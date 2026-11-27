/**
 * Device-wide recording preferences.
 *
 * The auto-pause toggle follows the phone, not the account (like the map
 * provider), so it is stored outside the per-account namespace.
 */

const AUTO_PAUSE_KEY = 'allmova_auto_pause_enabled_v1';

/** Auto-pause is on by default, matching the behaviour Strava users expect. */
export function isAutoPauseEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(AUTO_PAUSE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setAutoPauseEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AUTO_PAUSE_KEY, enabled ? 'true' : 'false');
  } catch {
    // A blocked write keeps the choice for this session only.
  }
}
