import type { SupabaseClient } from '@supabase/supabase-js';
import { parseActivityGeometry, type ActivityRecord } from './activity';
import type { LngLat } from './polyline';
import { readScopedStorage, removeScopedStorage, writeScopedStorage } from './userStorage';
import { normalizeActivityType, type ActivityType } from './valhalla';

/** localStorage key holding the simplified heatmap history. */
export const HEATMAP_CACHE_KEY = 'tracker3d_personal_heatmap_v1';

/** ~13 m in degrees: keeps every street corner while dropping GPS noise. */
export const SIMPLIFY_TOLERANCE = 0.00012;

/** Upper bound per activity so a long ride cannot blow up the cache. */
const MAX_POINTS_PER_ACTIVITY = 150;

/** 5 decimals ≈ 1.1 m, far below GPS accuracy but a third of the JSON size. */
const COORD_PRECISION = 5;

/** Only the columns the heatmap needs, so the one-off read stays small. */
const HEATMAP_COLUMNS = 'id,activity_type,created_at,distance_meters,geojson';

export type HeatmapCoord = [number, number];

/** Lightweight, cache-friendly projection of an activity. */
export type HeatmapActivity = {
  id: string | number;
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

export type HeatmapScheme = 'fire' | 'neon';

export type HeatmapPalette = {
  label: string;
  /** Widest, most blurred pass that produces the soft outer aura. */
  halo: string;
  /** Mid-width pass that brightens on repeated passes. */
  glow: string;
  /** Thin pass that keeps corners sharp at every zoom. */
  core: string;
};

export const HEATMAP_SCHEMES: Record<HeatmapScheme, HeatmapPalette> = {
  fire: {
    label: 'Oranye Api',
    halo: '#c2410c',
    glow: '#f97316',
    core: '#fef08a',
  },
  neon: {
    label: 'Biru Neon',
    halo: '#0369a1',
    glow: '#06b6d4',
    core: '#e0f2fe',
  },
};

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
    type: normalizeActivityType(entry.type),
    date: typeof entry.date === 'string' ? entry.date : '',
    distance: Number.isFinite(Number(entry.distance)) ? Number(entry.distance) : 0,
    coords,
  };
}

/** Returns `null` when nothing is cached yet, so a miss is distinguishable. */
export function readHeatmapCache(): HeatmapActivity[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = readScopedStorage(HEATMAP_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map(parseCachedEntry)
      .filter((entry): entry is HeatmapActivity => entry !== null);
  } catch {
    return null;
  }
}

export function writeHeatmapCache(items: HeatmapActivity[]): void {
  if (typeof window === 'undefined') return;
  try {
    writeScopedStorage(HEATMAP_CACHE_KEY, JSON.stringify(items));
  } catch {
    // Quota or private mode: the heatmap still works for this session.
  }
}

/** Drops the cache so the next open rebuilds it from fresh data. */
export function invalidateHeatmapCache(): void {
  if (typeof window === 'undefined') return;
  try {
    removeScopedStorage(HEATMAP_CACHE_KEY);
  } catch {
    // Nothing to do if storage is unavailable.
  }
}

function fromRows(rows: unknown[]): HeatmapActivity[] {
  const items: HeatmapActivity[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as {
      id?: unknown;
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
 */
export async function getCachedHeatmapActivities(
  supabaseClient: SupabaseClient | null,
  existingActivities?: ActivityRecord[],
): Promise<HeatmapActivity[]> {
  if (existingActivities && existingActivities.length > 0) {
    const items = existingActivities
      .map(toHeatmapActivity)
      .filter((entry): entry is HeatmapActivity => entry !== null);
    writeHeatmapCache(items);
    return items;
  }

  const cached = readHeatmapCache();
  if (cached) return cached;

  if (!supabaseClient) return [];

  const { data, error } = await supabaseClient
    .from('activities')
    .select(HEATMAP_COLUMNS)
    .eq('is_planned_route', false);

  if (error) throw new Error(error.message);

  const items = fromRows(Array.isArray(data) ? data : []);
  writeHeatmapCache(items);
  return items;
}

function timeCutoff(range: HeatmapTimeFilter): number | null {
  if (range === 'all') return null;
  const now = new Date();
  if (range === 'year') return new Date(now.getFullYear(), 0, 1).getTime();
  return now.getTime() - 30 * 24 * 60 * 60 * 1000;
}

/**
 * Turns the cached history into the simplified line collection the map layers use.
 *
 * Every track stays a `LineString`, so MapLibre re-rasterises it at the native
 * screen resolution of each zoom level instead of showing a blocky point grid.
 */
export function buildHeatmapGeoJSON(
  activities: HeatmapActivity[],
  filters: HeatmapFilters,
): HeatmapGeoJSON {
  const cutoff = timeCutoff(filters.timeRange);
  const lines: GeoJSON.Feature<GeoJSON.LineString>[] = [];

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let count = 0;

  for (const activity of activities) {
    if (filters.activityType !== 'all' && activity.type !== filters.activityType) continue;
    if (cutoff !== null) {
      const stamp = Date.parse(activity.date);
      if (!Number.isFinite(stamp) || stamp < cutoff) continue;
    }
    if (activity.coords.length < 2) continue;

    count += 1;
    lines.push({
      type: 'Feature',
      properties: {
        id: activity.id,
        type: activity.type,
        date: activity.date,
        distance: activity.distance,
      },
      geometry: { type: 'LineString', coordinates: activity.coords },
    });

    for (const [lng, lat] of activity.coords) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }

  return {
    linesGeoJSON: { type: 'FeatureCollection', features: lines },
    bounds: count > 0 ? [west, south, east, north] : null,
    count,
  };
}
