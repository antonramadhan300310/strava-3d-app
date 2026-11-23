'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  ImagePlus,
  Loader2,
  Map as MapIcon,
  RotateCcw,
  Share2,
  Sparkles,
  Sticker,
  Trash2,
  X,
} from 'lucide-react';
import AllmovaLogo from '@/components/AllmovaLogo';
import type { ActivityRecord } from '@/lib/activity';
import type { MapProvider } from '@/lib/mapProvider';
import {
  SHARE_SIZES,
  SHARE_SIZE_LABELS,
  buildShareCardData,
  renderShareCard,
  shareCardFileName,
  type ShareCardMode,
  type ShareSizeKey,
  type StatsPosition,
} from '@/lib/shareCard';
import { captureSharePosterMap } from '@/lib/sharePoster';
import { saveCardImage, shareCardImage, type SaveImageOutcome } from '@/lib/shareImage';

type Props = {
  activity: ActivityRecord;
  /** Same tile stack the main map uses, so the poster matches. */
  provider: MapProvider;
  onClose: () => void;
  onNotice: (message: string) => void;
};

type BusyAction = 'share' | 'save' | null;

type PhotoState = {
  image: HTMLImageElement;
  src: string;
  zoom: number;
  offsetX: number;
  offsetY: number;
};

const MODES: {
  key: ShareCardMode;
  label: string;
  icon: React.ReactNode;
  hint: string;
}[] = [
  {
    key: 'poster',
    label: 'Poster Peta 3D',
    icon: <MapIcon size={14} />,
    hint: 'Peta 3D miring dengan rute tebal, pin start/finish, statistik, grafik elevasi, dan watermark ALLMOVA.',
  },
  {
    key: 'route',
    label: 'Stiker + Rute',
    icon: <Sticker size={14} />,
    hint: 'Latar transparan atau foto galeri berisi jalur rute tebal, pin start/finish, dan statistik.',
  },
  {
    key: 'stats',
    label: 'Stiker Tanpa Rute',
    icon: <Sparkles size={14} />,
    hint: 'Latar transparan atau foto galeri tanpa rute: hanya nama aktivitas, ikon olahraga, dan statistik.',
  },
];

const SAVE_NOTICES: Record<SaveImageOutcome['location'], string> = {
  gallery: 'Berhasil disimpan ke Galeri perangkat',
  documents: 'Gambar berhasil disimpan di folder Documents',
  'share-sheet': 'Pilih "Simpan ke File" untuk menyimpan gambar',
  download: 'Gambar berhasil diunduh',
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const MAX_OFFSET = 0.9;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export default function ShareActivitySheet({ activity, provider, onClose, onNotice }: Props) {
  const [mode, setMode] = useState<ShareCardMode>('poster');
  const [sizeKey, setSizeKey] = useState<ShareSizeKey>('feed');
  const [preview, setPreview] = useState<string | null>(null);
  const [building, setBuilding] = useState(true);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<PhotoState | null>(null);
  const [statsPosition, setStatsPosition] = useState<StatsPosition>('bottom');

  const previewRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const photoUrlRef = useRef<string | null>(null);
  const photoRef = useRef<PhotoState | null>(null);
  const posterCacheRef = useRef(new Map<ShareSizeKey, HTMLCanvasElement | null>());
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef({
    mode: 'none' as 'none' | 'pan' | 'pinch',
    startZoom: MIN_ZOOM,
    startOffsetX: 0,
    startOffsetY: 0,
    startDistance: 0,
    startX: 0,
    startY: 0,
  });

  photoRef.current = photo;

  const data = useMemo(() => buildShareCardData(activity), [activity]);
  const size = SHARE_SIZES[sizeKey];
  const activeMode = MODES.find((option) => option.key === mode) ?? MODES[0];
  const photoActive = photo !== null;
  const showPhotoControls = mode !== 'poster';

  const getPosterFrame = useCallback(
    async (key: ShareSizeKey): Promise<HTMLCanvasElement | null> => {
      const cache = posterCacheRef.current;
      if (cache.has(key)) return cache.get(key) ?? null;
      const frame = await captureSharePosterMap({
        coordinates: activity.coordinates,
        size: key,
        provider,
      });
      cache.set(key, frame);
      return frame;
    },
    [activity.coordinates, provider],
  );

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setBuilding(true);
    setError(null);

    // A macrotask lets the spinner paint before the canvas/map work blocks.
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const mapImage = mode === 'poster' ? await getPosterFrame(sizeKey) : null;
          if (cancelled) return;
          const canvas = renderShareCard({
            mode,
            data,
            coordinates: activity.coordinates,
            size: sizeKey,
            mapImage,
            // The DOM preview layers the photo itself; only the readability
            // gradient is baked in, so dragging never re-renders the canvas.
            photoBackdrop: showPhotoControls && photoActive,
            statsPosition,
          });
          if (cancelled) return;
          setPreview(canvas.toDataURL('image/png'));
        } catch (cause) {
          console.error(cause);
          if (!cancelled) setError('Gagal membuat pratinjau. Coba lagi.');
        } finally {
          if (!cancelled) setBuilding(false);
        }
      })();
    }, 30);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [
    mode,
    sizeKey,
    data,
    activity.coordinates,
    getPosterFrame,
    photoActive,
    showPhotoControls,
    statsPosition,
  ]);

  useEffect(() => {
    return () => {
      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
    };
  }, []);

  const buildExportCanvas = useCallback(async (): Promise<HTMLCanvasElement> => {
    const mapImage = mode === 'poster' ? await getPosterFrame(sizeKey) : null;
    return renderShareCard({
      mode,
      data,
      coordinates: activity.coordinates,
      size: sizeKey,
      mapImage,
      photo: showPhotoControls ? photo : null,
      photoBackdrop: showPhotoControls && photoActive,
      statsPosition,
    });
  }, [
    activity.coordinates,
    data,
    getPosterFrame,
    mode,
    photo,
    photoActive,
    showPhotoControls,
    sizeKey,
    statsPosition,
  ]);

  const handleShare = useCallback(async () => {
    if (busy) return;
    setBusy('share');
    setError(null);
    try {
      const canvas = await buildExportCanvas();
      const outcome = await shareCardImage(
        canvas,
        shareCardFileName(mode, activity.title),
        activity.title,
      );
      if (outcome === 'shared') onNotice('Gambar aktivitas siap dibagikan');
    } catch (cause) {
      console.error(cause);
      setError('Gagal membagikan gambar.');
    } finally {
      setBusy(null);
    }
  }, [activity.title, buildExportCanvas, busy, mode, onNotice]);

  const handleSave = useCallback(async () => {
    if (busy) return;
    setBusy('save');
    setError(null);
    try {
      const canvas = await buildExportCanvas();
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
  }, [activity.title, buildExportCanvas, busy, mode, onNotice]);

  const pickPhoto = () => fileInputRef.current?.click();

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
      photoUrlRef.current = url;
      setPhoto({ image, src: url, zoom: MIN_ZOOM, offsetX: 0, offsetY: 0 });
      setError(null);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setError('Gagal memuat foto dari galeri.');
    };
    image.src = url;
  };

  const removePhoto = () => {
    if (photoUrlRef.current) {
      URL.revokeObjectURL(photoUrlRef.current);
      photoUrlRef.current = null;
    }
    setPhoto(null);
  };

  const resetPhoto = () =>
    setPhoto((current) =>
      current ? { ...current, zoom: MIN_ZOOM, offsetX: 0, offsetY: 0 } : current,
    );

  const beginGesture = () => {
    const current = photoRef.current;
    if (!current) return;
    const points = Array.from(pointersRef.current.values());
    const gesture = gestureRef.current;

    if (points.length >= 2) {
      gesture.mode = 'pinch';
      gesture.startZoom = current.zoom;
      gesture.startDistance = Math.max(pointerDistance(points[0], points[1]), 1);
      return;
    }
    if (points.length === 1) {
      gesture.mode = 'pan';
      gesture.startOffsetX = current.offsetX;
      gesture.startOffsetY = current.offsetY;
      gesture.startX = points[0].x;
      gesture.startY = points[0].y;
      return;
    }
    gesture.mode = 'none';
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!photo) return;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // A released or synthetic pointer has no capture target; panning still works.
    }
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    beginGesture();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect) return;

    const gesture = gestureRef.current;
    const points = Array.from(pointersRef.current.values());

    if (gesture.mode === 'pinch' && points.length >= 2) {
      const ratio = pointerDistance(points[0], points[1]) / gesture.startDistance;
      const zoom = clamp(gesture.startZoom * ratio, MIN_ZOOM, MAX_ZOOM);
      setPhoto((current) => (current ? { ...current, zoom } : current));
      return;
    }

    if (gesture.mode === 'pan' && points.length === 1) {
      const offsetX = clamp(
        gesture.startOffsetX + (points[0].x - gesture.startX) / rect.width,
        -MAX_OFFSET,
        MAX_OFFSET,
      );
      const offsetY = clamp(
        gesture.startOffsetY + (points[0].y - gesture.startY) / rect.height,
        -MAX_OFFSET,
        MAX_OFFSET,
      );
      setPhoto((current) => (current ? { ...current, offsetX, offsetY } : current));
    }
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) gestureRef.current.mode = 'none';
    else beginGesture();
  };

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[#0D1112]/97 backdrop-blur">
      <header className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <div className="flex items-center gap-2">
          <AllmovaLogo variant="compact" className="h-6 w-auto" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Bagikan Aktivitas
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Tutup layar bagikan aktivitas"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-[#151B1D] text-slate-300 active:scale-95"
        >
          <X size={18} />
        </button>
      </header>

      <div className="shrink-0 px-4">
        <div className="mx-auto flex w-full max-w-sm items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Pilih Ukuran
          </span>
          <div className="flex gap-1 rounded-full border border-white/10 bg-[#151B1D]/90 p-1">
            {(Object.keys(SHARE_SIZES) as ShareSizeKey[]).map((key) => {
              const selected = key === sizeKey;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSizeKey(key)}
                  aria-pressed={selected}
                  className={`rounded-full px-3 py-1 text-[10px] font-bold transition ${
                    selected
                      ? 'bg-[#B9F51E] text-[#0D1112]'
                      : 'text-slate-300 active:bg-[#1E2E16]'
                  }`}
                >
                  {SHARE_SIZE_LABELS[key]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mx-auto mt-2 flex w-full max-w-sm gap-1 rounded-2xl border border-white/10 bg-[#151B1D]/90 p-1">
          {MODES.map((option) => {
            const selected = option.key === mode;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => setMode(option.key)}
                aria-pressed={selected}
                className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-[10px] font-semibold leading-tight transition ${
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
          ref={previewRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          className={`relative mx-auto w-full max-w-sm select-none overflow-hidden rounded-2xl border border-white/10 shadow-2xl ${
            showPhotoControls && photoActive ? 'touch-none cursor-grab' : ''
          }`}
          style={{ aspectRatio: `${size.width} / ${size.height}` }}
        >
          {showPhotoControls && <Checkerboard />}
          {showPhotoControls && photo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photo.src}
              alt="Foto galeri yang dipilih"
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full object-cover"
              style={{
                transform: `translate(${photo.offsetX * 100}%, ${photo.offsetY * 100}%) scale(${photo.zoom})`,
              }}
            />
          )}
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt={`Pratinjau ${activeMode.label} untuk ${activity.title}`}
              className="relative h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Loader2 size={24} className="animate-spin text-[#B9F51E]" />
            </div>
          )}
          {building && preview && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0D1112]/40">
              <Loader2 size={24} className="animate-spin text-[#B9F51E]" />
            </div>
          )}
        </div>

        <p className="mx-auto mt-2 max-w-sm text-center text-[10px] leading-relaxed text-slate-400">
          {activeMode.hint}
        </p>
        <p className="mx-auto mt-1 max-w-sm text-center text-[10px] leading-relaxed text-slate-500">
          Resolusi {size.width} × {size.height} px • watermark ALLMOVA selalu disertakan.
        </p>

        {showPhotoControls && (
          <div className="mx-auto mt-3 w-full max-w-sm rounded-2xl border border-white/10 bg-[#151B1D]/80 p-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={pickPhoto}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-[#B9F51E]/50 bg-[#B9F51E]/10 py-2 text-[11px] font-bold text-[#B9F51E] active:scale-[0.98]"
              >
                <ImagePlus size={14} />
                {photo ? 'Ganti Foto' : '+ Pilih Foto Galeri'}
              </button>
              {photo && (
                <button
                  type="button"
                  onClick={removePhoto}
                  className="flex items-center justify-center gap-1 rounded-xl border border-rose-400/40 px-3 py-2 text-[11px] font-semibold text-rose-300 active:scale-[0.98]"
                >
                  <Trash2 size={14} />
                  Hapus
                </button>
              )}
            </div>

            {photo ? (
              <>
                <label className="mt-3 flex items-center gap-2">
                  <span className="w-12 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Zoom
                  </span>
                  <input
                    type="range"
                    min={MIN_ZOOM * 100}
                    max={MAX_ZOOM * 100}
                    step={1}
                    value={Math.round(photo.zoom * 100)}
                    onChange={(event) =>
                      setPhoto((current) =>
                        current
                          ? { ...current, zoom: clamp(Number(event.target.value) / 100, MIN_ZOOM, MAX_ZOOM) }
                          : current,
                      )
                    }
                    className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-[#2A3538] accent-[#B9F51E]"
                  />
                  <span className="w-10 shrink-0 text-right text-[10px] font-bold tabular-nums text-slate-200">
                    {Math.round(photo.zoom * 100)}%
                  </span>
                </label>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-[10px] leading-tight text-slate-500">
                    Geser foto di pratinjau atau cubit dua jari untuk zoom.
                  </p>
                  <button
                    type="button"
                    onClick={resetPhoto}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-white/15 px-2 py-1 text-[10px] font-semibold text-slate-200 active:scale-95"
                  >
                    <RotateCcw size={11} />
                    Reset Foto
                  </button>
                </div>
              </>
            ) : (
              <p className="mt-2 text-[10px] leading-tight text-slate-500">
                Tanpa foto, kanvas tetap 100% transparan (pola kotak catur).
              </p>
            )}

            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Posisi Teks
              </span>
              <div className="flex gap-1 rounded-full border border-white/10 bg-[#0D1112]/80 p-1">
                {(['bottom', 'top'] as StatsPosition[]).map((position) => {
                  const selected = statsPosition === position;
                  return (
                    <button
                      key={position}
                      type="button"
                      onClick={() => setStatsPosition(position)}
                      aria-pressed={selected}
                      className={`rounded-full px-3 py-1 text-[10px] font-bold transition ${
                        selected
                          ? 'bg-[#B9F51E] text-[#0D1112]'
                          : 'text-slate-300 active:bg-[#1E2E16]'
                      }`}
                    >
                      {position === 'bottom' ? 'Teks: Bawah' : 'Teks: Atas'}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

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
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#B9F51E] py-3.5 text-sm font-bold text-[#0D1112] shadow-2xl transition hover:bg-[#A5E012] active:scale-[0.98] disabled:opacity-50"
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
            onClick={() => void handleSave()}
            disabled={!preview || busy !== null}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-white/15 bg-[#151B1D] py-3.5 text-sm font-bold text-slate-100 transition active:scale-[0.98] disabled:opacity-50"
          >
            {busy === 'save' ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Download size={18} />
            )}
            Simpan Gambar
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
