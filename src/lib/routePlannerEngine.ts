import { decodePolyline, type LngLat, type LngLatEle } from './polyline';
import type { ActivityType } from './valhalla';

export type SportMode = ActivityType;
export type RoutingMode = 'snap' | 'offtrail';
export type RouteProvider = 'valhalla' | 'osrm' | 'straight';

const VALHALLA_ROUTE_URL = 'https://valhalla1.openstreetmap.de/route';
const OSRM_BASE = 'https://router.project-osrm.org/route/v1';
const ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';

const VALHALLA_TIMEOUT_MS = 12000;
const OSRM_TIMEOUT_MS = 10000;
const ELEVATION_TIMEOUT_MS = 9000;

/** Open-Meteo accepts up to 100 coordinates; 80 keeps the query URL short. */
const MAX_ELEVATION_SAMPLES = 80;
const MAX_PROFILE_SAMPLES = 48;
const MAX_SEGMENT_POINTS = 480;
const STRAIGHT_SAMPLE_SPACING_METERS = 40;
const EARTH_RADIUS_METERS = 6371008.8;

type SportProfile = {
  costing: string;
  costingOptions: Record<string, Record<string, number | string>>;
  osrm: 'cycling' | 'walking';
};

const PROFILES: Record<SportMode, SportProfile> = {
  cycling: {
    costing: 'bicycle',
    costingOptions: {
      bicycle: { bicycle_type: 'Road', use_roads: 0.4, avoid_bad_surfaces: 0.3 },
    },
    osrm: 'cycling',
  },
  run: {
    costing: 'pedestrian',
    costingOptions: {
      pedestrian: { walkway_factor: 0.8, use_trails: 0.7 },
    },
    osrm: 'walking',
  },
  walking: {
    costing: 'pedestrian',
    costingOptions: {
      pedestrian: { walkway_factor: 0.7 },
    },
    osrm: 'walking',
  },
  hike: {
    costing: 'pedestrian',
    costingOptions: {
      pedestrian: {
        use_tracks: 1.0,
        use_trails: 1.0,
        max_hiking_difficulty: 4,
        walkway_factor: 0.6,
      },
    },
    osrm: 'walking',
  },
};

export type ElevationSample = {
  distanceMeters: number;
  elevationMeters: number;
};

export type PlannedRouteResult = {
  coordinates: LngLatEle[];
  distanceMeters: number;
  elevationGainMeters: number;
  durationSeconds: number;
  elevationProfile: ElevationSample[];
  provider: RouteProvider;
  routingMode: RoutingMode;
  /** True when the elevation service was unreachable and zeroes were used. */
  usedElevationFallback: boolean;
};

type ValhallaResponse = {
  trip?: {
    summary?: { length?: number; time?: number };
    legs?: { shape?: string }[];
  };
  error?: string;
};

type OsrmResponse = {
  code?: string;
  routes?: {
    distance?: number;
    duration?: number;
    geometry?: { coordinates?: [number, number][] };
  }[];
};

type ElevationResponse = {
  elevation?: (number | null)[];
};

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function haversineMeters(a: readonly number[], b: readonly number[]): number {
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const dLat = lat2 - lat1;
  const dLng = toRadians(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function initialBearingDegrees(from: LngLat, to: LngLat): number {
  const lat1 = toRadians(from[1]);
  const lat2 = toRadians(to[1]);
  const dLng = toRadians(to[0] - from[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Point reached after travelling `meters` along a great circle. */
function destinationPoint(from: LngLat, meters: number, bearingDegrees: number): LngLat {
  const angular = meters / EARTH_RADIUS_METERS;
  const bearing = toRadians(bearingDegrees);
  const lat1 = toRadians(from[1]);
  const lng1 = toRadians(from[0]);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );

  return [(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
}

function sanitizeWaypoints(waypoints: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const point of waypoints) {
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const last = out[out.length - 1];
    if (last && last[0] === lng && last[1] === lat) continue;
    out.push([lng, lat]);
  }
  return out;
}

/**
 * Straight geodesic connector used by Off-Trail mode and as the last-resort
 * fallback. Segments are densified so the elevation profile has something to
 * sample along long climbs that have no mapped path.
 */
function buildStraightGeometry(waypoints: LngLat[]): LngLat[] {
  if (waypoints.length === 0) return [];
  const out: LngLat[] = [waypoints[0]];

  for (let i = 1; i < waypoints.length; i += 1) {
    const from = waypoints[i - 1];
    const to = waypoints[i];
    const segmentMeters = haversineMeters(from, to);
    if (segmentMeters < 0.5) continue;

    const steps = Math.min(
      MAX_SEGMENT_POINTS,
      Math.max(1, Math.ceil(segmentMeters / STRAIGHT_SAMPLE_SPACING_METERS)),
    );
    const bearing = initialBearingDegrees(from, to);
    for (let step = 1; step <= steps; step += 1) {
      const point =
        step === steps ? to : destinationPoint(from, (segmentMeters * step) / steps, bearing);
      const last = out[out.length - 1];
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      out.push(point);
    }
  }

  return out;
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function requestValhalla(waypoints: LngLat[], sportMode: SportMode): Promise<LngLat[]> {
  const profile = PROFILES[sportMode];
  const data = await fetchJson<ValhallaResponse>(
    VALHALLA_ROUTE_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: waypoints.map(([lng, lat]) => ({ lat, lon: lng })),
        costing: profile.costing,
        costing_options: profile.costingOptions,
        directions_options: { units: 'kilometers' },
        // Valhalla encodes shapes at 1e6; decodePolyline is told the same precision.
        shape_format: 'polyline6',
      }),
    },
    VALHALLA_TIMEOUT_MS,
  );

  const points: LngLat[] = [];
  for (const leg of data.trip?.legs ?? []) {
    if (!leg.shape) continue;
    for (const point of decodePolyline(leg.shape, 6)) {
      const last = points[points.length - 1];
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      points.push(point);
    }
  }

  if (points.length < 2) throw new Error(data.error ?? 'Valhalla tidak menemukan jalur.');
  return points;
}

async function requestOsrm(waypoints: LngLat[], sportMode: SportMode): Promise<LngLat[]> {
  const coordinates = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(';');
  const url =
    `${OSRM_BASE}/${PROFILES[sportMode].osrm}/${coordinates}` +
    '?overview=full&geometries=geojson&steps=false';
  const data = await fetchJson<OsrmResponse>(url, { method: 'GET' }, OSRM_TIMEOUT_MS);

  const points = data.routes?.[0]?.geometry?.coordinates;
  if (data.code && data.code !== 'Ok') throw new Error(data.code);
  if (!points || points.length < 2) throw new Error('OSRM tidak menemukan jalur.');

  return points
    .map(([lng, lat]) => [Number(lng), Number(lat)] as LngLat)
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
}

function sampleIndices(count: number, maxSamples: number): number[] {
  if (count <= maxSamples) return Array.from({ length: count }, (_, index) => index);
  if (maxSamples === 1) return [0];

  const step = (count - 1) / (maxSamples - 1);
  const out: number[] = [];
  for (let i = 0; i < maxSamples; i += 1) {
    const index = Math.round(i * step);
    if (out[out.length - 1] !== index) out.push(index);
  }
  return out;
}

function cumulativeDistances(points: LngLat[]): number[] {
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + haversineMeters(points[i - 1], points[i]));
  }
  return cumulative;
}

async function fetchElevations(points: LngLat[]): Promise<{
  values: number[];
  usedFallback: boolean;
}> {
  if (points.length === 0) return { values: [], usedFallback: false };

  const indices = sampleIndices(points.length, MAX_ELEVATION_SAMPLES);
  const latitudes = indices.map((index) => points[index][1].toFixed(6)).join(',');
  const longitudes = indices.map((index) => points[index][0].toFixed(6)).join(',');

  try {
    const data = await fetchJson<ElevationResponse>(
      `${ELEVATION_URL}?latitude=${latitudes}&longitude=${longitudes}`,
      { method: 'GET' },
      ELEVATION_TIMEOUT_MS,
    );

    const samples = data.elevation ?? [];
    if (samples.length === 0 || !samples.some((value) => Number.isFinite(value))) {
      throw new Error('Elevasi kosong.');
    }

    const heightAt = (position: number): number => {
      const exact = indices.indexOf(position);
      if (exact !== -1) {
        const value = Number(samples[Math.min(exact, samples.length - 1)]);
        return Number.isFinite(value) ? value : 0;
      }

      let upper = indices.findIndex((sample) => sample > position);
      if (upper === -1) upper = indices.length - 1;
      const lower = Math.max(0, upper - 1);
      const span = indices[upper] - indices[lower] || 1;
      const ratio = (position - indices[lower]) / span;
      const from = Number(samples[Math.min(lower, samples.length - 1)]);
      const to = Number(samples[Math.min(upper, samples.length - 1)]);
      const safeFrom = Number.isFinite(from) ? from : 0;
      const safeTo = Number.isFinite(to) ? to : 0;
      return safeFrom + (safeTo - safeFrom) * ratio;
    };

    return {
      values: Array.from({ length: points.length }, (_, index) => heightAt(index)),
      usedFallback: false,
    };
  } catch {
    return { values: points.map(() => 0), usedFallback: true };
  }
}

/** Moving average that removes DEM cell steps without flattening real climbs. */
export function smoothElevations(values: number[], window = 5): number[] {
  if (values.length < 3 || window < 3) return [...values];
  // A short track must not be averaged into a single flat height.
  const radius = Math.min(Math.floor(window / 2), Math.floor((values.length - 1) / 2));
  if (radius < 1) return [...values];

  return values.map((_, index) => {
    const from = Math.max(0, index - radius);
    const to = Math.min(values.length - 1, index + radius);
    let sum = 0;
    for (let i = from; i <= to; i += 1) sum += values[i];
    return sum / (to - from + 1);
  });
}

function positiveGain(values: number[]): number {
  let gain = 0;
  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta > 0.5) gain += delta;
  }
  return Math.round(gain);
}

/** Smoothed total climb for already-elevated coordinates. */
export function elevationGainOf(coordinates: LngLatEle[]): number {
  if (coordinates.length < 2) return 0;
  return positiveGain(smoothElevations(coordinates.map((point) => point[2] ?? 0)));
}

export function buildElevationProfile(
  coordinates: LngLatEle[],
  maxSamples = MAX_PROFILE_SAMPLES,
): ElevationSample[] {
  if (coordinates.length < 2) return [];

  const points = coordinates.map((point) => [point[0], point[1]] as LngLat);
  const cumulative = cumulativeDistances(points);
  const heights = smoothElevations(coordinates.map((point) => point[2] ?? 0));
  const indices = sampleIndices(coordinates.length, maxSamples);

  return indices.map((index) => ({
    distanceMeters: cumulative[index],
    elevationMeters: heights[index],
  }));
}

async function attachElevations(points: LngLat[]): Promise<{
  coordinates: LngLatEle[];
  usedFallback: boolean;
}> {
  const { values, usedFallback } = await fetchElevations(points);
  return {
    coordinates: points.map((point, index) => [point[0], point[1], values[index] ?? 0]),
    usedFallback,
  };
}

const CYCLING_BASE_SPEED_KMH = 22;
/** One extra minute for every 15 m of climbing. */
const CYCLING_CLIMB_MINUTES_PER_METER = 1 / 15;
const RUN_BASE_PACE_SECONDS_PER_KM = 6 * 60;
/** Seconds added per km for each 1% of average grade. */
const RUN_GRADE_PENALTY_SECONDS = 12;
const WALKING_BASE_SPEED_KMH = 5;
const WALKING_GRADE_PENALTY_SECONDS = 15;
const HIKE_BASE_SPEED_KMH = 4;
/** Naismith's Rule: +1 hour per 600 m of ascent. */
const HIKE_ASCENT_HOURS_PER_METER = 1 / 600;

export type SportEstimate = {
  durationSeconds: number;
  speedKmh: number;
  paceSecondsPerKm: number;
};

export function estimateSportMetrics(
  sportMode: SportMode,
  distanceMeters: number,
  elevationGainMeters: number,
): SportEstimate {
  const km = Math.max(distanceMeters, 0) / 1000;
  const gain = Math.max(elevationGainMeters, 0);
  const gradePercent = distanceMeters > 0 ? (gain / distanceMeters) * 100 : 0;

  let durationSeconds = 0;
  let paceSecondsPerKm = 0;

  switch (sportMode) {
    case 'cycling': {
      durationSeconds = (km / CYCLING_BASE_SPEED_KMH) * 3600 + gain * CYCLING_CLIMB_MINUTES_PER_METER * 60;
      paceSecondsPerKm = km > 0 ? durationSeconds / km : 0;
      break;
    }
    case 'run': {
      paceSecondsPerKm = RUN_BASE_PACE_SECONDS_PER_KM + gradePercent * RUN_GRADE_PENALTY_SECONDS;
      durationSeconds = paceSecondsPerKm * km;
      break;
    }
    case 'walking': {
      paceSecondsPerKm =
        (1 / WALKING_BASE_SPEED_KMH) * 3600 + gradePercent * WALKING_GRADE_PENALTY_SECONDS;
      durationSeconds = paceSecondsPerKm * km;
      break;
    }
    case 'hike': {
      durationSeconds =
        (km / HIKE_BASE_SPEED_KMH) * 3600 + gain * HIKE_ASCENT_HOURS_PER_METER * 3600;
      paceSecondsPerKm = km > 0 ? durationSeconds / km : 0;
      break;
    }
  }

  const speedKmh =
    km > 0 && durationSeconds > 0 ? km / (durationSeconds / 3600) : 0;

  return {
    durationSeconds: Number.isFinite(durationSeconds) ? Math.round(durationSeconds) : 0,
    speedKmh: Number.isFinite(speedKmh) ? speedKmh : 0,
    paceSecondsPerKm: Number.isFinite(paceSecondsPerKm) ? paceSecondsPerKm : 0,
  };
}

export function sportMetricLabels(sportMode: SportMode): {
  duration: string;
  secondary: string;
} {
  switch (sportMode) {
    case 'cycling':
      return { duration: 'Estimasi', secondary: 'Est. Kecepatan' };
    case 'run':
      return { duration: 'Estimasi', secondary: 'Target Pace' };
    case 'walking':
      return { duration: 'Estimasi', secondary: 'Pace Jalan' };
    case 'hike':
      return { duration: 'Estimasi', secondary: 'Pace Naik' };
  }
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 mnt';
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} mnt`;
  if (minutes === 0) return `${hours} j`;
  return `${hours}j ${minutes}m`;
}

export function formatSpeed(speedKmh: number): string {
  if (!Number.isFinite(speedKmh) || speedKmh <= 0) return '—';
  return `${speedKmh.toFixed(1)} km/j`;
}

export function formatPace(secondsPerKm: number): string {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return '—';
  const total = Math.round(secondsPerKm);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')} /km`;
}

function emptyResult(routingMode: RoutingMode): PlannedRouteResult {
  return {
    coordinates: [],
    distanceMeters: 0,
    elevationGainMeters: 0,
    durationSeconds: 0,
    elevationProfile: [],
    provider: 'straight',
    routingMode,
    usedElevationFallback: false,
  };
}

/**
 * Plans a route for the selected sport.
 *
 * Valhalla is the primary engine because its costing options can be tuned per
 * sport (road bike vs. hiking trails). A timeout or unroutable point falls back
 * to OSRM, and finally to the straight geodesic so the planner never blocks the
 * user. Elevation is always re-sampled from Open-Meteo, which also covers the
 * straight-line fallback that Valhalla cannot describe.
 */
export async function planRoute(
  waypoints: LngLat[],
  sportMode: SportMode,
  routingMode: RoutingMode,
): Promise<PlannedRouteResult> {
  const points = sanitizeWaypoints(waypoints);
  if (points.length < 2) return emptyResult(routingMode);

  let geometry: LngLat[] | null = null;
  let provider: RouteProvider = 'straight';

  if (routingMode === 'snap') {
    try {
      geometry = await requestValhalla(points, sportMode);
      provider = 'valhalla';
    } catch {
      try {
        geometry = await requestOsrm(points, sportMode);
        provider = 'osrm';
      } catch {
        geometry = null;
      }
    }
  }

  if (!geometry || geometry.length < 2) {
    geometry = buildStraightGeometry(points);
    provider = 'straight';
  }

  const { coordinates, usedFallback } = await attachElevations(geometry);
  const distanceMeters = Math.round(cumulativeDistances(geometry).at(-1) ?? 0);
  const elevationGainMeters = elevationGainOf(coordinates);
  const estimate = estimateSportMetrics(sportMode, distanceMeters, elevationGainMeters);

  return {
    coordinates,
    distanceMeters,
    elevationGainMeters,
    durationSeconds: estimate.durationSeconds,
    elevationProfile: buildElevationProfile(coordinates),
    provider,
    routingMode,
    usedElevationFallback: usedFallback,
  };
}
