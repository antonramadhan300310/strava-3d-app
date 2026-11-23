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
 * `poster` is the framed 3D map poster, `route` a transparent route sticker and
 * `stats` a transparent sticker that only carries the numbers.
 */
export type ShareCardMode = 'poster' | 'route' | 'stats';

/** Export ratio shared by the preview and the saved image. */
export type ShareSizeKey = 'feed' | 'story';

export const SHARE_SIZES: Record<ShareSizeKey, { width: number; height: number }> = {
  feed: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
};

export const SHARE_SIZE_LABELS: Record<ShareSizeKey, string> = {
  feed: 'Feed 4:5',
  story: 'Story 9:16',
};

/** Where the stat block sits inside a sticker. */
export type StatsPosition = 'bottom' | 'top';

/**
 * Gallery photo placed behind a sticker. `offsetX`/`offsetY` are fractions of
 * the canvas size so the same numbers drive the DOM preview and the export.
 */
export type SharePhoto = {
  image: HTMLImageElement | HTMLCanvasElement;
  /** 1 = cover fit, up to 3 = zoomed in. */
  zoom: number;
  offsetX: number;
  offsetY: number;
};

export type ShareStat = { label: string; value: string };

export type ShareCardData = {
  title: string;
  date: string;
  badge: string;
  activityType: ActivityType;
  stats: ShareStat[];
};

const ACCENT = '#B9F51E';
const INK = '#0D1112';
const SHADOW = 'rgba(13,17,18,0.85)';

/** Watermark lockup height as a share of the canvas height. */
export const WATERMARK_HEIGHT_RATIO = 0.12;

/** Card safe margins, shared by every block so the layout stays aligned. */
const MARGIN = 72;

/** Poster area (in feed pixels) the captured 3D frame keeps the route inside. */
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
  size?: ShareSizeKey;
  /** Gallery photo drawn behind a sticker. */
  photo?: SharePhoto | null;
  /** Readability gradient behind the stats; set whenever a photo is present. */
  photoBackdrop?: boolean;
  statsPosition?: StatsPosition;
  /** Captured 3D map frame for the poster background. */
  mapImage?: HTMLImageElement | HTMLCanvasElement | null;
};

export function renderShareCard(input: ShareCardInput): HTMLCanvasElement {
  const { width, height } = SHARE_SIZES[input.size ?? 'feed'];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  if (input.mode === 'poster') drawPoster(ctx, input, width, height);
  else drawSticker(ctx, input, width, height);

  drawWatermark(ctx, width, height);

  return canvas;
}

/* ------------------------------------------------------------------ poster */

function drawPoster(
  ctx: CanvasRenderingContext2D,
  { data, coordinates, mapImage }: ShareCardInput,
  width: number,
  height: number,
) {
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, width, height);

  if (mapImage) {
    drawCover(ctx, mapImage, width, height);
  } else {
    // No WebGL frame (offline or tainted tiles): keep the poster recognisable
    // with the charcoal backdrop and the flat route.
    const glow = ctx.createRadialGradient(
      width / 2,
      height * 0.45,
      40,
      width / 2,
      height * 0.45,
      width,
    );
    glow.addColorStop(0, 'rgba(185,245,30,0.16)');
    glow.addColorStop(0.55, 'rgba(30,46,22,0.32)');
    glow.addColorStop(1, 'rgba(13,17,18,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    drawRoute(
      ctx,
      coordinates,
      { x: MARGIN, y: height * 0.26, width: width - MARGIN * 2, height: height * 0.4 },
      { casing: INK, core: ACCENT, halo: 'rgba(185,245,30,0.28)' },
    );
  }

  drawVignettes(ctx, width, height);
  drawPosterHeader(ctx, data, width, height);
  drawPosterStats(ctx, data, width, height);
  drawElevationProfile(ctx, coordinates, width, height);
}

/** Covers the canvas with the frame, cropping the overflow evenly. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
) {
  const { width: iw, height: ih } = imageSize(image);
  if (!iw || !ih) return;
  const scale = Math.max(width / iw, height / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(image, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

function drawVignettes(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const top = ctx.createLinearGradient(0, 0, 0, height * 0.42);
  top.addColorStop(0, 'rgba(13,17,18,0.94)');
  top.addColorStop(0.55, 'rgba(13,17,18,0.5)');
  top.addColorStop(1, 'rgba(13,17,18,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, width, height * 0.42);

  const bottom = ctx.createLinearGradient(0, height * 0.42, 0, height);
  bottom.addColorStop(0, 'rgba(13,17,18,0)');
  bottom.addColorStop(0.45, 'rgba(13,17,18,0.72)');
  bottom.addColorStop(1, 'rgba(13,17,18,0.98)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, height * 0.42, width, height * 0.58);
}

function drawPosterHeader(
  ctx: CanvasRenderingContext2D,
  data: ShareCardData,
  width: number,
  height: number,
) {
  const pillHeight = 56;
  const pillY = Math.round(height * 0.06);

  ctx.save();
  ctx.shadowColor = 'rgba(13,17,18,0.5)';
  ctx.shadowBlur = 18;

  ctx.font = font(28, 800);
  const pillWidth = ctx.measureText(data.badge).width + 50;
  roundedRect(ctx, MARGIN, pillY, pillWidth, pillHeight, pillHeight / 2);
  ctx.fillStyle = ACCENT;
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(data.badge, MARGIN + pillWidth / 2, pillY + pillHeight / 2 + 1);

  ctx.font = font(28, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.textAlign = 'right';
  ctx.fillText(data.date, width - MARGIN, pillY + pillHeight / 2 + 1);

  ctx.font = font(62, 800);
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(13,17,18,0.7)';
  ctx.shadowBlur = 24;
  const lines = wrapText(ctx, data.title, width - MARGIN * 2, 2);
  lines.forEach((line, index) => {
    ctx.fillText(line, MARGIN, pillY + 128 + index * 74);
  });
  ctx.restore();
}

/** Two-column stat grid above the elevation chart. */
function drawPosterStats(
  ctx: CanvasRenderingContext2D,
  data: ShareCardData,
  width: number,
  height: number,
) {
  const columnWidth = (width - MARGIN * 2) / 2;
  const chartTop = elevationChartBottom(height) - ELEVATION_CHART_HEIGHT;
  const rowTwo = chartTop - 110;
  const rowOne = rowTwo - 118;

  ctx.save();
  ctx.textAlign = 'left';
  data.stats.forEach((stat, index) => {
    const x = MARGIN + columnWidth * (index % 2);
    const y = index < 2 ? rowOne : rowTwo;

    ctx.font = font(24, 700);
    ctx.fillStyle = ACCENT;
    ctx.fillText(stat.label.toUpperCase(), x, y);

    ctx.font = font(fitFontSize(ctx, stat.value, columnWidth - 40, 52, 800, 28), 800);
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = 'rgba(13,17,18,0.65)';
    ctx.shadowBlur = 16;
    ctx.fillText(stat.value, x, y + 52);
    ctx.shadowBlur = 0;
  });
  ctx.restore();
}

const ELEVATION_CHART_HEIGHT = 108;

/** Stats sit above the elevation chart and the watermark, never on top. */
function stickerStatsBaseline(height: number): number {
  return (
    height -
    height * WATERMARK_HEIGHT_RATIO -
    Math.round(height * 0.028) -
    Math.round(height * 0.06)
  );
}

function elevationChartBottom(height: number): number {
  const watermarkTop = height - height * WATERMARK_HEIGHT_RATIO - Math.round(height * 0.028);
  return watermarkTop - 26;
}

/** Lime area chart with the min/max labels pinned to the chart ends. */
function drawElevationProfile(
  ctx: CanvasRenderingContext2D,
  coordinates: LngLatEle[],
  width: number,
  height: number,
) {
  const profile = elevationProfile(coordinates);
  if (!profile) return;

  const chartHeight = ELEVATION_CHART_HEIGHT;
  const bottom = elevationChartBottom(height);
  const top = bottom - chartHeight;
  const left = MARGIN;
  const chartWidth = width - MARGIN * 2;

  const { values, min, max } = profile;
  const span = Math.max(max - min, 1);
  const stepX = chartWidth / Math.max(values.length - 1, 1);
  const yFor = (value: number) => top + chartHeight - ((value - min) / span) * chartHeight;

  ctx.save();
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = left + index * stepX;
    if (index === 0) ctx.moveTo(x, yFor(value));
    else ctx.lineTo(x, yFor(value));
  });

  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(13,17,18,0.6)';
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.lineTo(left + chartWidth, top + chartHeight);
  ctx.lineTo(left, top + chartHeight);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, top, 0, top + chartHeight);
  fill.addColorStop(0, 'rgba(185,245,30,0.38)');
  fill.addColorStop(1, 'rgba(185,245,30,0.02)');
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.font = font(22, 700);
  ctx.fillStyle = ACCENT;
  ctx.textAlign = 'left';
  ctx.fillText(`MIN ${Math.round(min)} m`, left, top - 14);
  ctx.textAlign = 'right';
  ctx.fillText(`MAKS ${Math.round(max)} m`, left + chartWidth, top - 14);
  ctx.restore();
}

/** Downsamples the track to a readable profile, or null without elevation. */
function elevationProfile(
  coordinates: LngLatEle[],
): { values: number[]; min: number; max: number } | null {
  if (coordinates.length < 4) return null;

  const elevations = coordinates
    .map((coordinate) => Number(coordinate[2]))
    .filter((value) => Number.isFinite(value) && value > -500);
  if (elevations.length < 4) return null;

  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  if (max - min < 2) return null;

  const samples = 72;
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const at = Math.round((index / (samples - 1)) * (elevations.length - 1));
    values.push(elevations[at]);
  }
  return { values, min, max };
}

/* ----------------------------------------------------------------- sticker */

function drawSticker(
  ctx: CanvasRenderingContext2D,
  input: ShareCardInput,
  width: number,
  height: number,
) {
  const { data, coordinates, mode, photo } = input;
  const position = input.statsPosition ?? 'bottom';

  // Both stickers must stay fully transparent unless a gallery photo fills them.
  ctx.clearRect(0, 0, width, height);
  if (photo) drawPhotoLayer(ctx, photo, width, height);
  if (input.photoBackdrop) drawStatsBackdrop(ctx, width, height, position);

  if (mode === 'route') {
    const box =
      position === 'top'
        ? { x: MARGIN, y: height * 0.3, width: width - MARGIN * 2, height: height * 0.5 }
        : { x: 100, y: height * 0.07, width: width - 200, height: height * 0.52 };
    drawRoute(ctx, coordinates, box, {
      casing: SHADOW,
      core: ACCENT,
      halo: 'rgba(185,245,30,0.35)',
    });
    drawStickerStats(
      ctx,
      data.stats,
      width,
      position === 'top' ? height * 0.22 : stickerStatsBaseline(height),
    );
    return;
  }

  drawStatsSticker(ctx, data, width, height, position);
}

/** Photo at cover fit, then zoom and pan around its centre. */
function drawPhotoLayer(
  ctx: CanvasRenderingContext2D,
  photo: SharePhoto,
  width: number,
  height: number,
) {
  const { width: iw, height: ih } = imageSize(photo.image);
  if (!iw || !ih) return;

  const zoom = Math.min(Math.max(photo.zoom, 1), 3);
  const scale = Math.max(width / iw, height / ih) * zoom;
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (width - dw) / 2 + photo.offsetX * width;
  const dy = (height - dh) / 2 + photo.offsetY * height;
  ctx.drawImage(photo.image, dx, dy, dw, dh);
}

/** Soft charcoal gradient behind the numbers so white type survives a photo. */
function drawStatsBackdrop(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  position: StatsPosition,
) {
  const gradient =
    position === 'top'
      ? ctx.createLinearGradient(0, 0, 0, height * 0.52)
      : ctx.createLinearGradient(0, height * 0.52, 0, height);

  gradient.addColorStop(position === 'top' ? 0 : 1, 'rgba(13,17,18,0.86)');
  gradient.addColorStop(0.55, 'rgba(13,17,18,0.45)');
  gradient.addColorStop(position === 'top' ? 1 : 0, 'rgba(13,17,18,0)');

  ctx.fillStyle = gradient;
  if (position === 'top') ctx.fillRect(0, 0, width, height * 0.52);
  else ctx.fillRect(0, height * 0.52, width, height * 0.48);
}

function drawStatsSticker(
  ctx: CanvasRenderingContext2D,
  data: ShareCardData,
  width: number,
  height: number,
  position: StatsPosition,
) {
  // With the stats on top the title block owns the lower third, but it must stop
  // above the watermark lockup instead of running underneath it.
  const titleBottom =
    position === 'top'
      ? height - height * WATERMARK_HEIGHT_RATIO - Math.round(height * 0.075)
      : height * 0.36;
  const statsBaseline = position === 'top' ? height * 0.18 : stickerStatsBaseline(height);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.shadowColor = SHADOW;
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 4;

  ctx.font = font(64, 800);
  const titleLines = wrapText(ctx, data.title, width - 240, 2);
  const titleFirstBaseline = titleBottom - 58 - (titleLines.length - 1) * 76;
  titleLines.forEach((line, index) => {
    ctx.fillText(line, width / 2, titleFirstBaseline + index * 76);
  });

  drawSportIcon(ctx, data.activityType, width / 2, titleFirstBaseline - 116, 74);

  ctx.font = font(28, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.fillText(data.date, width / 2, titleBottom);
  ctx.restore();

  drawStickerStats(ctx, data.stats, width, statsBaseline);
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

/* ------------------------------------------------------------------- utils */

function imageSize(image: HTMLImageElement | HTMLCanvasElement): {
  width: number;
  height: number;
} {
  if (image instanceof HTMLCanvasElement) {
    return { width: image.width, height: image.height };
  }
  return { width: image.naturalWidth, height: image.naturalHeight };
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
