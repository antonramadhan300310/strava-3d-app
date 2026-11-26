'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  Bike,
  Download,
  Flame,
  Footprints,
  List,
  Loader2,
  Lock,
  MapPin,
  Mountain,
  MountainSnow,
  Navigation,
  Play,
  RefreshCw,
  Share2,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { ACTIVITY_FILTERS, type ActivitiesState } from '@/hooks/useActivities';
import { formatActivityDate, type ActivityRecord } from '@/lib/activity';
import { buildGpx, gpxFileName } from '@/lib/gpx';
import { exportGpxFile, gpxExportMessage, shareGpxFile } from '@/lib/exportGpx';
import { formatDistanceKm, formatDuration } from '@/lib/metrics';
import { getPRHolderIds } from '@/lib/activityAnalytics';
import {
  deletePersonalGoal,
  loadPersonalGoals,
  savePersonalGoal,
  type PersonalGoal,
} from '@/lib/trainingLog';
import type { ActivityType } from '@/lib/valhalla';
import PersonalGoalsStrip from './PersonalGoalsStrip';
import ProPaywallSheet from './ProPaywallSheet';
import AllmovaLogo from './AllmovaLogo';
import TrainingLogView from './TrainingLogView';
import AthleteProfileSheet from './AthleteProfileSheet';

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
  /** Loads a saved route as the Follow Route guide and opens the Record tab. */
  onFollowRoute: (activity: ActivityRecord) => void;
};

type ViewMode = 'history' | 'log';

const VIEW_MODES: { key: ViewMode; label: string; icon: React.ReactNode }[] = [
  { key: 'history', label: 'Riwayat', icon: <List size={13} /> },
  { key: 'log', label: 'Training Log', icon: <BarChart3 size={13} /> },
];

export default function ActivitiesPanel({
  activities,
  onOpen,
  onNotice,
  onOpenHeatmap,
  onFollowRoute,
}: Props) {
  const { isPro, updateProfile } = useAuth();
  const [pendingDelete, setPendingDelete] = useState<ActivityRecord | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('history');
  const [goals, setGoals] = useState<PersonalGoal[]>([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [paywallReason, setPaywallReason] = useState<string | undefined>(undefined);

  const requirePro = (reason: string) => {
    setPaywallReason(reason);
    setPaywallOpen(true);
  };

  // localStorage is client-only: loading in an effect keeps the static export
  // and the first client render identical.
  useEffect(() => {
    setGoals(loadPersonalGoals());
  }, []);

  useEffect(() => {
    if (!isPro && viewMode === 'log') setViewMode('history');
  }, [isPro, viewMode]);

  const handleSaveGoal = (goal: PersonalGoal) => {
    const next = savePersonalGoal(goal);
    setGoals(next);
    void updateProfile({ personal_goals: next }).catch(() => {
      // The local copy stays authoritative when the cloud sync fails.
    });
    onNotice('Target pribadi disimpan.');
  };

  const handleDeleteGoal = (id: string) => {
    const next = deletePersonalGoal(id);
    setGoals(next);
    void updateProfile({ personal_goals: next }).catch(() => {
      // The local copy stays authoritative when the cloud sync fails.
    });
    onNotice('Target pribadi dihapus.');
  };

  // Recorded tracks only: a planned route was never actually travelled.
  const journey = useMemo(() => {
    const recorded = activities.activities.filter((activity) => !activity.isPlannedRoute);
    return {
      count: recorded.length,
      meters: recorded.reduce((total, activity) => total + activity.distanceMeters, 0),
    };
  }, [activities.activities]);

  const prHolderIds = useMemo(
    () => getPRHolderIds(activities.activities),
    [activities.activities],
  );

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    await activities.remove(target.id);
  };

  const exportActivity = async (activity: ActivityRecord) => {
    try {
      const result = await exportGpxFile(
        gpxFileName(activity.title),
        buildGpx(activity.title, activity.coordinates),
      );
      onNotice(gpxExportMessage(result));
    } catch (cause) {
      onNotice(
        cause instanceof Error
          ? `Gagal mengekspor GPX: ${cause.message}`
          : 'Gagal mengekspor GPX. Coba lagi.',
      );
    }
  };

  const shareActivity = async (activity: ActivityRecord) => {
    try {
      const result = await shareGpxFile(
        gpxFileName(activity.title),
        buildGpx(activity.title, activity.coordinates),
      );
      onNotice(result ? gpxExportMessage(result) : 'GPX siap dibagikan.');
    } catch (cause) {
      onNotice(
        cause instanceof Error ? `Gagal membagikan GPX: ${cause.message}` : 'Gagal membagikan GPX.',
      );
    }
  };

  return (
    <section className="absolute inset-0 z-10 flex flex-col bg-[#0D1112] pb-[calc(env(safe-area-inset-bottom)+4.5rem)]">
      <header className="px-4 pb-2 pt-[calc(env(safe-area-inset-top)+1rem)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <AllmovaLogo variant="compact" className="h-6 w-auto" />
            <h1 className="mt-1 text-lg font-semibold text-slate-100">Aktivitas</h1>
            <p className="text-[11px] text-slate-400">
              {activities.counts.all} tersimpan di Cloud ALLMOVA
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void activities.refresh()}
              disabled={activities.loading}
              aria-label="Muat ulang daftar aktivitas"
              aria-busy={activities.loading}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-[#151B1D]/85 text-slate-100 shadow-lg backdrop-blur transition active:scale-95 disabled:opacity-50"
            >
              <RefreshCw size={18} className={activities.loading ? 'animate-spin' : undefined} />
            </button>
            <button
              type="button"
              onClick={() => setProfileOpen(true)}
              aria-label="Buka profil atlet"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-[#B9F51E]/40 bg-[#B9F51E]/15 text-[#B9F51E] shadow-lg backdrop-blur transition active:scale-95"
            >
              <UserRound size={19} />
            </button>
          </div>
        </div>

        <div
          className="mt-3 flex gap-1 rounded-xl bg-[#151B1D]/80 p-1"
          role="tablist"
          aria-label="Mode daftar aktivitas"
        >
          {VIEW_MODES.map(({ key, label, icon }) => {
            const locked = key === 'log' && !isPro;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={viewMode === key}
                onClick={() =>
                  locked ? requirePro('Training Log khusus Pro.') : setViewMode(key)
                }
                className={`flex flex-1 items-center justify-center gap-1 rounded-lg py-2 text-[11px] font-semibold transition active:scale-95 ${
                  viewMode === key
                    ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]'
                    : 'text-slate-300 active:bg-[#1E2E16]'
                }`}
              >
                {icon}
                {label}
                {locked && (
                  <span className="rounded-full bg-[#B9F51E] px-1 py-0.5 text-[8px] font-bold text-[#0D1112]">
                    👑 PRO
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {viewMode === 'history' && (
          <div className="mt-2 flex gap-1 rounded-xl bg-[#151B1D]/80 p-1" role="tablist" aria-label="Filter aktivitas">
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
        )}
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        <HeatmapShortcutCard
          count={journey.count}
          meters={journey.meters}
          locked={!isPro}
          onOpen={
            isPro
              ? onOpenHeatmap
              : () => requirePro('Heatmap Personal Vektor khusus Pro.')
          }
        />

        {isPro ? (
          <PersonalGoalsStrip
            goals={goals}
            activities={activities.activities}
            onSave={handleSaveGoal}
            onDelete={handleDeleteGoal}
          />
        ) : (
          <LockedProCard
            title="Target Pribadi"
            description="Strip target mingguan, bulanan, dan tahunan tanpa batas."
            onOpen={() => requirePro('Target Pribadi khusus Pro.')}
          />
        )}

        {activities.error && (
          <div className="mb-3 flex items-start gap-2 rounded-xl bg-rose-500/95 px-3 py-2 text-xs font-medium text-white shadow-lg">
            <span className="flex-1">{activities.error}</span>
            <button type="button" onClick={activities.dismissError} aria-label="Tutup pesan galat">
              <X size={14} />
            </button>
          </div>
        )}

        {viewMode === 'log' ? (
          activities.loading && activities.activities.length === 0 ? (
            <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
              <Loader2 size={16} className="animate-spin" />
              Memuat aktivitas…
            </p>
          ) : (
            <TrainingLogView
              activities={activities.activities}
              goals={goals}
              onOpen={onOpen}
            />
          )
        ) : (
          <>
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
                  hasPR={isPro && prHolderIds.has(String(activity.id))}
                  deleting={activities.deletingId === activity.id}
                  onOpen={() => onOpen(activity)}
                  onFlyover={() =>
                    isPro
                      ? onOpen(activity)
                      : requirePro('3D Flyover khusus Pro.')
                  }
                  onExport={() =>
                    isPro ? void exportActivity(activity) : requirePro('Export GPX khusus Pro.')
                  }
                  onShare={() =>
                    isPro ? void shareActivity(activity) : requirePro('Bagikan GPX khusus Pro.')
                  }
                  onDelete={() => setPendingDelete(activity)}
                  onFollowRoute={
                    activity.isPlannedRoute ? () => onFollowRoute(activity) : undefined
                  }
                />
              ))}
            </ul>
          </>
        )}
      </div>

      {pendingDelete && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#0D1112]/75 px-6 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#151B1D] p-4 shadow-2xl">
            <h2 className="mb-1 text-sm font-semibold text-slate-100">Hapus aktivitas?</h2>
            <p className="mb-4 text-xs text-slate-400">
              &ldquo;{pendingDelete.title}&rdquo; akan dihapus permanen dari Cloud ALLMOVA. Tindakan ini
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

      {profileOpen && (
        <AthleteProfileSheet
          open={profileOpen}
          activities={activities.activities}
          onClose={() => setProfileOpen(false)}
          onSaved={() => onNotice('Profil berhasil disimpan')}
        />
      )}

      <ProPaywallSheet
        open={paywallOpen}
        reason={paywallReason}
        onClose={() => setPaywallOpen(false)}
      />
    </section>
  );
}

function HeatmapShortcutCard({
  count,
  meters,
  locked,
  onOpen,
}: {
  count: number;
  meters: number;
  locked?: boolean;
  onOpen: () => void;
}) {
  return (
    <section className="mb-3 overflow-hidden rounded-2xl border border-[#B9F51E]/25 bg-gradient-to-br from-[#151B1D] via-[#151B1D] to-[#1E2E16]/50 p-3 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#B9F51E]/20 text-[#B9F51E]">
            <Flame size={18} />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">
              Heatmap Jelajah
              {locked && (
                <span className="rounded-full border border-[#B9F51E]/40 bg-[#B9F51E] px-1.5 py-0.5 text-[9px] font-bold text-[#0D1112]">
                  👑 PRO
                </span>
              )}
            </p>
            <p className="text-[11px] text-slate-400">{count} aktivitas terekam</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold leading-none tabular-nums text-[#B9F51E]">
            {(meters / 1000).toFixed(1)}
          </p>
          <p className="text-[9px] uppercase tracking-wide text-slate-400">km jelajah</p>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] py-2 text-xs font-semibold text-[#0D1112] shadow transition active:scale-[0.98]"
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
        selected ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]' : 'text-slate-300 active:bg-[#1E2E16]'
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 text-[9px] tabular-nums ${
          selected ? 'bg-white/25 text-white' : 'bg-[#1E2E16] text-slate-400'
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function ActivityCard({
  activity,
  hasPR,
  deleting,
  onOpen,
  onFlyover,
  onExport,
  onShare,
  onDelete,
  onFollowRoute,
}: {
  activity: ActivityRecord;
  hasPR: boolean;
  deleting: boolean;
  onOpen: () => void;
  onFlyover: () => void;
  onExport: () => void;
  onShare: () => void;
  onDelete: () => void;
  onFollowRoute?: () => void;
}) {
  return (
    <li className="rounded-2xl border border-white/10 bg-[#151B1D]/80 shadow-lg">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-3 p-3 text-left active:bg-[#1E2E16]/60"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#B9F51E]/15 text-[#B9F51E]">
          {ACTIVITY_ICONS[activity.activityType]}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-slate-100">{activity.title}</span>
            {hasPR && (
              <span className="shrink-0 rounded-full border border-amber-300/50 bg-gradient-to-r from-amber-400/25 to-yellow-300/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">
                🏆 PR
              </span>
            )}
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
        <CardAction label="3D Flyover" onClick={onFlyover}>
          <Play size={14} />
        </CardAction>
        <CardAction label="Export GPX" onClick={onExport}>
          <Download size={14} />
        </CardAction>
        <button
          type="button"
          onClick={onShare}
          aria-label="Bagikan GPX"
          title="Bagikan GPX"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-200 transition active:scale-95 active:bg-[#1E2E16]"
        >
          <Share2 size={14} />
        </button>
        {onFollowRoute && (
          <CardAction label="Ikuti Rute" onClick={onFollowRoute}>
            <Navigation size={14} />
          </CardAction>
        )}
        <CardAction label={deleting ? 'Menghapus…' : 'Hapus'} onClick={onDelete} danger busy={deleting}>
          {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        </CardAction>
      </div>
    </li>
  );
}

function LockedProCard({
  title,
  description,
  onOpen,
}: {
  title: string;
  description: string;
  onOpen: () => void;
}) {
  return (
    <section className="mb-3 rounded-2xl border border-amber-300/25 bg-gradient-to-br from-[#151B1D] via-[#151B1D] to-amber-950/30 p-3 shadow-xl">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">
        <Lock size={14} className="text-amber-300" />
        {title}
        <span className="rounded-full border border-[#B9F51E]/40 bg-[#B9F51E] px-1.5 py-0.5 text-[9px] font-bold text-[#0D1112]">
          👑 PRO
        </span>
      </p>
      <p className="mt-0.5 text-[11px] text-slate-400">{description}</p>
      <button
        type="button"
        onClick={onOpen}
        className="mt-2 w-full rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] py-2 text-xs font-semibold text-[#0D1112] shadow transition active:scale-[0.98]"
      >
        Upgrade ke Pro
      </button>
    </section>
  );
}

function CardMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col rounded-lg bg-[#1E2E16]/60 px-1 py-1 text-center">
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
        danger ? 'text-rose-400 active:bg-rose-500/10' : 'text-slate-200 active:bg-[#1E2E16]'
      }`}
    >
      {children}
      {label}
    </button>
  );
}
