import type { LngLat } from './polyline';

export type PlaceSuggestion = {
  id: string;
  /** Street, place or POI name, shown as the bold first line. */
  name: string;
  /** District/city context, shown underneath. */
  subtitle: string;
  /** `[lng, lat]` so it can be pushed straight into a route. */
  coords: LngLat;
};

export type BiasCenter = { lat: number; lng: number };

const PHOTON_URL = 'https://photon.komoot.io/api/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const RESULT_LIMIT = 5;
const OFFLINE_MESSAGE = 'Pencarian alamat butuh koneksi internet';

type PhotonProperties = {
  osm_id?: number;
  osm_type?: string;
  name?: string;
  street?: string;
  housenumber?: string;
  district?: string;
  locality?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  country?: string;
  postcode?: string;
};

type PhotonFeature = {
  properties?: PhotonProperties;
  geometry?: { coordinates?: number[] };
};

type PhotonResponse = { features?: PhotonFeature[] };

type NominatimPlace = {
  place_id?: number;
  display_name?: string;
  lat?: string;
  lon?: string;
  name?: string;
};

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException
    ? cause.name === 'AbortError'
    : cause instanceof Error && cause.name === 'AbortError';
}

function uniqueParts(parts: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    const value = part?.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parsePhoton(data: PhotonResponse): PlaceSuggestion[] {
  const features = data.features ?? [];
  const suggestions: PlaceSuggestion[] = [];

  features.forEach((feature, index) => {
    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) return;
    const [lng, lat] = coords;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;

    const p = feature.properties ?? {};
    const street = [p.street, p.housenumber].filter(Boolean).join(' ').trim();
    const name =
      p.name?.trim() ||
      street ||
      p.city ||
      p.town ||
      p.village ||
      p.locality ||
      p.county ||
      'Lokasi';

    const subtitle = uniqueParts([
      p.district,
      p.city,
      p.town,
      p.village,
      p.county,
      p.state,
      p.country,
    ])
      .filter((part) => part !== name)
      .slice(0, 3)
      .join(', ');

    suggestions.push({
      id: `${p.osm_type ?? 'photon'}-${p.osm_id ?? index}`,
      name,
      subtitle,
      coords: [lng, lat],
    });
  });

  return suggestions;
}

function parseNominatim(rows: NominatimPlace[]): PlaceSuggestion[] {
  const suggestions: PlaceSuggestion[] = [];

  rows.forEach((row, index) => {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const parts = (row.display_name ?? '').split(',').map((part) => part.trim()).filter(Boolean);
    const name = row.name?.trim() || parts[0] || 'Lokasi';
    const subtitle = parts.filter((part) => part !== name).slice(0, 3).join(', ');

    suggestions.push({
      id: `nominatim-${row.place_id ?? index}`,
      name,
      subtitle,
      coords: [lon, lat],
    });
  });

  return suggestions;
}

async function fetchPhoton(
  query: string,
  biasCenter: BiasCenter | undefined,
  signal: AbortSignal | undefined,
): Promise<PlaceSuggestion[]> {
  const params = new URLSearchParams({ q: query, limit: String(RESULT_LIMIT) });
  if (biasCenter) {
    params.set('lat', String(biasCenter.lat));
    params.set('lon', String(biasCenter.lng));
  }

  const response = await fetch(`${PHOTON_URL}?${params.toString()}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Photon ${response.status}`);

  return parsePhoton((await response.json()) as PhotonResponse);
}

async function fetchNominatim(
  query: string,
  signal: AbortSignal | undefined,
): Promise<PlaceSuggestion[]> {
  const params = new URLSearchParams({
    format: 'json',
    q: query,
    limit: String(RESULT_LIMIT),
    countrycodes: 'id',
  });

  const response = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Nominatim ${response.status}`);

  return parseNominatim((await response.json()) as NominatimPlace[]);
}

/**
 * Free address search with no API key: Photon (OSM) first, Nominatim as a
 * fallback. Never throws for network problems — the caller gets a short
 * offline message instead, so a failed search cannot break the route screen.
 */
export async function searchPlaces(
  query: string,
  biasCenter?: BiasCenter,
  signal?: AbortSignal,
): Promise<PlaceSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  try {
    return await fetchPhoton(trimmed, biasCenter, signal);
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
  }

  try {
    return await fetchNominatim(trimmed, signal);
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
  }

  throw new Error(OFFLINE_MESSAGE);
}
