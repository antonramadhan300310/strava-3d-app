import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { CapacitorUpdater, type BundleInfo } from '@capgo/capacitor-updater';

/**
 * Lowest native shell this web bundle can run on. It mirrors `versionName`
 * (`1.2.<runNumber>`) in `android/app/build.gradle`, so the current APK line
 * always passes the gate; bump it together with a `minNativeVersion` raise in
 * the OTA manifest when a bundle starts needing new native code.
 */
export const NATIVE_APP_VERSION = '1.2.0';

/**
 * OTA assets live in a public Supabase Storage bucket, so the manifest and the
 * bundle are plain HTTP 200 responses with no cross-domain redirect.
 */
export const OTA_STORAGE_BASE =
  'https://adnboduimzesbvbejdwr.supabase.co/storage/v1/object/public/ota-updates';
const MANIFEST_URL = `${OTA_STORAGE_BASE}/version.json`;

const APPLIED_KEY = 'allmova_ota_applied_v2';
const PENDING_KEY = 'allmova_ota_pending_v2';
const REJECTED_KEY = 'allmova_ota_rejected_version';
const LEGACY_VERSION_KEY = 'allmova_ota_version';
const LEGACY_BUNDLE_ID_KEY = 'allmova_ota_bundle_id';

/**
 * capgo rolls a bundle back when `notifyAppReady()` does not arrive in time.
 * After two failed boots the bundle is dropped instead of retried forever.
 */
const MAX_APPLY_ATTEMPTS = 2;
const HTTP_TIMEOUT_MS = 12000;

export type OtaRelease = {
  otaVersion: string;
  buildNumber: number;
  commitSha: string;
  builtAt: string;
  minNativeVersion: string;
  bundleUrl: string;
  apkUrl: string;
  releaseNotes: string;
};

export type OtaBundle = {
  id: string;
  version: string;
  buildNumber: number;
};

export type OtaPendingBundle = OtaBundle & { attempts: number; downloadedAt: number };

export type OtaFailureReason =
  | 'network'
  | 'not-found'
  | 'invalid-manifest'
  | 'download-failed'
  | 'rejected';

export type OtaFetchResult =
  | { ok: true; release: OtaRelease }
  | { ok: false; reason: OtaFailureReason; detail?: string };

export type OtaDownloadResult = { ok: true; bundle: OtaBundle } | { ok: false; detail: string };

export type OtaCheckOutcome =
  | { status: 'not-native' }
  | { status: 'up-to-date'; version: string }
  | { status: 'native-required'; release: OtaRelease }
  | { status: 'ready'; bundle: OtaBundle }
  | { status: 'error'; reason: OtaFailureReason; detail?: string };

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

function withCacheBust(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}t=${Date.now()}`;
}

/** `version.json` is overwritten on every build, so every read must bypass the CDN. */
export function otaManifestUrl(): string {
  return withCacheBust(MANIFEST_URL);
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

/**
 * Build counter embedded in a bundle version: `1.3.36` (semver) and the older
 * `<run>-<sha>` form both resolve to the CI run number.
 */
export function parseBuildNumber(version: string): number {
  const semver = /^\d+\.\d+\.(\d+)/.exec(version);
  if (semver) return Number.parseInt(semver[1], 10) || 0;
  const leading = /^(\d+)/.exec(version);
  return leading ? Number.parseInt(leading[1], 10) || 0 : 0;
}

export function isNativeVersionOutdated(
  minNativeVersion: string,
  nativeVersion: string = NATIVE_APP_VERSION,
): boolean {
  if (!minNativeVersion) return false;
  return compareVersions(nativeVersion, minNativeVersion) < 0;
}

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: the update simply re-downloads next launch.
  }
}

function removeKey(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to clean up.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
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

/**
 * Native HTTP for the manifest read: the WebView `fetch` path is kept for web
 * builds, but on Android `CapacitorHttp` bypasses any WebView cache and CORS.
 */
async function getText(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number; text: string } | null> {
  if (isNativeApp()) {
    try {
      const response = await CapacitorHttp.get({
        url,
        responseType: 'text',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Cache-Control': 'no-cache',
        },
        connectTimeout: HTTP_TIMEOUT_MS,
        readTimeout: HTTP_TIMEOUT_MS,
      });
      const text =
        typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? null);
      return { status: response.status, text };
    } catch {
      return null;
    }
  }

  try {
    const response = await fetch(url, { cache: 'no-store', signal });
    return { status: response.status, text: await response.text() };
  } catch {
    return null;
  }
}

function parseManifest(text: string): OtaRelease | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const otaVersion = String(raw.otaVersion ?? '').trim();
  if (!otaVersion) return null;

  const buildNumber =
    Number.parseInt(String(raw.buildNumber ?? ''), 10) || parseBuildNumber(otaVersion);
  const bundleUrl =
    String(raw.url ?? raw.bundleUrl ?? '').trim() ||
    `${OTA_STORAGE_BASE}/allmova-ota-${otaVersion}.zip`;

  return {
    otaVersion,
    buildNumber,
    commitSha: String(raw.commitSha ?? ''),
    builtAt: String(raw.builtAt ?? ''),
    minNativeVersion: String(raw.minNativeVersion ?? '0.0.0'),
    bundleUrl,
    apkUrl: String(raw.apkUrl ?? ''),
    releaseNotes: String(raw.releaseNotes ?? ''),
  };
}

export async function fetchOtaRelease(signal?: AbortSignal): Promise<OtaFetchResult> {
  const response = await getText(otaManifestUrl(), signal);
  if (!response) return { ok: false, reason: 'network' };
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: 'not-found', detail: `HTTP ${response.status}` };
  }

  const release = parseManifest(response.text);
  if (!release) {
    return { ok: false, reason: 'invalid-manifest', detail: response.text.slice(0, 120) };
  }
  return { ok: true, release };
}

/** Bundle the app is running right now; the builtin bundle reports the native version. */
export async function currentBundleVersion(): Promise<string | null> {
  if (!isNativeApp()) return null;
  try {
    const current = await CapacitorUpdater.current();
    return current.bundle.version || current.native || null;
  } catch {
    return null;
  }
}

/** Real version of the installed APK, so the native gate cannot trust a stale constant. */
export async function nativeAppVersion(): Promise<string> {
  if (!isNativeApp()) return NATIVE_APP_VERSION;
  try {
    const current = await CapacitorUpdater.current();
    return current.native || NATIVE_APP_VERSION;
  } catch {
    return NATIVE_APP_VERSION;
  }
}

export function appliedOtaBundle(): OtaBundle | null {
  const stored = readJson<OtaBundle>(APPLIED_KEY);
  if (stored?.version && stored.id) return stored;
  return null;
}

/** Version of the bundle installed on this device, including pre-v2 records. */
export function installedOtaVersion(): string | null {
  const applied = appliedOtaBundle();
  if (applied) return applied.version;
  try {
    return storage()?.getItem(LEGACY_VERSION_KEY) ?? null;
  } catch {
    return null;
  }
}

/** A bundle downloaded on an earlier launch but not applied yet. */
export function pendingOtaBundle(): OtaPendingBundle | null {
  const stored = readJson<OtaPendingBundle>(PENDING_KEY);
  if (stored?.version && stored.id) {
    return { ...stored, attempts: stored.attempts ?? 0, downloadedAt: stored.downloadedAt ?? 0 };
  }

  try {
    const version = storage()?.getItem(LEGACY_VERSION_KEY);
    const id = storage()?.getItem(LEGACY_BUNDLE_ID_KEY);
    if (version && id) {
      return { id, version, buildNumber: parseBuildNumber(version), attempts: 0, downloadedAt: 0 };
    }
  } catch {
    // No legacy record.
  }
  return null;
}

export function clearPendingOtaBundle(): void {
  removeKey(PENDING_KEY);
  removeKey(LEGACY_VERSION_KEY);
  removeKey(LEGACY_BUNDLE_ID_KEY);
}

export function rejectedOtaVersion(): string | null {
  try {
    return storage()?.getItem(REJECTED_KEY) ?? null;
  } catch {
    return null;
  }
}

export function isOtaReleaseNewer(release: OtaRelease, runningVersion: string | null): boolean {
  if (!runningVersion) return true;
  if (release.otaVersion === runningVersion) return false;

  const applied = appliedOtaBundle();
  const localBuild =
    applied?.version === runningVersion ? applied.buildNumber : parseBuildNumber(runningVersion);
  if (localBuild > 0 && release.buildNumber > 0) return release.buildNumber > localBuild;

  return compareVersions(release.otaVersion, runningVersion) > 0;
}

export async function downloadOtaBundle(release: OtaRelease): Promise<OtaDownloadResult> {
  if (!isNativeApp()) {
    return { ok: false, detail: 'Pembaruan OTA hanya tersedia di aplikasi Android.' };
  }

  const pending = pendingOtaBundle();
  if (pending && pending.version === release.otaVersion) {
    return { ok: true, bundle: pending };
  }

  try {
    // Every build publishes a new filename, so the manifest URL is immutable and
    // safe to download as is; adding `?t=` would only defeat CDN caching.
    const info: BundleInfo = await CapacitorUpdater.download({
      url: release.bundleUrl,
      version: release.otaVersion,
    });
    const bundle: OtaBundle = {
      id: info.id,
      version: info.version || release.otaVersion,
      buildNumber: release.buildNumber,
    };
    writeJson(PENDING_KEY, { ...bundle, attempts: 0, downloadedAt: Date.now() });
    removeKey(LEGACY_VERSION_KEY);
    removeKey(LEGACY_BUNDLE_ID_KEY);
    return { ok: true, bundle };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

function markRejected(version: string): void {
  try {
    storage()?.setItem(REJECTED_KEY, version);
  } catch {
    // Nothing to remember.
  }
}

/**
 * Activates a downloaded bundle. `set()` reloads the WebView, so a successful
 * call never resolves — the promise below is only ever settled on failure.
 */
export async function applyOtaBundle(bundle: OtaBundle): Promise<{ ok: boolean; detail?: string }> {
  if (!isNativeApp()) return { ok: false, detail: 'Bukan aplikasi native.' };

  const pending = pendingOtaBundle();
  const previousAttempts = pending?.version === bundle.version ? pending.attempts : 0;
  // capgo already rolled this bundle back once per attempt; stop boot-looping.
  if (previousAttempts >= MAX_APPLY_ATTEMPTS) {
    markRejected(bundle.version);
    clearPendingOtaBundle();
    return { ok: false, detail: `bundle gagal dimuat ${previousAttempts} kali` };
  }

  const attempts = previousAttempts + 1;
  writeJson(PENDING_KEY, {
    ...bundle,
    attempts,
    downloadedAt: pending?.downloadedAt ?? Date.now(),
  });

  try {
    writeJson(APPLIED_KEY, { ...bundle, appliedAt: Date.now() });
    await CapacitorUpdater.set({ id: bundle.id });
    return { ok: true };
  } catch (error) {
    removeKey(APPLIED_KEY);
    if (attempts >= MAX_APPLY_ATTEMPTS) {
      markRejected(bundle.version);
      clearPendingOtaBundle();
    }
    return { ok: false, detail: errorMessage(error) };
  }
}

export type OtaCheckOptions = {
  signal?: AbortSignal;
  onStage?: (stage: 'checking' | 'downloading') => void;
};

let activeCheck: Promise<OtaCheckOutcome> | null = null;

/**
 * One full OTA pass: manifest → native gate → download. Callers decide when to
 * apply, so the launch flow can defer the reload and the profile button cannot.
 * Concurrent callers share one pass: two downloads of the same version would
 * race on the same capgo bundle folder.
 */
export function checkOtaUpdate(options: OtaCheckOptions = {}): Promise<OtaCheckOutcome> {
  if (activeCheck) return activeCheck;
  activeCheck = runOtaCheck(options).finally(() => {
    activeCheck = null;
  });
  return activeCheck;
}

async function runOtaCheck(options: OtaCheckOptions): Promise<OtaCheckOutcome> {
  if (!isNativeApp()) return { status: 'not-native' };

  options.onStage?.('checking');
  const fetched = await fetchOtaRelease(options.signal);
  if (!fetched.ok) return { status: 'error', reason: fetched.reason, detail: fetched.detail };
  const release = fetched.release;

  const native = await nativeAppVersion();
  if (isNativeVersionOutdated(release.minNativeVersion, native)) {
    return { status: 'native-required', release };
  }

  const running = await currentBundleVersion();
  if (!isOtaReleaseNewer(release, running)) {
    return { status: 'up-to-date', version: running ?? native };
  }

  if (rejectedOtaVersion() === release.otaVersion) {
    return { status: 'error', reason: 'rejected', detail: release.otaVersion };
  }

  options.onStage?.('downloading');
  const downloaded = await downloadOtaBundle(release);
  if (!downloaded.ok) {
    return { status: 'error', reason: 'download-failed', detail: downloaded.detail };
  }
  return { status: 'ready', bundle: downloaded.bundle };
}
