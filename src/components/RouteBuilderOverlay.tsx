'use client';

import { useRef, useState } from 'react';
import {
  Bike,
  Download,
  Footprints,
  Loader2,
  Mountain,
  Save,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { FloatingButton } from '@/components/MapView';
import type { RouteBuilderState } from '@/hooks/useRouteBuilder';
import { PROFILES, type ActivityType } from '@/lib/valhalla';

const PROFILE_ICONS: Record<ActivityType, React.ReactNode> = {
  ride: <Bike size={18} />,
  run: <Footprints size={18} />,
  hike: <Mountain size={18} />,
};

type Props = {
  builder: RouteBuilderState;
};

export default function RouteBuilderOverlay({ builder }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showSave, setShowSave] = useState(false);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const hasRoute = Boolean(builder.coordinates && builder.coordinates.length > 1);
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
        accept=".gpx,application/gpx+xml"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void builder.importGpx(file);
          event.target.value = '';
        }}
      />

      {builder.metrics && (
        <div className="pointer-events-none absolute inset-x-3 top-[calc(env(safe-area-inset-top)+1rem)] flex justify-center">
          <MetricsCard
            distanceMeters={builder.metrics.distanceMeters}
            elevationGainMeters={builder.metrics.elevationGainMeters}
            durationSeconds={builder.metrics.durationSeconds}
          />
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 px-3 pb-[calc(env(safe-area-inset-bottom)+5.5rem)]">
        {status && (
          <p
            className={`mx-auto max-w-md rounded-xl px-3 py-2 text-center text-xs font-medium shadow-lg ${
              builder.error
                ? 'bg-rose-500/95 text-white'
                : builder.info
                  ? 'bg-emerald-500/95 text-white'
                  : 'bg-slate-900/90 text-slate-100'
            }`}
            role="status"
          >
            {status}
          </p>
        )}

        <div className="mx-auto flex w-full max-w-md items-center justify-between gap-2 rounded-2xl border border-white/10 bg-slate-900/90 p-2 shadow-2xl backdrop-blur">
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
                    selected ? 'bg-orange-500 text-white' : 'text-slate-300 active:bg-slate-800'
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

      {showSave && (
        <div className="absolute inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-950/60 px-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] backdrop-blur-sm sm:items-center sm:pb-4">
          <div className="w-full max-w-sm rounded-2xl bg-slate-900 p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Simpan Rute</h2>
              <button
                type="button"
                onClick={() => setShowSave(false)}
                aria-label="Tutup"
                className="rounded-full p-1 text-slate-400 active:bg-slate-800"
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
              className="mb-3 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-orange-500"
              placeholder="Rute pagi"
            />

            {saveError && <p className="mb-2 text-xs text-rose-400">{saveError}</p>}

            <button
              type="button"
              onClick={() => void confirmSave()}
              disabled={saving}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-orange-500 py-3 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-60"
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              {saving ? 'Menyimpan…' : 'Simpan ke Supabase'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function MetricsCard({
  distanceMeters,
  elevationGainMeters,
  durationSeconds,
}: {
  distanceMeters: number;
  elevationGainMeters: number;
  durationSeconds: number;
}) {
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.round((durationSeconds % 3600) / 60);

  return (
    <div className="flex w-full max-w-md items-center justify-between rounded-2xl border border-white/10 bg-slate-900/90 px-4 py-2.5 text-slate-100 shadow-2xl backdrop-blur">
      <Metric label="Jarak" value={`${(distanceMeters / 1000).toFixed(2)} km`} />
      <Metric label="Elevasi" value={`${Math.round(elevationGainMeters)} m`} />
      <Metric label="Estimasi" value={hours > 0 ? `${hours}j ${minutes}m` : `${minutes} mnt`} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[10px] uppercase tracking-wide text-slate-400">{label}</span>
      <span className="text-sm font-semibold">{value}</span>
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
          ? 'bg-orange-500 text-white'
          : 'border border-white/15 bg-slate-900/85 text-slate-100'
      }`}
    >
      {children}
      {label}
    </button>
  );
}
