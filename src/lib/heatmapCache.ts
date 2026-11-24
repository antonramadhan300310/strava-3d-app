import type { SupabaseClient } from '@supabase/supabase-js';
import { parseActivityGeometry, type ActivityRecord } from './activity';
import type { LngLat } from './polyline';
import {
  readUserStorage,
  removeUserStorage,
  USER_STORAGE_KEYS,
  writeUserStorage,
} from './userStorage';
import { normalizeActivityType, type ActivityType } from './valhalla';

/** localStorage key holding the simplified heatmap history, suffixed per account. */
export const HEATMAP_CACHE_KEY = USER_STORAGE_KEYS.heatmap;

/** ~13 m in degrees: keeps every street corner while dropping GPS noise. */
export const SIMPLIFY_TOLERANCE = 0.00012;

/** Upper bound per activity so a long ride cannot blow up the cache. */
const MAX_POINTS_PER_ACTIVITY = 150;

/** 5 decimals ≈ 1.1 m, far below GPS accuracy but a third of the JSON size. */
const COORD_PRECISION = 5;

/** Only the columns the heatmap needs, so the one-off read stays small. */
const HEATMAP_COLUMNS = 'id,user_id,activity_type,created_at,distance_meters,geojson';

export type HeatmapCoord = [number, number];

/** Lightweight, cache-friendly projection of an activity. */
export type HeatmapActivity = {
  id: string | number;
  /** Owner id, so a stale entry can never be drawn for another account. */
  userId?: string | null;
  type: ActivityType;
  date: string;
  distance: number;
  coords: HeatmapCoord[];
};

export type HeatmapTypeFilter = 'all' | ActivityType;
export type HeatmapTimeFilter = 'all' | 'year' | '30d';

export type HeatmapFilters = {
  activityType: HeatmapTypeFilter;
  timeRange: HeatmapTimeFilter;
};

/**
 * Grid used to recognise segments that reuse the same road. ~11 m is coarser
 * than the 5-decimal coordinates but finer than a lane change, so repeated
 * rides of one street collapse into a single weighted segment.
 */
const WEIGHT_SNAP_DEGREES = 1e-4;

export const HEATMAP_TYPE_FILTERS: { key: HeatmapTypeFilter; label: string }[] = [
  { key: 'all', label: 'Semua' },
  { key: 'cycling', label: 'Cycling' },
  { key: 'run', label: 'Run' },
  { key: 'walking', label: 'Walking' },
  { key: 'hike', label: 'Hike' },
];

export const HEATMAP_TIME_FILTERS: { key: HeatmapTimeFilter; label: string }[] = [
  { key: 'all', label: 'Semua Waktu' },
  { key: 'year', label: 'Tahun Ini' },
  { key: '30d', label: '30 Hari' },
];

export type HeatmapGeoJSON = {
  linesGeoJSON: GeoJSON.FeatureCollection<GeoJSON.LineString>;
  /** `[west, south, east, north]` of the filtered tracks, or null when empty. */
  bounds: [number, number, number, number] | null;
  count: number;
};

/** Squared distance from `p` to the segment `a`→`b`, in degrees². */
function squareSegmentDistance(p: LngLat, a: LngLat, b: LngLat): number {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;

  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/** Iterative Douglas-Peucker so a 10k-point track cannot overflow the stack. */
function douglasPeucker(points: LngLat[], tolerance: number): LngLat[] {
  if (points.length <= 2) return points.slice();

  const sqTolerance = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let maxSquared = 0;
    let index = -1;

    for (let i = first + 1; i < last; i += 1) {
      const squared = squareSegmentDistance(points[i], points[first], points[last]);
      if (squared > maxSquared) {
        maxSquared = squared;
        index = i;
      }
    }

    if (index !== -1 && maxSquared > sqTolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const simplified: LngLat[] = [];
  for (let i = 0; i < points.length; i += 1) {
    if (keep[i]) simplified.push(points[i]);
  }
  return simplified;
}

function subsampleEvenly(points: LngLat[], limit: number): LngLat[] {
  if (points.length <= limit) return points;
  const step = (points.length - 1) / (limit - 1);
  const out: LngLat[] = [];
  for (let i = 0; i < limit; i += 1) out.push(points[Math.round(i * step)]);
  return out;
}

/**
 * Douglas-Peucker simplification of a recorded track.
 *
 * The tolerance is widened progressively while the result is still above the
 * per-activity cap, so a 40 km ride ends up with roughly 100–150 vertices
 * instead of thousands, without flattening real corners.
 */
export function simplifyCoordinates(coords: LngLat[], tolerance = SIMPLIFY_TOLERANCE): LngLat[] {
  if (coords.length <= 2) return coords.map(([lng, lat]) => [lng, lat] as LngLat);

  const points = coords.map(([lng, lat]) => [lng, lat] as LngLat);
  let current = tolerance;
  let simplified = douglasPeucker(points, current);

  for (let attempt = 0; attempt < 6 && simplified.length > MAX_POINTS_PER_ACTIVITY; attempt += 1) {
    current *= 2;
    simplified = douglasPeucker(points, current);
  }

  return subsampleEvenly(simplified, MAX_POINTS_PER_ACTIVITY);
}

function roundCoord([lng, lat]: HeatmapCoord): HeatmapCoord {
  const factor = 10 ** COORD_PRECISION;
  return [Math.round(lng * factor) / factor, Math.round(lat * factor) / factor];
}

function toHeatmapCoords(coords: readonly (readonly number[])[]): HeatmapCoord[] {
  const planar = coords.map((point) => [point[0], point[1]] as LngLat);
  return simplifyCoordinates(planar).map(roundCoord);
}

/** Projection used for both the in-memory activities and the Supabase rows. */
export function toHeatmapActivity(record: ActivityRecord): HeatmapActivity | null {
  if (record.isPlannedRoute) return null;

  const coords = toHeatmapCoords(record.coordinates);
  if (coords.length < 2) return null;

  return {
    id: record.id,
    userId: record.userId ?? null,
    type: normalizeActivityType(record.activityType),
    date: record.createdAt,
    distance: record.distanceMeters,
    coords,
  };
}

function isHeatmapCoord(value: unknown): value is HeatmapCoord {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  );
}

function parseCachedEntry(value: unknown): HeatmapActivity | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<HeatmapActivity>;
  if (!Array.isArray(entry.coords)) return null;

  const coords = entry.coords.filter(isHeatmapCoord).map(([lng, lat]) => [lng, lat] as HeatmapCoord);
  if (coords.length < 2) return null;

  const id = entry.id;
  if (typeof id !== 'string' && typeof id !== 'number') return null;

  return {
    id,
    userId: typeof entry.userId === 'string' ? entry.userId : null,
    type: normalizeActivityType(entry.type),
    date: typeof entry.date === 'string' ? entry.date : '',
    distance: Number.isFinite(Number(entry.distance)) ? Number(entry.distance) : 0,
    coords,
  };
}

/** Returns `null` when nothing is cached yet, so a miss is distinguishable. */
export function readHeatmapCache(userId: string | null): HeatmapActivity[] | null {
  if (!userId) return null;
  try {
    const raw = readUserStorage(HEATMAP_CACHE_KEY, userId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map(parseCachedEntry)
      .filter((entry): entry is HeatmapActivity => entry !== null)
      .filter((entry) => !entry.userId || entry.userId === userId);
  } catch {
    return null;
  }
}

export function writeHeatmapCache(userId: string | null, items: HeatmapActivity[]): void {
  if (!userId) return;
  try {
    writeUserStorage(
      HEATMAP_CACHE_KEY,
      userId,
      JSON.stringify(items.map((item) => ({ ...item, userId }))),
    );
  } catch {
    // Quota or private mode: the heatmap still works for this session.
  }
}

/** Drops the cache so the next open rebuilds it from fresh data. */
export function invalidateHeatmapCache(userId: string | null): void {
  removeUserStorage(HEATMAP_CACHE_KEY, userId);
}

function fromRows(rows: unknown[]): HeatmapActivity[] {
  const items: HeatmapActivity[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as {
      id?: unknown;
      user_id?: string | null;
      activity_type?: string | null;
      created_at?: string | null;
      distance_meters?: number | null;
      geojson?: unknown;
    };
    if (typeof record.id !== 'string' && typeof record.id !== 'number') continue;

    const coords = toHeatmapCoords(parseActivityGeometry(record.geojson));
    if (coords.length < 2) continue;

    items.push({
      id: record.id,
      userId: typeof record.user_id === 'string' ? record.user_id : null,
      type: normalizeActivityType(record.activity_type),
      date: record.created_at ?? '',
      distance:
        typeof record.distance_meters === 'number' && Number.isFinite(record.distance_meters)
          ? record.distance_meters
          : 0,
      coords,
    });
  }
  return items;
}

/**
 * Heatmap history with a single Supabase read at most.
 *
 * Activities already in app state are reused as-is, so toggling the heatmap or
 * changing its filters never hits the database. Only a cold start (no state,
 * no cache) fetches the minimal columns once and then writes the cache.
 *
 * Without an account id there is no owner to read for, so the function returns
 * an empty list instead of running an unscoped query.
 */
export async function getCachedHeatmapActivities(
  supabaseClient: SupabaseClient | null,
  userId: string | null,
  existingActivities?: ActivityRecord[],
): Promise<HeatmapActivity[]> {
  if (!userId) return [];

  if (existingActivities && existingActivities.length > 0) {
    const items = existingActivities
      .filter((record) => !record.userId || record.userId === userId)
      .map(toHeatmapActivity)
      .filter((entry): entry is HeatmapActivity => entry !== null);
    writeHeatmapCache(userId, items);
    return items;
  }

  const cached = readHeatmapCache(userId);
  if (cached) return cached;

  if (!supabaseClient) return [];

  const { data, error } = await supabaseClient
    .from('activities')
    .select(HEATMAP_COLUMNS)
    .eq('user_id', userId)
    .eq('is_planned_route', false);

  if (error) throw new Error(error.message);

  const items = fromRows(Array.isArray(data) ? data : []).filter(
    (item) => !item.userId || item.userId === userId,
  );
  writeHeatmapCache(userId, items);
  return items;
}

function timeCutoff(range: HeatmapTimeFilter): number | null {
  if (range === 'all') return null;
  const now = new Date();
  if (range === 'year') return new Date(now.getFullYear(), 0, 1).getTime();
  return now.getTime() - 30 * 24 * 60 * 60 * 1000;
}

/**
 * Snapped, order-independent key for one segment. `null` for a zero-length
 * segment, which happens when two fixes land in the same grid cell.
 */
function segmentKey(a: HeatmapCoord, b: HeatmapCoord): string | null {
  const ax = Math.round(a[0] / WEIGHT_SNAP_DEGREES);
  const ay = Math.round(a[1] / WEIGHT_SNAP_DEGREES);
  const bx = Math.round(b[0] / WEIGHT_SNAP_DEGREES);
  const by = Math.round(b[1] / WEIGHT_SNAP_DEGREES);
  if (ax === bx && ay === by) return null;
  return ax < bx || (ax === bx && ay < by)
    ? `${ax},${ay}|${bx},${by}`
    : `${bx},${by}|${ax},${ay}`;
}

/** How many distinct tracks cross each snapped segment. */
function countSegmentWeights(tracks: HeatmapCoord[][]): Map<string, number> {
  const weights = new Map<string, number>();

  for (const track of tracks) {
    const seen = new Set<string>();
    for (let index = 1; index < track.length; index += 1) {
      const key = segmentKey(track[index - 1], track[index]);
      // One pass along a segment counts once, even if the rider doubled back.
      if (!key || seen.has(key)) continue;
      seen.add(key);
      weights.set(key, (weights.get(key) ?? 0) + 1);
    }
  }

  return weights;
}

type WeightedRun = { weight: number; coords: HeatmapCoord[] };

/**
 * Splits a track into runs of equal weight so each run can be coloured by the
 * data-driven paint expression. Consecutive runs share their boundary vertex,
 * which keeps the line continuous where a popular street meets a quiet one.
 */
function splitByWeight(track: HeatmapCoord[], weights: Map<string, number>): WeightedRun[] {
  const runs: WeightedRun[] = [];
  let current: WeightedRun | null = null;

  for (let index = 1; index < track.length; index += 1) {
    const key = segmentKey(track[index - 1], track[index]);
    if (!key) continue;

    const segmentWeight = weights.get(key) ?? 1;
    if (!current || current.weight !== segmentWeight) {
      current = { weight: segmentWeight, coords: [track[index - 1]] };
      runs.push(current);
    }
    current.coords.push(track[index]);
  }

  return runs.filter((run) => run.coords.length >= 2);
}

/**
 * Turns the cached history into the simplified line collection the map layers use.
 *
 * Every track stays a `LineString`, so MapLibre re-rasterises it at the native
 * screen resolution of each zoom level instead of showing a blocky point grid.
 * Segments carry a `weight` property (how many activities cross them) that the
 * neon heatmap paint expressions read.
 */
export function buildHeatmapGeoJSON(
  activities: HeatmapActivity[],
  filters: HeatmapFilters,
  userId?: string | null,
): HeatmapGeoJSON {
  const cutoff = timeCutoff(filters.timeRange);
  const visible: HeatmapActivity[] = [];

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const activity of activities) {
    // Defence in depth: an entry copied from another account must never draw.
    if (userId && activity.userId && activity.userId !== userId) continue;
    if (filters.activityType !== 'all' && activity.type !== filters.activityType) continue;
    if (cutoff !== null) {
      const stamp = Date.parse(activity.date);
      if (!Number.isFinite(stamp) || stamp < cutoff) continue;
    }
    if (activity.coords.length < 2) continue;

    visible.push(activity);

    for (const [lng, lat] of activity.coords) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }

  const weights = countSegmentWeights(visible.map((activity) => activity.coords));
  const lines: GeoJSON.Feature<GeoJSON.LineString>[] = [];

  for (const activity of visible) {
    for (const run of splitByWeight(activity.coords, weights)) {
      lines.push({
        type: 'Feature',
        properties: {
          id: activity.id,
          type: activity.type,
          date: activity.date,
          distance: activity.distance,
          weight: run.weight,
        },
        geometry: { type: 'LineString', coordinates: run.coords },
      });
    }
  }

  const count = visible.length;

  return {
    linesGeoJSON: { type: 'FeatureCollection', features: lines },
    bounds: count > 0 ? [west, south, east, north] : null,
    count,
  };
}
