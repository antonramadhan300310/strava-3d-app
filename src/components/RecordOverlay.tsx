'use client';

import { useEffect, useState } from 'react';
import {
  Bike,
  CheckCircle2,
  Footprints,
  Loader2,
  Mountain,
  Navigation,
  Pause,
  Play,
  RotateCcw,
  Route,
  Save,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { ActivityRecorderState } from '@/hooks/useActivityRecorder';
import { useGuideProgress, type GuideProgressState } from '@/hooks/useGuideProgress';
import type { ActivityRecord } from '@/lib/activity';
import { formatGuideDistance, type GuideRoute } from '@/lib/guideRoute';
import { isRouteVoiceMuted, setRouteVoiceMuted } from '@/lib/routeVoice';
import { RPE_SCALE, rpeLabel } from '@/lib/powerAndEffort';
import type { ActivityType } from '@/lib/valhalla';
import SavedRouteSheet from '@/components/SavedRouteSheet';

const PROFILE_ICONS: Record<ActivityType, React.ReactNode> = {
  cycling: <Bike size={18} />,
  run: <Footprints size={18} />,
  walking: <Footprints size={18} />,
  hike: <Mountain size={18} />,
};

const ACTIVITY_LABELS: { key: ActivityType; label: string }[] = [
  { key: 'cycling', label: 'Cycling' },
  { key: 'run', label: 'Run' },
  { key: 'walking', label: 'Walking' },
  { key: 'hike', label: 'Hike' },
];

const ACTIVITY_NAMES: Record<ActivityType, string> = {
  cycling: 'Bersepeda',
  run: 'Lari',
  walking: 'Jalan',
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

export default function RecordOverlay({
  recorder,
  guideRoute,
  savedRoutes,
  savedRoutesLoading,
  onSelectGuideRoute,
  onClearGuideRoute,
  onSessionEnd,
}: {
  recorder: ActivityRecorderState;
  guideRoute: GuideRoute | null;
  savedRoutes: ActivityRecord[];
  savedRoutesLoading: boolean;
  onSelectGuideRoute: (activity: ActivityRecord) => void;
  onClearGuideRoute: () => void;
  onSessionEnd: () => void;
}) {
  const [showSave, setShowSave] = useState(false);
  const [title, setTitle] = useState('');
  const [rpe, setRpe] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);

  const idle = recorder.phase === 'idle';
  // The HUD stays up while elevations are fetched so the numbers do not blink out.
  const active = recorder.phase !== 'idle';
  const finished = recorder.finishResult !== null;

  // localStorage is client-only, so the mute preference loads after hydration.
  useEffect(() => {
    setVoiceMuted(isRouteVoiceMuted());
  }, []);

  const guiding = Boolean(guideRoute) && active;
  const guideProgress = useGuideProgress(
    guideRoute,
    recorder.livePosition,
    guiding,
    !voiceMuted,
  );

  const toggleVoice = () => {
    setVoiceMuted((current) => {
      const next = !current;
      setRouteVoiceMuted(next);
      return next;
    });
  };

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
    setRpe(null);
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
      await recorder.saveActivity(trimmed, rpe);
      setShowSave(false);
      onSessionEnd();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Gagal menyimpan aktivitas.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {guiding && guideRoute && (
        <GuideHud
          route={guideRoute}
          progress={guideProgress}
          muted={voiceMuted}
          onToggleVoice={toggleVoice}
        />
      )}

      {idle && (
        <div className="absolute inset-x-3 top-[calc(env(safe-area-inset-top)+3.2rem)] z-20 flex">
          {guideRoute ? (
            <div className="flex max-w-[calc(100%-5rem)] items-center gap-1.5 rounded-full border border-sky-400/40 bg-[#151B1D]/90 py-1 pl-3 pr-1 text-[11px] font-semibold text-slate-100 shadow-lg backdrop-blur">
              <Navigation size={13} className="shrink-0 text-sky-300" />
              <span className="truncate">{guideRoute.name}</span>
              <button
                type="button"
                onClick={onClearGuideRoute}
                aria-label="Lepas rute panduan"
                className="ml-0.5 shrink-0 rounded-full p-1 text-slate-400 active:bg-[#1E2E16]"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex items-center gap-1.5 rounded-full border border-white/15 bg-[#151B1D]/90 px-3 py-1.5 text-[11px] font-semibold text-slate-100 shadow-lg backdrop-blur transition active:scale-95"
            >
              <Route size={13} className="text-sky-300" />
              Pilih Rute
            </button>
          )}
        </div>
      )}

      {active && (
        <div
          className={`pointer-events-none absolute inset-x-3 flex justify-center ${
            guiding && guideRoute
              ? 'top-[calc(env(safe-area-inset-top)+6.4rem)]'
              : 'top-[calc(env(safe-area-inset-top)+4.5rem)]'
          }`}
        >
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
            className="mx-auto max-w-md rounded-xl bg-[#151B1D]/90 px-3 py-2 text-center text-xs font-medium text-slate-100 shadow-lg"
            role="status"
          >
            {recorder.notice}
          </button>
        )}

        {recorder.isAutoPaused && (
          <div
            className="mx-auto flex w-full max-w-md items-center gap-2 rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 py-2 text-[11px] font-medium text-amber-200 shadow-lg"
            role="status"
            aria-live="polite"
          >
            <Pause size={14} className="shrink-0" />
            <span>
              Jeda Otomatis aktif — timer berhenti sementara dan rekaman lanjut sendiri saat kamu
              bergerak lagi.
            </span>
          </div>
        )}

        {idle && (
          <div className="mx-auto w-full max-w-md rounded-2xl border border-white/10 bg-[#151B1D]/90 p-2 shadow-2xl backdrop-blur">
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
                      selected ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]' : 'text-slate-300 active:bg-[#1E2E16]'
                    }`}
                  >
                    {PROFILE_ICONS[key]}
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="mt-1 flex items-center justify-between gap-2 rounded-xl px-2 py-1.5">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-slate-200">Jeda Otomatis</p>
                <p className="text-[9px] leading-tight text-slate-400">
                  Timer berhenti saat kecepatan &lt; {recorder.autoPauseThresholdKmh} km/j selama 5
                  detik, lalu lanjut sendiri.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={recorder.autoPauseEnabled}
                aria-label="Jeda otomatis"
                onClick={() => recorder.setAutoPauseEnabled(!recorder.autoPauseEnabled)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors active:scale-95 ${
                  recorder.autoPauseEnabled ? 'bg-[#B9F51E]' : 'bg-[#2A3538]'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                    recorder.autoPauseEnabled ? 'translate-x-[20px]' : 'translate-x-0.5'
                  }`}
                />
              </button>
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

          {recorder.phase === 'auto-paused' && !finished && (
            <>
              <button
                type="button"
                onClick={() => void recorder.resume()}
                className="flex flex-[2] items-center justify-center gap-2 rounded-2xl bg-[#B9F51E] py-4 text-base font-bold text-[#0D1112] shadow-2xl transition active:scale-[0.98]"
              >
                <Play size={22} />
                Lanjutkan
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
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-[#1E2E16] py-4 text-base font-bold text-slate-300 shadow-2xl"
            >
              <Loader2 size={22} className="animate-spin" />
              Menempelkan ke jalan…
            </button>
          )}
        </div>
      </div>

      {showSave && finished && recorder.finishResult && (
        <div className="absolute inset-0 z-50 flex items-end justify-center overflow-y-auto bg-[#0D1112]/70 px-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] backdrop-blur-sm sm:items-center sm:pb-4">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#151B1D] p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Simpan Aktivitas</h2>
              <button
                type="button"
                onClick={() => {
                  setShowSave(false);
                  recorder.discardFinish();
                  onSessionEnd();
                }}
                aria-label="Tutup"
                className="rounded-full p-1 text-slate-400 active:bg-[#1E2E16]"
              >
                <X size={18} />
              </button>
            </div>

            <dl className="mb-3 grid grid-cols-3 gap-2 rounded-xl bg-[#1E2E16]/70 px-3 py-2 text-center">
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
              className="mb-3 w-full rounded-xl border border-[#2A3538] bg-[#1E2E16] px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-[#B9F51E]"
              placeholder="Lari pagi"
            />

            <div className="mb-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs text-slate-400">Tingkat Usaha / RPE (opsional)</span>
                <span className="text-[10px] font-semibold text-slate-300">
                  {rpe === null ? 'Belum diisi' : `${rpe}/10 • ${rpeLabel(rpe)}`}
                </span>
              </div>
              <div className="grid grid-cols-5 gap-1" role="group" aria-label="RPE 1 sampai 10">
                {RPE_SCALE.map((entry) => {
                  const selected = rpe === entry.value;
                  return (
                    <button
                      key={entry.value}
                      type="button"
                      aria-pressed={selected}
                      aria-label={`RPE ${entry.value}: ${entry.label}`}
                      onClick={() => setRpe(selected ? null : entry.value)}
                      className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                        selected
                          ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]'
                          : 'bg-[#1E2E16] text-slate-300 active:bg-[#2A3538]'
                      }`}
                    >
                      {entry.value}
                    </button>
                  );
                })}
              </div>
            </div>

            {saveError && <p className="mb-2 text-xs text-rose-400">{saveError}</p>}

            <button
              type="button"
              onClick={() => void confirmSave()}
              disabled={saving}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] py-3 text-sm font-semibold text-[#0D1112] transition active:scale-[0.98] disabled:opacity-60"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {saving ? 'Menyimpan ke Cloud ALLMOVA...' : 'Simpan ke Cloud ALLMOVA'}
            </button>
          </div>
        </div>
      )}

      <SavedRouteSheet
        open={pickerOpen}
        routes={savedRoutes}
        loading={savedRoutesLoading}
        activeId={guideRoute?.id ?? null}
        onSelect={(activity) => {
          setPickerOpen(false);
          onSelectGuideRoute(activity);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

function GuideHud({
  route,
  progress,
  muted,
  onToggleVoice,
}: {
  route: GuideRoute;
  progress: GuideProgressState | null;
  muted: boolean;
  onToggleVoice: () => void;
}) {
  const offRoute = progress?.offRoute ?? false;
  const percent = Math.round((progress?.progress ?? 0) * 100);
  const label = offRoute
    ? `⚠ Di luar rute • ${Math.round(progress?.distanceToRouteMeters ?? 0)} m`
    : `Sisa ${formatGuideDistance(progress?.remainingMeters ?? route.distanceMeters)}`;

  return (
    <div className="absolute left-3 right-[4.6rem] top-[calc(env(safe-area-inset-top)+3.2rem)] z-20 flex justify-center">
      <div
        className={`relative flex h-9 w-full max-w-md items-center gap-2 overflow-hidden rounded-full border px-3 text-[11px] font-semibold shadow-lg backdrop-blur ${
          offRoute
            ? 'border-amber-300/50 bg-amber-500/95 text-slate-900'
            : 'border-sky-400/35 bg-[#151B1D]/92 text-slate-100'
        }`}
        role="status"
        aria-live="polite"
      >
        <Navigation
          size={13}
          className={`shrink-0 ${offRoute ? 'text-slate-900' : 'text-sky-300'}`}
        />
        <span className="min-w-0 truncate">{route.name}</span>
        <span
          className={`ml-auto shrink-0 tabular-nums ${offRoute ? '' : 'text-sky-200'}`}
          aria-label={offRoute ? 'Di luar rute' : 'Sisa jarak'}
        >
          {label}
        </span>
        <button
          type="button"
          onClick={onToggleVoice}
          aria-label={muted ? 'Aktifkan panduan suara' : 'Bisukan panduan suara'}
          aria-pressed={!muted}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
            offRoute ? 'text-slate-900 active:bg-black/10' : 'text-slate-300 active:bg-[#1E2E16]'
          }`}
        >
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>

        <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/15">
          <span
            className={`block h-full rounded-r-full ${offRoute ? 'bg-slate-900/60' : 'bg-sky-400'}`}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </span>
      </div>
    </div>
  );
}

function TelemetryCard({ recorder }: { recorder: ActivityRecorderState }) {
  const { formatted } = recorder;
  const paused = recorder.isPaused;
  const autoPaused = recorder.isAutoPaused;
  const statusLabel = autoPaused ? 'Jeda Otomatis' : paused ? 'Dijeda' : 'Merekam';

  return (
    <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#151B1D]/90 px-4 py-3 text-slate-100 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            <span
              className={`h-2 w-2 rounded-full ${
                paused || autoPaused ? 'bg-amber-400' : 'animate-pulse bg-emerald-400'
              }`}
            />
            {statusLabel}
          </span>
          {!paused && !autoPaused && recorder.nativeTrackingActive && (
            <span className="inline-flex w-fit items-center gap-1 rounded-full bg-[#1E2E16] px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-[#B9F51E]">
              <span className="h-1 w-1 rounded-full bg-[#B9F51E]" />
              GPS Latar Belakang Aktif
            </span>
          )}
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
    <div className="absolute inset-0 z-50 flex items-center justify-center overflow-y-auto bg-[#0D1112]/70 px-4 py-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] backdrop-blur-sm">
      <div className="my-auto w-full max-w-sm rounded-2xl border border-white/10 bg-[#151B1D] p-4 shadow-2xl">
        <h2 className="mb-1 text-sm font-semibold text-slate-100">Pulihkan sesi rekaman?</h2>
        <p className="mb-4 text-xs text-slate-400">
          Ditemukan rekaman {ACTIVITY_NAMES[saved.activityType]} dengan {saved.points.length} titik
          (tersimpan {savedAt}). Lanjutkan atau buang rekaman ini.
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void recorder.restoreSession()}
            className="flex items-center justify-center gap-2 rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] py-3 text-sm font-semibold text-[#0D1112] transition active:scale-[0.98]"
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
