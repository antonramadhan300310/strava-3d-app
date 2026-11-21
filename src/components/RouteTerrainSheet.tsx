'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { LngLatEle } from '@/lib/polyline';
import type { ActivityType } from '@/lib/valhalla';
import {
  analyzeRouteGradient,
  fetchRoadConditions,
  type GradientBucket,
  type GradientSample,
  type RoadConditions,
  type SurfaceBucket,
} from '@/lib/routeAnalysis';

const GRADIENT_COLORS: Record<GradientBucket['key'], string> = {
  flat: 'bg-emerald-400',
  moderate: 'bg-amber-400',
  steep: 'bg-rose-500',
};

const SURFACE_COLORS: Record<SurfaceBucket['key'], string> = {
  paved: 'bg-emerald-400',
  rough: 'bg-amber-400',
  unpaved: 'bg-orange-500',
  unknown: 'bg-slate-500',
};

type Props = {
  coordinates: LngLatEle[];
  activityType: ActivityType;
  onClose: () => void;
};

function formatKm(meters: number): string {
  return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(0)}%`;
}

export default function RouteTerrainSheet({ coordinates, activityType, onClose }: Props) {
  const analysis = useMemo(() => analyzeRouteGradient(coordinates), [coordinates]);
  const [conditions, setConditions] = useState<RoadConditions | null>(null);
  const [loadingConditions, setLoadingConditions] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingConditions(true);
    setConditions(null);

    fetchRoadConditions(coordinates, activityType)
      .then((result) => {
        if (cancelled) return;
        setConditions(result);
        setLoadingConditions(false);
      })
      .catch(() => {
        if (cancelled) return;
        setConditions(null);
        setLoadingConditions(false);
      });

    return () => {
      cancelled = true;
    };
  }, [coordinates, activityType]);

  return (
    <div
      className="absolute inset-0 z-50 flex items-end justify-center bg-slate-950/70 px-3 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] backdrop-blur-sm sm:items-center sm:pb-4"
      role="dialog"
      aria-modal="true"
      aria-label="Info Medan"
      onClick={onClose}
    >
      <div
        className="max-h-[82dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/10 bg-slate-900 p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Info Medan</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup Info Medan"
            className="rounded-full p-1 text-slate-400 active:bg-slate-800"
          >
            <X size={18} />
          </button>
        </div>

        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Ringkasan Gradien
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <GradientStat label="Max Gradien" value={`${analysis.maxGrade.toFixed(1)}%`} accent="text-rose-300" />
            <GradientStat
              label="Rata-rata Tanjakan"
              value={`${analysis.avgUphill.toFixed(1)}%`}
              accent="text-amber-300"
            />
          </div>

          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-slate-800">
            {analysis.buckets.map((bucket) => (
              <span
                key={bucket.key}
                className={GRADIENT_COLORS[bucket.key]}
                style={{ width: `${bucket.percent}%` }}
              />
            ))}
          </div>

          <ul className="mt-2 space-y-1">
            {analysis.buckets.map((bucket) => (
              <li key={bucket.key} className="flex items-center gap-2 text-[11px] text-slate-300">
                <span className={`h-2 w-2 shrink-0 rounded-full ${GRADIENT_COLORS[bucket.key]}`} />
                <span className="flex-1">{bucket.label}</span>
                <span className="text-slate-400">{formatKm(bucket.distanceMeters)}</span>
                <span className="w-9 text-right font-semibold text-slate-200">
                  {formatPercent(bucket.percent)}
                </span>
              </li>
            ))}
          </ul>

          {!analysis.hasElevation && (
            <p className="mt-2 text-[11px] text-slate-500">
              Data elevasi rute tidak tersedia, gradien tidak dapat dihitung.
            </p>
          )}
        </section>

        <section className="mt-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Profil Elevasi
          </h3>
          <TerrainProfileChart
            samples={analysis.samples}
            totalDistanceMeters={analysis.totalDistanceMeters}
          />
        </section>

        <section className="mt-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Kondisi Permukaan Jalan
          </h3>
          {loadingConditions ? (
            <p className="flex items-center gap-2 text-[11px] text-slate-400">
              <Loader2 size={14} className="animate-spin text-orange-400" />
              Membaca data permukaan jalan…
            </p>
          ) : conditions?.available ? (
            <SurfaceSummary conditions={conditions} />
          ) : (
            <p className="text-[11px] text-slate-500">
              Data permukaan jalan tidak tersedia. Periksa koneksi internet lalu coba lagi.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function GradientStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-xl bg-slate-800/70 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-xl font-bold ${accent}`}>{value}</p>
    </div>
  );
}

function SurfaceSummary({ conditions }: { conditions: RoadConditions }) {
  return (
    <>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-800">
        {conditions.buckets.map((bucket) => (
          <span
            key={bucket.key}
            className={SURFACE_COLORS[bucket.key]}
            style={{ width: `${bucket.percent}%` }}
          />
        ))}
      </div>
      <ul className="mt-2 space-y-1">
        {conditions.buckets.map((bucket) => (
          <li key={bucket.key} className="flex items-center gap-2 text-[11px] text-slate-300">
            <span className={`h-2 w-2 shrink-0 rounded-full ${SURFACE_COLORS[bucket.key]}`} />
            <span className="flex-1">{bucket.label}</span>
            <span className="text-slate-400">{formatKm(bucket.distanceMeters)}</span>
            <span className="w-9 text-right font-semibold text-slate-200">
              {formatPercent(bucket.percent)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 120;
const CHART_PADDING = 6;

function TerrainProfileChart({
  samples,
  totalDistanceMeters,
}: {
  samples: GradientSample[];
  totalDistanceMeters: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const geometry = useMemo(() => {
    if (samples.length < 2) return null;

    const elevations = samples.map((sample) => sample.elevationMeters);
    const min = Math.min(...elevations);
    const max = Math.max(...elevations);
    const span = max - min || 1;
    const usableWidth = CHART_WIDTH - CHART_PADDING * 2;
    const usableHeight = CHART_HEIGHT - CHART_PADDING * 2;

    const toX = (distance: number) =>
      CHART_PADDING + (distance / (totalDistanceMeters || 1)) * usableWidth;
    const toY = (elevation: number) =>
      CHART_PADDING + usableHeight - ((elevation - min) / span) * usableHeight;

    const line = samples
      .map((sample) => `${toX(sample.distanceMeters).toFixed(2)},${toY(sample.elevationMeters).toFixed(2)}`)
      .join(' ');
    const area = `${CHART_PADDING},${CHART_HEIGHT - CHART_PADDING} ${line} ${
      CHART_WIDTH - CHART_PADDING
    },${CHART_HEIGHT - CHART_PADDING}`;

    return { line, area, min, max, toX, toY };
  }, [samples, totalDistanceMeters]);

  const pick = (clientX: number) => {
    const element = surfaceRef.current;
    if (!element || samples.length < 2) return;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    setActive(Math.round(ratio * (samples.length - 1)));
  };

  if (!geometry) {
    return (
      <div className="flex h-24 items-center justify-center rounded-xl bg-slate-800/60 text-[11px] text-slate-500">
        Profil elevasi tidak tersedia
      </div>
    );
  }

  const activeSample = active !== null ? samples[active] : null;
  const activeX = activeSample ? geometry.toX(activeSample.distanceMeters) : 0;
  const activeY = activeSample ? geometry.toY(activeSample.elevationMeters) : 0;
  const tooltipLeft = Math.min(Math.max((activeX / CHART_WIDTH) * 100, 18), 82);

  return (
    <div
      ref={surfaceRef}
      className="relative touch-none select-none overflow-hidden rounded-xl bg-slate-800/60"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        pick(event.clientX);
      }}
      onPointerMove={(event) => pick(event.clientX)}
      onPointerLeave={() => setActive(null)}
      onPointerCancel={() => setActive(null)}
    >
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        role="img"
        aria-label={`Profil elevasi ${Math.round(geometry.min)} sampai ${Math.round(geometry.max)} meter`}
      >
        <defs>
          <linearGradient id="terrain-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f97316" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#f97316" stopOpacity="0.03" />
          </linearGradient>
        </defs>

        <polygon points={geometry.area} fill="url(#terrain-fill)" />
        <polyline
          points={geometry.line}
          fill="none"
          stroke="#fb923c"
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {activeSample && (
          <>
            <line
              x1={activeX}
              y1={0}
              x2={activeX}
              y2={CHART_HEIGHT}
              stroke="#fde047"
              strokeWidth="1"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={activeX} cy={activeY} r="3.2" fill="#fde047" stroke="#0f172a" strokeWidth="1.2" />
          </>
        )}
      </svg>

      <span className="pointer-events-none absolute left-1.5 top-1 text-[9px] font-medium text-slate-400">
        {Math.round(geometry.max)} mdpl
      </span>
      <span className="pointer-events-none absolute bottom-1 left-1.5 text-[9px] font-medium text-slate-400">
        {Math.round(geometry.min)} mdpl
      </span>

      {activeSample && (
        <div
          className="pointer-events-none absolute top-1 -translate-x-1/2 rounded-lg border border-white/10 bg-slate-950/90 px-2 py-1 text-[10px] leading-tight text-slate-200 shadow-lg"
          style={{ left: `${tooltipLeft}%` }}
        >
          <p className="font-semibold text-orange-300">
            {(activeSample.distanceMeters / 1000).toFixed(2)} km
          </p>
          <p>{Math.round(activeSample.elevationMeters)} mdpl</p>
          <p className={activeSample.grade >= 0 ? 'text-amber-300' : 'text-emerald-300'}>
            {activeSample.grade > 0 ? '+' : ''}
            {activeSample.grade.toFixed(1)}%
          </p>
        </div>
      )}
    </div>
  );
}
