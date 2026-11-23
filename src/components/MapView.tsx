'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import maplibregl, {
  type HeatmapLayerSpecification,
  type LineLayerSpecification,
} from 'maplibre-gl';
import { Layers, LocateFixed, Mountain, Square } from 'lucide-react';
import type { LngLat, LngLatEle } from '@/lib/polyline';
import { gpsBadgeText, gpsQuality, type GpsQuality } from '@/lib/metrics';
import { applySky } from '@/lib/mapSky';
import { MAP_PROVIDER_LABELS, type MapProvider } from '@/lib/mapProvider';
import { createActivityMarkerElement } from '@/lib/activityMarker';
import type { ActivityType } from '@/lib/valhalla';
import {
  hasMaptilerKey,
  initialMapStyle,
  installTerrain,
  resolveMapStyle,
  type BaseMapStyle,
} from '@/lib/mapStyle';
import { HEATMAP_SCHEMES, type HeatmapScheme } from '@/lib/heatmapCache';
import 'maplibre-gl/dist/maplibre-gl.css';

const TERRAIN_SOURCE_ID = 'terrain-source';
const HILLSHADE_LAYER_ID = 'map-hillshade';
const ROUTE_SOURCE_ID = 'route-line';
const ROUTE_CASING_LAYER_ID = 'route-line-casing';
const ROUTE_LAYER_ID = 'route-line-layer';
const ROUTE_COLOR = '#f97316';
const TRACK_SOURCE_ID = 'live-track';
const TRACK_CASING_LAYER_ID = 'live-track-casing';
const TRACK_LAYER_ID = 'live-track-layer';
const TRACK_COLOR = '#22d3ee';
const HEATMAP_LINES_SOURCE_ID = 'personal-heatmap-lines';
const HEATMAP_POINTS_SOURCE_ID = 'personal-heatmap-points';
const HEATMAP_CLOUD_LAYER_ID = 'personal-heatmap-cloud';
const HEATMAP_GLOW_LAYER_ID = 'personal-heatmap-glow';
const HEATMAP_CORE_LAYER_ID = 'personal-heatmap-core';
/** Lines hand over to the heat cloud above this zoom. */
const HEATMAP_CLOUD_MAX_ZOOM = 13;
const DEFAULT_CENTER: [number, number] = [107.6191, -6.9175];
const DEFAULT_ZOOM = 13;
const PITCH_3D = 60;
const FOLLOW_ZOOM = 16.5;

/** Web Mercator metres-per-pixel, used to size the accuracy halo in screen space. */
function metersToPixels(meters: number, latitude: number, zoom: number): number {
  const metersPerPixel = (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return 0;
  return meters / metersPerPixel;
}

export type MapViewHandle = {
  flyTo: (center: LngLat, zoom?: number, duration?: number) => void;
  fitCoordinates: (coordinates: (LngLat | LngLatEle)[]) => void;
  toggleDimension: () => void;
  toggleStyle: () => void;
  locate: () => void;
  getCenter: () => LngLat | null;
  getZoom: () => number;
};

type Props = {
  /** Which tile stack to render (chosen in the provider modal). */
  provider: MapProvider;
  /** Opens the provider modal again from the floating badge. */
  onProviderBadgeClick: () => void;
  active: boolean;
  waypoints?: LngLat[];
  route?: LngLatEle[] | null;
  onMapClick?: (lngLat: LngLat) => void;
  /** Latest GPS fix, drawn as the blue dot with an accuracy halo. */
  livePosition?: { lng: number; lat: number; accuracy: number } | null;
  /** Recorded track drawn live on top of the map. */
  liveTrack?: LngLatEle[] | null;
  /** Accuracy of the latest fix in metres; `null` while no fix has arrived. */
  gpsAccuracy?: number | null;
  /** While true, the camera follows the blue dot until the user pans away. */
  followEnabled?: boolean;
  /** Shows the GPS signal badge; enabled on the Record tab. */
  showGpsStatus?: boolean;
  /** Drives the live activity badge icon. */
  activityType?: ActivityType;
  /** Personal heatmap drawn beneath the active route line and waypoint markers. */
  heatmap?: HeatmapLayers | null;
};

export type HeatmapLayers = {
  visible: boolean;
  scheme: HeatmapScheme;
  lines: GeoJSON.FeatureCollection<GeoJSON.LineString> | null;
  points: GeoJSON.FeatureCollection<GeoJSON.Point> | null;
};

const EMPTY_LINE: GeoJSON.Feature<GeoJSON.LineString> = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [] },
};

const EMPTY_TRACK: GeoJSON.Feature<GeoJSON.LineString> = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [] },
};

const EMPTY_HEATMAP_LINES: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
  type: 'FeatureCollection',
  features: [],
};

const EMPTY_HEATMAP_POINTS: GeoJSON.FeatureCollection<GeoJSON.Point> = {
  type: 'FeatureCollection',
  features: [],
};

const GPS_BADGE_STYLES: Record<GpsQuality, string> = {
  good: 'bg-emerald-500/95 text-white',
  fair: 'bg-amber-400/95 text-slate-900',
  poor: 'bg-slate-900/90 text-slate-100',
};

const MapView = forwardRef<MapViewHandle, Props>(function MapView(
  {
    provider,
    onProviderBadgeClick,
    active,
    waypoints = [],
    route = null,
    onMapClick,
    livePosition = null,
    liveTrack = null,
    gpsAccuracy = null,
    followEnabled = false,
    showGpsStatus = false,
    activityType = 'cycling',
    heatmap = null,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const userMarkerKeyRef = useRef<string | null>(null);
  const haloRef = useRef<HTMLDivElement | null>(null);
  const routeRef = useRef<LngLatEle[] | null>(route);
  const trackRef = useRef<LngLatEle[] | null>(liveTrack);
  const clickRef = useRef(onMapClick);
  const positionRef = useRef(livePosition);
  const providerRef = useRef(provider);
  const heatmapRef = useRef(heatmap);
  /** Last collections pushed to the GPU, so unchanged filters skip re-parsing. */
  const appliedHeatmapRef = useRef<{ lines: unknown; points: unknown }>({
    lines: null,
    points: null,
  });
  const [mapStyle, setMapStyle] = useState<BaseMapStyle>('outdoor');
  const [is3D, setIs3D] = useState(true);
  const is3DRef = useRef(is3D);
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [autoFollow, setAutoFollow] = useState(followEnabled);
  /** Provider+style currently handed to MapLibre, to avoid reloading on mount. */
  const appliedStyleRef = useRef(`${provider}:outdoor`);

  routeRef.current = route;
  trackRef.current = liveTrack;
  clickRef.current = onMapClick;
  positionRef.current = livePosition;
  is3DRef.current = is3D;
  providerRef.current = provider;
  heatmapRef.current = heatmap;

  useEffect(() => {
    if (!followEnabled) setAutoFollow(false);
    else setAutoFollow(true);
  }, [followEnabled]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: initialMapStyle(providerRef.current),
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      pitch: PITCH_3D,
      bearing: 0,
      attributionControl: { compact: true },
    });

    mapRef.current = map;
    map.touchZoomRotate.enableRotation();
    map.dragRotate.enable();

    // setStyle() discards custom sources and layers, so they are all rebuilt here.
    const ensureRouteLayers = () => {
      if (!map.getSource(ROUTE_SOURCE_ID)) {
        map.addSource(ROUTE_SOURCE_ID, {
          type: 'geojson',
          data: EMPTY_LINE,
          lineMetrics: true,
        });
      }
      if (!map.getLayer(ROUTE_CASING_LAYER_ID)) {
        map.addLayer({
          id: ROUTE_CASING_LAYER_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#0f172a', 'line-width': 9, 'line-opacity': 0.5 },
        });
      }
      if (!map.getLayer(ROUTE_LAYER_ID)) {
        map.addLayer({
          id: ROUTE_LAYER_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': ROUTE_COLOR, 'line-width': 5 },
        });
      }
      if (!map.getSource(TRACK_SOURCE_ID)) {
        map.addSource(TRACK_SOURCE_ID, {
          type: 'geojson',
          data: EMPTY_TRACK,
          lineMetrics: true,
        });
      }
      if (!map.getLayer(TRACK_CASING_LAYER_ID)) {
        map.addLayer({
          id: TRACK_CASING_LAYER_ID,
          type: 'line',
          source: TRACK_SOURCE_ID,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#0f172a', 'line-width': 10, 'line-opacity': 0.45 },
        });
      }
      if (!map.getLayer(TRACK_LAYER_ID)) {
        map.addLayer({
          id: TRACK_LAYER_ID,
          type: 'line',
          source: TRACK_SOURCE_ID,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': TRACK_COLOR, 'line-width': 6 },
        });
      }
      applyRoute(map, routeRef.current);
      applyTrack(map, trackRef.current);
      ensureHeatmapLayers(map);
      appliedHeatmapRef.current = { lines: null, points: null };
      applyHeatmap(map, heatmapRef.current, appliedHeatmapRef);
    };

    map.on('style.load', () => {
      if (is3DRef.current) applySky(map);
      installTerrain(map, providerRef.current, {
        source: TERRAIN_SOURCE_ID,
        hillshade: HILLSHADE_LAYER_ID,
      });
      ensureRouteLayers();
    });

    map.on('click', (event) => {
      clickRef.current?.([event.lngLat.lng, event.lngLat.lat]);
    });

    // Panning by hand means the user wants to look elsewhere; following would
    // fight their finger, so it stays off until "Lokasi Saya" is tapped.
    map.on('dragstart', () => setAutoFollow(false));

    return () => {
      for (const marker of markersRef.current) marker.remove();
      markersRef.current = [];
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      userMarkerKeyRef.current = null;
      haloRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Reloads the base style when the provider or Outdoor/Satellite choice
  // changes. `setStyle` fires `style.load`, which re-installs terrain, sky and
  // the route layers on top of the new base map.
  useEffect(() => {
    const key = `${provider}:${mapStyle}`;
    if (appliedStyleRef.current === key) return;
    appliedStyleRef.current = key;

    const map = mapRef.current;
    if (!map) return;

    let cancelled = false;
    void resolveMapStyle(provider, mapStyle).then((style) => {
      if (cancelled || mapRef.current !== map) return;
      map.setStyle(style, { diff: false });
    });
    return () => {
      cancelled = true;
    };
  }, [provider, mapStyle]);

  const resizeHalo = useCallback(() => {
    const map = mapRef.current;
    const halo = haloRef.current;
    const position = positionRef.current;
    if (!map || !halo) return;

    const meters = position && Number.isFinite(position.accuracy) ? position.accuracy : 0;
    const latitude = position?.lat ?? 0;
    const diameter = metersToPixels(meters, latitude, map.getZoom()) * 2;
    const size = Math.min(Math.max(diameter, 0), 4000);
    halo.style.width = `${size}px`;
    halo.style.height = `${size}px`;
  }, []);

  // The live marker is created once per mode/activity and then only moved, so
  // it never flickers between GPS fixes. Switching sport swaps the badge icon.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!livePosition) {
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      userMarkerKeyRef.current = null;
      haloRef.current = null;
      return;
    }

    const key = showGpsStatus ? `badge:${activityType}` : 'dot';

    if (!userMarkerRef.current || userMarkerKeyRef.current !== key) {
      userMarkerRef.current?.remove();

      const element = document.createElement('div');
      element.className = 'pointer-events-none relative flex items-center justify-center';

      const halo = document.createElement('div');
      halo.className =
        'absolute rounded-full bg-sky-400/20 ring-1 ring-sky-300/40 transition-[width,height] duration-300';
      halo.style.transform = 'translate(-50%, -50%)';
      halo.style.left = '50%';
      halo.style.top = '50%';
      haloRef.current = halo;
      element.appendChild(halo);

      if (showGpsStatus) {
        element.appendChild(createActivityMarkerElement(activityType, { pulse: true }));
      } else {
        const dot = document.createElement('div');
        dot.className =
          'relative h-4 w-4 rounded-full border-2 border-white bg-sky-500 shadow-[0_0_12px_rgba(56,189,248,0.9)]';
        element.appendChild(dot);
      }

      userMarkerRef.current = new maplibregl.Marker({
        element,
        anchor: 'center',
        rotationAlignment: 'viewport',
        pitchAlignment: 'viewport',
      })
        .setLngLat([livePosition.lng, livePosition.lat])
        .addTo(map);
      userMarkerKeyRef.current = key;
    } else {
      userMarkerRef.current.setLngLat([livePosition.lng, livePosition.lat]);
    }

    resizeHalo();
  }, [livePosition, showGpsStatus, activityType, resizeHalo]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.on('zoom', resizeHalo);
    return () => {
      map.off('zoom', resizeHalo);
    };
  }, [resizeHalo]);

  // Smart auto-follow: only recentres while following is on, so a manual drag
  // is never overridden.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !livePosition || !autoFollow) return;
    map.easeTo({
      center: [livePosition.lng, livePosition.lat],
      zoom: Math.max(map.getZoom(), FOLLOW_ZOOM),
      duration: 800,
    });
  }, [livePosition, autoFollow]);

  useEffect(() => {
    if (active) mapRef.current?.resize();
  }, [active]);

  useEffect(() => {
    if (mapRef.current) applyRoute(mapRef.current, route);
  }, [route]);

  useEffect(() => {
    if (mapRef.current) applyTrack(mapRef.current, liveTrack);
  }, [liveTrack]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyHeatmap(map, heatmap, appliedHeatmapRef);
  }, [heatmap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const marker of markersRef.current) marker.remove();
    markersRef.current = waypoints.map((position, index) => {
      const element = document.createElement('div');
      element.className =
        'flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-orange-500 text-[11px] font-bold text-white shadow-lg';
      element.textContent = String(index + 1);
      // Markers live inside the canvas container, so an un-stopped tap would
      // also register as a map click and add a duplicate waypoint.
      element.addEventListener('click', (event) => event.stopPropagation());
      return new maplibregl.Marker({ element, anchor: 'center' }).setLngLat(position).addTo(map);
    });
  }, [waypoints]);

  const toggleDimension = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const next = !is3D;
    map.easeTo({ pitch: next ? PITCH_3D : 0, duration: 600 });
    if (next) applySky(map);
    setIs3D(next);
  }, [is3D]);

  const toggleStyle = useCallback(() => {
    setMapStyle((current) => (current === 'outdoor' ? 'satellite' : 'outdoor'));
  }, []);

  const flyTo = useCallback((center: LngLat, zoom = 16, duration = 1200) => {
    mapRef.current?.flyTo({ center, zoom, duration });
  }, []);

  const getCenter = useCallback((): LngLat | null => {
    const map = mapRef.current;
    if (!map) return null;
    const center = map.getCenter();
    return [center.lng, center.lat];
  }, []);

  const getZoom = useCallback((): number => mapRef.current?.getZoom() ?? DEFAULT_ZOOM, []);

  const fitCoordinates = useCallback((coordinates: (LngLat | LngLatEle)[]) => {
    const map = mapRef.current;
    if (!map || coordinates.length === 0) return;

    const bounds = coordinates.reduce(
      (acc, [lng, lat]) => acc.extend([lng, lat] as LngLat),
      new maplibregl.LngLatBounds(
        [coordinates[0][0], coordinates[0][1]],
        [coordinates[0][0], coordinates[0][1]],
      ),
    );
    map.fitBounds(bounds, { padding: 64, maxZoom: 16, duration: 1200 });
  }, []);

  const locate = useCallback(() => {
    setAutoFollow(true);

    // A live fix is already on the map; recentre on it without a fresh request.
    if (livePosition) {
      mapRef.current?.easeTo({
        center: [livePosition.lng, livePosition.lat],
        zoom: Math.max(mapRef.current.getZoom(), FOLLOW_ZOOM),
        duration: 800,
      });
      setNotice(null);
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setNotice('Perangkat ini tidak mendukung layanan lokasi.');
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        setNotice(null);
        flyTo([position.coords.longitude, position.coords.latitude]);
      },
      (error) => {
        setLocating(false);
        setNotice(
          error.code === error.PERMISSION_DENIED
            ? 'Izin lokasi ditolak. Aktifkan izin lokasi untuk aplikasi ini.'
            : 'Lokasi tidak tersedia saat ini. Coba lagi di area terbuka.',
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }, [flyTo, livePosition]);

  useImperativeHandle(
    ref,
    () => ({ flyTo, fitCoordinates, toggleDimension, toggleStyle, locate, getCenter, getZoom }),
    [flyTo, fitCoordinates, toggleDimension, toggleStyle, locate, getCenter, getZoom],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const quality = gpsQuality(gpsAccuracy);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />

      <div
        className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+1rem)]"
        aria-live="polite"
      >
        {provider === 'maptiler' && !hasMaptilerKey && (
          <p className="rounded-full bg-amber-500/90 px-4 py-1.5 text-center text-xs font-medium text-slate-900 shadow-lg">
            NEXT_PUBLIC_MAPTILER_KEY belum diatur — peta dasar tidak dapat dimuat.
          </p>
        )}
        {showGpsStatus && (
          <p
            className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold shadow-lg ${
              GPS_BADGE_STYLES[quality]
            }`}
            role="status"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                quality === 'poor' ? 'animate-pulse bg-slate-400' : 'bg-white'
              }`}
            />
            {gpsBadgeText(gpsAccuracy)}
          </p>
        )}
        {notice && (
          <p className="rounded-full bg-slate-900/90 px-4 py-1.5 text-center text-xs font-medium text-slate-100 shadow-lg">
            {notice}
          </p>
        )}
      </div>

      <div className="absolute right-3 top-[calc(env(safe-area-inset-top)+1rem)] flex flex-col items-end gap-3">
        <button
          type="button"
          onClick={onProviderBadgeClick}
          aria-label="Ganti mesin peta"
          title="Ganti mesin peta"
          className="rounded-full border border-white/15 bg-slate-900/85 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-100 shadow-lg backdrop-blur transition active:scale-95"
        >
          {MAP_PROVIDER_LABELS[provider]}
        </button>
        <FloatingButton label={is3D ? 'Tampilan 2D' : 'Tampilan 3D'} onClick={toggleDimension}>
          {is3D ? <Square size={20} /> : <Mountain size={20} />}
        </FloatingButton>
        <FloatingButton
          label={mapStyle === 'outdoor' ? 'Gaya Satelit' : 'Gaya Outdoor'}
          onClick={toggleStyle}
        >
          <Layers size={20} />
        </FloatingButton>
        <FloatingButton label="Lokasi Saya" onClick={locate} busy={locating}>
          <LocateFixed size={20} />
        </FloatingButton>
      </div>
    </div>
  );
});

function applyRoute(map: maplibregl.Map, route: LngLatEle[] | null) {
  const source = map.getSource(ROUTE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  source.setData({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: route && route.length > 1 ? route : [],
    },
  });
}

function applyTrack(map: maplibregl.Map, track: LngLatEle[] | null) {
  const source = map.getSource(TRACK_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  source.setData({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: track && track.length > 1 ? track : [],
    },
  });
}

/**
 * Heatmap layers sit directly under the route casing, so the active planning
 * line, live track and HTML waypoint markers always stay readable on top.
 */
function ensureHeatmapLayers(map: maplibregl.Map) {
  const before = map.getLayer(ROUTE_CASING_LAYER_ID) ? ROUTE_CASING_LAYER_ID : undefined;

  if (!map.getSource(HEATMAP_LINES_SOURCE_ID)) {
    map.addSource(HEATMAP_LINES_SOURCE_ID, { type: 'geojson', data: EMPTY_HEATMAP_LINES });
  }
  if (!map.getSource(HEATMAP_POINTS_SOURCE_ID)) {
    map.addSource(HEATMAP_POINTS_SOURCE_ID, { type: 'geojson', data: EMPTY_HEATMAP_POINTS });
  }

  if (!map.getLayer(HEATMAP_CLOUD_LAYER_ID)) {
    map.addLayer(
      {
        id: HEATMAP_CLOUD_LAYER_ID,
        type: 'heatmap',
        source: HEATMAP_POINTS_SOURCE_ID,
        maxzoom: HEATMAP_CLOUD_MAX_ZOOM,
        layout: { visibility: 'none' },
        paint: heatmapCloudPaint('fire'),
      },
      before,
    );
  }

  if (!map.getLayer(HEATMAP_GLOW_LAYER_ID)) {
    map.addLayer(
      {
        id: HEATMAP_GLOW_LAYER_ID,
        type: 'line',
        source: HEATMAP_LINES_SOURCE_ID,
        layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: heatmapGlowPaint('fire'),
      },
      before,
    );
  }

  if (!map.getLayer(HEATMAP_CORE_LAYER_ID)) {
    map.addLayer(
      {
        id: HEATMAP_CORE_LAYER_ID,
        type: 'line',
        source: HEATMAP_LINES_SOURCE_ID,
        layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: heatmapCorePaint('fire'),
      },
      before,
    );
  }
}

function heatmapCloudPaint(
  scheme: HeatmapScheme,
): NonNullable<HeatmapLayerSpecification['paint']> {
  const palette = HEATMAP_SCHEMES[scheme];
  return {
    'heatmap-weight': ['interpolate', ['linear'], ['get', 'weight'], 0, 0, 1, 1],
    'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 9, 0.9, 13, 1.8],
    'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 8, 10, 11, 18, 13, 34],
    'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 11, 1, 13, 0],
    'heatmap-color': [
      'interpolate',
      ['linear'],
      ['heatmap-density'],
      0,
      'rgba(0, 0, 0, 0)',
      0.2,
      palette.cloud[0],
      0.55,
      palette.cloud[1],
      0.85,
      palette.cloud[2],
      1,
      '#ffffff',
    ],
  };
}

function heatmapGlowPaint(scheme: HeatmapScheme): NonNullable<LineLayerSpecification['paint']> {
  return {
    'line-color': HEATMAP_SCHEMES[scheme].glow,
    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 9, 17, 14],
    'line-blur': 8,
    'line-opacity': 0.32,
  };
}

function heatmapCorePaint(scheme: HeatmapScheme): NonNullable<LineLayerSpecification['paint']> {
  return {
    'line-color': HEATMAP_SCHEMES[scheme].core,
    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 2.5, 17, 4],
    'line-opacity': 0.45,
  };
}

function applyHeatmap(
  map: maplibregl.Map,
  heatmap: HeatmapLayers | null | undefined,
  appliedRef?: { current: { lines: unknown; points: unknown } },
) {
  const linesSource = map.getSource(HEATMAP_LINES_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  const pointsSource = map.getSource(HEATMAP_POINTS_SOURCE_ID) as
    | maplibregl.GeoJSONSource
    | undefined;
  if (!linesSource || !pointsSource) return;

  const lines = heatmap?.lines ?? EMPTY_HEATMAP_LINES;
  const points = heatmap?.points ?? EMPTY_HEATMAP_POINTS;

  if (!appliedRef || appliedRef.current.lines !== lines) {
    linesSource.setData(lines);
    if (appliedRef) appliedRef.current.lines = lines;
  }
  if (!appliedRef || appliedRef.current.points !== points) {
    pointsSource.setData(points);
    if (appliedRef) appliedRef.current.points = points;
  }

  const visibility = heatmap?.visible ? 'visible' : 'none';
  const scheme = heatmap?.scheme ?? 'fire';
  const palette = HEATMAP_SCHEMES[scheme];

  for (const layerId of [HEATMAP_CLOUD_LAYER_ID, HEATMAP_GLOW_LAYER_ID, HEATMAP_CORE_LAYER_ID]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', visibility);
  }

  if (map.getLayer(HEATMAP_CLOUD_LAYER_ID)) {
    map.setPaintProperty(
      HEATMAP_CLOUD_LAYER_ID,
      'heatmap-color',
      heatmapCloudPaint(scheme)['heatmap-color'],
    );
  }
  if (map.getLayer(HEATMAP_GLOW_LAYER_ID)) {
    map.setPaintProperty(HEATMAP_GLOW_LAYER_ID, 'line-color', palette.glow);
  }
  if (map.getLayer(HEATMAP_CORE_LAYER_ID)) {
    map.setPaintProperty(HEATMAP_CORE_LAYER_ID, 'line-color', palette.core);
  }
}

export function FloatingButton({
  label,
  onClick,
  busy = false,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-busy={busy}
      disabled={busy || disabled}
      className="flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-slate-900/85 text-slate-100 shadow-xl backdrop-blur transition active:scale-95 active:bg-slate-800 disabled:opacity-40"
    >
      {busy ? (
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-500 border-t-slate-100" />
      ) : (
        children
      )}
    </button>
  );
}

export default MapView;
