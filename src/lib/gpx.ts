import { calculateElevationGain } from './valhalla';
import type { LngLat, LngLatEle } from './polyline';

export type ParsedGpx = {
  coordinates: LngLatEle[];
  name: string | null;
};

/**
 * Parses `<trkpt>`/`<rtept>` elements from a GPX document.
 *
 * Uses DOMParser so namespace prefixes on the root `<gpx>` element do not
 * matter; only element local names are compared.
 */
export function parseGpx(xml: string): ParsedGpx {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('File GPX tidak valid atau rusak.');
  }

  const points = Array.from(doc.getElementsByTagName('*')).filter(
    (element) => element.localName === 'trkpt' || element.localName === 'rtept',
  );

  const coordinates: LngLatEle[] = [];
  for (const point of points) {
    const lat = Number.parseFloat(point.getAttribute('lat') ?? '');
    const lon = Number.parseFloat(point.getAttribute('lon') ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const eleElement = Array.from(point.children).find((child) => child.localName === 'ele');
    const ele = eleElement ? Number.parseFloat(eleElement.textContent ?? '') : Number.NaN;

    coordinates.push([lon, lat, Number.isFinite(ele) ? ele : 0]);
  }

  if (coordinates.length < 2) {
    throw new Error('GPX tidak berisi minimal 2 titik jalur.');
  }

  const nameElement = Array.from(doc.getElementsByTagName('*')).find(
    (element) => element.localName === 'name',
  );

  return {
    coordinates,
    name: nameElement?.textContent?.trim() || null,
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Builds a GPX 1.1 track document with one `<trkseg>`. */
export function buildGpx(name: string, coordinates: LngLatEle[]): string {
  const points = coordinates
    .map(
      ([lon, lat, ele]) =>
        `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">` +
        `<ele>${ele.toFixed(1)}</ele></trkpt>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Personal 3D Activity Tracker"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
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
