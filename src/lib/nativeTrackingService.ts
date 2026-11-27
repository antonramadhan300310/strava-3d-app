import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type SavedMedia = {
  /** `content://media/...` URI of the new gallery row. */
  uri: string;
  /** Human-readable location, e.g. `Pictures/ALLMOVA/card.png`. */
  path: string;
};

type RawBufferedFix = {
  i: number;
  lat: number;
  lng: number;
  acc: number;
  alt?: number;
  spd?: number;
  brg?: number;
  t: number;
};

type AllmovaTrackingPlugin = {
  startTrackingService(): Promise<void>;
  stopTrackingService(): Promise<void>;
  hasRecordingEngine(): Promise<{ available: boolean }>;
  addListener(
    eventName: 'location',
    listener: (fix: RawBufferedFix) => void,
  ): Promise<PluginListenerHandle>;
  getBufferedFixes(options: { since: number }): Promise<{
    fixes: RawBufferedFix[];
    nextIndex: number;
    count: number;
  }>;
  clearFixBuffer(): Promise<void>;
  openExternalUrl(options: { url: string }): Promise<void>;
  saveMediaToGallery(options: { filePath: string; mimeType: string }): Promise<SavedMedia>;
  saveFileToDownloads(options: {
    filePath: string;
    fileName?: string;
    mimeType?: string;
  }): Promise<SavedMedia>;
};

/** A fix the native foreground service buffered while the WebView was frozen. */
export type NativeBufferedFix = {
  index: number;
  lat: number;
  lng: number;
  accuracy: number;
  altitude: number | null;
  speed: number | null;
  bearing: number | null;
  time: number;
};

export type NativeBufferDrain = {
  fixes: NativeBufferedFix[];
  /** Index to pass as `since` on the next drain. */
  nextIndex: number;
  /** Total fixes currently held natively. */
  count: number;
};

/**
 * Native companion of `AllmovaTrackingService`: keeps the CPU and GPS awake
 * while a recording session runs in the background.
 */
const AllmovaTracking = registerPlugin<AllmovaTrackingPlugin>('AllmovaTracking');

export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/** Returns true when the Android foreground service actually started. */
export async function startNativeTrackingService(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    await AllmovaTracking.startTrackingService();
    return true;
  } catch {
    return false;
  }
}

export async function stopNativeTrackingService(): Promise<void> {
  if (!isNativeAndroid()) return;
  try {
    await AllmovaTracking.stopTrackingService();
  } catch {
    // The OS may have already torn the service down.
  }
}

function toBufferedFix(fix: RawBufferedFix): NativeBufferedFix | null {
  if (!Number.isFinite(fix?.lat) || !Number.isFinite(fix?.lng) || !Number.isFinite(fix?.t)) {
    return null;
  }
  return {
    index: Number.isFinite(fix.i) ? fix.i : 0,
    lat: fix.lat,
    lng: fix.lng,
    accuracy: Number.isFinite(fix.acc) ? fix.acc : Number.POSITIVE_INFINITY,
    altitude: Number.isFinite(fix.alt) ? (fix.alt as number) : null,
    speed: Number.isFinite(fix.spd) ? (fix.spd as number) : null,
    bearing: Number.isFinite(fix.brg) ? (fix.brg as number) : null,
    time: fix.t,
  };
}

/**
 * Reads the fixes the foreground service recorded natively since `since`.
 *
 * Returns `null` off Android or when the bridge fails, so a broken native call
 * can never interrupt a recording that the live watcher is still feeding.
 */
export async function readNativeGpsBuffer(since = 0): Promise<NativeBufferDrain | null> {
  if (!isNativeAndroid()) return null;
  try {
    const response = await AllmovaTracking.getBufferedFixes({ since });
    const raw = Array.isArray(response?.fixes) ? response.fixes : [];
    const fixes = raw
      .map(toBufferedFix)
      .filter((fix): fix is NativeBufferedFix => fix !== null)
      .sort((a, b) => a.time - b.time);
    return {
      fixes,
      nextIndex: Number.isFinite(response?.nextIndex) ? response.nextIndex : since,
      count: Number.isFinite(response?.count) ? response.count : fixes.length,
    };
  } catch {
    return null;
  }
}

/** Empties the native buffer; called when a recording starts or is saved. */
export async function clearNativeGpsBuffer(): Promise<void> {
  if (!isNativeAndroid()) return;
  try {
    await AllmovaTracking.clearFixBuffer();
  } catch {
    // A stale buffer only wastes storage; it never corrupts a new recording.
  }
}

/**
 * Whether this APK ships the native recording engine (foreground service with
 * its own high-accuracy location request plus the fix buffer). Builds before
 * the engine existed do not answer the call at all, which is the signal to fall
 * back to `@capacitor-community/background-geolocation`.
 */
export async function hasNativeRecordingEngine(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    const result = await AllmovaTracking.hasRecordingEngine();
    return result?.available === true;
  } catch {
    return false;
  }
}

/**
 * Streams the fixes the native service receives while the WebView is awake.
 * Resolves with a detach function, or `null` when the bridge is unavailable.
 */
export async function addNativeLocationListener(
  listener: (fix: NativeBufferedFix) => void,
): Promise<(() => Promise<void>) | null> {
  if (!isNativeAndroid()) return null;
  try {
    const handle = await AllmovaTracking.addListener('location', (raw) => {
      const fix = toBufferedFix(raw);
      if (fix) listener(fix);
    });
    return async () => {
      try {
        await handle.remove();
      } catch {
        // The bridge may already be gone (activity destroyed).
      }
    };
  } catch {
    return null;
  }
}

/**
 * Copies a cached image/video into the Android gallery (Pictures/ALLMOVA or
 * Movies/ALLMOVA) through the native MediaStore bridge.
 *
 * Returns `null` on the web or when the native call fails, so callers can fall
 * back to the share sheet instead of losing the export.
 */
export async function saveMediaToGallery(options: {
  filePath: string;
  mimeType: string;
}): Promise<SavedMedia | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await AllmovaTracking.saveMediaToGallery(options);
  } catch {
    return null;
  }
}

export type DownloadSaveResult =
  | { ok: true; uri: string; path: string }
  | { ok: false; error: string };

/**
 * Writes a cached export into the public `Download/ALLMOVA` folder through
 * MediaStore. Returns a result instead of throwing so the caller can fall back
 * to the share sheet while still reporting why the save failed.
 */
export async function saveFileToDownloads(options: {
  filePath: string;
  fileName?: string;
  mimeType?: string;
}): Promise<DownloadSaveResult> {
  if (!isNativeAndroid()) {
    return { ok: false, error: 'folder Download hanya tersedia di Android' };
  }
  try {
    const saved = await AllmovaTracking.saveFileToDownloads(options);
    return { ok: true, uri: saved.uri, path: saved.path };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : 'plugin penyimpanan tidak tersedia',
    };
  }
}

/** Opens a link outside the WebView (used for the mandatory APK download). */
export async function openExternalUrl(url: string): Promise<void> {
  if (!url) return;
  if (isNativeAndroid()) {
    try {
      await AllmovaTracking.openExternalUrl({ url });
      return;
    } catch {
      // Fall through to the web behaviour below.
    }
  }
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
