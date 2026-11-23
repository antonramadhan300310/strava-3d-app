'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { length as turfLength } from '@turf/turf';
import { useAuth } from '@/context/AuthContext';
import { calculateElevationGain, fetchRoute, getProfile, type ActivityType } from '@/lib/valhalla';
import { buildGpx, gpxFileName, parseGpx } from '@/lib/gpx';
import { exportGpxFile } from '@/lib/exportGpx';
import { isSupabaseConfigured, savePlannedRoute } from '@/lib/supabase';
import type { LngLat, LngLatEle } from '@/lib/polyline';
import type { MapViewHandle } from '@/components/MapView';

/** Rough speeds for imported GPX files, which carry no Valhalla timing. */
const FALLBACK_SPEED_KMH: Record<ActivityType, number> = {
  cycling: 16,
  run: 9,
  walking: 5,
  hike: 4,
};

export type RouteMetrics = {
  distanceMeters: number;
  elevationGainMeters: number;
  durationSeconds: number;
};

type ImportedRoute = {
  coordinates: LngLatEle[];
  name: string | null;
};

export function useRouteBuilder(mapRef: React.RefObject<MapViewHandle | null>) {
  const { user } = useAuth();
  const [waypoints, setWaypoints] = useState<LngLat[]>([]);
  const [activityType, setActivityType] = useState<ActivityType>('cycling');
  const [routed, setRouted] = useState<LngLatEle[] | null>(null);
  const [routedDuration, setRoutedDuration] = useState(0);
  const [imported, setImported] = useState<ImportedRoute | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const requestId = useRef(0);

  const coordinates = imported?.coordinates ?? routed;

  useEffect(() => {
    if (imported) return;

    if (waypoints.length < 2) {
      setRouted(null);
      setRoutedDuration(0);
      setLoading(false);
      return;
    }

    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    fetchRoute(waypoints, activityType)
      .then((result) => {
        if (id !== requestId.current) return;
        setRouted(result.coordinates);
        setRoutedDuration(result.durationSeconds);
      })
      .catch((cause: unknown) => {
        if (id !== requestId.current) return;
        setRouted(null);
        setRoutedDuration(0);
        setError(cause instanceof Error ? cause.message : 'Rute gagal dihitung.');
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [waypoints, activityType, imported]);

  const metrics = useMemo<RouteMetrics | null>(() => {
    if (!coordinates || coordinates.length < 2) return null;

    const line = {
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates },
    };
    const distanceMeters = turfLength(line, { units: 'meters' });

    const durationSeconds = imported
      ? Math.round((distanceMeters / 1000 / FALLBACK_SPEED_KMH[activityType]) * 3600)
      : routedDuration;

    return {
      distanceMeters,
      elevationGainMeters: calculateElevationGain(coordinates),
      durationSeconds,
    };
  }, [coordinates, imported, activityType, routedDuration]);

  const addWaypoint = useCallback((lngLat: LngLat) => {
    setImported(null);
    setInfo(null);
    setWaypoints((current) => [...current, lngLat]);
  }, []);

  const undo = useCallback(() => {
    setImported(null);
    setError(null);
    setWaypoints((current) => current.slice(0, -1));
  }, []);

  const clear = useCallback(() => {
    setImported(null);
    setRouted(null);
    setRoutedDuration(0);
    setError(null);
    setInfo(null);
    setWaypoints([]);
  }, []);

  const changeActivityType = useCallback((next: ActivityType) => {
    setActivityType(next);
    setInfo(null);
  }, []);

  const importGpx = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const parsed = parseGpx(await file.text());
        setWaypoints([]);
        setRouted(null);
        setRoutedDuration(0);
        setImported({ coordinates: parsed.coordinates, name: parsed.name });
        setInfo(`GPX diimpor: ${parsed.name ?? file.name} (${parsed.coordinates.length} titik).`);
        mapRef.current?.fitCoordinates(parsed.coordinates);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'GPX gagal dibaca.');
      }
    },
    [mapRef],
  );

  const exportGpx = useCallback(
    async (title: string) => {
      if (!coordinates) {
        setError('Belum ada rute untuk diekspor.');
        return;
      }
      setError(null);
      try {
        await exportGpxFile(gpxFileName(title), buildGpx(title, coordinates));
        setInfo('File GPX siap dibagikan.');
      } catch {
        setError('Gagal mengekspor GPX. Coba lagi.');
      }
    },
    [coordinates],
  );

  const saveRoute = useCallback(
    async (title: string) => {
      if (!coordinates || !metrics) {
        throw new Error('Belum ada rute untuk disimpan.');
      }
      if (!isSupabaseConfigured) {
        throw new Error(
          'Supabase belum dikonfigurasi. Isi NEXT_PUBLIC_SUPABASE_URL dan NEXT_PUBLIC_SUPABASE_ANON_KEY.',
        );
      }
      if (!user) throw new Error('Sesi login tidak ditemukan. Silakan masuk kembali.');

      await savePlannedRoute({
        userId: user.id,
        title,
        activityType,
        distanceMeters: Math.round(metrics.distanceMeters),
        elevationGain: metrics.elevationGainMeters,
        durationSeconds: metrics.durationSeconds,
        coordinates,
      });
      setInfo(`Rute "${title}" tersimpan.`);
    },
    [coordinates, metrics, activityType, user],
  );

  const suggestedTitle = useMemo(() => {
    if (imported?.name) return imported.name;
    const profile = getProfile(activityType);
    const stamp = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
    return `${profile.label} ${stamp}`;
  }, [imported, activityType]);

  return {
    waypoints,
    coordinates,
    metrics,
    activityType,
    loading,
    error,
    info,
    suggestedTitle,
    addWaypoint,
    undo,
    clear,
    changeActivityType,
    importGpx,
    exportGpx,
    saveRoute,
    dismissError: useCallback(() => setError(null), []),
    dismissInfo: useCallback(() => setInfo(null), []),
  };
}

export type RouteBuilderState = ReturnType<typeof useRouteBuilder>;
