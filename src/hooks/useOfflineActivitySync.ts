'use client';

import { useEffect } from 'react';
import { flushOfflineActivityQueue } from '@/lib/offlineActivityQueue';
import { invalidateHeatmapCache } from '@/lib/heatmapCache';

/**
 * Uploads offline recordings for the signed-in account on launch, reconnect and
 * foreground. Items owned by another account are never sent.
 */
export function useOfflineActivitySync(userId: string | null, onSynced: () => void): void {
  useEffect(() => {
    if (!userId) return;

    let alive = true;
    const flush = async () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const saved = await flushOfflineActivityQueue(userId);
      if (!alive || saved === 0) return;
      invalidateHeatmapCache(userId);
      onSynced();
    };

    void flush();

    const onForeground = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void flush();
    };

    window.addEventListener('online', onForeground);
    window.addEventListener('focus', onForeground);
    document.addEventListener('visibilitychange', onForeground);
    return () => {
      alive = false;
      window.removeEventListener('online', onForeground);
      window.removeEventListener('focus', onForeground);
      document.removeEventListener('visibilitychange', onForeground);
    };
  }, [userId, onSynced]);
}
