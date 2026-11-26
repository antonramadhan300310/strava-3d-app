'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import AllmovaLogo from '@/components/AllmovaLogo';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { GuideRouteProvider, useGuideRoute } from '@/context/GuideRouteContext';
import AuthScreen from '@/components/AuthScreen';
import ProPaywallSheet from '@/components/ProPaywallSheet';
import BottomNav, { type TabKey } from '@/components/BottomNav';
import MapView, { type MapViewHandle } from '@/components/MapView';
import RecordOverlay from '@/components/RecordOverlay';
import RouteBuilderOverlay, { type RoutesSubTab } from '@/components/RouteBuilderOverlay';
import ActivitiesPanel from '@/components/ActivitiesPanel';
import ActivityDetail from '@/components/ActivityDetail';
import MapProviderModal from '@/components/MapProviderModal';
import OtaUpdateManager from '@/components/OtaUpdateManager';
import AccountGuardModals from '@/components/AccountGuardModals';
import { useActivityRecorder } from '@/hooks/useActivityRecorder';
import { useActivities } from '@/hooks/useActivities';
import { useHeatmap } from '@/hooks/useHeatmap';
import { useOfflineActivitySync } from '@/hooks/useOfflineActivitySync';
import { useRouteBuilder } from '@/hooks/useRouteBuilder';
import { useCuratedRoutes } from '@/hooks/useCuratedRoutes';
import type { ActivityRecord } from '@/lib/activity';
import {
  curatedRouteDurationSeconds,
  curatedRouteKey,
  toCuratedGuideRoute,
  type CuratedRoute,
} from '@/lib/curatedRoutes';
import { guideToLngLat, toGuideRoute } from '@/lib/guideRoute';
import { isValidRouteCoordinates } from '@/lib/routeCoordinates';
import { readMapProvider, writeMapProvider, type MapProvider } from '@/lib/mapProvider';
import { isNativeApp, notifyAppReady } from '@/lib/otaUpdater';
import { buildElevationProfile } from '@/lib/routePlannerEngine';
import { isSupabaseConfigured, savePlannedRoute } from '@/lib/supabase';

const NOTICE_MS = 3000;

// Runs while the bundle is parsed, before React renders: capgo rolls a freshly
// applied bundle back when the ready signal never arrives, so a crash in any
// screen below must not be able to swallow it.
if (typeof window !== 'undefined' && isNativeApp()) void notifyAppReady();

export default function AppShell() {
  return (
    <AuthProvider>
      <OtaUpdateManager />
      <AuthGate />
      <AccountGuardModals />
    </AuthProvider>
  );
}

function AuthGate() {
  const { status, user } = useAuth();

  if (status === 'loading') return <SplashScreen />;
  if (status !== 'authenticated' || !user) return <AuthScreen />;
  // Keying on the account id remounts every screen (and the MapLibre map) when
  // the session switches, so no in-memory track can survive into the new login.
  return (
    <GuideRouteProvider key={user.id}>
      <TrackerApp />
    </GuideRouteProvider>
  );
}

function SplashScreen() {
  return (
    <main className="flex h-dvh w-full flex-col items-center justify-center gap-3 bg-[#0D1112] text-slate-100">
      <AllmovaLogo variant="full" className="h-24 w-auto" />
      <Loader2 size={18} className="animate-spin text-[#B9F51E]" />
      <p className="text-[11px] text-slate-400">Memuat sesi…</p>
    </main>
  );
}

function TrackerApp() {
  const { isPro, user } = useAuth();
  const [tab, setTab] = useState<TabKey>(isPro ? 'routes' : 'record');
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [paywallReason, setPaywallReason] = useState<string | undefined>(undefined);
  const [openActivity, setOpenActivity] = useState<ActivityRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [provider, setProvider] = useState<MapProvider | null>(null);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [providerChecked, setProviderChecked] = useState(false);
  const [heatmapFocusToken, setHeatmapFocusToken] = useState(0);
  const [guideFitToken, setGuideFitToken] = useState(0);
  const [routesSubTab, setRoutesSubTab] = useState<RoutesSubTab>('mine');
  const consumedFocusRef = useRef(0);
  const mapRef = useRef<MapViewHandle | null>(null);
  const guide = useGuideRoute();
  const builder = useRouteBuilder(mapRef);
  const recorder = useActivityRecorder();
  const activities = useActivities();
  const heatmap = useHeatmap(activities.activities, () =>
    setNotice('Belum ada riwayat rute untuk ditampilkan di Heatmap.'),
  );
  useOfflineActivitySync(user?.id ?? null, activities.refresh);
  const isRoutes = tab === 'routes' && isPro;
  const isRecord = tab === 'record';
  // The curated feed only loads once the Pro-only Routes tab is opened.
  const curated = useCuratedRoutes(isRoutes);
  const isActivities = tab === 'activities';

  const savedRoutes = useMemo(
    () => activities.activities.filter((activity) => activity.isPlannedRoute),
    [activities.activities],
  );
  const guideLngLat = useMemo(
    () => (guide.activeGuideRoute ? guideToLngLat(guide.activeGuideRoute.coordinates) : null),
    [guide.activeGuideRoute],
  );

  const requirePro = useCallback((reason?: string) => {
    setPaywallReason(reason);
    setPaywallOpen(true);
  }, []);

  // A free account never lands on (or stays on) the Pro-only Routes tab.
  useEffect(() => {
    if (!isPro && tab === 'routes') setTab('record');
  }, [isPro, tab]);

  // Satellite tiles are part of Pro, so a downgraded account falls back.
  useEffect(() => {
    if (!provider || isPro || provider !== 'maptiler') return;
    writeMapProvider('opendata');
    setProvider('opendata');
  }, [provider, isPro]);

  const changeTab = useCallback(
    (next: TabKey) => {
      if (next === 'routes' && !isPro) {
        requirePro('Perencanaan Rute 3D, Import/Export GPX, dan Heatmap Personal khusus Pro.');
        return;
      }
      setTab(next);
    },
    [isPro, requirePro],
  );

  // A stored choice means the app goes straight in; otherwise the full-screen
  // picker is shown before the map is ever created.
  useEffect(() => {
    const saved = readMapProvider();
    setProvider(saved);
    setProviderModalOpen(saved === null);
    setProviderChecked(true);
  }, []);

  // Both entry points (Routes tab card and Record picker) land here: the route
  // becomes the guide and the Record tab takes over.
  const setGuideRoute = guide.setGuideRoute;
  const clearGuideRoute = guide.clearGuideRoute;
  const followRoute = useCallback(
    (activity: ActivityRecord) => {
      const route = toGuideRoute(activity);
      if (!route) {
        setNotice('Rute ini belum punya cukup titik untuk dipandu.');
        return;
      }
      setGuideRoute(route);
      setGuideFitToken((token) => token + 1);
      setOpenActivity(null);
      setTab('record');
    },
    [setGuideRoute],
  );

  // A curated route uses the same Follow Route engine as a saved route: it
  // becomes the guide and the Record tab takes over.
  const followCuratedRoute = useCallback(
    (route: CuratedRoute) => {
      if (!isValidRouteCoordinates(route.coordinates)) {
        setNotice('Koordinat rute tidak valid');
        return;
      }
      const guideRoute = toCuratedGuideRoute(route);
      if (!guideRoute) {
        setNotice('Rute rekomendasi ini belum punya cukup titik untuk dipandu.');
        return;
      }
      setGuideRoute(guideRoute);
      setGuideFitToken((token) => token + 1);
      setTab('record');
    },
    [setGuideRoute],
  );

  const requireProForCurated = useCallback(() => {
    requirePro('Rute rekomendasi PRO khusus pelanggan Pro ALLMOVA.');
  }, [requirePro]);

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

  // Copying a recommendation writes a planned route, so the Rute Saya list has
  // to be reloaded before the saved badge shows up there.
  const saveCuratedRoute = useCallback(
    async (route: CuratedRoute) => {
      if (!isSupabaseConfigured) {
        throw new Error('Server ALLMOVA belum dikonfigurasi. Hubungi admin aplikasi.');
      }
      if (!user) throw new Error('Sesi login tidak ditemukan. Silakan masuk kembali.');
      if (!isValidRouteCoordinates(route.coordinates)) {
        throw new Error('Koordinat rute tidak valid');
      }

      await savePlannedRoute({
        userId: user.id,
        title: route.name,
        activityType: route.sportType,
        distanceMeters: Math.round(route.distanceMeters),
        elevationGain: route.elevationGain,
        durationSeconds: curatedRouteDurationSeconds(route),
        coordinates: route.coordinates,
        routingMode: 'snap',
        elevationProfile: buildElevationProfile(route.coordinates),
        curatedRouteId: curatedRouteKey(route),
      });
      await refreshActivities();
      setNotice(`Rute "${route.name}" disimpan ke Rute Saya.`);
    },
    [refreshActivities, user],
  );

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
  // The guide route is dropped at the same time so the next session starts clean.
  const previousPhaseRef = useRef(recorder.phase);
  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = recorder.phase;
    if (previous !== 'idle' && recorder.phase === 'idle') {
      void refreshActivities();
      clearGuideRoute();
    }
  }, [recorder.phase, refreshActivities, clearGuideRoute]);

  const heatmapLayers = useMemo(
    () => ({
      visible: isRoutes && heatmap.enabled,
      lines: heatmap.linesGeoJSON,
    }),
    [isRoutes, heatmap.enabled, heatmap.linesGeoJSON],
  );

  const focusHeatmap = useCallback(() => {
    setHeatmapFocusToken((token) => token + 1);
  }, []);

  const openHeatmapFromActivities = useCallback(() => {
    if (!isPro) {
      requirePro('Heatmap Personal Vektor khusus Pro.');
      return;
    }
    setTab('routes');
    heatmap.enable();
    setHeatmapFocusToken((token) => token + 1);
  }, [heatmap.enable, isPro, requirePro]);

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
    <main className="relative h-dvh w-full overflow-hidden bg-[#0D1112]">
      {provider && (
        <MapView
          ref={mapRef}
          provider={provider}
          onProviderBadgeClick={() => setProviderModalOpen(true)}
          active={!isActivities}
          waypoints={isRoutes ? builder.waypoints : []}
          route={isRoutes ? builder.coordinates : null}
          onMapClick={isRoutes && routesSubTab === 'mine' ? builder.addWaypoint : undefined}
          livePosition={liveGps ? recorder.livePosition : null}
          liveTrack={liveGps ? recorder.track : null}
          gpsAccuracy={liveGps ? recorder.gpsAccuracy : null}
          followEnabled={followEnabled}
          showGpsStatus={liveGps}
          activityType={recorder.activityType}
          sportMode={isRoutes ? builder.activityType : recorder.activityType}
          heatmap={heatmapLayers}
          guideRoute={isRecord ? guideLngLat : null}
          guideFitToken={guideFitToken}
        />
      )}

      {isRoutes && (
        <RouteBuilderOverlay
          builder={builder}
          mapRef={mapRef}
          heatmap={heatmap}
          onFocusHeatmap={focusHeatmap}
          savedRoutes={savedRoutes}
          savedRoutesLoading={activities.loading}
          onFollowRoute={followRoute}
          subTab={routesSubTab}
          onChangeSubTab={setRoutesSubTab}
          curated={curated}
          isPro={isPro}
          onFollowCuratedRoute={followCuratedRoute}
          onSaveCuratedRoute={saveCuratedRoute}
          onRequirePro={requireProForCurated}
          onNotice={setNotice}
        />
      )}
      {isRecord && (
        <RecordOverlay
          recorder={recorder}
          guideRoute={guide.activeGuideRoute}
          savedRoutes={savedRoutes}
          savedRoutesLoading={activities.loading}
          onSelectGuideRoute={followRoute}
          onClearGuideRoute={clearGuideRoute}
          onSessionEnd={clearGuideRoute}
        />
      )}

      {isActivities && !openActivity && (
        <ActivitiesPanel
          activities={activities}
          onOpen={setOpenActivity}
          onNotice={setNotice}
          onOpenHeatmap={openHeatmapFromActivities}
          onFollowRoute={followRoute}
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
          onFollowRoute={followRoute}
        />
      )}

      {notice && (
        <p
          className="pointer-events-none absolute inset-x-3 top-[calc(env(safe-area-inset-top)+1rem)] z-[60] mx-auto max-w-md rounded-xl bg-[#151B1D]/95 px-3 py-2 text-center text-xs font-medium text-slate-100 shadow-lg backdrop-blur"
          role="status"
        >
          {notice}
        </p>
      )}

      {!openActivity && (
        <BottomNav
          active={tab}
          onChange={changeTab}
          lockedTabs={isPro ? [] : ['routes']}
        />
      )}

      {providerChecked && providerModalOpen && (
        <MapProviderModal
          current={provider}
          onSelect={selectProvider}
          onClose={provider ? () => setProviderModalOpen(false) : undefined}
          isPro={isPro}
          onRequirePro={() => requirePro('Peta satelit HD MapTiler khusus Pro.')}
        />
      )}

      <ProPaywallSheet
        open={paywallOpen}
        reason={paywallReason}
        onClose={() => setPaywallOpen(false)}
      />
    </main>
  );
}
