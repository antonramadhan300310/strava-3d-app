import { distance as turfDistance } from '@turf/turf';
import type { LngLat } from './polyline';

/**
 * Fixes worse than this are too noisy to trust for distance and speed. Above
 * 25 m the phone is usually on a cell/Wi-Fi position rather than a satellite
 * one, which is what drags the line off the road under a flyover.
 */
export const MAX_ACCURACY_METERS = 25;
/** Minimum movement from the last accepted fix; below this is GPS jitter. */
export const MIN_MOVEMENT_METERS = 3;
/** Speed is reported as zero once no accepted fix has arrived for this long. */
export const SPEED_STALE_MS = 5000;
/** Below this speed pace is meaningless, so it renders as `--:--`. */
export const MIN_PACE_SPEED_KMH = 0.5;

export type AcceptedPoint = {
  lng: number;
  lat: number;
  ele: number | null;
  /** Milliseconds since the unix epoch. */
  time: number;
  accuracy: number;
  /** GPS ground speed in m/s when the device reported one. */
  speed: number | null;
};

export type GpsQuality = 'good' | 'fair' | 'poor';

export function gpsQuality(accuracyMeters: number | null): GpsQuality {
  if (accuracyMeters === null || !Number.isFinite(accuracyMeters)) return 'poor';
  if (accuracyMeters <= 8) return 'good';
  if (accuracyMeters <= MAX_ACCURACY_METERS) return 'fair';
  return 'poor';
}

export function gpsBadgeText(accuracyMeters: number | null): string {
  if (accuracyMeters === null || !Number.isFinite(accuracyMeters)) return 'Mencari Sinyal GPS...';
  const rounded = Math.round(accuracyMeters);
  if (accuracyMeters > MAX_ACCURACY_METERS) return `Sinyal Lemah • Akurasi ${rounded}m`;
  return `GPS Siap • Akurasi ${rounded}m`;
}

/** Cumulative great-circle length of the recorded track, in metres. */
export function totalDistanceMeters(points: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += turfDistance(points[i - 1], points[i], { units: 'meters' });
  }
  return total;
}

export type CurrentSpeedInput = {
  points: AcceptedPoint[];
  /** Timestamp of the most recent accepted fix, or null before the first fix. */
  lastFixTime: number | null;
  /** Wall clock used to detect a stalled GPS stream. */
  now: number;
};

/**
 * Instantaneous speed in km/h.
 *
 * GPS ground speed wins when the device reports it, because it is derived from
 * the Doppler shift rather than from two noisy positions. Otherwise the last
 * pair of accepted fixes is used.
 */
export function currentSpeedKmh({ points, lastFixTime, now }: CurrentSpeedInput): number {
  if (lastFixTime === null) return 0;
  if (now - lastFixTime > SPEED_STALE_MS) return 0;
  if (points.length < 2) return 0;

  const latest = points[points.length - 1];
  if (latest.speed !== null && Number.isFinite(latest.speed) && latest.speed >= 0) {
    return latest.speed * 3.6;
  }

  const previous = points[points.length - 2];
  const seconds = (latest.time - previous.time) / 1000;
  if (seconds <= 0) return 0;

  const meters = turfDistance(
    [previous.lng, previous.lat],
    [latest.lng, latest.lat],
    { units: 'meters' },
  );
  return (meters / seconds) * 3.6;
}

export function averageSpeedKmh(distanceMeters: number, activeSeconds: number): number {
  if (activeSeconds <= 0) return 0;
  return distanceMeters / 1000 / (activeSeconds / 3600);
}

/** Pace in seconds per kilometre, or null when the speed is too low to be meaningful. */
export function paceSecondsPerKm(speedKmh: number): number | null {
  if (!Number.isFinite(speedKmh) || speedKmh < MIN_PACE_SPEED_KMH) return null;
  return 3600 / speedKmh;
}

export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export function formatPace(secondsPerKm: number | null): string {
  if (secondsPerKm === null || !Number.isFinite(secondsPerKm)) return '--:--';
  const safe = Math.round(secondsPerKm);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatSpeed(kmh: number): string {
  if (!Number.isFinite(kmh) || kmh < 0) return '0.0';
  return kmh.toFixed(1);
}

export function formatDistanceKm(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '0.00';
  return (meters / 1000).toFixed(2);
}
