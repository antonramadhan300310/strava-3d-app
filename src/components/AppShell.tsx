'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import BottomNav, { type TabKey } from '@/components/BottomNav';
import MapView, { type MapViewHandle } from '@/components/MapView';
import RecordOverlay from '@/components/RecordOverlay';
import RouteBuilderOverlay from '@/components/RouteBuilderOverlay';
import ActivitiesPanel from '@/components/ActivitiesPanel';
import ActivityDetail from '@/components/ActivityDetail';
import MapProviderModal from '@/components/MapProviderModal';
import { useActivityRecorder } from '@/hooks/useActivityRecorder';
import { useActivities } from '@/hooks/useActivities';
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
  const mapRef = useRef<MapViewHandle | null>(null);
  const builder = useRouteBuilder(mapRef);
  const recorder = useActivityRecorder();
  const activities = useActivities();
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
        />
      )}

      {isRoutes && <RouteBuilderOverlay builder={builder} mapRef={mapRef} />}
      {isRecord && <RecordOverlay recorder={recorder} />}

      {isActivities && !openActivity && (
        <ActivitiesPanel activities={activities} onOpen={setOpenActivity} onNotice={setNotice} />
      )}

      {openActivity && provider && (
        <ActivityDetail
          activity={openActivity}
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
