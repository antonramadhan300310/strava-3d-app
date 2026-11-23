'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityRecord } from '@/lib/activity';
import {
  buildHeatmapGeoJSON,
  getCachedHeatmapActivities,
  type HeatmapActivity,
  type HeatmapScheme,
  type HeatmapTimeFilter,
  type HeatmapTypeFilter,
} from '@/lib/heatmapCache';
import { getSupabaseClientOrNull } from '@/lib/supabase';

/**
 * Heatmap state shared by the Routes control and the Activities shortcut.
 *
 * History is read through `getCachedHeatmapActivities`, so toggling the mode or
 * changing filters only re-derives GeoJSON in memory and never queries Supabase.
 */
export function useHeatmap(existingActivities: ActivityRecord[]) {
  const [enabled, setEnabled] = useState(false);
  const [activityType, setActivityType] = useState<HeatmapTypeFilter>('all');
  const [timeRange, setTimeRange] = useState<HeatmapTimeFilter>('all');
  const [scheme, setScheme] = useState<HeatmapScheme>('fire');
  const [items, setItems] = useState<HeatmapActivity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existingRef = useRef(existingActivities);
  existingRef.current = existingActivities;
  // Refreshing the feed keeps the same length when a row is edited, so the
  // count is used only as a cheap "history changed" signal.
  const existingCount = existingActivities.length;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const source = existingRef.current.length > 0 ? existingRef.current : undefined;
      setItems(await getCachedHeatmapActivities(getSupabaseClientOrNull(), source));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Gagal memuat heatmap.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, existingCount, load]);

  const geo = useMemo(
    () => buildHeatmapGeoJSON(items, { activityType, timeRange }),
    [items, activityType, timeRange],
  );

  const enable = useCallback(() => setEnabled(true), []);
  const disable = useCallback(() => setEnabled(false), []);
  const toggle = useCallback(() => setEnabled((current) => !current), []);

  return {
    enabled,
    enable,
    disable,
    toggle,
    activityType,
    timeRange,
    scheme,
    setActivityType,
    setTimeRange,
    setScheme,
    loading,
    error,
    count: geo.count,
    bounds: geo.bounds,
    linesGeoJSON: geo.linesGeoJSON,
  };
}

export type HeatmapState = ReturnType<typeof useHeatmap>;
