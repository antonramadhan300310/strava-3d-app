'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BottomNav, { type TabKey } from '@/components/BottomNav';
import MapView, { type MapViewHandle } from '@/components/MapView';
import RecordOverlay from '@/components/RecordOverlay';
import RouteBuilderOverlay from '@/components/RouteBuilderOverlay';
import ActivitiesPanel from '@/components/ActivitiesPanel';
import ActivityDetail from '@/components/ActivityDetail';
import MapProviderModal from '@/components/MapProviderModal';
import { useActivityRecorder } from '@/hooks/useActivityRecorder';
import { useActivities } from '@/hooks/useActivities';
import { useHeatmap } from '@/hooks/useHeatmap';
import { useRouteBuilder } from '@/hooks/useRouteBuilder';
import type { ActivityRecord } from '@/lib/activity';
import { readMapProvider, writeMapProvider, type MapProvider } from '@/lib/mapProvider';

const NOTICE_MS = 3000;

export default function AppShell() {
  const [tab, setTab] = useState<TabKey>('routes');
  const [openActivity, setOpenActivity] = useState<ActivityRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [provider, setProvider] = useState<MapProvider | null>(null);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [providerChecked, setProviderChecked] = useState(false);
  const [heatmapFocusToken, setHeatmapFocusToken] = useState(0);
  const consumedFocusRef = useRef(0);
  const mapRef = useRef<MapViewHandle | null>(null);
  const builder = useRouteBuilder(mapRef);
  const recorder = useActivityRecorder();
  const activities = useActivities();
  const heatmap = useHeatmap(activities.activities);
  const isRoutes = tab === 'routes';
  const isRecord = tab === 'record';
  const isActivities = tab === 'activities';

  // A stored choice means the app goes straight in; otherwise the full-screen
  // picker is shown before the map is ever created.
  useEffect(() => {
    const saved = readMapProvider();
    setProvider(saved);
    setProviderModalOpen(saved === null);
    setProviderChecked(true);
  }, []);

  const selectProvider = useCallback((next: MapProvider) => {
    writeMapProvider(next);
    setProvider(next);
    setProviderModalOpen(false);
  }, []);

  // Recording keeps the camera locked on the blue dot; pausing releases it.
  const followEnabled = isRecord && recorder.isRecording;
  // A running session stays visible even while the user browses other tabs.
  const liveGps = isRecord || recorder.phase !== 'idle';

  const refreshActivities = activities.refresh;
  // Opening the feed or saving a route both change what should be listed.
  const savedRouteSignal = builder.info;
  useEffect(() => {
    if (!isActivities) return;
    void refreshActivities();
  }, [isActivities, savedRouteSignal, refreshActivities]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // Saving a recording returns the recorder to idle; the new row must then show
  // up in the feed (and in the heatmap cache) without reopening the tab.
  const previousPhaseRef = useRef(recorder.phase);
  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = recorder.phase;
    if (previous !== 'idle' && recorder.phase === 'idle') void refreshActivities();
  }, [recorder.phase, refreshActivities]);

  const heatmapLayers = useMemo(
    () => ({
      visible: isRoutes && heatmap.enabled,
      scheme: heatmap.scheme,
      lines: heatmap.linesGeoJSON,
    }),
    [isRoutes, heatmap.enabled, heatmap.scheme, heatmap.linesGeoJSON],
  );

  const focusHeatmap = useCallback(() => {
    setHeatmapFocusToken((token) => token + 1);
  }, []);

  const openHeatmapFromActivities = useCallback(() => {
    setTab('routes');
    heatmap.enable();
    setHeatmapFocusToken((token) => token + 1);
  }, [heatmap.enable]);

  // Frames the filtered extent once the data for a focus request is available.
  useEffect(() => {
    if (heatmapFocusToken === consumedFocusRef.current) return;
    if (tab !== 'routes' || !heatmap.bounds) return;
    consumedFocusRef.current = heatmapFocusToken;

    const bounds = heatmap.bounds;
    const timer = setTimeout(() => {
      mapRef.current?.fitCoordinates([
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ]);
    }, 280);
    return () => clearTimeout(timer);
  }, [heatmapFocusToken, heatmap.bounds, tab]);

  const closeActivity = useCallback(() => {
    setOpenActivity(null);
    void refreshActivities();
  }, [refreshActivities]);

  // "Rapikan ke Jalan" rewrites the row, so the open record must follow it.
  const replaceActivityInList = activities.replace;
  const replaceActivity = useCallback(
    (updated: ActivityRecord) => {
      setOpenActivity(updated);
      replaceActivityInList(updated);
    },
    [replaceActivityInList],
  );

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-slate-950">
      {provider && (
        <MapView
          ref={mapRef}
          provider={provider}
          onProviderBadgeClick={() => setProviderModalOpen(true)}
          active={!isActivities}
          waypoints={isRoutes ? builder.waypoints : []}
          route={isRoutes ? builder.coordinates : null}
          onMapClick={isRoutes ? builder.addWaypoint : undefined}
          livePosition={liveGps ? recorder.livePosition : null}
          liveTrack={liveGps ? recorder.track : null}
          gpsAccuracy={liveGps ? recorder.gpsAccuracy : null}
          followEnabled={followEnabled}
          showGpsStatus={liveGps}
          activityType={recorder.activityType}
          heatmap={heatmapLayers}
        />
      )}

      {isRoutes && (
        <RouteBuilderOverlay
          builder={builder}
          mapRef={mapRef}
          heatmap={heatmap}
          onFocusHeatmap={focusHeatmap}
        />
      )}
      {isRecord && <RecordOverlay recorder={recorder} />}

      {isActivities && !openActivity && (
        <ActivitiesPanel
          activities={activities}
          onOpen={setOpenActivity}
          onNotice={setNotice}
          onOpenHeatmap={openHeatmapFromActivities}
        />
      )}

      {openActivity && provider && (
        <ActivityDetail
          activity={openActivity}
          allActivities={activities.activities}
          provider={provider}
          onClose={closeActivity}
          onNotice={setNotice}
          onTrackUpdated={replaceActivity}
        />
      )}

      {notice && (
        <p
          className="pointer-events-none absolute inset-x-3 top-[calc(env(safe-area-inset-top)+1rem)] z-[60] mx-auto max-w-md rounded-xl bg-slate-900/95 px-3 py-2 text-center text-xs font-medium text-slate-100 shadow-lg backdrop-blur"
          role="status"
        >
          {notice}
        </p>
      )}

      {!openActivity && <BottomNav active={tab} onChange={setTab} />}

      {providerChecked && providerModalOpen && (
        <MapProviderModal
          current={provider}
          onSelect={selectProvider}
          onClose={provider ? () => setProviderModalOpen(false) : undefined}
        />
      )}
    </main>
  );
}
