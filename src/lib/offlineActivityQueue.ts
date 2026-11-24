import type { ActivityType } from './valhalla';
import type { ActivityWeather } from './weatherService';
import type { LngLatEle } from './polyline';
import { saveRecordedActivity, type RecordedActivity } from './supabase';
import {
  readUserStorage,
  removeUserStorage,
  USER_STORAGE_KEYS,
  writeUserStorage,
} from './userStorage';

/**
 * Offline recordings waiting for a connection.
 *
 * The queue key is scoped to the active account and every item carries the
 * `user_id` that created it, so a recording made by one account can never be
 * uploaded into another account after a switch.
 */
export type QueuedActivity = {
  id: string;
  /** Owner captured when the recording was saved offline. */
  user_id: string;
  title: string;
  activity_type: ActivityType;
  distance_meters: number;
  elevation_gain: number;
  duration_seconds: number;
  coordinates: LngLatEle[];
  weather: ActivityWeather | null;
  rpe: number | null;
  queued_at: number;
};

const QUEUE_KEY = USER_STORAGE_KEYS.offlineActivities;
const flushing = new Set<string>();

function isQueuedActivity(value: unknown): value is QueuedActivity {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<QueuedActivity>;
  return (
    typeof item.id === 'string' &&
    typeof item.user_id === 'string' &&
    item.user_id.length > 0 &&
    typeof item.title === 'string' &&
    Array.isArray(item.coordinates) &&
    item.coordinates.length >= 2
  );
}

function readQueueItems(userId: string | null): QueuedActivity[] {
  if (!userId) return [];
  try {
    const raw = readUserStorage(QUEUE_KEY, userId);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isQueuedActivity);
  } catch {
    return [];
  }
}

export function readOfflineQueue(userId: string | null): QueuedActivity[] {
  return readQueueItems(userId).filter((item) => item.user_id === userId);
}

function writeOfflineQueue(userId: string, items: QueuedActivity[]): void {
  if (items.length === 0) {
    removeUserStorage(QUEUE_KEY, userId);
    return;
  }
  writeUserStorage(QUEUE_KEY, userId, JSON.stringify(items));
}

export function enqueueOfflineActivity(
  userId: string,
  activity: Omit<RecordedActivity, 'userId'>,
): QueuedActivity {
  if (!userId) throw new Error('Sesi login tidak ditemukan. Silakan masuk kembali.');

  const item: QueuedActivity = {
    id: `${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    user_id: userId,
    title: activity.title,
    activity_type: activity.activityType,
    distance_meters: activity.distanceMeters,
    elevation_gain: activity.elevationGain,
    duration_seconds: activity.durationSeconds,
    coordinates: activity.coordinates,
    weather: activity.weather ?? null,
    rpe: activity.rpe ?? null,
    queued_at: Date.now(),
  };

  writeOfflineQueue(userId, [...readQueueItems(userId), item]);
  return item;
}

export function offlineQueueSize(userId: string | null): number {
  return readOfflineQueue(userId).length;
}

/**
 * Uploads only the items owned by `userId`. Returns how many rows were saved;
 * failed items stay queued for the next reconnect.
 */
export async function flushOfflineActivityQueue(userId: string | null): Promise<number> {
  if (!userId || flushing.has(userId)) return 0;

  const queue = readQueueItems(userId);
  const mine = queue.filter((item) => item.user_id === userId);
  if (mine.length === 0) return 0;

  flushing.add(userId);
  const remaining = queue.filter((item) => item.user_id !== userId);
  let saved = 0;

  try {
    for (const item of mine) {
      try {
        await saveRecordedActivity({
          userId: item.user_id,
          title: item.title,
          activityType: item.activity_type,
          distanceMeters: item.distance_meters,
          elevationGain: item.elevation_gain,
          durationSeconds: item.duration_seconds,
          coordinates: item.coordinates,
          weather: item.weather,
          rpe: item.rpe,
        });
        saved += 1;
      } catch {
        remaining.push(item);
      }
    }
  } finally {
    writeOfflineQueue(userId, remaining);
    flushing.delete(userId);
  }

  return saved;
}
