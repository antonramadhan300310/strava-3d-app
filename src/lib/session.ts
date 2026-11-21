import { normalizeActivityType, type ActivityType } from './valhalla';
import type { AcceptedPoint } from './metrics';

const STORAGE_KEY = 'tracker3d:active-session:v1';

export type SessionStatus = 'recording' | 'paused';

export type SavedSession = {
  version: 1;
  activityType: ActivityType;
  status: SessionStatus;
  /** Active (unpaused) time accumulated before the backup was written. */
  activeMs: number;
  /** Epoch milliseconds when the session started. */
  startedAt: number;
  /** Epoch milliseconds of the last backup, used to label the restore prompt. */
  savedAt: number;
  points: AcceptedPoint[];
};

/**
 * Mirrors the in-flight session into `localStorage` so a force-closed app does
 * not lose a recorded track.
 */
export function saveSession(session: Omit<SavedSession, 'version' | 'savedAt'>): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: SavedSession = { ...session, version: 1, savedAt: Date.now() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage can be full or blocked (private mode); recording continues.
  }
}

export function loadSession(): SavedSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedSession>;
    if (parsed.version !== 1 || !Array.isArray(parsed.points) || parsed.points.length === 0) {
      return null;
    }
    const storedType = parsed.activityType as string | undefined;
    if (
      storedType !== 'ride' &&
      storedType !== 'cycling' &&
      storedType !== 'run' &&
      storedType !== 'walking' &&
      storedType !== 'hike'
    ) {
      return null;
    }
    return {
      version: 1,
      activityType: normalizeActivityType(storedType),
      status: parsed.status === 'recording' ? 'recording' : 'paused',
      activeMs: Number.isFinite(parsed.activeMs) ? Number(parsed.activeMs) : 0,
      startedAt: Number.isFinite(parsed.startedAt) ? Number(parsed.startedAt) : Date.now(),
      savedAt: Number.isFinite(parsed.savedAt) ? Number(parsed.savedAt) : Date.now(),
      points: parsed.points,
    };
  } catch {
    return null;
  }
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: an unreadable key is as good as a cleared one.
  }
}
