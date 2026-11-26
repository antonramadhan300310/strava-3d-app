import type { LngLat, LngLatEle } from './polyline';

/**
 * One parser for every shape a stored route polyline can take.
 *
 * The Supabase admin panel writes `coordinates` as JSONB and editors are not
 * consistent: plain `[lat, lng]` tuples, `[lng, lat]` tuples, `{ lat, lng }`
 * objects, `{ latitude, longitude }` objects, GeoJSON LineStrings and JSON
 * strings all exist in the same table. MapLibre only accepts `[lng, lat]`
 * inside ±90° latitude, so a mis-ordered pair throws
 * `Invalid LngLat object` and blanks the screen; the SVG preview silently
 * collapses into a vertical line instead. Everything is normalised here once.
 */

const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;

export function isValidLngLat(lng: number, lat: number): boolean {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= MAX_LATITUDE &&
    Math.abs(lng) <= MAX_LONGITUDE
  );
}

/** A polyline needs two usable points; anything shorter cannot be drawn. */
export function isValidRouteCoordinates(
  coordinates: readonly (readonly number[])[] | null | undefined,
): coordinates is LngLatEle[] {
  return (
    Array.isArray(coordinates) &&
    coordinates.length >= 2 &&
    coordinates.every(
      (coordinate) =>
        Array.isArray(coordinate) &&
        isValidLngLat(Number(coordinate[0]), Number(coordinate[1])),
    )
  );
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

type PointRead = {
  /** Set when the source names the axes, which removes all ambiguity. */
  explicit: { lat: number; lng: number } | null;
  /** Positional pair exactly as stored, order unknown. */
  pair: LngLat | null;
  elevation: number;
};

function readPoint(value: unknown): PointRead | null {
  if (Array.isArray(value)) {
    const a = toNumber(value[0]);
    const b = toNumber(value[1]);
    if (a === null || b === null) return null;
    return { explicit: null, pair: [a, b], elevation: toNumber(value[2]) ?? 0 };
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const lat = toNumber(record.lat ?? record.latitude ?? record.y);
    const lng = toNumber(
      record.lng ?? record.lon ?? record.long ?? record.longitude ?? record.x,
    );
    const elevation =
      toNumber(record.ele ?? record.elevation ?? record.alt ?? record.altitude ?? record.z) ?? 0;

    if (lat !== null && lng !== null) return { explicit: { lat, lng }, pair: null, elevation };

    // Postgres JSONB can hand a tuple back with numeric keys.
    const a = toNumber(record['0']);
    const b = toNumber(record['1']);
    if (a !== null && b !== null) return { explicit: null, pair: [a, b], elevation };
  }

  return null;
}

type PositionSource = {
  positions: unknown[];
  /** `lnglat` for GeoJSON, `unknown` for bare tuples and object lists. */
  order: 'lnglat' | 'latlng' | 'unknown';
};

function extractPositions(raw: unknown): PositionSource | null {
  const value = parseJson(raw);

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const nested = value as unknown[][];
    const allArrays = value.every((entry) => Array.isArray(entry));
    if (allArrays && nested.every((entry) => entry.length > 0 && Array.isArray(entry[0]))) {
      // MultiLineString: a list of coordinate lists.
      return { positions: nested.flat(), order: 'lnglat' };
    }
    return { positions: value, order: 'unknown' };
  }

  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  if (record.type === 'Feature') return extractPositions(record.geometry);
  if (record.type === 'FeatureCollection' && Array.isArray(record.features)) {
    const collected: unknown[] = [];
    for (const feature of record.features) {
      const nested = extractPositions(feature);
      if (nested) collected.push(...nested.positions);
    }
    return collected.length > 0 ? { positions: collected, order: 'lnglat' } : null;
  }

  const isGeoJsonGeometry =
    record.type === 'LineString' || record.type === 'MultiLineString';
  for (const key of ['coordinates', 'coords', 'points', 'path', 'polyline', 'track', 'geometry']) {
    if (!(key in record)) continue;
    const nested = extractPositions(record[key]);
    if (!nested) continue;
    return {
      positions: nested.positions,
      order: isGeoJsonGeometry ? 'lnglat' : nested.order,
    };
  }

  // A single point object is not a route, but keeping the reader symmetric
  // makes the ordering heuristic below reusable.
  return readPoint(record) ? { positions: [record], order: 'unknown' } : null;
}

/**
 * Decides whether positional pairs are `[lat, lng]` or `[lng, lat]`.
 *
 * Values outside ±90 can only be a longitude, which settles almost every
 * Indonesian row (`lng` 95–141, `lat` −11–6). Sign votes cover the remaining
 * in-range cases, and the source order is the tie-breaker: GeoJSON is
 * longitude-first, while the admin panel's plain tuples are latitude-first.
 */
function prefersLatitudeFirst(points: PointRead[], order: PositionSource['order']): boolean {
  let lngFirstVotes = 0;
  let latFirstVotes = 0;
  let lngFirstSign = 0;
  let latFirstSign = 0;

  for (const point of points) {
    if (point.explicit || !point.pair) continue;
    const [a, b] = point.pair;
    if (Math.abs(a) > MAX_LATITUDE && Math.abs(b) <= MAX_LATITUDE) {
      lngFirstVotes += 1;
    } else if (Math.abs(b) > MAX_LATITUDE && Math.abs(a) <= MAX_LATITUDE) {
      latFirstVotes += 1;
    } else if (a < 0 && b >= 0) {
      latFirstSign += 1;
    } else if (b < 0 && a >= 0) {
      lngFirstSign += 1;
    }
  }

  if (lngFirstVotes !== latFirstVotes) return latFirstVotes > lngFirstVotes;
  if (latFirstSign !== lngFirstSign) return latFirstSign > lngFirstSign;
  if (order === 'lnglat') return false;
  return true;
}

function buildCoordinates(points: PointRead[], latitudeFirst: boolean): LngLatEle[] {
  const coordinates: LngLatEle[] = [];
  for (const point of points) {
    let lng: number;
    let lat: number;
    if (point.explicit) {
      ({ lat, lng } = point.explicit);
    } else if (point.pair) {
      const [a, b] = point.pair;
      lng = latitudeFirst ? b : a;
      lat = latitudeFirst ? a : b;
    } else {
      continue;
    }
    if (!isValidLngLat(lng, lat)) continue;
    coordinates.push([lng, lat, point.elevation]);
  }
  return coordinates;
}

/**
 * Central normaliser: any stored shape in, GeoJSON `[lng, lat, ele]` out.
 *
 * Invalid points are dropped instead of poisoning the whole polyline, and the
 * returned array is empty when nothing usable is left. Callers must check the
 * length (or use {@link isValidRouteCoordinates}) before handing it to the map.
 */
export function normalizeRouteCoordinates(raw: unknown): LngLatEle[] {
  const source = extractPositions(raw);
  if (!source) return [];

  const points: PointRead[] = [];
  for (const position of source.positions) {
    const point = readPoint(position);
    if (point) points.push(point);
  }
  if (points.length === 0) return [];

  const latitudeFirst = prefersLatitudeFirst(points, source.order);
  const primary = buildCoordinates(points, latitudeFirst);
  const alternate = buildCoordinates(points, !latitudeFirst);

  // A wrong guess loses points to the range check; keep whichever reading
  // survives intact rather than trusting the heuristic blindly.
  if (alternate.length > primary.length) return alternate;
  return primary;
}

/** Follow Route / `GuideRoute` consumes latitude-first pairs. */
export function toLatLngCoordinates(coordinates: LngLatEle[]): LngLat[] {
  return coordinates.map(([lng, lat]) => [lat, lng]);
}
