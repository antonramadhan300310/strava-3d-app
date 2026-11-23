import { normalizeActivityType, type ActivityType } from './valhalla';

export type ActivityMarkerOptions = {
  /** Draws the soft radar pulse ring around the badge. */
  pulse?: boolean;
};

const BADGE_BACKGROUND = '#B9F51E';
const STYLE_ID = 'activity-marker-styles';

const ICON_SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"';

/** Charcoal silhouettes kept as inline SVG so the badge stays well under 1 KB. */
const ICONS: Record<ActivityType, string> = {
  cycling:
    `<svg ${ICON_SVG_ATTRS} fill="none" stroke="#0D1112" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    '<circle cx="5.5" cy="17.5" r="3.2"/><circle cx="18.5" cy="17.5" r="3.2"/>' +
    '<path d="M5.5 17.5 9.5 8h4.5l4.5 9.5M9.5 8l4.5 9.5H5.5M14 8h3.5"/></svg>',
  run:
    `<svg ${ICON_SVG_ATTRS} fill="#0D1112">` +
    '<circle cx="15" cy="5" r="2.2"/>' +
    '<path d="M13.7 8.2 10 9.7l-2.2 3.6 1.8 1 1.7-2.9 1.5-.6-1.4 4.1-3.2 3.4 1.4 1.4 3.6-3.8 1-2.9.9 2.6 2.5 2.6 1.5-1.4-2.1-2.2-1-4.1 2 1.1 2.4.4.3-2.1-2.6-.4-2.4-1.5Z"/></svg>',
  walking:
    `<svg ${ICON_SVG_ATTRS} fill="#0D1112">` +
    '<circle cx="13" cy="4.6" r="2.2"/>' +
    '<path d="M12.4 7.6 9.5 9.5 8 13.6l1.9.7 1.3-3 1.1-.6-1 4.4-2.4 4.4 1.8.9 2.4-4.3 1-2.6 1.3 2.6 2.4 2.5 1.4-1.4-2-2.2-1-3.6 1.7.9 2.1.2.2-2-2.2-.2-2.7-1.6Z"/></svg>',
  hike:
    `<svg ${ICON_SVG_ATTRS} fill="#0D1112">` +
    '<path d="M2 20h20L13.8 6.2l-3.2 5.5-1.8-2.6L2 20Z"/>' +
    '<path d="M16 3v5l3-1.6L16 5"/></svg>',
};

function ensurePulseStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    '@keyframes activity-marker-pulse{0%{transform:scale(.6);opacity:.85}70%{transform:scale(1.9);opacity:0}100%{transform:scale(1.9);opacity:0}}';
  document.head.appendChild(style);
}

/**
 * Round Active Lime activity badge used by the live GPS dot and the flyover marker.
 * Returns a detached element; the caller hands it to a MapLibre marker.
 */
export function createActivityMarkerElement(
  activityType: string | null | undefined,
  options: ActivityMarkerOptions = {},
): HTMLDivElement {
  ensurePulseStyles();

  const type = normalizeActivityType(activityType);
  const root = document.createElement('div');
  root.style.cssText =
    'position:relative;display:flex;align-items:center;justify-content:center;width:34px;height:34px;pointer-events:none;';

  if (options.pulse) {
    const ring = document.createElement('span');
    ring.style.cssText =
      'position:absolute;left:50%;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:9999px;' +
      'background:rgba(185,245,30,0.45);animation:activity-marker-pulse 1.8s ease-out infinite;';
    root.appendChild(ring);
  }

  const badge = document.createElement('span');
  badge.style.cssText =
    `position:relative;display:flex;align-items:center;justify-content:center;width:28px;height:28px;` +
    `border-radius:9999px;background:${BADGE_BACKGROUND};border:2.5px solid #ffffff;` +
    'box-shadow:0 2px 10px rgba(15,23,42,0.45);';
  badge.innerHTML = ICONS[type];
  root.appendChild(badge);

  return root;
}
