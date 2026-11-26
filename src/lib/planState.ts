import {
  isLifetimePro,
  isProfilePro,
  isTrialExpired,
  isTrialPro,
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

/** Later of two ISO dates; an unparseable date defers to the other one. */
function laterExpiry(a: string | null, b: string | null): string | null {
  const aMs = a ? Date.parse(a) : Number.NaN;
  const bMs = b ? Date.parse(b) : Number.NaN;
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return aMs >= bMs ? a : b;
}

/**
 * Overlays a server signal onto the profile read from the row.
 *
 * - Promotion wins: a Pro signal from either source unlocks Pro, so a stale
 *   `tier = 'free'` cannot erase an activation written to `plan_tier`.
 * - A `null` expiry from a Pro source means lifetime and outranks any date.
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

  const proExpiries: (string | null)[] = [];
  if (signalPro) proExpiries.push(signal.proExpiresAt);
  if (rowPro) proExpiries.push(profile.proExpiresAt);

  const proExpiresAt =
    proExpiries.length === 0
      ? null
      : proExpiries.includes(null)
        ? null
        : proExpiries.reduce((latest, current) => laterExpiry(latest, current));

  const merged: AthleteProfile = {
    ...profile,
    tier: proExpiries.length > 0 ? 'pro' : 'free',
    proExpiresAt,
    isOwner: signal.isOwner || profile.isOwner,
    activeDeviceId: signal.activeDeviceId ?? profile.activeDeviceId,
    // Only a `pro` verdict marks the plan as server-checked; a `free` verdict
    // (or an offline copy) falls back to the trusted-clock expiry check.
    serverVerifiedAt: signalPro ? now : null,
  };

  if (signalPro) return merged;
  if (signal.downgraded === true) return { ...merged, tier: 'free' };
  return withTrustedTier(merged, now);
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

  return {
    tier: profile.tier,
    isPro: isProfilePro(profile, now),
    isOwner: profile.isOwner,
    isLifetime: isLifetimePro(profile),
    isTrial: isTrialPro(profile, now),
    daysLeft: trialDaysLeft(profile, now),
    expired: isTrialExpired(profile, now),
  };
}
