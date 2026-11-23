'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bike,
  Eye,
  EyeOff,
  Footprints,
  Gauge,
  Layers,
  Loader2,
  Lock,
  Mountain,
  Pause,
  Play,
  RotateCcw,
  Share2,
  Timer,
  TrendingUp,
  Trophy,
  Video,
  Wand2,
  Zap,
} from 'lucide-react';
import FlyoverMap, { type FlyoverMapHandle, type FlyoverMapStyle } from '@/components/FlyoverMap';
import ElevationChart from '@/components/ElevationChart';
import FlyoverExportSheet from '@/components/FlyoverExportSheet';
import ShareActivitySheet from '@/components/ShareActivitySheet';
import ActivityWeatherCard from '@/components/ActivityWeatherCard';
import ActivityRpeCard from '@/components/ActivityRpeCard';
import VirtualPowerCard from '@/components/VirtualPowerCard';
import AthleteProfileSheet from '@/components/AthleteProfileSheet';
import ProPaywallSheet from '@/components/ProPaywallSheet';
import { useAuth } from '@/context/AuthContext';
import { useFlyoverPlayback } from '@/hooks/useFlyoverPlayback';
import type { ActivityRecord } from '@/lib/activity';
import {
  computeGAP,
  computeKmSplits,
  findMatchedActivities,
  formatSignedDelta,
  getAllTimePRs,
  isFootSport,
  type KmSplit,
  type MatchedActivity,
  type PersonalRecordEntry,
} from '@/lib/activityAnalytics';
import { buildFlyoverPath, type FlyoverSample } from '@/lib/flyover';
import {
  averageSpeedKmh,
  formatDistanceKm,
  formatDuration,
  formatPace,
  formatSpeed,
  paceSecondsPerKm,
} from '@/lib/metrics';
import { snapRouteToRoad, type ActivityType } from '@/lib/valhalla';
import {
  getSupabaseClientOrNull,
  updateActivityProperties,
  updateActivityTrack,
} from '@/lib/supabase';
import { computeCyclingPowerAnalysis, getActivityRpe, storeActivityRpe } from '@/lib/powerAndEffort';
import { loadRiderProfile, type RiderProfile } from '@/lib/riderProfile';
import {
  getCachedActivityWeather,
  getEmbeddedActivityWeather,
  getOrFetchActivityWeather,
  type ActivityWeather,
} from '@/lib/weatherService';
import type { MapProvider } from '@/lib/mapProvider';

const ACTIVITY_ICONS: Record<ActivityType, React.ReactNode> = {
  cycling: <Bike size={18} />,
  run: <Footprints size={18} />,
  walking: <Footprints size={18} />,
  hike: <Mountain size={18} />,
};

type Props = {
  activity: ActivityRecord;
  /** Full feed, used for route matching and all-time records. */
  allActivities: ActivityRecord[];
  /** Same tile stack the main map uses, so the flyover matches. */
  provider: MapProvider;
  onClose: () => void;
  onNotice: (message: string) => void;
  /** Replaces the open activity after its track is rewritten in Supabase. */
  onTrackUpdated: (activity: ActivityRecord) => void;
};

type DetailTab = 'summary' | 'splits' | 'pr';

const DETAIL_TABS: { key: DetailTab; label: string }[] = [
  { key: 'summary', label: 'Ringkasan' },
  { key: 'splits', label: 'Splits' },
  { key: 'pr', label: 'Rekor (PR)' },
];

export default function ActivityDetail({
  activity,
  allActivities,
  provider,
  onClose,
  onNotice,
  onTrackUpdated,
}: Props) {
  const { isPro } = useAuth();
  const mapRef = useRef<FlyoverMapHandle | null>(null);
  const [cleanMode, setCleanMode] = useState(false);
  const [shareActivityOpen, setShareActivityOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [paywallReason, setPaywallReason] = useState<string | undefined>(undefined);
  const [mapStyle, setMapStyle] = useState<FlyoverMapStyle>('outdoor');
  const [snapping, setSnapping] = useState(false);
  const [introPending, setIntroPending] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>('summary');
  const [profile, setProfile] = useState<RiderProfile>(loadRiderProfile);
  const [profileOpen, setProfileOpen] = useState(false);
  const [rpe, setRpe] = useState<number | null>(() => getActivityRpe(activity));

  const requirePro = useCallback((reason: string) => {
    setPaywallReason(reason);
    setPaywallOpen(true);
  }, []);

  // A downgraded account must not stay on a locked sub-tab or satellite style.
  useEffect(() => {
    if (!isPro && detailTab !== 'summary') setDetailTab('summary');
  }, [isPro, detailTab]);

  useEffect(() => {
    if (isPro || mapStyle !== 'satellite') return;
    mapRef.current?.setMapStyle('outdoor');
    setMapStyle('outdoor');
  }, [isPro, mapStyle]);

  useEffect(() => {
    if (!isPro && exportOpen) setExportOpen(false);
  }, [isPro, exportOpen]);

  const [weather, setWeather] = useState<ActivityWeather | null>(() => {
    const embedded = getEmbeddedActivityWeather(activity);
    if (embedded) return embedded;
    if (typeof window === 'undefined') return null;
    return getCachedActivityWeather(activity.id);
  });
  const [weatherLoading, setWeatherLoading] = useState(
    () => weather === null && !activity.isPlannedRoute,
  );

  useEffect(() => {
    let cancelled = false;

    const embedded = getEmbeddedActivityWeather(activity);
    if (embedded) {
      setWeather(embedded);
      setWeatherLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const cached = getCachedActivityWeather(activity.id);
    if (cached) {
      setWeather(cached);
      setWeatherLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (activity.isPlannedRoute || activity.coordinates.length === 0) {
      setWeather(null);
      setWeatherLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setWeatherLoading(true);
    getOrFetchActivityWeather(activity, getSupabaseClientOrNull())
      .then((result) => {
        if (!cancelled) setWeather(result);
      })
      .catch(() => {
        if (!cancelled) setWeather(null);
      })
      .finally(() => {
        if (!cancelled) setWeatherLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activity]);

  const path = useMemo(() => buildFlyoverPath(activity.coordinates), [activity.coordinates]);

  const handleFrame = useCallback((sample: FlyoverSample, progress: number) => {
    mapRef.current?.applyFrame(sample, progress);
  }, []);

  const playback = useFlyoverPlayback(path, handleFrame);
  // The export sheet holds on to these callbacks, so they must stay stable.
  const playbackRef = useRef(playback);
  playbackRef.current = playback;

  /** Drives the map to one export frame; the exporter owns the timing. */
  const captureExportFrame = useCallback(
    (progress: number) =>
      mapRef.current?.captureProgressFrame(progress) ?? Promise.resolve(null),
    [],
  );

  const openExport = useCallback(() => {
    playbackRef.current.pause();
    setExportOpen(true);
  }, []);

  /** The exporter leaves the camera on the last frame, so put the flyover back. */
  const closeExport = useCallback(() => {
    setExportOpen(false);
    playbackRef.current.seek(playbackRef.current.progress);
  }, []);

  /**
   * Play from the very start glides the camera to the first vertex first, so
   * the flyover does not begin with a hard cut.
   */
  const handlePlayToggle = useCallback(async () => {
    if (playback.isPlaying) {
      playback.pause();
      return;
    }
    if (playback.progress > 0.001 || introPending) {
      playback.play();
      return;
    }

    setIntroPending(true);
    try {
      await mapRef.current?.flyToStart();
    } finally {
      setIntroPending(false);
    }
    playback.play();
  }, [introPending, playback]);

  const requestPlayToggle = useCallback(() => {
    if (!isPro) {
      requirePro('3D Flyover khusus Pro.');
      return;
    }
    void handlePlayToggle();
  }, [isPro, requirePro, handlePlayToggle]);

  const toggleMapStyle = useCallback(() => {
    const next: FlyoverMapStyle = mapStyle === 'outdoor' ? 'satellite' : 'outdoor';
    if (next === 'satellite' && !isPro) {
      requirePro('Peta satelit HD khusus Pro.');
      return;
    }
    mapRef.current?.setMapStyle(next);
    setMapStyle(next);
  }, [mapStyle, isPro, requirePro]);

  /** Re-snaps an old recording to the road network and saves it back. */
  const snapToRoad = useCallback(async () => {
    if (snapping) return;
    setSnapping(true);
    try {
      const result = await snapRouteToRoad(activity.coordinates, activity.activityType);
      if (!result.snapped) {
        onNotice('Gagal menempelkan ke jalan. Periksa koneksi internet lalu coba lagi.');
        return;
      }

      await updateActivityTrack(activity.id, {
        distanceMeters: result.distanceMeters,
        elevationGain: result.elevationGainMeters,
        durationSeconds: activity.durationSeconds,
        coordinates: result.coordinates,
      });

      onTrackUpdated({
        ...activity,
        coordinates: result.coordinates,
        distanceMeters: result.distanceMeters,
        elevationGain: result.elevationGainMeters,
      });
      onNotice('Rute dirapikan menempel ke jalan.');
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : 'Gagal merapikan rute.');
    } finally {
      setSnapping(false);
    }
  }, [activity, onNotice, onTrackUpdated, snapping]);

  const analytics = useMemo(() => {
    const gap = computeGAP(activity);
    const splits = computeKmSplits(activity);
    const matched = findMatchedActivities(activity, allActivities);
    const allTimePRs = getAllTimePRs(activity.activityType, allActivities);
    const heldPRs = allTimePRs.filter(
      (entry) => entry.activityId !== null && String(entry.activityId) === String(activity.id),
    );
    return { gap, splits, matched, allTimePRs, heldPRs };
  }, [activity, allActivities]);

  const isFoot = isFootSport(activity.activityType);

  const powerAnalysis = useMemo(
    () => computeCyclingPowerAnalysis(activity, profile),
    [activity, profile],
  );

  /** Caches locally and mirrors into GeoJSON properties; offline failures are silent. */
  const handleRpeChange = useCallback(
    (next: number) => {
      setRpe(next);
      storeActivityRpe(activity.id, next);
      const properties = { ...(activity.geojson?.properties ?? {}), rpe: next };
      void updateActivityProperties(activity.id, activity.coordinates, properties).catch(() => {
        // The device cache keeps the value until the next successful sync.
      });
    },
    [activity],
  );

  const summary = useMemo(() => {
    const averageSpeed = averageSpeedKmh(activity.distanceMeters, activity.durationSeconds);
    return {
      distance: `${formatDistanceKm(activity.distanceMeters)} km`,
      elevation: `${Math.round(activity.elevationGain)} m`,
      duration: formatDuration(activity.durationSeconds),
      averageSpeed: `${formatSpeed(averageSpeed)} km/j`,
      averagePace: `${formatPace(paceSecondsPerKm(averageSpeed))} /km`,
      gap: isFoot
        ? `${formatPace(analytics.gap.gapSecondsPerKm)} /km`
        : analytics.gap.estimatedPowerWatts !== null
          ? `${analytics.gap.estimatedPowerWatts} W`
          : '-- W',
    };
  }, [activity.distanceMeters, activity.durationSeconds, activity.elevationGain, analytics.gap, isFoot]);

  if (!path) {
    return (
      <section className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-[#0D1112] px-8 text-center">
        <p className="text-sm text-slate-400">Aktivitas ini tidak memiliki cukup titik rute.</p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] px-5 py-2.5 text-sm font-semibold text-[#0D1112]"
        >
          Kembali
        </button>
      </section>
    );
  }

  return (
    <section className="absolute inset-0 z-30 bg-[#0D1112]">
      <FlyoverMap ref={mapRef} path={path} provider={provider} activityType={activity.activityType} />

      {/* In clean mode a tap anywhere on the map brings the controls back. */}
      {cleanMode && (
        <button
          type="button"
          aria-label="Tampilkan kontrol pemutaran"
          onClick={() => setCleanMode(false)}
          className="absolute inset-0 z-10"
        />
      )}

      <div
        className={`pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 bg-gradient-to-b from-[#0D1112]/90 to-transparent px-3 pb-8 pr-16 pt-[calc(env(safe-area-inset-top)+0.75rem)] transition-opacity duration-300 ${
          cleanMode ? 'invisible opacity-0' : 'visible opacity-100'
        }`}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Tutup detail aktivitas"
          className="pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/15 bg-[#151B1D]/85 text-slate-100 shadow-xl backdrop-blur active:scale-95"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="min-w-0 flex-1 pt-0.5">
          <h1 className="truncate text-sm font-semibold text-slate-100">{activity.title}</h1>
          <p className="truncate text-[11px] text-slate-400">
            {activity.isPlannedRoute ? 'Rute Rencana' : 'Rekaman'} •{' '}
            {formatActivityType(activity.activityType)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShareActivityOpen(true)}
          aria-label="Bagikan ringkasan aktivitas"
          className="pointer-events-auto flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-[#B9F51E]/40 bg-[#B9F51E]/15 px-3 text-[11px] font-bold text-[#B9F51E] shadow-xl backdrop-blur active:scale-95"
        >
          <Share2 size={16} />
          Bagikan
        </button>
      </div>

      {/* Quick actions sit under the telemetry HUD so nothing overlaps it. */}
      <div
        className={`absolute right-3 top-[calc(env(safe-area-inset-top)+9rem)] z-40 flex flex-col items-end gap-2 transition-opacity duration-300 ${
          cleanMode ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
      >
        <button
          type="button"
          onClick={toggleMapStyle}
          aria-label={
            mapStyle === 'outdoor' ? 'Ganti ke gaya satelit' : 'Ganti ke gaya outdoor'
          }
          className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-[#151B1D]/85 text-slate-100 shadow-xl backdrop-blur active:scale-95"
        >
          <Layers size={18} />
        </button>
        {!activity.isPlannedRoute && (
          <button
            type="button"
            onClick={() => void snapToRoad()}
            disabled={snapping}
            aria-label="Rapikan rute ke jalan"
            aria-busy={snapping}
            title="Rapikan ke Jalan"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-[#151B1D]/85 text-[#B9F51E] shadow-xl backdrop-blur active:scale-95 disabled:opacity-60"
          >
            {snapping ? <Loader2 size={18} className="animate-spin" /> : <Wand2 size={18} />}
          </button>
        )}
        <button
          type="button"
          onClick={
            isPro ? openExport : () => requirePro('Export Video MP4 khusus Pro.')
          }
          aria-label="Export MP4 (Beta)"
          title="Export MP4 (Beta)"
          className="flex h-10 items-center gap-1.5 rounded-full border border-white/15 bg-[#151B1D]/85 px-3 text-[11px] font-bold text-slate-100 shadow-xl backdrop-blur active:scale-95"
        >
          <Video size={16} className="text-[#B9F51E]" />
          Export MP4
          {isPro ? (
            <span className="text-[9px] font-semibold text-[#B9F51E]">(Beta)</span>
          ) : (
            <span className="rounded-full bg-[#B9F51E] px-1.5 py-0.5 text-[9px] font-bold text-[#0D1112]">
              👑 PRO
            </span>
          )}
        </button>
      </div>

      <button
        type="button"
        onClick={() => setCleanMode((value) => !value)}
        aria-label={cleanMode ? 'Tampilkan kontrol flyover' : 'Mode bersih (sembunyikan kontrol)'}
        aria-pressed={cleanMode}
        className={`absolute right-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-40 flex items-center justify-center rounded-full border shadow-xl backdrop-blur transition active:scale-95 ${
          cleanMode
            ? 'h-9 w-9 border-white/20 bg-[#0D1112]/35 text-slate-200/70'
            : 'h-10 w-10 border-white/15 bg-[#151B1D]/85 text-slate-100'
        }`}
      >
        {cleanMode ? <EyeOff size={18} /> : <Eye size={20} />}
      </button>
      <div className="pointer-events-none absolute inset-x-3 top-[calc(env(safe-area-inset-top)+3.75rem)] flex justify-center pr-14">
        <TelemetryHud
          distanceMeters={playback.telemetry.distanceMeters}
          elevationMeters={playback.telemetry.elevationMeters}
          progress={playback.telemetry.progress}
          playing={playback.isPlaying}
        />
      </div>

      <div
        className={`absolute inset-x-0 bottom-0 flex flex-col gap-2 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] transition-all duration-300 ${
          cleanMode ? 'pointer-events-none translate-y-[120%] opacity-0' : 'opacity-100'
        }`}
        aria-hidden={cleanMode}
      >
        <div className="mx-auto flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#151B1D]/92 shadow-2xl backdrop-blur">
          <div
            className="flex gap-1 border-b border-white/10 p-1.5"
            role="tablist"
            aria-label="Detail aktivitas"
          >
            {DETAIL_TABS.map(({ key, label }) => {
              const locked = key !== 'summary' && !isPro;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={detailTab === key}
                  onClick={() =>
                    locked
                      ? requirePro(
                          key === 'splits'
                            ? 'Splits per kilometer khusus Pro.'
                            : 'Rekor Pribadi (PR) khusus Pro.',
                        )
                      : setDetailTab(key)
                  }
                  className={`flex flex-1 items-center justify-center gap-1 rounded-lg py-2 text-[11px] font-semibold transition active:scale-95 ${
                    detailTab === key
                      ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]'
                      : 'text-slate-300 active:bg-[#1E2E16]'
                  }`}
                >
                  {label}
                  {locked && (
                    <span className="rounded-full bg-[#B9F51E] px-1 py-0.5 text-[8px] font-bold text-[#0D1112]">
                      👑
                    </span>
                  )}
                  {!locked && key === 'pr' && analytics.heldPRs.length > 0 && (
                    <span
                      className={`rounded-full px-1.5 text-[9px] tabular-nums ${
                        detailTab === key
                          ? 'bg-white/25 text-white'
                          : 'bg-amber-400/20 text-amber-300'
                      }`}
                    >
                      {analytics.heldPRs.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="max-h-[46vh] overflow-y-auto overscroll-contain p-3">
            {detailTab === 'summary' && (
              <div className="flex flex-col">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {ACTIVITY_ICONS[activity.activityType]}
                    Ringkasan
                  </span>
                  <span className="text-[11px] font-medium text-slate-400">
                    {formatDistanceKm(playback.telemetry.distanceMeters)} /{' '}
                    {formatDistanceKm(activity.distanceMeters)} km
                  </span>
                </div>

                <dl className="mt-2 grid grid-cols-3 gap-1.5">
                  <SummaryMetric icon={<TrendingUp size={12} />} label="Jarak" value={summary.distance} />
                  <SummaryMetric icon={<Mountain size={12} />} label="Elevasi" value={summary.elevation} />
                  <SummaryMetric icon={<Timer size={12} />} label="Durasi" value={summary.duration} />
                  {isFoot ? (
                    <>
                      <SummaryMetric icon={<Timer size={12} />} label="Pace" value={summary.averagePace} />
                      <SummaryMetric
                        icon={<TrendingUp size={12} />}
                        label="GAP"
                        value={summary.gap}
                        locked={!isPro}
                        onClick={() => requirePro('Metrik GAP khusus Pro.')}
                      />
                    </>
                  ) : (
                    <>
                      <SummaryMetric icon={<Gauge size={12} />} label="Kecepatan" value={summary.averageSpeed} />
                      <SummaryMetric
                        icon={<Zap size={12} />}
                        label="Est. Power"
                        value={summary.gap}
                        locked={!isPro}
                        onClick={() => requirePro('Virtual Power & Zona FTP khusus Pro.')}
                      />
                    </>
                  )}
                  <SummaryMetric
                    icon={ACTIVITY_ICONS[activity.activityType]}
                    label="Jenis"
                    value={formatActivityType(activity.activityType)}
                  />
                </dl>

                <ActivityWeatherCard weather={weather} loading={weatherLoading} />

                {isPro ? (
                  <ActivityRpeCard
                    rpe={rpe}
                    durationSeconds={activity.durationSeconds}
                    onChange={handleRpeChange}
                  />
                ) : (
                  <LockedProPanel
                    title="Perceived Exertion (RPE)"
                    description="Catat tingkat usaha dan skor beban latihan."
                    onOpen={() => requirePro('Kartu RPE khusus Pro.')}
                  />
                )}

                {isPro ? (
                  powerAnalysis && (
                    <VirtualPowerCard
                      analysis={powerAnalysis}
                      onOpenProfile={() => setProfileOpen(true)}
                    />
                  )
                ) : (
                  <LockedProPanel
                    title="Virtual Power & Zona FTP"
                    description="Estimasi daya dan distribusi zona FTP pribadi."
                    onOpen={() => requirePro('Virtual Power & Zona FTP khusus Pro.')}
                  />
                )}

                <div className="mt-2.5">
                  <ElevationChart
                    coordinates={activity.coordinates}
                    progress={playback.telemetry.progress}
                  />
                </div>

                {analytics.matched.length >= 2 &&
                  (isPro ? (
                    <MatchedRoutesCard matches={analytics.matched} isFoot={isFoot} />
                  ) : (
                    <LockedProPanel
                      title="Matched Activities"
                      description="Bandingkan waktu kamu di rute yang sama."
                      onOpen={() => requirePro('Matched Activities khusus Pro.')}
                    />
                  ))}
              </div>
            )}

            {detailTab === 'splits' && (
              <SplitsTab splits={analytics.splits} isFoot={isFoot} />
            )}

            {detailTab === 'pr' && (
              <PRTab
                heldPRs={analytics.heldPRs}
                allTimePRs={analytics.allTimePRs}
                isFoot={isFoot}
                sportLabel={formatActivityType(activity.activityType)}
                activityId={activity.id}
              />
            )}
          </div>
        </div>

        {detailTab === 'summary' && (
          <>
            <div className="mx-auto flex w-full max-w-md gap-2">
              <button
                type="button"
                onClick={requestPlayToggle}
                disabled={introPending}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-[#B9F51E] hover:bg-[#A5E012] py-3.5 text-base font-bold text-[#0D1112] shadow-2xl transition active:scale-[0.98] disabled:opacity-70"
              >
                {introPending ? (
                  <Loader2 size={20} className="animate-spin" />
                ) : !isPro ? (
                  <Lock size={18} />
                ) : playback.isPlaying ? (
                  <Pause size={20} />
                ) : (
                  <Play size={20} />
                )}
                {introPending
                  ? 'Menyiapkan kamera…'
                  : playback.isPlaying
                    ? 'Pause 3D Flyover'
                    : 'Play 3D Flyover'}
                {!isPro && (
                  <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[9px] font-bold">
                    👑 PRO
                  </span>
                )}
              </button>
            </div>

            <div className="mx-auto flex w-full max-w-md items-center gap-2 rounded-2xl border border-white/10 bg-[#151B1D]/92 px-2.5 py-2 shadow-2xl backdrop-blur">
              <button
                type="button"
                onClick={requestPlayToggle}
                aria-label={playback.isPlaying ? 'Pause' : 'Play'}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#1E2E16] text-slate-100 active:scale-95"
              >
                {playback.isPlaying ? <Pause size={18} /> : <Play size={18} />}
              </button>

              <label className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="sr-only">Posisi flyover</span>
                <input
                  type="range"
                  min={0}
                  max={1000}
                  step={1}
                  value={Math.round(playback.progress * 1000)}
                  onChange={(event) => {
                    playback.pause();
                    playback.seek(Number(event.target.value) / 1000);
                  }}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[#2A3538] accent-[#B9F51E]"
                />
                <span className="text-center text-[10px] font-medium tabular-nums text-slate-400">
                  {Math.round(playback.progress * 100)}%
                </span>
              </label>

              <button
                type="button"
                onClick={playback.cycleSpeed}
                aria-label={`Kecepatan ${playback.speed}x, ketuk untuk mengubah`}
                className="flex h-11 shrink-0 items-center justify-center rounded-full bg-[#1E2E16] px-3 text-xs font-bold tabular-nums text-[#B9F51E] active:scale-95"
              >
                {playback.speed}x
              </button>

              <button
                type="button"
                onClick={playback.restart}
                aria-label="Ulangi flyover"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#1E2E16] text-slate-100 active:scale-95"
              >
                <RotateCcw size={18} />
              </button>

              <button
                type="button"
                onClick={onClose}
                aria-label="Kembali ke daftar aktivitas"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#1E2E16] text-slate-100 active:scale-95"
              >
                <ArrowLeft size={18} />
              </button>
            </div>
          </>
        )}
      </div>

      {shareActivityOpen && (
        <ShareActivitySheet
          activity={activity}
          onClose={() => setShareActivityOpen(false)}
          onNotice={onNotice}
        />
      )}

      {exportOpen && (
        <FlyoverExportSheet
          activity={activity}
          captureFrame={captureExportFrame}
          onClose={closeExport}
          onNotice={onNotice}
        />
      )}

      <AthleteProfileSheet
        open={profileOpen}
        activities={allActivities}
        onClose={() => setProfileOpen(false)}
        onSaved={(next) => {
          setProfile(next);
          onNotice('Profil berhasil disimpan');
        }}
      />

      <ProPaywallSheet
        open={paywallOpen}
        reason={paywallReason}
        onClose={() => setPaywallOpen(false)}
      />
    </section>
  );
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function speedOfActivity(activity: ActivityRecord): number {
  if (activity.durationSeconds <= 0) return 0;
  return activity.distanceMeters / 1000 / (activity.durationSeconds / 3600);
}

function MatchedRoutesCard({
  matches,
  isFoot,
}: {
  matches: MatchedActivity[];
  isFoot: boolean;
}) {
  const current = matches.find((match) => match.isCurrent);
  const currentBadge = current
    ? current.rank === 1
      ? '#1 Tercepat'
      : `#${current.rank} (+${Math.round(current.deltaSeconds)} dtk)`
    : null;

  return (
    <section className="mt-2 rounded-xl border border-[#B9F51E]/25 bg-gradient-to-br from-[#151B1D] to-[#1E2E16]/30 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-slate-100">
          Riwayat di Rute Ini ({matches.length}x latihan)
        </p>
        {currentBadge && (
          <span className="shrink-0 rounded-full border border-amber-300/30 bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-300">
            {currentBadge}
          </span>
        )}
      </div>

      <ul className="mt-2 flex flex-col gap-1">
        {matches.map((match) => {
          const speed = speedOfActivity(match.activity);
          const deltaClass =
            match.relativeToCurrentSeconds < 0
              ? 'text-emerald-400'
              : match.relativeToCurrentSeconds > 0
                ? 'text-rose-400'
                : 'text-slate-400';

          return (
            <li
              key={String(match.activity.id)}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
                match.isCurrent
                  ? 'bg-[#B9F51E]/10 ring-1 ring-[#B9F51E]/30'
                  : 'bg-[#1E2E16]/50'
              }`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                  match.rank === 1
                    ? 'bg-amber-400 text-slate-950'
                    : 'bg-[#2A3538] text-slate-200'
                }`}
              >
                {match.rank === 1 ? <Trophy size={11} /> : match.rank}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-[10px] font-medium text-slate-200">
                  <span className="truncate">{shortDate(match.activity.createdAt)}</span>
                  {match.isCurrent && (
                    <span className="rounded-full bg-[#B9F51E]/20 px-1 text-[8px] font-bold text-[#B9F51E]">
                      INI
                    </span>
                  )}
                </span>
                <span className="text-[9px] text-slate-400">
                  {formatDuration(match.activity.durationSeconds)} •{' '}
                  {isFoot
                    ? `${formatPace(paceSecondsPerKm(speed))} /km`
                    : `${formatSpeed(speed)} km/j`}
                </span>
              </span>

              <span className={`shrink-0 text-[10px] font-semibold tabular-nums ${deltaClass}`}>
                {match.isCurrent ? '—' : `${formatSignedDelta(match.relativeToCurrentSeconds)} dtk`}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SplitsTab({ splits, isFoot }: { splits: KmSplit[]; isFoot: boolean }) {
  if (splits.length === 0) {
    return (
      <p className="py-6 text-center text-[11px] text-slate-400">
        Belum ada split. Aktivitas ini terlalu pendek atau tidak punya data jarak.
      </p>
    );
  }

  const performance = splits.map((split) =>
    isFoot
      ? split.paceSecondsPerKm > 0
        ? 1000 / split.paceSecondsPerKm
        : 0
      : split.speedKmh,
  );
  const fastest = Math.max(...performance);
  const grid = isFoot
    ? 'grid-cols-[2.4rem_1fr_1fr_1.15fr]'
    : 'grid-cols-[2.4rem_1fr_1.15fr]';

  return (
    <div>
      <div className={`grid ${grid} gap-1 px-2 pb-1 text-[9px] uppercase tracking-wide text-slate-500`}>
        <span>KM</span>
        <span className="text-right">{isFoot ? 'Pace' : 'Kec.'}</span>
        {isFoot && <span className="text-right">GAP</span>}
        <span className="text-right">Elevasi</span>
      </div>

      <div className="flex flex-col gap-1">
        {splits.map((split, index) => {
          const ratio = fastest > 0 ? (performance[index] / fastest) * 100 : 0;
          return (
            <div key={`${split.kmLabel}-${index}`} className="relative overflow-hidden rounded-lg bg-[#1E2E16]/60">
              <div
                className="absolute inset-y-0 left-0 bg-[#B9F51E]/20"
                style={{ width: `${Math.max(4, ratio)}%` }}
              />
              <div className={`relative grid ${grid} items-center gap-1 px-2 py-1.5 text-[11px]`}>
                <span className="font-semibold leading-tight text-slate-200">
                  {split.kmLabel}
                  {split.distanceMeters < 999 && (
                    <span className="block text-[8px] font-normal text-slate-500">
                      {(split.distanceMeters / 1000).toFixed(2)} km
                    </span>
                  )}
                </span>
                <span className="text-right font-medium tabular-nums text-slate-100">
                  {isFoot ? formatPace(split.paceSecondsPerKm) : formatSpeed(split.speedKmh)}
                  <span className="ml-0.5 text-[8px] font-normal text-slate-500">
                    {isFoot ? '/km' : 'km/j'}
                  </span>
                </span>
                {isFoot && (
                  <span className="text-right tabular-nums text-sky-300">
                    {formatPace(split.gapSecondsPerKm)}
                  </span>
                )}
                <span className="text-right text-[10px] tabular-nums">
                  <span className="text-emerald-400">+{split.elevationGain}</span>{' '}
                  <span className="text-rose-400">-{split.elevationLoss}</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function prValue(entry: PersonalRecordEntry): string {
  if (entry.kind === 'distance') {
    return entry.valueMeters !== null ? `${formatDistanceKm(entry.valueMeters)} km` : '—';
  }
  if (entry.kind === 'elevation') {
    return entry.valueMeters !== null ? `${Math.round(entry.valueMeters)} m` : '—';
  }
  return entry.durationSeconds !== null ? formatDuration(entry.durationSeconds) : '—';
}

function prSubtitle(entry: PersonalRecordEntry, isFoot: boolean): string {
  if (entry.kind === 'distance') {
    return entry.durationSeconds !== null
      ? `Durasi ${formatDuration(entry.durationSeconds)}`
      : 'Jarak terjauh';
  }
  if (entry.kind === 'elevation') return 'Total tanjakan';
  if (entry.durationSeconds === null) return 'Belum ada catatan';
  if (entry.speedKmh === null) return '';
  return isFoot
    ? `${formatPace(entry.paceSecondsPerKm)} /km`
    : `${formatSpeed(entry.speedKmh)} km/j`;
}

function PRTab({
  heldPRs,
  allTimePRs,
  isFoot,
  sportLabel,
  activityId,
}: {
  heldPRs: PersonalRecordEntry[];
  allTimePRs: PersonalRecordEntry[];
  isFoot: boolean;
  sportLabel: string;
  activityId: string | number;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <p className="text-[11px] font-semibold text-slate-100">Rekor di Aktivitas Ini</p>
        {heldPRs.length > 0 ? (
          <div className="mt-1.5 rounded-xl border border-amber-300/30 bg-gradient-to-br from-amber-500/15 to-[#151B1D] p-2.5">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-400/20 text-amber-300">
                <Trophy size={16} />
              </span>
              <div>
                <p className="text-[11px] font-bold text-amber-200">
                  {heldPRs.length} rekor pribadi
                </p>
                <p className="text-[9px] text-amber-200/70">
                  Aktivitas ini memegang rekor terbaik.
                </p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {heldPRs.map((entry) => (
                <span
                  key={entry.key}
                  className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[9px] font-semibold text-amber-200"
                >
                  {entry.label}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-1 rounded-xl bg-[#1E2E16]/50 px-2.5 py-2 text-[10px] text-slate-400">
            Belum memegang rekor. Terus tingkatkan!
          </p>
        )}
      </div>

      <div>
        <p className="text-[11px] font-semibold text-slate-100">
          Rekor Pribadi Terbaik{' '}
          <span className="text-[9px] font-normal text-slate-500">• {sportLabel}</span>
        </p>
        <ul className="mt-1.5 flex flex-col gap-1">
          {allTimePRs.map((entry) => {
            const held =
              entry.activityId !== null && String(entry.activityId) === String(activityId);
            return (
              <li
                key={entry.key}
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
                  held
                    ? 'bg-amber-400/10 ring-1 ring-amber-300/25'
                    : 'bg-[#1E2E16]/50'
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                    held
                      ? 'bg-amber-400/20 text-amber-300'
                      : 'bg-[#2A3538]/60 text-slate-300'
                  }`}
                >
                  {held ? (
                    <Trophy size={12} />
                  ) : (
                    <span className="text-[9px] font-bold">{entry.shortLabel}</span>
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] font-semibold text-slate-200">
                    {entry.label}
                  </span>
                  <span className="block text-[9px] text-slate-400">
                    {prSubtitle(entry, isFoot)}
                  </span>
                </span>

                <span className="shrink-0 text-right">
                  <span
                    className={`block text-[11px] font-bold tabular-nums ${
                      entry.activityId !== null ? 'text-slate-100' : 'text-slate-500'
                    }`}
                  >
                    {prValue(entry)}
                  </span>
                  <span className="block text-[8px] text-slate-500">
                    {entry.achievedAt ? shortDate(entry.achievedAt) : '—'}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function formatActivityType(type: ActivityType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function TelemetryHud({
  distanceMeters,
  elevationMeters,
  progress,
  playing,
}: {
  distanceMeters: number;
  elevationMeters: number;
  progress: number;
  playing: boolean;
}) {
  return (
    <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#151B1D]/85 px-4 py-2.5 text-slate-100 shadow-2xl backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          <span
            className={`h-2 w-2 rounded-full ${
              playing ? 'animate-pulse bg-[#B9F51E]' : 'bg-slate-500'
            }`}
          />
          {playing ? 'Flyover berjalan' : 'Flyover siap'}
        </span>
        <span className="text-[10px] font-medium tabular-nums text-slate-400">
          {Math.round(progress * 100)}%
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1 border-t border-white/10 pt-1.5">
        <HudMetric label="Jarak" value={`${formatDistanceKm(distanceMeters)} km`} />
        <HudMetric label="Elevasi" value={`${Math.round(elevationMeters)} m`} />
        <HudMetric label="Progres" value={`${Math.round(progress * 100)}%`} />
      </div>
    </div>
  );
}

function HudMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[9px] uppercase tracking-wide text-slate-400">{label}</span>
      <span className="text-sm font-bold tabular-nums">{value}</span>
    </div>
  );
}

function SummaryMetric({
  icon,
  label,
  value,
  locked = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  locked?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <dt
        className={`flex items-center gap-1 text-[9px] uppercase tracking-wide ${
          locked ? 'text-amber-300/80' : 'text-slate-400'
        }`}
      >
        {icon}
        {label}
      </dt>
      <dd
        className={`text-[11px] font-semibold tabular-nums ${
          locked ? 'text-amber-300' : 'text-slate-100'
        }`}
      >
        {locked ? '👑 PRO' : value}
      </dd>
    </>
  );

  if (locked) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onClick?.();
          }
        }}
        className="flex cursor-pointer flex-col items-center rounded-lg border border-amber-300/30 bg-amber-400/10 px-1 py-1.5 active:scale-95"
      >
        {content}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center rounded-lg bg-[#1E2E16]/60 px-1 py-1.5">
      {content}
    </div>
  );
}

function LockedProPanel({
  title,
  description,
  onOpen,
}: {
  title: string;
  description: string;
  onOpen: () => void;
}) {
  return (
    <section className="mt-2 rounded-xl border border-amber-300/25 bg-gradient-to-br from-[#151B1D] to-amber-950/30 p-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-100">
        <Lock size={12} className="text-amber-300" />
        {title}
        <span className="rounded-full border border-[#B9F51E]/40 bg-[#B9F51E] px-1.5 py-0.5 text-[9px] font-bold text-[#0D1112]">
          👑 PRO
        </span>
      </p>
      <p className="mt-0.5 text-[10px] text-slate-400">{description}</p>
      <button
        type="button"
        onClick={onOpen}
        className="mt-2 w-full rounded-lg bg-[#B9F51E] hover:bg-[#A5E012] py-1.5 text-[11px] font-semibold text-[#0D1112] active:scale-[0.98]"
      >
        Upgrade ke Pro
      </button>
    </section>
  );
}
