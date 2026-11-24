'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getProfile, type ActivityType } from '@/lib/valhalla';
import {
  buildElevationProfile,
  elevationGainOf,
  estimateSportMetrics,
  haversineMeters,
  planRoute,
  type ElevationSample,
  type PlannedRouteResult,
  type RoutingMode,
  type SportEstimate,
} from '@/lib/routePlannerEngine';
import { buildGpx, gpxFileName, parseGpx } from '@/lib/gpx';
import { exportGpxFile } from '@/lib/exportGpx';
import { isSupabaseConfigured, savePlannedRoute } from '@/lib/supabase';
import type { LngLat, LngLatEle } from '@/lib/polyline';
import type { MapViewHandle } from '@/components/MapView';

export type RouteMetrics = {
  distanceMeters: number;
  elevationGainMeters: number;
  durationSeconds: number;
  estimate: SportEstimate;
  elevationProfile: ElevationSample[];
};

type ImportedRoute = {
  coordinates: LngLatEle[];
  name: string | null;
};

function geometryLength(coordinates: LngLatEle[]): number {
  let meters = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    meters += haversineMeters(coordinates[i - 1], coordinates[i]);
  }
  return meters;
}

export function useRouteBuilder(mapRef: React.RefObject<MapViewHandle | null>) {
  const { user } = useAuth();
  const [waypoints, setWaypoints] = useState<LngLat[]>([]);
  const [activityType, setActivityType] = useState<ActivityType>('cycling');
  const [routingMode, setRoutingMode] = useState<RoutingMode>('snap');
  const [routed, setRouted] = useState<PlannedRouteResult | null>(null);
  const [imported, setImported] = useState<ImportedRoute | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const requestId = useRef(0);

  const coordinates = imported?.coordinates ?? routed?.coordinates ?? null;

  useEffect(() => {
    if (imported) return;

    if (waypoints.length < 2) {
      setRouted(null);
      setLoading(false);
      return;
    }

    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    planRoute(waypoints, activityType, routingMode)
      .then((result) => {
        if (id !== requestId.current) return;
        setRouted(result);
        if (result.provider === 'straight' && routingMode === 'snap') {
          setInfo('Jalur tidak ditemukan, rute disambung garis lurus.');
        } else if (result.provider === 'osrm') {
          setInfo('Rute dihitung lewat server cadangan (OSRM).');
        }
      })
      .catch((cause: unknown) => {
        if (id !== requestId.current) return;
        setRouted(null);
        setError(cause instanceof Error ? cause.message : 'Rute gagal dihitung.');
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [waypoints, activityType, routingMode, imported]);

  const metrics = useMemo<RouteMetrics | null>(() => {
    if (!coordinates || coordinates.length < 2) return null;

    const distanceMeters = imported
      ? geometryLength(coordinates)
      : (routed?.distanceMeters ?? geometryLength(coordinates));
    // Imported GPX keeps its own elevations; planned routes carry sampled DEM.
    const elevationGainMeters = imported
      ? elevationGainOf(coordinates)
      : (routed?.elevationGainMeters ?? elevationGainOf(coordinates));

    const estimate = estimateSportMetrics(activityType, distanceMeters, elevationGainMeters);
    const elevationProfile = imported
      ? buildElevationProfile(coordinates)
      : (routed?.elevationProfile ?? buildElevationProfile(coordinates));

    return {
      distanceMeters,
      elevationGainMeters,
      durationSeconds: estimate.durationSeconds,
      estimate,
      elevationProfile,
    };
  }, [coordinates, imported, activityType, routed]);

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
    setError(null);
    setInfo(null);
    setWaypoints([]);
  }, []);

  const changeActivityType = useCallback((next: ActivityType) => {
    setActivityType(next);
    setInfo(null);
  }, []);

  const changeRoutingMode = useCallback((next: RoutingMode) => {
    setRoutingMode(next);
    setInfo(
      next === 'offtrail'
        ? 'Mode Off-Trail aktif: titik disambung garis lurus.'
        : 'Mode Ikuti Jalur aktif: rute menempel jalan dan setapak.',
    );
  }, []);

  const importGpx = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const parsed = parseGpx(await file.text());
        setWaypoints([]);
        setRouted(null);
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
        await exportGpxFile(
          gpxFileName(title),
          buildGpx(title, coordinates, {
            sportType: activityType,
            distanceMeters: metrics?.distanceMeters,
            elevationGainMeters: metrics?.elevationGainMeters,
            durationSeconds: metrics?.durationSeconds,
          }),
        );
        setInfo('File GPX siap dibagikan.');
      } catch {
        setError('Gagal mengekspor GPX. Coba lagi.');
      }
    },
    [coordinates, activityType, metrics],
  );

  const saveRoute = useCallback(
    async (title: string) => {
      if (!coordinates || !metrics) {
        throw new Error('Belum ada rute untuk disimpan.');
      }
      if (!isSupabaseConfigured) {
        throw new Error(
          'Server ALLMOVA belum dikonfigurasi. Hubungi admin aplikasi.',
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
        routingMode,
        elevationProfile: metrics.elevationProfile,
      });
      setInfo(`Rute "${title}" tersimpan di Cloud ALLMOVA.`);
    },
    [coordinates, metrics, activityType, routingMode, user],
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
    routingMode,
    provider: routed?.provider ?? (imported ? 'import' : null),
    isImported: Boolean(imported),
    loading,
    error,
    info,
    suggestedTitle,
    addWaypoint,
    undo,
    clear,
    changeActivityType,
    changeRoutingMode,
    importGpx,
    exportGpx,
    saveRoute,
    dismissError: useCallback(() => setError(null), []),
    dismissInfo: useCallback(() => setInfo(null), []),
  };
}

export type RouteBuilderState = ReturnType<typeof useRouteBuilder>;
