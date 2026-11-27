import { distance as turfDistance } from '@turf/turf';
import {
  MAX_ACCURACY_METERS,
  MIN_MOVEMENT_METERS,
  type AcceptedPoint,
} from './metrics';
import type { ActivityType } from './valhalla';

/**
 * A fix with a larger horizontal uncertainty is dropped. Under a flyover or
 * between tall buildings the phone falls back to a cell/Wi-Fi position, which
 * can sit a hundred metres off the road and would drag the drawn track with it.
 */
export const GPS_ACCURACY_LIMIT_METERS = MAX_ACCURACY_METERS;

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

/** Altitudes averaged per accepted fix to dampen the barometer/GPS noise. */
const ELEVATION_WINDOW = 5;
/** Rises smaller than this are noise, not climb. */
export const ELEVATION_DEADBAND_METERS = 2.5;
const ELEVATION_GAIN_WINDOW = 3;

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

export type GpsFilterReason = 'accuracy' | 'stale' | 'spike' | 'distance';

export type GpsFilterResult = {
  accepted: boolean;
  /** Why the fix was dropped, or null when it was accepted. */
  reason: GpsFilterReason | null;
  /** Smoothed point appended to the track; null when rejected. */
  point: AcceptedPoint | null;
  /** Filtered speed in km/h, updated even when the fix itself is dropped. */
  speedKmh: number;
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

function metersBetween(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  return turfDistance([a.lng, a.lat], [b.lng, b.lat], { units: 'meters' });
}

/**
 * Exponential moving average weight for a new fix.
 *
 * A fix that sits close to the current position is mostly noise, so it gets a
 * small weight. A fix far from it (relative to the reported accuracy) is real
 * movement — a corner or a sprint — and is followed almost exactly, so sharp
 * turns are not cut.
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
 * Accuracy gate → spike rejection → drift gate → smoothing.
 *
 * The speed is derived before the gates and returned even for a rejected fix,
 * because auto-pause must still see that a stationary phone is stationary (its
 * fixes are dropped by the drift gate).
 */
export function createGpsFilter(activityType: ActivityType = 'cycling'): GpsFilter {
  let currentType = activityType;
  let accepted: AcceptedPoint[] = [];
  let lastRaw: GpsFix | null = null;
  let lastAcceptedRaw: GpsFix | null = null;
  let speedKmh = 0;
  let elevationWindow: number[] = [];

  const instantSpeedKmh = (fix: GpsFix): number | null => {
    if (fix.speed !== null && Number.isFinite(fix.speed) && fix.speed >= 0) {
      return fix.speed * 3.6;
    }
    if (!lastRaw) return null;
    const seconds = (fix.time - lastRaw.time) / 1000;
    if (!(seconds > 0)) return null;
    const moved = metersBetween(lastRaw, fix);
    // Half a second is the shortest window two positions can be divided over.
    return (moved / Math.max(seconds, 0.5)) * 3.6;
  };

  const push = (fix: GpsFix): GpsFilterResult => {
    const reject = (reason: GpsFilterReason): GpsFilterResult => ({
      accepted: false,
      reason,
      point: null,
      speedKmh,
    });

    // A cell/Wi-Fi position is not used for anything, not even as the speed
    // reference: a fix 200 m off the road would read as a 700 km/h jump.
    if (!Number.isFinite(fix.accuracy) || fix.accuracy > GPS_ACCURACY_LIMIT_METERS) {
      return reject('accuracy');
    }
    if (lastAcceptedRaw && fix.time <= lastAcceptedRaw.time) {
      return reject('stale');
    }

    if (lastAcceptedRaw) {
      const seconds = (fix.time - lastAcceptedRaw.time) / 1000;
      const moved = metersBetween(lastAcceptedRaw, fix);
      const limit = spikeSpeedLimitKmh(currentType);

      // Compare over the elapsed time with a one-second floor, so a burst of
      // fixes a few hundred milliseconds apart is not read as a rocket.
      const implied = (moved / Math.max(seconds, 1)) * 3.6;
      if (implied > limit) return reject('spike');

      // A jump inside the spike window must also fit the distance the sport can
      // physically cover in that time, even when the timestamps are close.
      if (seconds * 1000 <= SPIKE_WINDOW_MS && moved > (limit / 3.6) * 2) {
        return reject('spike');
      }
    }

    // Past the gates the fix is a plausible position, so it becomes the
    // reference for the next speed reading (drift-rejected fixes included:
    // standing still is exactly what auto-pause needs to observe).
    const instant = instantSpeedKmh(fix);
    if (instant !== null) {
      speedKmh =
        speedKmh === 0 ? instant : speedKmh * (1 - SPEED_SMOOTHING) + instant * SPEED_SMOOTHING;
    }
    lastRaw = fix;

    if (lastAcceptedRaw && metersBetween(lastAcceptedRaw, fix) < MIN_MOVEMENT_METERS) {
      return reject('distance');
    }

    const previous = accepted[accepted.length - 1];
    let lng = fix.lng;
    let lat = fix.lat;
    if (previous) {
      const alpha = smoothingAlpha(metersBetween(previous, fix), fix.accuracy);
      lng = previous.lng + alpha * (fix.lng - previous.lng);
      lat = previous.lat + alpha * (fix.lat - previous.lat);
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

    return { accepted: true, reason: null, point, speedKmh };
  };

  const reset = (points: AcceptedPoint[] = []): void => {
    accepted = points.map((point) => ({ ...point }));
    lastRaw = null;
    lastAcceptedRaw = accepted.length ? toFix(accepted[accepted.length - 1]) : null;
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
