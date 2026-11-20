import { along, bearing, length as turfLength } from '@turf/turf';
import type { LngLat, LngLatEle } from './polyline';

export const FLYOVER_PITCH = 70;
export const FLYOVER_ZOOM = 15.5;
/** Distance ahead of the marker used to derive the camera heading. */
export const LOOK_AHEAD_METERS = 80;

export type FlyoverPath = {
  /** Route as a turf line, ready for `along`/`bearing`. */
  line: GeoJSON.Feature<GeoJSON.LineString>;
  coordinates: LngLatEle[];
  totalMeters: number;
  /** Distance travelled at each vertex, in metres. */
  cumulative: number[];
};

export type FlyoverSample = {
  lng: number;
  lat: number;
  ele: number;
  /** Raw heading in degrees (0–360) along the route. */
  bearing: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function buildFlyoverPath(coordinates: LngLatEle[]): FlyoverPath | null {
  if (coordinates.length < 2) return null;

  const line: GeoJSON.Feature<GeoJSON.LineString> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  };

  const cumulative: number[] = [0];
  for (let i = 1; i < coordinates.length; i += 1) {
    const previous = coordinates[i - 1];
    const current = coordinates[i];
    const segment = turfLength(
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [previous, current] },
      },
      { units: 'meters' },
    );
    cumulative.push(cumulative[i - 1] + segment);
  }

  const totalMeters = turfLength(line, { units: 'meters' });
  if (!Number.isFinite(totalMeters) || totalMeters <= 0) return null;

  return { line, coordinates, totalMeters, cumulative };
}

/** Index of the vertex at or before `distance`. */
function segmentIndex(cumulative: number[], distance: number): number {
  let low = 0;
  let high = cumulative.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (cumulative[mid] <= distance) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function pointAt(path: FlyoverPath, distance: number): LngLat {
  const clamped = clamp(distance, 0, path.totalMeters);
  const [lng, lat] = along(path.line, clamped, { units: 'meters' }).geometry.coordinates;
  return [lng, lat];
}

/** Interpolates the third coordinate (`ele`) so the HUD altitude tracks the route. */
export function elevationAt(path: FlyoverPath, distance: number): number {
  const clamped = clamp(distance, 0, path.totalMeters);
  const index = segmentIndex(path.cumulative, clamped);
  const from = path.coordinates[index];
  const to = path.coordinates[Math.min(index + 1, path.coordinates.length - 1)];
  const span = path.cumulative[Math.min(index + 1, path.cumulative.length - 1)] - path.cumulative[index];
  const ratio = span > 0 ? (clamped - path.cumulative[index]) / span : 0;
  return from[2] + (to[2] - from[2]) * clamp(ratio, 0, 1);
}

/**
 * Heading of the route at `distance`, measured towards a look-ahead point so
 * the camera turns into corners before the marker reaches them.
 */
export function bearingAt(path: FlyoverPath, distance: number): number {
  const clamped = clamp(distance, 0, path.totalMeters);
  const ahead = Math.min(clamped + LOOK_AHEAD_METERS, path.totalMeters);
  const behind = Math.max(clamped - LOOK_AHEAD_METERS, 0);

  let heading: number;
  if (ahead - clamped > 1) {
    heading = bearing(pointAt(path, clamped), pointAt(path, ahead));
  } else if (clamped - behind > 1) {
    heading = bearing(pointAt(path, behind), pointAt(path, clamped));
  } else {
    heading = 0;
  }

  return (heading + 360) % 360;
}

export function sampleAt(path: FlyoverPath, distance: number): FlyoverSample {
  const clamped = clamp(distance, 0, path.totalMeters);
  const [lng, lat] = pointAt(path, clamped);
  return {
    lng,
    lat,
    ele: elevationAt(path, clamped),
    bearing: bearingAt(path, clamped),
  };
}

/** Shortest-path angular interpolation, used to smooth camera rotation. */
export function lerpBearing(current: number, target: number, alpha: number): number {
  const delta = ((target - current + 540) % 360) - 180;
  return (current + delta * alpha + 360) % 360;
}

/** Downsampled elevation profile for the mini chart, with its own min/max. */
export function elevationProfile(coordinates: LngLatEle[], samples = 120) {
  const values = coordinates.map((coordinate) =>
    Number.isFinite(coordinate[2]) ? coordinate[2] : 0,
  );
  const step = Math.max(1, Math.ceil(values.length / samples));
  const points: number[] = [];
  for (let i = 0; i < values.length; i += step) points.push(values[i]);
  if (points[points.length - 1] !== values[values.length - 1]) {
    points.push(values[values.length - 1]);
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of points) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { points: [], min: 0, max: 0 };
  if (max - min < 1) {
    // A flat profile still needs a visible band instead of a zero-height line.
    return { points, min: min - 0.5, max: max + 0.5 };
  }
  return { points, min, max };
}
