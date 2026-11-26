import { calculateElevationGain } from './valhalla';
import { normalizeRouteCoordinates } from './routeCoordinates';
import type { LngLat, LngLatEle } from './polyline';

export type ParsedGpx = {
  coordinates: LngLatEle[];
  name: string | null;
};

/** Optional namespace prefix, e.g. `gpx:` in `<gpx:trkpt>`. */
const PREFIX = '(?:[A-Za-z_][\\w.-]*:)?';
const POINT_TAG = new RegExp(`<${PREFIX}(trkpt|rtept|wpt)\\b([^>]*?)(/?)>`, 'gi');
const ELE_TAG = new RegExp(`<${PREFIX}ele\\b[^>]*>([\\s\\S]*?)<\\/`, 'i');

function closingTagOf(tag: string): RegExp {
  return new RegExp(`</${PREFIX}${tag}\\s*>`, 'i');
}

function elementText(source: string, tag: string): string | null {
  const match = new RegExp(
    `<${PREFIX}${tag}\\b[^>]*>([\\s\\S]*?)</${PREFIX}${tag}\\s*>`,
    'i',
  ).exec(source);
  return match ? match[1] : null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, decimal: string) => {
      const code = Number.parseInt(decimal, 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attributesOf(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const regex = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const name = match[1].toLowerCase().replace(/^.*:/, '');
    attributes[name] = match[2] ?? match[3] ?? '';
  }
  return attributes;
}

/** True when the text carries a `<gpx>` root element (any namespace). */
export function looksLikeGpx(text: string): boolean {
  return new RegExp(`<${PREFIX}gpx\\b`, 'i').test(text);
}

export function isGpxFileName(fileName: string): boolean {
  return /\.gpx$/i.test(fileName.trim());
}

type GpxPoint = { lat: number; lng: number; ele: number };
type GpxPointTag = 'trkpt' | 'rtept' | 'wpt';

function readPoints(text: string): Record<GpxPointTag, GpxPoint[]> {
  const groups: Record<GpxPointTag, GpxPoint[]> = { trkpt: [], rtept: [], wpt: [] };
  POINT_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = POINT_TAG.exec(text)) !== null) {
    const tag = match[1].toLowerCase() as GpxPointTag;
    const attributes = attributesOf(match[2]);
    const lat = Number.parseFloat(attributes.lat ?? '');
    const lon = Number.parseFloat(attributes.lon ?? '');

    let ele = 0;
    if (!match[3]) {
      // `<trkpt .../>` carries no `<ele>`, so only scan the element body.
      const bodyStart = POINT_TAG.lastIndex;
      const closing = closingTagOf(tag).exec(text.slice(bodyStart));
      const body = closing ? text.slice(bodyStart, bodyStart + closing.index) : '';
      const eleMatch = ELE_TAG.exec(body);
      const parsed = eleMatch ? Number.parseFloat(decodeXmlEntities(eleMatch[1]).trim()) : Number.NaN;
      if (Number.isFinite(parsed)) ele = parsed;
    }

    if (Number.isFinite(lat) && Number.isFinite(lon)) groups[tag].push({ lat, lng: lon, ele });
  }

  return groups;
}

/**
 * Picks one point source. A track wins over a route, which wins over bare
 * waypoints; mixing them would splice POIs into the recorded line.
 */
function pickPoints(groups: Record<GpxPointTag, GpxPoint[]>): GpxPoint[] {
  for (const tag of ['trkpt', 'rtept', 'wpt'] as const) {
    if (groups[tag].length >= 2) return groups[tag];
  }
  return [...groups.trkpt, ...groups.rtept, ...groups.wpt];
}

function readName(text: string): string | null {
  for (const container of ['metadata', 'trk', 'rte']) {
    const block = elementText(text, container);
    if (!block) continue;
    const name = elementText(block, 'name');
    const cleaned = name ? decodeXmlEntities(name).trim() : '';
    if (cleaned) return cleaned;
  }

  const fallback = elementText(text, 'name');
  const cleaned = fallback ? decodeXmlEntities(fallback).trim() : '';
  return cleaned || null;
}

/**
 * Parses `<trkpt>`, `<rtept>` and `<wpt>` elements from a GPX document.
 *
 * A small tolerant scanner is used instead of `DOMParser`: it accepts any
 * namespace prefix, works in Node (unit tests) and never fails on the
 * vendor-specific extensions Strava/Garmin add. Coordinates go through
 * {@link normalizeRouteCoordinates}, so the output is always GeoJSON
 * `[lng, lat, ele]` and out-of-range points are dropped.
 */
export function parseGpx(xml: string): ParsedGpx {
  const text = xml.replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('File GPX kosong. Pilih berkas .gpx yang berisi jalur.');
  if (!looksLikeGpx(text)) {
    throw new Error('File bukan GPX yang valid: elemen <gpx> tidak ditemukan.');
  }

  const points = pickPoints(readPoints(text));
  if (points.length === 0) {
    throw new Error('File GPX tidak memiliki titik koordinat (<trkpt>, <rtept>, atau <wpt>).');
  }

  const coordinates = normalizeRouteCoordinates(points);
  if (coordinates.length < 2) {
    throw new Error('GPX harus berisi minimal 2 titik jalur dengan koordinat yang valid.');
  }

  return { coordinates, name: readName(text) };
}

async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('File GPX gagal dibaca dari perangkat.'));
    reader.readAsText(file);
  });
}

/**
 * Reads a picked file as GPX. Android often reports `.gpx` files with a generic
 * MIME type (`application/octet-stream`), so the extension and the `<gpx>` tag
 * inside the text decide validity instead of the picker's filter.
 */
export async function readGpxFile(file: File): Promise<ParsedGpx> {
  if (file.size > 25 * 1024 * 1024) {
    throw new Error('File GPX terlalu besar (maksimal 25 MB).');
  }

  const text = await readFileText(file);
  if (!looksLikeGpx(text) && !isGpxFileName(file.name)) {
    throw new Error(`"${file.name}" bukan file GPX. Pilih berkas berekstensi .gpx.`);
  }
  return parseGpx(text);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export type GpxMetadata = {
  sportType?: string;
  distanceMeters?: number;
  elevationGainMeters?: number;
  durationSeconds?: number;
};

function metadataExtension(metadata: GpxMetadata | undefined): string {
  if (!metadata?.sportType) return '';
  const rows = [
    `<allmova:sport_type>${escapeXml(metadata.sportType)}</allmova:sport_type>`,
  ];
  if (Number.isFinite(metadata.distanceMeters)) {
    rows.push(`<allmova:distance_meters>${Math.round(metadata.distanceMeters as number)}</allmova:distance_meters>`);
  }
  if (Number.isFinite(metadata.elevationGainMeters)) {
    rows.push(
      `<allmova:elevation_gain_meters>${Math.round(metadata.elevationGainMeters as number)}</allmova:elevation_gain_meters>`,
    );
  }
  if (Number.isFinite(metadata.durationSeconds)) {
    rows.push(
      `<allmova:duration_seconds>${Math.round(metadata.durationSeconds as number)}</allmova:duration_seconds>`,
    );
  }
  return `    <extensions>\n      ${rows.join('\n      ')}\n    </extensions>\n`;
}

/** Builds a GPX 1.1 track document with one `<trkseg>`. */
export function buildGpx(
  name: string,
  coordinates: LngLatEle[],
  metadata?: GpxMetadata,
): string {
  const points = coordinates
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
    .map(
      ([lon, lat, ele]) =>
        `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">` +
        `<ele>${(Number.isFinite(ele) ? ele : 0).toFixed(1)}</ele></trkpt>`,
    )
    .join('\n');
  const extension = metadataExtension(metadata);
  const type = metadata?.sportType
    ? `    <type>${escapeXml(metadata.sportType)}</type>\n`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Personal 3D Activity Tracker"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:allmova="https://allmova.app/gpx/1"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
${type}${extension}    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

export function gpxFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'route'}.gpx`;
}

export function elevationGainOf(coordinates: LngLatEle[]): number {
  return calculateElevationGain(coordinates);
}

export type { LngLat, LngLatEle };
