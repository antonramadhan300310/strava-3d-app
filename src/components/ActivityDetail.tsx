'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bike,
  Eye,
  EyeOff,
  Footprints,
  Gauge,
  Mountain,
  Pause,
  Play,
  RotateCcw,
  Share2,
  Timer,
  TrendingUp,
} from 'lucide-react';
import FlyoverMap, { type FlyoverMapHandle } from '@/components/FlyoverMap';
import ElevationChart from '@/components/ElevationChart';
import ShareCardModal from '@/components/ShareCardModal';
import { useFlyoverPlayback } from '@/hooks/useFlyoverPlayback';
import type { ActivityRecord } from '@/lib/activity';
import { buildFlyoverPath, type FlyoverSample } from '@/lib/flyover';
import {
  averageSpeedKmh,
  formatDistanceKm,
  formatDuration,
  formatPace,
  formatSpeed,
  paceSecondsPerKm,
} from '@/lib/metrics';
import type { ActivityType } from '@/lib/valhalla';

const ACTIVITY_ICONS: Record<ActivityType, React.ReactNode> = {
  ride: <Bike size={18} />,
  run: <Footprints size={18} />,
  hike: <Mountain size={18} />,
};

type Props = {
  activity: ActivityRecord;
  onClose: () => void;
  onNotice: (message: string) => void;
};

export default function ActivityDetail({ activity, onClose, onNotice }: Props) {
  const mapRef = useRef<FlyoverMapHandle | null>(null);
  const [cleanMode, setCleanMode] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const path = useMemo(() => buildFlyoverPath(activity.coordinates), [activity.coordinates]);

  const handleFrame = useCallback((sample: FlyoverSample, progress: number) => {
    mapRef.current?.applyFrame(sample, progress);
  }, []);

  const captureFrame = useCallback(() => mapRef.current?.captureFrame() ?? null, []);

  const playback = useFlyoverPlayback(path, handleFrame);

  const summary = useMemo(() => {
    const averageSpeed = averageSpeedKmh(activity.distanceMeters, activity.durationSeconds);
    return {
      distance: `${formatDistanceKm(activity.distanceMeters)} km`,
      elevation: `${Math.round(activity.elevationGain)} m`,
      duration: formatDuration(activity.durationSeconds),
      averageSpeed: `${formatSpeed(averageSpeed)} km/j`,
      averagePace: `${formatPace(paceSecondsPerKm(averageSpeed))} /km`,
    };
  }, [activity.distanceMeters, activity.durationSeconds, activity.elevationGain]);

  if (!path) {
    return (
      <section className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-slate-950 px-8 text-center">
        <p className="text-sm text-slate-400">Aktivitas ini tidak memiliki cukup titik rute.</p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl bg-orange-500 px-5 py-2.5 text-sm font-semibold text-white"
        >
          Kembali
        </button>
      </section>
    );
  }

  return (
    <section className="absolute inset-0 z-30 bg-slate-950">
      <FlyoverMap ref={mapRef} path={path} />

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
        className={`pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 bg-gradient-to-b from-slate-950/90 to-transparent px-3 pb-8 pr-16 pt-[calc(env(safe-area-inset-top)+0.75rem)] transition-opacity duration-300 ${
          cleanMode ? 'invisible opacity-0' : 'visible opacity-100'
        }`}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Tutup detail aktivitas"
          className="pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/15 bg-slate-900/85 text-slate-100 shadow-xl backdrop-blur active:scale-95"
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
      </div>

      <button
        type="button"
        onClick={() => setCleanMode((value) => !value)}
        aria-label={cleanMode ? 'Tampilkan kontrol flyover' : 'Mode bersih (sembunyikan kontrol)'}
        aria-pressed={cleanMode}
        className={`absolute right-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-40 flex items-center justify-center rounded-full border shadow-xl backdrop-blur transition active:scale-95 ${
          cleanMode
            ? 'h-9 w-9 border-white/20 bg-slate-950/35 text-slate-200/70'
            : 'h-10 w-10 border-white/15 bg-slate-900/85 text-slate-100'
        }`}
      >
        {cleanMode ? <EyeOff size={18} /> : <Eye size={20} />}
      </button>
      <div className="pointer-events-none absolute inset-x-3 top-[calc(env(safe-area-inset-top)+3.75rem)] flex justify-center">
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
        <div className="mx-auto w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/92 p-3 shadow-2xl backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {ACTIVITY_ICONS[activity.activityType]}
              Ringkasan
            </span>
            <span className="text-[11px] font-medium text-slate-400">
              {formatDistanceKm(playback.telemetry.distanceMeters)} / {formatDistanceKm(activity.distanceMeters)} km
            </span>
          </div>

          <ElevationChart coordinates={activity.coordinates} progress={playback.telemetry.progress} />

          <dl className="mt-2 grid grid-cols-3 gap-1.5">
            <SummaryMetric icon={<TrendingUp size={12} />} label="Jarak" value={summary.distance} />
            <SummaryMetric icon={<Mountain size={12} />} label="Elevasi" value={summary.elevation} />
            <SummaryMetric icon={<Timer size={12} />} label="Durasi" value={summary.duration} />
            <SummaryMetric icon={<Gauge size={12} />} label="Kecepatan" value={summary.averageSpeed} />
            <SummaryMetric icon={<Timer size={12} />} label="Pace" value={summary.averagePace} />
            <SummaryMetric
              icon={ACTIVITY_ICONS[activity.activityType]}
              label="Jenis"
              value={formatActivityType(activity.activityType)}
            />
          </dl>
        </div>

        <div className="mx-auto flex w-full max-w-md gap-2">
          <button
            type="button"
            onClick={playback.toggle}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-orange-500 py-3.5 text-base font-bold text-white shadow-2xl transition active:scale-[0.98]"
          >
            {playback.isPlaying ? <Pause size={20} /> : <Play size={20} />}
            {playback.isPlaying ? 'Pause 3D Flyover' : 'Play 3D Flyover'}
          </button>

          <button
            type="button"
            onClick={() => setShareOpen(true)}
            aria-label="Bagikan atau unduh kartu aktivitas"
            className="flex shrink-0 items-center justify-center gap-2 rounded-2xl border border-white/15 bg-slate-900/92 px-4 text-sm font-bold text-slate-100 shadow-2xl backdrop-blur transition active:scale-[0.98]"
          >
            <Share2 size={18} />
            Share
          </button>
        </div>

        <div className="mx-auto flex w-full max-w-md items-center gap-2 rounded-2xl border border-white/10 bg-slate-900/92 px-2.5 py-2 shadow-2xl backdrop-blur">
          <button
            type="button"
            onClick={playback.toggle}
            aria-label={playback.isPlaying ? 'Pause' : 'Play'}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-800 text-slate-100 active:scale-95"
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
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-orange-500"
            />
            <span className="text-center text-[10px] font-medium tabular-nums text-slate-400">
              {Math.round(playback.progress * 100)}%
            </span>
          </label>

          <button
            type="button"
            onClick={playback.cycleSpeed}
            aria-label={`Kecepatan ${playback.speed}x, ketuk untuk mengubah`}
            className="flex h-11 shrink-0 items-center justify-center rounded-full bg-slate-800 px-3 text-xs font-bold tabular-nums text-orange-300 active:scale-95"
          >
            {playback.speed}x
          </button>

          <button
            type="button"
            onClick={playback.restart}
            aria-label="Ulangi flyover"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-800 text-slate-100 active:scale-95"
          >
            <RotateCcw size={18} />
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="Kembali ke daftar aktivitas"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-800 text-slate-100 active:scale-95"
          >
            <ArrowLeft size={18} />
          </button>
        </div>
      </div>

      {shareOpen && (
        <ShareCardModal
          activity={activity}
          captureFrame={captureFrame}
          onClose={() => setShareOpen(false)}
          onNotice={onNotice}
        />
      )}
    </section>
  );
}

function formatActivityType(type: ActivityType): string {
  if (type === 'run') return 'Run';
  if (type === 'hike') return 'Hike';
  return 'Ride';
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
    <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/85 px-4 py-2.5 text-slate-100 shadow-2xl backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          <span
            className={`h-2 w-2 rounded-full ${
              playing ? 'animate-pulse bg-orange-400' : 'bg-slate-500'
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
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg bg-slate-800/60 px-1 py-1.5">
      <dt className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-slate-400">
        {icon}
        {label}
      </dt>
      <dd className="text-[11px] font-semibold tabular-nums text-slate-100">{value}</dd>
    </div>
  );
}
