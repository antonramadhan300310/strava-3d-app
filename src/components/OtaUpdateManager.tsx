'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw, X } from 'lucide-react';
import {
  applyOtaBundle,
  checkOtaUpdate,
  clearPendingOtaBundle,
  currentBundleVersion,
  isNativeApp,
  notifyAppReady,
  pendingOtaBundle,
  type OtaBundle,
  type OtaRelease,
} from '@/lib/otaUpdater';
import { openExternalUrl } from '@/lib/nativeTrackingService';

/**
 * Runs the silent OTA check once per launch: a mandatory native update gate
 * first, then a live bundle download. A bundle downloaded on an earlier launch
 * is applied here, before the user starts recording anything.
 */
export default function OtaUpdateManager() {
  const [requiredRelease, setRequiredRelease] = useState<OtaRelease | null>(null);
  const [readyBundle, setReadyBundle] = useState<OtaBundle | null>(null);
  const [applying, setApplying] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;

    void (async () => {
      // Idempotent safety net: AppShell already signalled readiness at module
      // load, this only matters if that call raced the native bridge.
      await notifyAppReady();

      const pending = pendingOtaBundle();
      const running = await currentBundleVersion();
      if (cancelled) return;

      if (pending && pending.version === running) {
        // The update already booted; nothing left to apply.
        clearPendingOtaBundle();
      } else if (pending) {
        const applied = await applyOtaBundle(pending);
        if (cancelled) return;
        if (!applied.ok) {
          // A stale bundle (deleted by a capgo rollback) must not block the check.
          clearPendingOtaBundle();
        } else {
          return;
        }
      }

      const outcome = await checkOtaUpdate();
      if (cancelled) return;

      if (outcome.status === 'native-required') {
        setRequiredRelease(outcome.release);
      } else if (outcome.status === 'ready') {
        setReadyBundle(outcome.bundle);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const reload = useCallback(async () => {
    if (!readyBundle) return;
    setApplying(true);
    const applied = await applyOtaBundle(readyBundle);
    if (!applied.ok) setApplying(false);
  }, [readyBundle]);

  if (!isNativeApp()) return null;

  return (
    <>
      {readyBundle && !bannerDismissed && (
        <div className="pointer-events-none fixed inset-x-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[90] flex justify-center">
          <div className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-xl border border-[#B9F51E]/30 bg-[#151B1D]/95 px-3 py-2 shadow-xl backdrop-blur">
            <RefreshCw size={14} className="shrink-0 text-[#B9F51E]" />
            <p className="flex-1 text-[11px] font-medium text-slate-100">
              Pembaruan ALLMOVA siap diterapkan
            </p>
            <button
              type="button"
              onClick={() => void reload()}
              disabled={applying}
              className="rounded-lg bg-[#B9F51E] px-2.5 py-1 text-[11px] font-bold text-[#0D1112] transition active:scale-95 disabled:opacity-60"
            >
              {applying ? 'Memuat…' : 'Muat Ulang'}
            </button>
            <button
              type="button"
              onClick={() => setBannerDismissed(true)}
              aria-label="Tutup pemberitahuan pembaruan"
              className="rounded-full p-1 text-slate-400 active:bg-white/10"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {requiredRelease && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#0D1112]/85 px-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-[#B9F51E]/25 bg-[#151B1D] p-5 shadow-2xl">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#B9F51E]">
              ALLMOVA
            </p>
            <h2 className="mb-2 text-lg font-bold text-slate-100">Pembaruan Sistem ALLMOVA</h2>
            <p className="mb-4 text-xs leading-relaxed text-slate-400">
              Versi aplikasi di perangkat ini sudah tidak didukung. Unduh versi baru untuk
              melanjutkan perekaman dan sinkronisasi aktivitas.
            </p>

            {requiredRelease.releaseNotes && (
              <p className="mb-4 rounded-xl bg-[#1E2E16]/70 px-3 py-2 text-[11px] leading-relaxed text-slate-300">
                {requiredRelease.releaseNotes}
              </p>
            )}

            <button
              type="button"
              onClick={() => void openExternalUrl(requiredRelease.apkUrl)}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#B9F51E] py-3 text-sm font-bold text-[#0D1112] transition active:scale-[0.98] hover:bg-[#A5E012]"
            >
              <Download size={16} />
              Unduh Versi Baru
            </button>
            <p className="mt-3 text-center text-[10px] text-slate-500">
              Diperlukan versi native {requiredRelease.minNativeVersion} atau lebih baru.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
