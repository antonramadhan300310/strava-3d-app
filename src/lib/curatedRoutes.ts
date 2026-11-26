import { parseActivityGeometry, type ActivityRecord } from './activity';
import type { GuideRoute, LatLng } from './guideRoute';
import type { LngLat, LngLatEle } from './polyline';
import {
  isValidLngLat,
  normalizeRouteCoordinates,
} from './routeCoordinates';
import { estimateSportMetrics, haversineMeters } from './routePlannerEngine';
import { normalizeActivityType, type ActivityType } from './valhalla';

export type CuratedDifficulty = 'easy' | 'medium' | 'hard';

/** Row shape of `public.curated_routes`; extra aliases cover legacy schemas. */
export type CuratedRouteRow = {
  id: string | number;
  name?: string | null;
  title?: string | null;
  city?: string | null;
  area?: string | null;
  location?: string | null;
  sport_type?: string | null;
  activity_type?: string | null;
  distance_meters?: number | null;
  distance?: number | null;
  elevation_gain?: number | null;
  elevation_gain_meters?: number | null;
  difficulty?: string | null;
  description?: string | null;
  is_pro?: boolean | null;
  is_active?: boolean | null;
  created_at?: string | null;
  coordinates?: unknown;
  geojson?: unknown;
  route_geometry?: unknown;
};

export type CuratedRoute = {
  id: string | number;
  name: string;
  city: string | null;
  sportType: ActivityType;
  distanceMeters: number;
  elevationGain: number;
  difficulty: CuratedDifficulty;
  description: string | null;
  isPro: boolean;
  createdAt: string;
  /** GeoJSON order (`[lng, lat, ele]`), ready for the map and the guide. */
  coordinates: LngLatEle[];
};

export type CuratedSportFilter = 'all' | ActivityType;

export const CURATED_SPORT_FILTERS: { key: CuratedSportFilter; label: string }[] = [
  { key: 'all', label: 'Semua' },
  { key: 'cycling', label: 'Cycling' },
  { key: 'run', label: 'Run' },
  { key: 'walking', label: 'Walking' },
  { key: 'hike', label: 'Hike' },
];

export const SPORT_LABELS: Record<ActivityType, string> = {
  cycling: 'Cycling',
  run: 'Run',
  walking: 'Walking',
  hike: 'Hike',
};

export const DIFFICULTY_LABELS: Record<CuratedDifficulty, string> = {
  easy: 'Mudah',
  medium: 'Menengah',
  hard: 'Berat',
};

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const numeric = typeof value === 'string' ? Number(value) : value;
    if (typeof numeric === 'number' && Number.isFinite(numeric)) return numeric;
  }
  return null;
}

/**
 * Accepts a GeoJSON geometry/feature, a plain tuple array (either axis order),
 * an object list or a JSON string, and falls back to hex WKB. The shared
 * normaliser resolves `[lat, lng]` vs `[lng, lat]`, which the dashboard and the
 * older seed rows disagree on.
 */
function readCuratedCoordinates(value: unknown): LngLatEle[] {
  const normalized = normalizeRouteCoordinates(value);
  if (normalized.length >= 2) return normalized;

  const wkb = parseActivityGeometry(value);
  if (wkb.length >= 2) return normalizeRouteCoordinates(wkb);

  return normalized;
}

function polylineLengthMeters(coordinates: LngLatEle[]): number {
  let meters = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    meters += haversineMeters(coordinates[i - 1], coordinates[i]);
  }
  return meters;
}

/** Climb per kilometre, with a distance floor for long flat rides. */
function deriveDifficulty(distanceMeters: number, elevationGain: number): CuratedDifficulty {
  const km = distanceMeters / 1000;
  const gainPerKm = km > 0 ? elevationGain / km : 0;
  if (gainPerKm >= 35 || km >= 100) return 'hard';
  if (gainPerKm >= 15 || km >= 45) return 'medium';
  return 'easy';
}

function toDifficulty(
  value: unknown,
  distanceMeters: number,
  elevationGain: number,
): CuratedDifficulty {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (key === 'easy' || key === 'mudah' || key === 'ringan') return 'easy';
  if (key === 'medium' || key === 'moderate' || key === 'menengah' || key === 'sedang') {
    return 'medium';
  }
  if (key === 'hard' || key === 'berat' || key === 'sulit' || key === 'difficult') return 'hard';
  return deriveDifficulty(distanceMeters, elevationGain);
}

/** Drops rows without a usable polyline instead of breaking the whole feed. */
export function toCuratedRoute(row: CuratedRouteRow): CuratedRoute | null {
  const coordinates = readCuratedCoordinates(
    row.coordinates ?? row.geojson ?? row.route_geometry,
  );
  if (coordinates.length < 2) return null;

  const distanceMeters =
    firstNumber(row.distance_meters, row.distance) ?? polylineLengthMeters(coordinates);
  const elevationGain =
    firstNumber(row.elevation_gain, row.elevation_gain_meters) ?? 0;

  return {
    id: row.id,
    name: firstString(row.name, row.title) ?? 'Rute rekomendasi',
    city: firstString(row.city, row.area, row.location),
    sportType: normalizeActivityType(row.sport_type ?? row.activity_type),
    distanceMeters: Math.max(0, Math.round(distanceMeters)),
    elevationGain: Math.max(0, Math.round(elevationGain)),
    difficulty: toDifficulty(row.difficulty, distanceMeters, elevationGain),
    description: firstString(row.description),
    isPro: row.is_pro === true,
    createdAt: row.created_at ?? '',
    coordinates,
  };
}

export function matchesSportFilter(route: CuratedRoute, filter: CuratedSportFilter): boolean {
  return filter === 'all' || route.sportType === filter;
}

/** Light search over the route name and its city/area. */
export function matchesCuratedQuery(route: CuratedRoute, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [route.name, route.city ?? ''].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

export function curatedRouteKey(route: CuratedRoute): string {
  return String(route.id);
}

/**
 * A saved copy is matched by its curated id first; when the GeoJSON properties
 * were dropped on write, the same name and distance still identify the copy.
 */
export function isCuratedRouteSaved(
  route: CuratedRoute,
  savedRoutes: ActivityRecord[],
): boolean {
  return savedRoutes.some((activity) => {
    const savedCuratedId = activity.geojson?.properties?.curated_route_id;
    if (savedCuratedId !== undefined && savedCuratedId !== null) {
      return String(savedCuratedId) === curatedRouteKey(route);
    }
    return (
      activity.title.trim().toLowerCase() === route.name.trim().toLowerCase() &&
      Math.abs(activity.distanceMeters - route.distanceMeters) < 50
    );
  });
}

/** `12,4 km` (Indonesian decimal comma). */
export function formatRouteDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '0 km';
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

export function curatedRouteDurationSeconds(route: CuratedRoute): number {
  return estimateSportMetrics(route.sportType, route.distanceMeters, route.elevationGain)
    .durationSeconds;
}

/** The Follow Route engine stores latitude first. */
export function toCuratedGuideRoute(route: CuratedRoute): GuideRoute | null {
  // `route.coordinates` is already normalised; only drop broken points so a
  // single bad row cannot poison the whole guide.
  const coordinates: LatLng[] = route.coordinates
    .filter(([lng, lat]) => isValidLngLat(lng, lat))
    .map(([lng, lat]) => [lat, lng]);
  if (coordinates.length < 2) return null;

  return {
    id: `curated-${curatedRouteKey(route)}`,
    name: route.name,
    coordinates,
    distanceMeters: route.distanceMeters,
  };
}

/**
 * Normalised SVG points for the card preview. Longitude is scaled by the
 * cosine of the mid latitude so the shape is not stretched, and the result is
 * fitted into the viewBox while keeping its aspect ratio.
 *
 * A route that runs exactly north–south (or east–west) has a zero span on one
 * axis: that axis is centred instead of dividing by zero. When every point is
 * identical the preview degrades to a short centred dash, never an empty or
 * NaN `points` attribute.
 */
export function miniRoutePolyline(
  coordinates: LngLatEle[],
  width = 100,
  height = 56,
  padding = 6,
): string {
  const points = coordinates.filter(
    ([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat),
  );
  if (points.length < 2) return '';

  const step = Math.max(1, Math.ceil(points.length / 180));
  const sampled: LngLat[] = [];
  for (let i = 0; i < points.length; i += step) {
    sampled.push([points[i][0], points[i][1]]);
  }
  const last = points[points.length - 1];
  const tail = sampled[sampled.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) sampled.push([last[0], last[1]]);

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lng, lat] of sampled) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  const midLat = (minLat + maxLat) / 2;
  const cosLat = Math.max(0.01, Math.cos((midLat * Math.PI) / 180));
  const spanX = (maxLng - minLng) * cosLat;
  const spanY = maxLat - minLat;
  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);

  const scale = Math.min(
    spanX > 0 ? usableWidth / spanX : Number.POSITIVE_INFINITY,
    spanY > 0 ? usableHeight / spanY : Number.POSITIVE_INFINITY,
  );

  if (!Number.isFinite(scale)) {
    const midX = width / 2;
    const midY = height / 2;
    return `${(midX - 6).toFixed(2)},${midY.toFixed(2)} ${(midX + 6).toFixed(2)},${midY.toFixed(2)}`;
  }

  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;

  return sampled
    .map(([lng, lat]) => {
      const x = offsetX + (lng - minLng) * cosLat * scale;
      const y = height - (offsetY + (lat - minLat) * scale);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}
