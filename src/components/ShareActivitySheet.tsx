'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Share2, X } from 'lucide-react';
import AllmovaLogo, {
  ALLMOVA_CHARCOAL,
  ALLMOVA_LIME,
  ALLMOVA_OLIVE,
  ALLMOVA_SURFACE,
  allmovaFontStack,
  drawAllmovaLogoOnCanvas,
} from '@/components/AllmovaLogo';
import { useAuth } from '@/context/AuthContext';
import type { ActivityRecord } from '@/lib/activity';
import {
  averageSpeedKmh,
  formatDistanceKm,
  formatDuration,
  formatPace,
  formatSpeed,
  paceSecondsPerKm,
} from '@/lib/metrics';
import { saveCardImage, shareCardImage } from '@/lib/shareImage';

type Props = {
  activity: ActivityRecord;
  onClose: () => void;
  onNotice: (message: string) => void;
};

type BusyAction = 'share' | 'save' | null;

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;
const PADDING = 80;
function font(size: number, weight: number | string = 600): string {
  return `${weight} ${size}px ${allmovaFontStack()}`;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}…`;
}

function shareDate(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('id-ID', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

type ProjectedPoint = { x: number; y: number };

/** Equirectangular projection that fits every GPS point inside the route band. */
function projectRoute(
  coordinates: ActivityRecord['coordinates'],
  box: { x: number; y: number; width: number; height: number },
): ProjectedPoint[] {
  const points = coordinates.filter(
    (point) => Number.isFinite(point[0]) && Number.isFinite(point[1]),
  );
  if (points.length < 2) return [];

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  // A point-to-point route has zero span on one axis; keep the scale finite.
  const spanLon = Math.max(maxLon - minLon, 1e-6);
  const spanLat = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min(box.width / spanLon, box.height / spanLat);
  const offsetX = box.x + (box.width - spanLon * scale) / 2;
  const offsetY = box.y + (box.height - spanLat * scale) / 2;

  return points.map(([lon, lat]) => ({
    x: offsetX + (lon - minLon) * scale,
    y: offsetY + (maxLat - lat) * scale,
  }));
}

function traceRoute(ctx: CanvasRenderingContext2D, points: ProjectedPoint[]) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo(points[index].x, points[index].y);
  }
}

function drawBackground(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = ALLMOVA_CHARCOAL;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  const glow = ctx.createRadialGradient(
    CARD_WIDTH / 2,
    520,
    40,
    CARD_WIDTH / 2,
    520,
    780,
  );
  glow.addColorStop(0, 'rgba(185,245,30,0.18)');
  glow.addColorStop(0.55, 'rgba(30,46,22,0.35)');
  glow.addColorStop(1, 'rgba(13,17,18,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
}

function drawRoute(
  ctx: CanvasRenderingContext2D,
  points: ProjectedPoint[],
) {
  if (points.length < 2) return;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  traceRoute(ctx, points);
  ctx.strokeStyle = 'rgba(185,245,30,0.14)';
  ctx.lineWidth = 34;
  ctx.stroke();

  traceRoute(ctx, points);
  ctx.strokeStyle = 'rgba(185,245,30,0.32)';
  ctx.lineWidth = 17;
  ctx.stroke();

  traceRoute(ctx, points);
  ctx.shadowColor = 'rgba(185,245,30,0.85)';
  ctx.shadowBlur = 28;
  ctx.strokeStyle = ALLMOVA_LIME;
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.restore();

  const start = points[0];
  const finish = points[points.length - 1];

  ctx.save();
  ctx.beginPath();
  ctx.arc(start.x, start.y, 18, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(34,197,94,0.28)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(start.x, start.y, 10, 0, Math.PI * 2);
  ctx.fillStyle = '#22C55E';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(finish.x, finish.y, 18, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(185,245,30,0.25)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(finish.x, finish.y, 10, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = ALLMOVA_LIME;
  ctx.stroke();
  ctx.restore();
}

function drawStats(
  ctx: CanvasRenderingContext2D,
  stats: { label: string; value: string }[],
  top: number,
) {
  const gap = 24;
  const boxWidth = (CARD_WIDTH - PADDING * 2 - gap) / 2;
  const boxHeight = 150;

  stats.forEach((stat, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = PADDING + column * (boxWidth + gap);
    const y = top + row * (boxHeight + gap);

    roundedRect(ctx, x, y, boxWidth, boxHeight, 28);
    ctx.fillStyle = ALLMOVA_SURFACE;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(185,245,30,0.16)';
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = font(22, 700);
    ctx.fillStyle = 'rgba(148,163,184,0.95)';
    ctx.fillText(stat.label.toUpperCase(), x + 32, y + 52);

    ctx.font = font(44, 800);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(truncate(ctx, stat.value, boxWidth - 64), x + 32, y + 116);
  });
}

function drawFreeWatermark(ctx: CanvasRenderingContext2D, top: number) {
  const height = CARD_HEIGHT - top;
  const gradient = ctx.createLinearGradient(0, top, 0, CARD_HEIGHT);
  gradient.addColorStop(0, ALLMOVA_OLIVE);
  gradient.addColorStop(1, ALLMOVA_SURFACE);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, top, CARD_WIDTH, height);

  ctx.fillStyle = ALLMOVA_LIME;
  ctx.fillRect(0, top, CARD_WIDTH, 4);

  drawAllmovaLogoOnCanvas(ctx, PADDING, top + 22, 0.72, { variant: 'full' });

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(22, 500);
  ctx.fillStyle = 'rgba(255,255,255,0.66)';
  ctx.fillText(
    'Upgrade ke Pro untuk membagikan gambar bersih tanpa watermark',
    PADDING,
    top + 178,
  );
}

export function renderActivityShareCard(
  activity: ActivityRecord,
  isPro: boolean,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  drawBackground(ctx);

  const badge = activity.activityType.toUpperCase();
  ctx.font = font(24, 800);
  const badgeWidth = ctx.measureText(badge).width + 48;
  roundedRect(ctx, PADDING, 88, badgeWidth, 54, 27);
  ctx.fillStyle = ALLMOVA_LIME;
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ALLMOVA_CHARCOAL;
  ctx.fillText(badge, PADDING + 24, 116);

  ctx.textBaseline = 'alphabetic';
  ctx.font = font(56, 800);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(
    truncate(ctx, activity.title, CARD_WIDTH - PADDING * 2),
    PADDING,
    206,
  );

  ctx.font = font(27, 500);
  ctx.fillStyle = 'rgba(148,163,184,0.95)';
  ctx.fillText(shareDate(activity.createdAt), PADDING, 256);

  const statsTop = isPro ? 960 : 790;
  const routeBox = {
    x: PADDING,
    y: 310,
    width: CARD_WIDTH - PADDING * 2,
    height: statsTop - 310 - 50,
  };
  const route = projectRoute(activity.coordinates, routeBox);
  if (route.length >= 2) {
    drawRoute(ctx, route);
  } else {
    ctx.font = font(28, 600);
    ctx.fillStyle = 'rgba(148,163,184,0.8)';
    ctx.textAlign = 'center';
    ctx.fillText('Rute tidak tersedia', CARD_WIDTH / 2, routeBox.y + routeBox.height / 2);
    ctx.textAlign = 'left';
  }

  const speed = averageSpeedKmh(activity.distanceMeters, activity.durationSeconds);
  const usesPace = activity.activityType !== 'cycling';
  drawStats(
    ctx,
    [
      { label: 'Jarak', value: `${formatDistanceKm(activity.distanceMeters)} km` },
      { label: 'Durasi', value: formatDuration(activity.durationSeconds) },
      { label: 'Elevasi', value: `${Math.round(activity.elevationGain)} m` },
      usesPace
        ? { label: 'Pace', value: `${formatPace(paceSecondsPerKm(speed))} /km` }
        : { label: 'Kecepatan', value: `${formatSpeed(speed)} km/j` },
    ],
    statsTop,
  );

  if (!isPro) drawFreeWatermark(ctx, 1140);

  return canvas;
}

function fileNameFor(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `allmova-share-${slug || 'aktivitas'}-${Date.now().toString(36)}.png`;
}

export default function ShareActivitySheet({ activity, onClose, onNotice }: Props) {
  const { isPro } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);

  const fileName = useMemo(() => fileNameFor(activity.title), [activity.title]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    const handle = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const canvas = renderActivityShareCard(activity, isPro);
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
  }, [activity, isPro]);

  const handleShare = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || busy) return;
    setBusy('share');
    setError(null);
    try {
      await shareCardImage(canvas, fileName, activity.title);
      onNotice('Gambar aktivitas siap dibagikan');
    } catch (cause) {
      console.error(cause);
      setError('Gagal membagikan gambar.');
    } finally {
      setBusy(null);
    }
  }, [activity.title, busy, fileName, onNotice]);

  const handleSave = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || busy) return;
    setBusy('save');
    setError(null);
    try {
      const outcome = await saveCardImage(canvas, fileName, activity.title);
      onNotice(
        outcome.location === 'documents'
          ? 'Gambar berhasil disimpan di folder Documents'
          : outcome.location === 'share-sheet'
            ? 'Pilih "Simpan ke File" untuk menyimpan gambar'
            : 'Gambar berhasil diunduh',
      );
    } catch (cause) {
      console.error(cause);
      setError('Gagal menyimpan gambar.');
    } finally {
      setBusy(null);
    }
  }, [activity.title, busy, fileName, onNotice]);

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[#0D1112]/97 backdrop-blur">
      <header className="flex items-center justify-between gap-3 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
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

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-3">
        <div className="mx-auto flex w-full max-w-sm items-center justify-center rounded-2xl border border-white/10 bg-[#151B1D] p-2">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt={`Kartu aktivitas ${activity.title}`}
              className="h-auto w-full rounded-xl"
            />
          ) : (
            <div className="flex aspect-[4/5] w-full items-center justify-center text-slate-400">
              <Loader2 size={24} className="animate-spin text-[#B9F51E]" />
            </div>
          )}
        </div>
        <p className="mx-auto mt-2 max-w-sm text-center text-[10px] leading-relaxed text-slate-500">
          {isPro
            ? 'Kartu bersih tanpa watermark, khusus pengguna Pro.'
            : 'Kartu menyertakan watermark ALLMOVA. Upgrade ke Pro untuk gambar bersih.'}
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
