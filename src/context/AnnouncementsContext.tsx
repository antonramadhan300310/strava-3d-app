'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  countUnseen,
  fetchAnnouncements,
  newestAnnouncementAt,
  readLastSeenAnnouncementAt,
  writeLastSeenAnnouncementAt,
  type Announcement,
} from '@/lib/announcements';

type AnnouncementsContextValue = {
  announcements: Announcement[];
  loading: boolean;
  error: string | null;
  /** Announcements published after the sheet was last opened. */
  unreadCount: number;
  /** Refetches the list; resolves with whatever the server returned. */
  refresh: () => Promise<Announcement[]>;
  /** Marks the newest listed announcement as read, clearing the badge. */
  markAllSeen: (list?: Announcement[]) => void;
};

const AnnouncementsContext = createContext<AnnouncementsContextValue | null>(null);

/**
 * Admin broadcasts from `public.announcements`, shared by every bell in the
 * app so the badge on the map and in the Activities header cannot disagree.
 *
 * The list is fetched when the account becomes available (app open) and again
 * every time a sheet is opened, so a message published while the app stayed
 * open still shows up.
 */
export function AnnouncementsProvider({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const userId = user?.id ?? null;
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);

  useEffect(() => {
    setLastSeenAt(readLastSeenAnnouncementAt(userId));
  }, [userId]);

  const refresh = useCallback(async (): Promise<Announcement[]> => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchAnnouncements();
      setAnnouncements(list);
      return list;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Gagal memuat notifikasi. Periksa koneksi internetmu lalu coba lagi.',
      );
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') {
      setLoading(false);
      return;
    }
    void refresh();
  }, [status, refresh]);

  const unreadCount = useMemo(
    () => countUnseen(announcements, lastSeenAt),
    [announcements, lastSeenAt],
  );

  const markAllSeen = useCallback(
    (list?: Announcement[]) => {
      const newest = newestAnnouncementAt(list ?? announcements);
      if (newest === null) return;
      writeLastSeenAnnouncementAt(userId, newest);
      setLastSeenAt(newest);
    },
    [announcements, userId],
  );

  const value = useMemo<AnnouncementsContextValue>(
    () => ({ announcements, loading, error, unreadCount, refresh, markAllSeen }),
    [announcements, loading, error, unreadCount, refresh, markAllSeen],
  );

  return <AnnouncementsContext.Provider value={value}>{children}</AnnouncementsContext.Provider>;
}

export function useAnnouncements(): AnnouncementsContextValue {
  const context = useContext(AnnouncementsContext);
  if (!context) {
    throw new Error('useAnnouncements harus dipakai di dalam AnnouncementsProvider.');
  }
  return context;
}
