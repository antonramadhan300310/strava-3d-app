import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ActivityType } from './valhalla';
import type { LngLatEle } from './polyline';
import { toActivityRecord, type ActivityRecord, type ActivityRow } from './activity';

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
 */
export function toLineStringZGeometry(coordinates: LngLatEle[]) {
  return {
    type: 'LineString' as const,
    coordinates: coordinates.map(([lng, lat, ele]) => [lng, lat, Number.isFinite(ele) ? ele : 0]),
  };
}

export async function savePlannedRoute(route: PlannedRoute): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase.from('activities').insert({
    title: route.title,
    activity_type: route.activityType,
    is_planned_route: true,
    distance_meters: route.distanceMeters,
    elevation_gain: route.elevationGain,
    duration_seconds: route.durationSeconds,
    geojson: toLineStringZGeometry(route.coordinates),
  });

  if (error) throw new Error(error.message);
}

export type RecordedActivity = {
  title: string;
  activityType: ActivityType;
  distanceMeters: number;
  elevationGain: number;
  durationSeconds: number;
  coordinates: LngLatEle[];
};

export async function saveRecordedActivity(activity: RecordedActivity): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase.from('activities').insert({
    title: activity.title,
    activity_type: activity.activityType,
    is_planned_route: false,
    distance_meters: activity.distanceMeters,
    elevation_gain: activity.elevationGain,
    duration_seconds: activity.durationSeconds,
    geojson: toLineStringZGeometry(activity.coordinates),
  });

  if (error) throw new Error(error.message);
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
  const { error } = await supabase
    .from('activities')
    .update({
      distance_meters: track.distanceMeters,
      elevation_gain: track.elevationGain,
      duration_seconds: track.durationSeconds,
      geojson: toLineStringZGeometry(track.coordinates),
    })
    .eq('id', id);

  if (error) throw new Error(error.message);
}
