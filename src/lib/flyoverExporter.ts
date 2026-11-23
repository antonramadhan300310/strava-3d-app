import { Muxer, StreamTarget } from 'mp4-muxer';
import { allmovaFontStack, drawAllmovaLogoOnCanvas } from '@/components/AllmovaLogo';
import { WATERMARK_HEIGHT_RATIO } from './shareCard';
import { formatActivityDate, type ActivityRecord } from './activity';
import {
  averageSpeedKmh,
  formatDistanceKm,
  formatDuration,
  formatPace,
  formatSpeed,
  paceSecondsPerKm,
} from './metrics';

export type FlyoverExportFps = 30 | 60;

export const FLYOVER_EXPORT_WIDTH = 720;
export const FLYOVER_EXPORT_HEIGHT = 1280;
export const FLYOVER_EXPORT_MIN_SECONDS = 10;
export const FLYOVER_EXPORT_MAX_SECONDS = 60;
/** Above this length the bitrate drops so the file stays around 35–42 MB. */
export const FLYOVER_EXPORT_LONG_SECONDS = 30;
/** From this length on, resolution and bitrate switch to the 720p memory budget. */
export const FLYOVER_EXPORT_ADAPTIVE_SECONDS = 45;
/** Longest canvas side for 45–60 s clips; 720p portrait fits inside it. */
export const FLYOVER_EXPORT_MAX_LONG_SIDE = 1280;
/** 4 Mbps target for long clips, small enough for low-RAM Android WebViews. */
export const FLYOVER_EXPORT_LONG_BITRATE = 4_000_000;
/** Bytes buffered per StreamTarget chunk before it is handed to the caller. */
const STREAM_CHUNK_BYTES = 1 << 20;
/** Frames allowed in the encoder queue before the loop waits for it to drain. */
const ENCODE_QUEUE_LIMIT = 3;

/** Hard cap per frame so a slow tile fetch cannot stall the whole export. */
export const EXPORT_FRAME_TIMEOUT_MS = 350;

/** H.264 High then Baseline, the profiles Android WebView usually hardware-encodes. */
const H264_CODECS = ['avc1.4d002a', 'avc1.42001f'] as const;

export const UNSUPPORTED_MESSAGE =
  'Perangkat ini belum mendukung Export MP4 langsung. Gunakan tombol Mode Bersih (ikon mata) + Rekam Layar HP.';

export type FlyoverExportQuality = {
  fps: FlyoverExportFps;
  bitrate: number;
  /** Canvas size for this clip; both sides are always even for H.264. */
  width: number;
  height: number;
  /** Short label used by the quality picker. */
  label: string;
  hint: string;
  /** Label shown in the progress overlay and the finished card. */
  qualityLabel: string;
  totalFrames: number;
};

export type FlyoverExportDimensions = { width: number; height: number };

/** 2 km or less → 10 s, 20 km or more → 60 s, linear in between. */
export function calculateFlyoverDuration(distanceMeters: number): number {
  const distanceKm = distanceMeters / 1000;
  if (distanceKm <= 2) return FLYOVER_EXPORT_MIN_SECONDS;
  if (distanceKm >= 20) return FLYOVER_EXPORT_MAX_SECONDS;
  return Math.round(
    FLYOVER_EXPORT_MIN_SECONDS + ((distanceKm - 2) / 18) * 50,
  );
}

/** H.264 `avc1` needs even dimensions on every Android encoder. */
function evenFloor(value: number): number {
  return Math.floor(value / 2) * 2;
}

/**
 * Keeps the canvas inside the memory budget of long clips: 45–60 s renders are
 * capped to a 1280 px longest side, which is exactly the 720×1280 portrait frame.
 */
export function resolveFlyoverExportDimensions(
  durationSeconds: number,
): FlyoverExportDimensions {
  const base = { width: FLYOVER_EXPORT_WIDTH, height: FLYOVER_EXPORT_HEIGHT };
  if (durationSeconds < FLYOVER_EXPORT_ADAPTIVE_SECONDS) {
    return { width: evenFloor(base.width), height: evenFloor(base.height) };
  }

  const longest = Math.max(base.width, base.height);
  const scale = Math.min(1, FLYOVER_EXPORT_MAX_LONG_SIDE / longest);
  return {
    width: evenFloor(base.width * scale),
    height: evenFloor(base.height * scale),
  };
}

export function flyoverExportBitrate(
  fps: FlyoverExportFps,
  durationSeconds: number,
): number {
  if (durationSeconds >= FLYOVER_EXPORT_ADAPTIVE_SECONDS) {
    return FLYOVER_EXPORT_LONG_BITRATE;
  }
  const long = durationSeconds > FLYOVER_EXPORT_LONG_SECONDS;
  if (fps === 30) return long ? 3_500_000 : 4_500_000;
  return long ? 5_500_000 : 7_500_000;
}

export function buildFlyoverExportQualities(
  durationSeconds: number,
): Record<FlyoverExportFps, FlyoverExportQuality> {
  const { width, height } = resolveFlyoverExportDimensions(durationSeconds);
  return {
    30: {
      fps: 30,
      bitrate: flyoverExportBitrate(30, durationSeconds),
      width,
      height,
      label: '30fps (Cepat)',
      hint: 'Render cepat • Cocok untuk WhatsApp',
      qualityLabel: '720p 30fps',
      totalFrames: 30 * durationSeconds,
    },
    60: {
      fps: 60,
      bitrate: flyoverExportBitrate(60, durationSeconds),
      width,
      height,
      label: '60fps (Mulus)',
      hint: 'Gerakan ekstra halus • Cocok untuk IG Story',
      qualityLabel: '720p 60fps',
      totalFrames: 60 * durationSeconds,
    },
  };
}

export type FlyoverExportHud = {
  title: string;
  date: string;
  badge: string;
  distanceKm: string;
  elevationMeters: string;
  duration: string;
  paceLabel: string;
  paceValue: string;
};

/** A captured map frame plus the marker's normalised position inside it. */
export type FlyoverFrameCapture = {
  image: HTMLCanvasElement;
  /** Marker position as a 0–1 fraction of the captured canvas. */
  markerX: number;
  markerY: number;
};

export type ExportFlyoverVideoOptions = {
  fps: FlyoverExportFps;
  /** Auto duration from `calculateFlyoverDuration`; drives frames and bitrate. */
  durationSeconds: number;
  hud: FlyoverExportHud;
  /** Draws the ALLMOVA mark on every frame. On by default for every tier. */
  watermark?: boolean;
  /** Drives the map to `progress` and returns the rendered frame. */
  captureFrame: (progress: number) => Promise<FlyoverFrameCapture | null>;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
};

export class FlyoverExportUnsupportedError extends Error {
  constructor() {
    super(UNSUPPORTED_MESSAGE);
    this.name = 'FlyoverExportUnsupportedError';
  }
}

export class FlyoverExportAbortedError extends Error {
  constructor() {
    super('Export dibatalkan.');
    this.name = 'FlyoverExportAbortedError';
  }
}

export function buildFlyoverExportHud(activity: ActivityRecord): FlyoverExportHud {
  const speed = averageSpeedKmh(activity.distanceMeters, activity.durationSeconds);
  const usesPace = activity.activityType !== 'cycling';

  return {
    title: activity.title,
    date: formatActivityDate(activity.createdAt),
    badge: activity.activityType.toUpperCase(),
    distanceKm: formatDistanceKm(activity.distanceMeters),
    elevationMeters: String(Math.round(activity.elevationGain)),
    duration: formatDuration(activity.durationSeconds),
    paceLabel: usesPace ? 'PACE' : 'KECEPATAN',
    paceValue: usesPace
      ? `${formatPace(paceSecondsPerKm(speed))} /km`
      : `${formatSpeed(speed)} km/j`,
  };
}

/** Returns an H.264 codec string the device can encode at this quality, or null. */
export async function pickSupportedH264Codec(
  fps: FlyoverExportFps,
  bitrate: number,
  dimensions: FlyoverExportDimensions = resolveFlyoverExportDimensions(0),
): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null;

  for (const codec of H264_CODECS) {
    try {
      const support = await VideoEncoder.isConfigSupported(
        buildEncoderConfig(codec, fps, bitrate, dimensions),
      );
      if (support.supported) return codec;
    } catch {
      // An unsupported profile can reject instead of returning `supported: false`.
    }
  }
  return null;
}

export function isFlyoverExportSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

function buildEncoderConfig(
  codec: string,
  fps: FlyoverExportFps,
  bitrate: number,
  { width, height }: FlyoverExportDimensions,
): VideoEncoderConfig {
  return {
    codec,
    width,
    height,
    framerate: fps,
    bitrate,
    latencyMode: 'quality',
    // mp4-muxer expects AVCC length-prefixed samples rather than Annex B.
    avc: { format: 'avc' },
  };
}

/** Muxed MP4 bytes, split into chunks so no single huge buffer is allocated. */
export type FlyoverVideo = {
  size: number;
  /** File-order chunks. Empty after `toBlob()` or `dispose()`. */
  chunks: Uint8Array[];
  /** Builds the Blob and immediately releases the chunk references. */
  toBlob: () => Blob;
  /** Drops the chunk references so the JS heap can be reclaimed. */
  dispose: () => void;
};

/**
 * Renders the flyover frame-by-frame, muxes H.264 into an MP4 and returns it as
 * chunked bytes. Everything runs on-device: no network, no ffmpeg, no Supabase
 * writes.
 */
export async function exportFlyoverVideo({
  fps,
  durationSeconds,
  hud,
  watermark = true,
  captureFrame,
  signal,
  onProgress,
}: ExportFlyoverVideoOptions): Promise<FlyoverVideo> {
  const quality = buildFlyoverExportQualities(durationSeconds)[fps];
  const codec = await pickSupportedH264Codec(fps, quality.bitrate, quality);
  if (!codec) throw new FlyoverExportUnsupportedError();

  const canvas = document.createElement('canvas');
  canvas.width = quality.width;
  canvas.height = quality.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Kanvas video tidak tersedia di perangkat ini.');

  const parts: StreamPart[] = [];
  const target = new StreamTarget({
    chunked: true,
    chunkSize: STREAM_CHUNK_BYTES,
    onData: (data, position) => {
      parts.push({ position, data });
    },
  });
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width: quality.width,
      height: quality.height,
      frameRate: fps,
    },
    // Reserves the moov space up front and streams media as it is encoded, so
    // memory stays flat instead of growing into one giant buffer.
    fastStart: { expectedVideoChunks: quality.totalFrames },
  });

  let encoderError: Error | null = null;
  let encoder: VideoEncoder;
  try {
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (error) => {
        encoderError = error instanceof Error ? error : new Error(String(error));
      },
    });
    encoder.configure(buildEncoderConfig(codec, fps, quality.bitrate, quality));
  } catch {
    // Some WebViews advertise H.264 but fail once the encoder is configured.
    throw new FlyoverExportUnsupportedError();
  }

  const totalFrames = quality.totalFrames;
  const frameDurationMicros = Math.round(1_000_000 / fps);

  try {
    for (let index = 0; index < totalFrames; index += 1) {
      throwIfAborted(signal);
      if (encoderError) throw encoderError;

      // Backpressure before capturing the next map frame: an unbounded queue
      // holds hundreds of raw frames in RAM and gets the WebView killed.
      await waitForEncoderQueue(encoder, signal);

      // Deterministic progress, so a dropped frame never shifts the camera.
      const progress = totalFrames > 1 ? index / (totalFrames - 1) : 0;

      const frame = await captureFrame(progress);
      throwIfAborted(signal);

      context.fillStyle = '#0D1112';
      context.fillRect(0, 0, quality.width, quality.height);
      if (frame) drawCapturedFrame(context, frame, quality.width, quality.height);
      drawHud(context, hud, progress, quality.width, quality.height);
      if (watermark) drawVideoWatermark(context, quality.width, quality.height);

      let videoFrame: VideoFrame | null = null;
      try {
        videoFrame = new VideoFrame(canvas, {
          timestamp: Math.round(index * frameDurationMicros),
          duration: frameDurationMicros,
        });
        encoder.encode(videoFrame, { keyFrame: index % fps === 0 });
      } finally {
        // Releasing the GPU texture every frame keeps memory flat up to 60 s.
        videoFrame?.close();
      }

      // Yields to the UI so the progress percentage can repaint.
      await delay(0);

      onProgress?.((index + 1) / totalFrames);
    }

    await encoder.flush();
    throwIfAborted(signal);
    if (encoderError) throw encoderError;

    muxer.finalize();

    const chunks = mergeStreamParts(parts);
    parts.length = 0;
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);

    return {
      size,
      chunks,
      toBlob: () => {
        const blob = new Blob(chunks as unknown as BlobPart[], { type: 'video/mp4' });
        chunks.length = 0;
        return blob;
      },
      dispose: () => {
        chunks.length = 0;
      },
    };
  } finally {
    // Frees the canvas backing store; the encoded frames are already muxed.
    canvas.width = 0;
    canvas.height = 0;
    if (encoder.state !== 'closed') encoder.close();
  }
}

/**
 * Base64-encodes bytes for `@capacitor/filesystem`. Chunked so a multi-MB
 * buffer never overflows the call stack via `String.fromCharCode(...)`.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    parts.push(String.fromCharCode.apply(null, Array.from(chunk)));
  }
  return btoa(parts.join(''));
}

type StreamPart = { position: number; data: Uint8Array };

/**
 * Turns StreamTarget writes into contiguous, file-order chunks.
 *
 * `mp4-muxer` patches the `mdat` header (and, with Fast Start, the `moov` box)
 * after the media data has already been streamed out, so a later write to an
 * already-written range must replace the earlier bytes.
 */
function mergeStreamParts(parts: StreamPart[]): Uint8Array[] {
  const segments: StreamPart[] = [];

  for (const part of parts) {
    const start = part.position;
    const end = start + part.data.byteLength;
    const next: StreamPart[] = [];

    for (const segment of segments) {
      const segmentEnd = segment.position + segment.data.byteLength;
      if (segmentEnd <= start || segment.position >= end) {
        next.push(segment);
        continue;
      }
      if (segment.position < start) {
        next.push({
          position: segment.position,
          data: segment.data.subarray(0, start - segment.position),
        });
      }
      if (segmentEnd > end) {
        next.push({ position: end, data: segment.data.subarray(end - segment.position) });
      }
    }

    next.push(part);
    segments.length = 0;
    segments.push(...next);
  }

  segments.sort((a, b) => a.position - b.position);

  // Reserved `free` boxes are skipped by the writer, so a gap must be filled
  // with zeros to keep every following byte at its real file offset.
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.position > cursor) {
      chunks.push(new Uint8Array(segment.position - cursor));
    }
    chunks.push(segment.data);
    cursor = segment.position + segment.data.byteLength;
  }
  return chunks;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new FlyoverExportAbortedError();
}

/** Waits until the encoder queue has room for another frame. */
async function waitForEncoderQueue(encoder: VideoEncoder, signal?: AbortSignal) {
  while (encoder.encodeQueueSize >= ENCODE_QUEUE_LIMIT) {
    throwIfAborted(signal);
    await delay(12);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Aspect-fill (`cover`) so the 9:16 video is never squashed. */
function drawCapturedFrame(
  context: CanvasRenderingContext2D,
  frame: FlyoverFrameCapture,
  width: number,
  height: number,
) {
  const source = frame.image;
  if (source.width === 0 || source.height === 0) return;

  const scale = Math.max(width / source.width, height / source.height);
  const drawWidth = source.width * scale;
  const drawHeight = source.height * scale;
  const x = (width - drawWidth) / 2;
  const y = (height - drawHeight) / 2;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, x, y, drawWidth, drawHeight);

  // MapLibre HTML markers live outside the WebGL buffer, so the moving marker
  // is painted here using its projected position in the captured frame.
  const markerX = x + frame.markerX * drawWidth;
  const markerY = y + frame.markerY * drawHeight;
  const markerScale = width / FLYOVER_EXPORT_WIDTH;
  context.save();
  context.beginPath();
  context.arc(markerX, markerY, 22 * markerScale, 0, Math.PI * 2);
  context.fillStyle = 'rgba(185,245,30,0.28)';
  context.fill();
  context.beginPath();
  context.arc(markerX, markerY, 12 * markerScale, 0, Math.PI * 2);
  context.fillStyle = '#B9F51E';
  context.fill();
  context.lineWidth = 4 * markerScale;
  context.strokeStyle = '#ffffff';
  context.stroke();
  context.restore();
}

function font(size: number, weight: number | string = 600): string {
  return `${weight} ${size}px ${allmovaFontStack()}`;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function truncateText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (context.measureText(text).width <= maxWidth) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (context.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}…`;
}

const HUD_MARGIN = 40;
const CARD_HEIGHT = 236;

function drawHud(
  context: CanvasRenderingContext2D,
  hud: FlyoverExportHud,
  progress: number,
  width: number,
  height: number,
) {
  // Layout is authored in the 720×1280 design space and scaled as a whole.
  const scale = Math.min(
    width / FLYOVER_EXPORT_WIDTH,
    height / FLYOVER_EXPORT_HEIGHT,
  );
  context.save();
  if (scale !== 1) context.scale(scale, scale);

  const designWidth = FLYOVER_EXPORT_WIDTH;
  const designHeight = FLYOVER_EXPORT_HEIGHT;

  const scrim = context.createLinearGradient(0, 0, 0, 340);
  scrim.addColorStop(0, 'rgba(13,17,18,0.88)');
  scrim.addColorStop(1, 'rgba(13,17,18,0)');
  context.fillStyle = scrim;
  context.fillRect(0, 0, designWidth, 340);

  context.textAlign = 'left';
  context.textBaseline = 'middle';

  context.font = font(24, 800);
  const badgeWidth = context.measureText(hud.badge).width + 44;
  roundedRect(context, HUD_MARGIN, 56, badgeWidth, 46, 23);
  context.fillStyle = '#B9F51E';
  context.fill();
  context.fillStyle = '#0D1112';
  context.fillText(hud.badge, HUD_MARGIN + 22, 80);

  context.font = font(42, 700);
  context.fillStyle = '#f8fafc';
  context.fillText(truncateText(context, hud.title, designWidth - HUD_MARGIN * 2), HUD_MARGIN, 152);

  context.font = font(24, 500);
  context.fillStyle = 'rgba(203,213,225,0.92)';
  context.fillText(
    truncateText(context, hud.date, designWidth - HUD_MARGIN * 2),
    HUD_MARGIN,
    202,
  );

  const cardX = 32;
  const cardY = designHeight - CARD_HEIGHT - 40;
  const cardWidth = designWidth - cardX * 2;

  roundedRect(context, cardX, cardY, cardWidth, CARD_HEIGHT, 28);
  context.fillStyle = 'rgba(21,27,29,0.82)';
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = 'rgba(255,255,255,0.14)';
  context.stroke();

  const cells = [
    { label: 'JARAK', value: `${hud.distanceKm} km` },
    { label: 'ELEVASI', value: `${hud.elevationMeters} m` },
    { label: 'DURASI', value: hud.duration },
    { label: hud.paceLabel, value: hud.paceValue },
  ];
  const innerWidth = cardWidth - 48;
  const cellWidth = innerWidth / cells.length;

  cells.forEach((cell, index) => {
    const centerX = cardX + 24 + cellWidth * index + cellWidth / 2;
    context.textAlign = 'center';

    context.font = font(20, 600);
    context.fillStyle = 'rgba(148,163,184,0.95)';
    context.fillText(cell.label, centerX, cardY + 58);

    context.font = font(30, 700);
    context.fillStyle = '#f8fafc';
    context.fillText(truncateText(context, cell.value, cellWidth - 8), centerX, cardY + 112);
  });

  const barX = cardX + 24;
  const barY = cardY + CARD_HEIGHT - 58;
  const barWidth = cardWidth - 48;
  const barHeight = 12;
  const clamped = Math.min(Math.max(progress, 0), 1);

  roundedRect(context, barX, barY, barWidth, barHeight, barHeight / 2);
  context.fillStyle = 'rgba(148,163,184,0.28)';
  context.fill();

  const fillWidth = Math.max(barHeight, barWidth * clamped);
  roundedRect(context, barX, barY, fillWidth, barHeight, barHeight / 2);
  context.fillStyle = '#B9F51E';
  context.fill();

  context.textAlign = 'right';
  context.font = font(20, 600);
  context.fillStyle = 'rgba(203,213,225,0.9)';
  context.fillText(`${Math.round(clamped * 100)}%`, barX + barWidth, barY - 20);
  context.textAlign = 'left';
  context.restore();
}

/**
 * Bottom-right ALLMOVA lockup on every export, free or pro.
 *
 * The height tracks the frame so the mark keeps the same relative weight at
 * every export quality instead of shrinking with the width.
 */
function drawVideoWatermark(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const logoHeight = height * WATERMARK_HEIGHT_RATIO;
  const scale = logoHeight / 64;
  const logoWidth = 280 * scale;
  const margin = Math.round(width * 0.035);
  drawAllmovaLogoOnCanvas(
    context,
    width - logoWidth - margin,
    height - logoHeight - margin,
    scale,
    { variant: 'compact', opacity: 0.94 },
  );
}
