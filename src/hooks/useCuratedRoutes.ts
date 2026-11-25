'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  matchesCuratedQuery,
  matchesSportFilter,
  type CuratedRoute,
  type CuratedSportFilter,
} from '@/lib/curatedRoutes';
import { fetchCuratedRoutes } from '@/lib/supabase';

/**
 * Active curated recommendations plus the sport chip and search filters.
 * `enabled` keeps the query idle until the Routes tab is actually opened.
 */
export function useCuratedRoutes(enabled = true) {
  const [routes, setRoutes] = useState<CuratedRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sport, setSport] = useState<CuratedSportFilter>('all');
  const [query, setQuery] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRoutes(await fetchCuratedRoutes());
    } catch (cause) {
      setRoutes([]);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Gagal memuat rekomendasi rute. Periksa koneksi internetmu lalu coba lagi.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  const filtered = useMemo(
    () =>
      routes.filter(
        (route) =>
          matchesSportFilter(route, sport) && matchesCuratedQuery(route, query),
      ),
    [routes, sport, query],
  );

  const counts = useMemo(() => {
    const bySport: Record<CuratedSportFilter, number> = {
      all: routes.length,
      cycling: 0,
      run: 0,
      walking: 0,
      hike: 0,
    };
    for (const route of routes) bySport[route.sportType] += 1;
    return bySport;
  }, [routes]);

  return {
    routes,
    filtered,
    counts,
    sport,
    setSport,
    query,
    setQuery,
    loading,
    error,
    refresh,
    dismissError: useCallback(() => setError(null), []),
  };
}

export type CuratedRoutesState = ReturnType<typeof useCuratedRoutes>;
