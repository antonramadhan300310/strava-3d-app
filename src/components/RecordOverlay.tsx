'use client';

import { useEffect, useState } from 'react';
import {
  Bike,
  CheckCircle2,
  Footprints,
  Loader2,
  Mountain,
  Pause,
  Play,
  RotateCcw,
  Save,
  Square,
  X,
} from 'lucide-react';
import type { ActivityRecorderState } from '@/hooks/useActivityRecorder';
import type { ActivityType } from '@/lib/valhalla';

const PROFILE_ICONS: Record<ActivityType, React.ReactNode> = {
  ride: <Bike size={18} />,
  run: <Footprints size={18} />,
  hike: <Mountain size={18} />,
};

const ACTIVITY_LABELS: { key: ActivityType; label: string }[] = [
  { key: 'ride', label: 'Ride' },
  { key: 'run', label: 'Run' },
  { key: 'hike', label: 'Hike' },
];

const ACTIVITY_NAMES: Record<ActivityType, string> = {
  ride: 'Bersepeda',
  run: 'Lari',
  hike: 'Hiking',
};

function suggestedTitle(activityType: ActivityType): string {
  const stamp = new Date().toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${ACTIVITY_NAMES[activityType]} ${stamp}`;
}

export default function RecordOverlay({ recorder }: { recorder: ActivityRecorderState }) {
  const [showSave, setShowSave] = useState(false);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const idle = recorder.phase === 'idle';
  // The HUD stays up while elevations are fetched so the numbers do not blink out.
  const active = recorder.phase !== 'idle';
  const finished = recorder.finishResult !== null;

  // Keep a GPS fix flowing while the tab is open so the signal badge and blue
  // dot are live before Start is pressed.
  useEffect(() => {
    void recorder.startPreview();
    return () => {
      void recorder.stopPreview();
    };
  }, [recorder.startPreview, recorder.stopPreview]);

  // Finishing a run pops the title dialog straight away, as required by the flow.
  useEffect(() => {
    if (!finished) {
      setShowSave(false);
      return;
    }
    setTitle(suggestedTitle(recorder.activityType));
    setSaveError(null);
    setShowSave(true);
  }, [finished, recorder.activityType]);

  const confirmSave = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setSaveError('Judul aktivitas wajib diisi.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await recorder.saveActivity(trimmed);
      setShowSave(false);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Gagal menyimpan aktivitas.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {active && (
        <div className="pointer-events-none absolute inset-x-3 top-[calc(env(safe-area-inset-top)+4.5rem)] flex justify-center">
          <TelemetryCard recorder={recorder} />
        </div>
      )}

      {recorder.pendingRestore && (
        <RestorePrompt recorder={recorder} />
      )}

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 px-3 pb-[calc(env(safe-area-inset-bottom)+5.5rem)]">
        {recorder.gpsError && (
          <p
            className="mx-auto max-w-md rounded-xl bg-rose-500/95 px-3 py-2 text-center text-xs font-medium text-white shadow-lg"
            role="alert"
          >
            {recorder.gpsError}
          </p>
        )}
        {recorder.notice && (
          <button
            type="button"
            onClick={recorder.dismissNotice}
            className="mx-auto max-w-md rounded-xl bg-slate-900/90 px-3 py-2 text-center text-xs font-medium text-slate-100 shadow-lg"
            role="status"
          >
            {recorder.notice}
          </button>
        )}

        {idle && (
          <div className="mx-auto w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/90 p-2 shadow-2xl backdrop-blur">
            <p className="px-2 pb-1 pt-0.5 text-[10px] uppercase tracking-wide text-slate-400">
              Jenis aktivitas
            </p>
            <div className="flex gap-1" role="group" aria-label="Jenis aktivitas">
              {ACTIVITY_LABELS.map(({ key, label }) => {
                const selected = recorder.activityType === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => recorder.changeActivityType(key)}
                    aria-pressed={selected}
                    className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-[11px] font-semibold transition active:scale-95 ${
                      selected ? 'bg-orange-500 text-white' : 'text-slate-300 active:bg-slate-800'
                    }`}
                  >
                    {PROFILE_ICONS[key]}
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="mx-auto flex w-full max-w-md items-center gap-2">
          {idle && (
            <button
              type="button"
              onClick={() => void recorder.start(recorder.activityType)}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-emerald-500 py-4 text-base font-bold text-white shadow-2xl transition active:scale-[0.98]"
            >
              <Play size={22} />
              Start
            </button>
          )}

          {recorder.phase === 'recording' && (
            <>
              <button
                type="button"
                onClick={recorder.pause}
                className="flex flex-[2] items-center justify-center gap-2 rounded-2xl bg-amber-500 py-4 text-base font-bold text-slate-900 shadow-2xl transition active:scale-[0.98]"
              >
                <Pause size={22} />
                Pause
              </button>
              <button
                type="button"
                onClick={() => void recorder.finish()}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-rose-500 py-4 text-base font-bold text-white shadow-2xl transition active:scale-[0.98]"
              >
                <Square size={20} />
                Finish
              </button>
            </>
          )}

          {recorder.phase === 'paused' && !finished && (
            <>
              <button
                type="button"
                onClick={() => void recorder.resume()}
                className="flex flex-[2] items-center justify-center gap-2 rounded-2xl bg-emerald-500 py-4 text-base font-bold text-white shadow-2xl transition active:scale-[0.98]"
              >
                <Play size={22} />
                Resume
              </button>
              <button
                type="button"
                onClick={() => void recorder.finish()}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-rose-500 py-4 text-base font-bold text-white shadow-2xl transition active:scale-[0.98]"
              >
                <Square size={20} />
                Finish
              </button>
            </>
          )}

          {recorder.phase === 'finishing' && (
            <button
              type="button"
              disabled
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-slate-800 py-4 text-base font-bold text-slate-300 shadow-2xl"
            >
              <Loader2 size={22} className="animate-spin" />
              Memproses elevasi…
            </button>
          )}
        </div>
      </div>

      {showSave && finished && recorder.finishResult && (
        <div className="absolute inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-950/70 px-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] backdrop-blur-sm sm:items-center sm:pb-4">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Simpan Aktivitas</h2>
              <button
                type="button"
                onClick={() => {
                  setShowSave(false);
                  recorder.discardFinish();
                }}
                aria-label="Tutup"
                className="rounded-full p-1 text-slate-400 active:bg-slate-800"
              >
                <X size={18} />
              </button>
            </div>

            <dl className="mb-3 grid grid-cols-3 gap-2 rounded-xl bg-slate-800/70 px-3 py-2 text-center">
              <SummaryItem label="Jarak" value={`${(recorder.finishResult.distanceMeters / 1000).toFixed(2)} km`} />
              <SummaryItem label="Durasi" value={recorder.formatted.duration} />
              <SummaryItem
                label={recorder.finishResult.usedGpsAltitude ? 'Elevasi GPS' : 'Elevasi'}
                value={`${recorder.finishResult.elevationGainMeters} m`}
              />
            </dl>

            <label htmlFor="activity-title" className="mb-1 block text-xs text-slate-400">
              Judul aktivitas
            </label>
            <input
              id="activity-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
              className="mb-3 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-orange-500"
              placeholder="Lari pagi"
            />

            {saveError && <p className="mb-2 text-xs text-rose-400">{saveError}</p>}

            <button
              type="button"
              onClick={() => void confirmSave()}
              disabled={saving}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-orange-500 py-3 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-60"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {saving ? 'Menyimpan…' : 'Simpan ke Supabase'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function TelemetryCard({ recorder }: { recorder: ActivityRecorderState }) {
  const { formatted } = recorder;
  const paused = recorder.isPaused;

  return (
    <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/90 px-4 py-3 text-slate-100 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          <span
            className={`h-2 w-2 rounded-full ${
              paused ? 'bg-amber-400' : 'animate-pulse bg-emerald-400'
            }`}
          />
          {paused ? 'Dijeda' : 'Merekam'}
        </span>
        <span className="text-2xl font-bold tabular-nums">{formatted.duration}</span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1 border-t border-white/10 pt-2">
        <Metric label="Jarak" value={`${formatted.distance} km`} />
        <Metric label="Kecepatan" value={`${formatted.currentSpeed} km/j`} />
        <Metric label="Rata-rata" value={`${formatted.averageSpeed} km/j`} />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1">
        <Metric label="Pace saat ini" value={`${formatted.currentPace} /km`} />
        <Metric label="Pace rata-rata" value={`${formatted.averagePace} /km`} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[9px] uppercase tracking-wide text-slate-400">{label}</span>
      <span className="text-xs font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[9px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-xs font-semibold text-slate-100">{value}</dd>
    </div>
  );
}

function RestorePrompt({ recorder }: { recorder: ActivityRecorderState }) {
  const saved = recorder.pendingRestore;
  if (!saved) return null;

  const savedAt = new Date(saved.savedAt).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/70 px-4 py-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] backdrop-blur-sm">
      <div className="my-auto w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-4 shadow-2xl">
        <h2 className="mb-1 text-sm font-semibold text-slate-100">Pulihkan sesi rekaman?</h2>
        <p className="mb-4 text-xs text-slate-400">
          Ditemukan rekaman {ACTIVITY_NAMES[saved.activityType]} dengan {saved.points.length} titik
          (tersimpan {savedAt}). Lanjutkan atau buang rekaman ini.
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void recorder.restoreSession()}
            className="flex items-center justify-center gap-2 rounded-xl bg-orange-500 py-3 text-sm font-semibold text-white transition active:scale-[0.98]"
          >
            <RotateCcw size={16} />
            Pulihkan Sesi
          </button>
          <button
            type="button"
            onClick={recorder.dismissRestore}
            className="flex items-center justify-center gap-2 rounded-xl border border-white/15 py-3 text-sm font-semibold text-slate-200 transition active:scale-[0.98]"
          >
            <CheckCircle2 size={16} />
            Buang dan Mulai Baru
          </button>
        </div>
      </div>
    </div>
  );
}
