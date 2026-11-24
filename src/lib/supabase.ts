import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ActivityType } from './valhalla';
import { timestampOf, type LngLatEle } from './polyline';
import { toActivityRecord, type ActivityRecord, type ActivityRow } from './activity';
import type { ActivityWeather } from './weatherService';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const isSupabaseConfigured = SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!isSupabaseConfigured) {
    throw new Error('Server ALLMOVA belum dikonfigurasi. Hubungi admin aplikasi.');
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return client;
}

/** Read-only helpers degrade gracefully instead of throwing when unconfigured. */
export function getSupabaseClientOrNull(): SupabaseClient | null {
  return isSupabaseConfigured ? getClient() : null;
}

export type PlannedRoute = {
  userId: string;
  title: string;
  activityType: ActivityType;
  distanceMeters: number;
  elevationGain: number;
  durationSeconds: number;
  coordinates: LngLatEle[];
  routingMode?: 'snap' | 'offtrail';
  elevationProfile?: { distanceMeters: number; elevationMeters: number }[];
};

/**
 * Builds a GeoJSON *Geometry* (not a Feature) so it can be fed straight into
 * the PostGIS trigger's `st_geomfromgeojson` for a `geometry(LineStringZ, 4326)`
 * column. Every coordinate carries a third elevation value, defaulting to 0.
 *
 * Recorded tracks also carry the epoch millisecond of each fix as a fourth
 * element. It is only emitted when every point has one, because mixing 3D and
 * 4D positions is not valid for the spatial column.
 */
export function toLineStringZGeometry(coordinates: LngLatEle[], includeTimestamps = true) {
  const withTime =
    includeTimestamps && coordinates.every((coordinate) => timestampOf(coordinate) !== null);

  return {
    type: 'LineString' as const,
    coordinates: coordinates.map(([lng, lat, ele, time]) =>
      withTime
        ? [lng, lat, Number.isFinite(ele) ? ele : 0, time as number]
        : [lng, lat, Number.isFinite(ele) ? ele : 0],
    ),
  };
}

function hasTimestamps(coordinates: LngLatEle[]): boolean {
  return coordinates.length > 0 && coordinates.every((coordinate) => timestampOf(coordinate) !== null);
}

type GeoJsonGeometry = ReturnType<typeof toLineStringZGeometry>;

type GeoJsonWrite = GeoJsonGeometry | {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: GeoJsonGeometry;
};

type GeometryWriteResult = { error: { message: string } | null; data?: unknown };

function toFeature(geometry: GeoJsonGeometry, properties: Record<string, unknown>): GeoJsonWrite {
  return { type: 'Feature', properties, geometry };
}

/**
 * Tries the richest representation first: a GeoJSON Feature carrying weather
 * properties, then a plain geometry, then the same geometry without timestamps.
 * The last two attempts keep the original behaviour when the column is a strict
 * PostGIS `geometry`.
 */
async function writeGeometryWithFallback(
  write: (geometry: GeoJsonWrite) => Promise<GeometryWriteResult>,
  coordinates: LngLatEle[],
  properties?: Record<string, unknown>,
): Promise<void> {
  const attempts: GeoJsonWrite[] = [];
  if (properties) attempts.push(toFeature(toLineStringZGeometry(coordinates), properties));
  attempts.push(toLineStringZGeometry(coordinates));
  if (hasTimestamps(coordinates)) attempts.push(toLineStringZGeometry(coordinates, false));

  let lastError: { message: string } | null = null;
  for (const geometry of attempts) {
    const result = await write(geometry);
    if (!result.error) return;
    lastError = result.error;
  }

  throw new Error(lastError?.message ?? 'Gagal menyimpan geometri aktivitas.');
}

export async function savePlannedRoute(route: PlannedRoute): Promise<void> {
  if (!route.userId) throw new Error('Sesi login tidak ditemukan. Silakan masuk kembali.');
  const supabase = getClient();
  // Rich properties ride inside the GeoJSON Feature so the sport profile,
  // climb and Naismith-style estimate survive the round-trip even when the
  // `activities` table has no dedicated columns for them.
  const properties = {
    sport_type: route.activityType,
    routing_mode: route.routingMode ?? null,
    elevation_gain_meters: route.elevationGain,
    estimated_duration_seconds: route.durationSeconds,
    elevation_profile: route.elevationProfile ?? null,
  };

  await writeGeometryWithFallback(
    async (geometry) =>
      supabase.from('activities').insert({
        user_id: route.userId,
        title: route.title,
        activity_type: route.activityType,
        is_planned_route: true,
        distance_meters: route.distanceMeters,
        elevation_gain: route.elevationGain,
        duration_seconds: route.durationSeconds,
        geojson: geometry,
      }),
    route.coordinates,
    properties,
  );
}

export type RecordedActivity = {
  userId: string;
  title: string;
  activityType: ActivityType;
  distanceMeters: number;
  elevationGain: number;
  durationSeconds: number;
  coordinates: LngLatEle[];
  /** Optional weather snapshot embedded into the GeoJSON properties. */
  weather?: ActivityWeather | null;
  /** Optional perceived exertion (1–10) embedded into the GeoJSON properties. */
  rpe?: number | null;
};

export async function saveRecordedActivity(activity: RecordedActivity): Promise<void> {
  if (!activity.userId) throw new Error('Sesi login tidak ditemukan. Silakan masuk kembali.');
  const supabase = getClient();
  const properties: Record<string, unknown> = {};
  if (activity.weather) properties.weather = activity.weather;
  if (typeof activity.rpe === 'number') properties.rpe = activity.rpe;

  await writeGeometryWithFallback(
    async (geometry) =>
      supabase.from('activities').insert({
        user_id: activity.userId,
        title: activity.title,
        activity_type: activity.activityType,
        is_planned_route: false,
        distance_meters: activity.distanceMeters,
        elevation_gain: activity.elevationGain,
        duration_seconds: activity.durationSeconds,
        geojson: geometry,
      }),
    activity.coordinates,
    Object.keys(properties).length > 0 ? properties : undefined,
  );
}

const ACTIVITY_COLUMNS =
  'id,user_id,title,activity_type,is_planned_route,distance_meters,elevation_gain,duration_seconds,geojson,created_at';

/**
 * Loads the signed-in account's saved activities, newest first.
 *
 * Without an account id the function returns an empty list instead of running
 * an unscoped query. Rows whose geometry cannot be decoded are dropped instead
 * of breaking the whole feed, because a single malformed row should not hide
 * the rest.
 */
export async function fetchActivities(userId: string): Promise<ActivityRecord[]> {
  if (!userId) return [];

  const supabase = getClient();
  const { data, error } = await supabase
    .from('activities')
    .select(ACTIVITY_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) return [];

  return (data as ActivityRow[])
    .map(toActivityRecord)
    .filter((record): record is ActivityRecord => record !== null)
    .filter((record) => !record.userId || record.userId === userId);
}

export async function deleteActivity(id: string | number, userId: string): Promise<void> {
  if (!userId) return;
  const supabase = getClient();
  const { error } = await supabase
    .from('activities')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/** Rewrites an existing activity's geometry and the metrics derived from it. */
export async function updateActivityTrack(
  id: string | number,
  track: {
    distanceMeters: number;
    elevationGain: number;
    durationSeconds: number;
    coordinates: LngLatEle[];
  },
  userId: string,
): Promise<void> {
  if (!userId) throw new Error('Sesi login tidak ditemukan. Silakan masuk kembali.');
  const supabase = getClient();
  await writeGeometryWithFallback(
    async (geometry) =>
      supabase
        .from('activities')
        .update({
          distance_meters: track.distanceMeters,
          elevation_gain: track.elevationGain,
          duration_seconds: track.durationSeconds,
          geojson: geometry,
        })
        .eq('id', id)
        .eq('user_id', userId),
    track.coordinates,
  );
}

/**
 * Merges properties into an activity's GeoJSON Feature. Used for optional
 * metadata such as RPE, where the geometry itself must stay untouched.
 */
export async function updateActivityProperties(
  id: string | number,
  coordinates: LngLatEle[],
  properties: Record<string, unknown>,
  userId: string,
): Promise<void> {
  if (!userId) throw new Error('Sesi login tidak ditemukan. Silakan masuk kembali.');
  const supabase = getClient();
  await writeGeometryWithFallback(
    async (geometry) =>
      supabase
        .from('activities')
        .update({ geojson: geometry })
        .eq('id', id)
        .eq('user_id', userId),
    coordinates,
    properties,
  );
}
