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
  toAthleteProfile,
  type AthleteProfile,
  type ProfileRow,
  type ProfileUpdate,
} from '@/lib/subscription';
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
  ownerSimulatedTier: SimulatedTier;
  setOwnerSimulatedTier: (tier: SimulatedTier) => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (displayName: string, email: string, password: string) => Promise<SignUpResult>;
  requestPasswordReset: (email: string) => Promise<void>;
  resetPasswordWithOtp: (email: string, token: string, newPassword: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateProfile: (patch: ProfileUpdate) => Promise<void>;
  saveAthleteProfile: (input: SaveAthleteProfileInput) => Promise<SaveAthleteProfileResult>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

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

function fallbackProfile(user: User): AthleteProfile {
  const local = readLocalRiderProfile();
  return {
    id: user.id,
    email: user.email ?? null,
    displayName: local?.displayName ?? fallbackName(user),
    planTier: 'free',
    proExpiresAt: null,
    riderProfile: local,
    personalGoals: null,
  };
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

async function fetchProfile(
  user: User,
  migration: LegacyMigration | null,
): Promise<AthleteProfile> {
  const supabase = getSupabaseClientOrNull();
  const fallback = fallbackProfile(user);
  if (!supabase) return fallback;

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', user.id)
      .maybeSingle();

    if (error) return fallback;

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

      return profile;
    }

    const { data: created } = await supabase
      .from('profiles')
      .upsert(
        {
          id: user.id,
          email: user.email ?? null,
          display_name: fallback.displayName,
          plan_tier: 'free',
          pro_expires_at: null,
          rider_profile: readLocalRiderProfile() ?? migration?.riderProfile ?? null,
          personal_goals: migration?.personalGoals ?? null,
        },
        { onConflict: 'id' },
      )
      .select(PROFILE_COLUMNS)
      .maybeSingle();

    return created
      ? toAthleteProfile(created as ProfileRow, user.email ?? null, fallback.displayName)
      : fallback;
  } catch {
    return fallback;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<AthleteProfile | null>(null);
  const [status, setStatus] = useState<AuthStatus>(
    isSupabaseConfigured ? 'loading' : 'unconfigured',
  );
  const [ownerSimulatedTier, setOwnerSimulatedTier] = useState<SimulatedTier>('pro');
  const loadedUserIdRef = useRef<string | null>(null);
  const authEventSeenRef = useRef(false);

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
        if (!next) setStatus('unauthenticated');
      })
      .catch(() => {
        if (alive && !authEventSeenRef.current) setStatus('unauthenticated');
      });

    const { data: listener } = supabase.auth.onAuthStateChange((event, next) => {
      if (!alive) return;
      authEventSeenRef.current = true;
      setSession(next);
      if (event === 'SIGNED_OUT' || !next) {
        loadedUserIdRef.current = null;
        setActiveUserId(null);
        setProfile(null);
        setStatus('unauthenticated');
      }
    });

    return () => {
      alive = false;
      listener.subscription.unsubscribe();
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
      .then((next) => {
        if (loadedUserIdRef.current !== user.id) return;
        seedLocalCache(next);
        setProfile(next);
        setStatus('authenticated');
      })
      .catch(() => {
        if (loadedUserIdRef.current !== user.id) return;
        setProfile(fallbackProfile(user));
        setStatus('authenticated');
      });
  }, [session]);

  const signIn = useCallback(async (email: string, password: string) => {
    const supabase = getSupabaseClientOrNull();
    if (!supabase) throw new Error('Server ALLMOVA belum dikonfigurasi.');
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) throw error;
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
      loadedUserIdRef.current = null;
      setActiveUserId(null);
      setProfile(null);
      setSession(null);
      setOwnerSimulatedTier('pro');
      setStatus('unauthenticated');
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    const user = session?.user;
    if (!user) return;
    setProfile(await fetchProfile(user, null));
  }, [session]);

  const updateProfile = useCallback(
    async (patch: ProfileUpdate) => {
      const supabase = getSupabaseClientOrNull();
      const user = session?.user;
      if (!supabase || !user) return;

      // Only send the changed fields: a fallback (offline) profile must never
      // overwrite the real plan_tier or expiry in the cloud.
      const { data, error } = await supabase
        .from('profiles')
        .update(patch)
        .eq('id', user.id)
        .select(PROFILE_COLUMNS)
        .maybeSingle();

      if (error) throw new Error(error.message);

      if (data) {
        setProfile(
          toAthleteProfile(
            data as ProfileRow,
            user.email ?? null,
            profile?.displayName ?? fallbackName(user),
          ),
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
            plan_tier: 'free',
            pro_expires_at: null,
            ...patch,
          },
          { onConflict: 'id' },
        )
        .select(PROFILE_COLUMNS)
        .maybeSingle();

      if (createError) throw new Error(createError.message);

      if (created) {
        setProfile(
          toAthleteProfile(
            created as ProfileRow,
            user.email ?? null,
            profile?.displayName ?? fallbackName(user),
          ),
        );
        return;
      }

      setProfile((previous) =>
        previous
          ? {
              ...previous,
              displayName: patch.display_name ?? previous.displayName,
              planTier: patch.plan_tier ?? previous.planTier,
              proExpiresAt:
                patch.pro_expires_at !== undefined
                  ? patch.pro_expires_at
                  : previous.proExpiresAt,
              riderProfile:
                patch.rider_profile !== undefined ? patch.rider_profile : previous.riderProfile,
              personalGoals:
                patch.personal_goals !== undefined
                  ? patch.personal_goals
                  : previous.personalGoals,
            }
          : previous,
      );
    },
    [profile, session],
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
          setProfile(
            toAthleteProfile(data as ProfileRow, user.email ?? null, saved.displayName),
          );
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
    [session],
  );

  const isOwner = isOwnerEmail(session?.user?.email);
  const planIsPro = profile ? isProfilePro(profile) : false;
  const isPro = isOwner ? ownerSimulatedTier === 'pro' : planIsPro;

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      isConfigured: isSupabaseConfigured,
      user: session?.user ?? null,
      profile,
      isPro,
      isOwner,
      ownerSimulatedTier,
      setOwnerSimulatedTier,
      signIn,
      signUp,
      requestPasswordReset,
      resetPasswordWithOtp,
      signOut,
      refreshProfile,
      updateProfile,
      saveAthleteProfile,
    }),
    [
      status,
      session,
      profile,
      isPro,
      isOwner,
      ownerSimulatedTier,
      signIn,
      signUp,
      requestPasswordReset,
      resetPasswordWithOtp,
      signOut,
      refreshProfile,
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
