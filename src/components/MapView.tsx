'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import { Layers, LocateFixed, Mountain, Square } from 'lucide-react';
import type { LngLat, LngLatEle } from '@/lib/polyline';
import 'maplibre-gl/dist/maplibre-gl.css';

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? '';
const HAS_KEY = MAPTILER_KEY.length > 0;

type MapStyle = 'outdoor' | 'satellite';

const STYLE_URLS: Record<MapStyle, string> = {
  outdoor: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`,
  satellite: `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_KEY}`,
};

const TERRAIN_URL = `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`;

const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#0f172a' },
    },
  ],
};

const TERRAIN_SOURCE_ID = 'terrain-source';
const ROUTE_SOURCE_ID = 'route-line';
const ROUTE_CASING_LAYER_ID = 'route-line-casing';
const ROUTE_LAYER_ID = 'route-line-layer';
const ROUTE_COLOR = '#f97316';
const DEFAULT_CENTER: [number, number] = [107.6191, -6.9175];
const DEFAULT_ZOOM = 13;
const PITCH_3D = 60;

export type MapViewHandle = {
  flyTo: (center: LngLat, zoom?: number) => void;
  fitCoordinates: (coordinates: (LngLat | LngLatEle)[]) => void;
  toggleDimension: () => void;
  toggleStyle: () => void;
  locate: () => void;
};

type Props = {
  active: boolean;
  waypoints?: LngLat[];
  route?: LngLatEle[] | null;
  onMapClick?: (lngLat: LngLat) => void;
};

const EMPTY_LINE: GeoJSON.Feature<GeoJSON.LineString> = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [] },
};

const MapView = forwardRef<MapViewHandle, Props>(function MapView(
  { active, waypoints = [], route = null, onMapClick },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const routeRef = useRef<LngLatEle[] | null>(route);
  const clickRef = useRef(onMapClick);
  const [mapStyle, setMapStyle] = useState<MapStyle>('outdoor');
  const [is3D, setIs3D] = useState(true);
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  routeRef.current = route;
  clickRef.current = onMapClick;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: HAS_KEY ? STYLE_URLS.outdoor : FALLBACK_STYLE,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      pitch: PITCH_3D,
      bearing: 0,
      attributionControl: { compact: true },
    });

    mapRef.current = map;
    map.touchZoomRotate.enableRotation();
    map.dragRotate.enable();

    const enableTerrain = () => {
      if (!HAS_KEY) return;
      try {
        if (!map.getSource(TERRAIN_SOURCE_ID)) {
          map.addSource(TERRAIN_SOURCE_ID, {
            type: 'raster-dem',
            url: TERRAIN_URL,
            tileSize: 256,
          });
        }
        map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1.5 });
      } catch {
        // Terrain is a progressive enhancement: the map stays usable without it.
      }
    };

    // setStyle() discards custom sources and layers, so both are rebuilt here.
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
      applyRoute(map, routeRef.current);
    };

    map.on('style.load', () => {
      enableTerrain();
      ensureRouteLayers();
    });

    map.on('click', (event) => {
      clickRef.current?.([event.lngLat.lng, event.lngLat.lat]);
    });

    return () => {
      for (const marker of markersRef.current) marker.remove();
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (active) mapRef.current?.resize();
  }, [active]);

  useEffect(() => {
    if (mapRef.current) applyRoute(mapRef.current, route);
  }, [route]);

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
    setIs3D(next);
  }, [is3D]);

  const toggleStyle = useCallback(() => {
    const next: MapStyle = mapStyle === 'outdoor' ? 'satellite' : 'outdoor';
    if (HAS_KEY) mapRef.current?.setStyle(STYLE_URLS[next], { diff: false });
    setMapStyle(next);
    if (!HAS_KEY) setNotice('Kunci MapTiler belum diatur.');
  }, [mapStyle]);

  const flyTo = useCallback((center: LngLat, zoom = 16) => {
    mapRef.current?.flyTo({ center, zoom, duration: 1200 });
  }, []);

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
  }, [flyTo]);

  useImperativeHandle(
    ref,
    () => ({ flyTo, fitCoordinates, toggleDimension, toggleStyle, locate }),
    [flyTo, fitCoordinates, toggleDimension, toggleStyle, locate],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />

      <div
        className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+1rem)]"
        aria-live="polite"
      >
        {!HAS_KEY && (
          <p className="rounded-full bg-amber-500/90 px-4 py-1.5 text-center text-xs font-medium text-slate-900 shadow-lg">
            NEXT_PUBLIC_MAPTILER_KEY belum diatur — peta dasar tidak dapat dimuat.
          </p>
        )}
        {notice && (
          <p className="rounded-full bg-slate-900/90 px-4 py-1.5 text-center text-xs font-medium text-slate-100 shadow-lg">
            {notice}
          </p>
        )}
      </div>

      <div className="absolute right-3 top-[calc(env(safe-area-inset-top)+1rem)] flex flex-col gap-3">
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
