import maplibregl from 'maplibre-gl';
import { applyCleanAllmovaMapStyle } from './mapStyleSanitizer';
import { initialMapStyle, installTerrain } from './mapStyle';
import type { MapProvider } from './mapProvider';
import type { LngLatEle } from './polyline';
import { drawRouteEndpointBadge } from './routeEndpoints';
import { SHARE_SIZES, type ShareSizeKey } from './shareCard';

const ROUTE_SOURCE_ID = 'share-poster-route';
const CASING_LAYER_ID = 'share-poster-casing';
const CORE_LAYER_ID = 'share-poster-core';
const TERRAIN_SOURCE_ID = 'share-poster-terrain';
const HILLSHADE_LAYER_ID = 'share-poster-hillshade';

/** Tilted camera that makes the map read as a 3D poster. */
const POSTER_PITCH = 48;
const POSTER_MAX_ZOOM = 15.5;
/** Offscreen viewport width; the frame is upscaled into the export canvas. */
const VIEWPORT_WIDTH = 760;
const STYLE_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 3000;

/** Route band (fraction of the frame) left free by the poster typography. */
const ROUTE_BAND: Record<ShareSizeKey, { top: number; bottom: number }> = {
  feed: { top: 0.3, bottom: 0.6 },
  story: { top: 0.22, bottom: 0.65 },
};

export type SharePosterMapInput = {
  coordinates: LngLatEle[];
  size: ShareSizeKey;
  provider: MapProvider;
};

/**
 * Renders the route on a tilted MapLibre view in a hidden container and
 * returns the captured frame, or `null` when the basemap cannot be read
 * (offline, blocked tiles, tainted WebGL buffer). The caller falls back to the
 * flat charcoal poster in that case.
 */
export async function captureSharePosterMap({
  coordinates,
  size,
  provider,
}: SharePosterMapInput): Promise<HTMLCanvasElement | null> {
  if (typeof document === 'undefined' || coordinates.length < 2) return null;

  const { width: cardWidth, height: cardHeight } = SHARE_SIZES[size];
  const width = VIEWPORT_WIDTH;
  const height = Math.round((VIEWPORT_WIDTH * cardHeight) / cardWidth);

  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  container.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    `width:${width}px`,
    `height:${height}px`,
    'opacity:0',
    'pointer-events:none',
    'z-index:-1',
  ].join(';');
  document.body.appendChild(container);

  const centre = routeCentre(coordinates);
  const map = new maplibregl.Map({
    container,
    style: initialMapStyle(provider),
    center: centre,
    zoom: 12,
    pitch: POSTER_PITCH,
    bearing: routeBearing(coordinates),
    maxPitch: 85,
    interactive: false,
    attributionControl: false,
    // The WebGL buffer is cleared after each frame without this flag.
    preserveDrawingBuffer: true,
  });

  let styleReady = false;
  const onStyleLoad = () => {
    styleReady = true;
    applyCleanAllmovaMapStyle(map, { isSatellite: false });
    installTerrain(map, provider, {
      source: TERRAIN_SOURCE_ID,
      hillshade: HILLSHADE_LAYER_ID,
    });
    installRouteLayers(map, coordinates);
    frameRoute(map, coordinates, { width, height }, size);
  };
  map.on('style.load', onStyleLoad);
  // Offline tile failures must stay quiet: the poster falls back to the flat card.
  map.on('error', () => undefined);

  try {
    await waitFor(map, 'load', STYLE_TIMEOUT_MS);
    if (!styleReady || !map.isStyleLoaded()) return null;

    // fitBounds ignores pitch, so the framed route is corrected by measuring
    // the projected geometry a few times.
    frameRoute(map, coordinates, { width, height }, size);
    map.triggerRepaint();
    await waitFor(map, 'idle', IDLE_TIMEOUT_MS);

    const frame = copyCanvas(map);
    if (!frame) return null;
    drawEndpoints(frame, map, coordinates, width);
    return frame;
  } catch {
    return null;
  } finally {
    map.off('style.load', onStyleLoad);
    map.remove();
    container.remove();
  }
}

function installRouteLayers(map: maplibregl.Map, coordinates: LngLatEle[]) {
  if (!map.getSource(ROUTE_SOURCE_ID)) {
    map.addSource(ROUTE_SOURCE_ID, {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: coordinates.map(([lng, lat]) => [lng, lat]),
        },
      },
    });
  }
  if (!map.getLayer(CASING_LAYER_ID)) {
    map.addLayer({
      id: CASING_LAYER_ID,
      type: 'line',
      source: ROUTE_SOURCE_ID,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#0D1112',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 9, 14, 13, 18, 17],
        'line-opacity': 0.95,
      },
    });
  }
  if (!map.getLayer(CORE_LAYER_ID)) {
    map.addLayer({
      id: CORE_LAYER_ID,
      type: 'line',
      source: ROUTE_SOURCE_ID,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#B9F51E',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 8, 18, 11],
      },
    });
  }
}

/**
 * Keeps the whole route inside the band left free by the poster header and
 * the stats/elevation block.
 */
function frameRoute(
  map: maplibregl.Map,
  coordinates: LngLatEle[],
  viewport: { width: number; height: number },
  size: ShareSizeKey,
) {
  const free = ROUTE_BAND[size];
  const band = {
    left: viewport.width * 0.07,
    right: viewport.width * 0.93,
    top: viewport.height * free.top,
    bottom: viewport.height * free.bottom,
  };

  const start: [number, number] = [coordinates[0][0], coordinates[0][1]];
  const bounds = coordinates.reduce(
    (acc, [lng, lat]) => acc.extend([lng, lat]),
    new maplibregl.LngLatBounds(start, start),
  );

  map.fitBounds(bounds, {
    padding: {
      top: band.top,
      bottom: viewport.height - band.bottom,
      left: band.left,
      right: viewport.width - band.right,
    },
    pitch: POSTER_PITCH,
    duration: 0,
    maxZoom: POSTER_MAX_ZOOM,
  });

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

    const scale = Math.min(
      (band.right - band.left) / Math.max(maxX - minX, 1),
      (band.bottom - band.top) / Math.max(maxY - minY, 1),
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
    });
  }
}

function routeCentre(coordinates: LngLatEle[]): [number, number] {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coordinates) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
}

/** Heading from the first fix towards a point further along the track. */
function routeBearing(coordinates: LngLatEle[]): number {
  const start = coordinates[0];
  const probe = coordinates[Math.min(coordinates.length - 1, Math.floor(coordinates.length * 0.25))];
  const deltaLng = ((probe[0] - start[0]) * Math.PI) / 180;
  const lat1 = (start[1] * Math.PI) / 180;
  const lat2 = (probe[1] * Math.PI) / 180;

  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  if (!Number.isFinite(bearing)) return 0;

  return bearing;
}

function drawEndpoints(
  frame: HTMLCanvasElement,
  map: maplibregl.Map,
  coordinates: LngLatEle[],
  width: number,
) {
  const ctx = frame.getContext('2d');
  if (!ctx) return;

  const scale = frame.width / width;
  const radius = 16 * scale;
  const first = map.project([coordinates[0][0], coordinates[0][1]]);
  const last = map.project([
    coordinates[coordinates.length - 1][0],
    coordinates[coordinates.length - 1][1],
  ]);

  drawRouteEndpointBadge(ctx, 'start', first.x * scale, first.y * scale, radius);
  drawRouteEndpointBadge(ctx, 'finish', last.x * scale, last.y * scale, radius * 1.1);
}

/** Copies the WebGL frame into a 2D canvas, or null when the buffer is tainted. */
function copyCanvas(map: maplibregl.Map): HTMLCanvasElement | null {
  const source = map.getCanvas();
  if (source.width === 0 || source.height === 0) return null;

  const snapshot = document.createElement('canvas');
  snapshot.width = source.width;
  snapshot.height = source.height;
  const ctx = snapshot.getContext('2d');
  if (!ctx) return null;

  try {
    ctx.drawImage(source, 0, 0);
    // Tiles served without CORS headers taint the buffer; this throws instead
    // of handing a blank poster to the export.
    snapshot.toDataURL('image/png');
  } catch {
    return null;
  }
  return snapshot;
}

function waitFor(map: maplibregl.Map, event: 'load' | 'idle', timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      map.off(event, finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    map.once(event, finish);
  });
}
