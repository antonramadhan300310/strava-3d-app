import { getSupabaseClientOrNull } from './supabase';
import { USER_STORAGE_KEYS } from './userStorage';

const ACCOUNT_DELETED_NOTICE_KEY = 'allmova_account_deleted_notice';

export const ACCOUNT_DELETED_NOTICE = 'Akun kamu telah dihapus secara permanen.';

/** Device-wide caches that only describe the signed-in account. */
const DEVICE_ACCOUNT_KEYS = ['allmova_last_server_ms', 'allmova_active_device_id'];

/** Legacy, unscoped copies written before per-account storage existed. */
const LEGACY_ACCOUNT_KEYS = Object.values(USER_STORAGE_KEYS);

let inMemoryNotice: string | null = null;

function storageOrNull(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Deletes the account and everything it owns on the server. */
export async function deleteOwnAccount(): Promise<void> {
  const supabase = getSupabaseClientOrNull();
  if (!supabase) {
    throw new Error('Server ALLMOVA belum dikonfigurasi. Hubungi admin aplikasi.');
  }

  const { error } = await supabase.rpc('delete_own_account');
  if (error) throw new Error(error.message);
}

/**
 * Removes every local cache that belongs to `userId`: per-account keys are
 * suffixed with the id, so one suffix match covers activities, routes, profile,
 * heatmap, RPE, weather and the in-flight recording backup.
 */
export function clearLocalAccountData(userId: string | null): void {
  if (typeof window === 'undefined') return;

  const suffix = userId ? `_${userId}` : null;
  const exact = new Set<string>(LEGACY_ACCOUNT_KEYS);
  DEVICE_ACCOUNT_KEYS.forEach((key) => exact.add(key));
  if (userId) {
    exact.add(`allmova_subscription_snapshot_${userId}`);
    exact.add(`allmova_trial_expired_notified_${userId}`);
  }

  try {
    const doomed: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key) continue;
      if (exact.has(key) || (suffix !== null && key.endsWith(suffix))) doomed.push(key);
    }
    doomed.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // A blocked storage call must not stop the deletion flow.
  }
}

/** Drops Supabase's persisted session when the server-side account is already gone. */
export function purgeSupabaseAuthStorage(): void {
  if (typeof window === 'undefined') return;

  try {
    const doomed: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith('sb-') && key.includes('auth-token')) doomed.push(key);
    }
    doomed.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // The sign-out already cleared the session when storage is reachable.
  }
}

/** Queues the confirmation shown on the login screen after the redirect. */
export function markAccountDeleted(): void {
  inMemoryNotice = ACCOUNT_DELETED_NOTICE;
  const storage = storageOrNull();
  try {
    storage?.setItem(ACCOUNT_DELETED_NOTICE_KEY, ACCOUNT_DELETED_NOTICE);
  } catch {
    // The in-memory copy still covers the current app session.
  }
}

export function consumeAccountDeletedNotice(): string | null {
  const storage = storageOrNull();
  let stored: string | null = null;
  try {
    stored = storage?.getItem(ACCOUNT_DELETED_NOTICE_KEY) ?? null;
    storage?.removeItem(ACCOUNT_DELETED_NOTICE_KEY);
  } catch {
    // Fall back to the in-memory copy.
  }

  const notice = stored ?? inMemoryNotice;
  inMemoryNotice = null;
  return notice;
}
