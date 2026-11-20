'use client';

import { useRef, useState } from 'react';
import BottomNav, { type TabKey } from '@/components/BottomNav';
import MapView, { type MapViewHandle } from '@/components/MapView';
import RouteBuilderOverlay from '@/components/RouteBuilderOverlay';
import { useRouteBuilder } from '@/hooks/useRouteBuilder';

const PLACEHOLDER = 'Segera hadir di Milestone berikutnya';

export default function AppShell() {
  const [tab, setTab] = useState<TabKey>('routes');
  const mapRef = useRef<MapViewHandle | null>(null);
  const builder = useRouteBuilder(mapRef);
  const isRoutes = tab === 'routes';

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-slate-950">
      <MapView
        ref={mapRef}
        active={tab !== 'activities'}
        waypoints={isRoutes ? builder.waypoints : []}
        route={isRoutes ? builder.coordinates : null}
        onMapClick={isRoutes ? builder.addWaypoint : undefined}
      />

      {isRoutes && <RouteBuilderOverlay builder={builder} />}

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
