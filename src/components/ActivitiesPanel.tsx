'use client';

import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Bike,
  Download,
  Flame,
  Footprints,
  Loader2,
  MapPin,
  Mountain,
  MountainSnow,
  Play,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { ACTIVITY_FILTERS, type ActivitiesState } from '@/hooks/useActivities';
import { formatActivityDate, type ActivityRecord } from '@/lib/activity';
import { buildGpx, gpxFileName } from '@/lib/gpx';
import { exportGpxFile } from '@/lib/exportGpx';
import { formatDistanceKm, formatDuration } from '@/lib/metrics';
import type { ActivityType } from '@/lib/valhalla';

const ACTIVITY_ICONS: Record<ActivityType, React.ReactNode> = {
  cycling: <Bike size={20} />,
  run: <Footprints size={20} />,
  walking: <Footprints size={20} />,
  hike: <Mountain size={20} />,
};

type Props = {
  activities: ActivitiesState;
  onOpen: (activity: ActivityRecord) => void;
  onNotice: (message: string) => void;
  /** Jumps to the Routes tab with the heatmap already switched on. */
  onOpenHeatmap: () => void;
};

export default function ActivitiesPanel({ activities, onOpen, onNotice, onOpenHeatmap }: Props) {
  const [pendingDelete, setPendingDelete] = useState<ActivityRecord | null>(null);

  // Recorded tracks only: a planned route was never actually travelled.
  const journey = useMemo(() => {
    const recorded = activities.activities.filter((activity) => !activity.isPlannedRoute);
    return {
      count: recorded.length,
      meters: recorded.reduce((total, activity) => total + activity.distanceMeters, 0),
    };
  }, [activities.activities]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    await activities.remove(target.id);
  };

  const exportActivity = async (activity: ActivityRecord) => {
    try {
      await exportGpxFile(gpxFileName(activity.title), buildGpx(activity.title, activity.coordinates));
      onNotice('File GPX siap dibagikan.');
    } catch {
      onNotice('Gagal mengekspor GPX. Coba lagi.');
    }
  };

  return (
    <section className="absolute inset-0 z-10 flex flex-col bg-slate-950 pb-[calc(env(safe-area-inset-bottom)+4.5rem)]">
      <header className="px-4 pb-2 pt-[calc(env(safe-area-inset-top)+1rem)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-100">Aktivitas</h1>
            <p className="text-[11px] text-slate-400">
              {activities.counts.all} tersimpan di Supabase
            </p>
          </div>
          <button
            type="button"
            onClick={() => void activities.refresh()}
            disabled={activities.loading}
            aria-label="Muat ulang daftar aktivitas"
            aria-busy={activities.loading}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-slate-900/85 text-slate-100 shadow-lg backdrop-blur transition active:scale-95 disabled:opacity-50"
          >
            <RefreshCw size={18} className={activities.loading ? 'animate-spin' : undefined} />
          </button>
        </div>

        <div className="mt-3 flex gap-1 rounded-xl bg-slate-900/80 p-1" role="tablist" aria-label="Filter aktivitas">
          {ACTIVITY_FILTERS.map(({ key, label }) => (
            <FilterTab
              key={key}
              label={label}
              count={activities.counts[key]}
              selected={activities.filter === key}
              onClick={() => activities.setFilter(key)}
            />
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        <HeatmapShortcutCard
          count={journey.count}
          meters={journey.meters}
          onOpen={onOpenHeatmap}
        />

        {activities.error && (
          <div className="mb-3 flex items-start gap-2 rounded-xl bg-rose-500/95 px-3 py-2 text-xs font-medium text-white shadow-lg">
            <span className="flex-1">{activities.error}</span>
            <button type="button" onClick={activities.dismissError} aria-label="Tutup pesan galat">
              <X size={14} />
            </button>
          </div>
        )}

        {activities.loading && activities.activities.length === 0 && (
          <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin" />
            Memuat aktivitas…
          </p>
        )}

        {!activities.loading && activities.visible.length === 0 && !activities.error && (
          <div className="flex flex-col items-center gap-2 py-14 text-center">
            <MountainSnow size={32} className="text-slate-600" />
            <p className="text-sm font-medium text-slate-300">Belum ada aktivitas</p>
            <p className="max-w-[16rem] text-xs text-slate-500">
              {activities.filter === 'planned'
                ? 'Simpan rute dari tab Routes untuk melihatnya di sini.'
                : activities.filter === 'recorded'
                  ? 'Rekam aktivitas dari tab Record untuk melihatnya di sini.'
                  : 'Rekam aktivitas atau simpan rute rencana untuk memulai.'}
            </p>
          </div>
        )}

        <ul className="flex flex-col gap-2.5">
          {activities.visible.map((activity) => (
            <ActivityCard
              key={String(activity.id)}
              activity={activity}
              deleting={activities.deletingId === activity.id}
              onOpen={() => onOpen(activity)}
              onExport={() => void exportActivity(activity)}
              onDelete={() => setPendingDelete(activity)}
            />
          ))}
        </ul>
      </div>

      {pendingDelete && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-6 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-4 shadow-2xl">
            <h2 className="mb-1 text-sm font-semibold text-slate-100">Hapus aktivitas?</h2>
            <p className="mb-4 text-xs text-slate-400">
              &ldquo;{pendingDelete.title}&rdquo; akan dihapus permanen dari Supabase. Tindakan ini
              tidak dapat dibatalkan.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm font-semibold text-slate-200 active:scale-[0.98]"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-rose-500 py-2.5 text-sm font-semibold text-white active:scale-[0.98]"
              >
                <Trash2 size={16} />
                Hapus
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function HeatmapShortcutCard({
  count,
  meters,
  onOpen,
}: {
  count: number;
  meters: number;
  onOpen: () => void;
}) {
  return (
    <section className="mb-3 overflow-hidden rounded-2xl border border-orange-500/25 bg-gradient-to-br from-slate-900 via-slate-900 to-orange-950/50 p-3 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-500/20 text-orange-400">
            <Flame size={18} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-100">Heatmap Jelajah</p>
            <p className="text-[11px] text-slate-400">{count} aktivitas terekam</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold leading-none tabular-nums text-orange-400">
            {(meters / 1000).toFixed(1)}
          </p>
          <p className="text-[9px] uppercase tracking-wide text-slate-400">km jelajah</p>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-orange-500 py-2 text-xs font-semibold text-white shadow transition active:scale-[0.98]"
      >
        <Flame size={14} />
        Buka Heatmap Jelajah
        <ArrowRight size={14} />
      </button>
    </section>
  );
}

function FilterTab({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1 rounded-lg py-2 text-[11px] font-semibold transition active:scale-95 ${
        selected ? 'bg-orange-500 text-white' : 'text-slate-300 active:bg-slate-800'
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 text-[9px] tabular-nums ${
          selected ? 'bg-white/25 text-white' : 'bg-slate-800 text-slate-400'
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function ActivityCard({
  activity,
  deleting,
  onOpen,
  onExport,
  onDelete,
}: {
  activity: ActivityRecord;
  deleting: boolean;
  onOpen: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="rounded-2xl border border-white/10 bg-slate-900/80 shadow-lg">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-3 p-3 text-left active:bg-slate-800/60"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-500/15 text-orange-400">
          {ACTIVITY_ICONS[activity.activityType]}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-slate-100">{activity.title}</span>
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                activity.isPlannedRoute
                  ? 'bg-sky-500/15 text-sky-300'
                  : 'bg-emerald-500/15 text-emerald-300'
              }`}
            >
              {activity.isPlannedRoute ? 'Rencana' : 'Rekaman'}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-400">
            <MapPin size={11} />
            {formatActivityDate(activity.createdAt)}
          </span>

          <span className="mt-2 grid grid-cols-3 gap-1">
            <CardMetric label="Jarak" value={`${formatDistanceKm(activity.distanceMeters)} km`} />
            <CardMetric label="Elevasi" value={`${Math.round(activity.elevationGain)} m`} />
            <CardMetric label="Durasi" value={formatDuration(activity.durationSeconds)} />
          </span>
        </span>
      </button>

      <div className="flex items-center gap-1 border-t border-white/10 px-2 py-1.5">
        <CardAction label="3D Flyover" onClick={onOpen}>
          <Play size={14} />
        </CardAction>
        <CardAction label="Export GPX" onClick={onExport}>
          <Download size={14} />
        </CardAction>
        <CardAction label={deleting ? 'Menghapus…' : 'Hapus'} onClick={onDelete} danger busy={deleting}>
          {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        </CardAction>
      </div>
    </li>
  );
}

function CardMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col rounded-lg bg-slate-800/60 px-1 py-1 text-center">
      <span className="text-[9px] uppercase tracking-wide text-slate-400">{label}</span>
      <span className="text-[11px] font-semibold tabular-nums text-slate-100">{value}</span>
    </span>
  );
}

function CardAction({
  label,
  onClick,
  danger = false,
  busy = false,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`flex flex-1 items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-semibold transition active:scale-95 disabled:opacity-50 ${
        danger ? 'text-rose-400 active:bg-rose-500/10' : 'text-slate-200 active:bg-slate-800'
      }`}
    >
      {children}
      {label}
    </button>
  );
}
