/** Which tile stack the main map and flyover should render. */
export type MapProvider = 'opendata' | 'maptiler';

export const MAP_PROVIDER_STORAGE_KEY = 'tracker3d_map_provider';

/** PIN required to unlock the personal MapTiler Pro stack. */
export const MAPTILER_PIN = '300310';

export const MAP_PROVIDER_LABELS: Record<MapProvider, string> = {
  opendata: 'OpenMap',
  maptiler: 'MapTiler',
};

export function readMapProvider(): MapProvider | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(MAP_PROVIDER_STORAGE_KEY);
    return value === 'opendata' || value === 'maptiler' ? value : null;
  } catch {
    return null;
  }
}

export function writeMapProvider(provider: MapProvider): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MAP_PROVIDER_STORAGE_KEY, provider);
  } catch {
    // Storage can be blocked (private mode); the choice still applies this session.
  }
}
