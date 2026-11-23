'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Image as ImageIcon, Loader2, Share2, Sticker, X } from 'lucide-react';
import type { ActivityRecord } from '@/lib/activity';
import {
  buildShareCardData,
  CARD_SIZES,
  renderShareCard,
  shareCardFileName,
  type ShareCardStyle,
} from '@/lib/shareCard';
import { saveCardImage, shareCardImage, type SaveImageOutcome } from '@/lib/shareImage';

type Props = {
  activity: ActivityRecord;
  /**
   * Captures the whole route framed for the poster, or null when the map
   * cannot be read. Never the current zoomed-in flyover camera.
   */
  captureFullRouteFrame: () => Promise<HTMLCanvasElement | null>;
  onClose: () => void;
  onNotice: (message: string) => void;
};

type BusyAction = 'share' | 'save' | null;

const STYLES: { key: ShareCardStyle; label: string; icon: React.ReactNode }[] = [
  { key: 'poster', label: 'Poster Peta 3D', icon: <ImageIcon size={14} /> },
  { key: 'sticker', label: 'Stiker Transparan', icon: <Sticker size={14} /> },
];

const SAVE_NOTICES: Record<SaveImageOutcome['location'], string> = {
  documents: 'Gambar berhasil disimpan di folder Documents',
  'share-sheet': 'Pilih "Simpan ke File" untuk menyimpan gambar',
  download: 'Gambar berhasil diunduh',
};

export default function ShareCardModal({
  activity,
  captureFullRouteFrame,
  onClose,
  onNotice,
}: Props) {
  const [style, setStyle] = useState<ShareCardStyle>('poster');
  const [preview, setPreview] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The map keeps animating, so the frame is frozen once the modal opens.
  const frameRef = useRef<HTMLCanvasElement | null>(null);
  const [frameReady, setFrameReady] = useState(false);

  const data = useMemo(() => buildShareCardData(activity), [activity]);
  const size = CARD_SIZES[style];

  // The poster needs the whole route, so the map is re-framed and captured
  // before the first render rather than grabbing the current flyover camera.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const frame = await captureFullRouteFrame();
      if (cancelled) return;
      frameRef.current = frame;
      setFrameReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [captureFullRouteFrame]);

  useEffect(() => {
    if (!frameReady) return;

    let cancelled = false;
    setRendering(true);
    setError(null);

    // A macrotask lets the spinner paint before the canvas work blocks the thread.
    const handle = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const canvas = renderShareCard({
          style,
          data,
          coordinates: activity.coordinates,
          mapFrame: frameRef.current,
        });
        canvasRef.current = canvas;
        setPreview(canvas.toDataURL('image/png'));
      } catch (cause) {
        console.error(cause);
        setError('Gagal membuat gambar. Coba lagi.');
      } finally {
        if (!cancelled) setRendering(false);
      }
    }, 30);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [style, data, activity.coordinates, frameReady]);

  const handleShare = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || busy) return;

    setBusy('share');
    setError(null);
    try {
      const outcome = await shareCardImage(
        canvas,
        shareCardFileName(style, activity.title),
        activity.title,
      );
      if (outcome === 'shared') onNotice('Kartu aktivitas siap dibagikan');
    } catch (cause) {
      console.error(cause);
      setError('Gagal membagikan gambar.');
    } finally {
      setBusy(null);
    }
  }, [activity.title, busy, onNotice, style]);

  const handleSave = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || busy) return;

    setBusy('save');
    setError(null);
    try {
      const result = await saveCardImage(
        canvas,
        shareCardFileName(style, activity.title),
        activity.title,
      );
      onNotice(SAVE_NOTICES[result.location]);
    } catch (cause) {
      console.error(cause);
      setError('Gagal menyimpan gambar.');
    } finally {
      setBusy(null);
    }
  }, [activity.title, busy, onNotice, style]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0D1112]/95 backdrop-blur">
      <header className="flex items-center gap-2 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-slate-100">Bagikan Aktivitas</h2>
          <p className="truncate text-[11px] text-slate-400">{activity.title}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Tutup pratinjau"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/15 bg-[#151B1D]/85 text-slate-100 active:scale-95"
        >
          <X size={20} />
        </button>
      </header>

      <div className="px-3">
        <div className="mx-auto flex w-full max-w-md gap-1 rounded-2xl border border-white/10 bg-[#151B1D]/90 p-1">
          {STYLES.map((option) => {
            const active = option.key === style;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => setStyle(option.key)}
                aria-pressed={active}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-[11px] font-semibold transition ${
                  active
                    ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112] shadow-lg'
                    : 'text-slate-300 active:bg-[#1E2E16]'
                }`}
              >
                {option.icon}
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="mx-auto flex w-full max-w-md flex-col gap-2">
          <div
            className="relative overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
            style={{ aspectRatio: `${size.width} / ${size.height}` }}
          >
            {style === 'sticker' && <Checkerboard />}
            {preview ? (
              <img
                src={preview}
                alt={`Pratinjau ${style === 'poster' ? 'poster peta 3D' : 'stiker transparan'}`}
                className="relative h-full w-full object-contain"
              />
            ) : null}
            {rendering && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0D1112]/60">
                <Loader2 size={24} className="animate-spin text-[#B9F51E]" />
              </div>
            )}
          </div>

          <p className="text-center text-[11px] leading-relaxed text-slate-400">
            {style === 'poster'
              ? `Poster ${size.width} × ${size.height} px dengan peta 3D, statistik, dan profil elevasi.`
              : `Stiker ${size.width} × ${size.height} px dengan latar transparan — tempel di atas foto.`}
          </p>

          {error && (
            <p className="rounded-xl bg-red-500/15 px-3 py-2 text-center text-[11px] font-medium text-red-300">
              {error}
            </p>
          )}
        </div>
      </div>

      <footer className="flex flex-col gap-2 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        <div className="mx-auto flex w-full max-w-md gap-2">
          <button
            type="button"
            onClick={handleShare}
            disabled={!preview || busy !== null}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-[#B9F51E] hover:bg-[#A5E012] py-3.5 text-sm font-bold text-[#0D1112] shadow-2xl transition active:scale-[0.98] disabled:opacity-50"
          >
            {busy === 'share' ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Share2 size={18} />
            )}
            Bagikan
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!preview || busy !== null}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-white/15 bg-[#151B1D]/90 py-3.5 text-sm font-bold text-slate-100 shadow-2xl transition active:scale-[0.98] disabled:opacity-50"
          >
            {busy === 'save' ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Download size={18} />
            )}
            Simpan Gambar
          </button>
        </div>
        <p className="text-center text-[10px] text-slate-500">
          Bagikan ke WhatsApp, Instagram, atau aplikasi lain lewat menu bawaan perangkat.
        </p>
      </footer>
    </div>
  );
}

/** Grey checkerboard so the transparent sticker area reads as transparent. */
function Checkerboard() {
  return (
    <div
      aria-hidden
      className="absolute inset-0"
      style={{
        backgroundImage:
          'linear-gradient(45deg, #334155 25%, transparent 25%), linear-gradient(-45deg, #334155 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #334155 75%), linear-gradient(-45deg, transparent 75%, #334155 75%)',
        backgroundSize: '24px 24px',
        backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0',
        backgroundColor: '#1e293b',
      }}
    />
  );
}
