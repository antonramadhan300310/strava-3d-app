'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Check, Download, Loader2, Share2, Video, X } from 'lucide-react';
import type { ActivityRecord } from '@/lib/activity';
import {
  FLYOVER_EXPORT_LONG_SECONDS,
  FlyoverExportAbortedError,
  FlyoverExportUnsupportedError,
  UNSUPPORTED_MESSAGE,
  arrayBufferToBase64,
  buildFlyoverExportHud,
  buildFlyoverExportQualities,
  calculateFlyoverDuration,
  exportFlyoverVideo,
  pickSupportedH264Codec,
  type FlyoverExportFps,
  type FlyoverFrameCapture,
} from '@/lib/flyoverExporter';

/** Temporary render target; cleared before a new export and on close. */
const TEMP_FILE = 'flyover_export.mp4';
const DOCUMENTS_FOLDER = 'Tracker3D';

type Stage = 'quality' | 'rendering' | 'done' | 'error';

type Props = {
  activity: ActivityRecord;
  captureFrame: (progress: number) => Promise<FlyoverFrameCapture | null>;
  onClose: () => void;
  onNotice: (message: string) => void;
};

export default function FlyoverExportSheet({
  activity,
  captureFrame,
  onClose,
  onNotice,
}: Props) {
  const [stage, setStage] = useState<Stage>('quality');
  const [fps, setFps] = useState<FlyoverExportFps>(30);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ size: number; uri: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const percentRef = useRef(0);

  const distanceKm = activity.distanceMeters / 1000;
  const durationSeconds = useMemo(
    () => calculateFlyoverDuration(activity.distanceMeters),
    [activity.distanceMeters],
  );
  const qualities = useMemo(
    () => buildFlyoverExportQualities(durationSeconds),
    [durationSeconds],
  );

  const removeTempFile = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) return;
    try {
      await Filesystem.deleteFile({ path: TEMP_FILE, directory: Directory.Cache });
    } catch {
      // Nothing cached from an earlier export.
    }
  }, []);

  // Probe H.264 up front so unsupported devices get the friendly fallback
  // instead of a failed render.
  useEffect(() => {
    let cancelled = false;
    void pickSupportedH264Codec(30, qualities[30].bitrate).then((codec) => {
      if (!cancelled) setSupported(codec !== null);
    });
    return () => {
      cancelled = true;
    };
  }, [qualities]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      void removeTempFile();
    };
  }, [removeTempFile]);

  const start = useCallback(
    async (quality: FlyoverExportFps) => {
      if (abortRef.current) return;
      setFps(quality);
      setStage('rendering');
      setProgress(0);
      percentRef.current = 0;
      setSaved(false);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const blob = await exportFlyoverVideo({
          fps: quality,
          durationSeconds,
          hud: buildFlyoverExportHud(activity),
          captureFrame,
          signal: controller.signal,
          onProgress: (value) => {
            const percent = Math.round(value * 100);
            if (percent <= percentRef.current && percent < 100) return;
            percentRef.current = percent;
            setProgress(value);
          },
        });
        blobRef.current = blob;

        let uri = '';
        if (Capacitor.isNativePlatform()) {
          await removeTempFile();
          await Filesystem.writeFile({
            path: TEMP_FILE,
            data: arrayBufferToBase64(await blob.arrayBuffer()),
            directory: Directory.Cache,
            recursive: true,
          });
          uri = (
            await Filesystem.getUri({ path: TEMP_FILE, directory: Directory.Cache })
          ).uri;
        }

        setResult({ size: blob.size, uri });
        setProgress(1);
        setStage('done');
      } catch (cause) {
        if (cause instanceof FlyoverExportAbortedError) {
          onClose();
          return;
        }
        setError(describeError(cause));
        setStage('error');
      } finally {
        abortRef.current = null;
      }
    },
    [activity, captureFrame, durationSeconds, onClose, removeTempFile],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const save = useCallback(async () => {
    if (saved || saving || !result) return;
    setSaving(true);

    try {
      const fileName = `Tracker3D-Flyover-${fileTimestamp()}.mp4`;

      if (Capacitor.isNativePlatform()) {
        try {
          await Filesystem.mkdir({
            path: DOCUMENTS_FOLDER,
            directory: Directory.Documents,
            recursive: true,
          });
          await Filesystem.copy({
            from: TEMP_FILE,
            directory: Directory.Cache,
            to: `${DOCUMENTS_FOLDER}/${fileName}`,
            toDirectory: Directory.Documents,
          });
          onNotice(`Video tersimpan di Documents/${DOCUMENTS_FOLDER}/${fileName}.`);
        } catch (cause) {
          // Android 11+ restricts direct writes to public Documents; the share
          // sheet still lets the user save the file through the system UI.
          console.warn('Documents write failed, falling back to the share sheet', cause);
          await Share.share({
            title: '3D Flyover Activity',
            url: result.uri,
            dialogTitle: 'Simpan Video 3D Flyover',
          });
          onNotice(
            'Folder Documents dibatasi Android. Pilih "Simpan ke Files" pada lembar bagikan.',
          );
          return;
        }
      } else {
        const blob = blobRef.current;
        if (!blob) throw new Error('Berkas video tidak tersedia.');
        downloadBlob(blob, fileName);
      }

      setSaved(true);
    } catch (cause) {
      onNotice(describeError(cause, 'Gagal menyimpan video ke HP.'));
    } finally {
      setSaving(false);
    }
  }, [onNotice, result, saved, saving]);

  const share = useCallback(async () => {
    if (sharing || !result) return;
    setSharing(true);

    try {
      if (Capacitor.isNativePlatform()) {
        await Share.share({
          title: '3D Flyover Activity',
          url: result.uri,
          dialogTitle: 'Bagikan Video 3D Flyover',
        });
        return;
      }

      const blob = blobRef.current;
      if (!blob) throw new Error('Berkas video tidak tersedia.');
      const file = new File([blob], `Tracker3D-Flyover-${fileTimestamp()}.mp4`, {
        type: 'video/mp4',
      });
      if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: '3D Flyover Activity' });
      } else {
        downloadBlob(blob, file.name);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      onNotice(describeError(cause, 'Gagal membagikan video.'));
    } finally {
      setSharing(false);
    }
  }, [onNotice, result, sharing]);

  const close = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    void removeTempFile();
    blobRef.current = null;
    onClose();
  }, [onClose, removeTempFile]);

  const quality = qualities[fps];

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-slate-900/95 p-5 text-slate-100 shadow-2xl">
        {stage === 'quality' && (
          <>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 text-sm font-bold">
                  <Video size={16} className="text-orange-400" />
                  Export MP4 (Beta)
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  Dirender 100% di HP, tanpa upload ke server.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Tutup pilihan export"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-800 text-slate-300 active:scale-95"
              >
                <X size={16} />
              </button>
            </div>

            {supported === false ? (
              <p className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
                {UNSUPPORTED_MESSAGE}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="rounded-2xl border border-white/10 bg-slate-800/40 p-3">
                  <p className="text-[11px] font-semibold text-slate-200">
                    Durasi otomatis: {durationSeconds} detik • rute{' '}
                    {distanceKm.toFixed(1)} km
                  </p>
                  {durationSeconds > FLYOVER_EXPORT_LONG_SECONDS && (
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                      Video &gt; 30 dtk otomatis dibagi 2 klip di Status WA (utuh di IG
                      Reels &amp; Chat WA)
                    </p>
                  )}
                </div>
                {([30, 60] as const).map((value) => {
                  const option = qualities[value];
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => void start(option.fps)}
                      className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-800/70 px-4 py-3 text-left transition active:scale-[0.98]"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-bold">{option.label}</span>
                        <span className="mt-0.5 block text-[11px] text-slate-400">
                          {option.hint}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-orange-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-orange-300">
                        720p
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        {stage === 'rendering' && (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <Loader2 size={28} className="animate-spin text-orange-400" />
            <p className="text-3xl font-black tabular-nums">
              {Math.round(progress * 100)}%
            </p>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Merender video • {quality.qualityLabel}
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-orange-500 transition-[width] duration-150"
                style={{ width: `${Math.max(2, progress * 100)}%` }}
              />
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              Jangan tutup layar selama proses video.
            </p>
            <button
              type="button"
              onClick={cancel}
              className="mt-1 flex items-center justify-center gap-2 rounded-2xl border border-white/15 bg-slate-800 px-5 py-2.5 text-sm font-bold text-slate-100 active:scale-[0.98]"
            >
              <X size={16} />
              Batal
            </button>
          </div>
        )}

        {stage === 'done' && result && (
          <>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 text-sm font-bold text-emerald-300">
                  <Check size={16} />
                  Video siap dibagikan
                </p>
                <p className="mt-1 text-[11px] tabular-nums text-slate-400">
                  {formatFileSize(result.size)} • {quality.qualityLabel}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Tutup dan bersihkan file sementara"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-800 text-slate-300 active:scale-95"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saved || saving}
                className="flex items-center justify-center gap-2 rounded-2xl bg-orange-500 py-3 text-sm font-bold text-white shadow-xl transition active:scale-[0.98] disabled:bg-emerald-600 disabled:opacity-100"
              >
                {saving ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : saved ? (
                  <Check size={18} />
                ) : (
                  <Download size={18} />
                )}
                {saved ? 'Tersimpan ✓' : 'Simpan ke HP'}
              </button>

              <button
                type="button"
                onClick={() => void share()}
                disabled={sharing}
                className="flex items-center justify-center gap-2 rounded-2xl border border-white/15 bg-slate-800 py-3 text-sm font-bold text-slate-100 transition active:scale-[0.98] disabled:opacity-70"
              >
                {sharing ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Share2 size={18} />
                )}
                Bagikan
              </button>
            </div>

            <p className="mt-3 text-center text-[10px] leading-relaxed text-slate-500">
              File sementara disimpan di cache HP dan dibersihkan saat kartu ini ditutup.
            </p>
          </>
        )}

        {stage === 'error' && (
          <>
            <p className="mb-3 text-sm font-bold text-amber-300">Export belum berhasil</p>
            <p className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-100">
              {error}
            </p>
            <button
              type="button"
              onClick={close}
              className="mt-4 flex w-full items-center justify-center rounded-2xl bg-slate-800 py-3 text-sm font-bold text-slate-100 active:scale-[0.98]"
            >
              Tutup
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function describeError(cause: unknown, fallback = 'Gagal membuat video.'): string {
  if (cause instanceof FlyoverExportUnsupportedError) return cause.message;
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

function formatFileSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function fileTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('-');
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
