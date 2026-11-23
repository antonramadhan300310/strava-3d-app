'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { CARD_SIZES, POSTER_ROUTE_BAND } from '@/lib/shareCard';
import { applySky } from '@/lib/mapSky';
import { createActivityMarkerElement } from '@/lib/activityMarker';
import type { ActivityType } from '@/lib/valhalla';
import type { MapProvider } from '@/lib/mapProvider';
import {
  initialMapStyle,
  installTerrain,
  resolveMapStyle,
  type BaseMapStyle,
} from '@/lib/mapStyle';
import { applyCleanAllmovaMapStyle } from '@/lib/mapStyleSanitizer';
import { drawRouteEndpointBadge, updateRouteEndpointMarkers } from '@/lib/routeEndpoints';
import {
  FLYOVER_PITCH,
  FLYOVER_ZOOM,
  bearingAt,
  sampleAt,
  type FlyoverPath,
  type FlyoverSample,
} from '@/lib/flyover';
import {
  EXPORT_FRAME_TIMEOUT_MS,
  type FlyoverFrameCapture,
} from '@/lib/flyoverExporter';
import 'maplibre-gl/dist/maplibre-gl.css';

export type FlyoverMapStyle = BaseMapStyle;

const TERRAIN_SOURCE_ID = 'flyover-terrain';
const HILLSHADE_LAYER_ID = 'flyover-hillshade';
const BASE_SOURCE_ID = 'flyover-base';
const REVEAL_SOURCE_ID = 'flyover-reveal';
const BASE_CASING_LAYER_ID = 'flyover-base-casing';
const BASE_LAYER_ID = 'flyover-base-line';
const REVEAL_GLOW_LAYER_ID = 'flyover-reveal-glow';
const REVEAL_LAYER_ID = 'flyover-reveal-line';
const BASE_COLOR = '#B9F51E';
const REVEAL_COLOR = '#B9F51E';

/** Keeps the marker in the lower third so the 3D panorama ahead stays visible. */
const FOLLOW_PADDING = { top: 200, bottom: 40, left: 0, right: 0 };
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };
/** The framed box must keep at least this share of the viewport free. */
const POSTER_USABLE_SHARE = 0.25;
const POSTER_PITCH = 45;
/** Poster framing may zoom closer than the flyover camera so short routes fill the card. */
const POSTER_MAX_ZOOM = 15.5;
const CAPTURE_IDLE_TIMEOUT_MS = 1500;
const INTRO_DURATION_MS = 2400;
const INTRO_FALLBACK_MS = 2500;

/**
 * Camera damping. Bearing eases towards the long look-ahead heading and is
 * rate-limited so a hairpin cannot whip the horizon; the centre trails the
 * marker like a drone gimbal.
 */
const BEARING_SMOOTHING = 1.5;
const MAX_TURN_DEG_PER_SEC = 18;
const CENTER_SMOOTHING = 4;
/** Longest frame delta honoured, so a backgrounded tab does not jump the camera. */
const MAX_FRAME_SECONDS = 0.25;
/** A scrubber jump larger than this snaps the camera instead of gliding. */
const SEEK_PROGRESS_THRESHOLD = 0.02;

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
   * Frames the whole route at poster pitch, draws the full Active Lime line with
   * start/finish markers, captures it, then restores the camera and reveal.
   */
  captureFullRouteFrame: () => Promise<HTMLCanvasElement | null>;
  /**
   * Snaps marker, reveal and camera to `progress`, waits for the map to paint
   * and returns the frame plus the marker position for the MP4 exporter.
   */
  captureProgressFrame: (progress: number) => Promise<FlyoverFrameCapture | null>;
  /** Swaps the base map between Outdoor Terrain and Satellite Hybrid. */
  setMapStyle: (style: FlyoverMapStyle) => void;
};

type Props = {
  path: FlyoverPath;
  provider: MapProvider;
  activityType: ActivityType;
};

const FlyoverMap = forwardRef<FlyoverMapHandle, Props>(function FlyoverMap(
  { path, provider, activityType },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const providerRef = useRef(provider);
  const activityTypeRef = useRef(activityType);
  const baseStyleRef = useRef<FlyoverMapStyle>('outdoor');
  const appliedStyleRef = useRef(`${provider}:outdoor`);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const endpointMarkersRef = useRef<maplibregl.Marker[]>([]);
  const bearingRef = useRef<number | null>(null);
  /** Spring-followed camera centre, so the view trails the marker instead of locking to it. */
  const cameraCenterRef = useRef<[number, number] | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const lastProgressRef = useRef<number | null>(null);
  const paddingRef = useRef<PaddingMode>('none');
  /** Last reveal progress, so a poster capture can repaint and restore it. */
  const revealRef = useRef(0);
  const capturingRef = useRef(false);
  /** Reused export snapshot, so a 1 800-frame render allocates one canvas. */
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pathRef = useRef(path);

  pathRef.current = path;
  providerRef.current = provider;
  activityTypeRef.current = activityType;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const start = pathRef.current.coordinates[0];
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: initialMapStyle(providerRef.current),
      center: [start[0], start[1]],
      zoom: FLYOVER_ZOOM,
      pitch: FLYOVER_PITCH,
      bearing: 0,
      // Headroom above MapLibre's default 60° pitch clamp for steeper views.
      maxPitch: 85,
      attributionControl: { compact: true },
      // Without this the WebGL buffer is cleared after each frame and the
      // share poster captures an empty/black image on Android WebView.
      preserveDrawingBuffer: true,
    });
    mapRef.current = map;
    map.touchZoomRotate.enableRotation();

    markerRef.current = new maplibregl.Marker({
      element: createActivityMarkerElement(activityTypeRef.current, { pulse: false }),
      anchor: 'center',
      rotationAlignment: 'viewport',
      pitchAlignment: 'viewport',
    })
      .setLngLat([start[0], start[1]])
      .addTo(map);

    // setStyle() (or a late style load) drops custom sources, so they are rebuilt.
    const onStyleLoad = () => {
      applySky(map);
      applyCleanAllmovaMapStyle(map, {
        isSatellite: baseStyleRef.current === 'satellite',
      });
      installTerrain(map, providerRef.current, {
        source: TERRAIN_SOURCE_ID,
        hillshade: HILLSHADE_LAYER_ID,
      });
      installLayers(map, pathRef.current);
      endpointMarkersRef.current = updateRouteEndpointMarkers(
        map,
        pathRef.current.coordinates,
        endpointMarkersRef.current,
      );
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
      for (const marker of endpointMarkersRef.current) marker.remove();
      endpointMarkersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // A different activity swaps the geometry under the already-built layers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    endpointMarkersRef.current = updateRouteEndpointMarkers(
      map,
      path.coordinates,
      endpointMarkersRef.current,
    );

    const start = path.coordinates[0];
    bearingRef.current = null;
    cameraCenterRef.current = null;
    lastFrameRef.current = null;
    lastProgressRef.current = null;
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

  // Swapping sport replaces the moving marker with the matching badge icon.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !markerRef.current) return;

    const position = markerRef.current.getLngLat();
    markerRef.current.remove();
    markerRef.current = new maplibregl.Marker({
      element: createActivityMarkerElement(activityType, { pulse: false }),
      anchor: 'center',
      rotationAlignment: 'viewport',
      pitchAlignment: 'viewport',
    })
      .setLngLat(position)
      .addTo(map);
  }, [activityType]);

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

        const now = performance.now();
        const dt =
          lastFrameRef.current === null
            ? 0
            : Math.min((now - lastFrameRef.current) / 1000, MAX_FRAME_SECONDS);
        lastFrameRef.current = now;

        // Dragging the scrubber teleports the marker; snap rather than glide
        // the camera across the whole route in a single frame.
        const seeked =
          lastProgressRef.current !== null &&
          Math.abs(progress - lastProgressRef.current) > SEEK_PROGRESS_THRESHOLD;
        lastProgressRef.current = progress;

        const marker: [number, number] = [sample.lng, sample.lat];
        let bearing = bearingRef.current;
        let center = cameraCenterRef.current;

        if (bearing === null || center === null || seeked) {
          bearing = sample.bearing;
          center = marker;
        } else {
          const delta = shortestAngleDelta(bearing, sample.bearing);
          const eased = delta * (1 - Math.exp(-BEARING_SMOOTHING * dt));
          const maxStep = MAX_TURN_DEG_PER_SEC * dt;
          bearing = (bearing + clamp(eased, -maxStep, maxStep) + 360) % 360;

          const alpha = 1 - Math.exp(-CENTER_SMOOTHING * dt);
          center = [
            center[0] + (marker[0] - center[0]) * alpha,
            center[1] + (marker[1] - center[1]) * alpha,
          ];
        }

        bearingRef.current = bearing;
        cameraCenterRef.current = center;

        map.jumpTo({
          center,
          bearing,
          pitch: FLYOVER_PITCH,
          zoom: FLYOVER_ZOOM,
        });
      },
      flyToStart: () => {
        const map = mapRef.current;
        if (!map) return Promise.resolve();

        const path = pathRef.current;
        const start = path.coordinates[0];
        const startCenter: [number, number] = [start[0], start[1]];
        const initialBearing = bearingAt(path, 0);

        markerRef.current?.setLngLat(startCenter);
        revealRef.current = 0;
        setRevealProgress(map, 0);
        syncPadding(map, paddingRef, 'follow');

        bearingRef.current = initialBearing;
        cameraCenterRef.current = startCenter;
        lastFrameRef.current = null;
        lastProgressRef.current = null;

        // Let the swoop finish (or time out) before playback drives the camera,
        // so tiles and terrain are rendered for the opening frame.
        return new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            map.off('moveend', finish);
            window.clearTimeout(timer);
            resolve();
          };
          const timer = window.setTimeout(finish, INTRO_FALLBACK_MS);
          map.once('moveend', finish);
          map.flyTo({
            center: startCenter,
            zoom: FLYOVER_ZOOM,
            pitch: FLYOVER_PITCH,
            bearing: initialBearing,
            padding: FOLLOW_PADDING,
            duration: INTRO_DURATION_MS,
            essential: true,
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
          // The poster needs the whole line lit, in the same Active Lime as the map.
          setRevealProgress(map, 1, BASE_COLOR);

          frameRouteInBand(
            map,
            pathRef.current.line.geometry.coordinates as [number, number][],
          );
          paddingRef.current = 'none';

          await waitForIdle(map, CAPTURE_IDLE_TIMEOUT_MS);
          const snapshot = copyCanvas(map);
          if (snapshot) drawEndpointsOnCapture(snapshot, map, pathRef.current);
          return snapshot;
        } finally {
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
          bearingRef.current = null;
          cameraCenterRef.current = null;
          lastFrameRef.current = null;
          lastProgressRef.current = null;
          capturingRef.current = false;
        }
      },
      captureProgressFrame: async (progress) => {
        const map = mapRef.current;
        if (!map || capturingRef.current) return null;

        const path = pathRef.current;
        const clamped = clamp(progress, 0, 1);
        const sample = sampleAt(path, clamped * path.totalMeters);
        const marker: [number, number] = [sample.lng, sample.lat];

        markerRef.current?.setLngLat(marker);
        revealRef.current = clamped;
        setRevealProgress(map, clamped);
        syncPadding(map, paddingRef, clamped > 0 ? 'follow' : 'none');

        // The exporter drives progress deterministically, so the camera snaps
        // instead of easing: a slow frame must not shift the next framing.
        bearingRef.current = sample.bearing;
        cameraCenterRef.current = marker;
        lastFrameRef.current = null;
        lastProgressRef.current = clamped;
        map.jumpTo({
          center: marker,
          bearing: sample.bearing,
          pitch: FLYOVER_PITCH,
          zoom: FLYOVER_ZOOM,
        });

        map.triggerRepaint();
        await waitForRender(map, EXPORT_FRAME_TIMEOUT_MS);

        const image = copyCanvas(map, false, captureCanvasRef.current);
        if (!image) return null;
        captureCanvasRef.current = image;

        const point = map.project(marker);
        const { width, height } = map.getCanvas().getBoundingClientRect();
        return {
          image,
          markerX: width > 0 ? clamp(point.x / width, 0, 1) : 0.5,
          markerY: height > 0 ? clamp(point.y / height, 0, 1) : 0.5,
        };
      },
      setMapStyle: (style) => {
        const map = mapRef.current;
        if (!map) return;
        baseStyleRef.current = style;
        appliedStyleRef.current = `${providerRef.current}:${style}`;
        // `diff: false` forces a full reload so the hillshade and route layers
        // are rebuilt from scratch on top of the new base style.
        void resolveMapStyle(providerRef.current, style).then((resolved) => {
          if (mapRef.current !== map) return;
          map.setStyle(resolved, { diff: false });
        });
      },
    }),
    [],
  );

  // A provider swap (from the map badge) must rebuild the current base style.
  useEffect(() => {
    const key = `${provider}:${baseStyleRef.current}`;
    if (appliedStyleRef.current === key) return;
    appliedStyleRef.current = key;

    const map = mapRef.current;
    if (!map) return;

    let cancelled = false;
    void resolveMapStyle(provider, baseStyleRef.current).then((style) => {
      if (cancelled || mapRef.current !== map) return;
      map.setStyle(style, { diff: false });
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // MapLibre's stylesheet forces `position: relative` on this element, so the
  // height has to come from a positioned parent instead of `absolute inset-0`.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
});

type PaddingMode = 'none' | 'follow';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Signed shortest rotation from `from` to `to`, in [-180, 180). */
function shortestAngleDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

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
    maxZoom: POSTER_MAX_ZOOM,
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

    const zoom = Math.min(map.getZoom() + Math.log2(scale), POSTER_MAX_ZOOM);
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
function copyCanvas(
  map: maplibregl.Map | null,
  verifyReadable = true,
  reuse: HTMLCanvasElement | null = null,
): HTMLCanvasElement | null {
  if (!map) return null;

  const source = map.getCanvas();
  if (source.width === 0 || source.height === 0) return null;

  const snapshot = reuse ?? document.createElement('canvas');
  if (snapshot.width !== source.width) snapshot.width = source.width;
  if (snapshot.height !== source.height) snapshot.height = source.height;
  const context = snapshot.getContext('2d');
  if (!context) return null;

  try {
    context.drawImage(source, 0, 0);
    if (!verifyReadable) return snapshot;
    // Tiles served without CORS headers taint the buffer; reading it back
    // throws here so the poster can fall back to the drawn route.
    snapshot.toDataURL('image/png');
  } catch {
    return null;
  }
  return snapshot;
}

/** Resolves on the next `render`, or after `timeoutMs` if tiles never settle. */
function waitForRender(map: maplibregl.Map, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      map.off('render', finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    map.once('render', finish);
  });
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
 * HTML markers never reach the WebGL buffer, so the captured poster gets its
 * start/finish badges painted onto the snapshot at the projected endpoints.
 */
function drawEndpointsOnCapture(
  canvas: HTMLCanvasElement,
  map: maplibregl.Map,
  path: FlyoverPath,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width, height } = map.getCanvas().getBoundingClientRect();
  if (width <= 0 || height <= 0) return;

  const scaleX = canvas.width / width;
  const scaleY = canvas.height / height;
  const radius = 14 * Math.max(scaleX, scaleY);
  const first = path.coordinates[0];
  const last = path.coordinates[path.coordinates.length - 1];

  const start = map.project([first[0], first[1]]);
  drawRouteEndpointBadge(ctx, 'start', start.x * scaleX, start.y * scaleY, radius);

  const finish = map.project([last[0], last[1]]);
  drawRouteEndpointBadge(ctx, 'finish', finish.x * scaleX, finish.y * scaleY, radius);
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
      paint: {
        'line-color': '#0D1112',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7.5, 14, 10, 18, 12.5],
        'line-opacity': 0.94,
      },
    });
  }
  if (!map.getLayer(BASE_LAYER_ID)) {
    map.addLayer({
      id: BASE_LAYER_ID,
      type: 'line',
      source: BASE_SOURCE_ID,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': BASE_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4.8, 14, 6.8, 18, 8.5],
        'line-opacity': 0.4,
      },
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
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 15, 18, 18],
        'line-opacity': 0.22,
        'line-blur': 5,
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
      paint: {
        'line-color': REVEAL_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4.8, 14, 6.8, 18, 8.5],
        'line-opacity': 1,
        'line-gradient': gradient(0),
      },
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
