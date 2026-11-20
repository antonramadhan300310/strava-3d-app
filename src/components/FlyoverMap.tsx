'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import { CARD_SIZES, POSTER_ROUTE_BAND } from '@/lib/shareCard';
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

export type FlyoverMapStyle = 'outdoor' | 'satellite';

const STYLE_URLS: Record<FlyoverMapStyle, string> = {
  outdoor: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`,
  satellite: `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_KEY}`,
};
const TERRAIN_URL = `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`;
const TERRAIN_EXAGGERATION = 1.5;

const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1220' } }],
};

const TERRAIN_SOURCE_ID = 'flyover-terrain';
const HILLSHADE_LAYER_ID = 'flyover-hillshade';
const BASE_SOURCE_ID = 'flyover-base';
const REVEAL_SOURCE_ID = 'flyover-reveal';
const BASE_CASING_LAYER_ID = 'flyover-base-casing';
const BASE_LAYER_ID = 'flyover-base-line';
const REVEAL_GLOW_LAYER_ID = 'flyover-reveal-glow';
const REVEAL_LAYER_ID = 'flyover-reveal-line';
const ENDPOINTS_SOURCE_ID = 'flyover-endpoints';
const ENDPOINTS_LAYER_ID = 'flyover-endpoints-layer';
const BASE_COLOR = '#f97316';
const REVEAL_COLOR = '#fde047';

/** Keeps the marker in the lower third so the 3D panorama ahead stays visible. */
const FOLLOW_PADDING = { top: 240, bottom: 60, left: 0, right: 0 };
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };
/** The framed box must keep at least this share of the viewport free. */
const POSTER_USABLE_SHARE = 0.25;
const POSTER_PITCH = 45;
const CAPTURE_IDLE_TIMEOUT_MS = 1500;
const INTRO_DURATION_MS = 1200;

/** Camera rotation smoothing; low enough to glide through corners. */
const BEARING_LERP = 0.14;

type LineGradient = NonNullable<
  Extract<maplibregl.LayerSpecification, { type: 'line' }>['paint']
>['line-gradient'];

export type FlyoverMapHandle = {
  /** Moves the marker, redraws the reveal line and drives the camera. */
  applyFrame: (sample: FlyoverSample, progress: number) => void;
  /**
   * Glides the camera to the route start before playback begins, so pressing
   * Play from 0% does not snap the view.
   */
  flyToStart: () => Promise<void>;
  /**
   * Frames the whole route at poster pitch, draws the full orange line with
   * start/finish markers, captures it, then restores the camera and reveal.
   */
  captureFullRouteFrame: () => Promise<HTMLCanvasElement | null>;
  /** Swaps the base map between Outdoor Terrain and Satellite Hybrid. */
  setMapStyle: (style: FlyoverMapStyle) => void;
};

type Props = {
  path: FlyoverPath;
};

const FlyoverMap = forwardRef<FlyoverMapHandle, Props>(function FlyoverMap({ path }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const bearingRef = useRef<number | null>(null);
  const paddingRef = useRef<PaddingMode>('none');
  /** Last reveal progress, so a poster capture can repaint and restore it. */
  const revealRef = useRef(0);
  const capturingRef = useRef(false);
  const pathRef = useRef(path);

  pathRef.current = path;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const start = pathRef.current.coordinates[0];
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: HAS_KEY ? STYLE_URLS.outdoor : FALLBACK_STYLE,
      center: [start[0], start[1]],
      zoom: FLYOVER_ZOOM,
      pitch: FLYOVER_PITCH,
      bearing: 0,
      // MapLibre clamps pitch to 60 by default, which would flatten the requested 70.
      maxPitch: 85,
      attributionControl: { compact: true },
      // Without this the WebGL buffer is cleared after each frame and the
      // share poster captures an empty/black image on Android WebView.
      preserveDrawingBuffer: true,
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
      setRevealProgress(map, revealRef.current);
    };
    map.on('style.load', onStyleLoad);

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      map.off('style.load', onStyleLoad);
      markerRef.current?.remove();
      markerRef.current = null;
      removeEndpoints(map);
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
      revealRef.current = 0;
      setRevealProgress(map, 0);
    };

    if (map.getSource(BASE_SOURCE_ID)) apply();
    else map.once('style.load', apply);

    paddingRef.current = 'none';
    map.easeTo({
      padding: NO_PADDING,
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
        if (!map || capturingRef.current) return;

        markerRef.current?.setLngLat([sample.lng, sample.lat]);
        revealRef.current = progress;
        setRevealProgress(map, progress);
        // The padding only matters while the camera is chasing the marker.
        syncPadding(map, paddingRef, progress > 0 ? 'follow' : 'none');

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
      flyToStart: () => {
        const map = mapRef.current;
        if (!map) return Promise.resolve();

        const start = pathRef.current.coordinates[0];
        bearingRef.current = null;
        markerRef.current?.setLngLat([start[0], start[1]]);
        revealRef.current = 0;
        setRevealProgress(map, 0);
        syncPadding(map, paddingRef, 'follow');

        return new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            map.off('moveend', finish);
            resolve();
          };
          map.once('moveend', finish);
          window.setTimeout(finish, INTRO_DURATION_MS + 300);
          map.flyTo({
            center: [start[0], start[1]],
            zoom: FLYOVER_ZOOM,
            pitch: FLYOVER_PITCH,
            bearing: 0,
            duration: INTRO_DURATION_MS,
          });
        });
      },
      captureFullRouteFrame: async () => {
        const map = mapRef.current;
        if (!map || capturingRef.current) return null;
        capturingRef.current = true;

        const camera = {
          center: map.getCenter(),
          zoom: map.getZoom(),
          pitch: map.getPitch(),
          bearing: map.getBearing(),
          padding: map.getPadding(),
        };
        const previousProgress = revealRef.current;
        const previousMarker = markerRef.current?.getLngLat() ?? null;

        try {
          markerRef.current?.setLngLat([
            pathRef.current.coordinates[0][0],
            pathRef.current.coordinates[0][1],
          ]);
          // The poster needs the whole line lit, in the same orange as the map.
          setRevealProgress(map, 1, BASE_COLOR);
          showEndpoints(map, pathRef.current);

          frameRouteInBand(
            map,
            pathRef.current.line.geometry.coordinates as [number, number][],
          );
          paddingRef.current = 'none';

          await waitForIdle(map, CAPTURE_IDLE_TIMEOUT_MS);
          return copyCanvas(map);
        } finally {
          removeEndpoints(map);

          setRevealProgress(map, previousProgress);
          if (previousMarker) markerRef.current?.setLngLat(previousMarker);

          map.jumpTo({
            center: camera.center,
            zoom: camera.zoom,
            pitch: camera.pitch,
            bearing: camera.bearing,
            padding: camera.padding,
          });
          paddingRef.current = isSamePadding(camera.padding, FOLLOW_PADDING) ? 'follow' : 'none';
          capturingRef.current = false;
        }
      },
      setMapStyle: (style) => {
        const map = mapRef.current;
        if (!map || !HAS_KEY) return;
        // `diff: false` forces a full reload so the hillshade and route layers
        // are rebuilt from scratch on top of the new base style.
        map.setStyle(STYLE_URLS[style], { diff: false });
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
    // The DEM also feeds a hillshade so ridges stay readable in 3D flyover.
    if (!map.getLayer(HILLSHADE_LAYER_ID)) {
      map.addLayer({
        id: HILLSHADE_LAYER_ID,
        type: 'hillshade',
        source: TERRAIN_SOURCE_ID,
        paint: {
          'hillshade-exaggeration': 0.45,
          'hillshade-shadow-color': '#0f172a',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-accent-color': '#94a3b8',
        },
      });
    }
  } catch {
    // Terrain is an enhancement; the flyover still runs on a flat map.
  }
}

type PaddingMode = 'none' | 'follow';

/** Applies the follow/none padding once, so playback does not thrash the camera. */
function syncPadding(
  map: maplibregl.Map,
  modeRef: { current: PaddingMode },
  mode: 'none' | 'follow',
) {
  if (modeRef.current === mode) return;
  modeRef.current = mode;
  const padding = mode === 'follow' ? FOLLOW_PADDING : NO_PADDING;
  if (isSamePadding(map.getPadding(), padding)) return;
  map.setPadding(padding);
}

type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * `POSTER_ROUTE_BAND` expressed in viewport pixels.
 *
 * The poster draws the frame as a cover image, so a landscape viewport is
 * cropped on both sides. Everything measured in card pixels has to travel back
 * through that same cover transform before it can drive the camera.
 */
function bandRect(map: maplibregl.Map): { band: Rect; width: number; height: number } | null {
  const { width, height } = map.getCanvas().getBoundingClientRect();
  if (width === 0 || height === 0) return null;

  const card = CARD_SIZES.poster;
  const scale = Math.max(card.width / width, card.height / height);
  const offsetX = (card.width - width * scale) / 2;
  const offsetY = (card.height - height * scale) / 2;
  const toViewport = (value: number, offset: number) => (value - offset) / scale;

  return {
    width,
    height,
    band: {
      left: toViewport(POSTER_ROUTE_BAND.left, offsetX),
      top: toViewport(POSTER_ROUTE_BAND.top, offsetY),
      right: toViewport(POSTER_ROUTE_BAND.right, offsetX),
      bottom: toViewport(POSTER_ROUTE_BAND.bottom, offsetY),
    },
  };
}

/**
 * `fitBounds` ignores pitch, and a pitched view foreshortens the route, so the
 * fitted result only fills part of the band. Measuring the projected route and
 * correcting zoom/centre a few times converges on the largest fit.
 */
function frameRouteInBand(map: maplibregl.Map, coordinates: [number, number][]) {
  map.setPadding(NO_PADDING);

  const framed = bandRect(map);
  const bounds = coordinates.reduce(
    (acc, [lng, lat]) => acc.extend([lng, lat]),
    new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
  );
  // `fitBounds` adds the map's current padding on top of this option, so the
  // follow padding has to be cleared first or the usable box collapses.
  map.fitBounds(bounds, {
    padding: framed
      ? {
          top: Math.max(framed.band.top, 0),
          bottom: Math.max(framed.height - framed.band.bottom, 0),
          left: Math.max(framed.band.left, 0),
          right: Math.max(framed.width - framed.band.right, 0),
        }
      : NO_PADDING,
    pitch: POSTER_PITCH,
    bearing: 0,
    duration: 0,
    maxZoom: FLYOVER_ZOOM,
  });

  if (!framed) return;
  const { band } = framed;

  for (let pass = 0; pass < 4; pass += 1) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [lng, lat] of coordinates) {
      const point = map.project([lng, lat]);
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

    const targetWidth = Math.max(band.right - band.left, 1);
    const targetHeight = Math.max(band.bottom - band.top, 1);
    const scale = Math.min(
      targetWidth / Math.max(maxX - minX, 1),
      targetHeight / Math.max(maxY - minY, 1),
    );
    const dx = (minX + maxX) / 2 - (band.left + band.right) / 2;
    const dy = (minY + maxY) / 2 - (band.top + band.bottom) / 2;
    if (Math.abs(scale - 1) < 0.02 && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;

    const zoom = Math.min(map.getZoom() + Math.log2(scale), FLYOVER_ZOOM);
    const centre = map.project(map.getCenter());
    map.jumpTo({
      center: map.unproject([centre.x + dx, centre.y + dy]),
      zoom,
      pitch: POSTER_PITCH,
      bearing: 0,
    });
  }
}

function isSamePadding(
  a: { top: number; bottom: number; left: number; right: number },
  b: { top: number; bottom: number; left: number; right: number },
): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;
}

/** Copies the WebGL frame into a detached 2D canvas, or null if unreadable. */
function copyCanvas(map: maplibregl.Map | null): HTMLCanvasElement | null {
  if (!map) return null;

  const source = map.getCanvas();
  if (source.width === 0 || source.height === 0) return null;

  const snapshot = document.createElement('canvas');
  snapshot.width = source.width;
  snapshot.height = source.height;
  const context = snapshot.getContext('2d');
  if (!context) return null;

  try {
    context.drawImage(source, 0, 0);
    // Tiles served without CORS headers taint the buffer; reading it back
    // throws here so the poster can fall back to the drawn route.
    snapshot.toDataURL('image/png');
  } catch {
    return null;
  }
  return snapshot;
}

/** Resolves on the next `idle`, or after `timeoutMs` if tiles never settle. */
function waitForIdle(map: maplibregl.Map, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      map.off('idle', finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    map.once('idle', finish);
  });
}

/**
 * Draws start/finish dots as map layers, not DOM markers: only WebGL content
 * lands in the captured canvas, so HTML markers would be missing from the poster.
 */
function showEndpoints(map: maplibregl.Map, path: FlyoverPath) {
  removeEndpoints(map);

  const first = path.coordinates[0];
  const last = path.coordinates[path.coordinates.length - 1];

  map.addSource(ENDPOINTS_SOURCE_ID, {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { role: 'start' },
          geometry: { type: 'Point', coordinates: [first[0], first[1]] },
        },
        {
          type: 'Feature',
          properties: { role: 'finish' },
          geometry: { type: 'Point', coordinates: [last[0], last[1]] },
        },
      ],
    },
  });

  map.addLayer({
    id: ENDPOINTS_LAYER_ID,
    type: 'circle',
    source: ENDPOINTS_SOURCE_ID,
    paint: {
      'circle-radius': 11,
      'circle-color': [
        'match',
        ['get', 'role'],
        'start',
        '#ffffff',
        BASE_COLOR,
      ],
      'circle-stroke-width': 4,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-opacity': 0.95,
    },
  });
}

function removeEndpoints(map: maplibregl.Map) {
  try {
    if (map.getLayer(ENDPOINTS_LAYER_ID)) map.removeLayer(ENDPOINTS_LAYER_ID);
    if (map.getSource(ENDPOINTS_SOURCE_ID)) map.removeSource(ENDPOINTS_SOURCE_ID);
  } catch {
    // A style swap may already have dropped them.
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
function gradient(progress: number, color = REVEAL_COLOR): LineGradient {
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
      color,
      1,
      color,
    ] as unknown as LineGradient;
  }

  const fadeStart = Math.min(stop + 0.002, 1);
  const stops: (string | number)[] = [0, color, stop, color];
  if (fadeStart > stop) stops.push(fadeStart, TRANSPARENT);
  if (fadeStart < 1) stops.push(1, TRANSPARENT);

  return ['interpolate', ['linear'], ['line-progress'], ...stops] as unknown as LineGradient;
}

function setRevealProgress(map: maplibregl.Map, progress: number, color = REVEAL_COLOR) {
  if (!map.getLayer(REVEAL_LAYER_ID)) return;
  const ramp = gradient(progress, color);
  map.setPaintProperty(REVEAL_LAYER_ID, 'line-gradient', ramp);
  map.setPaintProperty(REVEAL_GLOW_LAYER_ID, 'line-gradient', ramp);
}

export default FlyoverMap;
