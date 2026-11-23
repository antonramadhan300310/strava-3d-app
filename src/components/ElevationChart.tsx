'use client';

import { useMemo } from 'react';
import { elevationProfile } from '@/lib/flyover';
import type { LngLatEle } from '@/lib/polyline';

const WIDTH = 300;
const HEIGHT = 64;
const PADDING = 2;

type Props = {
  coordinates: LngLatEle[];
  /** Playback progress, 0–1; fills the chart up to the marker. */
  progress?: number;
};

export default function ElevationChart({ coordinates, progress = 0 }: Props) {
  const profile = useMemo(() => elevationProfile(coordinates), [coordinates]);
  const { points, min, max } = profile;

  const geometry = useMemo(() => {
    if (points.length < 2) return null;

    const span = max - min || 1;
    const usableWidth = WIDTH - PADDING * 2;
    const usableHeight = HEIGHT - PADDING * 2;

    const toXY = (value: number, index: number) => {
      const x = PADDING + (index / (points.length - 1)) * usableWidth;
      const y = PADDING + usableHeight - ((value - min) / span) * usableHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    };

    const line = points.map(toXY).join(' ');
    const area = `${PADDING},${HEIGHT - PADDING} ${line} ${WIDTH - PADDING},${HEIGHT - PADDING}`;
    return { line, area };
  }, [points, min, max]);

  if (!geometry) {
    return (
      <div className="flex h-16 items-center justify-center rounded-xl bg-[#1E2E16]/60 text-[11px] text-slate-500">
        Profil elevasi tidak tersedia
      </div>
    );
  }

  const clamped = Math.min(Math.max(progress, 0), 1);

  return (
    <div className="relative overflow-hidden rounded-xl bg-[#1E2E16]/60">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-16 w-full"
        role="img"
        aria-label={`Profil elevasi ${Math.round(min)} sampai ${Math.round(max)} meter`}
      >
        <defs>
          <linearGradient id="elevation-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#B9F51E" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#B9F51E" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="elevation-fill-done" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fde047" stopOpacity="0.65" />
            <stop offset="100%" stopColor="#fde047" stopOpacity="0.05" />
          </linearGradient>
          <clipPath id="elevation-progress">
            <rect x="0" y="0" width={WIDTH * clamped} height={HEIGHT} />
          </clipPath>
        </defs>

        <polygon points={geometry.area} fill="url(#elevation-fill)" />
        <polyline
          points={geometry.line}
          fill="none"
          stroke="#A5E012"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        <g clipPath="url(#elevation-progress)">
          <polygon points={geometry.area} fill="url(#elevation-fill-done)" />
          <polyline
            points={geometry.line}
            fill="none"
            stroke="#fde047"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </g>

        <line
          x1={WIDTH * clamped}
          y1="0"
          x2={WIDTH * clamped}
          y2={HEIGHT}
          stroke="#fde047"
          strokeWidth="1"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <span className="pointer-events-none absolute left-1.5 top-1 text-[9px] font-medium text-slate-400">
        {Math.round(max)} m
      </span>
      <span className="pointer-events-none absolute bottom-1 left-1.5 text-[9px] font-medium text-slate-400">
        {Math.round(min)} m
      </span>
    </div>
  );
}
