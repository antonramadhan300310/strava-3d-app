'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  currentSpeedKmh,
  formatDistanceKm,
  formatDuration,
  formatPace,
  formatSpeed,
  averageSpeedKmh,
  paceSecondsPerKm,
  rejectReason,
  totalDistanceMeters,
  type AcceptedPoint,
} from '@/lib/metrics';
import {
  startLocationWatch,
  type LocationError,
  type LocationSample,
  type LocationWatch,
} from '@/lib/location';
import { clearSession, loadSession, saveSession, type SavedSession } from '@/lib/session';
import { snapRouteToRoad, type ActivityType } from '@/lib/valhalla';
import { isSupabaseConfigured, saveRecordedActivity } from '@/lib/supabase';
import type { LngLat, LngLatEle } from '@/lib/polyline';

export type SessionPhase = 'idle' | 'recording' | 'paused' | 'finishing';

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

function toAcceptedPoint(sample: LocationSample): AcceptedPoint {
  return {
    lng: sample.lng,
    lat: sample.lat,
    ele: sample.altitude,
    time: sample.time,
    accuracy: sample.accuracy,
    speed: sample.speed,
  };
}

function formatSavedAt(epochMs: number): string {
  return new Date(epochMs).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function useActivityRecorder() {
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [activityType, setActivityType] = useState<ActivityType>('ride');
  const [points, setPoints] = useState<AcceptedPoint[]>([]);
  const [livePosition, setLivePosition] = useState<LocationSample | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<SavedSession | null>(null);
  const [finishResult, setFinishResult] = useState<FinishResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const watchRef = useRef<LocationWatch | null>(null);
  const pointsRef = useRef<AcceptedPoint[]>([]);
  const phaseRef = useRef<SessionPhase>('idle');
  const activityRef = useRef<ActivityType>('ride');
  const lastFixTimeRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const activeMsRef = useRef(0);
  /** Wall clock of the last resume, used to add elapsed time on pause/finish. */
  const runningSinceRef = useRef<number | null>(null);
  /** True while the Record tab is open, so the GPS badge has live data before Start. */
  const previewRef = useRef(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  pointsRef.current = points;
  phaseRef.current = phase;
  activityRef.current = activityType;

  const currentActiveMs = useCallback(() => {
    const running = runningSinceRef.current;
    return activeMsRef.current + (running === null ? 0 : Date.now() - running);
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

  const stopWatch = useCallback(async () => {
    const watch = watchRef.current;
    watchRef.current = null;
    if (watch) await watch.stop();
  }, []);

  const handleSample = useCallback(
    (sample: LocationSample) => {
      if (Date.now() - sample.time > MAX_FIX_AGE_MS) return;

      setLivePosition(sample);
      setGpsAccuracy(sample.accuracy);

      if (phaseRef.current !== 'recording') return;

      const candidate = toAcceptedPoint(sample);
      const last = pointsRef.current[pointsRef.current.length - 1] ?? null;
      if (rejectReason(candidate, last)) return;

      lastFixTimeRef.current = candidate.time;
      setPoints((current) => {
        const next = [...current, candidate];
        pointsRef.current = next;
        return next;
      });
      setGpsError(null);
    },
    [],
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
    // Only an in-flight recording outlives the Record tab; a paused session
    // restarts its watcher when the tab is opened again.
    if (phaseRef.current !== 'recording') await stopWatch();
  }, [stopWatch]);

  const flushElapsed = useCallback(() => {
    if (runningSinceRef.current === null) return;
    const now = Date.now();
    activeMsRef.current += now - runningSinceRef.current;
    runningSinceRef.current = now;
  }, []);

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
    void stopWatch();
  }, [stopWatch]);

  const start = useCallback(
    async (type: ActivityType) => {
      clearSession();
      setActivityType(type);
      activityRef.current = type;
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
      await beginWatch();
    },
    [beginWatch],
  );

  const pause = useCallback(() => {
    if (phaseRef.current !== 'recording') return;
    flushElapsed();
    runningSinceRef.current = null;
    setPhase('paused');
    phaseRef.current = 'paused';
    // The HUD memo is keyed on the wall clock, so nudge it to show frozen values.
    setNowMs(Date.now());
    persist();
  }, [flushElapsed, persist]);

  const resume = useCallback(async () => {
    if (phaseRef.current !== 'paused') return;
    runningSinceRef.current = Date.now();
    setPhase('recording');
    phaseRef.current = 'recording';
    await beginWatch();
  }, [beginWatch]);

  const finish = useCallback(async (): Promise<FinishResult | null> => {
    if (phaseRef.current === 'idle' || phaseRef.current === 'finishing') return null;
    flushElapsed();
    runningSinceRef.current = null;
    setPhase('finishing');
    phaseRef.current = 'finishing';
    setNowMs(Date.now());
    await stopWatch();

    const recorded = pointsRef.current;
    if (recorded.length < 2) {
      setPhase('paused');
      phaseRef.current = 'paused';
      setNotice('Rekaman terlalu pendek. Minimal 2 titik GPS yang sah diperlukan.');
      return null;
    }

    const gpsAltitudes = recorded.map((point) => point.ele);
    const gpsTrack: LngLatEle[] = recorded.map((point, index) => [
      point.lng,
      point.lat,
      Number.isFinite(gpsAltitudes[index] ?? NaN) ? (gpsAltitudes[index] as number) : 0,
    ]);

    // Snap the raw GPS trace onto roads first; the helper falls back to the
    // untouched track when Valhalla is unreachable, so Finish never fails here.
    const snapped = await snapRouteToRoad(gpsTrack, activityRef.current);
    const coordinates = snapped.coordinates;
    const usedGpsAltitude = snapped.usedGpsAltitude;

    const result: FinishResult = {
      coordinates,
      distanceMeters: snapped.distanceMeters,
      elevationGainMeters: snapped.elevationGainMeters,
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
  }, [flushElapsed, stopWatch, persist]);

  const saveActivity = useCallback(async (title: string) => {
    if (!finishResult) throw new Error('Belum ada rekaman yang selesai diproses.');
    if (!isSupabaseConfigured) {
      throw new Error(
        'Supabase belum dikonfigurasi. Isi NEXT_PUBLIC_SUPABASE_URL dan NEXT_PUBLIC_SUPABASE_ANON_KEY.',
      );
    }

    try {
      await saveRecordedActivity({
        title,
        activityType: activityRef.current,
        distanceMeters: finishResult.distanceMeters,
        elevationGain: finishResult.elevationGainMeters,
        durationSeconds: finishResult.durationSeconds,
        coordinates: finishResult.coordinates,
      });
      clearSession();
      setPhase('idle');
      phaseRef.current = 'idle';
      setPoints([]);
      pointsRef.current = [];
      setFinishResult(null);
      activeMsRef.current = 0;
      runningSinceRef.current = null;
      lastFixTimeRef.current = null;
      setNotice(`Aktivitas "${title}" tersimpan.`);
      if (previewRef.current) await beginWatch();
    } catch (cause) {
      throw cause;
    }
  }, [finishResult, beginWatch]);

  const discardFinish = useCallback(() => {
    setFinishResult(null);
    setNotice(null);
    setPhase('paused');
    phaseRef.current = 'paused';
    persist();
    // finish() stopped the watcher; restore the live dot for the paused session.
    if (previewRef.current) void beginWatch();
  }, [persist, beginWatch]);

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
    setFinishResult(null);
    setNotice(`Sesi dipulihkan (${saved.points.length} titik, tersimpan ${formatSavedAt(saved.savedAt)}).`);

    if (saved.status === 'recording') {
      runningSinceRef.current = Date.now();
      setPhase('recording');
      phaseRef.current = 'recording';
      await beginWatch();
    } else {
      runningSinceRef.current = null;
      setPhase('paused');
      phaseRef.current = 'paused';
    }
  }, [pendingRestore, beginWatch]);

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

  return {
    phase,
    isRecording: phase === 'recording',
    isPaused: phase === 'paused',
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
    changeActivityType: setActivityType,
    dismissNotice: useCallback(() => setNotice(null), []),
  };
}

export type ActivityRecorderState = ReturnType<typeof useActivityRecorder>;
