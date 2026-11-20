import { formatActivityDate, type ActivityRecord } from './activity';
import { elevationProfile } from './flyover';
import {
  averageSpeedKmh,
  formatDistanceKm,
  formatDuration,
  formatPace,
  formatSpeed,
  paceSecondsPerKm,
} from './metrics';
import type { LngLatEle } from './polyline';

export type ShareCardStyle = 'poster' | 'sticker';

export type ShareStat = { label: string; value: string };

export type ShareCardData = {
  title: string;
  date: string;
  badge: string;
  stats: ShareStat[];
};

export const CARD_SIZES: Record<ShareCardStyle, { width: number; height: number }> = {
  poster: { width: 1080, height: 1350 },
  sticker: { width: 1080, height: 1080 },
};

const ACCENT = '#f97316';
const ACCENT_SOFT = '#fb923c';
const ACCENT_LIGHT = '#fdba74';
const INK = '#0f172a';
const FONT_STACK = '"Inter","Segoe UI",Roboto,system-ui,-apple-system,sans-serif';

/** Poster safe margins, shared by every block so the layout stays aligned. */
const MARGIN = 72;
const GRID_GAP = 32;

/**
 * Poster area (in card pixels) the captured 3D frame must keep the route
 * inside: below the title block and above the stats grid. `FlyoverMap` reads
 * this to frame the route, since the frame is drawn as a cropped cover image.
 */
export const POSTER_ROUTE_BAND = { top: 380, bottom: 800, left: 90, right: 990 };

function font(size: number, weight: number | string = 600): string {
  return `${weight} ${size}px ${FONT_STACK}`;
}

export function buildShareCardData(activity: ActivityRecord): ShareCardData {
  const speed = averageSpeedKmh(activity.distanceMeters, activity.durationSeconds);
  const usesPace = activity.activityType !== 'ride';

  return {
    title: activity.title,
    date: formatShareDate(activity.createdAt),
    badge: activity.activityType.toUpperCase(),
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

export function shareCardFileName(style: ShareCardStyle, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const stamp = Date.now().toString(36);
  return `tracker3d-${style}-${slug || 'aktivitas'}-${stamp}.png`;
}

export type ShareCardInput = {
  style: ShareCardStyle;
  data: ShareCardData;
  coordinates: LngLatEle[];
  /** Live 3D map frame; the poster falls back to a drawn route when absent. */
  mapFrame: HTMLCanvasElement | null;
};

export function renderShareCard(input: ShareCardInput): HTMLCanvasElement {
  const { width, height } = CARD_SIZES[input.style];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // The sticker must stay fully transparent, so nothing paints the background.
  if (input.style === 'poster') drawPoster(ctx, input, width, height);
  else drawSticker(ctx, input, width, height);

  return canvas;
}

function drawPoster(
  ctx: CanvasRenderingContext2D,
  { data, coordinates, mapFrame }: ShareCardInput,
  width: number,
  height: number,
) {
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, width, height);

  if (mapFrame) {
    drawCover(ctx, mapFrame, width, height);
  } else {
    drawFallbackBackdrop(ctx, coordinates, width, height);
  }

  // Two soft scrims keep white type readable over bright satellite imagery.
  const top = ctx.createLinearGradient(0, 0, 0, 620);
  top.addColorStop(0, 'rgba(2,6,23,0.94)');
  top.addColorStop(0.55, 'rgba(2,6,23,0.55)');
  top.addColorStop(1, 'rgba(2,6,23,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, width, 620);

  const bottom = ctx.createLinearGradient(0, height * 0.34, 0, height);
  bottom.addColorStop(0, 'rgba(2,6,23,0)');
  bottom.addColorStop(0.45, 'rgba(2,6,23,0.82)');
  bottom.addColorStop(1, 'rgba(2,6,23,0.97)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, height * 0.34, width, height * 0.66);

  drawBadgeRow(ctx, data, width);
  drawPosterTitle(ctx, data.title, width);

  const cellWidth = (width - MARGIN * 2 - GRID_GAP) / 2;
  drawStatGrid(ctx, data.stats, MARGIN, 836, cellWidth, 118);

  drawElevation(ctx, coordinates, {
    x: MARGIN,
    y: 1104,
    width: width - MARGIN * 2,
    height: 148,
  });
}

function drawSticker(
  ctx: CanvasRenderingContext2D,
  { data, coordinates }: ShareCardInput,
  width: number,
  height: number,
) {
  // Upper band of the sticker: 120 → 740 leaves room for the stats row below.
  const routeBox = {
    x: 120,
    y: 120,
    width: width - 240,
    height: 620,
  };
  drawRouteGlow(ctx, coordinates, routeBox);

  drawStickerStats(ctx, data.stats, width, height);
}

function drawBadgeRow(ctx: CanvasRenderingContext2D, data: ShareCardData, width: number) {
  const pillFont = font(30, 800);
  ctx.font = pillFont;
  const textWidth = ctx.measureText(data.badge).width;
  const pillWidth = textWidth + 52;
  const pillHeight = 58;
  const pillY = 112;

  roundedRect(ctx, MARGIN, pillY, pillWidth, pillHeight, pillHeight / 2);
  ctx.fillStyle = ACCENT;
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(data.badge, MARGIN + pillWidth / 2, pillY + pillHeight / 2 + 1);

  ctx.font = font(30, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.textAlign = 'right';
  ctx.fillText(data.date, width - MARGIN, pillY + pillHeight / 2 + 1);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawPosterTitle(ctx: CanvasRenderingContext2D, title: string, width: number) {
  const maxWidth = width - MARGIN * 2;
  ctx.font = font(72, 800);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 4;

  const lines = wrapText(ctx, title, maxWidth, 2);
  lines.forEach((line, index) => {
    ctx.fillText(line, MARGIN, 258 + index * 86);
  });

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function drawStatGrid(
  ctx: CanvasRenderingContext2D,
  stats: ShareStat[],
  x: number,
  y: number,
  cellWidth: number,
  cellHeight: number,
) {
  stats.forEach((stat, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const cellX = x + column * (cellWidth + GRID_GAP);
    const cellY = y + row * cellHeight;

    ctx.textAlign = 'left';
    ctx.font = font(26, 700);
    ctx.fillStyle = ACCENT;
    ctx.fillText(stat.label.toUpperCase(), cellX, cellY);

    ctx.font = font(58, 800);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 3;
    ctx.fillText(stat.value, cellX, cellY + 66);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  });
}

function drawStickerStats(
  ctx: CanvasRenderingContext2D,
  stats: ShareStat[],
  width: number,
  height: number,
) {
  const columnWidth = (width - 192) / stats.length;
  const labelY = height - 206;
  const valueY = height - 128;

  stats.forEach((stat, index) => {
    const centerX = 96 + columnWidth * (index + 0.5);

    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 3;

    ctx.font = font(fitFontSize(ctx, stat.label.toUpperCase(), columnWidth - 20, 24, 700, 15), 700);
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fillText(stat.label.toUpperCase(), centerX, labelY);

    ctx.font = font(fitFontSize(ctx, stat.value, columnWidth - 14, 48, 800, 26), 800);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(stat.value, centerX, valueY);

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  });

  ctx.textAlign = 'left';
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

function drawElevation(
  ctx: CanvasRenderingContext2D,
  coordinates: LngLatEle[],
  box: { x: number; y: number; width: number; height: number },
) {
  const profile = elevationProfile(coordinates, 180);
  if (profile.points.length < 2) return;

  const span = profile.max - profile.min || 1;
  const step = box.width / (profile.points.length - 1);
  const toY = (value: number) =>
    box.y + box.height - ((value - profile.min) / span) * box.height * 0.9 - box.height * 0.05;

  const trace = () => {
    ctx.beginPath();
    profile.points.forEach((value, index) => {
      const x = box.x + index * step;
      const y = toY(value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  };

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const fill = ctx.createLinearGradient(0, box.y, 0, box.y + box.height);
  fill.addColorStop(0, 'rgba(249,115,22,0.55)');
  fill.addColorStop(1, 'rgba(249,115,22,0.03)');
  trace();
  ctx.lineTo(box.x + box.width, box.y + box.height);
  ctx.lineTo(box.x, box.y + box.height);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  trace();
  ctx.strokeStyle = ACCENT_SOFT;
  ctx.lineWidth = 5;
  ctx.stroke();

  ctx.font = font(24, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(profile.max)} m`, box.x, box.y - 18);
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(profile.min)} m`, box.x + box.width, box.y - 18);
  ctx.textAlign = 'left';
}

/** Cover-crops the map frame so the poster never letterboxes. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLCanvasElement,
  width: number,
  height: number,
) {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

/** Poster backdrop used when the WebGL frame cannot be captured (no map key). */
function drawFallbackBackdrop(
  ctx: CanvasRenderingContext2D,
  coordinates: LngLatEle[],
  width: number,
  height: number,
) {
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#1e293b');
  sky.addColorStop(0.5, '#0f172a');
  sky.addColorStop(1, '#020617');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  drawRouteGlow(ctx, coordinates, {
    x: 140,
    y: 320,
    width: width - 280,
    height: height * 0.32,
  });
}

function drawRouteGlow(
  ctx: CanvasRenderingContext2D,
  coordinates: LngLatEle[],
  box: { x: number; y: number; width: number; height: number },
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

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.save();
  ctx.shadowColor = 'rgba(249,115,22,0.85)';
  ctx.shadowBlur = 42;
  trace();
  ctx.strokeStyle = 'rgba(249,115,22,0.5)';
  ctx.lineWidth = 30;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.shadowColor = 'rgba(249,115,22,0.95)';
  ctx.shadowBlur = 26;
  trace();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 14;
  ctx.stroke();
  ctx.restore();

  trace();
  ctx.strokeStyle = ACCENT_LIGHT;
  ctx.lineWidth = 6;
  ctx.stroke();

  const start = points[0];
  const end = points[points.length - 1];
  drawEndpoint(ctx, start.x, start.y, '#ffffff', 13);
  drawEndpoint(ctx, end.x, end.y, ACCENT, 15);
}

function drawEndpoint(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, radius: number) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.stroke();
  ctx.restore();
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
