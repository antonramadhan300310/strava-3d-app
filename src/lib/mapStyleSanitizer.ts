import type { Map as MapLibreMap, LayerSpecification } from 'maplibre-gl';
import type { ActivityType } from './valhalla';

type LineLayer = Extract<LayerSpecification, { type: 'line' }>;
type LineWidth = NonNullable<NonNullable<LineLayer['paint']>['line-width']>;
type PaintKey = Parameters<MapLibreMap['setPaintProperty']>[1];
type LayoutKey = Parameters<MapLibreMap['setLayoutProperty']>[1];

export type CleanMapStyleOptions = {
  isSatellite: boolean;
  /** Enables the topo treatment: amber trails, peak labels and hillshade. */
  sportMode?: ActivityType;
};

/** Neutral road palette used on the standard (non-satellite) basemap. */
const ROAD_CASING = '#CBD5E1';
const ROAD_MAJOR = '#FFFFFF';
const ROAD_LOCAL = '#F1F5F9';

/** Hike overlay: warm amber tracks stay visible over the pale road network. */
const HIKE_TRAIL = '#D97706';
const HIKE_TRAIL_WIDTH = 2.6;
const HIKE_TRAIL_DASH = [2.5, 1.5];
const HIKE_HILLSHADE_EXAGGERATION = 0.6;

/** Satellite keeps the imagery readable, so roads become thin translucent traces. */
const SATELLITE_CORE = 'rgba(255, 255, 255, 0.28)';
const SATELLITE_CASING = 'rgba(13, 17, 18, 0.35)';

const ROAD_TOKENS = [
  'road',
  'highway',
  'transportation',
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'street',
  'bridge',
  'tunnel',
];

const MAJOR_ROAD_TOKENS = ['motorway', 'trunk', 'primary', 'secondary'];

const HIKE_PATH_TOKENS = ['path', 'footway', 'bridleway', 'steps', 'trail', 'track', 'hiking'];

/** Natural features the hiker needs: peaks, passes, camps, springs, shelters. */
const NATURAL_FEATURE_TOKENS = [
  'peak',
  'volcano',
  'saddle',
  'mountain_pass',
  'camp_site',
  'camping',
  'spring',
  'natural',
  'viewpoint',
  'alpine_hut',
  'wilderness_hut',
  'shelter',
  'waterfall',
  'glacier',
  'ridge',
  'mountain',
];

/** Layers drawn by the app on top of the base style; never restyle them. */
const APP_LAYER_PREFIXES = [
  'route-line',
  'route-casing',
  'personal-heatmap-',
  'flyover-',
  'live-track',
  'satellite-',
];

type LayerSnapshot = {
  paint: Record<string, unknown>;
  layout: Record<string, unknown>;
};

/**
 * Original values keyed by layer id, captured before the first override so the
 * map can return to the neutral ALLMOVA road style when Hike is switched off.
 */
const layerSnapshots = new WeakMap<MapLibreMap, Map<string, LayerSnapshot>>();

function snapshotOf(map: MapLibreMap): Map<string, LayerSnapshot> {
  let snapshots = layerSnapshots.get(map);
  if (!snapshots) {
    snapshots = new Map();
    layerSnapshots.set(map, snapshots);
  }
  return snapshots;
}

function snapshotLayer(
  map: MapLibreMap,
  layerId: string,
  paintKeys: string[],
  layoutKeys: string[],
): void {
  const snapshots = snapshotOf(map);
  let snapshot = snapshots.get(layerId);
  if (!snapshot) {
    snapshot = { paint: {}, layout: {} };
    snapshots.set(layerId, snapshot);
  }

  for (const key of paintKeys) {
    if (key in snapshot.paint) continue;
    snapshot.paint[key] = map.getPaintProperty(layerId, key as PaintKey);
  }
  for (const key of layoutKeys) {
    if (key in snapshot.layout) continue;
    snapshot.layout[key] = map.getLayoutProperty(layerId, key as LayoutKey);
  }
}

function setPaint(map: MapLibreMap, layerId: string, key: string, value: unknown): void {
  snapshotLayer(map, layerId, [key], []);
  map.setPaintProperty(layerId, key as PaintKey, value as never);
}

function setLayout(map: MapLibreMap, layerId: string, key: string, value: unknown): void {
  snapshotLayer(map, layerId, [], [key]);
  map.setLayoutProperty(layerId, key as LayoutKey, value as never);
}

function restoreSnapshots(map: MapLibreMap): void {
  const snapshots = layerSnapshots.get(map);
  if (!snapshots) return;

  for (const [layerId, snapshot] of Array.from(snapshots.entries())) {
    for (const [key, value] of Array.from(Object.entries(snapshot.paint))) {
      if (value === undefined || value === null) continue;
      try {
        map.setPaintProperty(layerId, key as PaintKey, value as never);
      } catch {
        // The layer disappeared while the style was being swapped.
      }
    }
    for (const [key, value] of Array.from(Object.entries(snapshot.layout))) {
      if (value === undefined || value === null) continue;
      try {
        map.setLayoutProperty(layerId, key as LayoutKey, value as never);
      } catch {
        // The layer disappeared while the style was being swapped.
      }
    }
  }

  layerSnapshots.delete(map);
}

/** Drops the saved originals when `setStyle` has already rebuilt the layers. */
export function resetCleanAllmovaMapStyleSnapshots(map: MapLibreMap): void {
  layerSnapshots.delete(map);
}

function isAppLayer(id: string): boolean {
  const lower = id.toLowerCase();
  return APP_LAYER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function layerHaystack(layer: LayerSpecification): string {
  const sourceLayer = 'source-layer' in layer ? layer['source-layer'] ?? '' : '';
  return `${layer.id} ${sourceLayer}`.toLowerCase();
}

function isRoadLayer(haystack: string): boolean {
  return ROAD_TOKENS.some((token) => haystack.includes(token));
}

function isHikePathLayer(haystack: string): boolean {
  return HIKE_PATH_TOKENS.some((token) => haystack.includes(token));
}

function isNaturalFeature(haystack: string): boolean {
  return NATURAL_FEATURE_TOKENS.some((token) => haystack.includes(token));
}

function isRoadCasing(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes('casing') || lower.includes('outline') || lower.includes('edge');
}

function isCommercialPoi(layer: LayerSpecification): boolean {
  if (layer.type !== 'symbol') return false;
  const haystack = layerHaystack(layer);
  return haystack.includes('poi') || haystack.includes('housenumber');
}

function scaleStop(value: unknown, factor: number): unknown {
  return typeof value === 'number' ? value * factor : value;
}

/**
 * Scales line width while keeping a zoom expression valid at the top level.
 * Wrapping `['interpolate', ...]` in `['*', ...]` makes MapLibre reject the
 * whole paint property, so each output stop is scaled instead.
 */
function scaleLineWidth(width: LineWidth, factor: number): LineWidth {
  if (typeof width === 'number') return width * factor;
  if (!Array.isArray(width)) return width;

  const expression = width as unknown[];
  const head = expression[0];

  if (head === 'interpolate' && expression.length >= 4) {
    return [
      expression[0],
      expression[1],
      expression[2],
      ...expression.slice(3).map((value, index) => (index % 2 === 1 ? scaleStop(value, factor) : value)),
    ] as unknown as LineWidth;
  }

  if (head === 'step' && expression.length >= 4) {
    return [
      expression[0],
      expression[1],
      scaleStop(expression[2], factor),
      ...expression.slice(3).map((value, index) => (index % 2 === 1 ? scaleStop(value, factor) : value)),
    ] as unknown as LineWidth;
  }

  return width;
}

function styleHikeTrail(map: MapLibreMap, layerId: string): void {
  setPaint(map, layerId, 'line-color', HIKE_TRAIL);
  setPaint(map, layerId, 'line-opacity', 1);
  setPaint(map, layerId, 'line-width', HIKE_TRAIL_WIDTH);
  setPaint(map, layerId, 'line-dasharray', HIKE_TRAIL_DASH);
}

function styleHikeRelief(map: MapLibreMap, layers: LayerSpecification[]): void {
  for (const layer of layers) {
    if (isAppLayer(layer.id)) continue;
    const haystack = layerHaystack(layer);

    if (layer.type === 'hillshade') {
      setPaint(map, layer.id, 'hillshade-exaggeration', HIKE_HILLSHADE_EXAGGERATION);
      continue;
    }

    // MapTiler Outdoor / OpenFreeMap ship optional contour lines; show them so
    // ridges and valleys read as terrain instead of a flat road map.
    if (haystack.includes('contour') && (layer.type === 'line' || layer.type === 'symbol')) {
      setLayout(map, layer.id, 'visibility', 'visible');
      if (layer.type === 'line') {
        setPaint(map, layer.id, 'line-color', HIKE_TRAIL);
        setPaint(map, layer.id, 'line-opacity', 0.35);
      }
    }
  }
}

/**
 * Neutralises the basemap so the Active Lime route is the loudest thing on
 * screen. In Hike mode the same pass highlights footpaths/steps in amber,
 * keeps peak and camp labels visible and turns up the hillshade.
 *
 * Called from every `style.load` because `setStyle` rebuilds the base layers.
 */
export function applyCleanAllmovaMapStyle(
  map: MapLibreMap,
  { isSatellite, sportMode = 'cycling' }: CleanMapStyleOptions,
): void {
  let layers: LayerSpecification[] = [];
  try {
    layers = map.getStyle()?.layers ?? [];
  } catch {
    return;
  }

  // Undo the previous sport's overrides before applying this one.
  restoreSnapshots(map);

  const hike = sportMode === 'hike' && !isSatellite;

  for (const layer of layers) {
    if (isAppLayer(layer.id)) continue;

    const haystack = layerHaystack(layer);

    if (isCommercialPoi(layer)) {
      const keepForHike = hike && isNaturalFeature(haystack);
      try {
        setLayout(map, layer.id, 'visibility', keepForHike ? 'visible' : 'none');
      } catch {
        // The layer may disappear during a style swap.
      }
      continue;
    }

    if (layer.type === 'line' && hike && isHikePathLayer(haystack)) {
      try {
        styleHikeTrail(map, layer.id);
      } catch {
        // A single unsupported paint property must not abort the whole pass.
      }
      continue;
    }

    if (!isRoadLayer(haystack)) continue;

    const casing = isRoadCasing(layer.id);
    const major = MAJOR_ROAD_TOKENS.some((token) => haystack.includes(token));

    try {
      if (layer.type === 'line') {
        const width = map.getPaintProperty(layer.id, 'line-width') as LineWidth | null | undefined;
        const hasWidth = width !== undefined && width !== null;

        if (isSatellite) {
          setPaint(map, layer.id, 'line-color', casing ? SATELLITE_CASING : SATELLITE_CORE);
          setPaint(map, layer.id, 'line-opacity', 1);
          if (hasWidth) {
            setPaint(map, layer.id, 'line-width', scaleLineWidth(width, 0.45));
          }
        } else if (casing) {
          setPaint(map, layer.id, 'line-color', ROAD_CASING);
          setPaint(map, layer.id, 'line-opacity', 0.65);
        } else {
          setPaint(map, layer.id, 'line-color', major ? ROAD_MAJOR : ROAD_LOCAL);
          setPaint(map, layer.id, 'line-opacity', 1);
          if (major && hasWidth) {
            setPaint(map, layer.id, 'line-width', scaleLineWidth(width, 0.75));
          }
        }
      } else if (layer.type === 'fill' && !isSatellite) {
        setPaint(map, layer.id, 'fill-color', major ? ROAD_MAJOR : ROAD_LOCAL);
      }
    } catch {
      // A single unsupported paint property must not abort the whole pass.
    }
  }

  if (hike) styleHikeRelief(map, layers);
}
