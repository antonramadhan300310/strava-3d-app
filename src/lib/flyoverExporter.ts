import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
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

/** Hard cap per frame so a slow tile fetch cannot stall the whole export. */
export const EXPORT_FRAME_TIMEOUT_MS = 350;

/** H.264 High then Baseline, the profiles Android WebView usually hardware-encodes. */
const H264_CODECS = ['avc1.4d002a', 'avc1.42001f'] as const;

export const UNSUPPORTED_MESSAGE =
  'Perangkat ini belum mendukung Export MP4 langsung. Gunakan tombol Mode Bersih (ikon mata) + Rekam Layar HP.';

export type FlyoverExportQuality = {
  fps: FlyoverExportFps;
  bitrate: number;
  /** Short label used by the quality picker. */
  label: string;
  hint: string;
  /** Label shown in the progress overlay and the finished card. */
  qualityLabel: string;
  totalFrames: number;
};

/** 2 km or less → 10 s, 20 km or more → 60 s, linear in between. */
export function calculateFlyoverDuration(distanceMeters: number): number {
  const distanceKm = distanceMeters / 1000;
  if (distanceKm <= 2) return FLYOVER_EXPORT_MIN_SECONDS;
  if (distanceKm >= 20) return FLYOVER_EXPORT_MAX_SECONDS;
  return Math.round(
    FLYOVER_EXPORT_MIN_SECONDS + ((distanceKm - 2) / 18) * 50,
  );
}

export function flyoverExportBitrate(
  fps: FlyoverExportFps,
  durationSeconds: number,
): number {
  const long = durationSeconds > FLYOVER_EXPORT_LONG_SECONDS;
  if (fps === 30) return long ? 3_500_000 : 4_500_000;
  return long ? 5_500_000 : 7_500_000;
}

export function buildFlyoverExportQualities(
  durationSeconds: number,
): Record<FlyoverExportFps, FlyoverExportQuality> {
  return {
    30: {
      fps: 30,
      bitrate: flyoverExportBitrate(30, durationSeconds),
      label: '30fps (Cepat)',
      hint: 'Render cepat • Cocok untuk WhatsApp',
      qualityLabel: '720p 30fps',
      totalFrames: 30 * durationSeconds,
    },
    60: {
      fps: 60,
      bitrate: flyoverExportBitrate(60, durationSeconds),
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
): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null;

  for (const codec of H264_CODECS) {
    try {
      const support = await VideoEncoder.isConfigSupported(
        buildEncoderConfig(codec, fps, bitrate),
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
): VideoEncoderConfig {
  return {
    codec,
    width: FLYOVER_EXPORT_WIDTH,
    height: FLYOVER_EXPORT_HEIGHT,
    framerate: fps,
    bitrate,
    latencyMode: 'quality',
    // mp4-muxer expects AVCC length-prefixed samples rather than Annex B.
    avc: { format: 'avc' },
  };
}

/**
 * Renders the flyover frame-by-frame, muxes H.264 into an MP4 and returns it as
 * a Blob. Everything runs on-device: no network, no ffmpeg, no Supabase writes.
 */
export async function exportFlyoverVideo({
  fps,
  durationSeconds,
  hud,
  captureFrame,
  signal,
  onProgress,
}: ExportFlyoverVideoOptions): Promise<Blob> {
  const quality = buildFlyoverExportQualities(durationSeconds)[fps];
  const codec = await pickSupportedH264Codec(fps, quality.bitrate);
  if (!codec) throw new FlyoverExportUnsupportedError();

  const canvas = document.createElement('canvas');
  canvas.width = FLYOVER_EXPORT_WIDTH;
  canvas.height = FLYOVER_EXPORT_HEIGHT;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Kanvas video tidak tersedia di perangkat ini.');

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width: FLYOVER_EXPORT_WIDTH,
      height: FLYOVER_EXPORT_HEIGHT,
      frameRate: fps,
    },
    fastStart: 'in-memory',
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
    encoder.configure(buildEncoderConfig(codec, fps, quality.bitrate));
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

      // Deterministic progress, so a dropped frame never shifts the camera.
      const progress = totalFrames > 1 ? index / (totalFrames - 1) : 0;

      const frame = await captureFrame(progress);
      throwIfAborted(signal);

      context.fillStyle = '#0f172a';
      context.fillRect(0, 0, FLYOVER_EXPORT_WIDTH, FLYOVER_EXPORT_HEIGHT);
      if (frame) drawCapturedFrame(context, frame);
      drawHud(context, hud, progress);

      const videoFrame = new VideoFrame(canvas, {
        timestamp: Math.round(index * frameDurationMicros),
        duration: frameDurationMicros,
      });
      encoder.encode(videoFrame, { keyFrame: index % fps === 0 });
      // Closing right away keeps GPU/CPU memory flat even on 3 600-frame clips.
      videoFrame.close();

      await drainEncoder(encoder, signal);

      onProgress?.((index + 1) / totalFrames);
    }

    await encoder.flush();
    throwIfAborted(signal);
    if (encoderError) throw encoderError;

    muxer.finalize();
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

/**
 * Base64-encodes the muxed MP4 for `@capacitor/filesystem`. Chunked so a
 * ~40 MB buffer never overflows the call stack via `String.fromCharCode(...)`.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    parts.push(String.fromCharCode.apply(null, Array.from(chunk)));
  }
  return btoa(parts.join(''));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new FlyoverExportAbortedError();
}

/** Lets the encoder catch up instead of queueing every frame into RAM. */
async function drainEncoder(encoder: VideoEncoder, signal?: AbortSignal) {
  let waited = 0;
  while (encoder.encodeQueueSize > 8) {
    if (waited > 2_000) return;
    await delay(4);
    throwIfAborted(signal);
    waited += 4;
  }
  // Yields to the UI so the progress percentage can repaint.
  await delay(0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Aspect-fill (`cover`) so the 9:16 video is never squashed. */
function drawCapturedFrame(context: CanvasRenderingContext2D, frame: FlyoverFrameCapture) {
  const source = frame.image;
  if (source.width === 0 || source.height === 0) return;

  const scale = Math.max(
    FLYOVER_EXPORT_WIDTH / source.width,
    FLYOVER_EXPORT_HEIGHT / source.height,
  );
  const width = source.width * scale;
  const height = source.height * scale;
  const x = (FLYOVER_EXPORT_WIDTH - width) / 2;
  const y = (FLYOVER_EXPORT_HEIGHT - height) / 2;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, x, y, width, height);

  // MapLibre HTML markers live outside the WebGL buffer, so the moving marker
  // is painted here using its projected position in the captured frame.
  const markerX = x + frame.markerX * width;
  const markerY = y + frame.markerY * height;
  context.save();
  context.beginPath();
  context.arc(markerX, markerY, 22, 0, Math.PI * 2);
  context.fillStyle = 'rgba(249,115,22,0.28)';
  context.fill();
  context.beginPath();
  context.arc(markerX, markerY, 12, 0, Math.PI * 2);
  context.fillStyle = '#f97316';
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = '#ffffff';
  context.stroke();
  context.restore();
}

const FONT_STACK = '"Inter","Segoe UI",Roboto,system-ui,-apple-system,sans-serif';

function font(size: number, weight: number | string = 600): string {
  return `${weight} ${size}px ${FONT_STACK}`;
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
) {
  const width = FLYOVER_EXPORT_WIDTH;
  const height = FLYOVER_EXPORT_HEIGHT;

  const scrim = context.createLinearGradient(0, 0, 0, 340);
  scrim.addColorStop(0, 'rgba(2,6,23,0.88)');
  scrim.addColorStop(1, 'rgba(2,6,23,0)');
  context.fillStyle = scrim;
  context.fillRect(0, 0, width, 340);

  context.textAlign = 'left';
  context.textBaseline = 'middle';

  context.font = font(24, 800);
  const badgeWidth = context.measureText(hud.badge).width + 44;
  roundedRect(context, HUD_MARGIN, 56, badgeWidth, 46, 23);
  context.fillStyle = '#f97316';
  context.fill();
  context.fillStyle = '#ffffff';
  context.fillText(hud.badge, HUD_MARGIN + 22, 80);

  context.font = font(42, 700);
  context.fillStyle = '#f8fafc';
  context.fillText(truncateText(context, hud.title, width - HUD_MARGIN * 2), HUD_MARGIN, 152);

  context.font = font(24, 500);
  context.fillStyle = 'rgba(203,213,225,0.92)';
  context.fillText(
    truncateText(context, hud.date, width - HUD_MARGIN * 2),
    HUD_MARGIN,
    202,
  );

  const cardX = 32;
  const cardY = height - CARD_HEIGHT - 40;
  const cardWidth = width - cardX * 2;

  roundedRect(context, cardX, cardY, cardWidth, CARD_HEIGHT, 28);
  context.fillStyle = 'rgba(15,23,42,0.78)';
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
  context.fillStyle = '#f97316';
  context.fill();

  context.textAlign = 'right';
  context.font = font(20, 600);
  context.fillStyle = 'rgba(203,213,225,0.9)';
  context.fillText(`${Math.round(clamped * 100)}%`, barX + barWidth, barY - 20);
  context.textAlign = 'left';
}
