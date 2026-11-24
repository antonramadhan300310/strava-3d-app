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
 * `poster` is the framed 3D map poster and `sticker` the transparent sticker
 * whose four layout presets live in `StickerLayout`.
 */
export type ShareCardMode = 'poster' | 'sticker';

/** Layout presets for the transparent sticker. */
export type StickerLayout = 'compact' | 'grid' | 'vertical-route' | 'vertical-clean';

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
export type StatsPosition = 'bottom' | 'center' | 'top';

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
  /** Poster grid: distance, gain, duration and speed/pace. */
  stats: ShareStat[];
  /** Sticker order: distance, gain, time, speed, max elevation, total duration. */
  metrics: ShareStat[];
};

const ACCENT = '#B9F51E';
const INK = '#0D1112';
const SHADOW = 'rgba(13,17,18,0.85)';
const STICKER_SHADOW = 'rgba(13,17,18,0.78)';
const STICKER_SHADOW_BLUR = 12;
const STICKER_SHADOW_OFFSET_Y = 2;

/**
 * Watermark lockup width as a share of the canvas width. Anchoring on the width
 * keeps the mark slim at every export size instead of growing with the height.
 */
export const WATERMARK_WIDTH_RATIO = 0.18;

const LOGO_BOX_WIDTH = 280;
const LOGO_BOX_HEIGHT = 64;

/** Shared watermark geometry for the poster, the stickers and the MP4 export. */
export function watermarkMetrics(width: number) {
  const logoWidth = width * WATERMARK_WIDTH_RATIO;
  return {
    logoWidth,
    logoHeight: (logoWidth * LOGO_BOX_HEIGHT) / LOGO_BOX_WIDTH,
    scale: logoWidth / LOGO_BOX_WIDTH,
    margin: Math.round(width * 0.035),
  };
}

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
  const maxElevation = maxElevationOf(activity);
  const elapsedSeconds = elapsedSecondsOf(activity);

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
    metrics: [
      { label: 'Jarak', value: `${formatDistanceKm(activity.distanceMeters).replace('.', ',')} km` },
      { label: 'Kenaikan Elev.', value: `${Math.round(activity.elevationGain)} m` },
      { label: 'Waktu', value: formatCompactDuration(activity.durationSeconds) },
      usesPace
        ? { label: 'Pace', value: `${formatPace(paceSecondsPerKm(speed))} /km` }
        : { label: 'Kecepatan', value: `${formatSpeed(speed)} km/j` },
      { label: 'Elev Maks', value: `${Math.round(maxElevation)} m` },
      { label: 'Total Durasi', value: formatCompactDuration(elapsedSeconds) },
    ],
  };
}

/** Highest DEM point of the track, falling back to the recorded gain. */
function maxElevationOf(activity: ActivityRecord): number {
  let max = -Infinity;
  for (const point of activity.coordinates) {
    const elevation = point[2];
    if (Number.isFinite(elevation) && elevation > max) max = elevation;
  }
  if (!Number.isFinite(max) || max <= 0) return activity.elevationGain;
  return max;
}

/**
 * Elapsed wall-clock time from the track timestamps. Some imports omit the time
 * dimension or carry a span far outside the recording, so anything implausible
 * falls back to the saved duration.
 */
function elapsedSecondsOf(activity: ActivityRecord): number {
  const times: number[] = [];
  for (const point of activity.coordinates) {
    const time = point[3];
    if (typeof time === 'number' && Number.isFinite(time)) times.push(time);
  }
  if (times.length < 2) return activity.durationSeconds;

  const millis = times[0] > 1e11;
  const span = (times[times.length - 1] - times[0]) / (millis ? 1000 : 1);
  const duration = activity.durationSeconds;
  if (!Number.isFinite(span) || span < duration || span > duration * 3) return duration;
  return span;
}

/** Compact Indonesian duration, e.g. `44m 50d` or `1j 12m`. */
function formatCompactDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) return `${hours}j ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}d`;
  return `${seconds}d`;
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
  /** Sticker preset; `compact` when omitted. */
  stickerLayout?: StickerLayout;
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

  if (input.mode === 'poster') {
    drawPoster(ctx, input, width, height);
    drawWatermark(ctx, width, height);
  } else {
    drawSticker(ctx, input, width, height);
  }

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
  const chartTop = elevationChartBottom(width, height) - ELEVATION_CHART_HEIGHT;
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
function elevationChartBottom(width: number, height: number): number {
  const { logoHeight, margin } = watermarkMetrics(width);
  return height - logoHeight - margin - Math.round(height * 0.026);
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
  const bottom = elevationChartBottom(width, height);
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

/** Logo lockup width for stickers: slimmer than the poster watermark. */
const STICKER_LOGO_WIDTH_RATIO = 0.21;
const STICKER_LOGO_BOX_WIDTH = 280;
const STICKER_LOGO_BOX_HEIGHT = 64;

type StickerGeometry = {
  /** 1 at the 1080 px reference width; scales every size below. */
  unit: number;
  margin: number;
  logoScale: number;
  logoWidth: number;
  logoHeight: number;
};

function stickerGeometry(width: number): StickerGeometry {
  const logoWidth = width * STICKER_LOGO_WIDTH_RATIO;
  return {
    unit: width / 1080,
    margin: MARGIN * (width / 1080),
    logoScale: logoWidth / STICKER_LOGO_BOX_WIDTH,
    logoWidth,
    logoHeight: (logoWidth * STICKER_LOGO_BOX_HEIGHT) / STICKER_LOGO_BOX_WIDTH,
  };
}

function drawSticker(
  ctx: CanvasRenderingContext2D,
  input: ShareCardInput,
  width: number,
  height: number,
) {
  const { data, coordinates, photo } = input;
  const position = input.statsPosition ?? 'bottom';
  const layout = input.stickerLayout ?? 'compact';

  // Stickers must stay fully transparent unless a gallery photo fills them.
  ctx.clearRect(0, 0, width, height);
  if (photo) drawPhotoLayer(ctx, photo, width, height);
  if (input.photoBackdrop) drawStatsBackdrop(ctx, width, height, position);

  if (layout === 'compact') drawCompactSticker(ctx, data, width, height, position);
  else if (layout === 'grid') drawGridSticker(ctx, data, width, height, position);
  else {
    drawVerticalSticker(
      ctx,
      data,
      coordinates,
      width,
      height,
      position,
      layout === 'vertical-route',
    );
  }
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
  if (position === 'center') {
    const band = ctx.createLinearGradient(0, height * 0.16, 0, height * 0.84);
    band.addColorStop(0, 'rgba(13,17,18,0)');
    band.addColorStop(0.5, 'rgba(13,17,18,0.78)');
    band.addColorStop(1, 'rgba(13,17,18,0)');
    ctx.fillStyle = band;
    ctx.fillRect(0, height * 0.16, width, height * 0.68);
    return;
  }

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

function stickerShadow(ctx: CanvasRenderingContext2D) {
  ctx.shadowColor = STICKER_SHADOW;
  ctx.shadowBlur = STICKER_SHADOW_BLUR;
  ctx.shadowOffsetY = STICKER_SHADOW_OFFSET_Y;
}

/** Top of the stat block for the chosen vertical position. */
function stickerBlockTop(
  height: number,
  position: StatsPosition,
  blockHeight: number,
): number {
  const safe = Math.round(height * 0.06);
  if (position === 'top') return safe + Math.round(height * 0.01);
  if (position === 'center') return Math.max(safe, Math.round((height - blockHeight) / 2));
  return Math.round(height - safe - Math.round(height * 0.03) - blockHeight);
}

/** Sport glyph followed by the slim ALLMOVA lockup; returns the header height. */
function drawStickerHeader(
  ctx: CanvasRenderingContext2D,
  activityType: ActivityType,
  x: number,
  top: number,
  width: number,
  geometry: StickerGeometry,
  align: 'left' | 'center',
): number {
  const { logoScale, logoWidth, logoHeight, unit } = geometry;

  ctx.save();
  stickerShadow(ctx);
  let logoX = x + (width - logoWidth) / 2;
  if (align === 'left') {
    const iconSize = 44 * unit;
    drawSportIcon(ctx, activityType, x + iconSize / 2, top + logoHeight / 2, iconSize, '#FFFFFF');
    logoX = x + iconSize + 20 * unit;
  }
  drawAllmovaLogoOnCanvas(ctx, logoX, top, logoScale, { variant: 'compact' });
  ctx.restore();

  return logoHeight;
}

function drawStickerMetric(
  ctx: CanvasRenderingContext2D,
  stat: ShareStat,
  x: number,
  labelBaseline: number,
  valueBaseline: number,
  maxWidth: number,
  valueSize: number,
  labelSize: number,
  align: CanvasTextAlign,
) {
  ctx.save();
  ctx.textAlign = align;
  stickerShadow(ctx);

  ctx.font = font(labelSize, 700);
  ctx.fillStyle = 'rgba(255,255,255,0.84)';
  ctx.fillText(stat.label.toUpperCase(), x, labelBaseline);

  const size = fitFontSize(
    ctx,
    stat.value,
    maxWidth,
    valueSize,
    800,
    Math.round(valueSize * 0.62),
  );
  ctx.font = font(size, 800);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(stat.value, x, valueBaseline);
  ctx.restore();
}

/** Preset 1: left aligned lockup with one row of three metrics. */
function drawCompactSticker(
  ctx: CanvasRenderingContext2D,
  data: ShareCardData,
  width: number,
  height: number,
  position: StatsPosition,
) {
  const geometry = stickerGeometry(width);
  const u = geometry.unit;
  const contentWidth = width - geometry.margin * 2;
  const labelSize = 22 * u;
  const valueSize = 54 * u;
  const headerGap = 32 * u;
  const labelOffset = 34 * u;
  const valueOffset = 96 * u;

  const blockHeight = geometry.logoHeight + headerGap + valueOffset + 10 * u;
  const top = stickerBlockTop(height, position, blockHeight);
  const headerHeight = drawStickerHeader(
    ctx,
    data.activityType,
    geometry.margin,
    top,
    contentWidth,
    geometry,
    'left',
  );

  const metricsTop = top + headerHeight + headerGap;
  const columns = data.metrics.slice(0, 3);
  const columnWidth = contentWidth / columns.length;

  columns.forEach((stat, index) => {
    drawStickerMetric(
      ctx,
      stat,
      geometry.margin + columnWidth * index,
      metricsTop + labelOffset,
      metricsTop + valueOffset,
      columnWidth - 18 * u,
      valueSize,
      labelSize,
      'left',
    );
  });
}

/** Preset 2: left aligned lockup with a 2×3 metric grid. */
function drawGridSticker(
  ctx: CanvasRenderingContext2D,
  data: ShareCardData,
  width: number,
  height: number,
  position: StatsPosition,
) {
  const geometry = stickerGeometry(width);
  const u = geometry.unit;
  const contentWidth = width - geometry.margin * 2;
  const labelSize = 22 * u;
  const valueSize = 46 * u;
  const headerGap = 32 * u;
  const labelOffset = 32 * u;
  const valueOffset = 88 * u;
  const rowGap = 116 * u;

  const blockHeight = geometry.logoHeight + headerGap + valueOffset + rowGap + 8 * u;
  const top = stickerBlockTop(height, position, blockHeight);
  const headerHeight = drawStickerHeader(
    ctx,
    data.activityType,
    geometry.margin,
    top,
    contentWidth,
    geometry,
    'left',
  );

  const metricsTop = top + headerHeight + headerGap;
  const columnWidth = contentWidth / 3;
  const rows = [
    [0, 1, 4],
    [2, 3, 5],
  ];

  rows.forEach((row, rowIndex) => {
    row.forEach((metricIndex, columnIndex) => {
      const stat = data.metrics[metricIndex];
      if (!stat) return;
      const rowTop = metricsTop + rowIndex * rowGap;
      drawStickerMetric(
        ctx,
        stat,
        geometry.margin + columnWidth * columnIndex,
        rowTop + labelOffset,
        rowTop + valueOffset,
        columnWidth - 18 * u,
        valueSize,
        labelSize,
        'left',
      );
    });
  });
}

/** Presets 3 and 4: centred lockup above six stacked metrics. */
function drawVerticalSticker(
  ctx: CanvasRenderingContext2D,
  data: ShareCardData,
  coordinates: LngLatEle[],
  width: number,
  height: number,
  position: StatsPosition,
  withRoute: boolean,
) {
  const geometry = stickerGeometry(width);
  const u = geometry.unit;
  const contentWidth = width - geometry.margin * 2;
  const labelSize = 22 * u;
  const valueSize = 44 * u;
  const logoGap = 40 * u;
  const labelOffset = 30 * u;
  const valueOffset = 78 * u;
  const rowStep = 100 * u;
  // The route accent needs breathing room between the third and fourth metric.
  const routeGap = withRoute ? 64 * u : 0;

  const blockHeight =
    geometry.logoHeight + logoGap + rowStep * 5 + routeGap + valueOffset + 10 * u;
  const top = stickerBlockTop(height, position, blockHeight);
  const headerHeight = drawStickerHeader(
    ctx,
    data.activityType,
    geometry.margin,
    top,
    contentWidth,
    geometry,
    'center',
  );

  const rowsTop = top + headerHeight + logoGap;
  const rowTop = (index: number) =>
    rowsTop + index * rowStep + (withRoute && index >= 3 ? routeGap : 0);

  if (withRoute) {
    const yMid = (rowTop(2) + valueOffset + rowTop(3) + labelOffset) / 2;
    drawRoute(
      ctx,
      coordinates,
      { x: geometry.margin, y: yMid - 85 * u, width: contentWidth, height: 170 * u },
      { casing: SHADOW, core: ACCENT, halo: 'rgba(185,245,30,0.28)' },
      { stroke: { halo: 18 * u, casing: 12 * u, core: 5.5 * u }, badges: false },
    );
  }

  data.metrics.forEach((stat, index) => {
    const row = rowTop(index);
    drawStickerMetric(
      ctx,
      stat,
      width / 2,
      row + labelOffset,
      row + valueOffset,
      contentWidth - 40 * u,
      valueSize,
      labelSize,
      'center',
    );
  });
}

/** Neon route with a dark casing so it reads on any photo underneath. */
function drawRoute(
  ctx: CanvasRenderingContext2D,
  coordinates: LngLatEle[],
  box: { x: number; y: number; width: number; height: number },
  colors: { casing: string; core: string; halo: string },
  options: {
    stroke?: { halo: number; casing: number; core: number };
    badges?: boolean;
  } = {},
) {
  const points = projectCoordinates(coordinates, box);
  if (points.length < 2) return;

  const stroke = { halo: 34, casing: 24, core: 13, ...options.stroke };

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
  ctx.lineWidth = stroke.halo;
  ctx.stroke();

  trace();
  ctx.strokeStyle = colors.casing;
  ctx.lineWidth = stroke.casing;
  ctx.stroke();

  trace();
  ctx.strokeStyle = colors.core;
  ctx.lineWidth = stroke.core;
  ctx.stroke();
  ctx.restore();

  if (options.badges === false) return;

  const start = points[0];
  const end = points[points.length - 1];
  drawRouteEndpointBadge(ctx, 'start', start.x, start.y, 17);
  drawRouteEndpointBadge(ctx, 'finish', end.x, end.y, 19);
}

/** Sport glyph for the sticker header. */
function drawSportIcon(
  ctx: CanvasRenderingContext2D,
  activityType: ActivityType,
  centerX: number,
  centerY: number,
  size: number,
  color: string,
) {
  ctx.save();
  ctx.translate(centerX - size / 2, centerY - size / 2);
  ctx.scale(size / 64, size / 64);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 4.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  stickerShadow(ctx);

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
 * Slim ALLMOVA lockup in the bottom-right corner of the poster.
 *
 * Every tier gets it, so a Free and a Pro export stay visually consistent and
 * the brand rides along on every share. Sizing from the width keeps the mark
 * proportionate at both the 4:5 and 9:16 ratios.
 */
function drawWatermark(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const { logoWidth, logoHeight, scale, margin } = watermarkMetrics(width);

  ctx.save();
  ctx.shadowColor = 'rgba(13,17,18,0.55)';
  ctx.shadowBlur = 14;
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
