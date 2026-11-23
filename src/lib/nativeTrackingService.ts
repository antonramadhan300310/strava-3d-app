import { Capacitor, registerPlugin } from '@capacitor/core';

type AllmovaTrackingPlugin = {
  startTrackingService(): Promise<void>;
  stopTrackingService(): Promise<void>;
  openExternalUrl(options: { url: string }): Promise<void>;
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
