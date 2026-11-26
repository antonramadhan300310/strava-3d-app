import {
  isLifetimePro,
  isProfilePro,
  isTrialExpired,
  isTrialSubscriptionSource,
  trialDaysLeft,
  withTrustedTier,
  type AthleteProfile,
  type PlanTier,
} from './subscription';

/**
 * The single place where a plan is decided.
 *
 * Two sources describe the same account: the `profiles` row the admin panel
 * edits and the `sync_subscription_and_device()` verdict. They can disagree —
 * the admin panel may write `plan_tier` while the RPC still reads `tier`, or a
 * read may fail on a flaky connection — so the UI must never pick one and
 * discard the other. `mergePlanSignal` combines them, promotion wins, and a
 * fresh `pro` verdict from the server is final because the server already ran
 * the expiry check.
 */

/** Structural shape of `SubscriptionSyncResult`, kept dependency-free. */
export type PlanSignal = {
  tier: PlanTier;
  proExpiresAt: string | null;
  isOwner: boolean;
  activeDeviceId: string | null;
  /** `subscription_source` echoed by the server, when it returns the column. */
  subscriptionSource?: string | null;
  /** True when the server itself downgraded the plan on this call. */
  downgraded?: boolean;
  serverNow?: string | null;
};

export type FetchedProfile = {
  profile: AthleteProfile;
  /** False when the `profiles` row could not be read and an offline copy is used. */
  cloud: boolean;
  /** Indonesian, user-facing reason the cloud read failed. */
  error: string | null;
};

export type PlanStatus = {
  tier: PlanTier;
  isPro: boolean;
  isOwner: boolean;
  isLifetime: boolean;
  isTrial: boolean;
  daysLeft: number | null;
  expired: boolean;
};

/**
 * Overlays a server signal onto the profile read from the row.
 *
 * - Promotion wins for the *tier*: a Pro signal from either source unlocks Pro,
 *   so a stale `tier = 'free'` cannot erase an activation written to `plan_tier`.
 * - The expiry is never erased by a `null`. The RPC and the row describe the
 *   same account, so a missing date on one side (an alias column the reader did
 *   not see, a partial realtime echo, a cached snapshot written before the
 *   activation) must not turn a dated plan into "Pro aktif selamanya". Only two
 *   `null`s mean lifetime.
 * - The verdict's date is preferred, never the later of the two: an admin who
 *   shortens the expiry from 30 days to 4 must see 4 days in the app.
 * - A server `pro` verdict is not re-checked against the device clock: the
 *   server already downgraded expired plans (`downgraded`), so a phone with a
 *   wrong date must not turn an active plan into Free locally.
 */
export function mergePlanSignal(
  profile: AthleteProfile,
  signal: PlanSignal,
  now: number,
): AthleteProfile {
  const signalPro = signal.tier === 'pro' && signal.downgraded !== true;
  const rowPro = profile.tier === 'pro';
  const isPro = signalPro || rowPro;

  const proExpiresAt = !isPro
    ? null
    : signalPro
      ? signal.proExpiresAt ?? profile.proExpiresAt
      : profile.proExpiresAt;

  const merged: AthleteProfile = {
    ...profile,
    tier: isPro ? 'pro' : 'free',
    proExpiresAt,
    isOwner: signal.isOwner || profile.isOwner,
    activeDeviceId: signal.activeDeviceId ?? profile.activeDeviceId,
    // The row is the only source of `subscription_source` in practice; a
    // server echo is preferred when the RPC returns it.
    subscriptionSource: signal.subscriptionSource ?? profile.subscriptionSource,
    // Only a `pro` verdict marks the plan as server-checked; a `free` verdict
    // (or an offline copy) falls back to the trusted-clock expiry check.
    serverVerifiedAt: signalPro ? now : null,
  };

  if (signalPro) return merged;
  if (signal.downgraded === true) return { ...merged, tier: 'free' };
  return withTrustedTier(merged, now);
}

/**
 * Which verdict may be applied on top of a row read.
 *
 * A successful cloud read already carries the newest server values, so a cached
 * verdict must not be replayed over it: an old snapshot could otherwise restore
 * an expiry the admin just shortened, or erase a date the server just wrote.
 * The cached verdict is only a fallback when the row itself could not be read.
 */
export function pickPlanSignal(
  fetched: FetchedProfile,
  fresh: PlanSignal | null,
  cached: PlanSignal | null,
): PlanSignal | null {
  if (fresh) return fresh;
  return fetched.cloud ? null : cached;
}

/**
 * Final profile for the UI: the row when it was read, the offline copy
 * otherwise, always combined with the server verdict when one is available.
 */
export function resolvePlanProfile(
  fetched: FetchedProfile,
  signal: PlanSignal | null,
  now: number,
): AthleteProfile {
  if (!signal) return withTrustedTier(fetched.profile, now);
  return mergePlanSignal(fetched.profile, signal, now);
}

/** Every derived flag the UI needs, computed once from the same profile. */
export function describePlan(profile: AthleteProfile | null, now: number): PlanStatus {
  if (!profile) {
    return {
      tier: 'free',
      isPro: false,
      isOwner: false,
      isLifetime: false,
      isTrial: false,
      daysLeft: null,
      expired: false,
    };
  }

  const isPro = isProfilePro(profile, now);

  return {
    tier: profile.tier,
    isPro,
    isOwner: profile.isOwner,
    isLifetime: isLifetimePro(profile),
    // A dated Pro plan is only a *trial* when the row says so: monthly/yearly
    // subscriptions and admin activations also expire, but are not trials.
    isTrial:
      isPro && !profile.isOwner && isTrialSubscriptionSource(profile.subscriptionSource),
    daysLeft: trialDaysLeft(profile, now),
    expired: isTrialExpired(profile, now),
  };
}
