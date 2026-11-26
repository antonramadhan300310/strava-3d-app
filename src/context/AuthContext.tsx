'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabaseClientOrNull, isSupabaseConfigured } from '@/lib/supabase';
import {
  PROFILE_COLUMNS,
  isOwnerEmail,
  isProfilePro,
  isTrialExpired,
  toAthleteProfile,
  trialDaysLeft as trialDaysLeftOf,
  withTrustedTier,
  type AthleteProfile,
  type PlanTier,
  type ProfileRow,
  type ProfileUpdate,
} from '@/lib/subscription';
import {
  cachedActiveDeviceId,
  claimActiveDevice,
  getDeviceId,
  getTrustedCurrentTimeMs,
  isDeviceClaimInProgress,
  readSubscriptionSnapshot,
  setCachedActiveDeviceId,
  subscribeToProfileChanges,
  syncSubscriptionAndDevice,
  writeSubscriptionSnapshot,
  type SubscriptionSyncResult,
} from '@/lib/subscriptionAndDeviceGuard';
import {
  USER_STORAGE_KEYS,
  migrateLegacyStorage,
  readScopedStorage,
  setActiveUserId,
  writeScopedStorage,
  type LegacyMigration,
} from '@/lib/userStorage';
import {
  sanitizeRiderProfile,
  type RiderProfile,
} from '@/lib/riderProfile';
import {
  clearLocalAccountData,
  deleteOwnAccount,
  markAccountDeleted,
  purgeSupabaseAuthStorage,
} from '@/lib/accountDeletion';
import { translateAuthError } from '@/lib/authErrors';
import {
  addBrowserFinishedListener,
  addOAuthUrlListener,
  closeInAppBrowser,
  completeGoogleOAuth,
  isNativePlatform,
  isOAuthCallbackUrl,
  startGoogleOAuth,
} from '@/lib/googleAuth';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'unconfigured';
export type SimulatedTier = 'pro' | 'free';

type SignUpResult = { needsEmailConfirmation: boolean };

export type SaveAthleteProfileInput = {
  displayName: string;
  riderProfile: RiderProfile;
};

export type SaveAthleteProfileResult = {
  profile: RiderProfile;
  /** False when the cloud write failed; the local copy is still saved. */
  synced: boolean;
};

type AuthContextValue = {
  status: AuthStatus;
  isConfigured: boolean;
  user: User | null;
  profile: AthleteProfile | null;
  isPro: boolean;
  isOwner: boolean;
  tier: PlanTier;
  /** Whole days left in the Pro trial, or null when not on a trial. */
  trialDaysLeft: number | null;
  /** True while the one-time "trial ended" popup should be visible. */
  trialExpiredNotice: boolean;
  dismissTrialExpiredNotice: () => void;
  /** True when another device took over the account and the session was cleared. */
  sessionKicked: boolean;
  dismissSessionKicked: () => void;
  ownerSimulatedTier: SimulatedTier;
  setOwnerSimulatedTier: (tier: SimulatedTier) => void;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  /** True while the native OAuth tab is open (or the web redirect is starting). */
  googleSignInPending: boolean;
  /** Indonesian copy for a failed or cancelled Google login. */
  googleAuthError: string | null;
  clearGoogleAuthError: () => void;
  signUp: (displayName: string, email: string, password: string) => Promise<SignUpResult>;
  requestPasswordReset: (email: string) => Promise<void>;
  resetPasswordWithOtp: (email: string, token: string, newPassword: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Permanently deletes the account (UU PDP) and clears every local cache. */
  deleteAccount: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  refreshSubscription: () => Promise<void>;
  updateProfile: (patch: ProfileUpdate) => Promise<void>;
  saveAthleteProfile: (input: SaveAthleteProfileInput) => Promise<SaveAthleteProfileResult>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const TRIAL_NOTICE_PREFIX = 'allmova_trial_expired_notified_';

/** A freshly claimed device must not be kicked by a stale realtime echo. */
const CLAIM_GRACE_MS = 12_000;

function fallbackName(user: User): string {
  const meta = user.user_metadata?.display_name;
  if (typeof meta === 'string' && meta.trim().length > 0) return meta.trim();
  const email = user.email ?? '';
  return email.split('@')[0] || 'Atlet ALLMOVA';
}

function hasRiderProfile(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

/**
 * The only columns the client may write. `tier`, `plan_tier`, `is_owner` and
 * every expiry column belong to the admin panel; a stale client write would
 * silently reset an activation back to Free.
 */
const ATHLETE_PROFILE_KEYS = ['display_name', 'rider_profile', 'personal_goals'] as const;

function athleteProfileColumns(patch: ProfileUpdate): ProfileUpdate {
  const clean: ProfileUpdate = {};
  const target = clean as Record<string, unknown>;
  for (const key of ATHLETE_PROFILE_KEYS) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) target[key] = value;
  }
  return clean;
}

/** Reads the active account's offline copy, which is the newest local edit. */
function readLocalRiderProfile(): RiderProfile | null {
  const raw = readScopedStorage(USER_STORAGE_KEYS.riderProfile);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return hasRiderProfile(parsed) ? sanitizeRiderProfile(parsed) : null;
  } catch {
    return null;
  }
}

/** Offline fallback: cached plan fields still enforce trial expiry without signal. */
function fallbackProfile(user: User): AthleteProfile {
  const local = readLocalRiderProfile();
  const snapshot = readSubscriptionSnapshot(user.id);
  return withTrustedTier(
    {
      id: user.id,
      email: user.email ?? null,
      displayName: local?.displayName ?? fallbackName(user),
      tier: snapshot?.tier ?? 'free',
      proExpiresAt: snapshot?.proExpiresAt ?? null,
      isOwner: snapshot?.isOwner ?? false,
      activeDeviceId: snapshot?.activeDeviceId ?? null,
      riderProfile: local,
      personalGoals: null,
    },
    getTrustedCurrentTimeMs(),
  );
}

/** A cloud profile is the source of truth for a fresh device. */
function seedLocalCache(profile: AthleteProfile): void {
  if (profile.riderProfile && !readScopedStorage(USER_STORAGE_KEYS.riderProfile)) {
    writeScopedStorage(USER_STORAGE_KEYS.riderProfile, JSON.stringify(profile.riderProfile));
  }
  if (profile.personalGoals && !readScopedStorage(USER_STORAGE_KEYS.personalGoals)) {
    writeScopedStorage(USER_STORAGE_KEYS.personalGoals, JSON.stringify(profile.personalGoals));
  }
  if (!readScopedStorage(USER_STORAGE_KEYS.displayName)) {
    writeScopedStorage(USER_STORAGE_KEYS.displayName, profile.displayName);
  }
}

/** Later of two ISO dates; an unparseable date defers to the other one. */
function laterExpiry(a: string | null, b: string | null): string | null {
  const aMs = a ? Date.parse(a) : Number.NaN;
  const bMs = b ? Date.parse(b) : Number.NaN;
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return aMs >= bMs ? a : b;
}

/**
 * Overlays a server RPC result onto a profile, then applies the trusted clock.
 *
 * The RPC and the `profiles` row are two views of the same account and either
 * can be stale: the admin panel may write `plan_tier` while the RPC still
 * reports `tier = 'free'`. Promotion therefore wins — a Pro signal from either
 * source is kept — and the expiry is taken from the Pro sources only, so a
 * Free row's empty date never turns into a lifetime plan.
 */
function mergeSyncResult(
  profile: AthleteProfile,
  result: SubscriptionSyncResult,
  now: number,
): AthleteProfile {
  const proExpiries: (string | null)[] = [];
  if (result.tier === 'pro') proExpiries.push(result.proExpiresAt);
  if (profile.tier === 'pro') proExpiries.push(profile.proExpiresAt);

  // `null` from a Pro source means lifetime, which outranks any dated plan.
  const proExpiresAt =
    proExpiries.length === 0
      ? null
      : proExpiries.includes(null)
        ? null
        : proExpiries.reduce((latest, current) => laterExpiry(latest, current));

  return withTrustedTier(
    {
      ...profile,
      tier: proExpiries.length > 0 ? 'pro' : 'free',
      proExpiresAt,
      isOwner: result.isOwner || profile.isOwner,
      activeDeviceId: result.activeDeviceId ?? profile.activeDeviceId,
    },
    now,
  );
}

/**
 * A freshly read cloud row is authoritative for the plan: it is the same row
 * the admin panel edits. Only the offline fallback needs the RPC result, which
 * may promote it (the server knows about an activation the cache missed) but
 * never demote it.
 */
function resolveFetchedProfile(
  fetched: FetchedProfile,
  sync: SubscriptionSyncResult | null,
  now: number,
): AthleteProfile {
  if (fetched.cloud || !sync) return withTrustedTier(fetched.profile, now);
  return mergeSyncResult(fetched.profile, sync, now);
}

function isTrialNoticeSeen(userId: string): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(`${TRIAL_NOTICE_PREFIX}${userId}`) === 'true';
  } catch {
    return true;
  }
}

function markTrialNoticeSeen(userId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${TRIAL_NOTICE_PREFIX}${userId}`, 'true');
  } catch {
    // A blocked write only means the popup may repeat; never break the app.
  }
}

type FetchedProfile = {
  profile: AthleteProfile;
  /** False when the cloud row could not be read and the offline copy is used. */
  cloud: boolean;
};

async function fetchProfile(
  user: User,
  migration: LegacyMigration | null,
): Promise<FetchedProfile> {
  const supabase = getSupabaseClientOrNull();
  const fallback = fallbackProfile(user);
  if (!supabase) return { profile: fallback, cloud: false };

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', user.id)
      .maybeSingle();

    if (error) return { profile: fallback, cloud: false };

    if (data) {
      let profile = toAthleteProfile(data as ProfileRow, user.email ?? null, fallback.displayName);
      if (!hasRiderProfile(profile.riderProfile)) {
        profile = { ...profile, riderProfile: null };
      }

      // The offline copy is written on every save, so it is at least as new as
      // the cloud row and must not be replaced by a stale cloud profile.
      const local = readLocalRiderProfile();
      if (local) {
        profile = { ...profile, displayName: local.displayName, riderProfile: local };
      }

      const patch: ProfileUpdate = {};
      if (migration?.riderProfile && !profile.riderProfile) {
        patch.rider_profile = migration.riderProfile;
      }
      if (migration?.personalGoals && !profile.personalGoals) {
        patch.personal_goals = migration.personalGoals;
      }

      if (Object.keys(patch).length > 0) {
        const { data: updated } = await supabase
          .from('profiles')
          .update(patch)
          .eq('id', user.id)
          .select(PROFILE_COLUMNS)
          .maybeSingle();

        profile = updated
          ? toAthleteProfile(updated as ProfileRow, user.email ?? null, fallback.displayName)
          : {
              ...profile,
              riderProfile: patch.rider_profile ?? profile.riderProfile,
              personalGoals: patch.personal_goals ?? profile.personalGoals,
            };
      }

      return { profile: withTrustedTier(profile, getTrustedCurrentTimeMs()), cloud: true };
    }

    // A missing row is created without plan fields: the database trigger starts
    // the 14-day Pro trial, and the client is not allowed to write the tier.
    const { data: created } = await supabase
      .from('profiles')
      .upsert(
        {
          id: user.id,
          email: user.email ?? null,
          display_name: fallback.displayName,
          rider_profile: readLocalRiderProfile() ?? migration?.riderProfile ?? null,
          personal_goals: migration?.personalGoals ?? null,
        },
        { onConflict: 'id' },
      )
      .select(PROFILE_COLUMNS)
      .maybeSingle();

    return created
      ? {
          profile: withTrustedTier(
            toAthleteProfile(created as ProfileRow, user.email ?? null, fallback.displayName),
            getTrustedCurrentTimeMs(),
          ),
          cloud: true,
        }
      : { profile: fallback, cloud: false };
  } catch {
    return { profile: fallback, cloud: false };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<AthleteProfile | null>(null);
  const [status, setStatus] = useState<AuthStatus>(
    isSupabaseConfigured ? 'loading' : 'unconfigured',
  );
  const [ownerSimulatedTier, setOwnerSimulatedTier] = useState<SimulatedTier>('pro');
  const [trialExpiredNotice, setTrialExpiredNotice] = useState(false);
  const [sessionKicked, setSessionKicked] = useState(false);
  const [googleSignInPending, setGoogleSignInPending] = useState(false);
  const [googleAuthError, setGoogleAuthError] = useState<string | null>(null);
  const loadedUserIdRef = useRef<string | null>(null);
  const authEventSeenRef = useRef(false);
  const latestSyncRef = useRef<SubscriptionSyncResult | null>(null);
  const claimedAtRef = useRef(0);
  const kickedRef = useRef(false);
  const oauthCallbackHandledRef = useRef(false);
  const oauthLastCallbackRef = useRef<string | null>(null);
  const oauthCancelTimerRef = useRef<number | null>(null);

  /**
   * True while the profile in state came from a freshly read `profiles` row.
   * The row is then authoritative: an RPC result may still promote it (the
   * server can know about an activation the read missed) but never demote it,
   * so an admin downgrade is not undone by a stale `tier = 'pro'` column.
   */
  const profileFromCloudRef = useRef(false);

  const applySyncResult = useCallback((userId: string, result: SubscriptionSyncResult) => {
    latestSyncRef.current = result;
    setProfile((previous) => {
      if (!previous || previous.id !== userId) return previous;
      const now = getTrustedCurrentTimeMs();
      const next =
        profileFromCloudRef.current && result.tier !== 'pro'
          ? withTrustedTier(
              {
                ...previous,
                isOwner: previous.isOwner || result.isOwner,
                activeDeviceId: result.activeDeviceId ?? previous.activeDeviceId,
              },
              now,
            )
          : mergeSyncResult(previous, result, now);
      writeSubscriptionSnapshot(userId, next);
      return next;
    });
  }, []);

  /** Row -> context profile. The row is authoritative, so a downgrade sticks. */
  const applyProfileRow = useCallback(
    (row: ProfileRow | Record<string, unknown>, nameFallback: string): AthleteProfile => {
      profileFromCloudRef.current = true;
      return withTrustedTier(
        toAthleteProfile(row, session?.user?.email ?? null, nameFallback),
        getTrustedCurrentTimeMs(),
      );
    },
    [session],
  );

  const handleForeignDevice = useCallback(async (activeDeviceId: string | null) => {
    if (!activeDeviceId || activeDeviceId === getDeviceId()) return;
    // Offline, a failed or timed-out call, or an in-flight login claim must never
    // end the session: recording in the mountains comes first.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (isDeviceClaimInProgress() || kickedRef.current) return;
    if (Date.now() - claimedAtRef.current < CLAIM_GRACE_MS) return;

    kickedRef.current = true;
    setCachedActiveDeviceId(null);
    const supabase = getSupabaseClientOrNull();
    try {
      // Local scope: clears this session without clearing the new device's id.
      await supabase?.auth.signOut({ scope: 'local' });
    } catch {
      // The in-memory state below is cleared regardless.
    }

    loadedUserIdRef.current = null;
    profileFromCloudRef.current = false;
    setActiveUserId(null);
    setProfile(null);
    setSession(null);
    setOwnerSimulatedTier('pro');
    setTrialExpiredNotice(false);
    setStatus('unauthenticated');
    setSessionKicked(true);
  }, []);

  const syncSubscription = useCallback(async () => {
    const user = session?.user;
    if (!user) return;

    const result = await syncSubscriptionAndDevice();
    if (!result) {
      // Offline: still apply the trusted-clock auto-downgrade locally.
      setProfile((previous) =>
        previous ? withTrustedTier(previous, getTrustedCurrentTimeMs()) : previous,
      );
      return;
    }

    applySyncResult(user.id, result);
    await handleForeignDevice(result.activeDeviceId);
  }, [session, applySyncResult, handleForeignDevice]);

  useEffect(() => {
    const supabase = getSupabaseClientOrNull();
    if (!supabase) return;

    let alive = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        // An auth event is newer than this snapshot; never let the snapshot
        // overwrite a sign-in or sign-out that already arrived.
        if (!alive || authEventSeenRef.current) return;
        const next = data.session ?? null;
        setSession(next);
        if (next?.user) setActiveUserId(next.user.id);
        if (!next) setStatus('unauthenticated');
      })
      .catch(() => {
        if (alive && !authEventSeenRef.current) setStatus('unauthenticated');
      });

    const { data: listener } = supabase.auth.onAuthStateChange((event, next) => {
      if (!alive) return;
      authEventSeenRef.current = true;
      setSession(next);
      if (next?.user) setActiveUserId(next.user.id);
      if (event === 'SIGNED_OUT' || !next) {
        loadedUserIdRef.current = null;
        latestSyncRef.current = null;
        setActiveUserId(null);
        setProfile(null);
        setStatus('unauthenticated');
        return;
      }

      // `Last login wins`: a real sign-in claims this device. Supabase also
      // emits SIGNED_IN when it restores a stored session on launch, so an
      // existing claim is skipped: re-claiming on every boot would silently
      // overwrite the device that logged in later.
      if (event === 'SIGNED_IN' && next.user) {
        const alreadyClaimed = cachedActiveDeviceId() === getDeviceId();
        if (alreadyClaimed) return;

        void (async () => {
          const result = await claimActiveDevice();
          if (!alive || !result) return;
          claimedAtRef.current = Date.now();
          applySyncResult(next.user.id, result);
        })();
      }
    });

    return () => {
      alive = false;
      listener.subscription.unsubscribe();
    };
  }, [applySyncResult]);

  // Native OAuth return path. The listener lives at the app root so a deep link
  // that launches the app cold still lands on a session.
  useEffect(() => {
    if (!isNativePlatform()) return;

    let alive = true;
    const cleanups: (() => void)[] = [];

    const clearCancelTimer = () => {
      if (oauthCancelTimerRef.current === null) return;
      window.clearTimeout(oauthCancelTimerRef.current);
      oauthCancelTimerRef.current = null;
    };

    void (async () => {
      const removeUrlListener = await addOAuthUrlListener((url) => {
        if (!isOAuthCallbackUrl(url)) return;
        if (oauthLastCallbackRef.current === url) return;
        oauthLastCallbackRef.current = url;
        oauthCallbackHandledRef.current = true;
        clearCancelTimer();

        void (async () => {
          // A Custom Tab does not close itself once the deep link takes over.
          await closeInAppBrowser();
          const supabase = getSupabaseClientOrNull();
          if (!supabase) {
            setGoogleAuthError('Server ALLMOVA belum dikonfigurasi. Hubungi admin aplikasi.');
            setGoogleSignInPending(false);
            return;
          }
          try {
            // SIGNED_IN then drives the device claim, profile load and trial.
            await completeGoogleOAuth(supabase, url);
            setGoogleAuthError(null);
          } catch (cause) {
            setGoogleAuthError(translateAuthError(cause));
          } finally {
            setGoogleSignInPending(false);
          }
        })();
      });

      if (!alive) {
        removeUrlListener();
        return;
      }
      cleanups.push(removeUrlListener);

      const removeBrowserListener = await addBrowserFinishedListener(() => {
        setGoogleSignInPending(false);
        if (oauthCallbackHandledRef.current) return;
        // The tab can close a moment before the deep link lands: wait, then report.
        clearCancelTimer();
        oauthCancelTimerRef.current = window.setTimeout(() => {
          oauthCancelTimerRef.current = null;
          if (oauthCallbackHandledRef.current) return;
          setGoogleAuthError('Login Google dibatalkan. Coba lagi.');
        }, 1500);
      });

      if (!alive) {
        removeBrowserListener();
        return;
      }
      cleanups.push(removeBrowserListener);
    })();

    return () => {
      alive = false;
      cleanups.forEach((remove) => remove());
      clearCancelTimer();
    };
  }, []);

  // Loading is keyed on the user id, so token refreshes do not refetch the profile.
  useEffect(() => {
    const user = session?.user;
    if (!user) return;
    if (loadedUserIdRef.current === user.id) return;

    loadedUserIdRef.current = user.id;
    setActiveUserId(user.id);
    const migration = migrateLegacyStorage(user.id);
    setStatus('loading');

    // No per-run cancellation: a token refresh re-runs this effect with the same
    // user id, and dropping the in-flight profile fetch would leave the app on
    // the splash screen. Late results are ignored when the user id changed.
    void fetchProfile(user, migration)
      .then((fetched) => {
        if (loadedUserIdRef.current !== user.id) return;
        seedLocalCache(fetched.profile);
        const synced = resolveFetchedProfile(
          fetched,
          latestSyncRef.current,
          getTrustedCurrentTimeMs(),
        );
        profileFromCloudRef.current = fetched.cloud;
        writeSubscriptionSnapshot(user.id, synced);
        setProfile(synced);
        setStatus('authenticated');
      })
      .catch(() => {
        if (loadedUserIdRef.current !== user.id) return;
        setProfile(fallbackProfile(user));
        setStatus('authenticated');
      });
  }, [session]);

  // Sync on launch, when the app returns to the foreground and when it reconnects.
  useEffect(() => {
    const user = session?.user;
    if (!user) return;

    void syncSubscription();

    const onForeground = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void syncSubscription();
    };

    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    window.addEventListener('online', onForeground);

    // Android WebView pauses `visibilitychange` while a Custom Tab or the
    // launcher is in front, so the native app-state signal drives the refresh
    // that picks up an admin tier change.
    let cancelled = false;
    let removeNativeListener: (() => void) | null = null;
    void (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const handle = await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) void syncSubscription();
        });
        if (cancelled) {
          void handle.remove();
          return;
        }
        removeNativeListener = () => void handle.remove();
      } catch {
        // Web build without the native bridge: the DOM listeners cover it.
      }
    })();

    return () => {
      cancelled = true;
      removeNativeListener?.();
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
      window.removeEventListener('online', onForeground);
    };
  }, [session, syncSubscription]);

  // Realtime takeover detection, plus live tier changes from an admin activation.
  useEffect(() => {
    const user = session?.user;
    if (!user) return;

    return subscribeToProfileChanges(user.id, (row) => {
      // `row` may be a partial realtime payload; `toAthleteProfile` reads the
      // plan columns flexibly and keeps the last Pro signal when the echo is
      // older than a sync.
      const next = applyProfileRow(row, fallbackName(user));
      setProfile((previous) => {
        if (!previous || previous.id !== user.id) return previous;
        const merged: AthleteProfile = {
          ...next,
          riderProfile: previous.riderProfile,
          personalGoals: previous.personalGoals,
          displayName: previous.displayName,
        };
        writeSubscriptionSnapshot(user.id, merged);
        return merged;
      });

      if (row.active_device_id) void handleForeignDevice(row.active_device_id);
    });
  }, [applyProfileRow, session, handleForeignDevice]);

  // The one-time trial popup, gated per account in localStorage.
  useEffect(() => {
    const user = session?.user;
    if (!user || !profile || status !== 'authenticated') return;
    if (isOwnerEmail(user.email)) return;
    if (!isTrialExpired(profile, getTrustedCurrentTimeMs())) return;
    if (isTrialNoticeSeen(user.id)) return;
    // Marked as soon as it is shown, so the popup appears exactly once even if
    // the app is closed while it is still on screen.
    markTrialNoticeSeen(user.id);
    setTrialExpiredNotice(true);
  }, [profile, session, status]);

  const dismissTrialExpiredNotice = useCallback(() => {
    const userId = session?.user?.id;
    if (userId) markTrialNoticeSeen(userId);
    setTrialExpiredNotice(false);
  }, [session]);

  const dismissSessionKicked = useCallback(() => {
    setSessionKicked(false);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const supabase = getSupabaseClientOrNull();
    if (!supabase) throw new Error('Server ALLMOVA belum dikonfigurasi.');
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) throw error;
  }, []);

  /**
   * Google SSO. Native opens the Supabase URL in a Custom Tab and finishes in
   * the `appUrlOpen` listener; the web lets Supabase redirect the page.
   */
  const signInWithGoogle = useCallback(async () => {
    const supabase = getSupabaseClientOrNull();
    if (!supabase) throw new Error('Server ALLMOVA belum dikonfigurasi.');
    oauthCallbackHandledRef.current = false;
    oauthLastCallbackRef.current = null;
    setGoogleAuthError(null);
    setGoogleSignInPending(true);
    try {
      await startGoogleOAuth(supabase);
    } catch (cause) {
      setGoogleSignInPending(false);
      throw cause;
    }
  }, []);

  const clearGoogleAuthError = useCallback(() => {
    setGoogleAuthError(null);
  }, []);

  const signUp = useCallback(
    async (displayName: string, email: string, password: string): Promise<SignUpResult> => {
      const supabase = getSupabaseClientOrNull();
      if (!supabase) throw new Error('Server ALLMOVA belum dikonfigurasi.');
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { display_name: displayName.trim() } },
      });
      if (error) throw error;
      return { needsEmailConfirmation: !data.session };
    },
    [],
  );

  const requestPasswordReset = useCallback(async (email: string) => {
    const supabase = getSupabaseClientOrNull();
    if (!supabase) throw new Error('Server ALLMOVA belum dikonfigurasi.');
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
    if (error) throw error;
  }, []);

  const resetPasswordWithOtp = useCallback(
    async (email: string, token: string, newPassword: string) => {
      const supabase = getSupabaseClientOrNull();
      if (!supabase) throw new Error('Server ALLMOVA belum dikonfigurasi.');
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: token.trim(),
        type: 'recovery',
      });
      if (error) throw error;

      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
    },
    [],
  );

  const resetAuthState = useCallback(() => {
    loadedUserIdRef.current = null;
    latestSyncRef.current = null;
    profileFromCloudRef.current = false;
    kickedRef.current = false;
    setCachedActiveDeviceId(null);
    setActiveUserId(null);
    setProfile(null);
    setSession(null);
    setOwnerSimulatedTier('pro');
    setTrialExpiredNotice(false);
    setGoogleSignInPending(false);
    setGoogleAuthError(null);
    setStatus('unauthenticated');
  }, []);

  const signOut = useCallback(async () => {
    const supabase = getSupabaseClientOrNull();
    try {
      if (supabase) {
        const { error } = await supabase.auth.signOut();
        // Local scope clears the persisted session even when the network is down.
        if (error) await supabase.auth.signOut({ scope: 'local' });
      }
    } catch {
      try {
        await supabase?.auth.signOut({ scope: 'local' });
      } catch {
        // The in-memory state is cleared below regardless.
      }
    } finally {
      resetAuthState();
    }
  }, [resetAuthState]);

  const deleteAccount = useCallback(async () => {
    const userId = session?.user?.id ?? null;

    // Throws before touching local data when the server refuses, so the user
    // stays signed in and can retry.
    await deleteOwnAccount();

    clearLocalAccountData(userId);
    markAccountDeleted();

    const supabase = getSupabaseClientOrNull();
    try {
      await supabase?.auth.signOut();
    } catch {
      // The account is already gone server-side; local cleanup below still runs.
    }
    purgeSupabaseAuthStorage();
    resetAuthState();
  }, [session, resetAuthState]);

  const refreshProfile = useCallback(async () => {
    const user = session?.user;
    if (!user) return;

    await syncSubscription();
    if (loadedUserIdRef.current !== user.id) return;

    const fetched = await fetchProfile(user, null);
    const synced = resolveFetchedProfile(
      fetched,
      latestSyncRef.current,
      getTrustedCurrentTimeMs(),
    );
    profileFromCloudRef.current = fetched.cloud;
    writeSubscriptionSnapshot(user.id, synced);
    setProfile(synced);
  }, [session, syncSubscription]);

  const updateProfile = useCallback(
    async (patch: ProfileUpdate) => {
      const supabase = getSupabaseClientOrNull();
      const user = session?.user;
      if (!supabase || !user) return;

      // Only send the editable fields: a fallback (offline) profile must never
      // overwrite the server-owned tier, expiry or device columns.
      const columns = athleteProfileColumns(patch);
      if (Object.keys(columns).length === 0) return;

      const { data, error } = await supabase
        .from('profiles')
        .update(columns)
        .eq('id', user.id)
        .select(PROFILE_COLUMNS)
        .maybeSingle();

      if (error) throw new Error(error.message);

      if (data) {
        setProfile(
          applyProfileRow(data, profile?.displayName ?? fallbackName(user)),
        );
        return;
      }

      const { data: created, error: createError } = await supabase
        .from('profiles')
        .upsert(
          {
            id: user.id,
            email: user.email ?? null,
            display_name: profile?.displayName ?? fallbackName(user),
            ...columns,
          },
          { onConflict: 'id' },
        )
        .select(PROFILE_COLUMNS)
        .maybeSingle();

      if (createError) throw new Error(createError.message);

      if (created) {
        setProfile(
          applyProfileRow(created, profile?.displayName ?? fallbackName(user)),
        );
        return;
      }

      setProfile((previous) =>
        previous
          ? {
              ...previous,
              displayName: columns.display_name ?? previous.displayName,
              riderProfile:
                columns.rider_profile !== undefined
                  ? columns.rider_profile
                  : previous.riderProfile,
              personalGoals:
                columns.personal_goals !== undefined
                  ? columns.personal_goals
                  : previous.personalGoals,
            }
          : previous,
      );
    },
    [applyProfileRow, profile, session],
  );

  /**
   * Single write path for the athlete profile: React state, the per-account
   * offline cache and the cloud row are updated together, so the sheet always
   * reopens with the last saved values even after switching tabs.
   */
  const saveAthleteProfile = useCallback(
    async ({
      displayName,
      riderProfile,
    }: SaveAthleteProfileInput): Promise<SaveAthleteProfileResult> => {
      const user = session?.user;
      const saved = sanitizeRiderProfile({ ...riderProfile, displayName });

      if (user) {
        writeScopedStorage(USER_STORAGE_KEYS.riderProfile, JSON.stringify(saved));
        writeScopedStorage(USER_STORAGE_KEYS.displayName, saved.displayName);
      }

      setProfile((previous) =>
        previous
          ? { ...previous, displayName: saved.displayName, riderProfile: saved }
          : previous,
      );

      const supabase = getSupabaseClientOrNull();
      if (!supabase || !user) return { profile: saved, synced: false };

      try {
        const { data, error } = await supabase
          .from('profiles')
          .update({ display_name: saved.displayName, rider_profile: saved })
          .eq('id', user.id)
          .select(PROFILE_COLUMNS)
          .maybeSingle();

        if (error) return { profile: saved, synced: false };

        if (data) {
          setProfile(applyProfileRow(data, saved.displayName));
          return { profile: saved, synced: true };
        }

        // A missing row is created with only the editable columns, so the
        // protect_profile_tier trigger never sees a plan change.
        const { error: createError } = await supabase.from('profiles').upsert(
          {
            id: user.id,
            email: user.email ?? null,
            display_name: saved.displayName,
            rider_profile: saved,
          },
          { onConflict: 'id' },
        );

        return { profile: saved, synced: !createError };
      } catch {
        return { profile: saved, synced: false };
      }
    },
    [applyProfileRow, session],
  );

  const isOwner = isOwnerEmail(session?.user?.email) || profile?.isOwner === true;
  const trustedNow = getTrustedCurrentTimeMs();
  const planIsPro = profile ? isProfilePro(profile, trustedNow) : false;
  const isPro = isOwner ? ownerSimulatedTier === 'pro' : planIsPro;
  const trialDays = profile ? trialDaysLeftOf(profile, trustedNow) : null;
  const tier: PlanTier = profile?.tier ?? 'free';

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      isConfigured: isSupabaseConfigured,
      user: session?.user ?? null,
      profile,
      isPro,
      isOwner,
      tier,
      trialDaysLeft: trialDays,
      trialExpiredNotice,
      dismissTrialExpiredNotice,
      sessionKicked,
      dismissSessionKicked,
      ownerSimulatedTier,
      setOwnerSimulatedTier,
      signIn,
      signInWithGoogle,
      googleSignInPending,
      googleAuthError,
      clearGoogleAuthError,
      signUp,
      requestPasswordReset,
      resetPasswordWithOtp,
      signOut,
      deleteAccount,
      refreshProfile,
      refreshSubscription: syncSubscription,
      updateProfile,
      saveAthleteProfile,
    }),
    [
      status,
      session,
      profile,
      isPro,
      isOwner,
      tier,
      trialDays,
      trialExpiredNotice,
      dismissTrialExpiredNotice,
      sessionKicked,
      dismissSessionKicked,
      ownerSimulatedTier,
      signIn,
      signInWithGoogle,
      googleSignInPending,
      googleAuthError,
      clearGoogleAuthError,
      signUp,
      requestPasswordReset,
      resetPasswordWithOtp,
      signOut,
      deleteAccount,
      refreshProfile,
      syncSubscription,
      updateProfile,
      saveAthleteProfile,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth harus dipakai di dalam AuthProvider.');
  return context;
}
