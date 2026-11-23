import type { LngLatEle } from './polyline';
import { normalizeActivityType, type ActivityType } from './valhalla';

/** Row shape returned by the `activities` table (PostgREST snake_case). */
export type ActivityRow = {
  id: string | number;
  title: string | null;
  activity_type: string | null;
  is_planned_route: boolean | null;
  distance_meters: number | null;
  elevation_gain: number | null;
  duration_seconds: number | null;
  geojson: unknown;
  created_at: string | null;
};

export type ActivityRecord = {
  id: string | number;
  title: string;
  activityType: ActivityType;
  isPlannedRoute: boolean;
  distanceMeters: number;
  elevationGain: number;
  durationSeconds: number;
  coordinates: LngLatEle[];
  createdAt: string;
};

function toActivityType(value: string | null): ActivityType {
  return normalizeActivityType(value);
}

/**
 * Reads an EWKB/ISO WKB hex string into coordinates.
 *
 * PostgREST serialises a PostGIS `geometry` column as hex WKB rather than
 * GeoJSON, so a plain `select` hands back something like
 * `010200008001000000...` instead of `{ type: 'LineString', ... }`.
 */
function parseWkbHex(hex: string): LngLatEle[] | null {
  if (hex.length < 18 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  const view = new DataView(bytes.buffer);
  const little = view.getUint8(0) === 1;
  let offset = 1;
  if (offset + 4 > bytes.length) return null;

  const typeWord = view.getUint32(offset, little);
  offset += 4;

  const ewkbHasZ = (typeWord & 0x80000000) !== 0;
  const ewkbHasM = (typeWord & 0x40000000) !== 0;
  const hasSrid = (typeWord & 0x20000000) !== 0;
  const isoType = typeWord & 0x0fffffff;
  let baseType = isoType;
  let hasZ = ewkbHasZ;
  let hasM = ewkbHasM;

  // ISO WKB encodes the dimension in the type itself (1002 = LineString Z,
  // 2002 = LineString M, 3002 = LineString ZM).
  if (!ewkbHasZ && !ewkbHasM && isoType >= 1000) {
    baseType = isoType % 1000;
    const dimension = Math.floor(isoType / 1000);
    hasZ = dimension === 1 || dimension === 3;
    hasM = dimension === 2 || dimension === 3;
  }

  if (baseType !== 2) return null;
  if (hasSrid) offset += 4;
  if (offset + 4 > bytes.length) return null;

  const count = view.getUint32(offset, little);
  offset += 4;

  const stride = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  if (count === 0 || offset + count * stride * 8 > bytes.length) return null;

  const coordinates: LngLatEle[] = [];
  for (let i = 0; i < count; i += 1) {
    const lng = view.getFloat64(offset, little);
    const lat = view.getFloat64(offset + 8, little);
    const ele = hasZ ? view.getFloat64(offset + 16, little) : 0;
    const time = hasM ? view.getFloat64(offset + (hasZ ? 24 : 16), little) : null;
    offset += stride * 8;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    const point: LngLatEle = [lng, lat, Number.isFinite(ele) ? ele : 0];
    if (time !== null && Number.isFinite(time)) point.push(time);
    coordinates.push(point);
  }

  return coordinates;
}

function toCoordinate(value: unknown): LngLatEle | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lng = Number(value[0]);
  const lat = Number(value[1]);
  const ele = Number(value[2]);
  const time = value.length > 3 ? Number(value[3]) : null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const point: LngLatEle = [lng, lat, Number.isFinite(ele) ? ele : 0];
  if (time !== null && Number.isFinite(time)) point.push(time);
  return point;
}

function fromGeoJson(value: unknown): LngLatEle[] | null {
  if (!value || typeof value !== 'object') return null;
  const geometry = value as { type?: string; coordinates?: unknown; geometry?: unknown };

  if (geometry.type === 'Feature' && geometry.geometry) return fromGeoJson(geometry.geometry);
  if (geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) return null;

  const coordinates = geometry.coordinates
    .map(toCoordinate)
    .filter((point): point is LngLatEle => point !== null);
  return coordinates.length >= 2 ? coordinates : null;
}

/** Accepts a GeoJSON object, a GeoJSON string, or hex WKB from PostGIS. */
export function parseActivityGeometry(value: unknown): LngLatEle[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      try {
        return fromGeoJson(JSON.parse(trimmed)) ?? [];
      } catch {
        return [];
      }
    }
    return parseWkbHex(trimmed) ?? [];
  }
  return fromGeoJson(value) ?? [];
}

function toFiniteNumber(value: number | null, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function toActivityRecord(row: ActivityRow): ActivityRecord | null {
  const coordinates = parseActivityGeometry(row.geojson);
  if (coordinates.length < 2) return null;

  return {
    id: row.id,
    title: row.title?.trim() || 'Aktivitas tanpa judul',
    activityType: toActivityType(row.activity_type),
    isPlannedRoute: row.is_planned_route === true,
    distanceMeters: toFiniteNumber(row.distance_meters),
    elevationGain: toFiniteNumber(row.elevation_gain),
    durationSeconds: toFiniteNumber(row.duration_seconds),
    coordinates,
    createdAt: row.created_at ?? '',
  };
}

export function formatActivityDate(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return 'Tanggal tidak tersedia';
  return date.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
