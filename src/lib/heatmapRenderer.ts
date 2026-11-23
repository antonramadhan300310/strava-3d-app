import type { ExpressionSpecification, LineLayerSpecification } from 'maplibre-gl';

export const HEATMAP_LINES_SOURCE_ID = 'personal-heatmap-lines';
export const HEATMAP_CASING_LAYER_ID = 'personal-heatmap-casing';
export const HEATMAP_GLOW_LAYER_ID = 'personal-heatmap-glow';
export const HEATMAP_CORE_LAYER_ID = 'personal-heatmap-core';

/** Charcoal contrast pass so the neon track never sinks into a bright map. */
export const HEATMAP_CASING_COLOR = '#0D1112';
/** Extra width, in pixels, the casing adds under the neon core. */
export const HEATMAP_CASING_EXTRA_WIDTH = 8;

/** Neon Opsi A spectrum, keyed by how often a segment has been ridden. */
export const HEATMAP_NEON_COLORS = {
  low: '#00E5FF',
  mid: '#FF6D00',
  high: '#FF1744',
} as const;

export const HEATMAP_WEIGHT_TIERS = [
  { label: '1× dilewati', color: HEATMAP_NEON_COLORS.low, range: '< 2' },
  { label: '2–4× dilewati', color: HEATMAP_NEON_COLORS.mid, range: '2–4' },
  { label: '5×+ (favorit)', color: HEATMAP_NEON_COLORS.high, range: '≥ 5' },
] as const;

type HeatmapPaint = NonNullable<LineLayerSpecification['paint']>;

const weight: ExpressionSpecification = ['coalesce', ['get', 'weight'], 1];

/** Cyan → orange → laser red as the segment weight crosses 2 and 5. */
const neonColor: ExpressionSpecification = [
  'step',
  weight,
  HEATMAP_NEON_COLORS.low,
  2,
  HEATMAP_NEON_COLORS.mid,
  5,
  HEATMAP_NEON_COLORS.high,
];

/** Widths per weight tier at one zoom stop. */
function tieredWidth(low: number, mid: number, high: number): ExpressionSpecification {
  return ['step', weight, low, 2, mid, 5, high];
}

/**
 * Zoom-interpolated width, grown by `extra` pixels on every tier.
 *
 * The zoom input has to stay at the top level of the expression — MapLibre
 * rejects `['+', <interpolate on zoom>, 8]` — so `extra` is folded into each
 * stop instead of wrapping the whole expression.
 */
function neonWidth(extra = 0): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    8,
    tieredWidth(2.6 + extra, 3.4 + extra, 4.4 + extra),
    12,
    tieredWidth(3.4 + extra, 4.4 + extra, 5.6 + extra),
    16,
    tieredWidth(4.6 + extra, 5.8 + extra, 7.2 + extra),
  ];
}

export function heatmapCasingPaint(): HeatmapPaint {
  return {
    'line-color': HEATMAP_CASING_COLOR,
    'line-width': neonWidth(HEATMAP_CASING_EXTRA_WIDTH),
    'line-opacity': 0.8,
    'line-blur': 4,
  };
}

export function heatmapGlowPaint(): HeatmapPaint {
  return {
    'line-color': neonColor,
    'line-width': neonWidth(3),
    'line-blur': 6,
    'line-opacity': 0.45,
  };
}

export function heatmapCorePaint(): HeatmapPaint {
  return {
    'line-color': neonColor,
    'line-width': neonWidth(),
    'line-blur': 1,
    'line-opacity': 0.95,
  };
}
