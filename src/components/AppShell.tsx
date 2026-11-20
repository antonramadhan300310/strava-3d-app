'use client';

import { useRef, useState } from 'react';
import BottomNav, { type TabKey } from '@/components/BottomNav';
import MapView, { type MapViewHandle } from '@/components/MapView';
import RecordOverlay from '@/components/RecordOverlay';
import RouteBuilderOverlay from '@/components/RouteBuilderOverlay';
import { useActivityRecorder } from '@/hooks/useActivityRecorder';
import { useRouteBuilder } from '@/hooks/useRouteBuilder';

const PLACEHOLDER = 'Segera hadir di Milestone berikutnya';

export default function AppShell() {
  const [tab, setTab] = useState<TabKey>('routes');
  const mapRef = useRef<MapViewHandle | null>(null);
  const builder = useRouteBuilder(mapRef);
  const recorder = useActivityRecorder();
  const isRoutes = tab === 'routes';
  const isRecord = tab === 'record';

  // Recording keeps the camera locked on the blue dot; pausing releases it.
  const followEnabled = isRecord && recorder.isRecording;
  // A running session stays visible even while the user browses other tabs.
  const liveGps = isRecord || recorder.phase !== 'idle';

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-slate-950">
      <MapView
        ref={mapRef}
        active={tab !== 'activities'}
        waypoints={isRoutes ? builder.waypoints : []}
        route={isRoutes ? builder.coordinates : null}
        onMapClick={isRoutes ? builder.addWaypoint : undefined}
        livePosition={liveGps ? recorder.livePosition : null}
        liveTrack={liveGps ? recorder.track : null}
        gpsAccuracy={liveGps ? recorder.gpsAccuracy : null}
        followEnabled={followEnabled}
        showGpsStatus={liveGps}
      />

      {isRoutes && <RouteBuilderOverlay builder={builder} />}
      {isRecord && <RecordOverlay recorder={recorder} />}

      {tab === 'activities' && (
        <section className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-950 px-8 pb-20 text-center">
          <h1 className="text-xl font-semibold text-slate-100">Activities</h1>
          <p className="max-w-xs text-sm text-slate-400">{PLACEHOLDER}</p>
        </section>
      )}

      <BottomNav active={tab} onChange={setTab} />
    </main>
  );
}
