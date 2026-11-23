import { length as turfLength, distance as turfDistance } from '@turf/turf';
import { decodePolyline, timestampOf, type LngLat, type LngLatEle } from './polyline';

const VALHALLA_BASE = 'https://valhalla1.openstreetmap.de';

export type ActivityType = 'cycling' | 'run' | 'walking' | 'hike';

/** Legacy rows stored `'ride'`; both spellings map to the Cycling profile. */
export type StoredActivityType = ActivityType | 'ride';

export type ProfileDefinition = {
  key: ActivityType;
  label: string;
  costing: string;
  costingOptions?: Record<string, unknown>;
};

export const PROFILES: ProfileDefinition[] = [
  { key: 'cycling', label: 'Cycling', costing: 'bicycle' },
  { key: 'run', label: 'Run', costing: 'pedestrian' },
  {
    key: 'walking',
    label: 'Walking',
    costing: 'pedestrian',
    costingOptions: {
      pedestrian: { walking_speed: 4.8, walkway_factor: 0.7 },
    },
  },
  {
    key: 'hike',
    label: 'Hike',
    costing: 'pedestrian',
    costingOptions: {
      pedestrian: { walkway_factor: 0.8, max_hiking_difficulty: 3 },
    },
  },
];

export function normalizeActivityType(value: string | null | undefined): ActivityType {
  if (value === 'ride' || value === 'cycling') return 'cycling';
  if (value === 'run') return 'run';
  if (value === 'walking') return 'walking';
  if (value === 'hike') return 'hike';
  return 'cycling';
}

export function getProfile(key: StoredActivityType): ProfileDefinition {
  const normalized = normalizeActivityType(key);
  return PROFILES.find((profile) => profile.key === normalized) ?? PROFILES[0];
}

export type RouteResult = {
  coordinates: LngLatEle[];
  distanceMeters: number;
  elevationGainMeters: number;
  durationSeconds: number;
};

/** Cap on points sent to the height endpoint to stay under its payload limit. */
const MAX_HEIGHT_SAMPLES = 140;

class ValhallaError extends Error {}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${VALHALLA_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ValhallaError('Tidak dapat menghubungi server rute. Periksa koneksi internet.');
  }

  if (!response.ok) {
    throw new ValhallaError(
      response.status === 400 || response.status === 404
        ? 'Rute tidak ditemukan. Coba geser titik ke jalan terdekat.'
        : `Server rute menolak permintaan (${response.status}). Coba lagi nanti.`,
    );
  }

  return (await response.json()) as T;
}

type ValhallaRouteResponse = {
  trip?: {
    summary?: { length?: number; time?: number };
    legs?: { shape?: string }[];
  };
  error?: string;
  error_code?: number;
};

type ValhallaHeightResponse = {
  range_height?: [number, number][];
};

/**
 * Fetches elevations for the route and writes them onto each coordinate.
 *
 * Valhalla's height endpoint returns `[distanceAlongShape, height]` pairs for
 * the sampled points only, so intermediate coordinates are filled by linear
 * interpolation between the nearest surrounding samples.
 *
 * `fallbackAltitudes` (one per point) is used when the request fails, so a
 * recorded track keeps its GPS altitudes while offline instead of flattening
 * to sea level.
 */
async function attachElevations(
  points: LngLat[],
  fallbackAltitudes?: (number | null)[],
): Promise<ElevationResult> {
  if (points.length === 0) return { coordinates: [], usedFallback: false };

  const fallbackAt = (index: number): number => {
    const value = fallbackAltitudes?.[index];
    return value !== null && value !== undefined && Number.isFinite(value) ? value : 0;
  };

  const step = Math.max(1, Math.ceil(points.length / MAX_HEIGHT_SAMPLES));
  const sampleIndices: number[] = [];
  for (let i = 0; i < points.length; i += step) sampleIndices.push(i);
  if (sampleIndices[sampleIndices.length - 1] !== points.length - 1) {
    sampleIndices.push(points.length - 1);
  }

  try {
    const payload = {
      range: true,
      shape: sampleIndices.map((i) => ({ lat: points[i][1], lon: points[i][0] })),
    };
    const data = await postJson<ValhallaHeightResponse>('/height', payload);
    const heights = data.range_height;
    if (!heights || heights.length === 0) {
      return {
        coordinates: points.map(
          (point, index) => [point[0], point[1], fallbackAt(index)] as LngLatEle,
        ),
        usedFallback: true,
      };
    }

    const elevationAt = (pointIndex: number): number => {
      const exact = sampleIndices.indexOf(pointIndex);
      if (exact !== -1) return heights[Math.min(exact, heights.length - 1)][1];

      let upper = sampleIndices.findIndex((sample) => sample > pointIndex);
      if (upper === -1) upper = sampleIndices.length - 1;
      const lower = Math.max(0, upper - 1);
      const span = sampleIndices[upper] - sampleIndices[lower] || 1;
      const ratio = (pointIndex - sampleIndices[lower]) / span;
      const from = heights[Math.min(lower, heights.length - 1)][1];
      const to = heights[Math.min(upper, heights.length - 1)][1];
      return from + (to - from) * ratio;
    };

    return {
      coordinates: points.map(
        (point, index) => [point[0], point[1], elevationAt(index)] as LngLatEle,
      ),
      usedFallback: false,
    };
  } catch {
    return {
      coordinates: points.map(
        (point, index) => [point[0], point[1], fallbackAt(index)] as LngLatEle,
      ),
      usedFallback: true,
    };
  }
}

/** Sum of positive elevation deltas, ignoring GPS/DEM noise below 0.5 m. */
export function calculateElevationGain(coordinates: LngLatEle[]): number {
  let gain = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    const delta = coordinates[i][2] - coordinates[i - 1][2];
    if (delta > 0.5) gain += delta;
  }
  return Math.round(gain);
}

export type ElevationResult = {
  coordinates: LngLatEle[];
  /** True when Valhalla was unreachable and GPS altitudes were kept instead. */
  usedFallback: boolean;
};

/** Cap on points sent to the map-matching endpoint; longer tracks are resampled. */
const MAX_TRACE_SAMPLES = 180;
/**
 * A successful match traces the same route, so its length stays close to the
 * recording. Valhalla answers an unmatchable trace with a stub shape (two
 * points, a few metres), which would silently replace a whole activity.
 */
// Wide enough for a noisy GPS track (zig-zag inflates the raw length) while
// still rejecting the near-zero stub, which is orders of magnitude off.
const MIN_SNAP_LENGTH_RATIO = 0.25;
const MAX_SNAP_LENGTH_RATIO = 4;

type ValhallaTraceResponse = {
  trip?: {
    summary?: { length?: number; time?: number };
    legs?: { shape?: string }[];
  };
  error?: string;
  error_code?: number;
};

export type SnapRouteResult = {
  coordinates: LngLatEle[];
  distanceMeters: number;
  elevationGainMeters: number;
  /** False when Valhalla was unreachable and the raw GPS track was kept. */
  snapped: boolean;
  /** True when ground elevations were unavailable and GPS altitudes were kept. */
  usedGpsAltitude: boolean;
};

function lineFeature(coordinates: (LngLat | LngLatEle)[]): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  };
}

function lengthMeters(coordinates: (LngLat | LngLatEle)[]): number {
  return Math.round(turfLength(lineFeature(coordinates), { units: 'meters' }));
}

/**
 * Nearest-altitude lookup for the snapped shape.
 *
 * Matched points have no GPS altitude of their own, so each one borrows the
 * altitude of the sampled fix at the same relative position along the track.
 */
function altitudeLookup(altitudes: number[], pointCount: number): (index: number) => number {
  const last = altitudes.length - 1;
  return (index) => {
    if (last < 0) return 0;
    if (last === 0) return altitudes[0];

    const position = (index / Math.max(pointCount - 1, 1)) * last;
    const lower = Math.min(Math.floor(position), last);
    const upper = Math.min(lower + 1, last);
    const ratio = position - lower;
    const from = altitudes[lower];
    const to = altitudes[upper];

    if (!Number.isFinite(from)) return Number.isFinite(to) ? to : 0;
    if (!Number.isFinite(to)) return from;
    return from + (to - from) * ratio;
  };
}

function cumulativeDistances(coordinates: LngLatEle[]): number[] {
  const cumulative: number[] = [0];
  for (let i = 1; i < coordinates.length; i += 1) {
    cumulative.push(
      cumulative[i - 1] +
        turfDistance(
          [coordinates[i - 1][0], coordinates[i - 1][1]],
          [coordinates[i][0], coordinates[i][1]],
          { units: 'meters' },
        ),
    );
  }
  return cumulative;
}

/**
 * Carries the per-fix timestamps from the raw GPS track onto the re-sampled
 * matched shape, keyed by relative distance along the route.
 */
function attachTimestamps(snapped: LngLatEle[], source: LngLatEle[]): LngLatEle[] {
  const sourceTimes = source.map((coordinate) => timestampOf(coordinate));
  if (sourceTimes.length < 2 || sourceTimes.some((time) => time === null)) return snapped;

  const sourceCumulative = cumulativeDistances(source);
  const snappedCumulative = cumulativeDistances(snapped);
  const sourceTotal = sourceCumulative[sourceCumulative.length - 1];
  const snappedTotal = snappedCumulative[snappedCumulative.length - 1];
  if (!(sourceTotal > 0) || !(snappedTotal > 0)) return snapped;

  const timeAtDistance = (distance: number): number => {
    let index = 1;
    while (index < sourceCumulative.length - 1 && sourceCumulative[index] < distance) index += 1;
    const span = sourceCumulative[index] - sourceCumulative[index - 1];
    const ratio = span > 0 ? (distance - sourceCumulative[index - 1]) / span : 0;
    const from = sourceTimes[index - 1] as number;
    const to = sourceTimes[index] as number;
    return from + (to - from) * Math.min(Math.max(ratio, 0), 1);
  };

  return snapped.map((point, index) => {
    const distance = (snappedCumulative[index] / snappedTotal) * sourceTotal;
    return [point[0], point[1], point[2], timeAtDistance(distance)];
  });
}

/**
 * Snaps a recorded GPS track onto the road/path network with Valhalla's free
 * FOSSGIS map-matching endpoint (`trace_route` with `shape_match: map_snap`).
 *
 * The matched geometry comes back as a precision-6 polyline, so distance and
 * elevation are recomputed from it instead of trusting the noisy GPS fixes.
 * Any network or server failure returns the untouched track, because losing a
 * recording to a routing outage would be far worse than a jagged line.
 */
export async function snapRouteToRoad(
  coordinates: (LngLat | LngLatEle)[],
  activityType: ActivityType,
): Promise<SnapRouteResult> {
  const original: LngLatEle[] = coordinates.map((coordinate) => {
    const point = coordinate as LngLatEle;
    const ele = Number.isFinite(point[2]) ? point[2] : 0;
    const time = timestampOf(coordinate);
    return time === null ? [point[0], point[1], ele] : [point[0], point[1], ele, time];
  });

  const fallback: SnapRouteResult = {
    coordinates: original,
    distanceMeters: lengthMeters(original),
    elevationGainMeters: calculateElevationGain(original),
    snapped: false,
    usedGpsAltitude: true,
  };

  if (original.length < 2) return fallback;

  const step = Math.max(1, Math.ceil(original.length / MAX_TRACE_SAMPLES));
  const sampleIndices: number[] = [];
  for (let i = 0; i < original.length; i += step) sampleIndices.push(i);
  if (sampleIndices[sampleIndices.length - 1] !== original.length - 1) {
    sampleIndices.push(original.length - 1);
  }
  if (sampleIndices.length < 2) return fallback;

  const profile = getProfile(activityType);

  try {
    const body: Record<string, unknown> = {
      shape: sampleIndices.map((index) => ({ lat: original[index][1], lon: original[index][0] })),
      costing: profile.costing,
      shape_match: 'map_snap',
      directions_options: { units: 'kilometers' },
    };
    if (profile.costingOptions) body.costing_options = profile.costingOptions;

    const data = await postJson<ValhallaTraceResponse>('/trace_route', body);
    const legs = data.trip?.legs;
    if (!legs || legs.length === 0) return fallback;

    const points: LngLat[] = [];
    for (const leg of legs) {
      if (!leg.shape) continue;
      for (const point of decodePolyline(leg.shape)) {
        const last = points[points.length - 1];
        if (last && last[0] === point[0] && last[1] === point[1]) continue;
        points.push(point);
      }
    }
    if (points.length < 2) return fallback;

    const snappedLength = lengthMeters(points);
    const ratio = snappedLength / Math.max(fallback.distanceMeters, 1);
    if (ratio < MIN_SNAP_LENGTH_RATIO || ratio > MAX_SNAP_LENGTH_RATIO) return fallback;

    const fallbackAltitude = altitudeLookup(
      sampleIndices.map((index) => original[index][2]),
      points.length,
    );
    const { coordinates: snapped, usedFallback } = await attachElevations(
      points,
      points.map((_, index) => fallbackAltitude(index)),
    );
    const withTimestamps = attachTimestamps(snapped, original);

    return {
      coordinates: withTimestamps,
      distanceMeters: lengthMeters(withTimestamps),
      elevationGainMeters: calculateElevationGain(withTimestamps),
      snapped: true,
      usedGpsAltitude: usedFallback,
    };
  } catch {
    return fallback;
  }
}

export async function fetchRoute(
  waypoints: LngLat[],
  activityType: ActivityType,
): Promise<RouteResult> {
  const profile = getProfile(activityType);
  const body: Record<string, unknown> = {
    locations: waypoints.map(([lng, lat]) => ({ lat, lon: lng })),
    costing: profile.costing,
    directions_options: { units: 'kilometers' },
  };
  if (profile.costingOptions) body.costing_options = profile.costingOptions;

  const data = await postJson<ValhallaRouteResponse>('/route', body);
  const legs = data.trip?.legs;
  if (!legs || legs.length === 0) {
    throw new ValhallaError(data.error ?? 'Rute tidak dapat dihitung.');
  }

  const points: LngLat[] = [];
  for (const leg of legs) {
    if (!leg.shape) continue;
    for (const point of decodePolyline(leg.shape)) {
      const last = points[points.length - 1];
      // Consecutive legs repeat the shared waypoint.
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      points.push(point);
    }
  }

  if (points.length < 2) throw new ValhallaError('Rute terlalu pendek untuk ditampilkan.');

  const { coordinates } = await attachElevations(points);
  const summary = data.trip?.summary ?? {};

  return {
    coordinates,
    distanceMeters: Math.round((summary.length ?? 0) * 1000),
    elevationGainMeters: calculateElevationGain(coordinates),
    durationSeconds: Math.round(summary.time ?? 0),
  };
}
