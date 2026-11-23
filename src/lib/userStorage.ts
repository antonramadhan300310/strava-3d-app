/**
 * Per-account localStorage scoping.
 *
 * Every cache key is suffixed with the active Supabase user id so two accounts
 * on the same device never read each other's data. The active id lives in
 * module memory and is set by `AuthContext` before any screen mounts.
 */

export const USER_STORAGE_KEYS = {
  riderProfile: 'tracker3d_rider_profile_v1',
  personalGoals: 'personal_goals_v1',
  heatmap: 'tracker3d_personal_heatmap_v1',
  weather: 'tracker3d_activity_weather_v1',
  rpe: 'tracker3d_activity_rpe_v1',
  session: 'tracker3d:active-session:v1',
} as const;

const MIGRATED_KEYS: string[] = Object.values(USER_STORAGE_KEYS);

let activeUserId: string | null = null;

export function setActiveUserId(userId: string | null): void {
  activeUserId = userId;
}

export function getActiveUserId(): string | null {
  return activeUserId;
}

export function scopedStorageKey(baseKey: string): string {
  return activeUserId ? `${baseKey}_${activeUserId}` : baseKey;
}

export function readScopedStorage(baseKey: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(scopedStorageKey(baseKey));
  } catch {
    return null;
  }
}

export function writeScopedStorage(baseKey: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(scopedStorageKey(baseKey), value);
  } catch {
    // A full quota or private mode must not break the feature.
  }
}

export function removeScopedStorage(baseKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(scopedStorageKey(baseKey));
  } catch {
    // Nothing to remove when storage is unavailable.
  }
}

export type LegacyMigration = {
  migratedKeys: string[];
  riderProfile: unknown;
  personalGoals: unknown;
};

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Moves device-wide keys written before accounts existed to the signed-in
 * user's namespace, then deletes the legacy copies.
 */
export function migrateLegacyStorage(userId: string): LegacyMigration {
  const result: LegacyMigration = { migratedKeys: [], riderProfile: null, personalGoals: null };
  if (typeof window === 'undefined' || !userId) return result;

  for (const base of MIGRATED_KEYS) {
    try {
      const legacy = window.localStorage.getItem(base);
      if (legacy === null) continue;

      const target = `${base}_${userId}`;
      if (window.localStorage.getItem(target) === null) {
        window.localStorage.setItem(target, legacy);
      }
      window.localStorage.removeItem(base);

      result.migratedKeys.push(base);
      if (base === USER_STORAGE_KEYS.riderProfile) result.riderProfile = parseJson(legacy);
      if (base === USER_STORAGE_KEYS.personalGoals) result.personalGoals = parseJson(legacy);
    } catch {
      // Skip the key: a blocked storage read is the same as absent data.
    }
  }

  return result;
}
