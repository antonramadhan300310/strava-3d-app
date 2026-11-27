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
  createAutoPauseTracker,
  createGpsFilter,
  smoothedElevationGain,
  type AutoPauseTracker,
  type GpsFilter,
} from '@/lib/gpsFilter';
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
import { startNativeTrackingService, stopNativeTrackingService } from '@/lib/nativeTrackingService';

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
  const startedAtRef = useRef<number>(0);
  const activeMsRef = useRef(0);
  /** Wall clock of the last resume, used to add elapsed time on pause/finish. */
  const runningSinceRef = useRef<number | null>(null);
  /** True while the Record tab is open, so the GPS badge has live data before Start. */
  const previewRef = useRef(false);
  const filterRef = useRef<GpsFilter | null>(null);
  const autoPauseRef = useRef<AutoPauseTracker | null>(null);
  const autoPauseEnabledRef = useRef(true);
  const [nowMs, setNowMs] = useState(() => Date.now());

  pointsRef.current = points;
  phaseRef.current = phase;
  activityRef.current = activityType;

  const currentActiveMs = useCallback(() => {
    const running = runningSinceRef.current;
    return activeMsRef.current + (running === null ? 0 : Date.now() - running);
  }, []);

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
      startedAt: startedAtRef.current,
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

  const flushElapsed = useCallback(() => {
    if (runningSinceRef.current === null) return;
    const now = Date.now();
    activeMsRef.current += now - runningSinceRef.current;
    runningSinceRef.current = now;
  }, []);

  /**
   * Auto-pause keeps the watcher and the wake lock alive: the session has to
   * see the next fix to know the athlete started moving again.
   */
  const enterAutoPause = useCallback(() => {
    if (phaseRef.current !== 'recording') return;
    flushElapsed();
    runningSinceRef.current = null;
    setPhase('auto-paused');
    phaseRef.current = 'auto-paused';
    setNowMs(Date.now());
    persist();
  }, [flushElapsed, persist]);

  const exitAutoPause = useCallback(() => {
    if (phaseRef.current !== 'auto-paused') return;
    runningSinceRef.current = Date.now();
    setPhase('recording');
    phaseRef.current = 'recording';
    setNowMs(Date.now());
  }, []);

  const handleSample = useCallback(
    (sample: LocationSample) => {
      if (Date.now() - sample.time > MAX_FIX_AGE_MS) return;

      setLivePosition(sample);
      setGpsAccuracy(sample.accuracy);

      const phase = phaseRef.current;
      // Preview fixes (Record tab open, no session) and a manual pause must not
      // touch the filter: the track would otherwise silently absorb the drift.
      if (phase !== 'recording' && phase !== 'auto-paused') return;

      const result = getFilter().push(sample);

      // Auto-pause reads the filtered speed even when the fix itself is dropped:
      // a stationary phone's fixes fail the drift gate, but its speed still has
      // to reach the state machine so the timer can stop and start again.
      if (autoPauseEnabledRef.current) {
        const update = getAutoPause().update(result.speedKmh, sample.time);
        if (update.changed) {
          if (update.paused) enterAutoPause();
          else exitAutoPause();
        }
      }

      if (phaseRef.current !== 'recording') return;
      if (!result.accepted || !result.point) return;

      const accepted = result.point;
      lastFixTimeRef.current = accepted.time;
      setPoints((current) => {
        const next = [...current, accepted];
        pointsRef.current = next;
        return next;
      });
      setGpsError(null);
    },
    [enterAutoPause, exitAutoPause, getAutoPause, getFilter],
  );

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

  // A single ticking clock drives the HUD; it only advances while recording.
  useEffect(() => {
    if (phase !== 'recording') return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [phase]);

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
      activeMsRef.current = 0;
      startedAtRef.current = Date.now();
      runningSinceRef.current = Date.now();
      setFinishResult(null);
      setNotice(null);
      setGpsError(null);
      setPhase('recording');
      phaseRef.current = 'recording';
      // Grab the wake lock before the location watcher starts so a screen lock
      // right after Start cannot suspend the first fixes.
      await startBackgroundService();
      await beginWatch();
    },
    [beginWatch, startBackgroundService],
  );

  const pause = useCallback(() => {
    if (phaseRef.current !== 'recording') return;
    flushElapsed();
    runningSinceRef.current = null;
    getAutoPause().reset();
    setPhase('paused');
    phaseRef.current = 'paused';
    // The HUD memo is keyed on the wall clock, so nudge it to show frozen values.
    setNowMs(Date.now());
    persist();
    stopBackgroundService();
  }, [flushElapsed, getAutoPause, persist, stopBackgroundService]);

  const resume = useCallback(async () => {
    if (phaseRef.current !== 'paused' && phaseRef.current !== 'auto-paused') return;
    getAutoPause().reset();
    runningSinceRef.current = Date.now();
    setPhase('recording');
    phaseRef.current = 'recording';
    setNowMs(Date.now());
    await startBackgroundService();
    await beginWatch();
  }, [beginWatch, getAutoPause, startBackgroundService]);

  const finish = useCallback(async (): Promise<FinishResult | null> => {
    if (phaseRef.current === 'idle' || phaseRef.current === 'finishing') return null;
    flushElapsed();
    runningSinceRef.current = null;
    setPhase('finishing');
    phaseRef.current = 'finishing';
    setNowMs(Date.now());
    stopBackgroundService();
    await stopWatch();

    const recorded = pointsRef.current;
    if (recorded.length < 2) {
      setPhase('paused');
      phaseRef.current = 'paused';
      setNotice('Rekaman terlalu pendek. Minimal 2 titik GPS yang sah diperlukan.');
      return null;
    }

    const gpsAltitudes = recorded.map((point) => point.ele);
    const gpsTrack: LngLatEle[] = recorded.map((point, index) => {
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
      recorded
        .map((point) => point.ele)
        .filter((value): value is number => value !== null && Number.isFinite(value)),
    );

    const result: FinishResult = {
      coordinates,
      distanceMeters: snapped.distanceMeters,
      elevationGainMeters: usedGpsAltitude ? gpsAltitudeGain : snapped.elevationGainMeters,
      durationSeconds: Math.round(activeMsRef.current / 1000),
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
  }, [flushElapsed, stopWatch, persist, stopBackgroundService]);

  const resetAfterSave = useCallback(() => {
    stopBackgroundService();
    clearSession();
    setPhase('idle');
    phaseRef.current = 'idle';
    setPoints([]);
    pointsRef.current = [];
    filterRef.current = createGpsFilter(activityRef.current);
    autoPauseRef.current = createAutoPauseTracker(activityRef.current);
    setFinishResult(null);
    activeMsRef.current = 0;
    runningSinceRef.current = null;
    lastFixTimeRef.current = null;
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
    const startedAtEpoch = (first && timestampOf(first)) ?? startedAtRef.current;
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
    activeMsRef.current = saved.activeMs;
    startedAtRef.current = saved.startedAt;
    lastFixTimeRef.current = saved.points[saved.points.length - 1]?.time ?? null;
    filterRef.current = createGpsFilter(saved.activityType);
    filterRef.current.reset(saved.points);
    autoPauseRef.current = createAutoPauseTracker(saved.activityType);
    setFinishResult(null);
    setNotice(`Sesi dipulihkan (${saved.points.length} titik, tersimpan ${formatSavedAt(saved.savedAt)}).`);

    if (saved.status === 'recording') {
      runningSinceRef.current = Date.now();
      setPhase('recording');
      phaseRef.current = 'recording';
      await startBackgroundService();
      await beginWatch();
    } else {
      runningSinceRef.current = null;
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
        getAutoPause().reset();
        runningSinceRef.current = Date.now();
        setPhase('recording');
        phaseRef.current = 'recording';
        setNowMs(Date.now());
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
