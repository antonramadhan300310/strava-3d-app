import { distance as turfDistance } from '@turf/turf';
import {
  MAX_ACCURACY_METERS,
  MIN_MOVEMENT_METERS,
  type AcceptedPoint,
} from './metrics';
import type { ActivityType } from './valhalla';

/**
 * Accuracy required before the first point is locked in. A satellite fix of
 * this quality is what anchors the start of the track.
 */
export const GPS_INITIAL_LOCK_ACCURACY_METERS = MAX_ACCURACY_METERS;
/** Kept as the historical name: the strict (stationary) gate. */
export const GPS_ACCURACY_LIMIT_METERS = GPS_INITIAL_LOCK_ACCURACY_METERS;

/**
 * Adaptive ceiling while the athlete is moving.
 *
 * A phone inside a jacket pocket, under trees or between houses loses satellite
 * lock and reports 30–45 m of uncertainty while still being perfectly usable;
 * dropping those fixes used to end the track mid-ride. Cell/Wi-Fi positions sit
 * far worse (50–100 m+) and are still refused, because they drag the line off
 * the road.
 */
export const GPS_ACCURACY_LIMIT_MOVING_METERS = 45;

/** Speed at which the adaptive gate opens to the moving ceiling. */
const MOVING_GATE_SPEED_KMH = 3;

/**
 * Instantaneous speed that only a coordinate spike can reach. Real movement is
 * well below these limits; a teleported fix lands far above them.
 */
const SPIKE_SPEED_KMH: Record<ActivityType, number> = {
  cycling: 90,
  run: 35,
  walking: 20,
  hike: 20,
};

/** A jump measured over less than this is judged by its distance alone. */
const SPIKE_WINDOW_MS = 2000;

/** Below this speed the session is considered standing still. */
const AUTO_PAUSE_SPEED_KMH: Record<ActivityType, number> = {
  cycling: 2.5,
  run: 1.5,
  walking: 1.5,
  hike: 1.5,
};

/** How long the speed has to stay below the threshold before pausing. */
export const AUTO_PAUSE_HOLD_MS = 5000;

/** Resuming needs a slightly higher speed, otherwise the state flaps at the edge. */
const AUTO_PAUSE_RESUME_MARGIN_KMH = 1;

/** Weight of the newest fix in the speed average; 1 Hz fixes settle in ~2 s. */
const SPEED_SMOOTHING = 0.4;

/** Position smoothing: the floor keeps the line calm, the ceiling keeps corners. */
const BASE_POSITION_ALPHA = 0.4;
const MAX_POSITION_ALPHA = 0.9;

/**
 * How much of the constant-velocity extrapolation the predictor trusts.
 *
 * The predictor supplies where the athlete *should* be given the last heading
 * and speed; the correction step then blends the measurement in with a gain
 * weighted by its accuracy. On a straight line the prediction matches, so the
 * gain stays low and jitter is damped; at a corner the innovation is large, so
 * the gain rises and the turn is followed instead of being cut.
 */
const VELOCITY_PREDICTION_WEIGHT = 0.5;
const MAX_PREDICTION_SECONDS = 4;
const MAX_PREDICTION_METERS = 40;

/**
 * A sudden sideways excursion at speed is a multipath artefact (a reflected
 * satellite signal between buildings or under a flyover), not a real move: a
 * road never turns 75° and 12 m sideways in one second.
 */
const LATERAL_TURN_DEGREES = 75;
const LATERAL_SPIKE_MIN_SPEED_KMH = 8;
const LATERAL_SPIKE_MIN_METERS = 12;

/**
 * Android reports `speed = 0` both for a standing phone and when the Doppler
 * reading is unavailable, so a fallback speed is measured over this window of
 * net displacement — jitter cancels out, real movement accumulates.
 */
const NET_SPEED_WINDOW_MS = 3000;
const NET_SPEED_MIN_WINDOW_MS = 1500;

/** Altitudes averaged per accepted fix to dampen the barometer/GPS noise. */
const ELEVATION_WINDOW = 5;
/** Rises smaller than this are noise, not climb. */
export const ELEVATION_DEADBAND_METERS = 2.5;
const ELEVATION_GAIN_WINDOW = 3;

/** Post-recording simplification tolerance; corners deviate far more than this. */
export const POLYLINE_CLEANUP_TOLERANCE_METERS = 1.5;
/** A stop shorter than this is still part of the ride. */
const TAIL_WINDOW_MS = 45000;
const TAIL_CLUSTER_METERS = 12;

const METERS_PER_DEG_LAT = 111320;

export type GpsFix = {
  lng: number;
  lat: number;
  /** Horizontal uncertainty in metres. */
  accuracy: number;
  /** Metres above sea level, or null when the fix carries no altitude. */
  altitude: number | null;
  /** Ground speed in metres per second, or null. */
  speed: number | null;
  /** Fix timestamp in milliseconds since the unix epoch. */
  time: number;
};

export type GpsFilterReason = 'accuracy' | 'stale' | 'spike' | 'lateral' | 'distance';

export type GpsFilterResult = {
  accepted: boolean;
  /** Why the fix was dropped, or null when it was accepted. */
  reason: GpsFilterReason | null;
  /** Smoothed point appended to the track; null when rejected. */
  point: AcceptedPoint | null;
  /** Filtered speed in km/h, updated even when the fix itself is dropped. */
  speedKmh: number;
  /**
   * Unsmoothed speed of this fix (reported Doppler speed, or net displacement
   * when the OS reports none). Auto-pause uses this one: it reacts on the first
   * stationary fix instead of waiting for the average to decay, and it is the
   * only signal that notices a restart when Android reports `speed = null`.
   */
  instantSpeedKmh: number | null;
};

export type GpsFilter = {
  readonly activityType: ActivityType;
  /** Accepted, smoothed points in recording order. */
  readonly points: AcceptedPoint[];
  readonly speedKmh: number;
  readonly elevationGainMeters: number;
  setActivityType: (type: ActivityType) => void;
  /** Resets the filter, optionally seeding it with an already recorded track. */
  reset: (points?: AcceptedPoint[]) => void;
  push: (fix: GpsFix) => GpsFilterResult;
};

export function spikeSpeedLimitKmh(activityType: ActivityType): number {
  return SPIKE_SPEED_KMH[activityType] ?? SPIKE_SPEED_KMH.cycling;
}

export function autoPauseSpeedKmh(activityType: ActivityType): number {
  return AUTO_PAUSE_SPEED_KMH[activityType] ?? AUTO_PAUSE_SPEED_KMH.cycling;
}

/**
 * Accuracy the gate accepts for the current situation: the strict limit before
 * the first lock and while standing still, the relaxed one while moving.
 */
export function accuracyLimitMeters(speedKmh: number, locked: boolean): number {
  if (!locked) return GPS_INITIAL_LOCK_ACCURACY_METERS;
  return speedKmh >= MOVING_GATE_SPEED_KMH
    ? GPS_ACCURACY_LIMIT_MOVING_METERS
    : GPS_INITIAL_LOCK_ACCURACY_METERS;
}

function metersBetween(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  return turfDistance([a.lng, a.lat], [b.lng, b.lat], { units: 'meters' });
}

/** Local planar offset in metres, valid over the few hundred metres of a fix pair. */
function offsetMeters(
  origin: { lng: number; lat: number },
  point: { lng: number; lat: number },
): { east: number; north: number } {
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return {
    east: (point.lng - origin.lng) * metersPerDegLng,
    north: (point.lat - origin.lat) * METERS_PER_DEG_LAT,
  };
}

function shiftMeters(
  point: { lng: number; lat: number },
  east: number,
  north: number,
): { lng: number; lat: number } {
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((point.lat * Math.PI) / 180);
  return {
    lng: point.lng + east / metersPerDegLng,
    lat: point.lat + north / METERS_PER_DEG_LAT,
  };
}

function bearingDegrees(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const { east, north } = offsetMeters(a, b);
  if (east === 0 && north === 0) return 0;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

function angleBetweenBearings(a: number, b: number): number {
  const delta = Math.abs(((a - b) % 360) + 360) % 360;
  return delta > 180 ? 360 - delta : delta;
}

/** Perpendicular distance of `point` from the line through `a` and `b`. */
function crossTrackMeters(
  point: { lng: number; lat: number },
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const p = offsetMeters(a, point);
  const q = offsetMeters(a, b);
  const length = Math.hypot(q.east, q.north);
  if (length < 1e-6) return Math.hypot(p.east, p.north);
  return Math.abs(p.east * q.north - p.north * q.east) / length;
}

/**
 * Exponential moving average weight for a new fix.
 *
 * A fix that sits close to the predicted position is mostly noise, so it gets a
 * small weight. A fix far from it (relative to the reported accuracy) is real
 * movement — a corner or a sprint — and is followed almost exactly, so sharp
 * turns are not cut. A poor accuracy widens `noise`, which lowers the gain and
 * therefore smooths a jacket-pocket fix harder.
 */
export function smoothingAlpha(offsetMeters: number, accuracyMeters: number): number {
  const noise = Number.isFinite(accuracyMeters) ? Math.max(accuracyMeters, 1) : MAX_ACCURACY_METERS;
  const ratio = Math.min(2, Math.max(0, offsetMeters / noise));
  const alpha = BASE_POSITION_ALPHA + (MAX_POSITION_ALPHA - BASE_POSITION_ALPHA) * (ratio / 2);
  return Math.min(MAX_POSITION_ALPHA, Math.max(BASE_POSITION_ALPHA, alpha));
}

function movingAverage(values: number[], window: number): number[] {
  if (values.length < 3 || window < 3) return [...values];
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

/**
 * Total climb after a moving average and a deadband.
 *
 * The reference height only moves once the smoothed altitude leaves a band of
 * ±`deadband` around it, so a phone that reports ±1.5 m of altitude noise on a
 * flat road adds nothing, while a real climb is still counted in deadband-sized
 * steps (the error stays below one deadband for the whole ascent).
 */
export function smoothedElevationGain(
  altitudes: number[],
  deadband = ELEVATION_DEADBAND_METERS,
  window = ELEVATION_GAIN_WINDOW,
): number {
  const heights = altitudes.filter((value) => Number.isFinite(value));
  if (heights.length < 2) return 0;

  const smooth = movingAverage(heights, window);
  let gain = 0;
  let reference = smooth[0];

  for (let i = 1; i < smooth.length; i += 1) {
    const delta = smooth[i] - reference;
    if (delta >= deadband) {
      gain += delta;
      reference = smooth[i];
    } else if (delta <= -deadband) {
      reference = smooth[i];
    }
  }

  return Math.round(gain);
}

export type AutoPauseState = 'moving' | 'holding' | 'paused';

export type AutoPauseUpdate = {
  state: AutoPauseState;
  paused: boolean;
  /** True on the sample that entered or left `paused`. */
  changed: boolean;
};

export type AutoPauseTracker = {
  readonly state: AutoPauseState;
  readonly paused: boolean;
  update: (speedKmh: number, timeMs: number) => AutoPauseUpdate;
  reset: () => void;
};

/**
 * Pure auto-pause state machine: `moving` → `holding` (speed below the
 * threshold) → `paused` after `holdMs`, and straight back to `moving` once the
 * speed passes the resume threshold.
 */
export function createAutoPauseTracker(
  activityType: ActivityType,
  holdMs = AUTO_PAUSE_HOLD_MS,
): AutoPauseTracker {
  const pauseBelow = autoPauseSpeedKmh(activityType);
  const resumeAt = pauseBelow + AUTO_PAUSE_RESUME_MARGIN_KMH;

  let state: AutoPauseState = 'moving';
  let holdingSince: number | null = null;
  let lastTime = Number.NEGATIVE_INFINITY;

  return {
    get state() {
      return state;
    },
    get paused() {
      return state === 'paused';
    },
    update(speedKmh, timeMs) {
      const time = Number.isFinite(timeMs) ? Math.max(timeMs, lastTime) : lastTime;
      lastTime = time;
      const speed = Number.isFinite(speedKmh) ? Math.max(0, speedKmh) : 0;

      if (state === 'paused') {
        if (speed >= resumeAt) {
          state = 'moving';
          holdingSince = null;
          return { state, paused: false, changed: true };
        }
        return { state, paused: true, changed: false };
      }

      if (speed >= pauseBelow) {
        holdingSince = null;
        const changed = state !== 'moving';
        state = 'moving';
        return { state, paused: false, changed };
      }

      if (holdingSince === null) holdingSince = time;
      if (time - holdingSince >= holdMs) {
        holdingSince = null;
        state = 'paused';
        return { state, paused: true, changed: true };
      }

      const changed = state !== 'holding';
      state = 'holding';
      return { state, paused: false, changed };
    },
    reset() {
      state = 'moving';
      holdingSince = null;
      lastTime = Number.NEGATIVE_INFINITY;
    },
  };
}

function toFix(point: AcceptedPoint): GpsFix {
  return {
    lng: point.lng,
    lat: point.lat,
    accuracy: point.accuracy,
    altitude: point.ele,
    speed: point.speed,
    time: point.time,
  };
}

/**
 * Accuracy gate → stale check → spike rejection → lateral spike rejection →
 * speed → drift gate → predictor-corrector smoothing.
 *
 * The speed is derived before the drift gate and returned even for a rejected
 * fix, because auto-pause must still see that a stationary phone is stationary
 * (its fixes are dropped by the drift gate) and that it started moving again.
 */
export function createGpsFilter(activityType: ActivityType = 'cycling'): GpsFilter {
  let currentType = activityType;
  let accepted: AcceptedPoint[] = [];
  let lastAcceptedRaw: GpsFix | null = null;
  /** Plausible fixes of the last few seconds, used for the fallback speed. */
  let recentRaw: GpsFix[] = [];
  let speedKmh = 0;
  let elevationWindow: number[] = [];

  /** Reported Doppler speed, or the net displacement when it is missing/zero. */
  const displacementSpeedKmh = (from: GpsFix, fix: GpsFix): number | null => {
    const seconds = (fix.time - from.time) / 1000;
    if (!(seconds > 0)) return null;
    return (metersBetween(from, fix) / seconds) * 3.6;
  };

  const instantSpeedKmh = (fix: GpsFix): number | null => {
    if (fix.speed !== null && Number.isFinite(fix.speed) && fix.speed > 0) {
      return fix.speed * 3.6;
    }

    // Android reports 0 both when the athlete stands still and when the Doppler
    // reading is missing, so measure the net displacement instead. The shorter
    // window reacts at once, the longer one cancels jitter; the smaller of the
    // two wins, which is what makes "stopped" and "moving again" both instant
    // without ever inventing speed out of GPS noise.
    const candidates = recentRaw.filter((past) => {
      const age = fix.time - past.time;
      return age > 0 && age <= NET_SPEED_WINDOW_MS;
    });
    if (candidates.length === 0) return null;

    const short = displacementSpeedKmh(candidates[candidates.length - 1], fix);

    let reference = candidates[0];
    for (const past of candidates) {
      if (fix.time - past.time >= NET_SPEED_MIN_WINDOW_MS) {
        reference = past;
        break;
      }
    }
    const long = displacementSpeedKmh(reference, fix);

    if (short === null) return long;
    if (long === null) return short;
    return Math.min(short, long);
  };

  const rememberRaw = (fix: GpsFix): void => {
    recentRaw.push(fix);
    while (recentRaw.length > 1 && fix.time - recentRaw[0].time > NET_SPEED_WINDOW_MS) {
      recentRaw.shift();
    }
  };

  const push = (fix: GpsFix): GpsFilterResult => {
    /** Latest measured speed of this fix, shared with the rejection results. */
    let measuredKmh: number | null = null;

    const reject = (reason: GpsFilterReason): GpsFilterResult => ({
      accepted: false,
      reason,
      point: null,
      speedKmh,
      instantSpeedKmh: measuredKmh,
    });

    const reportedKmh =
      fix.speed !== null && Number.isFinite(fix.speed) && fix.speed > 0 ? fix.speed * 3.6 : 0;

    // "Moving" for the adaptive gate: a reported speed, the filtered speed, or
    // simply the distance covered since the last accepted point. The last one
    // matters right after the initial lock, when no speed estimate exists yet.
    let approachKmh = 0;
    if (lastAcceptedRaw) {
      const seconds = (fix.time - lastAcceptedRaw.time) / 1000;
      if (seconds > 0) {
        approachKmh = (metersBetween(lastAcceptedRaw, fix) / Math.max(seconds, 0.5)) * 3.6;
      }
    }

    const limit = accuracyLimitMeters(
      Math.max(speedKmh, reportedKmh, approachKmh),
      lastAcceptedRaw !== null,
    );

    // A cell/Wi-Fi position is not used for anything, not even as the speed
    // reference: a fix 200 m off the road would read as a 700 km/h jump.
    if (!Number.isFinite(fix.accuracy) || fix.accuracy > limit) {
      return reject('accuracy');
    }
    if (lastAcceptedRaw && fix.time <= lastAcceptedRaw.time) {
      return reject('stale');
    }

    if (lastAcceptedRaw) {
      const seconds = (fix.time - lastAcceptedRaw.time) / 1000;
      const moved = metersBetween(lastAcceptedRaw, fix);
      const spikeLimit = spikeSpeedLimitKmh(currentType);

      // Compare over the elapsed time with a one-second floor, so a burst of
      // fixes a few hundred milliseconds apart is not read as a rocket.
      const implied = (moved / Math.max(seconds, 1)) * 3.6;
      if (implied > spikeLimit) return reject('spike');

      // A jump inside the spike window must also fit the distance the sport can
      // physically cover in that time, even when the timestamps are close.
      if (seconds * 1000 <= SPIKE_WINDOW_MS && moved > (spikeLimit / 3.6) * 2) {
        return reject('spike');
      }

      // Lateral spike: a hard sideways excursion at speed that no road makes.
      const beforeLast = accepted[accepted.length - 2];
      if (beforeLast && speedKmh >= LATERAL_SPIKE_MIN_SPEED_KMH) {
        const turn = angleBetweenBearings(
          bearingDegrees(beforeLast, lastAcceptedRaw),
          bearingDegrees(lastAcceptedRaw, fix),
        );
        const lateral = crossTrackMeters(fix, beforeLast, lastAcceptedRaw);
        const threshold = Math.max(LATERAL_SPIKE_MIN_METERS, fix.accuracy * 2.5);
        if (turn > LATERAL_TURN_DEGREES && lateral > threshold) {
          return reject('lateral');
        }
      }
    }

    // Past the gates the fix is a plausible position, so it becomes the
    // reference for the next speed reading (drift-rejected fixes included:
    // standing still is exactly what auto-pause needs to observe).
    const instant = instantSpeedKmh(fix);
    measuredKmh = instant;
    if (instant !== null) {
      speedKmh =
        speedKmh === 0 ? instant : speedKmh * (1 - SPEED_SMOOTHING) + instant * SPEED_SMOOTHING;
    }
    rememberRaw(fix);

    if (lastAcceptedRaw && metersBetween(lastAcceptedRaw, fix) < MIN_MOVEMENT_METERS) {
      return reject('distance');
    }

    const previous = accepted[accepted.length - 1];
    let lng = fix.lng;
    let lat = fix.lat;

    if (previous) {
      // Predictor: carry the last smoothed velocity forward by the elapsed time
      // (damped, and capped so a long background gap cannot fling the point).
      let predicted = { lng: previous.lng, lat: previous.lat };
      const older = accepted[accepted.length - 2];
      if (older) {
        const span = (previous.time - older.time) / 1000;
        if (span > 0) {
          const velocity = offsetMeters(older, previous);
          const eastPerSecond = velocity.east / span;
          const northPerSecond = velocity.north / span;
          const horizon = Math.min(
            Math.max(0, (fix.time - previous.time) / 1000),
            MAX_PREDICTION_SECONDS,
          );
          let east = eastPerSecond * horizon * VELOCITY_PREDICTION_WEIGHT;
          let north = northPerSecond * horizon * VELOCITY_PREDICTION_WEIGHT;
          const magnitude = Math.hypot(east, north);
          if (magnitude > MAX_PREDICTION_METERS) {
            const scale = MAX_PREDICTION_METERS / magnitude;
            east *= scale;
            north *= scale;
          }
          predicted = shiftMeters(previous, east, north);
        }
      }

      const alpha = smoothingAlpha(metersBetween(predicted, fix), fix.accuracy);
      lng = predicted.lng + alpha * (fix.lng - predicted.lng);
      lat = predicted.lat + alpha * (fix.lat - predicted.lat);
    }

    let ele: number | null = null;
    if (fix.altitude !== null && Number.isFinite(fix.altitude)) {
      elevationWindow.push(fix.altitude);
      if (elevationWindow.length > ELEVATION_WINDOW) elevationWindow.shift();
      const sum = elevationWindow.reduce((total, value) => total + value, 0);
      ele = Math.round((sum / elevationWindow.length) * 10) / 10;
    }

    const point: AcceptedPoint = {
      lng,
      lat,
      ele,
      time: fix.time,
      accuracy: fix.accuracy,
      speed: fix.speed,
    };
    accepted.push(point);
    lastAcceptedRaw = fix;

    return { accepted: true, reason: null, point, speedKmh, instantSpeedKmh: instant };
  };

  const reset = (points: AcceptedPoint[] = []): void => {
    accepted = points.map((point) => ({ ...point }));
    lastAcceptedRaw = accepted.length ? toFix(accepted[accepted.length - 1]) : null;
    recentRaw = [];
    speedKmh = 0;
    elevationWindow = accepted
      .slice(-ELEVATION_WINDOW)
      .map((point) => point.ele)
      .filter((value): value is number => value !== null && Number.isFinite(value));
  };

  return {
    get activityType() {
      return currentType;
    },
    get points() {
      return accepted;
    },
    get speedKmh() {
      return speedKmh;
    },
    get elevationGainMeters() {
      return smoothedElevationGain(
        accepted
          .map((point) => point.ele)
          .filter((value): value is number => value !== null && Number.isFinite(value)),
      );
    },
    setActivityType(type) {
      currentType = type;
    },
    reset,
    push,
  };
}

/** Perpendicular distance in a local metre plane. */
function perpendicularMeters(
  point: { east: number; north: number },
  a: { east: number; north: number },
  b: { east: number; north: number },
): number {
  const dx = b.east - a.east;
  const dy = b.north - a.north;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return Math.hypot(point.east - a.east, point.north - a.north);
  return Math.abs((point.east - a.east) * dy - (point.north - a.north) * dx) / length;
}

/**
 * Ramer–Douglas–Peucker simplification in metres.
 *
 * Only points that sit within `toleranceMeters` of the chord are dropped, so a
 * real corner (which deviates by far more than a metre) is always kept.
 */
export function simplifyTrack<T extends { lng: number; lat: number }>(
  points: T[],
  toleranceMeters = POLYLINE_CLEANUP_TOLERANCE_METERS,
): T[] {
  if (points.length <= 2) return [...points];

  const origin = points[0];
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  const plane = points.map((point) => ({
    east: (point.lng - origin.lng) * metersPerDegLng,
    north: (point.lat - origin.lat) * METERS_PER_DEG_LAT,
  }));

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let worst = 0;
    let worstIndex = -1;
    for (let index = first + 1; index < last; index += 1) {
      const distance = perpendicularMeters(plane[index], plane[first], plane[last]);
      if (distance > worst) {
        worst = distance;
        worstIndex = index;
      }
    }
    if (worstIndex !== -1 && worst > toleranceMeters) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }

  return points.filter((_, index) => keep[index] === 1);
}

/**
 * Drops the micro zig-zag a stationary phone records at the end of a ride.
 *
 * When the last 45 seconds stay inside a 12 m cluster the athlete has stopped,
 * so those points are replaced by the final one. Real corners are untouched:
 * the tail is only collapsed when it never leaves the cluster.
 */
function collapseStationaryTail(points: AcceptedPoint[]): AcceptedPoint[] {
  if (points.length < 5) return points;
  const last = points[points.length - 1];

  let startIndex = points.length - 1;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (last.time - points[index].time > TAIL_WINDOW_MS) break;
    if (metersBetween(points[index], last) > TAIL_CLUSTER_METERS) break;
    startIndex = index;
  }

  if (points.length - startIndex < 4) return points;
  return [...points.slice(0, startIndex + 1), last];
}

/**
 * Final polish applied when the athlete taps *Selesai & Simpan*: the trailing
 * stationary cluster is collapsed and collinear points are dropped. The first
 * and last point are always kept so the start time and the finish stay exact.
 */
export function cleanupRecordedPolyline(points: AcceptedPoint[]): AcceptedPoint[] {
  if (points.length < 3) return points.map((point) => ({ ...point }));

  const collapsed = collapseStationaryTail(points);
  const simplified = simplifyTrack(collapsed);
  if (simplified.length < 2) return points.map((point) => ({ ...point }));
  return simplified;
}
