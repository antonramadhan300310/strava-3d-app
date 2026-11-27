import { Capacitor, registerPlugin } from '@capacitor/core';
import type {
  BackgroundGeolocationPlugin,
  Location as NativeLocation,
} from '@capacitor-community/background-geolocation';
import {
  addNativeLocationListener,
  hasNativeRecordingEngine,
  startNativeTrackingService,
  stopNativeTrackingService,
  type NativeBufferedFix,
} from './nativeTrackingService';

export type LocationSample = {
  lng: number;
  lat: number;
  /** Horizontal uncertainty in metres (68% confidence). */
  accuracy: number;
  /** Metres above sea level, or null when the fix carries no altitude. */
  altitude: number | null;
  /** Ground speed in metres per second, or null. */
  speed: number | null;
  /** Degrees from true north, or null. */
  bearing: number | null;
  /** Fix timestamp in milliseconds since the unix epoch. */
  time: number;
};

export type LocationErrorCode = 'permission' | 'unavailable' | 'timeout' | 'unknown';

export type LocationError = {
  code: LocationErrorCode;
  message: string;
};

export type LocationWatch = {
  stop: () => Promise<void>;
};

export const FOREGROUND_NOTIFICATION_TITLE = 'Merekam aktivitas olahraga...';
const FOREGROUND_NOTIFICATION_BODY = 'GPS aktif — rekaman berjalan meski layar mati.';

/**
 * The plugin ships no web implementation, so it is only ever registered (and
 * called) on a native platform. `registerPlugin` itself is safe on the web; it
 * only throws when a method is invoked without a native bridge.
 */
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

export function isNativeLocationPlatform(): boolean {
  return Capacitor.isNativePlatform();
}

function nativeError(error: { code?: string; message?: string }): LocationError {
  if (error.code === 'NOT_AUTHORIZED') {
    return {
      code: 'permission',
      message: 'Izin lokasi ditolak. Aktifkan izin lokasi untuk aplikasi ini.',
    };
  }
  if (error.code === 'UNABLE_TO_START') {
    return {
      code: 'unavailable',
      message: 'Layanan lokasi perangkat tidak dapat dinyalakan. Pastikan GPS aktif.',
    };
  }
  return { code: 'unknown', message: error.message ?? 'Terjadi kesalahan pada layanan GPS.' };
}

function fromNativeLocation(location: NativeLocation): LocationSample {
  return {
    lng: location.longitude,
    lat: location.latitude,
    accuracy: Number.isFinite(location.accuracy) ? location.accuracy : Number.POSITIVE_INFINITY,
    altitude: location.altitude,
    speed: location.speed,
    bearing: location.bearing,
    time: location.time ?? Date.now(),
  };
}

function fromBrowserPosition(position: GeolocationPosition): LocationSample {
  const { coords } = position;
  return {
    lng: coords.longitude,
    lat: coords.latitude,
    accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : Number.POSITIVE_INFINITY,
    altitude: coords.altitude,
    speed: coords.speed,
    bearing: coords.heading,
    time: position.timestamp || Date.now(),
  };
}

function browserError(error: GeolocationPositionError): LocationError {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return {
        code: 'permission',
        message: 'Izin lokasi ditolak. Aktifkan izin lokasi untuk aplikasi ini.',
      };
    case error.POSITION_UNAVAILABLE:
      return {
        code: 'unavailable',
        message: 'Sinyal GPS belum tersedia. Coba di area terbuka.',
      };
    case error.TIMEOUT:
      return { code: 'timeout', message: 'Sinyal GPS habis waktu. Mencari ulang…' };
    default:
      return { code: 'unknown', message: 'Terjadi kesalahan pada layanan GPS.' };
  }
}

function startBrowserWatch(
  onSample: (sample: LocationSample) => void,
  onError: (error: LocationError) => void,
): LocationWatch {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    onError({ code: 'unavailable', message: 'Perangkat ini tidak mendukung layanan lokasi.' });
    return { stop: async () => {} };
  }

  const id = navigator.geolocation.watchPosition(
    (position) => onSample(fromBrowserPosition(position)),
    (error) => onError(browserError(error)),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
  );

  return {
    stop: async () => {
      navigator.geolocation.clearWatch(id);
    },
  };
}

function fromNativeFix(fix: NativeBufferedFix): LocationSample {
  return {
    lng: fix.lng,
    lat: fix.lat,
    accuracy: fix.accuracy,
    altitude: fix.altitude,
    speed: fix.speed,
    bearing: fix.bearing,
    time: fix.time,
  };
}

/**
 * Our own foreground service is the primary source on Android: it requests
 * 1 s / 500 ms high-accuracy fixes, holds a wake lock and buffers every fix
 * natively, so one notification covers both the live HUD and the locked-screen
 * recording. Returns `null` when this APK predates the engine.
 */
async function startNativeEngineWatch(
  onSample: (sample: LocationSample) => void,
): Promise<LocationWatch | null> {
  if (!(await hasNativeRecordingEngine())) return null;

  const detach = await addNativeLocationListener((fix) => onSample(fromNativeFix(fix)));
  if (!detach) return null;

  if (!(await startNativeTrackingService())) {
    // Permission denied or the service refused to start: let the caller fall
    // back to the community plugin, which prompts for the permission itself.
    await detach();
    return null;
  }

  return {
    stop: async () => {
      await detach();
      await stopNativeTrackingService();
    },
  };
}

/**
 * Streams GPS fixes from the Android foreground service when running natively,
 * and from `navigator.geolocation` when running in a browser.
 */
export async function startLocationWatch(
  onSample: (sample: LocationSample) => void,
  onError: (error: LocationError) => void,
): Promise<LocationWatch> {
  if (isNativeLocationPlatform()) {
    const engineWatch = await startNativeEngineWatch(onSample);
    if (engineWatch) return engineWatch;

    try {
      const id = await BackgroundGeolocation.addWatcher(
        {
          backgroundTitle: FOREGROUND_NOTIFICATION_TITLE,
          backgroundMessage: FOREGROUND_NOTIFICATION_BODY,
          requestPermissions: true,
          stale: false,
          distanceFilter: 0,
        },
        (location, error) => {
          if (error) {
            onError(nativeError(error));
            return;
          }
          if (location) onSample(fromNativeLocation(location));
        },
      );

      return {
        stop: async () => {
          try {
            await BackgroundGeolocation.removeWatcher({ id });
          } catch {
            // The service may already be gone (e.g. killed by the OS).
          }
        },
      };
    } catch {
      onError({
        code: 'unavailable',
        message: 'Layanan GPS latar belakang gagal dinyalakan, memakai GPS bawaan.',
      });
    }
  }

  return startBrowserWatch(onSample, onError);
}

/** Opens the system settings page for this app when the plugin is available. */
export async function openLocationSettings(): Promise<void> {
  if (!isNativeLocationPlatform()) return;
  try {
    await BackgroundGeolocation.openSettings();
  } catch {
    // Settings are a convenience only.
  }
}
