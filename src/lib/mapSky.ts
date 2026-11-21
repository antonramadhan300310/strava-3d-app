import type { SkySpecification } from 'maplibre-gl';

/** Blue gradient sky with a hazy horizon, so peaks do not sit on black void. */
export const SKY_SPEC: SkySpecification = {
  'sky-color': '#4a90e2',
  'sky-horizon-blend': 0.5,
  'horizon-color': '#dbeafe',
  'horizon-fog-blend': 0.8,
  'fog-color': '#e2e8f0',
  'fog-ground-blend': 0.15,
};

/** Older MapLibre builds (and the style-spec types) may lack `setSky`. */
export function applySky(map: maplibregl.Map) {
  if (typeof map.setSky !== 'function') return;
  map.setSky(SKY_SPEC);
}
