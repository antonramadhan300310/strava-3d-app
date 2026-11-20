'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import { Layers, LocateFixed, Mountain, Square } from 'lucide-react';
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
const DEFAULT_CENTER: [number, number] = [107.6191, -6.9175];
const DEFAULT_ZOOM = 13;
const PITCH_3D = 60;

type Props = {
  active: boolean;
};

export default function MapView({ active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapStyle, setMapStyle] = useState<MapStyle>('outdoor');
  const [is3D, setIs3D] = useState(true);
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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

    map.on('style.load', enableTerrain);

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (active) mapRef.current?.resize();
  }, [active]);

  const toggleDimension = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const next = !is3D;
    map.easeTo({ pitch: next ? PITCH_3D : 0, duration: 600 });
    setIs3D(next);
  }, [is3D]);

  const toggleStyle = useCallback(() => {
    const map = mapRef.current;
    const next: MapStyle = mapStyle === 'outdoor' ? 'satellite' : 'outdoor';
    if (map && HAS_KEY) map.setStyle(STYLE_URLS[next], { diff: false });
    setMapStyle(next);
    if (!HAS_KEY) setNotice('Kunci MapTiler belum diatur.');
  }, [mapStyle]);

  const locateMe = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setNotice('Perangkat ini tidak mendukung layanan lokasi.');
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        setNotice(null);
        map.flyTo({
          center: [position.coords.longitude, position.coords.latitude],
          zoom: 16,
          duration: 1200,
        });
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
  }, []);

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
        <FloatingButton label="Lokasi Saya" onClick={locateMe} busy={locating}>
          <LocateFixed size={20} />
        </FloatingButton>
      </div>
    </div>
  );
}

function FloatingButton({
  label,
  onClick,
  busy = false,
  children,
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-busy={busy}
      className="flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-slate-900/85 text-slate-100 shadow-xl backdrop-blur transition active:scale-95 active:bg-slate-800 disabled:opacity-60"
      disabled={busy}
    >
      {busy ? (
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-500 border-t-slate-100" />
      ) : (
        children
      )}
    </button>
  );
}
