'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import type { ActivityRecord } from '@/lib/activity';
import {
  buildHeatmapGeoJSON,
  getCachedHeatmapActivities,
  type HeatmapActivity,
  type HeatmapTimeFilter,
  type HeatmapTypeFilter,
} from '@/lib/heatmapCache';
import { getSupabaseClientOrNull } from '@/lib/supabase';

/**
 * Heatmap state shared by the Routes control and the Activities shortcut.
 *
 * History is read through `getCachedHeatmapActivities`, so toggling the mode or
 * changing filters only re-derives GeoJSON in memory and never queries Supabase.
 * Every read is keyed by the signed-in account, and a user change wipes the
 * in-memory tracks before the new account can render anything.
 */
export function useHeatmap(existingActivities: ActivityRecord[], onEmptyHistory?: () => void) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  /** Items are tagged with their owner so a switch can never draw stale lines. */
  const [store, setStore] = useState<{ userId: string | null; items: HeatmapActivity[] }>({
    userId,
    items: [],
  });
  const [enabled, setEnabled] = useState(false);
  const [activityType, setActivityType] = useState<HeatmapTypeFilter>('all');
  const [timeRange, setTimeRange] = useState<HeatmapTimeFilter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = store.userId === userId ? store.items : [];

  const existingRef = useRef(existingActivities);
  existingRef.current = existingActivities;
  const onEmptyRef = useRef(onEmptyHistory);
  onEmptyRef.current = onEmptyHistory;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const ownerRef = useRef(userId);
  const emptyNotifiedRef = useRef(false);
  // Refreshing the feed keeps the same length when a row is edited, so the
  // count is used only as a cheap "history changed" signal.
  const existingCount = existingActivities.length;

  const load = useCallback(async () => {
    if (!userId) {
      setStore({ userId: null, items: [] });
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const source =
        existingRef.current.length > 0
          ? existingRef.current.filter((record) => !record.userId || record.userId === userId)
          : undefined;
      const next = await getCachedHeatmapActivities(getSupabaseClientOrNull(), userId, source);
      setStore({ userId, items: next });
      if (enabledRef.current && next.length === 0 && !emptyNotifiedRef.current) {
        emptyNotifiedRef.current = true;
        onEmptyRef.current?.();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Gagal memuat heatmap.');
      setStore({ userId, items: [] });
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Switching account clears the tracks immediately, before any fetch runs.
  useEffect(() => {
    if (ownerRef.current === userId) return;
    ownerRef.current = userId;
    setStore({ userId, items: [] });
    setEnabled(false);
    setError(null);
    setLoading(false);
    emptyNotifiedRef.current = false;
  }, [userId]);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, existingCount, load]);

  const geo = useMemo(
    () => buildHeatmapGeoJSON(items, { activityType, timeRange }, userId),
    [items, activityType, timeRange, userId],
  );

  const enable = useCallback(() => {
    emptyNotifiedRef.current = false;
    setEnabled(true);
  }, []);
  const disable = useCallback(() => setEnabled(false), []);
  const toggle = useCallback(() => {
    emptyNotifiedRef.current = false;
    setEnabled((current) => !current);
  }, []);

  return {
    enabled,
    enable,
    disable,
    toggle,
    activityType,
    timeRange,
    setActivityType,
    setTimeRange,
    loading,
    error,
    count: geo.count,
    bounds: geo.bounds,
    linesGeoJSON: geo.linesGeoJSON,
  };
}

export type HeatmapState = ReturnType<typeof useHeatmap>;
