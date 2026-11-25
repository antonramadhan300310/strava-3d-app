'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  Bike,
  Check,
  Crown,
  Footprints,
  Loader2,
  MapPin,
  Mountain,
  Navigation,
  RefreshCw,
  Route as RouteIcon,
  Save,
  Search,
  X,
} from 'lucide-react';
import type { ActivityRecord } from '@/lib/activity';
import {
  CURATED_SPORT_FILTERS,
  DIFFICULTY_LABELS,
  SPORT_LABELS,
  curatedRouteKey,
  formatRouteDistance,
  isCuratedRouteSaved,
  miniRoutePolyline,
  type CuratedDifficulty,
  type CuratedRoute,
} from '@/lib/curatedRoutes';
import type { CuratedRoutesState } from '@/hooks/useCuratedRoutes';
import type { ActivityType } from '@/lib/valhalla';

const SPORT_ICONS: Record<ActivityType, React.ReactNode> = {
  cycling: <Bike size={11} />,
  run: <Footprints size={11} />,
  walking: <Footprints size={11} />,
  hike: <Mountain size={11} />,
};

const SPORT_STYLES: Record<ActivityType, string> = {
  cycling: 'bg-sky-500/15 text-sky-300',
  run: 'bg-orange-500/15 text-orange-300',
  walking: 'bg-emerald-500/15 text-emerald-300',
  hike: 'bg-amber-500/15 text-amber-300',
};

const DIFFICULTY_STYLES: Record<CuratedDifficulty, string> = {
  easy: 'bg-emerald-500/15 text-emerald-300',
  medium: 'bg-amber-500/15 text-amber-300',
  hard: 'bg-rose-500/15 text-rose-300',
};

type Props = {
  state: CuratedRoutesState;
  savedRoutes: ActivityRecord[];
  isPro: boolean;
  onFollow: (route: CuratedRoute) => void;
  onSave: (route: CuratedRoute) => Promise<void>;
  onRequirePro: () => void;
};

/** Rekomendasi sub-tab: curated routes from `curated_routes`, ready to follow. */
export default function CuratedRouteList({
  state,
  savedRoutes,
  isPro,
  onFollow,
  onSave,
  onRequirePro,
}: Props) {
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isSaved = (route: CuratedRoute) =>
    savedIds.includes(curatedRouteKey(route)) || isCuratedRouteSaved(route, savedRoutes);

  const handleFollow = (route: CuratedRoute) => {
    if (route.isPro && !isPro) {
      onRequirePro();
      return;
    }
    onFollow(route);
  };

  const handleSave = async (route: CuratedRoute) => {
    const key = curatedRouteKey(route);
    if (savingId !== null || isSaved(route)) return;
    setSavingId(key);
    setSaveError(null);
    try {
      await onSave(route);
      setSavedIds((current) => [...current, key]);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Gagal menyimpan rute. Coba lagi.');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col overflow-hidden">
      <div className="shrink-0 px-1 pb-1.5">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            value={state.query}
            onChange={(event) => state.setQuery(event.target.value)}
            placeholder="Cari nama rute atau kota…"
            aria-label="Cari rute rekomendasi"
            className="w-full rounded-xl border border-white/10 bg-[#151B1D]/95 py-2.5 pl-9 pr-9 text-xs text-slate-100 placeholder:text-slate-500 outline-none backdrop-blur focus:border-[#B9F51E]"
          />
          {state.query.length > 0 && (
            <button
              type="button"
              onClick={() => state.setQuery('')}
              aria-label="Hapus pencarian"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 active:bg-[#1E2E16]"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div
          className="mt-2 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="group"
          aria-label="Filter jenis olahraga"
        >
          {CURATED_SPORT_FILTERS.map((chip) => {
            const active = state.sport === chip.key;
            const count = state.counts[chip.key];
            return (
              <button
                key={chip.key}
                type="button"
                onClick={() => state.setSport(chip.key)}
                aria-pressed={active}
                className={`flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition active:scale-95 ${
                  active
                    ? 'border-[#B9F51E] bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]'
                    : 'border-white/10 bg-[#151B1D]/90 text-slate-300'
                }`}
              >
                {chip.label}
                {count > 0 && (
                  <span
                    className={`tabular-nums text-[9px] ${
                      active ? 'text-[#0D1112]/70' : 'text-slate-500'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {saveError && (
          <p className="mb-2 rounded-xl bg-rose-500/15 px-3 py-2 text-[11px] font-medium text-rose-300">
            {saveError}
          </p>
        )}

        {state.loading && state.routes.length === 0 && <SkeletonList />}

        {!state.loading && state.error && (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-white/10 bg-[#151B1D]/95 px-4 py-8 text-center">
            <AlertTriangle size={26} className="text-amber-400" />
            <p className="text-sm font-semibold text-slate-100">Rekomendasi belum bisa dimuat</p>
            <p className="max-w-[17rem] text-[11px] text-slate-400">{state.error}</p>
            <button
              type="button"
              onClick={() => void state.refresh()}
              className="mt-1 flex items-center gap-1.5 rounded-full bg-[#B9F51E] hover:bg-[#A5E012] px-3 py-1.5 text-[11px] font-bold text-[#0D1112] active:scale-95"
            >
              <RefreshCw size={12} />
              Coba Lagi
            </button>
          </div>
        )}

        {!state.loading && !state.error && state.filtered.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-white/10 bg-[#151B1D]/95 px-4 py-8 text-center">
            <RouteIcon size={26} className="text-slate-600" />
            <p className="text-sm font-semibold text-slate-100">Belum ada rute di kategori ini</p>
            <p className="max-w-[17rem] text-[11px] text-slate-400">
              {state.query.trim().length > 0
                ? 'Coba kata kunci lain atau pilih jenis olahraga berbeda.'
                : 'Rekomendasi baru akan muncul di sini. Coba lagi nanti.'}
            </p>
            {state.query.trim().length > 0 && (
              <button
                type="button"
                onClick={() => state.setQuery('')}
                className="mt-1 rounded-full border border-white/15 px-3 py-1.5 text-[11px] font-semibold text-slate-200 active:bg-[#1E2E16]"
              >
                Hapus pencarian
              </button>
            )}
          </div>
        )}

        <ul className="flex flex-col gap-2">
          {state.filtered.map((route) => {
            const key = curatedRouteKey(route);
            return (
              <li key={key}>
                <CuratedRouteCard
                  route={route}
                  saved={isSaved(route)}
                  saving={savingId === key}
                  locked={route.isPro && !isPro}
                  onFollow={() => handleFollow(route)}
                  onSave={() => void handleSave(route)}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function CuratedRouteCard({
  route,
  saved,
  saving,
  locked,
  onFollow,
  onSave,
}: {
  route: CuratedRoute;
  saved: boolean;
  saving: boolean;
  locked: boolean;
  onFollow: () => void;
  onSave: () => void;
}) {
  const polyline = miniRoutePolyline(route.coordinates);
  const sportLabel = SPORT_LABELS[route.sportType];

  return (
    <article className="rounded-2xl border border-white/10 bg-[#151B1D]/95 p-3 shadow-lg backdrop-blur">
      <div className="flex gap-2.5">
        <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-[#0D1112]">
          <svg
            viewBox="0 0 100 56"
            preserveAspectRatio="none"
            className="h-full w-full"
            aria-hidden="true"
          >
            <polyline
              points={polyline}
              fill="none"
              stroke="#B9F51E"
              strokeWidth={1.8}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1.5">
            <h3 className="min-w-0 truncate text-sm font-semibold text-slate-100">
              {route.name}
            </h3>
            {route.isPro && (
              <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-[#B9F51E] hover:bg-[#A5E012] px-1.5 py-0.5 text-[9px] font-bold text-[#0D1112]">
                <Crown size={9} />
                PRO
              </span>
            )}
          </div>

          {route.city && (
            <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-slate-400">
              <MapPin size={10} className="shrink-0" />
              {route.city}
            </p>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span
              className={`flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-bold ${SPORT_STYLES[route.sportType]}`}
            >
              {SPORT_ICONS[route.sportType]}
              {sportLabel}
            </span>
            <span className="whitespace-nowrap rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-slate-200">
              {formatRouteDistance(route.distanceMeters)}
            </span>
            <span className="whitespace-nowrap rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-slate-200">
              {`+${Math.round(route.elevationGain)} m`}
            </span>
            <span
              className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-bold ${DIFFICULTY_STYLES[route.difficulty]}`}
            >
              {DIFFICULTY_LABELS[route.difficulty]}
            </span>
          </div>
        </div>
      </div>

      {route.description && (
        <p className="mt-2 line-clamp-2 text-[11px] leading-snug text-slate-400">
          {route.description}
        </p>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onFollow}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] py-2.5 text-[11px] font-bold text-[#0D1112] shadow-lg transition active:scale-[0.98]"
        >
          {locked ? <Crown size={13} /> : <Navigation size={13} />}
          Ikuti Rute
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saved || saving}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border py-2.5 text-[11px] font-semibold transition active:scale-[0.98] disabled:opacity-70 ${
            saved
              ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
              : 'border-white/15 bg-[#1E2E16]/70 text-slate-100'
          }`}
        >
          {saving ? (
            <Loader2 size={13} className="animate-spin" />
          ) : saved ? (
            <Check size={13} />
          ) : (
            <Save size={13} />
          )}
          {saving ? 'Menyimpan…' : saved ? 'Tersimpan' : 'Simpan'}
        </button>
      </div>
    </article>
  );
}

function SkeletonList() {
  return (
    <ul className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <li
          key={index}
          className="animate-pulse rounded-2xl border border-white/10 bg-[#151B1D]/95 p-3"
        >
          <div className="flex gap-2.5">
            <div className="h-16 w-24 shrink-0 rounded-xl bg-white/5" />
            <div className="flex-1 space-y-2 py-1">
              <div className="h-3 w-2/3 rounded bg-white/10" />
              <div className="h-2.5 w-1/3 rounded bg-white/5" />
              <div className="h-3 w-4/5 rounded bg-white/5" />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <div className="h-8 flex-1 rounded-xl bg-white/5" />
            <div className="h-8 flex-1 rounded-xl bg-white/5" />
          </div>
        </li>
      ))}
    </ul>
  );
}
