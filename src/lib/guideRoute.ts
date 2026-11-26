import type { ActivityRecord } from './activity';
import { haversineMeters } from './routePlannerEngine';
import type { LngLat } from './polyline';

/** Guide polylines are stored latitude-first, matching the Follow Route spec. */
export type LatLng = [number, number];

export type GuideRoute = {
  id: string | number;
  name: string;
  /** Polyline as `[lat, lng]` pairs. */
  coordinates: LatLng[];
  distanceMeters: number;
};

export type GuideProgress = {
  /** Metres left along the guide polyline from the nearest point to the finish. */
  remainingMeters: number;
  /** Metres already covered when the position is projected onto the polyline. */
  alongMeters: number;
  /** 0–1 share of the polyline behind the rider. */
  progress: number;
  /** Straight-line distance from the GPS fix to the finish point. */
  distanceToFinishMeters: number;
  /** Perpendicular distance from the GPS fix to the closest route segment. */
  distanceToRouteMeters: number;
};

const METERS_PER_DEGREE_LAT = 110574;

export function toGuideRoute(activity: ActivityRecord): GuideRoute | null {
  const coordinates = activity.coordinates
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
    .map(([lng, lat]) => [lat, lng] as LatLng);
  if (coordinates.length < 2) return null;

  return {
    id: activity.id,
    name: activity.title,
    coordinates,
    distanceMeters: activity.distanceMeters,
  };
}

/** MapLibre wants lng/lat, the guide stores lat/lng. Broken fixes are dropped. */
export function guideToLngLat(coordinates: LatLng[]): LngLat[] {
  return coordinates
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng))
    .map(([lat, lng]) => [lng, lat]);
}

/** Metres per degree of longitude at a given latitude. */
function metersPerDegreeLng(latitude: number): number {
  return METERS_PER_DEGREE_LAT * Math.cos((latitude * Math.PI) / 180);
}

/**
 * Projects the GPS fix onto every segment of the guide polyline and keeps the
 * closest one. A local equirectangular projection is enough at segment scale
 * and keeps the per-fix cost linear without allocating turf features.
 */
export function computeGuideProgress(
  route: GuideRoute,
  position: { lat: number; lng: number },
): GuideProgress | null {
  const points = route.coordinates;
  if (points.length < 2) return null;

  const mPerLng = metersPerDegreeLng(position.lat);
  if (!(mPerLng > 0)) return null;

  let cumulative = 0;
  let best: { distance: number; along: number } | null = null;

  for (let i = 1; i < points.length; i += 1) {
    const [aLat, aLng] = points[i - 1];
    const [bLat, bLng] = points[i];

    const ax = (aLng - position.lng) * mPerLng;
    const ay = (aLat - position.lat) * METERS_PER_DEGREE_LAT;
    const bx = (bLng - position.lng) * mPerLng;
    const by = (bLat - position.lat) * METERS_PER_DEGREE_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const segmentSquared = dx * dx + dy * dy;
    const t = segmentSquared > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / segmentSquared)) : 0;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const distance = Math.hypot(px, py);
    const segmentMeters = Math.sqrt(segmentSquared);
    const along = cumulative + segmentMeters * t;

    if (!best || distance < best.distance) best = { distance, along };
    cumulative += segmentMeters;
  }

  if (!best || cumulative <= 0) return null;

  const last = points[points.length - 1];
  return {
    remainingMeters: Math.max(0, cumulative - best.along),
    alongMeters: best.along,
    progress: Math.min(1, Math.max(0, best.along / cumulative)),
    distanceToFinishMeters: haversineMeters([position.lng, position.lat], [last[1], last[0]]),
    distanceToRouteMeters: best.distance,
  };
}

/** `3,2 km` above a kilometre, `850 m` below it (Indonesian decimal comma). */
export function formatGuideDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '--';
  if (meters >= 1000) return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
  return `${Math.max(0, Math.round(meters))} m`;
}

export type GuideEndpointRole = 'start' | 'finish';

const GUIDE_ENDPOINT_COLORS: Record<GuideEndpointRole, string> = {
  start: '#22C55E',
  finish: '#EF4444',
};

/** Compact S/F badge used for the guide route endpoints on the live map. */
export function createGuideEndpointElement(role: GuideEndpointRole): HTMLDivElement {
  const element = document.createElement('div');
  element.setAttribute('aria-hidden', 'true');
  element.textContent = role === 'start' ? 'S' : 'F';
  element.style.cssText = [
    'width:24px',
    'height:24px',
    'border-radius:9999px',
    `border:2px solid ${GUIDE_ENDPOINT_COLORS[role]}`,
    'background:#0D1112',
    `color:${GUIDE_ENDPOINT_COLORS[role]}`,
    'box-sizing:border-box',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font:700 11px/1 system-ui,sans-serif',
    'pointer-events:none',
    'box-shadow:0 2px 8px rgba(13,17,18,0.55)',
  ].join(';');
  return element;
}
