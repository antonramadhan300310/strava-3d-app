import { pointToLineDistance } from '@turf/turf';
import type { ActivityRecord } from './activity';
import { timestampOf, type LngLatEle } from './polyline';
import { normalizeActivityType, type ActivityType } from './valhalla';
import { haversineMeters } from './routeAnalysis';

/** Grade is measured on segments this long so 30 m DEM noise cannot fake a wall. */
const GRADE_SPACING_METERS = 35;
const MAX_GRADE = 0.35;
const MINETTI_FLAT_COST = 3.6;
const ELEVATION_NOISE_METERS = 0.5;

const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;
const DEFAULT_TOTAL_MASS_KG = 78;
const ROLLING_RESISTANCE = 0.005;
const DRAG_AREA_M2 = 0.35;

const MATCH_RADIUS_METERS = 150;
const MATCH_DISTANCE_TOLERANCE = 0.1;
const MATCH_SAMPLE_FRACTIONS = [0.2, 0.35, 0.5, 0.65, 0.8];
const MIN_REMAINDER_METERS = 100;

export function isFootSport(sportType: ActivityType): boolean {
  return normalizeActivityType(sportType) !== 'cycling';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Minetti et al. (2002) metabolic cost of walking/running on a gradient,
 * in J/(kg·m). `grade` is the rise over run as a fraction.
 */
export function minettiCost(grade: number): number {
  const i = clamp(grade, -MAX_GRADE, MAX_GRADE);
  return (
    155.4 * i ** 5 -
    30.4 * i ** 4 -
    43.3 * i ** 3 +
    46.3 * i ** 2 +
    19.5 * i +
    MINETTI_FLAT_COST
  );
}

/** Cost relative to flat ground; 1 means a flat metre costs one flat metre. */
export function gradeLoadRatio(grade: number): number {
  return minettiCost(grade) / MINETTI_FLAT_COST;
}

function gradeOf(segmentMeters: number, climbMeters: number): number {
  if (!(segmentMeters > 0)) return 0;
  return clamp(climbMeters / segmentMeters, -MAX_GRADE, MAX_GRADE);
}

type RawPoint = {
  lng: number;
  lat: number;
  ele: number;
  time: number | null;
  distance: number;
};

export type TrackPoint = {
  lng: number;
  lat: number;
  ele: number;
  distance: number;
  /** Seconds from the start of the activity. */
  time: number;
};

export type TrackModel = {
  points: TrackPoint[];
  totalDistanceMeters: number;
  totalTimeSeconds: number;
  /** True when every vertex carried an epoch timestamp. */
  hasTimestamps: boolean;
};

function finiteCoordinate(coordinate: LngLatEle): boolean {
  return (
    Number.isFinite(coordinate[0]) &&
    Number.isFinite(coordinate[1]) &&
    coordinate.length >= 2
  );
}

function buildRawTrack(coordinates: LngLatEle[]): RawPoint[] {
  const points: RawPoint[] = [];
  for (const coordinate of coordinates) {
    if (!finiteCoordinate(coordinate)) continue;
    const lng = coordinate[0];
    const lat = coordinate[1];
    const ele = Number.isFinite(coordinate[2]) ? coordinate[2] : 0;
    const time = timestampOf(coordinate);
    const previous = points[points.length - 1];
    const distance = previous
      ? previous.distance + haversineMeters([previous.lng, previous.lat], [lng, lat])
      : 0;
    if (previous && distance - previous.distance <= 0.01) continue;
    points.push({ lng, lat, ele, time, distance });
  }
  return points;
}

function interpolateRaw(from: RawPoint, to: RawPoint, ratio: number, distance: number): RawPoint {
  const time =
    from.time !== null && to.time !== null ? from.time + (to.time - from.time) * ratio : null;
  return {
    lng: from.lng + (to.lng - from.lng) * ratio,
    lat: from.lat + (to.lat - from.lat) * ratio,
    ele: from.ele + (to.ele - from.ele) * ratio,
    time,
    distance,
  };
}

function resampleRaw(points: RawPoint[], spacing: number): RawPoint[] {
  if (points.length < 2) return [...points];

  const out: RawPoint[] = [points[0]];
  let distanceSinceSample = 0;

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    const segment = to.distance - from.distance;
    if (!(segment > 0.01)) continue;

    let travelled = 0;
    while (distanceSinceSample + (segment - travelled) >= spacing) {
      travelled += spacing - distanceSinceSample;
      const ratio = travelled / segment;
      out.push(interpolateRaw(from, to, ratio, from.distance + travelled));
      distanceSinceSample = 0;
    }
    distanceSinceSample += segment - travelled;
  }

  const last = points[points.length - 1];
  if (out[out.length - 1].distance < last.distance - 0.5) out.push(last);
  return out;
}

/**
 * Builds a smoothed track with a monotonic time axis. Legacy rows without
 * per-point timestamps get their duration distributed by Minetti load, which
 * keeps climbs slower than descents instead of assuming a constant speed.
 */
export function buildTrack(activity: ActivityRecord): TrackModel | null {
  const raw = buildRawTrack(activity.coordinates);
  if (raw.length < 2) return null;

  const rawTotal = raw[raw.length - 1].distance;
  if (!(rawTotal > 0)) return null;

  const points = resampleRaw(raw, GRADE_SPACING_METERS);
  if (points.length < 2) return null;

  // The stored distance is the official one; use it when it is plausible so
  // kilometre boundaries line up with the activity summary.
  const official = activity.distanceMeters;
  const scale =
    official > 0 && official / rawTotal >= 0.5 && official / rawTotal <= 2
      ? official / rawTotal
      : 1;

  const hasTimestamps =
    raw.every((point) => point.time !== null) &&
    (raw[raw.length - 1].time as number) > (raw[0].time as number);

  const result: TrackPoint[] = points.map((point) => ({
    lng: point.lng,
    lat: point.lat,
    ele: point.ele,
    distance: point.distance * scale,
    time: 0,
  }));

  const totalDistanceMeters = result[result.length - 1].distance;

  if (hasTimestamps) {
    const start = raw[0].time as number;
    const end = raw[raw.length - 1].time as number;
    for (let i = 0; i < result.length; i += 1) {
      const rawTime = points[i].time as number;
      // Resampled points interpolate their timestamp, so the offset is exact.
      result[i].time = clamp((rawTime - start) / 1000, 0, (end - start) / 1000);
    }
    // Interpolation at the very end can land a hair early; anchor the finish.
    result[result.length - 1].time = (end - start) / 1000;
  } else {
    const duration = activity.durationSeconds;
    if (duration > 0) {
      const weights: number[] = [0];
      let totalWeight = 0;
      for (let i = 1; i < result.length; i += 1) {
        const segment = result[i].distance - result[i - 1].distance;
        if (!(segment > 0)) {
          weights.push(totalWeight);
          continue;
        }
        const grade = gradeOf(segment, result[i].ele - result[i - 1].ele);
        totalWeight += segment * gradeLoadRatio(grade);
        weights.push(totalWeight);
      }

      if (totalWeight > 0) {
        for (let i = 0; i < result.length; i += 1) {
          result[i].time = (weights[i] / totalWeight) * duration;
        }
      }
    }
  }

  return {
    points: result,
    totalDistanceMeters,
    totalTimeSeconds: result[result.length - 1].time,
    hasTimestamps,
  };
}

function pointAtDistance(points: TrackPoint[], distance: number): TrackPoint {
  const first = points[0];
  const last = points[points.length - 1];
  if (distance <= first.distance) return { ...first, distance };
  if (distance >= last.distance) return { ...last, distance: last.distance };

  let low = 0;
  let high = points.length - 1;
  while (low < high - 1) {
    const mid = (low + high) >> 1;
    if (points[mid].distance <= distance) low = mid;
    else high = mid;
  }

  const from = points[low];
  const to = points[high];
  const span = to.distance - from.distance;
  const ratio = span > 0 ? (distance - from.distance) / span : 0;
  return {
    lng: from.lng + (to.lng - from.lng) * ratio,
    lat: from.lat + (to.lat - from.lat) * ratio,
    ele: from.ele + (to.ele - from.ele) * ratio,
    distance,
    time: from.time + (to.time - from.time) * ratio,
  };
}

type SegmentStats = {
  flatEquivalentMeters: number;
  elevationGain: number;
  elevationLoss: number;
};

function segmentStats(points: TrackPoint[], fromDistance: number, toDistance: number): SegmentStats {
  let flatEquivalentMeters = 0;
  let elevationGain = 0;
  let elevationLoss = 0;

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (current.distance <= fromDistance) continue;
    if (previous.distance >= toDistance) break;

    const start = previous.distance < fromDistance ? pointAtDistance(points, fromDistance) : previous;
    const end = current.distance > toDistance ? pointAtDistance(points, toDistance) : current;
    const segment = end.distance - start.distance;
    if (!(segment > 0)) continue;

    const climb = end.ele - start.ele;
    flatEquivalentMeters += segment * gradeLoadRatio(gradeOf(segment, climb));
    if (climb > ELEVATION_NOISE_METERS) elevationGain += climb;
    else if (climb < -ELEVATION_NOISE_METERS) elevationLoss += -climb;
  }

  return { flatEquivalentMeters, elevationGain, elevationLoss };
}

export type GradeAdjustedSummary = {
  /** Flat-equivalent pace for foot sports, seconds per kilometre. */
  gapSecondsPerKm: number | null;
  averageSpeedKmh: number | null;
  /** Physics-based estimate for cycling, watts. */
  estimatedPowerWatts: number | null;
};

function estimateCyclingPower(track: TrackModel): number | null {
  const { points } = track;
  let energy = 0;
  let elapsed = 0;

  for (let i = 1; i < points.length; i += 1) {
    const seconds = points[i].time - points[i - 1].time;
    const segment = points[i].distance - points[i - 1].distance;
    if (!(seconds > 0) || !(segment > 0)) continue;

    const speed = segment / seconds;
    const grade = gradeOf(segment, points[i].ele - points[i - 1].ele);
    const gravity = DEFAULT_TOTAL_MASS_KG * GRAVITY * grade;
    const rolling =
      ROLLING_RESISTANCE * DEFAULT_TOTAL_MASS_KG * GRAVITY * Math.cos(Math.atan(grade));
    const drag = 0.5 * AIR_DENSITY * DRAG_AREA_M2 * speed * speed;
    energy += Math.max(0, speed * (gravity + rolling + drag)) * seconds;
    elapsed += seconds;
  }

  if (!(elapsed > 0)) return null;
  return Math.round(energy / elapsed);
}

export function computeGAP(activity: ActivityRecord): GradeAdjustedSummary {
  const track = buildTrack(activity);
  if (!track) {
    return { gapSecondsPerKm: null, averageSpeedKmh: null, estimatedPowerWatts: null };
  }

  const duration =
    activity.durationSeconds > 0 ? activity.durationSeconds : track.totalTimeSeconds;
  const averageSpeedKmh =
    duration > 0 ? track.totalDistanceMeters / 1000 / (duration / 3600) : null;

  if (!isFootSport(activity.activityType)) {
    return {
      gapSecondsPerKm: null,
      averageSpeedKmh,
      estimatedPowerWatts: estimateCyclingPower(track),
    };
  }

  let flatEquivalentMeters = 0;
  for (let i = 1; i < track.points.length; i += 1) {
    const segment = track.points[i].distance - track.points[i - 1].distance;
    if (!(segment > 0)) continue;
    const grade = gradeOf(segment, track.points[i].ele - track.points[i - 1].ele);
    flatEquivalentMeters += segment * gradeLoadRatio(grade);
  }

  return {
    gapSecondsPerKm:
      flatEquivalentMeters > 0 && duration > 0
        ? duration / (flatEquivalentMeters / 1000)
        : null,
    averageSpeedKmh,
    estimatedPowerWatts: null,
  };
}

export type KmSplit = {
  kmLabel: string;
  distanceMeters: number;
  durationSeconds: number;
  paceSecondsPerKm: number;
  speedKmh: number;
  gapSecondsPerKm: number;
  elevationGain: number;
  elevationLoss: number;
};

/**
 * Cuts the route at every full kilometre, interpolating the boundary point so
 * the split really is 1000 m long. A final remainder is kept when it is long
 * enough to be meaningful.
 */
export function computeKmSplits(activity: ActivityRecord): KmSplit[] {
  const track = buildTrack(activity);
  if (!track) return [];

  const total = track.totalDistanceMeters;
  const boundaries: number[] = [0];
  for (let distance = 1000; distance <= total + 1e-6; distance += 1000) {
    boundaries.push(Math.min(distance, total));
  }
  if (total - boundaries[boundaries.length - 1] >= MIN_REMAINDER_METERS) {
    boundaries.push(total);
  }

  const splits: KmSplit[] = [];
  for (let i = 1; i < boundaries.length; i += 1) {
    const fromDistance = boundaries[i - 1];
    const toDistance = boundaries[i];
    const distanceMeters = toDistance - fromDistance;
    if (!(distanceMeters > 0)) continue;

    const start = pointAtDistance(track.points, fromDistance);
    const end = pointAtDistance(track.points, toDistance);
    const durationSeconds = Math.max(0, end.time - start.time);
    const stats = segmentStats(track.points, fromDistance, toDistance);

    splits.push({
      kmLabel: `KM ${Math.floor(fromDistance / 1000) + 1}`,
      distanceMeters,
      durationSeconds,
      paceSecondsPerKm:
        distanceMeters > 0 ? durationSeconds / (distanceMeters / 1000) : 0,
      speedKmh:
        durationSeconds > 0 ? distanceMeters / 1000 / (durationSeconds / 3600) : 0,
      gapSecondsPerKm:
        stats.flatEquivalentMeters > 0
          ? durationSeconds / (stats.flatEquivalentMeters / 1000)
          : 0,
      elevationGain: Math.round(stats.elevationGain),
      elevationLoss: Math.round(stats.elevationLoss),
    });
  }

  return splits;
}

export type MatchedActivity = {
  activity: ActivityRecord;
  rank: number;
  /** Seconds behind the fastest attempt on the route (0 for the winner). */
  deltaSeconds: number;
  /** Signed difference against the activity currently open. */
  relativeToCurrentSeconds: number;
  isCurrent: boolean;
};

function rawCumulative(coordinates: LngLatEle[]): number[] {
  const cumulative: number[] = [0];
  for (let i = 1; i < coordinates.length; i += 1) {
    cumulative.push(
      cumulative[i - 1] + haversineMeters(coordinates[i - 1], coordinates[i]),
    );
  }
  return cumulative;
}

function pointAtFraction(coordinates: LngLatEle[], fraction: number): [number, number] {
  const cumulative = rawCumulative(coordinates);
  const total = cumulative[cumulative.length - 1];
  if (!(total > 0)) return [coordinates[0][0], coordinates[0][1]];
  const target = total * fraction;

  let low = 0;
  let high = cumulative.length - 1;
  while (low < high - 1) {
    const mid = (low + high) >> 1;
    if (cumulative[mid] <= target) low = mid;
    else high = mid;
  }

  const span = cumulative[high] - cumulative[low];
  const ratio = span > 0 ? (target - cumulative[low]) / span : 0;
  return [
    coordinates[low][0] + (coordinates[high][0] - coordinates[low][0]) * ratio,
    coordinates[low][1] + (coordinates[high][1] - coordinates[low][1]) * ratio,
  ];
}

function lineFeature(coordinates: LngLatEle[]): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  };
}

function routeMatches(
  current: ActivityRecord,
  candidate: ActivityRecord,
  currentDistance: number,
): boolean {
  if (candidate.coordinates.length < 2) return false;

  const candidateDistance =
    candidate.distanceMeters > 0
      ? candidate.distanceMeters
      : (buildTrack(candidate)?.totalDistanceMeters ?? 0);
  if (!(candidateDistance > 0)) return false;

  const distanceDifference =
    Math.abs(candidateDistance - currentDistance) / Math.max(currentDistance, 1);
  if (distanceDifference > MATCH_DISTANCE_TOLERANCE) return false;

  const currentStart = current.coordinates[0];
  const currentEnd = current.coordinates[current.coordinates.length - 1];
  const candidateStart = candidate.coordinates[0];
  const candidateEnd = candidate.coordinates[candidate.coordinates.length - 1];

  if (haversineMeters(currentStart, candidateStart) > MATCH_RADIUS_METERS) return false;
  if (haversineMeters(currentEnd, candidateEnd) > MATCH_RADIUS_METERS) return false;

  const candidateLine = lineFeature(candidate.coordinates);
  return MATCH_SAMPLE_FRACTIONS.every((fraction) => {
    const [lng, lat] = pointAtFraction(current.coordinates, fraction);
    return (
      pointToLineDistance([lng, lat], candidateLine, { units: 'meters' }) <=
      MATCH_RADIUS_METERS
    );
  });
}

function effectiveDuration(activity: ActivityRecord): number {
  if (activity.durationSeconds > 0) return activity.durationSeconds;
  const track = buildTrack(activity);
  return track?.totalTimeSeconds ?? 0;
}

/**
 * Finds attempts on the same route and ranks them by moving time. The open
 * activity is always part of the result so the UI can show its place.
 */
export function findMatchedActivities(
  activity: ActivityRecord,
  allActivities: ActivityRecord[],
): MatchedActivity[] {
  if (activity.isPlannedRoute) return [];

  const sport = normalizeActivityType(activity.activityType);
  const currentId = String(activity.id);
  const pool = allActivities.filter(
    (candidate) =>
      !candidate.isPlannedRoute &&
      normalizeActivityType(candidate.activityType) === sport &&
      candidate.coordinates.length >= 2,
  );

  const current = pool.find((candidate) => String(candidate.id) === currentId) ?? activity;
  const currentDistance =
    current.distanceMeters > 0
      ? current.distanceMeters
      : (buildTrack(current)?.totalDistanceMeters ?? 0);

  const matches = pool.filter(
    (candidate) =>
      String(candidate.id) === currentId ||
      routeMatches(current, candidate, currentDistance),
  );
  if (!matches.some((candidate) => String(candidate.id) === currentId)) matches.push(current);

  const durations = new Map<string, number>();
  for (const candidate of matches) {
    durations.set(String(candidate.id), effectiveDuration(candidate));
  }

  const sorted = [...matches].sort((a, b) => {
    const durationA = durations.get(String(a.id)) ?? 0;
    const durationB = durations.get(String(b.id)) ?? 0;
    if (durationA <= 0 && durationB <= 0) return 0;
    if (durationA <= 0) return 1;
    if (durationB <= 0) return -1;
    return durationA - durationB;
  });

  const fastest = durations.get(String(sorted[0].id)) ?? 0;
  const currentDuration = durations.get(currentId) ?? 0;

  return sorted.map((candidate, index) => {
    const duration = durations.get(String(candidate.id)) ?? 0;
    return {
      activity: candidate,
      rank: index + 1,
      deltaSeconds:
        duration > 0 && fastest > 0 ? Math.max(0, duration - fastest) : 0,
      relativeToCurrentSeconds:
        duration > 0 && currentDuration > 0 ? duration - currentDuration : 0,
      isCurrent: String(candidate.id) === currentId,
    };
  });
}

export function formatSignedDelta(seconds: number): string {
  const rounded = Math.round(seconds);
  const sign = rounded < 0 ? '-' : '+';
  const absolute = Math.abs(rounded);
  const minutes = Math.floor(absolute / 60);
  const rest = absolute % 60;
  return `${sign}${minutes}:${String(rest).padStart(2, '0')}`;
}

export type PRKind = 'time' | 'distance' | 'elevation';

export type PRCategory = {
  key: string;
  label: string;
  shortLabel: string;
  kind: PRKind;
  distanceMeters: number | null;
};

const FOOT_TARGETS: PRCategory[] = [
  { key: '1k', label: '1K', shortLabel: '1K', kind: 'time', distanceMeters: 1000 },
  { key: '5k', label: '5K', shortLabel: '5K', kind: 'time', distanceMeters: 5000 },
  { key: '10k', label: '10K', shortLabel: '10K', kind: 'time', distanceMeters: 10000 },
  {
    key: 'half',
    label: 'Half Marathon',
    shortLabel: '21.1K',
    kind: 'time',
    distanceMeters: 21097,
  },
];

const CYCLING_TARGETS: PRCategory[] = [
  { key: '10k', label: '10K', shortLabel: '10K', kind: 'time', distanceMeters: 10000 },
  { key: '20k', label: '20K', shortLabel: '20K', kind: 'time', distanceMeters: 20000 },
  { key: '50k', label: '50K', shortLabel: '50K', kind: 'time', distanceMeters: 50000 },
  { key: '100k', label: '100K', shortLabel: '100K', kind: 'time', distanceMeters: 100000 },
];

const SUMMARY_CATEGORIES: PRCategory[] = [
  {
    key: 'distance',
    label: 'Jarak Terjauh',
    shortLabel: 'Jarak',
    kind: 'distance',
    distanceMeters: null,
  },
  {
    key: 'elevation',
    label: 'Elevasi Tertinggi',
    shortLabel: 'Elevasi',
    kind: 'elevation',
    distanceMeters: null,
  },
];

export function prCategoriesFor(sportType: ActivityType): PRCategory[] {
  const targets = normalizeActivityType(sportType) === 'cycling' ? CYCLING_TARGETS : FOOT_TARGETS;
  return [...targets, ...SUMMARY_CATEGORIES];
}

function timeAtDistance(points: TrackPoint[], distance: number): number {
  return pointAtDistance(points, distance).time;
}

function fastestWindowSeconds(points: TrackPoint[], targetMeters: number): number | null {
  const last = points[points.length - 1];
  if (last.distance + 0.5 < targetMeters) return null;

  let best = Number.POSITIVE_INFINITY;
  let endIndex = 0;

  for (let startIndex = 0; startIndex < points.length; startIndex += 1) {
    const target = points[startIndex].distance + targetMeters;
    if (target > last.distance + 0.5) break;
    if (endIndex < startIndex) endIndex = startIndex;
    while (endIndex < points.length - 1 && points[endIndex].distance < target) {
      endIndex += 1;
    }

    const duration = timeAtDistance(points, target) - points[startIndex].time;
    if (duration > 0 && duration < best) best = duration;
  }

  return Number.isFinite(best) ? best : null;
}

export type ActivityPersonalRecord = {
  key: string;
  label: string;
  shortLabel: string;
  kind: PRKind;
  distanceMeters: number | null;
  durationSeconds: number | null;
  paceSecondsPerKm: number | null;
  speedKmh: number | null;
  valueMeters: number | null;
};

function paceOf(duration: number | null, distanceMeters: number | null): number | null {
  if (duration === null || distanceMeters === null || distanceMeters <= 0) return null;
  return duration / (distanceMeters / 1000);
}

function speedOf(duration: number | null, distanceMeters: number | null): number | null {
  if (duration === null || distanceMeters === null || duration <= 0) return null;
  return distanceMeters / 1000 / (duration / 3600);
}

/** Best result of one activity in every category its sport tracks. */
export function computePersonalRecords(activity: ActivityRecord): ActivityPersonalRecord[] {
  const sport = normalizeActivityType(activity.activityType);
  const track = buildTrack(activity);
  const totalDistance = activity.distanceMeters > 0
    ? activity.distanceMeters
    : (track?.totalDistanceMeters ?? 0);

  return prCategoriesFor(sport).map((category) => {
    if (category.kind === 'distance') {
      const value = totalDistance > 0 ? totalDistance : null;
      const duration = value !== null && activity.durationSeconds > 0 ? activity.durationSeconds : null;
      return {
        ...category,
        durationSeconds: duration,
        paceSecondsPerKm: paceOf(duration, value),
        speedKmh: speedOf(duration, value),
        valueMeters: value,
      };
    }

    if (category.kind === 'elevation') {
      const value = activity.elevationGain > 0 ? activity.elevationGain : null;
      return {
        ...category,
        durationSeconds: null,
        paceSecondsPerKm: null,
        speedKmh: null,
        valueMeters: value,
      };
    }

    const target = category.distanceMeters as number;
    let duration: number | null = null;

    if (track) {
      if (track.hasTimestamps) {
        duration = fastestWindowSeconds(track.points, target);
      } else if (activity.durationSeconds > 0 && track.totalDistanceMeters + 0.5 >= target) {
        // Legacy rows only have the activity average, so scale it by distance.
        duration = activity.durationSeconds * (target / track.totalDistanceMeters);
      }
    }

    return {
      ...category,
      durationSeconds: duration,
      paceSecondsPerKm: paceOf(duration, target),
      speedKmh: speedOf(duration, target),
      valueMeters: null,
    };
  });
}

export type PersonalRecordEntry = ActivityPersonalRecord & {
  activityId: string | number | null;
  activityTitle: string | null;
  achievedAt: string | null;
};

function isBetter(
  kind: PRKind,
  candidate: ActivityPersonalRecord,
  current: ActivityPersonalRecord,
): boolean {
  if (kind === 'time') {
    if (candidate.durationSeconds === null) return false;
    if (current.durationSeconds === null) return true;
    return candidate.durationSeconds < current.durationSeconds;
  }
  if (candidate.valueMeters === null) return false;
  if (current.valueMeters === null) return true;
  return candidate.valueMeters > current.valueMeters;
}

/** Best all-time result per category for one sport. */
export function getAllTimePRs(
  sportType: ActivityType,
  allActivities: ActivityRecord[],
): PersonalRecordEntry[] {
  const sport = normalizeActivityType(sportType);
  const categories = prCategoriesFor(sport);
  const activities = allActivities.filter(
    (activity) =>
      !activity.isPlannedRoute && normalizeActivityType(activity.activityType) === sport,
  );

  const best = new Map<string, { record: ActivityPersonalRecord; activity: ActivityRecord }>();

  for (const activity of activities) {
    for (const record of computePersonalRecords(activity)) {
      if (record.kind === 'time' && record.durationSeconds === null) continue;
      if (record.kind !== 'time' && !(record.valueMeters !== null && record.valueMeters > 0)) {
        continue;
      }

      const current = best.get(record.key);
      if (!current || isBetter(record.kind, record, current.record)) {
        best.set(record.key, { record, activity });
      }
    }
  }

  return categories.map((category) => {
    const winner = best.get(category.key);
    if (!winner) {
      return {
        ...category,
        durationSeconds: null,
        paceSecondsPerKm: null,
        speedKmh: null,
        valueMeters: null,
        activityId: null,
        activityTitle: null,
        achievedAt: null,
      };
    }

    return {
      ...winner.record,
      activityId: winner.activity.id,
      activityTitle: winner.activity.title,
      achievedAt: winner.activity.createdAt,
    };
  });
}

/** Categories where `activityId` currently holds the all-time best. */
export function getActivityPRBadges(
  activityId: string | number,
  allActivities: ActivityRecord[],
): PersonalRecordEntry[] {
  const id = String(activityId);
  const activity = allActivities.find((candidate) => String(candidate.id) === id);
  if (!activity || activity.isPlannedRoute) return [];

  return getAllTimePRs(activity.activityType, allActivities).filter(
    (entry) => entry.activityId !== null && String(entry.activityId) === id,
  );
}

/** IDs of every activity that holds at least one all-time PR. */
export function getPRHolderIds(allActivities: ActivityRecord[]): Set<string> {
  const sports = new Set<ActivityType>();
  for (const activity of allActivities) {
    if (!activity.isPlannedRoute) sports.add(normalizeActivityType(activity.activityType));
  }

  const holders = new Set<string>();
  for (const sport of Array.from(sports)) {
    for (const entry of getAllTimePRs(sport, allActivities)) {
      if (entry.activityId !== null) holders.add(String(entry.activityId));
    }
  }
  return holders;
}
