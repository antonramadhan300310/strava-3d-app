'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Image as ImageIcon, Loader2, Share2, Sparkles, Sticker, X } from 'lucide-react';
import AllmovaLogo from '@/components/AllmovaLogo';
import type { ActivityRecord } from '@/lib/activity';
import {
  CARD_SIZES,
  buildShareCardData,
  renderShareCard,
  shareCardFileName,
  type ShareCardMode,
} from '@/lib/shareCard';
import { saveCardImage, shareCardImage, type SaveImageOutcome } from '@/lib/shareImage';

type Props = {
  activity: ActivityRecord;
  onClose: () => void;
  onNotice: (message: string) => void;
};

type BusyAction = 'share' | 'save' | null;

const MODES: {
  key: ShareCardMode;
  label: string;
  icon: React.ReactNode;
  hint: string;
}[] = [
  {
    key: 'card',
    label: 'Kartu Gelap',
    icon: <ImageIcon size={14} />,
    hint: 'Kartu charcoal dengan jalur GPS tebal, pin start/finish, statistik, dan watermark.',
  },
  {
    key: 'route',
    label: 'Stiker + Rute',
    icon: <Sticker size={14} />,
    hint: 'Latar transparan berisi jalur GPS tebal, pin start/finish, dan statistik ber-shadow.',
  },
  {
    key: 'stats',
    label: 'Stiker Statistik',
    icon: <Sparkles size={14} />,
    hint: 'Latar transparan tanpa rute: hanya nama aktivitas, ikon olahraga, dan 4 statistik.',
  },
];

const SAVE_NOTICES: Record<SaveImageOutcome['location'], string> = {
  gallery: 'Berhasil disimpan ke Galeri perangkat',
  documents: 'Gambar berhasil disimpan di folder Documents',
  'share-sheet': 'Pilih "Simpan ke File" untuk menyimpan gambar',
  download: 'Gambar berhasil diunduh',
};

export default function ShareActivitySheet({ activity, onClose, onNotice }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<ShareCardMode>('card');
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);

  const data = useMemo(() => buildShareCardData(activity), [activity]);
  const size = CARD_SIZES[mode];
  const activeMode = MODES.find((option) => option.key === mode) ?? MODES[0];

  useEffect(() => {
    let cancelled = false;
    setPreview(null);

    // A macrotask lets the spinner paint before the canvas work blocks the thread.
    const handle = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const canvas = renderShareCard({
          mode,
          data,
          coordinates: activity.coordinates,
        });
        canvasRef.current = canvas;
        setPreview(canvas.toDataURL('image/png'));
      } catch (cause) {
        console.error(cause);
        setError('Gagal membuat gambar. Coba lagi.');
      }
    }, 30);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [mode, data, activity.coordinates]);

  const handleShare = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || busy) return;
    setBusy('share');
    setError(null);
    try {
      const outcome = await shareCardImage(canvas, shareCardFileName(mode, activity.title), activity.title);
      if (outcome === 'shared') onNotice('Gambar aktivitas siap dibagikan');
    } catch (cause) {
      console.error(cause);
      setError('Gagal membagikan gambar.');
    } finally {
      setBusy(null);
    }
  }, [activity.title, busy, mode, onNotice]);

  const handleSave = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || busy) return;
    setBusy('save');
    setError(null);
    try {
      const outcome = await saveCardImage(
        canvas,
        shareCardFileName(mode, activity.title),
        activity.title,
      );
      onNotice(SAVE_NOTICES[outcome.location]);
    } catch (cause) {
      console.error(cause);
      setError('Gagal menyimpan gambar.');
    } finally {
      setBusy(null);
    }
  }, [activity.title, busy, mode, onNotice]);

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[#0D1112]/97 backdrop-blur">
      <header className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <div className="flex items-center gap-2">
          <AllmovaLogo variant="compact" className="h-6 w-auto" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Kartu Aktivitas
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Tutup kartu aktivitas"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-[#151B1D] text-slate-300 active:scale-95"
        >
          <X size={18} />
        </button>
      </header>

      <div className="shrink-0 px-4">
        <div className="mx-auto flex w-full max-w-sm gap-1 rounded-2xl border border-white/10 bg-[#151B1D]/90 p-1">
          {MODES.map((option) => {
            const selected = option.key === mode;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => setMode(option.key)}
                aria-pressed={selected}
                className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1.5 py-2 text-[10px] font-semibold transition ${
                  selected
                    ? 'bg-[#B9F51E] text-[#0D1112] shadow-lg'
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

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3 pt-3">
        <div
          className="relative mx-auto w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
          style={{ aspectRatio: `${size.width} / ${size.height}` }}
        >
          {mode !== 'card' && <Checkerboard />}
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt={`Pratinjau ${activeMode.label} untuk ${activity.title}`}
              className="relative h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-slate-400">
              <Loader2 size={24} className="animate-spin text-[#B9F51E]" />
            </div>
          )}
        </div>

        <p className="mx-auto mt-2 max-w-sm text-center text-[10px] leading-relaxed text-slate-400">
          {activeMode.hint}
        </p>
        <p className="mx-auto mt-1 max-w-sm text-center text-[10px] leading-relaxed text-slate-500">
          Watermark ALLMOVA selalu disertakan di pojok kanan bawah.
        </p>
        {error && (
          <p className="mx-auto mt-2 max-w-sm text-center text-[11px] font-medium text-red-300">
            {error}
          </p>
        )}
      </div>

      <div className="shrink-0 px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        <div className="mx-auto flex w-full max-w-sm flex-col gap-2">
          <button
            type="button"
            onClick={() => void handleShare()}
            disabled={!preview || busy !== null}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#B9F51E] hover:bg-[#A5E012] py-3.5 text-sm font-bold text-[#0D1112] shadow-2xl transition active:scale-[0.98] disabled:opacity-50"
          >
            {busy === 'share' ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Share2 size={18} />
            )}
            Bagikan ke Sosmed / WhatsApp
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!preview || busy !== null}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-white/15 bg-[#151B1D] py-3.5 text-sm font-bold text-slate-100 transition active:scale-[0.98] disabled:opacity-50"
          >
            {busy === 'save' ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Download size={18} />
            )}
            Simpan ke Galeri / Perangkat
          </button>
        </div>
      </div>
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
