import { getSupabaseClientOrNull } from './supabase';
import {
  isProTierKey,
  readProfileExpiry,
  readProfileTier,
  type PlanTier,
  type ProfileRow,
} from './subscription';

/**
 * Device identity, server-clock anchoring and the two subscription RPCs.
 *
 * Everything here is offline-safe: every localStorage access is guarded and
 * every network call resolves to `null` instead of throwing, because a device
 * in the mountains without signal must keep recording.
 */

const DEVICE_ID_KEY = 'allmova_device_id';
const LAST_SERVER_MS_KEY = 'allmova_last_server_ms';
const ACTIVE_DEVICE_KEY = 'allmova_active_device_id';
const SNAPSHOT_PREFIX = 'allmova_subscription_snapshot_';

let claimInFlight = false;

export function isDeviceClaimInProgress(): boolean {
  return claimInFlight;
}

function readLocal(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or a full quota must not break the guard.
  }
}

function removeLocal(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to remove when storage is unavailable.
  }
}

/** Stable UUID per install; kept across sign-outs so a device stays recognisable. */
export function getDeviceId(): string {
  const existing = readLocal(DEVICE_ID_KEY);
  if (existing && existing.trim().length > 0) return existing;

  const generated = createUuid();
  writeLocal(DEVICE_ID_KEY, generated);
  return generated;
}

function createUuid(): string {
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // Older WebViews expose the method but reject it outside a secure context.
    }
  }
  const random = () => Math.random().toString(16).slice(2, 10);
  return `${random()}${random()}-${random()}-4${random().slice(1)}-a${random().slice(1)}-${random()}${random()}`;
}

function readLastServerMs(): number {
  const raw = readLocal(LAST_SERVER_MS_KEY);
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Remembers the newest server timestamp so a rolled-back clock cannot extend a trial. */
export function recordServerNow(serverNow: string | null | undefined): void {
  if (!serverNow) return;
  const parsed = Date.parse(serverNow);
  if (!Number.isFinite(parsed)) return;
  if (parsed > readLastServerMs()) writeLocal(LAST_SERVER_MS_KEY, String(parsed));
}

/**
 * Wall clock that can only move forward: the larger of the device clock and the
 * newest `server_now` ever seen. Used for every trial expiry decision.
 */
export function getTrustedCurrentTimeMs(now: number = Date.now()): number {
  return Math.max(now, readLastServerMs());
}

export function cachedActiveDeviceId(): string | null {
  const raw = readLocal(ACTIVE_DEVICE_KEY);
  return raw && raw.trim().length > 0 ? raw : null;
}

export function setCachedActiveDeviceId(deviceId: string | null): void {
  if (deviceId && deviceId.trim().length > 0) writeLocal(ACTIVE_DEVICE_KEY, deviceId);
  else removeLocal(ACTIVE_DEVICE_KEY);
}

export type SubscriptionSyncResult = {
  tier: PlanTier;
  proExpiresAt: string | null;
  isOwner: boolean;
  activeDeviceId: string | null;
  serverNow: string | null;
  downgraded: boolean;
};

type RawRpcResult = Record<string, unknown>;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeRpcResult(data: unknown): SubscriptionSyncResult | null {
  let payload: unknown = data;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const raw = payload as RawRpcResult;
  const serverNow = asString(raw.server_now);
  recordServerNow(serverNow);

  return {
    tier: isProTierKey(readProfileTier(raw)) ? 'pro' : 'free',
    proExpiresAt: readProfileExpiry(raw),
    isOwner: raw.is_owner === true,
    activeDeviceId: asString(raw.active_device_id),
    serverNow,
    downgraded: raw.downgraded === true,
  };
}

function canReachNetwork(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return getSupabaseClientOrNull() !== null;
}

/** `Last login wins`: registers this device as the account's active device. */
export async function claimActiveDevice(): Promise<SubscriptionSyncResult | null> {
  if (!canReachNetwork()) return null;
  const supabase = getSupabaseClientOrNull();
  if (!supabase) return null;

  claimInFlight = true;
  try {
    const { data, error } = await supabase.rpc('claim_active_device', {
      p_device_id: getDeviceId(),
    });
    if (error) return null;

    const result = normalizeRpcResult(data);
    if (result?.activeDeviceId) setCachedActiveDeviceId(result.activeDeviceId);
    return result;
  } catch {
    return null;
  } finally {
    claimInFlight = false;
  }
}

/** Refreshes tier/expiry and reads back the active device id. */
export async function syncSubscriptionAndDevice(): Promise<SubscriptionSyncResult | null> {
  if (!canReachNetwork()) return null;
  const supabase = getSupabaseClientOrNull();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc('sync_subscription_and_device');
    if (error) return null;

    const result = normalizeRpcResult(data);
    if (result?.activeDeviceId) setCachedActiveDeviceId(result.activeDeviceId);
    return result;
  } catch {
    return null;
  }
}

/**
 * Streams updates for one profile row. Returns an unsubscribe function; a
 * failed subscription simply resolves to a no-op so offline use is unaffected.
 */
export function subscribeToProfileChanges(
  userId: string,
  onChange: (row: ProfileRow) => void,
): () => void {
  const supabase = getSupabaseClientOrNull();
  if (!supabase || !userId) return () => undefined;

  try {
    const channel = supabase
      .channel(`allmova-profile-${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
        (payload) => {
          if (payload.new) onChange(payload.new as ProfileRow);
        },
      )
      .subscribe();

    return () => {
      try {
        void supabase.removeChannel(channel);
      } catch {
        // The socket may already be gone.
      }
    };
  } catch {
    return () => undefined;
  }
}

export type SubscriptionSnapshot = {
  tier: PlanTier;
  proExpiresAt: string | null;
  isOwner: boolean;
  activeDeviceId: string | null;
};

/** Offline copy of the plan fields, so expiry is still enforced without signal. */
export function readSubscriptionSnapshot(userId: string): SubscriptionSnapshot | null {
  const raw = readLocal(`${SNAPSHOT_PREFIX}${userId}`);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    return {
      tier: isProTierKey(asString(record.tier)) ? 'pro' : 'free',
      proExpiresAt: asString(record.proExpiresAt),
      isOwner: record.isOwner === true,
      activeDeviceId: asString(record.activeDeviceId),
    };
  } catch {
    return null;
  }
}

export function writeSubscriptionSnapshot(
  userId: string,
  snapshot: SubscriptionSnapshot,
): void {
  if (!userId) return;
  writeLocal(
    `${SNAPSHOT_PREFIX}${userId}`,
    JSON.stringify({
      tier: snapshot.tier,
      proExpiresAt: snapshot.proExpiresAt,
      isOwner: snapshot.isOwner,
      activeDeviceId: snapshot.activeDeviceId,
    }),
  );
}

export function clearSubscriptionSnapshot(userId: string): void {
  if (!userId) return;
  removeLocal(`${SNAPSHOT_PREFIX}${userId}`);
}
