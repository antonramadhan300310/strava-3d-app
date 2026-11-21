import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import type { MapProvider } from './mapProvider';

export type BaseMapStyle = 'outdoor' | 'satellite';

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? '';
export const hasMaptilerKey = MAPTILER_KEY.length > 0;

const MAPTILER_STYLE_URLS: Record<BaseMapStyle, string> = {
  outdoor: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`,
  satellite: `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_KEY}`,
};
const MAPTILER_TERRAIN_URL = `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`;

/** Free vector basemap used by the Open Data stack for Outdoor. */
const OPEN_DATA_OUTDOOR_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const ESRI_WORLD_IMAGERY_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTRIBUTION = 'Esri, Maxar, Earthstar Geographics';
const AWS_TERRAIN_TILES =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export const TERRAIN_EXAGGERATION = 1.5;

export const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1220' } }],
};

/**
 * Style handed to `new maplibregl.Map()` / `setStyle()`.
 *
 * The Open Data satellite hybrid is assembled from a fetched style, so it is
 * resolved asynchronously by `resolveMapStyle`; the initial style only ever
 * needs to be the synchronous Outdoor variant.
 */
export function initialMapStyle(
  provider: MapProvider,
  base: BaseMapStyle = 'outdoor',
): string | StyleSpecification {
  if (provider === 'maptiler') {
    return hasMaptilerKey ? MAPTILER_STYLE_URLS[base] : FALLBACK_STYLE;
  }
  // Satellite is fetched lazily by `resolveMapStyle`; start on Outdoor.
  return OPEN_DATA_OUTDOOR_STYLE;
}

export async function resolveMapStyle(
  provider: MapProvider,
  base: BaseMapStyle,
): Promise<string | StyleSpecification> {
  if (provider === 'maptiler') {
    return hasMaptilerKey ? MAPTILER_STYLE_URLS[base] : FALLBACK_STYLE;
  }
  if (base === 'outdoor') return OPEN_DATA_OUTDOOR_STYLE;
  return buildOpenDataHybridStyle();
}

type LibertyStyle = {
  glyphs?: StyleSpecification['glyphs'];
  sprite?: StyleSpecification['sprite'];
  sources?: StyleSpecification['sources'];
  layers?: StyleSpecification['layers'];
};

let hybridStyle: StyleSpecification | null = null;
let hybridRequest: Promise<StyleSpecification | null> | null = null;

/** Esri imagery with OpenFreeMap roads/labels stacked transparently on top. */
async function buildOpenDataHybridStyle(): Promise<StyleSpecification> {
  if (hybridStyle) return hybridStyle;
  if (!hybridRequest) hybridRequest = fetchOpenDataHybridStyle();
  const style = await hybridRequest;
  if (!style) return FALLBACK_STYLE;
  hybridStyle = style;
  return style;
}

async function fetchOpenDataHybridStyle(): Promise<StyleSpecification | null> {
  try {
    const response = await fetch(OPEN_DATA_OUTDOOR_STYLE);
    if (!response.ok) return null;
    const liberty = (await response.json()) as LibertyStyle;
    const sources = liberty.sources ?? {};

    // Only roads (line) and place/road labels (symbol) are kept, so the
    // satellite photo stays visible underneath instead of being covered by
    // the vector style's landuse/water fills.
    const overlayLayers = (liberty.layers ?? []).filter((layer) => {
      if (layer.type !== 'line' && layer.type !== 'symbol') return false;
      if (!('source' in layer) || typeof layer.source !== 'string') return true;
      return Boolean(sources[layer.source]);
    });

    return {
      version: 8,
      glyphs: liberty.glyphs,
      sprite: liberty.sprite,
      sources: {
        'esri-satellite': {
          type: 'raster',
          tiles: [ESRI_WORLD_IMAGERY_TILES],
          tileSize: 256,
          maxzoom: 18,
          attribution: ESRI_ATTRIBUTION,
        },
        ...sources,
      },
      layers: [
        {
          id: 'satellite-background',
          type: 'background',
          paint: { 'background-color': '#0b1220' },
        },
        {
          id: 'satellite-imagery',
          type: 'raster',
          source: 'esri-satellite',
          paint: { 'raster-opacity': 1 },
        },
        ...overlayLayers,
      ],
    };
  } catch {
    return null;
  }
}

/**
 * Installs the DEM, 3D terrain and a soft hillshade on top of whichever base
 * style is loaded. Called from `style.load`, because `setStyle` drops them.
 */
export function installTerrain(
  map: MapLibreMap,
  provider: MapProvider,
  ids: { source: string; hillshade: string },
): void {
  try {
    if (!map.getSource(ids.source)) {
      if (provider === 'maptiler') {
        if (!hasMaptilerKey) return;
        map.addSource(ids.source, {
          type: 'raster-dem',
          url: MAPTILER_TERRAIN_URL,
          tileSize: 256,
        });
      } else {
        map.addSource(ids.source, {
          type: 'raster-dem',
          encoding: 'terrarium',
          tiles: [AWS_TERRAIN_TILES],
          tileSize: 256,
          maxzoom: 15,
        });
      }
    }

    map.setTerrain({ source: ids.source, exaggeration: TERRAIN_EXAGGERATION });

    if (!map.getLayer(ids.hillshade)) {
      const firstSymbol = map.getStyle()?.layers?.find((layer) => layer.type === 'symbol');
      map.addLayer(
        {
          id: ids.hillshade,
          type: 'hillshade',
          source: ids.source,
          paint: {
            'hillshade-exaggeration': 0.45,
            'hillshade-shadow-color': '#0f172a',
            'hillshade-highlight-color': '#ffffff',
            'hillshade-accent-color': '#94a3b8',
          },
        },
        firstSymbol?.id,
      );
    }
  } catch {
    // Terrain is a progressive enhancement: the map stays usable without it.
  }
}
