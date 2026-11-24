/**
 * Per-account localStorage scoping.
 *
 * Every cache key is suffixed with the active account id so two accounts on the
 * same device never read each other's data. The active id lives in module
 * memory and is set by `AuthContext` before any screen mounts.
 *
 * Reads and writes are refused while no account is active: falling back to the
 * unsuffixed key would expose whatever the previous account left behind.
 */

export const USER_STORAGE_KEYS = {
  riderProfile: 'tracker3d_rider_profile_v1',
  displayName: 'tracker3d_display_name_v1',
  personalGoals: 'personal_goals_v1',
  heatmap: 'tracker3d_personal_heatmap_v1',
  weather: 'tracker3d_activity_weather_v1',
  rpe: 'tracker3d_activity_rpe_v1',
  session: 'tracker3d:active-session:v1',
  offlineActivities: 'tracker3d_offline_activities_v1',
} as const;

/** Device-wide keys written before accounts existed. */
const LEGACY_MIGRATED_KEYS: string[] = [
  USER_STORAGE_KEYS.riderProfile,
  USER_STORAGE_KEYS.displayName,
  USER_STORAGE_KEYS.personalGoals,
];

/**
 * Activity-shaped legacy keys are deleted rather than migrated: their owner is
 * unknown, so copying them into the next account would leak the previous
 * account's tracks.
 */
const LEGACY_ACTIVITY_KEYS: string[] = [
  USER_STORAGE_KEYS.heatmap,
  USER_STORAGE_KEYS.weather,
  USER_STORAGE_KEYS.rpe,
  USER_STORAGE_KEYS.session,
  USER_STORAGE_KEYS.offlineActivities,
];

let activeUserId: string | null = null;

export function setActiveUserId(userId: string | null): void {
  activeUserId = userId;
}

export function getActiveUserId(): string | null {
  return activeUserId;
}

/** `null` when there is no account: callers must not touch unscoped storage. */
export function userStorageKey(baseKey: string, userId: string | null): string | null {
  return userId ? `${baseKey}_${userId}` : null;
}

export function scopedStorageKey(baseKey: string): string | null {
  return userStorageKey(baseKey, activeUserId);
}

export function readUserStorage(baseKey: string, userId: string | null): string | null {
  if (typeof window === 'undefined') return null;
  const key = userStorageKey(baseKey, userId);
  if (!key) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeUserStorage(baseKey: string, userId: string | null, value: string): void {
  if (typeof window === 'undefined') return;
  const key = userStorageKey(baseKey, userId);
  if (!key) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A full quota or private mode must not break the feature.
  }
}

export function removeUserStorage(baseKey: string, userId: string | null): void {
  if (typeof window === 'undefined') return;
  const key = userStorageKey(baseKey, userId);
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to remove when storage is unavailable.
  }
}

export function readScopedStorage(baseKey: string): string | null {
  return readUserStorage(baseKey, activeUserId);
}

export function writeScopedStorage(baseKey: string, value: string): void {
  writeUserStorage(baseKey, activeUserId, value);
}

export function removeScopedStorage(baseKey: string): void {
  removeUserStorage(baseKey, activeUserId);
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

/** Deletes ownerless activity caches left by older app versions. */
export function purgeLegacyActivityStorage(): void {
  if (typeof window === 'undefined') return;
  for (const base of LEGACY_ACTIVITY_KEYS) {
    try {
      window.localStorage.removeItem(base);
    } catch {
      // A blocked storage call is the same as absent data.
    }
  }
}

/**
 * Moves device-wide profile keys written before accounts existed to the
 * signed-in user's namespace, then deletes the legacy copies. Activity caches
 * are purged, never migrated.
 */
export function migrateLegacyStorage(userId: string): LegacyMigration {
  const result: LegacyMigration = { migratedKeys: [], riderProfile: null, personalGoals: null };
  if (typeof window === 'undefined' || !userId) return result;

  purgeLegacyActivityStorage();

  for (const base of LEGACY_MIGRATED_KEYS) {
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
