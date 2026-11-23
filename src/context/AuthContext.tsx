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

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'unconfigured';
export type SimulatedTier = 'pro' | 'free';

type SignUpResult = { needsEmailConfirmation: boolean };

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
};

const AuthContext = createContext<AuthContextValue | null>(null);

function fallbackName(user: User): string {
  const meta = user.user_metadata?.display_name;
  if (typeof meta === 'string' && meta.trim().length > 0) return meta.trim();
  const email = user.email ?? '';
  return email.split('@')[0] || 'Atlet Tracker 3D';
}

function fallbackProfile(user: User): AthleteProfile {
  return {
    id: user.id,
    email: user.email ?? null,
    displayName: fallbackName(user),
    planTier: 'free',
    proExpiresAt: null,
    riderProfile: null,
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
          rider_profile: migration?.riderProfile ?? null,
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
    if (!supabase) throw new Error('Supabase belum dikonfigurasi.');
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) throw error;
  }, []);

  const signUp = useCallback(
    async (displayName: string, email: string, password: string): Promise<SignUpResult> => {
      const supabase = getSupabaseClientOrNull();
      if (!supabase) throw new Error('Supabase belum dikonfigurasi.');
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
    if (!supabase) throw new Error('Supabase belum dikonfigurasi.');
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
    if (error) throw error;
  }, []);

  const resetPasswordWithOtp = useCallback(
    async (email: string, token: string, newPassword: string) => {
      const supabase = getSupabaseClientOrNull();
      if (!supabase) throw new Error('Supabase belum dikonfigurasi.');
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
      await supabase?.auth.signOut();
    } catch {
      // A failed network call must still leave the device signed out.
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

      const current = profile;
      const payload = {
        id: user.id,
        email: user.email ?? current?.email ?? null,
        display_name: current?.displayName ?? fallbackName(user),
        plan_tier: current?.planTier ?? 'free',
        pro_expires_at: current?.proExpiresAt ?? null,
        rider_profile: current?.riderProfile ?? null,
        personal_goals: current?.personalGoals ?? null,
        ...patch,
      };

      const { data, error } = await supabase
        .from('profiles')
        .upsert(payload, { onConflict: 'id' })
        .select(PROFILE_COLUMNS)
        .maybeSingle();

      if (error) throw new Error(error.message);

      if (data) {
        setProfile(
          toAthleteProfile(data as ProfileRow, user.email ?? null, payload.display_name),
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
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth harus dipakai di dalam AuthProvider.');
  return context;
}
