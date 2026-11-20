'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import {
  FLYOVER_PITCH,
  FLYOVER_ZOOM,
  lerpBearing,
  type FlyoverPath,
  type FlyoverSample,
} from '@/lib/flyover';
import 'maplibre-gl/dist/maplibre-gl.css';

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? '';
const HAS_KEY = MAPTILER_KEY.length > 0;
const STYLE_URL = `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`;
const TERRAIN_URL = `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`;
const TERRAIN_EXAGGERATION = 1.5;

const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1220' } }],
};

const TERRAIN_SOURCE_ID = 'flyover-terrain';
const BASE_SOURCE_ID = 'flyover-base';
const REVEAL_SOURCE_ID = 'flyover-reveal';
const BASE_CASING_LAYER_ID = 'flyover-base-casing';
const BASE_LAYER_ID = 'flyover-base-line';
const REVEAL_GLOW_LAYER_ID = 'flyover-reveal-glow';
const REVEAL_LAYER_ID = 'flyover-reveal-line';
const BASE_COLOR = '#f97316';
const REVEAL_COLOR = '#fde047';

/** Camera rotation smoothing; low enough to glide through corners. */
const BEARING_LERP = 0.14;

type LineGradient = NonNullable<
  Extract<maplibregl.LayerSpecification, { type: 'line' }>['paint']
>['line-gradient'];

export type FlyoverMapHandle = {
  /** Moves the marker, redraws the reveal line and drives the camera. */
  applyFrame: (sample: FlyoverSample, progress: number) => void;
};

type Props = {
  path: FlyoverPath;
};

const FlyoverMap = forwardRef<FlyoverMapHandle, Props>(function FlyoverMap({ path }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const bearingRef = useRef<number | null>(null);
  const pathRef = useRef(path);

  pathRef.current = path;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const start = pathRef.current.coordinates[0];
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: HAS_KEY ? STYLE_URL : FALLBACK_STYLE,
      center: [start[0], start[1]],
      zoom: FLYOVER_ZOOM,
      pitch: FLYOVER_PITCH,
      bearing: 0,
      // MapLibre clamps pitch to 60 by default, which would flatten the requested 70.
      maxPitch: 85,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.touchZoomRotate.enableRotation();

    const element = document.createElement('div');
    element.className = 'pointer-events-none flex h-6 w-6 items-center justify-center';
    element.innerHTML =
      '<span class="absolute h-6 w-6 animate-ping rounded-full bg-orange-400/40"></span>' +
      '<span class="relative h-4 w-4 rounded-full border-2 border-white bg-orange-500 shadow-[0_0_14px_rgba(249,115,22,0.95)]"></span>';
    markerRef.current = new maplibregl.Marker({ element, anchor: 'center' })
      .setLngLat([start[0], start[1]])
      .addTo(map);

    // setStyle() (or a late style load) drops custom sources, so they are rebuilt.
    const onStyleLoad = () => {
      enableTerrain(map);
      installLayers(map, pathRef.current);
      setRevealProgress(map, 0);
    };
    map.on('style.load', onStyleLoad);

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      map.off('style.load', onStyleLoad);
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // A different activity swaps the geometry under the already-built layers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const start = path.coordinates[0];
    bearingRef.current = null;
    markerRef.current?.setLngLat([start[0], start[1]]);

    const apply = () => {
      const base = map.getSource(BASE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      const reveal = map.getSource(REVEAL_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      base?.setData(path.line);
      reveal?.setData(path.line);
      setRevealProgress(map, 0);
    };

    if (map.getSource(BASE_SOURCE_ID)) apply();
    else map.once('style.load', apply);

    map.easeTo({
      center: [start[0], start[1]],
      zoom: FLYOVER_ZOOM,
      pitch: FLYOVER_PITCH,
      bearing: 0,
      duration: 900,
    });

    return () => {
      map.off('style.load', apply);
    };
  }, [path]);

  useImperativeHandle(
    ref,
    () => ({
      applyFrame: (sample, progress) => {
        const map = mapRef.current;
        if (!map) return;

        markerRef.current?.setLngLat([sample.lng, sample.lat]);
        setRevealProgress(map, progress);

        // Smoothing the heading keeps corners from snapping the camera.
        const current = bearingRef.current;
        const next =
          current === null ? sample.bearing : lerpBearing(current, sample.bearing, BEARING_LERP);
        bearingRef.current = next;

        map.jumpTo({
          center: [sample.lng, sample.lat],
          bearing: next,
          pitch: FLYOVER_PITCH,
          zoom: FLYOVER_ZOOM,
        });
      },
    }),
    [],
  );

  // MapLibre's stylesheet forces `position: relative` on this element, so the
  // height has to come from a positioned parent instead of `absolute inset-0`.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
});

function enableTerrain(map: maplibregl.Map) {
  if (!HAS_KEY) return;
  try {
    if (!map.getSource(TERRAIN_SOURCE_ID)) {
      map.addSource(TERRAIN_SOURCE_ID, { type: 'raster-dem', url: TERRAIN_URL, tileSize: 256 });
    }
    map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION });
  } catch {
    // Terrain is an enhancement; the flyover still runs on a flat map.
  }
}

function installLayers(map: maplibregl.Map, path: FlyoverPath) {
  if (!map.getSource(BASE_SOURCE_ID)) {
    map.addSource(BASE_SOURCE_ID, { type: 'geojson', data: path.line });
  }
  if (!map.getLayer(BASE_CASING_LAYER_ID)) {
    map.addLayer({
      id: BASE_CASING_LAYER_ID,
      type: 'line',
      source: BASE_SOURCE_ID,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#0f172a', 'line-width': 8, 'line-opacity': 0.5 },
    });
  }
  if (!map.getLayer(BASE_LAYER_ID)) {
    map.addLayer({
      id: BASE_LAYER_ID,
      type: 'line',
      source: BASE_SOURCE_ID,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': BASE_COLOR, 'line-width': 4, 'line-opacity': 0.35 },
    });
  }

  if (!map.getSource(REVEAL_SOURCE_ID)) {
    map.addSource(REVEAL_SOURCE_ID, { type: 'geojson', data: path.line, lineMetrics: true });
  }
  if (!map.getLayer(REVEAL_GLOW_LAYER_ID)) {
    map.addLayer({
      id: REVEAL_GLOW_LAYER_ID,
      type: 'line',
      source: REVEAL_SOURCE_ID,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': REVEAL_COLOR,
        'line-width': 14,
        'line-opacity': 0.28,
        'line-blur': 6,
        'line-gradient': gradient(0),
      },
    });
  }
  if (!map.getLayer(REVEAL_LAYER_ID)) {
    map.addLayer({
      id: REVEAL_LAYER_ID,
      type: 'line',
      source: REVEAL_SOURCE_ID,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': REVEAL_COLOR, 'line-width': 6, 'line-gradient': gradient(0) },
    });
  }
}

const TRANSPARENT = 'rgba(253,224,71,0)';

/**
 * Colour ramp that stops at `progress`, so the bright line is drawn up to the
 * marker only. Stops must be strictly ascending, hence the empty/complete cases.
 */
function gradient(progress: number): LineGradient {
  const stop = Math.min(Math.max(progress, 0), 1);

  if (stop <= 0) {
    return [
      'interpolate',
      ['linear'],
      ['line-progress'],
      0,
      TRANSPARENT,
      1,
      TRANSPARENT,
    ] as unknown as LineGradient;
  }
  if (stop >= 1) {
    return [
      'interpolate',
      ['linear'],
      ['line-progress'],
      0,
      REVEAL_COLOR,
      1,
      REVEAL_COLOR,
    ] as unknown as LineGradient;
  }

  const fadeStart = Math.min(stop + 0.002, 1);
  const stops: (string | number)[] = [0, REVEAL_COLOR, stop, REVEAL_COLOR];
  if (fadeStart > stop) stops.push(fadeStart, TRANSPARENT);
  if (fadeStart < 1) stops.push(1, TRANSPARENT);

  return ['interpolate', ['linear'], ['line-progress'], ...stops] as unknown as LineGradient;
}

function setRevealProgress(map: maplibregl.Map, progress: number) {
  if (!map.getLayer(REVEAL_LAYER_ID)) return;
  const ramp = gradient(progress);
  map.setPaintProperty(REVEAL_LAYER_ID, 'line-gradient', ramp);
  map.setPaintProperty(REVEAL_GLOW_LAYER_ID, 'line-gradient', ramp);
}

export default FlyoverMap;
