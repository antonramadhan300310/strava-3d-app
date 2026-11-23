import { Capacitor, registerPlugin } from '@capacitor/core';

export type SavedMedia = {
  /** `content://media/...` URI of the new gallery row. */
  uri: string;
  /** Human-readable location, e.g. `Pictures/ALLMOVA/card.png`. */
  path: string;
};

type AllmovaTrackingPlugin = {
  startTrackingService(): Promise<void>;
  stopTrackingService(): Promise<void>;
  openExternalUrl(options: { url: string }): Promise<void>;
  saveMediaToGallery(options: { filePath: string; mimeType: string }): Promise<SavedMedia>;
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
