'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { deleteActivity, fetchActivities, isSupabaseConfigured } from '@/lib/supabase';
import { invalidateHeatmapCache } from '@/lib/heatmapCache';
import type { ActivityRecord } from '@/lib/activity';

export type ActivityFilter = 'all' | 'recorded' | 'planned';

export const ACTIVITY_FILTERS: { key: ActivityFilter; label: string }[] = [
  { key: 'all', label: 'Semua' },
  { key: 'recorded', label: 'Rekaman' },
  { key: 'planned', label: 'Rute Rencana' },
];

function matchesFilter(activity: ActivityRecord, filter: ActivityFilter): boolean {
  if (filter === 'recorded') return !activity.isPlannedRoute;
  if (filter === 'planned') return activity.isPlannedRoute;
  return true;
}

export function useActivities() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  /** Items are tagged with their owner so a switch can never render stale rows. */
  const [store, setStore] = useState<{ userId: string | null; items: ActivityRecord[] }>({
    userId,
    items: [],
  });
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | number | null>(null);

  const activities = store.userId === userId ? store.items : [];

  const setActivities = useCallback(
    (next: ActivityRecord[] | ((current: ActivityRecord[]) => ActivityRecord[])) => {
      setStore((previous) => {
        const current = previous.userId === userId ? previous.items : [];
        const items = typeof next === 'function' ? next(current) : next;
        return { userId, items };
      });
    },
    [userId],
  );

  const refresh = useCallback(async () => {
    if (!userId) {
      setStore({ userId: null, items: [] });
      return;
    }
    if (!isSupabaseConfigured) {
      setError(
        'Server ALLMOVA belum dikonfigurasi. Hubungi admin aplikasi.',
      );
      setStore({ userId, items: [] });
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setStore({ userId, items: await fetchActivities(userId) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Gagal memuat daftar aktivitas.');
      setStore({ userId, items: [] });
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // A new account starts from an empty list before its first fetch resolves.
  useEffect(() => {
    setActivities([]);
    setError(null);
    void refresh();
  }, [refresh, setActivities]);

  const remove = useCallback(async (id: string | number) => {
    if (!userId) return;
    setDeletingId(id);
    setError(null);
    try {
      await deleteActivity(id, userId);
      invalidateHeatmapCache(userId);
      setActivities((current) => current.filter((activity) => activity.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Gagal menghapus aktivitas.');
    } finally {
      setDeletingId(null);
    }
  }, [setActivities, userId]);

  /** Swaps one row in place after it was rewritten (e.g. snapped to roads). */
  const replace = useCallback((updated: ActivityRecord) => {
    setActivities((current) =>
      current.map((activity) => (activity.id === updated.id ? updated : activity)),
    );
  }, [setActivities]);

  const visible = useMemo(
    () => activities.filter((activity) => matchesFilter(activity, filter)),
    [activities, filter],
  );

  const counts = useMemo(
    () => ({
      all: activities.length,
      recorded: activities.filter((activity) => !activity.isPlannedRoute).length,
      planned: activities.filter((activity) => activity.isPlannedRoute).length,
    }),
    [activities],
  );

  return {
    activities,
    visible,
    counts,
    filter,
    loading,
    error,
    deletingId,
    setFilter,
    refresh,
    remove,
    replace,
    dismissError: useCallback(() => setError(null), []),
  };
}

export type ActivitiesState = ReturnType<typeof useActivities>;
