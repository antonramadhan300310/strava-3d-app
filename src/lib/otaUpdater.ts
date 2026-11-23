import { Capacitor } from '@capacitor/core';
import { CapacitorUpdater, type BundleInfo } from '@capgo/capacitor-updater';

/**
 * Version of the installed native shell. Bump it whenever a change requires a
 * new APK, and set the same value as `minNativeVersion` in the OTA manifest.
 */
export const NATIVE_APP_VERSION = '1.2.0';

const FALLBACK_REPO = 'antonramadhan1504-ops/strava-3d-app';
const OTA_RELEASE_TAG = 'ota-latest';
const OTA_VERSION_KEY = 'allmova_ota_version';
const OTA_BUNDLE_ID_KEY = 'allmova_ota_bundle_id';

export type OtaRelease = {
  otaVersion: string;
  minNativeVersion: string;
  bundleUrl: string;
  apkUrl: string;
  releaseNotes: string;
};

export type OtaBundle = {
  id: string;
  version: string;
};

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

function repoSlug(): string {
  const configured = process.env.NEXT_PUBLIC_GITHUB_REPO?.trim();
  return configured && configured.includes('/') ? configured : FALLBACK_REPO;
}

/** Compares dotted semver-ish versions; a missing or non-numeric segment is 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = Number.parseInt(left[index] ?? '0', 10) || 0;
    const r = Number.parseInt(right[index] ?? '0', 10) || 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export function isNativeVersionOutdated(minNativeVersion: string): boolean {
  if (!minNativeVersion) return false;
  return compareVersions(NATIVE_APP_VERSION, minNativeVersion) < 0;
}

/** Silent: an offline device must boot straight into the app. */
export async function notifyAppReady(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    await CapacitorUpdater.notifyAppReady();
  } catch {
    // Not running a downloaded bundle yet.
  }
}

export async function fetchOtaRelease(signal?: AbortSignal): Promise<OtaRelease | null> {
  try {
    const releaseResponse = await fetch(
      `https://api.github.com/repos/${repoSlug()}/releases/tags/${OTA_RELEASE_TAG}`,
      {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
        signal,
      },
    );
    if (!releaseResponse.ok) return null;

    const release = (await releaseResponse.json()) as {
      assets?: { name?: string; browser_download_url?: string }[];
    };
    const asset = release.assets?.find((entry) => entry.name === 'version.json');
    if (!asset?.browser_download_url) return null;

    // The tag is re-uploaded on every build, so bypass the CDN cache.
    const manifestResponse = await fetch(`${asset.browser_download_url}?t=${Date.now()}`, {
      cache: 'no-store',
      signal,
    });
    if (!manifestResponse.ok) return null;

    const manifest = (await manifestResponse.json()) as Partial<OtaRelease>;
    if (!manifest.otaVersion || !manifest.bundleUrl) return null;

    return {
      otaVersion: String(manifest.otaVersion),
      minNativeVersion: String(manifest.minNativeVersion ?? '0.0.0'),
      bundleUrl: String(manifest.bundleUrl),
      apkUrl: String(manifest.apkUrl ?? ''),
      releaseNotes: String(manifest.releaseNotes ?? ''),
    };
  } catch {
    return null;
  }
}

export async function downloadOtaBundle(release: OtaRelease): Promise<OtaBundle | null> {
  if (!isNativeApp()) return null;
  try {
    const bundle: BundleInfo = await CapacitorUpdater.download({
      url: release.bundleUrl,
      version: release.otaVersion,
    });
    rememberBundle(bundle);
    return { id: bundle.id, version: bundle.version };
  } catch {
    return null;
  }
}

export async function applyOtaBundle(id: string): Promise<boolean> {
  try {
    await CapacitorUpdater.set({ id });
    return true;
  } catch {
    return false;
  }
}

/** Version of the bundle the app is running right now. */
export async function currentBundleVersion(): Promise<string | null> {
  if (!isNativeApp()) return null;
  try {
    const current = await CapacitorUpdater.current();
    return current.bundle.version;
  } catch {
    return null;
  }
}

function rememberBundle(bundle: OtaBundle): void {
  try {
    window.localStorage.setItem(OTA_VERSION_KEY, bundle.version);
    window.localStorage.setItem(OTA_BUNDLE_ID_KEY, bundle.id);
  } catch {
    // Private mode or a full quota: the update simply re-downloads next launch.
  }
}

export function installedOtaVersion(): string | null {
  try {
    return window.localStorage.getItem(OTA_VERSION_KEY);
  } catch {
    return null;
  }
}

/** A bundle downloaded on a previous launch but not applied yet. */
export function pendingOtaBundle(): OtaBundle | null {
  try {
    const version = window.localStorage.getItem(OTA_VERSION_KEY);
    const id = window.localStorage.getItem(OTA_BUNDLE_ID_KEY);
    return version && id ? { id, version } : null;
  } catch {
    return null;
  }
}
