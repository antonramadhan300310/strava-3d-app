import maplibregl from 'maplibre-gl';

export type RouteEndpointRole = 'start' | 'finish';

export const ROUTE_START_COLOR = '#22C55E';
export const ROUTE_ENDPOINT_BORDER = '#0D1112';
export const ROUTE_ENDPOINT_SIZE = 28;

/**
 * DOM badge used by the interactive maps (Routes, Activity Detail, Flyover).
 * Start is a green circle with a white play triangle, finish is a checkered
 * flag inside the same charcoal-bordered circle.
 */
export function createRouteEndpointElement(role: RouteEndpointRole): HTMLDivElement {
  const element = document.createElement('div');
  element.setAttribute('aria-hidden', 'true');
  element.style.cssText = [
    `width:${ROUTE_ENDPOINT_SIZE}px`,
    `height:${ROUTE_ENDPOINT_SIZE}px`,
    'border-radius:9999px',
    `border:2.5px solid ${ROUTE_ENDPOINT_BORDER}`,
    'box-sizing:border-box',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'pointer-events:none',
    'box-shadow:0 2px 8px rgba(13,17,18,0.45)',
  ].join(';');

  if (role === 'start') {
    element.style.background = ROUTE_START_COLOR;
    const play = document.createElement('span');
    play.style.cssText =
      'display:block;width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;border-left:8px solid #FFFFFF;margin-left:2px;';
    element.appendChild(play);
  } else {
    element.style.backgroundColor = '#FFFFFF';
    element.style.backgroundImage =
      'repeating-conic-gradient(#0D1112 0% 25%, #FFFFFF 0% 50%)';
    element.style.backgroundSize = '10px 10px';
  }

  return element;
}

/**
 * Canvas twin of the DOM badge, so share cards and captured posters carry the
 * same start/finish identity as the live map.
 */
export function drawRouteEndpointBadge(
  ctx: CanvasRenderingContext2D,
  role: RouteEndpointRole,
  x: number,
  y: number,
  radius = 14,
): void {
  const r = Math.max(radius, 4);

  ctx.save();
  ctx.translate(x, y);

  ctx.shadowColor = 'rgba(13,17,18,0.45)';
  ctx.shadowBlur = r * 0.7;
  ctx.shadowOffsetY = r * 0.1;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = role === 'start' ? ROUTE_START_COLOR : '#FFFFFF';
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  if (role === 'finish') {
    ctx.save();
    ctx.clip();
    const cell = r / 2;
    ctx.fillStyle = ROUTE_ENDPOINT_BORDER;
    for (let row = -2; row < 2; row += 1) {
      for (let column = -2; column < 2; column += 1) {
        if ((row + column) % 2 === 0) {
          ctx.fillRect(column * cell, row * cell, cell, cell);
        }
      }
    }
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.moveTo(-r * 0.24, -r * 0.42);
    ctx.lineTo(-r * 0.24, r * 0.42);
    ctx.lineTo(r * 0.48, 0);
    ctx.closePath();
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, r * 0.18);
  ctx.strokeStyle = ROUTE_ENDPOINT_BORDER;
  ctx.stroke();

  ctx.restore();
}

function isCoordinate(value: readonly number[] | undefined): value is readonly number[] {
  return Boolean(
    value && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]),
  );
}

/**
 * Replaces the current start/finish markers with ones matching `coordinates`.
 *
 * Markers are always removed first so a geometry change or a style reload never
 * stacks duplicates on the map.
 */
export function updateRouteEndpointMarkers(
  map: maplibregl.Map,
  coordinates: readonly (readonly number[])[] | null | undefined,
  current: maplibregl.Marker[],
): maplibregl.Marker[] {
  for (const marker of current) marker.remove();
  if (!coordinates || coordinates.length < 2) return [];

  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (!isCoordinate(first) || !isCoordinate(last)) return [];

  const create = (role: RouteEndpointRole, coordinate: readonly number[]) =>
    new maplibregl.Marker({
      element: createRouteEndpointElement(role),
      anchor: 'center',
      rotationAlignment: 'viewport',
      pitchAlignment: 'viewport',
    })
      .setLngLat([coordinate[0], coordinate[1]])
      .addTo(map);

  return [create('start', first), create('finish', last)];
}
