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
    throw new Error('Supabase belum dikonfigurasi. Isi NEXT_PUBLIC_SUPABASE_URL dan NEXT_PUBLIC_SUPABASE_ANON_KEY.');
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
  title: string;
  activityType: ActivityType;
  distanceMeters: number;
  elevationGain: number;
  durationSeconds: number;
  coordinates: LngLatEle[];
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
  const supabase = getClient();
  await writeGeometryWithFallback(
    async (geometry) =>
      supabase.from('activities').insert({
        title: route.title,
        activity_type: route.activityType,
        is_planned_route: true,
        distance_meters: route.distanceMeters,
        elevation_gain: route.elevationGain,
        duration_seconds: route.durationSeconds,
        geojson: geometry,
      }),
    route.coordinates,
  );
}

export type RecordedActivity = {
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
  const supabase = getClient();
  const properties: Record<string, unknown> = {};
  if (activity.weather) properties.weather = activity.weather;
  if (typeof activity.rpe === 'number') properties.rpe = activity.rpe;

  await writeGeometryWithFallback(
    async (geometry) =>
      supabase.from('activities').insert({
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
  'id,title,activity_type,is_planned_route,distance_meters,elevation_gain,duration_seconds,geojson,created_at';

/**
 * Loads every saved activity, newest first.
 *
 * Rows whose geometry cannot be decoded are dropped instead of breaking the
 * whole feed, because a single malformed row should not hide the rest.
 */
export async function fetchActivities(): Promise<ActivityRecord[]> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('activities')
    .select(ACTIVITY_COLUMNS)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) return [];

  return (data as ActivityRow[])
    .map(toActivityRecord)
    .filter((record): record is ActivityRecord => record !== null);
}

export async function deleteActivity(id: string | number): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase.from('activities').delete().eq('id', id);
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
): Promise<void> {
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
        .eq('id', id),
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
): Promise<void> {
  const supabase = getClient();
  await writeGeometryWithFallback(
    async (geometry) =>
      supabase.from('activities').update({ geojson: geometry }).eq('id', id),
    coordinates,
    properties,
  );
}
