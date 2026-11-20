export type LngLat = [number, number];
export type LngLatEle = [number, number, number];

/**
 * Decodes a Valhalla `trip.legs[].shape` polyline.
 *
 * Valhalla encodes at precision 6 (1e6), unlike the precision-5 format used by
 * Google/OSRM. Decoding at 1e5 yields coordinates off by a factor of ten.
 */
export function decodePolyline(encoded: string, precision = 6): LngLat[] {
  const factor = 10 ** precision;
  const points: LngLat[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    for (let axis = 0; axis < 2; axis += 1) {
      let result = 0;
      let shift = 0;
      let byte: number;

      do {
        byte = encoded.charCodeAt(index) - 63;
        index += 1;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);

      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }

    points.push([lng / factor, lat / factor]);
  }

  return points;
}
