import { getSupabaseClientOrNull } from './supabase';
import { parseTimestamp } from './subscription';
import { readUserStorage, writeUserStorage, USER_STORAGE_KEYS } from './userStorage';

/**
 * Announcements are written by the admin panel (`allmova-landing`) and read
 * here. `select('*')` plus flexible column names keep the app working when the
 * editorial panel uses `message` instead of `body`, or `published_at` instead
 * of `created_at`.
 */
export type AnnouncementKind = 'info' | 'warning' | 'success' | 'promo';

export type Announcement = {
  id: string;
  title: string;
  body: string;
  /** Epoch milliseconds of publication, or null when the row has no date. */
  createdAtMs: number | null;
  kind: AnnouncementKind;
};

export type AnnouncementRow = Record<string, unknown>;

/** The bell only shows the newest handful; the panel keeps the rest. */
export const ANNOUNCEMENT_LIMIT = 20;

const KINDS: AnnouncementKind[] = ['info', 'warning', 'success', 'promo'];

function readText(row: AnnouncementRow, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

function readDate(row: AnnouncementRow, keys: string[]): number | null {
  for (const key of keys) {
    const parsed = parseTimestamp(row[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function readKind(row: AnnouncementRow): AnnouncementKind {
  const raw = readText(row, ['kind', 'level', 'severity', 'type']).toLowerCase();
  return (KINDS as string[]).includes(raw) ? (raw as AnnouncementKind) : 'info';
}

/** Returns null for rows that are inactive or carry no readable text. */
export function toAnnouncement(row: AnnouncementRow, index = 0): Announcement | null {
  if (!row || typeof row !== 'object') return null;
  if (row.is_active === false) return null;

  const title = readText(row, ['title', 'heading', 'name', 'subject']);
  const body = readText(row, ['body', 'message', 'content', 'description', 'text']);
  if (!title && !body) return null;

  const id =
    typeof row.id === 'string' || typeof row.id === 'number'
      ? String(row.id)
      : `announcement-${index}`;

  return {
    id,
    title: title || body.slice(0, 80),
    body,
    createdAtMs: readDate(row, ['created_at', 'published_at', 'starts_at', 'inserted_at']),
    kind: readKind(row),
  };
}

/** Newest first, so the badge and the list agree on what "latest" means. */
export function toAnnouncements(rows: unknown, limit = ANNOUNCEMENT_LIMIT): Announcement[] {
  if (!Array.isArray(rows)) return [];

  return (rows as AnnouncementRow[])
    .map((row, index) => toAnnouncement(row, index))
    .filter((entry): entry is Announcement => entry !== null)
    .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
    .slice(0, limit);
}

export async function fetchAnnouncements(): Promise<Announcement[]> {
  const supabase = getSupabaseClientOrNull();
  if (!supabase) return [];

  let data: unknown = null;
  let error: { message: string; code?: string } | null = null;
  try {
    const response = await supabase
      .from('announcements')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(ANNOUNCEMENT_LIMIT);
    data = response.data;
    error = response.error;
  } catch {
    throw new Error('Gagal memuat notifikasi. Periksa koneksi internetmu lalu coba lagi.');
  }

  // A project that has not run the migration yet has no announcements at all;
  // that is an empty inbox, not an error the user can act on.
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return [];
    throw new Error('Gagal memuat notifikasi. Periksa koneksi internetmu lalu coba lagi.');
  }

  return toAnnouncements(data);
}

/** How many announcements are newer than the last time the sheet was opened. */
export function countUnseen(announcements: Announcement[], lastSeenAt: number | null): number {
  if (lastSeenAt === null) return announcements.length;
  return announcements.filter(
    (entry) => entry.createdAtMs !== null && entry.createdAtMs > lastSeenAt,
  ).length;
}

export function newestAnnouncementAt(announcements: Announcement[]): number | null {
  let newest: number | null = null;
  for (const entry of announcements) {
    if (entry.createdAtMs === null) continue;
    if (newest === null || entry.createdAtMs > newest) newest = entry.createdAtMs;
  }
  return newest;
}

export function readLastSeenAnnouncementAt(userId: string | null): number | null {
  const raw = readUserStorage(USER_STORAGE_KEYS.lastSeenAnnouncement, userId);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function writeLastSeenAnnouncementAt(userId: string | null, epochMs: number): void {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return;
  writeUserStorage(USER_STORAGE_KEYS.lastSeenAnnouncement, userId, String(Math.round(epochMs)));
}

/** Short Indonesian relative time for the notification list. */
export function formatAnnouncementTime(epochMs: number | null, now = Date.now()): string {
  if (epochMs === null || !Number.isFinite(epochMs)) return '';
  const diffMs = now - epochMs;
  if (diffMs < 60_000) return 'Baru saja';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} menit lalu`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  if (hours < 48) return 'Kemarin';

  return new Date(epochMs).toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
