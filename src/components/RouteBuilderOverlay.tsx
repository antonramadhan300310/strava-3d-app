'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bike,
  Download,
  Footprints,
  Info,
  Loader2,
  Mountain,
  MoveRight,
  Navigation,
  Route,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { FloatingButton, type MapViewHandle } from '@/components/MapView';
import RouteSearchBar from '@/components/RouteSearchBar';
import HeatmapControl from '@/components/HeatmapControl';
import RouteTerrainSheet from '@/components/RouteTerrainSheet';
import SavedRouteSheet from '@/components/SavedRouteSheet';
import CuratedRouteList from '@/components/CuratedRouteList';
import type { HeatmapState } from '@/hooks/useHeatmap';
import type { RouteBuilderState } from '@/hooks/useRouteBuilder';
import type { CuratedRoutesState } from '@/hooks/useCuratedRoutes';
import type { ActivityRecord } from '@/lib/activity';
import type { CuratedRoute } from '@/lib/curatedRoutes';
import type { LngLat } from '@/lib/polyline';
import { PROFILES, type ActivityType } from '@/lib/valhalla';
import {
  formatDuration,
  formatPace,
  formatSpeed,
  sportMetricLabels,
  type ElevationSample,
} from '@/lib/routePlannerEngine';

const PROFILE_ICONS: Record<ActivityType, React.ReactNode> = {
  cycling: <Bike size={18} />,
  run: <Footprints size={18} />,
  walking: <Footprints size={18} />,
  hike: <Mountain size={18} />,
};

export type RoutesSubTab = 'mine' | 'recommended';

type Props = {
  builder: RouteBuilderState;
  mapRef: React.RefObject<MapViewHandle | null>;
  heatmap: HeatmapState;
  /** Frames the filtered heatmap extent on the map. */
  onFocusHeatmap: () => void;
  /** Saved routes offered for Follow Route navigation. */
  savedRoutes: ActivityRecord[];
  savedRoutesLoading: boolean;
  onFollowRoute: (activity: ActivityRecord) => void;
  /** `Rute Saya` (planner) or `Rekomendasi` (curated feed). */
  subTab: RoutesSubTab;
  onChangeSubTab: (next: RoutesSubTab) => void;
  curated: CuratedRoutesState;
  isPro: boolean;
  onFollowCuratedRoute: (route: CuratedRoute) => void;
  onSaveCuratedRoute: (route: CuratedRoute) => Promise<void>;
  onRequirePro: () => void;
  /** App-level toast for defensive validation failures. */
  onNotice?: (message: string) => void;
};

export default function RouteBuilderOverlay({
  builder,
  mapRef,
  heatmap,
  onFocusHeatmap,
  savedRoutes,
  savedRoutesLoading,
  onFollowRoute,
  subTab,
  onChangeSubTab,
  curated,
  isPro,
  onFollowCuratedRoute,
  onSaveCuratedRoute,
  onRequirePro,
  onNotice,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showSave, setShowSave] = useState(false);
  const [showTerrain, setShowTerrain] = useState(false);
  const [showRoutes, setShowRoutes] = useState(false);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const hasRoute = Boolean(builder.coordinates && builder.coordinates.length > 1);

  // Losing the route (clear/undo) must also close the terrain sheet.
  useEffect(() => {
    if (!hasRoute) setShowTerrain(false);
  }, [hasRoute]);

  const getBiasCenter = useCallback((): LngLat | null => {
    return mapRef.current?.getCenter() ?? null;
  }, [mapRef]);

  const handleSearchSelect = useCallback(
    (coords: LngLat) => {
      builder.addWaypoint(coords);
      const map = mapRef.current;
      if (map) map.flyTo(coords, Math.max(map.getZoom(), 15), 1000);
    },
    [builder.addWaypoint, mapRef],
  );

  const status = builder.error
    ? builder.error
    : builder.info
      ? builder.info
      : builder.waypoints.length === 0 && !builder.coordinates
        ? 'Ketuk peta untuk menambah titik rute.'
        : builder.loading
          ? 'Menghitung rute…'
          : null;

  const openSave = () => {
    setTitle(builder.suggestedTitle);
    setSaveError(null);
    setShowSave(true);
  };

  const confirmSave = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setSaveError('Judul rute wajib diisi.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await builder.saveRoute(trimmed);
      setShowSave(false);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Gagal menyimpan rute.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        // Android's picker hides `.gpx` behind `application/gpx+xml` because the
        // MIME type is often unregistered; accepting everything and validating
        // the extension/tag in JS keeps the file selectable on every device.
        accept=".gpx,.xml,application/gpx+xml,application/xml,text/xml,application/octet-stream,*/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Clear before reading so picking the same file again still fires.
          event.target.value = '';
          if (file) void builder.importGpx(file);
        }}
      />

      <div className="pointer-events-none absolute inset-x-3 top-[calc(env(safe-area-inset-top)+1rem)] z-20 flex flex-col items-center gap-2">
        <div className="pointer-events-auto w-full max-w-md pr-[4.5rem]">
          <RoutesSubTabs value={subTab} onChange={onChangeSubTab} />
        </div>

        {subTab === 'mine' && (
          <>
            <div className="pointer-events-auto w-[calc(100%-5.5rem)] max-w-md self-start">
              <RouteSearchBar onSelect={handleSearchSelect} getBiasCenter={getBiasCenter} />
            </div>
    
            {builder.metrics && (
              <div className="pointer-events-auto w-[calc(100%-5.5rem)] max-w-md self-start">
                <MetricsCard
                  distanceMeters={builder.metrics.distanceMeters}
                  elevationGainMeters={builder.metrics.elevationGainMeters}
                  durationSeconds={builder.metrics.durationSeconds}
                  speedKmh={builder.metrics.estimate.speedKmh}
                  paceSecondsPerKm={builder.metrics.estimate.paceSecondsPerKm}
                  elevationProfile={builder.metrics.elevationProfile}
                  sportMode={builder.activityType}
                  onInfo={() => setShowTerrain(true)}
                />
              </div>
            )}
    
            <div className="pointer-events-auto w-[calc(100%-5.5rem)] max-w-md self-start">
              <HeatmapControl heatmap={heatmap} onFocus={onFocusHeatmap} />
            </div>
    
            <button
              type="button"
              onClick={() => setShowRoutes(true)}
              className="pointer-events-auto flex w-[calc(100%-5.5rem)] max-w-md items-center justify-between rounded-xl border border-white/10 bg-[#151B1D]/90 px-3 py-2 text-[11px] font-semibold text-slate-100 shadow-lg backdrop-blur transition active:scale-[0.99]"
            >
              <span className="flex items-center gap-1.5">
                <Navigation size={13} className="text-sky-300" />
                Rute Tersimpan
              </span>
              <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] tabular-nums text-sky-200">
                {savedRoutes.length}
              </span>
            </button>
          </>
        )}
      </div>

      {subTab === 'recommended' ? (
        <div className="absolute inset-x-0 top-[calc(env(safe-area-inset-top)+4.6rem)] bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-10 px-3">
          <CuratedRouteList
            state={curated}
            savedRoutes={savedRoutes}
            isPro={isPro}
            onFollow={onFollowCuratedRoute}
            onSave={onSaveCuratedRoute}
            onRequirePro={onRequirePro}
            onNotice={onNotice}
          />
        </div>
      ) : (
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 px-3 pb-[calc(env(safe-area-inset-bottom)+5.5rem)]">
          {status && (
            <p
              className={`mx-auto max-w-md rounded-xl px-3 py-2 text-center text-xs font-medium shadow-lg ${
                builder.error
                  ? 'bg-rose-500/95 text-white'
                  : builder.info
                    ? 'bg-emerald-500/95 text-white'
                    : 'bg-[#151B1D]/90 text-slate-100'
              }`}
              role="status"
            >
              {status}
            </p>
          )}

          <div
            className="mx-auto flex w-full max-w-md items-center gap-1 rounded-2xl border border-white/10 bg-[#151B1D]/90 p-1 shadow-2xl backdrop-blur"
            role="group"
            aria-label="Mode perencanaan rute"
          >
            <RoutingModeButton
              active={builder.routingMode === 'snap'}
              label="Ikuti Jalur"
              onClick={() => builder.changeRoutingMode('snap')}
            >
              <Route size={16} />
            </RoutingModeButton>
            <RoutingModeButton
              active={builder.routingMode === 'offtrail'}
              label="Garis Lurus (Off-Trail)"
              onClick={() => builder.changeRoutingMode('offtrail')}
            >
              <MoveRight size={16} />
            </RoutingModeButton>
          </div>

          <div className="mx-auto flex w-full max-w-md items-center justify-between gap-2 rounded-2xl border border-white/10 bg-[#151B1D]/90 p-2 shadow-2xl backdrop-blur">
            <div className="flex flex-1 gap-1" role="group" aria-label="Profil aktivitas">
              {PROFILES.map((profile) => {
                const selected = builder.activityType === profile.key;
                return (
                  <button
                    key={profile.key}
                    type="button"
                    onClick={() => builder.changeActivityType(profile.key)}
                    aria-pressed={selected}
                    className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-[10px] font-semibold transition active:scale-95 ${
                      selected ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]' : 'text-slate-300 active:bg-[#1E2E16]'
                    }`}
                  >
                    {PROFILE_ICONS[profile.key]}
                    {profile.label}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <FloatingButton
                label="Batalkan titik terakhir"
                onClick={builder.undo}
                disabled={builder.waypoints.length === 0}
              >
                <Undo2 size={18} />
              </FloatingButton>
              <FloatingButton
                label="Hapus semua titik"
                onClick={builder.clear}
                disabled={builder.waypoints.length === 0 && !builder.coordinates}
              >
                <Trash2 size={18} />
              </FloatingButton>
            </div>
          </div>

          <div className="mx-auto flex w-full max-w-md items-center gap-2">
            <ActionButton label="Import GPX" onClick={() => fileInputRef.current?.click()}>
              <Upload size={18} />
            </ActionButton>
            <ActionButton
              label="Export GPX"
              onClick={() => void builder.exportGpx(title.trim() || builder.suggestedTitle)}
              disabled={!hasRoute}
            >
              <Download size={18} />
            </ActionButton>
            <ActionButton label="Save Route" onClick={openSave} disabled={!hasRoute} primary>
              <Save size={18} />
            </ActionButton>
          </div>
        </div>
      )}

      {showSave && (
        <div className="absolute inset-0 z-50 flex items-end justify-center overflow-y-auto bg-[#0D1112]/60 px-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] backdrop-blur-sm sm:items-center sm:pb-4">
          <div className="w-full max-w-sm rounded-2xl bg-[#151B1D] p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Simpan Rute</h2>
              <button
                type="button"
                onClick={() => setShowSave(false)}
                aria-label="Tutup"
                className="rounded-full p-1 text-slate-400 active:bg-[#1E2E16]"
              >
                <X size={18} />
              </button>
            </div>

            <label htmlFor="route-title" className="mb-1 block text-xs text-slate-400">
              Judul rute
            </label>
            <input
              id="route-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
              className="mb-3 w-full rounded-xl border border-[#2A3538] bg-[#1E2E16] px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-[#B9F51E]"
              placeholder="Rute pagi"
            />

            {saveError && <p className="mb-2 text-xs text-rose-400">{saveError}</p>}

            <button
              type="button"
              onClick={() => void confirmSave()}
              disabled={saving}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] py-3 text-sm font-semibold text-[#0D1112] transition active:scale-[0.98] disabled:opacity-60"
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              {saving ? 'Menyimpan ke Cloud ALLMOVA...' : 'Simpan ke Cloud ALLMOVA'}
            </button>
          </div>
        </div>
      )}

      {showTerrain && builder.coordinates && builder.coordinates.length > 1 && (
        <RouteTerrainSheet
          coordinates={builder.coordinates}
          activityType={builder.activityType}
          onClose={() => setShowTerrain(false)}
        />
      )}

      <SavedRouteSheet
        open={showRoutes}
        routes={savedRoutes}
        loading={savedRoutesLoading}
        onSelect={(activity) => {
          setShowRoutes(false);
          onFollowRoute(activity);
        }}
        onClose={() => setShowRoutes(false)}
      />
    </>
  );
}

/** Segmented control that switches the Routes tab between the planner and the feed. */
function RoutesSubTabs({
  value,
  onChange,
}: {
  value: RoutesSubTab;
  onChange: (next: RoutesSubTab) => void;
}) {
  return (
    <div
      className="flex w-full items-center gap-1 rounded-2xl border border-white/10 bg-[#151B1D]/90 p-1 shadow-2xl backdrop-blur"
      role="tablist"
      aria-label="Jenis rute"
    >
      <SubTabButton
        active={value === 'mine'}
        label="Rute Saya"
        onClick={() => onChange('mine')}
      >
        <Route size={14} />
      </SubTabButton>
      <SubTabButton
        active={value === 'recommended'}
        label="Rekomendasi"
        onClick={() => onChange('recommended')}
      >
        <Sparkles size={14} />
      </SubTabButton>
    </div>
  );
}

function SubTabButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-[11px] font-bold transition active:scale-[0.98] ${
        active ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]' : 'text-slate-300 active:bg-[#1E2E16]'
      }`}
    >
      {children}
      {label}
    </button>
  );
}

function MetricsCard({
  distanceMeters,
  elevationGainMeters,
  durationSeconds,
  speedKmh,
  paceSecondsPerKm,
  elevationProfile,
  sportMode,
  onInfo,
}: {
  distanceMeters: number;
  elevationGainMeters: number;
  durationSeconds: number;
  speedKmh: number;
  paceSecondsPerKm: number;
  elevationProfile: ElevationSample[];
  sportMode: ActivityType;
  onInfo: () => void;
}) {
  const labels = sportMetricLabels(sportMode);
  const secondaryValue =
    sportMode === 'cycling' ? formatSpeed(speedKmh) : formatPace(paceSecondsPerKm);

  return (
    <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#151B1D]/90 px-3 py-2.5 text-slate-100 shadow-2xl backdrop-blur">
      <div className="grid grid-cols-4 gap-1">
        <Metric label="Jarak" value={`${(distanceMeters / 1000).toFixed(2)} km`} />
        <Metric label="Tanjakan" value={`+${Math.round(elevationGainMeters)} m`} accent />
        <Metric label={labels.duration} value={formatDuration(durationSeconds)} accent />
        <Metric label={labels.secondary} value={secondaryValue} />
      </div>
      <ElevationSparkline profile={elevationProfile} />
      <button
        type="button"
        onClick={onInfo}
        className="mt-1.5 flex items-center gap-1 rounded-full border border-white/10 bg-[#1E2E16]/80 px-2.5 py-1 text-[10px] font-semibold text-[#B9F51E] transition active:scale-95"
      >
        <Info size={12} />
        Info Medan
      </button>
    </div>
  );
}

/** Active Lime profile line drawn under the sport metrics. */
function ElevationSparkline({ profile }: { profile: ElevationSample[] }) {
  if (profile.length < 2) return null;

  const total = profile[profile.length - 1].distanceMeters;
  if (!(total > 0)) return null;

  const heights = profile.map((sample) => sample.elevationMeters);
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  const range = Math.max(max - min, 1);

  const points = profile
    .map((sample) => {
      const x = (sample.distanceMeters / total) * 100;
      const y = 28 - ((sample.elevationMeters - min) / range) * 24;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <div className="mt-1.5 h-8 w-full">
      <svg
        viewBox="0 0 100 30"
        preserveAspectRatio="none"
        className="h-full w-full"
        aria-hidden="true"
      >
        <polyline
          points={`0,29 ${points} 100,29`}
          fill="rgba(185,245,30,0.12)"
          stroke="none"
        />
        <polyline
          points={points}
          fill="none"
          stroke="#B9F51E"
          strokeWidth={1.6}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

function RoutingModeButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-[10px] font-semibold transition active:scale-[0.98] ${
        active ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]' : 'text-slate-300 active:bg-[#1E2E16]'
      }`}
    >
      {children}
      {label}
    </button>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center">
      <span className="truncate text-[9px] uppercase tracking-wide text-slate-400">{label}</span>
      <span className={`truncate text-[13px] font-semibold ${accent ? 'text-[#B9F51E]' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled = false,
  primary = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-3 text-xs font-semibold shadow-xl backdrop-blur transition active:scale-[0.98] disabled:opacity-40 ${
        primary
          ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]'
          : 'border border-white/15 bg-[#151B1D]/85 text-slate-100'
      }`}
    >
      {children}
      {label}
    </button>
  );
}
