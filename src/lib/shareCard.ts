import { allmovaFontStack, drawAllmovaLogoOnCanvas } from '@/components/AllmovaLogo';
import { formatActivityDate, type ActivityRecord } from './activity';
import {
  averageSpeedKmh,
  formatDistanceKm,
  formatDuration,
  formatPace,
  formatSpeed,
  paceSecondsPerKm,
} from './metrics';
import type { LngLatEle } from './polyline';
import { drawRouteEndpointBadge } from './routeEndpoints';
import { normalizeActivityType, type ActivityType } from './valhalla';

/**
 * `card` is the charcoal poster, `route` a transparent route sticker and
 * `stats` a transparent sticker that only carries the numbers.
 */
export type ShareCardMode = 'card' | 'route' | 'stats';

export type ShareStat = { label: string; value: string };

export type ShareCardData = {
  title: string;
  date: string;
  badge: string;
  activityType: ActivityType;
  stats: ShareStat[];
};

export const CARD_SIZES: Record<ShareCardMode, { width: number; height: number }> = {
  card: { width: 1080, height: 1350 },
  route: { width: 1080, height: 1080 },
  stats: { width: 1080, height: 1080 },
};

const ACCENT = '#B9F51E';
const INK = '#0D1112';
const SURFACE = '#151B1D';
const SHADOW = 'rgba(13,17,18,0.85)';

/** Watermark lockup height as a share of the canvas height. */
export const WATERMARK_HEIGHT_RATIO = 0.12;

/** Card safe margins, shared by every block so the layout stays aligned. */
const MARGIN = 72;

/**
 * Poster area (in card pixels) the captured 3D frame must keep the route
 * inside. `FlyoverMap` reads this to frame the route for the share preview.
 */
export const POSTER_ROUTE_BAND = { top: 380, bottom: 800, left: 90, right: 990 };

function font(size: number, weight: number | string = 600): string {
  return `${weight} ${size}px ${allmovaFontStack()}`;
}

export function buildShareCardData(activity: ActivityRecord): ShareCardData {
  const speed = averageSpeedKmh(activity.distanceMeters, activity.durationSeconds);
  const usesPace = activity.activityType !== 'cycling';

  return {
    title: activity.title,
    date: formatShareDate(activity.createdAt),
    badge: activity.activityType.toUpperCase(),
    activityType: normalizeActivityType(activity.activityType),
    stats: [
      { label: 'Jarak', value: `${formatDistanceKm(activity.distanceMeters)} km` },
      { label: 'Elevasi', value: `${Math.round(activity.elevationGain)} m` },
      { label: 'Durasi', value: formatDuration(activity.durationSeconds) },
      usesPace
        ? { label: 'Pace', value: `${formatPace(paceSecondsPerKm(speed))} /km` }
        : { label: 'Kecepatan', value: `${formatSpeed(speed)} km/j` },
    ],
  };
}

function formatShareDate(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return formatActivityDate(iso);
  return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function shareCardFileName(mode: ShareCardMode, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const stamp = Date.now().toString(36);
  return `allmova-${mode}-${slug || 'aktivitas'}-${stamp}.png`;
}

export type ShareCardInput = {
  mode: ShareCardMode;
  data: ShareCardData;
  coordinates: LngLatEle[];
};

export function renderShareCard(input: ShareCardInput): HTMLCanvasElement {
  const { width, height } = CARD_SIZES[input.mode];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // Both stickers must stay fully transparent, so only the card paints a
  // background.
  if (input.mode === 'card') {
    drawCard(ctx, input, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
    if (input.mode === 'route') drawRouteSticker(ctx, input, width, height);
    else drawStatsSticker(ctx, input, width, height);
  }

  drawWatermark(ctx, width, height);

  return canvas;
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  { data, coordinates }: ShareCardInput,
  width: number,
  height: number,
) {
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(width / 2, 520, 40, width / 2, 520, 760);
  glow.addColorStop(0, 'rgba(185,245,30,0.16)');
  glow.addColorStop(0.55, 'rgba(30,46,22,0.32)');
  glow.addColorStop(1, 'rgba(13,17,18,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  drawBadgeRow(ctx, data, width);
  drawCardTitle(ctx, data, width);

  drawRoute(
    ctx,
    coordinates,
    { x: MARGIN, y: 420, width: width - MARGIN * 2, height: 400 },
    { casing: INK, core: ACCENT, halo: 'rgba(185,245,30,0.28)' },
  );

  drawCardStats(ctx, data.stats, 860);
}

function drawRouteSticker(
  ctx: CanvasRenderingContext2D,
  { data, coordinates }: ShareCardInput,
  width: number,
  height: number,
) {
  drawRoute(
    ctx,
    coordinates,
    { x: 100, y: 90, width: width - 200, height: 610 },
    { casing: SHADOW, core: ACCENT, halo: 'rgba(185,245,30,0.35)' },
  );

  drawStickerStats(ctx, data.stats, width, height - 200);
}

function drawStatsSticker(
  ctx: CanvasRenderingContext2D,
  { data }: ShareCardInput,
  width: number,
  height: number,
) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.shadowColor = SHADOW;
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 4;

  drawSportIcon(ctx, data.activityType, width / 2, 190, 74);

  ctx.font = font(64, 800);
  ctx.fillStyle = '#FFFFFF';
  const titleLines = wrapText(ctx, data.title, width - 240, 2);
  titleLines.forEach((line, index) => {
    ctx.fillText(line, width / 2, 330 + index * 76);
  });

  ctx.font = font(28, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.fillText(data.date, width / 2, 330 + titleLines.length * 76 + 16);
  ctx.restore();

  drawStickerStats(ctx, data.stats, width, height - 330);
}

/** Neon route with a dark casing so it reads on any photo underneath. */
function drawRoute(
  ctx: CanvasRenderingContext2D,
  coordinates: LngLatEle[],
  box: { x: number; y: number; width: number; height: number },
  colors: { casing: string; core: string; halo: string },
) {
  const points = projectCoordinates(coordinates, box);
  if (points.length < 2) return;

  const trace = () => {
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
  };

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  trace();
  ctx.strokeStyle = colors.halo;
  ctx.lineWidth = 34;
  ctx.stroke();

  trace();
  ctx.strokeStyle = colors.casing;
  ctx.lineWidth = 24;
  ctx.stroke();

  trace();
  ctx.strokeStyle = colors.core;
  ctx.lineWidth = 13;
  ctx.stroke();
  ctx.restore();

  const start = points[0];
  const end = points[points.length - 1];
  drawRouteEndpointBadge(ctx, 'start', start.x, start.y, 17);
  drawRouteEndpointBadge(ctx, 'finish', end.x, end.y, 19);
}

function drawBadgeRow(ctx: CanvasRenderingContext2D, data: ShareCardData, width: number) {
  const pillHeight = 56;
  const pillY = 96;

  ctx.font = font(28, 800);
  const pillWidth = ctx.measureText(data.badge).width + 50;
  roundedRect(ctx, MARGIN, pillY, pillWidth, pillHeight, pillHeight / 2);
  ctx.fillStyle = ACCENT;
  ctx.fill();

  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(data.badge, MARGIN + pillWidth / 2, pillY + pillHeight / 2 + 1);

  ctx.font = font(28, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.textAlign = 'right';
  ctx.fillText(data.date, width - MARGIN, pillY + pillHeight / 2 + 1);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawCardTitle(ctx: CanvasRenderingContext2D, data: ShareCardData, width: number) {
  ctx.font = font(62, 800);
  ctx.fillStyle = '#FFFFFF';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 4;

  wrapText(ctx, data.title, width - MARGIN * 2, 2).forEach((line, index) => {
    ctx.fillText(line, MARGIN, 250 + index * 74);
  });

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function drawCardStats(ctx: CanvasRenderingContext2D, stats: ShareStat[], top: number) {
  const gap = 24;
  const boxWidth = (CARD_SIZES.card.width - MARGIN * 2 - gap) / 2;
  const boxHeight = 132;

  stats.forEach((stat, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = MARGIN + column * (boxWidth + gap);
    const y = top + row * (boxHeight + gap);

    roundedRect(ctx, x, y, boxWidth, boxHeight, 26);
    ctx.fillStyle = SURFACE;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(185,245,30,0.16)';
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = font(22, 700);
    ctx.fillStyle = 'rgba(148,163,184,0.95)';
    ctx.fillText(stat.label.toUpperCase(), x + 30, y + 48);

    ctx.font = font(42, 800);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(truncate(ctx, stat.value, boxWidth - 60), x + 30, y + 104);
  });
}

/** Four stat columns with a heavy shadow so white type survives any photo. */
function drawStickerStats(
  ctx: CanvasRenderingContext2D,
  stats: ShareStat[],
  width: number,
  valueBaseline: number,
) {
  const columnWidth = (width - 160) / stats.length;
  const labelBaseline = valueBaseline - 68;

  stats.forEach((stat, index) => {
    const centerX = 80 + columnWidth * (index + 0.5);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 4;

    ctx.font = font(fitFontSize(ctx, stat.label.toUpperCase(), columnWidth - 24, 24, 700, 15), 700);
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.fillText(stat.label.toUpperCase(), centerX, labelBaseline);

    ctx.font = font(fitFontSize(ctx, stat.value, columnWidth - 18, 48, 800, 26), 800);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(stat.value, centerX, valueBaseline);
    ctx.restore();
  });
}

/** Sport glyph for the stats-only sticker, drawn with the lime accent. */
function drawSportIcon(
  ctx: CanvasRenderingContext2D,
  activityType: ActivityType,
  centerX: number,
  centerY: number,
  size: number,
) {
  ctx.save();
  ctx.translate(centerX - size / 2, centerY - size / 2);
  ctx.scale(size / 64, size / 64);
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  ctx.lineWidth = 4.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = SHADOW;
  ctx.shadowBlur = 18;

  if (activityType === 'cycling') {
    ctx.beginPath();
    ctx.arc(14, 46, 11, 0, Math.PI * 2);
    ctx.arc(50, 46, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(14, 46);
    ctx.lineTo(28, 24);
    ctx.lineTo(42, 24);
    ctx.lineTo(50, 46);
    ctx.moveTo(28, 24);
    ctx.lineTo(38, 46);
    ctx.lineTo(50, 46);
    ctx.stroke();
  } else {
    // Walking/running figure: head, torso and a two-leg stride.
    ctx.beginPath();
    ctx.arc(34, 13, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(32, 22);
    ctx.lineTo(28, 38);
    ctx.lineTo(14, 54);
    ctx.moveTo(28, 38);
    ctx.lineTo(44, 46);
    ctx.lineTo(50, 60);
    ctx.moveTo(32, 28);
    ctx.lineTo(48, 32);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Proportional ALLMOVA lockup in the bottom-right corner.
 *
 * Every tier gets it, so a Free and a Pro export stay visually consistent and
 * the brand rides along on every share. The height tracks the canvas so a
 * 1080 px sticker and a 1350 px card carry the same relative weight.
 */
function drawWatermark(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const logoHeight = height * WATERMARK_HEIGHT_RATIO;
  const scale = logoHeight / 64;
  const logoWidth = 280 * scale;
  const margin = Math.round(width * 0.035);

  ctx.save();
  ctx.shadowColor = 'rgba(13,17,18,0.55)';
  ctx.shadowBlur = 18;
  drawAllmovaLogoOnCanvas(
    ctx,
    width - logoWidth - margin,
    height - logoHeight - margin,
    scale,
    { variant: 'compact', opacity: 0.94 },
  );
  ctx.restore();
}

/** Largest font size at or below `size` that keeps `text` inside `maxWidth`. */
function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  size: number,
  weight: number,
  minSize: number,
): number {
  let current = size;
  ctx.font = font(current, weight);
  while (current > minSize && ctx.measureText(text).width > maxWidth) {
    current -= 2;
    ctx.font = font(current, weight);
  }
  return current;
}

const MERCATOR_LAT_LIMIT = 85.05112878;

/**
 * Fits `[lng, lat]` into `box` with one uniform scale on both axes.
 *
 * Longitude is multiplied by `cos(centerLat)` so a degree of longitude and a
 * degree of latitude share the same on-screen length — the local form of the
 * Web Mercator stretch the map itself applies. Without that factor the two axes
 * need separate scales, which shears the route (the "gepeng" sticker): bearings
 * and curves must match the real map, not merely fill the box.
 */
export function projectCoordinates(
  coordinates: LngLatEle[],
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number }[] {
  if (coordinates.length < 2) return [];

  const lats = coordinates.map(([, lat]) =>
    Math.min(Math.max(lat, -MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT),
  );
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const centerLat = (minLat + maxLat) / 2;
  const cosLat = Math.max(Math.cos((centerLat * Math.PI) / 180), 1e-6);

  const projected = coordinates.map(([lng, lat]) => ({
    x: lng * cosLat,
    y: Math.min(Math.max(lat, -MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT),
  }));

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of projected) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  // A perfectly straight route has no extent on one axis; avoid dividing by 0.
  const scale = Math.min(
    spanX > 0 ? box.width / spanX : Infinity,
    spanY > 0 ? box.height / spanY : Infinity,
  );
  const safeScale = Number.isFinite(scale) ? scale : 1;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  return projected.map((point) => ({
    x: box.x + box.width / 2 + (point.x - midX) * safeScale,
    // Latitude grows northwards while canvas y grows downwards.
    y: box.y + box.height / 2 - (point.y - midY) * safeScale,
  }));
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

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';
  let truncated = false;

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      if (lines.length === maxLines) {
        truncated = true;
        current = '';
        break;
      }
    }
    current = word;
  }

  if (current && lines.length < maxLines) lines.push(current);
  else if (current) truncated = true;

  if (truncated && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = `${last.trimEnd()}…`;
  }

  return lines;
}
