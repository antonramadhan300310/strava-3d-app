'use client';

import { Check, Loader2, Navigation, Route as RouteIcon, X } from 'lucide-react';
import type { ActivityRecord } from '@/lib/activity';
import { formatActivityDate } from '@/lib/activity';
import { formatDistanceKm, formatDuration } from '@/lib/metrics';
import type { ActivityType } from '@/lib/valhalla';

const ACTIVITY_LABELS: Record<ActivityType, string> = {
  cycling: 'Cycling',
  run: 'Run',
  walking: 'Walking',
  hike: 'Hike',
};

type Props = {
  open: boolean;
  routes: ActivityRecord[];
  loading?: boolean;
  /** Route currently loaded as the guide, highlighted in the list. */
  activeId?: string | number | null;
  onSelect: (activity: ActivityRecord) => void;
  onClose: () => void;
};

/** Bottom sheet listing the account's saved routes, used by Routes and Record. */
export default function SavedRouteSheet({
  open,
  routes,
  loading = false,
  activeId = null,
  onSelect,
  onClose,
}: Props) {
  if (!open) return null;

  return (
    <div className="absolute inset-0 z-50 flex items-end justify-center bg-[#0D1112]/60 px-3 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] backdrop-blur-sm">
      <div className="flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#151B1D] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Pilih Rute Tersimpan</h2>
            <p className="text-[11px] text-slate-400">Rute tampil sebagai panduan di peta.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup daftar rute"
            className="rounded-full p-1.5 text-slate-400 active:bg-[#1E2E16]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {loading && routes.length === 0 && (
            <p className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
              <Loader2 size={16} className="animate-spin" />
              Memuat rute…
            </p>
          )}

          {!loading && routes.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <RouteIcon size={28} className="text-slate-600" />
              <p className="text-sm font-medium text-slate-300">Belum ada rute tersimpan</p>
              <p className="max-w-[16rem] text-xs text-slate-500">
                Simpan rute dari tab Routes untuk memandu perekaman di sini.
              </p>
            </div>
          )}

          <ul className="flex flex-col gap-2">
            {routes.map((activity) => {
              const selected = activeId !== null && activity.id === activeId;
              return (
                <li key={String(activity.id)}>
                  <button
                    type="button"
                    onClick={() => onSelect(activity)}
                    className={`flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition active:scale-[0.99] ${
                      selected
                        ? 'border-sky-400/50 bg-sky-500/10'
                        : 'border-white/10 bg-[#1E2E16]/60'
                    }`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-300">
                      <Navigation size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-slate-100">
                        {activity.title}
                      </span>
                      <span className="block truncate text-[10px] text-slate-400">
                        {formatDistanceKm(activity.distanceMeters)} km •{' '}
                        {formatDuration(activity.durationSeconds)} •{' '}
                        {ACTIVITY_LABELS[activity.activityType]} •{' '}
                        {formatActivityDate(activity.createdAt)}
                      </span>
                    </span>
                    <span
                      className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold ${
                        selected
                          ? 'bg-sky-400 text-[#0D1112]'
                          : 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]'
                      }`}
                    >
                      {selected ? <Check size={12} /> : <Navigation size={12} />}
                      {selected ? 'Aktif' : 'Ikuti Rute'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
