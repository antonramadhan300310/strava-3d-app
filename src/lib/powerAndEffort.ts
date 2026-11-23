import { buildTrack } from './activityAnalytics';
import type { ActivityRecord } from './activity';
import {
  BIKE_PHYSICS,
  DEFAULT_RIDER_PROFILE,
  POWER_ZONE_DEFINITIONS,
  computePowerZoneRanges,
  type PowerZoneKey,
  type RiderProfile,
} from './riderProfile';
import { normalizeActivityType } from './valhalla';

const GRAVITY = 9.80665;
const AIR_DENSITY = 1.225;
const MAX_GRADE = 0.35;
const MAX_WATTS = 1400;
const NP_WINDOW_SECONDS = 30;
const PEAK_WINDOW_SECONDS = 1200;
const SUGGESTED_FTP_FACTOR = 0.95;

export const RPE_CACHE_KEY = 'tracker3d_activity_rpe_v1';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isCyclingRecord(activity: ActivityRecord): boolean {
  return (
    !activity.isPlannedRoute && normalizeActivityType(activity.activityType) === 'cycling'
  );
}

type PowerSample = {
  watts: number;
  seconds: number;
};

export type PowerZoneDistribution = {
  zone: PowerZoneKey;
  name: string;
  rangeLabel: string;
  seconds: number;
  percent: number;
  color: string;
};

export type CyclingPowerAnalysis = {
  avgPowerWatts: number;
  normalizedPowerWatts: number;
  wattsPerKg: number;
  peak20MinWatts: number | null;
  intensityFactor: number;
  tss: number;
  zones: PowerZoneDistribution[];
};

function buildPowerSamples(
  activity: ActivityRecord,
  profile: RiderProfile,
): { samples: PowerSample[]; seconds: number } | null {
  const track = buildTrack(activity);
  if (!track || track.points.length < 2) return null;

  const physics = BIKE_PHYSICS[profile.bikeType] ?? BIKE_PHYSICS.road;
  const totalMass = profile.bodyWeightKg + profile.bikeWeightKg;
  if (!(totalMass > 0)) return null;

  const points = track.points;
  const totalDistance = track.totalDistanceMeters;
  const duration =
    activity.durationSeconds > 0 ? activity.durationSeconds : track.totalTimeSeconds;
  const useTimestamps = track.hasTimestamps && track.totalTimeSeconds > 0;
  const averageSpeed = duration > 0 ? totalDistance / duration : 0;
  if (!(averageSpeed > 0)) return null;

  const samples: PowerSample[] = [];
  let seconds = 0;

  for (let i = 1; i < points.length; i += 1) {
    const segment = points[i].distance - points[i - 1].distance;
    if (!(segment > 0.01)) continue;

    const dt = useTimestamps
      ? points[i].time - points[i - 1].time
      : segment / averageSpeed;
    if (!(dt > 0)) continue;

    const speed = segment / dt;
    const grade = clamp((points[i].ele - points[i - 1].ele) / segment, -MAX_GRADE, MAX_GRADE);
    const angle = Math.atan(grade);

    const pGravity = totalMass * GRAVITY * Math.sin(angle) * speed;
    const pRolling = totalMass * GRAVITY * Math.cos(angle) * physics.crr * speed;
    const pAero = 0.5 * AIR_DENSITY * physics.cda * Math.pow(speed, 3);
    const watts = clamp(pGravity + pRolling + pAero, 0, MAX_WATTS);

    samples.push({ watts, seconds: dt });
    seconds += dt;
  }

  if (samples.length === 0 || !(seconds > 0)) return null;
  return { samples, seconds };
}

/** One value per second, sampled at the centre of each second. */
function expandToSeconds(samples: PowerSample[]): number[] {
  const totalSeconds = samples.reduce((total, sample) => total + sample.seconds, 0);
  const count = Math.max(1, Math.round(totalSeconds));
  const series: number[] = [];

  let index = 0;
  let sampleEnd = samples[0].seconds;

  for (let second = 0; second < count; second += 1) {
    const centre = second + 0.5;
    while (index < samples.length - 1 && centre >= sampleEnd) {
      index += 1;
      sampleEnd += samples[index].seconds;
    }
    series.push(samples[index].watts);
  }

  return series;
}

function weightedAveragePower(samples: PowerSample[]): number {
  let weighted = 0;
  let seconds = 0;
  for (const sample of samples) {
    weighted += sample.watts * sample.seconds;
    seconds += sample.seconds;
  }
  return seconds > 0 ? weighted / seconds : 0;
}

function normalizedPower(series: number[], fallback: number): number {
  if (series.length < NP_WINDOW_SECONDS) return fallback;

  let windowSum = 0;
  let fourthPowerSum = 0;
  let windows = 0;

  for (let i = 0; i < series.length; i += 1) {
    windowSum += series[i];
    if (i >= NP_WINDOW_SECONDS) windowSum -= series[i - NP_WINDOW_SECONDS];
    if (i >= NP_WINDOW_SECONDS - 1) {
      const mean = windowSum / NP_WINDOW_SECONDS;
      fourthPowerSum += Math.pow(mean, 4);
      windows += 1;
    }
  }

  return windows > 0 ? Math.pow(fourthPowerSum / windows, 0.25) : fallback;
}

function peakAveragePower(series: number[], windowSeconds: number): number | null {
  if (series.length < windowSeconds) {
    // Per-sample rounding can shave a second or two off an exact 20-minute ride.
    if (series.length >= windowSeconds - 2) {
      const total = series.reduce((sum, value) => sum + value, 0);
      return total / series.length;
    }
    return null;
  }

  let windowSum = 0;
  for (let i = 0; i < windowSeconds; i += 1) windowSum += series[i];

  let best = windowSum;
  for (let i = windowSeconds; i < series.length; i += 1) {
    windowSum += series[i] - series[i - windowSeconds];
    if (windowSum > best) best = windowSum;
  }

  return best / windowSeconds;
}

function zoneIndexFor(powerWatts: number, ftpWatts: number): number {
  const ratio = powerWatts / ftpWatts;
  if (ratio < 0.55) return 0;
  if (ratio <= 0.75) return 1;
  if (ratio <= 0.9) return 2;
  if (ratio <= 1.05) return 3;
  if (ratio <= 1.2) return 4;
  return 5;
}

function buildZoneDistribution(
  samples: PowerSample[],
  ftpWatts: number,
  totalSeconds: number,
): PowerZoneDistribution[] {
  const ranges = computePowerZoneRanges(ftpWatts);
  const zoneSeconds = [0, 0, 0, 0, 0, 0];

  for (const sample of samples) {
    zoneSeconds[zoneIndexFor(sample.watts, ftpWatts)] += sample.seconds;
  }

  return POWER_ZONE_DEFINITIONS.map((definition, index) => {
    const seconds = zoneSeconds[index];
    return {
      zone: definition.zone,
      name: definition.name,
      rangeLabel: ranges[index].rangeLabel,
      seconds: Math.round(seconds),
      percent:
        totalSeconds > 0 ? Number(((seconds / totalSeconds) * 100).toFixed(1)) : 0,
      color: definition.color,
    };
  });
}

/**
 * Estimates ride power from GPS speed and grade. Grade is measured on the
 * 35 m resampled track so 30 m DEM noise cannot fake a wall.
 */
export function computeCyclingPowerAnalysis(
  activity: ActivityRecord,
  profile: RiderProfile,
): CyclingPowerAnalysis | null {
  if (!isCyclingRecord(activity)) return null;

  const built = buildPowerSamples(activity, profile);
  if (!built) return null;

  const ftp = profile.ftpWatts > 0 ? profile.ftpWatts : DEFAULT_RIDER_PROFILE.ftpWatts;
  const avgPowerWatts = Math.round(weightedAveragePower(built.samples));
  const series = expandToSeconds(built.samples);
  const normalizedPowerWatts = Math.round(normalizedPower(series, avgPowerWatts));
  const peak = peakAveragePower(series, PEAK_WINDOW_SECONDS);
  const intensityFactor = Number((normalizedPowerWatts / ftp).toFixed(2));
  const durationSeconds =
    activity.durationSeconds > 0 ? activity.durationSeconds : built.seconds;

  return {
    avgPowerWatts,
    normalizedPowerWatts,
    wattsPerKg:
      profile.bodyWeightKg > 0
        ? Number((avgPowerWatts / profile.bodyWeightKg).toFixed(2))
        : 0,
    peak20MinWatts: peak === null ? null : Math.round(peak),
    intensityFactor,
    tss: Math.round(
      ((durationSeconds * normalizedPowerWatts * intensityFactor) / (ftp * 3600)) * 100,
    ),
    zones: buildZoneDistribution(built.samples, ftp, built.seconds),
  };
}

/**
 * Best 20-minute power across the cycling history, discounted by 5%, is a
 * common stand-in for a fresh FTP test.
 */
export function findSuggestedFtpFromHistory(
  activities: ActivityRecord[],
  profile: RiderProfile,
): number | null {
  let bestPeak20m = 0;

  for (const activity of activities) {
    if (!isCyclingRecord(activity)) continue;
    if (activity.durationSeconds > 0 && activity.durationSeconds < PEAK_WINDOW_SECONDS) continue;

    const analysis = computeCyclingPowerAnalysis(activity, profile);
    if (analysis?.peak20MinWatts && analysis.peak20MinWatts > bestPeak20m) {
      bestPeak20m = analysis.peak20MinWatts;
    }
  }

  return bestPeak20m > 0 ? Math.round(bestPeak20m * SUGGESTED_FTP_FACTOR) : null;
}

export type RpeScaleEntry = {
  value: number;
  label: string;
};

export const RPE_SCALE: RpeScaleEntry[] = [
  { value: 1, label: 'Sangat Ringan' },
  { value: 2, label: 'Ringan' },
  { value: 3, label: 'Mudah' },
  { value: 4, label: 'Cukup Mudah' },
  { value: 5, label: 'Sedang' },
  { value: 6, label: 'Cukup Berat' },
  { value: 7, label: 'Berat' },
  { value: 8, label: 'Sangat Berat' },
  { value: 9, label: 'Hampir Maksimal' },
  { value: 10, label: 'Maksimal' },
];

const RPE_WEIGHTS = [0, 0.35, 0.5, 0.7, 0.9, 1.15, 1.4, 1.75, 2.15, 2.6, 3.1];

export function isRpe(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10;
}

export function rpeLabel(rpe: number): string {
  return RPE_SCALE.find((entry) => entry.value === rpe)?.label ?? 'Sedang';
}

export type EffortCategory = 'Ringan' | 'Sedang' | 'Tinggi' | 'Sangat Tinggi';

export type RelativeEffort = {
  rpe: number;
  label: string;
  score: number;
  category: EffortCategory;
};

function effortCategory(score: number): EffortCategory {
  if (score < 35) return 'Ringan';
  if (score < 80) return 'Sedang';
  if (score < 140) return 'Tinggi';
  return 'Sangat Tinggi';
}

export function computeRelativeEffort(durationSeconds: number, rpe: number): RelativeEffort {
  const safeRpe = isRpe(rpe) ? rpe : 5;
  const minutes = Math.max(0, durationSeconds) / 60;
  const score = Math.max(1, Math.round(minutes * RPE_WEIGHTS[safeRpe]));

  return {
    rpe: safeRpe,
    label: rpeLabel(safeRpe),
    score,
    category: effortCategory(score),
  };
}

function readRpeMap(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(RPE_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, number] => isRpe(entry[1]),
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function getStoredActivityRpe(activityId: string | number): number | null {
  return readRpeMap()[String(activityId)] ?? null;
}

export function storeActivityRpe(activityId: string | number, rpe: number): void {
  if (typeof window === 'undefined' || !isRpe(rpe)) return;
  try {
    const map = readRpeMap();
    map[String(activityId)] = rpe;
    window.localStorage.setItem(RPE_CACHE_KEY, JSON.stringify(map));
  } catch {
    // Offline or quota errors fall back to the embedded GeoJSON value.
  }
}

/** Embedded GeoJSON properties win over the device cache. */
export function getActivityRpe(activity: ActivityRecord): number | null {
  const embedded = activity.geojson?.properties?.rpe;
  if (isRpe(embedded)) return embedded;
  return getStoredActivityRpe(activity.id);
}
