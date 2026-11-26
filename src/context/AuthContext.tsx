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
  toAthleteProfile,
  withTrustedTier,
  type AthleteProfile,
  type PlanTier,
  type ProfileRow,
  type ProfileUpdate,
} from '@/lib/subscription';
import {
  describePlan,
  mergePlanSignal,
  pickPlanSignal,
  resolvePlanProfile,
  type FetchedProfile,
  type PlanSignal,
} from '@/lib/planState';
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

/** Outcome of a forced `profiles` + RPC read, so the sheet can show a toast. */
export type RefreshProfileResult = {
  ok: boolean;
  /** Indonesian reason the read/sync failed; `null` when it succeeded. */
  error: string | null;
};

type AuthContextValue = {
  status: AuthStatus;
  isConfigured: boolean;
  user: User | null;
  profile: AthleteProfile | null;
  isPro: boolean;
  isOwner: boolean;
  /** True only for a dated Pro account whose `subscription_source` is `trial`. */
  isTrial: boolean;
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
  /** Forces a fresh `profiles` + RPC read and reports the outcome. */
  refreshProfile: () => Promise<RefreshProfileResult>;
  /** True while `refreshProfile()` is in flight (drives the sheet spinner). */
  subscriptionRefreshing: boolean;
  /**
   * Indonesian reason the last plan read/sync failed. `null` when the plan in
   * `profile` is backed by a successful server read.
   */
  subscriptionError: string | null;
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
      subscriptionSource: snapshot?.subscriptionSource ?? null,
      riderProfile: local,
      personalGoals: null,
      serverVerifiedAt: null,
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

const PROFILE_READ_FAILED =
  'Gagal membaca detail profil dari server. Status langganan memakai data terbaru yang tersedia.';
const SYNC_FAILED = 'Gagal menyinkronkan status langganan. Periksa koneksi lalu coba lagi.';

/** Indonesian, actionable copy for a failed `profiles` read. */
function profileReadError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  if (/jwt|token|session|not_authenticated|401/i.test(raw)) {
    return 'Sesi login kedaluwarsa. Masuk kembali untuk menyegarkan status langganan.';
  }
  return raw ? `${PROFILE_READ_FAILED} (${raw})` : PROFILE_READ_FAILED;
}

async function fetchProfile(
  user: User,
  migration: LegacyMigration | null,
): Promise<FetchedProfile> {
  const supabase = getSupabaseClientOrNull();
  const fallback = fallbackProfile(user);
  if (!supabase) {
    return { profile: fallback, cloud: false, error: null };
  }

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', user.id)
      .maybeSingle();

    if (error) {
      // Never silent: a swallowed read error is what left a paid account on the
      // stale offline snapshot (and therefore on "AKUN FREE") for days.
      console.warn('[ALLMOVA] gagal membaca public.profiles:', error.message);
      return { profile: fallback, cloud: false, error: profileReadError(error.message) };
    }

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

      return {
        profile: withTrustedTier(profile, getTrustedCurrentTimeMs()),
        cloud: true,
        error: null,
      };
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
          error: null,
        }
      : { profile: fallback, cloud: false, error: PROFILE_READ_FAILED };
  } catch (cause) {
    console.warn('[ALLMOVA] gagal membaca public.profiles:', cause);
    return { profile: fallback, cloud: false, error: profileReadError(cause) };
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
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [subscriptionRefreshing, setSubscriptionRefreshing] = useState(false);
  const loadedUserIdRef = useRef<string | null>(null);
  const authEventSeenRef = useRef(false);
  const latestSyncRef = useRef<PlanSignal | null>(null);
  /** Last profile built from a server row: the base every verdict merges onto. */
  const serverProfileRef = useRef<AthleteProfile | null>(null);
  /** In-flight `refreshProfile()`; a second tap joins it instead of no-opping. */
  const refreshInFlightRef = useRef<Promise<RefreshProfileResult> | null>(null);
  const claimedAtRef = useRef(0);
  const kickedRef = useRef(false);
  const oauthCallbackHandledRef = useRef(false);
  const oauthLastCallbackRef = useRef<string | null>(null);
  const oauthCancelTimerRef = useRef<number | null>(null);

  /**
   * Applies a server verdict to the profile in state. `mergePlanSignal` never
   * demotes a Pro row and never lets a stale `tier = 'free'` erase a `plan_tier`
   * activation, so this is the only write path a sync needs.
   *
   * The verdict is merged onto the last *server row* rather than onto the values
   * already on screen, so a cached date can never outlive the row it came from:
   * a shortened or extended expiry from the admin panel always lands.
   */
  const applySyncResult = useCallback((userId: string, result: PlanSignal) => {
    latestSyncRef.current = result;
    setProfile((previous) => {
      if (!previous || previous.id !== userId) return previous;
      const base =
        serverProfileRef.current && serverProfileRef.current.id === userId
          ? serverProfileRef.current
          : previous;
      const merged = mergePlanSignal(base, result, getTrustedCurrentTimeMs());
      // Local-only fields (display name, rider profile) stay with the screen.
      const next: AthleteProfile = {
        ...previous,
        tier: merged.tier,
        proExpiresAt: merged.proExpiresAt,
        isOwner: merged.isOwner,
        activeDeviceId: merged.activeDeviceId,
        subscriptionSource: merged.subscriptionSource,
        serverVerifiedAt: merged.serverVerifiedAt,
      };
      serverProfileRef.current = merged;
      writeSubscriptionSnapshot(userId, next);
      return next;
    });
  }, []);

  /** Row -> context profile, with the same merge rule as a sync result. */
  const applyProfileRow = useCallback(
    (row: ProfileRow | Record<string, unknown>, nameFallback: string): AthleteProfile => {
      const next = withTrustedTier(
        toAthleteProfile(row, session?.user?.email ?? null, nameFallback),
        getTrustedCurrentTimeMs(),
      );
      serverProfileRef.current = next;
      return next;
    },
    [session],
  );

  /**
   * Row read with one retry. A single failed request used to leave the account
   * on the stale offline snapshot, which is exactly how a verified `pro` row
   * still rendered as "AKUN FREE" until the next app restart.
   */
  const loadProfile = useCallback(
    async (user: User, migration: LegacyMigration | null): Promise<FetchedProfile> => {
      const first = await fetchProfile(user, migration);
      if (first.cloud) return first;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return first;

      await new Promise((resolve) => setTimeout(resolve, 800));
      const retried = await fetchProfile(user, migration);
      return retried.cloud ? retried : { ...retried, error: retried.error ?? first.error };
    },
    [],
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
    latestSyncRef.current = null;
    serverProfileRef.current = null;
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
      if (typeof navigator !== 'undefined' && navigator.onLine !== false) {
        setSubscriptionError((current) => current ?? SYNC_FAILED);
      }
      return;
    }

    setSubscriptionError(null);
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
        serverProfileRef.current = null;
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
    void loadProfile(user, migration)
      .then((fetched) => {
        if (loadedUserIdRef.current !== user.id) return;
        seedLocalCache(fetched.profile);
        // `latestSyncRef` only holds a verdict from this session (it is cleared
        // on sign-out), so its date cannot be older than the row just read; it
        // keeps the server-verified flag when the RPC answered first.
        const synced = resolvePlanProfile(
          fetched,
          latestSyncRef.current,
          getTrustedCurrentTimeMs(),
        );
        serverProfileRef.current = fetched.profile;
        writeSubscriptionSnapshot(user.id, synced);
        setProfile(synced);
        setSubscriptionError(fetched.error);
        setStatus('authenticated');
      })
      .catch(() => {
        if (loadedUserIdRef.current !== user.id) return;
        setProfile(fallbackProfile(user));
        setStatus('authenticated');
      });
  }, [session, loadProfile]);

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
    if (!describePlan(profile, getTrustedCurrentTimeMs()).expired) return;
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
    serverProfileRef.current = null;
    refreshInFlightRef.current = null;
    kickedRef.current = false;
    setCachedActiveDeviceId(null);
    setActiveUserId(null);
    setProfile(null);
    setSession(null);
    setOwnerSimulatedTier('pro');
    setTrialExpiredNotice(false);
    setGoogleSignInPending(false);
    setGoogleAuthError(null);
    setSubscriptionError(null);
    setSubscriptionRefreshing(false);
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

  /**
   * Forces a fresh read on demand (opening the Athlete Profile, tapping
   * "Perbarui status langganan"). Nothing is served from a ref or a cache: the
   * `profiles` row and the RPC are always fetched, in parallel, and the row's
   * newest values replace the ones on screen — the admin panel is the source of
   * truth, so a shortened expiry or a downgrade must land on the next tap.
   *
   * Resolves with the outcome instead of swallowing it, so the sheet can show
   * "Status langganan diperbarui" or the exact failure. A second tap while a
   * request is in flight joins that request rather than returning early.
   */
  const refreshProfile = useCallback(async (): Promise<RefreshProfileResult> => {
    const user = session?.user;
    if (!user) {
      return { ok: false, error: 'Sesi login tidak ditemukan. Masuk kembali untuk memperbarui.' };
    }
    if (refreshInFlightRef.current) return refreshInFlightRef.current;

    const run = (async (): Promise<RefreshProfileResult> => {
      setSubscriptionRefreshing(true);
      try {
        const [fetched, signal] = await Promise.all([
          loadProfile(user, null),
          syncSubscriptionAndDevice(),
        ]);

        // A cached verdict may only fill in for a row that could not be read.
        const verdict = pickPlanSignal(fetched, signal, latestSyncRef.current);
        if (signal) latestSyncRef.current = signal;

        if (verdict) await handleForeignDevice(verdict.activeDeviceId);

        // Signed out or taken over while the request was in flight: never write
        // this session's plan onto a different (or no) account.
        if (loadedUserIdRef.current !== user.id) {
          return { ok: false, error: 'Sesi login berubah saat memperbarui status langganan.' };
        }

        const now = getTrustedCurrentTimeMs();
        const synced = resolvePlanProfile(fetched, verdict, now);
        serverProfileRef.current = fetched.profile;
        writeSubscriptionSnapshot(user.id, synced);
        setProfile(synced);

        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        const error = fetched.error ?? (verdict || offline ? null : SYNC_FAILED);
        setSubscriptionError(error);
        return { ok: error === null, error };
      } catch (cause) {
        const error = profileReadError(cause);
        setSubscriptionError(error);
        return { ok: false, error };
      } finally {
        setSubscriptionRefreshing(false);
        refreshInFlightRef.current = null;
      }
    })();

    refreshInFlightRef.current = run;
    return run;
  }, [handleForeignDevice, loadProfile, session]);

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

  // One derivation for every consumer: the sheet, the nav lock and the paywall
  // all read these values, so they can never disagree with each other.
  const plan = describePlan(profile, getTrustedCurrentTimeMs());
  const isOwner = isOwnerEmail(session?.user?.email) || plan.isOwner;
  const isPro = isOwner ? ownerSimulatedTier === 'pro' : plan.isPro;
  const isTrial = !isOwner && plan.isTrial;
  const trialDays = plan.daysLeft;
  const tier: PlanTier = plan.tier;

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      isConfigured: isSupabaseConfigured,
      user: session?.user ?? null,
      profile,
      isPro,
      isOwner,
      isTrial,
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
      subscriptionRefreshing,
      subscriptionError,
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
      isTrial,
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
      subscriptionRefreshing,
      subscriptionError,
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
