import { decodePolyline, type LngLat, type LngLatEle } from './polyline';

const VALHALLA_BASE = 'https://valhalla1.openstreetmap.de';

export type ActivityType = 'ride' | 'run' | 'hike';

export type ProfileDefinition = {
  key: ActivityType;
  label: string;
  costing: string;
  costingOptions?: Record<string, unknown>;
};

export const PROFILES: ProfileDefinition[] = [
  { key: 'ride', label: 'Ride', costing: 'bicycle' },
  { key: 'run', label: 'Run', costing: 'pedestrian' },
  {
    key: 'hike',
    label: 'Hike',
    costing: 'pedestrian',
    costingOptions: {
      pedestrian: { walkway_factor: 0.8, max_hiking_difficulty: 3 },
    },
  },
];

export function getProfile(key: ActivityType): ProfileDefinition {
  return PROFILES.find((profile) => profile.key === key) ?? PROFILES[0];
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
 */
async function attachElevations(points: LngLat[]): Promise<LngLatEle[]> {
  if (points.length === 0) return [];

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
    if (!heights || heights.length === 0) return points.map((p) => [p[0], p[1], 0]);

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

    return points.map((point, index) => [point[0], point[1], elevationAt(index)] as LngLatEle);
  } catch {
    return points.map((point) => [point[0], point[1], 0] as LngLatEle);
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

  const coordinates = await attachElevations(points);
  const summary = data.trip?.summary ?? {};

  return {
    coordinates,
    distanceMeters: Math.round((summary.length ?? 0) * 1000),
    elevationGainMeters: calculateElevationGain(coordinates),
    durationSeconds: Math.round(summary.time ?? 0),
  };
}
