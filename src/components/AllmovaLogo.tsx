'use client';

export const ALLMOVA_LIME = '#B9F51E';
export const ALLMOVA_LIME_HOVER = '#A5E012';
export const ALLMOVA_CHARCOAL = '#0D1112';
export const ALLMOVA_SURFACE = '#151B1D';
export const ALLMOVA_OLIVE = '#1E2E16';

export type AllmovaLogoVariant = 'full' | 'compact' | 'icon-only';

const SVG_FONT_STACK = 'var(--font-plus-jakarta),"Plus Jakarta Sans","Segoe UI",sans-serif';
const FALLBACK_FONT_STACK =
  '"Plus Jakarta Sans","Segoe UI",Roboto,system-ui,-apple-system,sans-serif';
const WORDMARK = 'ΛLLMOVA';
const WORDMARK_LETTERS = 'LLMOVA';

/** Lambda is drawn as a path so it never depends on Greek glyph coverage. */
function lambdaPath(size: number): string {
  const width = size * 0.62;
  const height = size * 0.7;
  const thickness = size * 0.15;
  return [
    `M0 0`,
    `L${width / 2} ${-height}`,
    `L${width} 0`,
    `L${width - thickness} 0`,
    `L${width / 2} ${-height * 0.5}`,
    `L${thickness} 0`,
    'Z',
  ].join(' ');
}

let cachedCanvasFontStack: string | null = null;

/**
 * Canvas cannot resolve CSS variables, so the next/font family name is read
 * from the document once and reused for every frame of a video export.
 */
export function allmovaFontStack(): string {
  if (cachedCanvasFontStack) return cachedCanvasFontStack;
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return FALLBACK_FONT_STACK;
  }
  const family = getComputedStyle(document.body)
    .getPropertyValue('--font-plus-jakarta')
    .trim();
  cachedCanvasFontStack = family
    ? `${family},${FALLBACK_FONT_STACK}`
    : FALLBACK_FONT_STACK;
  return cachedCanvasFontStack;
}

/** Three parallel diagonal bars with stepped ends: the ALLMOVA motion mark. */
function MotionStripes() {
  return (
    <g transform="rotate(-45 32 32)" fill={ALLMOVA_LIME}>
      <rect x="6" y="13" width="48" height="8" rx="4" />
      <rect x="11" y="29" width="38" height="8" rx="4" />
      <rect x="16" y="45" width="28" height="8" rx="4" />
    </g>
  );
}

const wordmarkStyle = { fontFamily: SVG_FONT_STACK, fontStyle: 'normal' } as const;

type Props = {
  variant?: AllmovaLogoVariant;
  className?: string;
  /** Overrides the default responsive height. */
  height?: number;
};

export default function AllmovaLogo({ variant = 'full', className, height }: Props) {
  const label = `${WORDMARK} — Every Move Matters`;

  if (variant === 'icon-only') {
    return (
      <svg
        viewBox="0 0 64 64"
        role="img"
        aria-label={label}
        className={className ?? 'h-10 w-10'}
        height={height}
      >
        <MotionStripes />
      </svg>
    );
  }

  if (variant === 'compact') {
    return (
      <svg
        viewBox="0 0 280 64"
        role="img"
        aria-label={label}
        className={className ?? 'h-8 w-auto'}
        height={height}
      >
        <MotionStripes />
        <g transform="translate(78 46) skewX(-8)">
          <path d={lambdaPath(38)} fill="#FFFFFF" />
          <text
            x={38 * 0.66}
            y="0"
            fill="#FFFFFF"
            fontSize="38"
            fontWeight="800"
            letterSpacing="-0.5"
            style={wordmarkStyle}
          >
            {WORDMARK_LETTERS}
          </text>
        </g>
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 360 120"
      role="img"
      aria-label={label}
      className={className ?? 'h-20 w-auto'}
      height={height}
    >
      <g transform="translate(0 24) scale(1.125)">
        <MotionStripes />
      </g>
      <g transform="translate(90 78) skewX(-8)">
        <path d={lambdaPath(46)} fill="#FFFFFF" />
        <text
          x={46 * 0.66}
          y="0"
          fill="#FFFFFF"
          fontSize="46"
          fontWeight="800"
          letterSpacing="-0.5"
          style={wordmarkStyle}
        >
          {WORDMARK_LETTERS}
        </text>
      </g>
      <text
        x="92"
        y="108"
        fill="#FFFFFF"
        fontSize="12"
        fontWeight="700"
        letterSpacing="5"
        style={wordmarkStyle}
      >
        EVERY <tspan fill={ALLMOVA_LIME}>MOVE</tspan> MATTERS.
      </text>
    </svg>
  );
}

export type AllmovaLogoDrawOptions = {
  variant?: AllmovaLogoVariant;
  /** Multiplied into the current `globalAlpha`; 0.78 for the video watermark. */
  opacity?: number;
  stripeColor?: string;
  wordmarkColor?: string;
  taglineColor?: string;
};

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawStripes(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  color: string,
) {
  const bars = [
    { x: 6, y: 13, width: 48 },
    { x: 11, y: 29, width: 38 },
    { x: 16, y: 45, width: 28 },
  ];

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.translate(32, 32);
  ctx.rotate(-Math.PI / 4);
  ctx.translate(-32, -32);
  ctx.fillStyle = color;
  for (const bar of bars) {
    roundedRect(ctx, bar.x, bar.y, bar.width, 8, 4);
    ctx.fill();
  }
  ctx.restore();
}

function drawWordmark(
  ctx: CanvasRenderingContext2D,
  size: number,
  color: string,
) {
  const width = size * 0.62;
  const height = size * 0.7;
  const thickness = size * 0.15;

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(width / 2, -height);
  ctx.lineTo(width, 0);
  ctx.lineTo(width - thickness, 0);
  ctx.lineTo(width / 2, -height * 0.5);
  ctx.lineTo(thickness, 0);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.fillText(WORDMARK_LETTERS, width + size * 0.04, 0);
}

function drawTrackedTagline(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  color: string,
) {
  const text = 'EVERY MOVE MATTERS.';
  const moveStart = text.indexOf('MOVE');
  const moveEnd = moveStart + 'MOVE'.length;
  const tracking = 4.5 * scale;

  ctx.save();
  ctx.font = `700 ${12 * scale}px ${allmovaFontStack()}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let cursor = x;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    ctx.fillStyle = index >= moveStart && index < moveEnd ? ALLMOVA_LIME : color;
    ctx.fillText(char, cursor, y);
    cursor += ctx.measureText(char).width + tracking;
  }
  ctx.restore();
}

/**
 * Draws the vector logo onto an HTML5 canvas. Used by the MP4 watermark and
 * the share card so both match the SVG identity pixel for pixel.
 */
export function drawAllmovaLogoOnCanvas(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  options: AllmovaLogoDrawOptions = {},
) {
  const {
    variant = 'full',
    opacity = 1,
    stripeColor = ALLMOVA_LIME,
    wordmarkColor = '#FFFFFF',
    taglineColor = '#FFFFFF',
  } = options;

  ctx.save();
  ctx.globalAlpha *= opacity;

  if (variant === 'icon-only') {
    drawStripes(ctx, x, y, scale, stripeColor);
    ctx.restore();
    return;
  }

  const isFull = variant === 'full';
  if (isFull) drawStripes(ctx, x, y + 24 * scale, scale * 1.125, stripeColor);
  else drawStripes(ctx, x, y, scale, stripeColor);

  const wordmarkX = x + (isFull ? 90 : 78) * scale;
  const baseline = y + (isFull ? 78 : 46) * scale;

  ctx.save();
  ctx.translate(wordmarkX, baseline);
  ctx.transform(1, 0, -0.1405, 1, 0, 0);
  ctx.font = `800 ${(isFull ? 46 : 38) * scale}px ${allmovaFontStack()}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  drawWordmark(ctx, (isFull ? 46 : 38) * scale, wordmarkColor);
  ctx.restore();

  if (isFull) {
    drawTrackedTagline(ctx, x + 92 * scale, y + 108 * scale, scale, taglineColor);
  }

  ctx.restore();
}
