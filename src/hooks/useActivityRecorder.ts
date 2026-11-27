'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  currentSpeedKmh,
  formatDistanceKm,
  formatDuration,
  formatPace,
  formatSpeed,
  averageSpeedKmh,
  paceSecondsPerKm,
  totalDistanceMeters,
  type AcceptedPoint,
} from '@/lib/metrics';
import {
  autoPauseSpeedKmh,
  cleanupRecordedPolyline,
  createAutoPauseTracker,
  createGpsFilter,
  smoothedElevationGain,
  type AutoPauseTracker,
  type GpsFilter,
} from '@/lib/gpsFilter';
import { createRecordingClock, type RecordingClock } from '@/lib/recordingClock';
import { isAutoPauseEnabled, setAutoPauseEnabled as persistAutoPausePreference } from '@/lib/recorderSettings';
import {
  startLocationWatch,
  type LocationError,
  type LocationSample,
  type LocationWatch,
} from '@/lib/location';
import { clearSession, loadSession, saveSession, type SavedSession } from '@/lib/session';
import { snapRouteToRoad, type ActivityType } from '@/lib/valhalla';
import { isSupabaseConfigured, saveRecordedActivity } from '@/lib/supabase';
import { invalidateHeatmapCache } from '@/lib/heatmapCache';
import { enqueueOfflineActivity } from '@/lib/offlineActivityQueue';
import { fetchActivityWeather } from '@/lib/weatherService';
import { timestampOf, type LngLat, type LngLatEle } from '@/lib/polyline';
import {
  clearNativeGpsBuffer,
  readNativeGpsBuffer,
  startNativeTrackingService,
  stopNativeTrackingService,
} from '@/lib/nativeTrackingService';

export type SessionPhase = 'idle' | 'recording' | 'paused' | 'auto-paused' | 'finishing';

export type LiveMetrics = {
  activeSeconds: number;
  distanceMeters: number;
  currentSpeedKmh: number;
  averageSpeedKmh: number;
  currentPace: string;
  averagePace: string;
};

export type FinishResult = {
  coordinates: LngLatEle[];
  distanceMeters: number;
  elevationGainMeters: number;
  durationSeconds: number;
  usedGpsAltitude: boolean;
};

const TICK_MS = 1000;
/** How often the native fix buffer is drained while the app is visible. */
const NATIVE_DRAIN_MS = 5000;
/** Watcher callbacks can arrive out of order; ignore fixes older than this. */
const MAX_FIX_AGE_MS = 60000;

function formatSavedAt(epochMs: number): string {
  return new Date(epochMs).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A dropped connection is recoverable through the offline queue; a schema error is not. */
function isNetworkFailure(cause: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (!(cause instanceof Error)) return false;
  const message = cause.message.toLowerCase();
  return (
    cause.name === 'TypeError' ||
    message.includes('failed to fetch') ||
    message.includes('network') ||
    message.includes('fetch')
  );
}

export function useActivityRecorder() {
  const { user } = useAuth();
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [activityType, setActivityType] = useState<ActivityType>('cycling');
  const [points, setPoints] = useState<AcceptedPoint[]>([]);
  const [livePosition, setLivePosition] = useState<LocationSample | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<SavedSession | null>(null);
  const [finishResult, setFinishResult] = useState<FinishResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nativeTrackingActive, setNativeTrackingActive] = useState(false);
  const [autoPauseEnabled, setAutoPauseEnabledState] = useState(true);

  const watchRef = useRef<LocationWatch | null>(null);
  const pointsRef = useRef<AcceptedPoint[]>([]);
  const phaseRef = useRef<SessionPhase>('idle');
  const activityRef = useRef<ActivityType>('cycling');
  const lastFixTimeRef = useRef<number | null>(null);
  /** Newest fix timestamp already shown as the live dot, so a drained buffer never rewinds it. */
  const liveFixTimeRef = useRef<number>(0);
  /** `nextIndex` of the last native buffer drain. */
  const nativeBufferIndexRef = useRef(0);
  /**
   * Wall-clock duration model: `setInterval` is frozen while the screen is off,
   * so every duration is derived from `Date.now()` and the pause windows.
   */
  const clockRef = useRef<RecordingClock>(createRecordingClock());
  /** True while the Record tab is open, so the GPS badge has live data before Start. */
  const previewRef = useRef(false);
  const filterRef = useRef<GpsFilter | null>(null);
  const autoPauseRef = useRef<AutoPauseTracker | null>(null);
  const autoPauseEnabledRef = useRef(true);
  const [nowMs, setNowMs] = useState(() => Date.now());

  pointsRef.current = points;
  phaseRef.current = phase;
  activityRef.current = activityType;

  const currentActiveMs = useCallback(() => clockRef.current.activeMs(Date.now()), []);

  const getFilter = useCallback(() => {
    if (!filterRef.current) filterRef.current = createGpsFilter(activityRef.current);
    return filterRef.current;
  }, []);

  const getAutoPause = useCallback(() => {
    if (!autoPauseRef.current) autoPauseRef.current = createAutoPauseTracker(activityRef.current);
    return autoPauseRef.current;
  }, []);

  // The toggle is a device preference; it loads after hydration.
  useEffect(() => {
    const enabled = isAutoPauseEnabled();
    autoPauseEnabledRef.current = enabled;
    setAutoPauseEnabledState(enabled);
  }, []);

  const persist = useCallback(() => {
    if (pointsRef.current.length === 0) return;
    saveSession({
      activityType: activityRef.current,
      status: phaseRef.current === 'recording' ? 'recording' : 'paused',
      activeMs: currentActiveMs(),
      startedAt: clockRef.current.startedAt,
      points: pointsRef.current,
    });
  }, [currentActiveMs]);

  const startBackgroundService = useCallback(async () => {
    const started = await startNativeTrackingService();
    setNativeTrackingActive(started);
  }, []);

  const stopBackgroundService = useCallback(() => {
    setNativeTrackingActive(false);
    void stopNativeTrackingService();
  }, []);

  const stopWatch = useCallback(async () => {
    const watch = watchRef.current;
    watchRef.current = null;
    if (watch) await watch.stop();
  }, []);

  /**
   * Auto-pause keeps the watcher and the wake lock alive: the session has to
   * see the next fix to know the athlete started moving again.
   */
  const enterAutoPause = useCallback(() => {
    if (phaseRef.current !== 'recording') return;
    const now = Date.now();
    clockRef.current.pause(now);
    setPhase('auto-paused');
    phaseRef.current = 'auto-paused';
    setNowMs(now);
    persist();
  }, [persist]);

  const exitAutoPause = useCallback(() => {
    if (phaseRef.current !== 'auto-paused') return;
    const now = Date.now();
    clockRef.current.resume(now);
    setPhase('recording');
    phaseRef.current = 'recording';
    setNowMs(now);
  }, []);

  /**
   * Every fix, live or drained from the native buffer, goes through the same
   * path. `source === 'buffer'` skips the freshness gate: those fixes were
   * recorded minutes ago while the WebView was frozen, and they are the whole
   * point of the native buffer.
   */
  const handleSample = useCallback(
    (sample: LocationSample, source: 'live' | 'buffer' = 'live') => {
      if (source === 'live' && Date.now() - sample.time > MAX_FIX_AGE_MS) return;

      if (sample.time >= liveFixTimeRef.current) {
        liveFixTimeRef.current = sample.time;
        setLivePosition(sample);
        setGpsAccuracy(sample.accuracy);
      }

      const phase = phaseRef.current;
      // Preview fixes (Record tab open, no session) and a manual pause must not
      // touch the filter: the track would otherwise silently absorb the drift.
      // An auto-paused session must keep receiving fixes, otherwise nothing
      // would ever notice that the athlete started moving again.
      if (phase !== 'recording' && phase !== 'auto-paused') return;

      const result = getFilter().push(sample);

      // Auto-pause reads the measured speed even when the fix itself is dropped:
      // a stationary phone's fixes fail the drift gate, but its speed still has
      // to reach the state machine so the timer can stop and start again. The
      // unsmoothed value is used so the first stationary fix pauses promptly and
      // the first moving fix resumes even when Android reports `speed = null`.
      if (autoPauseEnabledRef.current) {
        const measured = result.instantSpeedKmh ?? result.speedKmh;
        const update = getAutoPause().update(measured, sample.time);
        if (update.changed) {
          if (update.paused) enterAutoPause();
          else exitAutoPause();
        }
      }

      // A fix that just resumed the session is recorded immediately; while the
      // session stays auto-paused no point is appended, so neither the polyline
      // nor the distance absorbs the drift.
      if (phaseRef.current !== 'recording') return;
      if (!result.accepted || !result.point) return;

      const accepted = result.point;
      lastFixTimeRef.current = accepted.time;
      // Updated synchronously: a native-buffer drain appends many points in one
      // tick and `finish()` reads this ref immediately afterwards.
      const next = [...pointsRef.current, accepted];
      pointsRef.current = next;
      setPoints(next);
      setGpsError(null);
    },
    [enterAutoPause, exitAutoPause, getAutoPause, getFilter],
  );

  const handleSampleRef = useRef(handleSample);
  handleSampleRef.current = handleSample;

  /**
   * Replays the fixes the Android foreground service recorded natively.
   *
   * The bridge can be throttled or frozen while the screen is off, so this is
   * what keeps the track continuous across a locked screen: every buffered fix
   * is fed through the same filter, and duplicates already delivered live are
   * dropped by the filter's monotonic-timestamp gate.
   */
  const drainNativeBuffer = useCallback(async () => {
    const drain = await readNativeGpsBuffer(nativeBufferIndexRef.current);
    if (!drain) return;
    nativeBufferIndexRef.current = Math.max(nativeBufferIndexRef.current, drain.nextIndex);
    for (const fix of drain.fixes) {
      handleSampleRef.current(
        {
          lng: fix.lng,
          lat: fix.lat,
          accuracy: fix.accuracy,
          altitude: fix.altitude,
          speed: fix.speed,
          bearing: fix.bearing,
          time: fix.time,
        },
        'buffer',
      );
    }
  }, []);

  const handleError = useCallback((error: LocationError) => {
    setGpsError(error.message);
  }, []);

  const beginWatch = useCallback(async () => {
    if (watchRef.current) return;
    setGpsError(null);
    const watch = await startLocationWatch(handleSample, handleError);
    watchRef.current = watch;
  }, [handleSample, handleError]);

  /**
   * Watch that feeds the blue dot and signal badge while the Record tab is open
   * but no session is running. Accepted fixes are only appended while recording.
   */
  const startPreview = useCallback(async () => {
    previewRef.current = true;
    if (phaseRef.current !== 'finishing') await beginWatch();
  }, [beginWatch]);

  const stopPreview = useCallback(async () => {
    previewRef.current = false;
    // Only a running session (including auto-pause, which must keep sampling)
    // outlives the Record tab; a paused session restarts its watcher on return.
    if (phaseRef.current !== 'recording' && phaseRef.current !== 'auto-paused') {
      await stopWatch();
    }
  }, [stopWatch]);

  // The HUD repaint tick. It is a display refresh only: the duration itself is
  // derived from wall-clock timestamps, so a frozen interval cannot freeze the
  // timer (and cannot inflate the average speed) while the screen is off.
  useEffect(() => {
    if (phase !== 'recording') return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [phase]);

  // Coming back to the foreground: recompute the duration from the wall clock
  // and replay every fix the native service recorded while we were frozen.
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      setNowMs(Date.now());
      void drainNativeBuffer();
    };

    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, [drainNativeBuffer]);

  // Safety net for a throttled (but not frozen) WebView: drain every few
  // seconds while a session runs so the buffer never grows unnecessarily.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'auto-paused') return;
    void drainNativeBuffer();
    const timer = setInterval(() => void drainNativeBuffer(), NATIVE_DRAIN_MS);
    return () => clearInterval(timer);
  }, [phase, drainNativeBuffer]);

  // Every accepted fix rewrites the backup so a force-close loses at most one point.
  useEffect(() => {
    if (points.length === 0) return;
    if (phase === 'idle' || phase === 'finishing') return;
    persist();
  }, [points, phase, persist]);

  useEffect(() => () => {
    // The WebView is going away, so the wake lock would outlive its watcher.
    void stopNativeTrackingService();
    void stopWatch();
  }, [stopWatch]);

  const start = useCallback(
    async (type: ActivityType) => {
      clearSession();
      setActivityType(type);
      activityRef.current = type;
      filterRef.current = createGpsFilter(type);
      autoPauseRef.current = createAutoPauseTracker(type);
      setPoints([]);
      pointsRef.current = [];
      lastFixTimeRef.current = null;
      liveFixTimeRef.current = 0;
      const startedAt = Date.now();
      clockRef.current = createRecordingClock();
      clockRef.current.start(startedAt);
      setFinishResult(null);
      setNotice(null);
      setGpsError(null);
      setPhase('recording');
      phaseRef.current = 'recording';
      // A fresh session must not inherit fixes from the previous ride.
      nativeBufferIndexRef.current = 0;
      await clearNativeGpsBuffer();
      // Grab the wake lock before the location watcher starts so a screen lock
      // right after Start cannot suspend the first fixes.
      await startBackgroundService();
      await beginWatch();
    },
    [beginWatch, startBackgroundService],
  );

  const pause = useCallback(() => {
    if (phaseRef.current !== 'recording') return;
    const now = Date.now();
    clockRef.current.pause(now);
    getAutoPause().reset();
    setPhase('paused');
    phaseRef.current = 'paused';
    // The HUD memo is keyed on the wall clock, so nudge it to show frozen values.
    setNowMs(now);
    persist();
    stopBackgroundService();
  }, [getAutoPause, persist, stopBackgroundService]);

  const resume = useCallback(async () => {
    if (phaseRef.current !== 'paused' && phaseRef.current !== 'auto-paused') return;
    const now = Date.now();
    getAutoPause().reset();
    clockRef.current.resume(now);
    setPhase('recording');
    phaseRef.current = 'recording';
    setNowMs(now);
    await startBackgroundService();
    await beginWatch();
  }, [beginWatch, getAutoPause, startBackgroundService]);

  const finish = useCallback(async (): Promise<FinishResult | null> => {
    if (phaseRef.current === 'idle' || phaseRef.current === 'finishing') return null;
    const stoppedAt = Date.now();
    clockRef.current.stop(stoppedAt);
    const activeMs = clockRef.current.activeMs(stoppedAt);
    stopBackgroundService();
    await stopWatch();
    // Pick up anything the native service recorded after the last live fix.
    // This runs while the phase is still recording, so those fixes are kept.
    await drainNativeBuffer();
    setPhase('finishing');
    phaseRef.current = 'finishing';
    setNowMs(stoppedAt);

    const recorded = pointsRef.current;
    if (recorded.length < 2) {
      setPhase('paused');
      phaseRef.current = 'paused';
      setNotice('Rekaman terlalu pendek. Minimal 2 titik GPS yang sah diperlukan.');
      return null;
    }

    // Polish the trace before it is snapped: the trailing stationary zig-zag is
    // collapsed and collinear points are dropped, real corners are untouched.
    const cleaned = cleanupRecordedPolyline(recorded);
    const gpsAltitudes = cleaned.map((point) => point.ele);
    const gpsTrack: LngLatEle[] = cleaned.map((point, index) => {
      const ele = gpsAltitudes[index];
      return [
        point.lng,
        point.lat,
        Number.isFinite(ele ?? NaN) ? (ele as number) : 0,
        point.time,
      ];
    });

    // Snap the raw GPS trace onto roads first; the helper falls back to the
    // untouched track when Valhalla is unreachable, so Finish never fails here.
    const snapped = await snapRouteToRoad(gpsTrack, activityRef.current);
    const coordinates = snapped.coordinates;
    const usedGpsAltitude = snapped.usedGpsAltitude;

    // Phone altitude is noisy enough to invent hundreds of metres of climb; the
    // smoothed, deadbanded sum is only used when the DEM profile was unavailable.
    const gpsAltitudeGain = smoothedElevationGain(
      cleaned
        .map((point) => point.ele)
        .filter((value): value is number => value !== null && Number.isFinite(value)),
    );

    const result: FinishResult = {
      coordinates,
      distanceMeters: snapped.distanceMeters,
      elevationGainMeters: usedGpsAltitude ? gpsAltitudeGain : snapped.elevationGainMeters,
      durationSeconds: Math.round(activeMs / 1000),
      usedGpsAltitude,
    };

    setFinishResult(result);
    setPhase('paused');
    phaseRef.current = 'paused';
    persist();
    setNotice(
      !snapped.snapped
        ? 'Gagal menempelkan ke jalan (offline). Rekaman GPS asli disimpan.'
        : usedGpsAltitude
          ? 'Rute ditempelkan ke jalan. Elevasi kontur tidak tersedia, memakai elevasi GPS.'
          : 'Rute ditempelkan ke jalan dengan elevasi kontur Valhalla.',
    );
    return result;
  }, [drainNativeBuffer, stopWatch, persist, stopBackgroundService]);

  const resetAfterSave = useCallback(() => {
    stopBackgroundService();
    clearSession();
    void clearNativeGpsBuffer();
    nativeBufferIndexRef.current = 0;
    setPhase('idle');
    phaseRef.current = 'idle';
    setPoints([]);
    pointsRef.current = [];
    filterRef.current = createGpsFilter(activityRef.current);
    autoPauseRef.current = createAutoPauseTracker(activityRef.current);
    setFinishResult(null);
    clockRef.current = createRecordingClock();
    lastFixTimeRef.current = null;
    liveFixTimeRef.current = 0;
  }, [stopBackgroundService]);

  const saveActivity = useCallback(async (title: string, rpe?: number | null) => {
    if (!finishResult) throw new Error('Belum ada rekaman yang selesai diproses.');
    if (!isSupabaseConfigured) {
      throw new Error(
        'Server ALLMOVA belum dikonfigurasi. Hubungi admin aplikasi.',
      );
    }
    if (!user) throw new Error('Sesi login tidak ditemukan. Silakan masuk kembali.');

    const first = finishResult.coordinates[0];
    const startedAtEpoch = (first && timestampOf(first)) ?? clockRef.current.startedAt;
    const weather = first
      ? await fetchActivityWeather({
          latitude: first[1],
          longitude: first[0],
          startedAt: new Date(startedAtEpoch > 0 ? startedAtEpoch : Date.now()),
          timeoutMs: 3000,
        })
      : null;

    const payload = {
      title,
      activityType: activityRef.current,
      distanceMeters: finishResult.distanceMeters,
      elevationGain: finishResult.elevationGainMeters,
      durationSeconds: finishResult.durationSeconds,
      coordinates: finishResult.coordinates,
      weather,
      rpe: rpe ?? null,
    };

    const queueForLater = () => {
      enqueueOfflineActivity(user.id, payload);
      invalidateHeatmapCache(user.id);
      resetAfterSave();
      setNotice(
        `Aktivitas "${title}" disimpan offline dan akan diunggah otomatis saat online.`,
      );
      if (previewRef.current) void beginWatch();
    };

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      queueForLater();
      return;
    }

    try {
      await saveRecordedActivity({ ...payload, userId: user.id });
      invalidateHeatmapCache(user.id);
      resetAfterSave();
      setNotice(`Aktivitas "${title}" tersimpan di Cloud ALLMOVA.`);
      if (previewRef.current) await beginWatch();
    } catch (cause) {
      if (isNetworkFailure(cause)) {
        queueForLater();
        return;
      }
      throw cause;
    }
  }, [finishResult, beginWatch, user, resetAfterSave]);

  const discardFinish = useCallback(() => {
    stopBackgroundService();
    setFinishResult(null);
    setNotice(null);
    setPhase('paused');
    phaseRef.current = 'paused';
    persist();
    // finish() stopped the watcher; restore the live dot for the paused session.
    if (previewRef.current) void beginWatch();
  }, [persist, beginWatch, stopBackgroundService]);

  // Offer a recovery whenever the Record tab mounts with a leftover backup.
  useEffect(() => {
    const saved = loadSession();
    if (saved) setPendingRestore(saved);
  }, []);

  const restoreSession = useCallback(async () => {
    const saved = pendingRestore;
    if (!saved) return;
    setPendingRestore(null);
    setActivityType(saved.activityType);
    activityRef.current = saved.activityType;
    setPoints(saved.points);
    pointsRef.current = saved.points;
    const restoredAt = Date.now();
    clockRef.current = createRecordingClock();
    clockRef.current.restoreFrom({
      startedAt: saved.startedAt,
      activeMs: saved.activeMs,
      paused: saved.status !== 'recording',
      at: restoredAt,
    });
    lastFixTimeRef.current = saved.points[saved.points.length - 1]?.time ?? null;
    liveFixTimeRef.current = 0;
    filterRef.current = createGpsFilter(saved.activityType);
    filterRef.current.reset(saved.points);
    autoPauseRef.current = createAutoPauseTracker(saved.activityType);
    setFinishResult(null);
    setNotice(`Sesi dipulihkan (${saved.points.length} titik, tersimpan ${formatSavedAt(saved.savedAt)}).`);

    if (saved.status === 'recording') {
      setPhase('recording');
      phaseRef.current = 'recording';
      await startBackgroundService();
      await beginWatch();
    } else {
      setPhase('paused');
      phaseRef.current = 'paused';
    }
  }, [pendingRestore, beginWatch, startBackgroundService]);

  const dismissRestore = useCallback(() => {
    clearSession();
    setPendingRestore(null);
  }, []);

  const metrics = useMemo<LiveMetrics>(() => {
    const line: LngLat[] = points.map((point) => [point.lng, point.lat]);
    const distanceMeters = totalDistanceMeters(line);
    const activeSeconds = Math.floor(currentActiveMs() / 1000);
    const instant = currentSpeedKmh({
      points,
      lastFixTime: lastFixTimeRef.current,
      now: nowMs,
    });
    const average = averageSpeedKmh(distanceMeters, activeSeconds);

    return {
      activeSeconds,
      distanceMeters,
      currentSpeedKmh: instant,
      averageSpeedKmh: average,
      currentPace: formatPace(paceSecondsPerKm(instant)),
      averagePace: formatPace(paceSecondsPerKm(average)),
    };
  }, [points, nowMs, currentActiveMs]);

  const track = useMemo<LngLatEle[]>(
    () => points.map((point) => [point.lng, point.lat, point.ele ?? 0]),
    [points],
  );

  const formatted = useMemo(
    () => ({
      duration: formatDuration(metrics.activeSeconds),
      distance: formatDistanceKm(metrics.distanceMeters),
      currentSpeed: formatSpeed(metrics.currentSpeedKmh),
      averageSpeed: formatSpeed(metrics.averageSpeedKmh),
      currentPace: metrics.currentPace,
      averagePace: metrics.averagePace,
    }),
    [metrics],
  );

  const changeActivityType = useCallback(
    (type: ActivityType) => {
      setActivityType(type);
      activityRef.current = type;
      getFilter().setActivityType(type);
      // The pause/resume thresholds are per sport, so the tracker is rebuilt.
      autoPauseRef.current = createAutoPauseTracker(type);
    },
    [getFilter],
  );

  const setAutoPauseEnabled = useCallback(
    (enabled: boolean) => {
      autoPauseEnabledRef.current = enabled;
      setAutoPauseEnabledState(enabled);
      persistAutoPausePreference(enabled);
      // Turning the option off while auto-paused would otherwise strand the
      // session, because nothing is left to notice the speed rising again.
      if (!enabled && phaseRef.current === 'auto-paused') {
        const now = Date.now();
        getAutoPause().reset();
        clockRef.current.resume(now);
        setPhase('recording');
        phaseRef.current = 'recording';
        setNowMs(now);
      }
    },
    [getAutoPause],
  );

  return {
    phase,
    isRecording: phase === 'recording',
    isPaused: phase === 'paused',
    isAutoPaused: phase === 'auto-paused',
    isFinishing: phase === 'finishing',
    activityType,
    points,
    track,
    metrics,
    formatted,
    livePosition,
    gpsAccuracy,
    gpsError,
    pendingRestore,
    finishResult,
    notice,
    nativeTrackingActive,
    autoPauseEnabled,
    autoPauseThresholdKmh: autoPauseSpeedKmh(activityType),
    start,
    pause,
    resume,
    finish,
    saveActivity,
    discardFinish,
    restoreSession,
    dismissRestore,
    startPreview,
    stopPreview,
    changeActivityType,
    setAutoPauseEnabled,
    dismissNotice: useCallback(() => setNotice(null), []),
  };
}

export type ActivityRecorderState = ReturnType<typeof useActivityRecorder>;
