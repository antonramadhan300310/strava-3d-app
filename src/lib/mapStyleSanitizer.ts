import type { Map as MapLibreMap, LayerSpecification } from 'maplibre-gl';

type LineLayer = Extract<LayerSpecification, { type: 'line' }>;
type LineWidth = NonNullable<NonNullable<LineLayer['paint']>['line-width']>;

export type CleanMapStyleOptions = {
  isSatellite: boolean;
};

/** Neutral road palette used on the standard (non-satellite) basemap. */
const ROAD_CASING = '#CBD5E1';
const ROAD_MAJOR = '#FFFFFF';
const ROAD_LOCAL = '#F1F5F9';

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

/** Layers drawn by the app on top of the base style; never restyle them. */
const APP_LAYER_PREFIXES = [
  'route-line',
  'route-casing',
  'personal-heatmap-',
  'flyover-',
  'live-track',
  'map-hillshade',
  'satellite-',
];

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

function isRoadCasing(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes('casing') || lower.includes('outline') || lower.includes('edge');
}

function isCommercialPoi(layer: LayerSpecification): boolean {
  if (layer.type !== 'symbol') return false;
  const haystack = layerHaystack(layer);
  return haystack.includes('poi') || haystack.includes('housenumber');
}

/** Scales a literal width or wraps a zoom/data expression in a multiplier. */
function scaleLineWidth(width: LineWidth, factor: number): LineWidth {
  if (typeof width === 'number') return width * factor;
  return ['*', width as unknown as number, factor] as unknown as LineWidth;
}

/**
 * Neutralises the basemap so the Active Lime route is the loudest thing on
 * screen: yellow arterial roads become white/grey, POI clutter is hidden and
 * satellite imagery keeps its texture instead of being covered by thick
 * vector roads.
 *
 * Called from every `style.load` because `setStyle` rebuilds the base layers.
 */
export function applyCleanAllmovaMapStyle(
  map: MapLibreMap,
  { isSatellite }: CleanMapStyleOptions,
): void {
  let layers: LayerSpecification[] = [];
  try {
    layers = map.getStyle()?.layers ?? [];
  } catch {
    return;
  }

  for (const layer of layers) {
    if (isAppLayer(layer.id)) continue;

    if (isCommercialPoi(layer)) {
      try {
        map.setLayoutProperty(layer.id, 'visibility', 'none');
      } catch {
        // The layer may disappear during a style swap.
      }
      continue;
    }

    const haystack = layerHaystack(layer);
    if (!isRoadLayer(haystack)) continue;

    const casing = isRoadCasing(layer.id);
    const major = MAJOR_ROAD_TOKENS.some((token) => haystack.includes(token));

    try {
      if (layer.type === 'line') {
        const width = map.getPaintProperty(layer.id, 'line-width') as LineWidth | null | undefined;
        const hasWidth = width !== undefined && width !== null;

        if (isSatellite) {
          map.setPaintProperty(layer.id, 'line-color', casing ? SATELLITE_CASING : SATELLITE_CORE);
          map.setPaintProperty(layer.id, 'line-opacity', 1);
          if (hasWidth) {
            map.setPaintProperty(layer.id, 'line-width', scaleLineWidth(width, 0.45));
          }
        } else if (casing) {
          map.setPaintProperty(layer.id, 'line-color', ROAD_CASING);
          map.setPaintProperty(layer.id, 'line-opacity', 0.65);
        } else {
          map.setPaintProperty(layer.id, 'line-color', major ? ROAD_MAJOR : ROAD_LOCAL);
          map.setPaintProperty(layer.id, 'line-opacity', 1);
          if (major && hasWidth) {
            map.setPaintProperty(layer.id, 'line-width', scaleLineWidth(width, 0.75));
          }
        }
      } else if (layer.type === 'fill' && !isSatellite) {
        map.setPaintProperty(layer.id, 'fill-color', major ? ROAD_MAJOR : ROAD_LOCAL);
      }
    } catch {
      // A single unsupported paint property must not abort the whole pass.
    }
  }
}
