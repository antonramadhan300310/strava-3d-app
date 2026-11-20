'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteActivity, fetchActivities, isSupabaseConfigured } from '@/lib/supabase';
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
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | number | null>(null);

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setError(
        'Supabase belum dikonfigurasi. Isi NEXT_PUBLIC_SUPABASE_URL dan NEXT_PUBLIC_SUPABASE_ANON_KEY.',
      );
      setActivities([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setActivities(await fetchActivities());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Gagal memuat daftar aktivitas.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string | number) => {
    setDeletingId(id);
    setError(null);
    try {
      await deleteActivity(id);
      setActivities((current) => current.filter((activity) => activity.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Gagal menghapus aktivitas.');
    } finally {
      setDeletingId(null);
    }
  }, []);

  /** Swaps one row in place after it was rewritten (e.g. snapped to roads). */
  const replace = useCallback((updated: ActivityRecord) => {
    setActivities((current) =>
      current.map((activity) => (activity.id === updated.id ? updated : activity)),
    );
  }, []);

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
