'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Crosshair, Flame, Loader2 } from 'lucide-react';
import {
  HEATMAP_SCHEMES,
  HEATMAP_TIME_FILTERS,
  HEATMAP_TYPE_FILTERS,
  type HeatmapScheme,
} from '@/lib/heatmapCache';
import type { HeatmapState } from '@/hooks/useHeatmap';

type Props = {
  heatmap: HeatmapState;
  /** Frames the filtered heatmap extent on the map. */
  onFocus: () => void;
};

export default function HeatmapControl({ heatmap, onFocus }: Props) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={heatmap.toggle}
        aria-pressed={heatmap.enabled}
        className={`flex w-fit items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold shadow-lg backdrop-blur transition active:scale-95 ${
          heatmap.enabled
            ? 'border-[#B9F51E]/60 bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]'
            : 'border-white/15 bg-[#151B1D]/90 text-slate-100'
        }`}
      >
        <Flame size={13} className={heatmap.enabled ? 'text-white' : 'text-[#B9F51E]'} />
        Heatmap
      </button>

      {heatmap.enabled && (
        <div className="rounded-2xl border border-white/10 bg-[#151B1D]/95 p-2.5 text-slate-100 shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[#B9F51E]">
              <Flame size={13} />
              Peta Panas Jelajah
            </span>
            <div className="flex items-center gap-1">
              {heatmap.loading && <Loader2 size={12} className="animate-spin text-slate-400" />}
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                aria-expanded={expanded}
                aria-label={expanded ? 'Tutup filter heatmap' : 'Buka filter heatmap'}
                className="rounded-full p-1 text-slate-300 transition active:bg-[#1E2E16]"
              >
                {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </button>
            </div>
          </div>

          {expanded && (
            <div className="mt-2 flex flex-col gap-2">
              <FilterRow label="Olahraga">
                {HEATMAP_TYPE_FILTERS.map(({ key, label }) => (
                  <Chip
                    key={key}
                    label={label}
                    selected={heatmap.activityType === key}
                    onClick={() => heatmap.setActivityType(key)}
                  />
                ))}
              </FilterRow>

              <FilterRow label="Waktu">
                {HEATMAP_TIME_FILTERS.map(({ key, label }) => (
                  <Chip
                    key={key}
                    label={label}
                    selected={heatmap.timeRange === key}
                    onClick={() => heatmap.setTimeRange(key)}
                  />
                ))}
              </FilterRow>

              <FilterRow label="Warna">
                {(Object.keys(HEATMAP_SCHEMES) as HeatmapScheme[]).map((key) => (
                  <Chip
                    key={key}
                    label={HEATMAP_SCHEMES[key].label}
                    selected={heatmap.scheme === key}
                    onClick={() => heatmap.setScheme(key)}
                    swatch={HEATMAP_SCHEMES[key].core}
                  />
                ))}
              </FilterRow>

              {heatmap.error && (
                <p className="text-[10px] text-rose-300" role="alert">
                  {heatmap.error}
                </p>
              )}

              <div className="flex items-center justify-between gap-2 pt-0.5">
                <p className="text-[10px] text-slate-400" role="status">
                  {heatmap.loading ? 'Memuat aktivitas…' : `${heatmap.count} aktivitas dipetakan`}
                </p>
                <button
                  type="button"
                  onClick={onFocus}
                  disabled={!heatmap.bounds}
                  className="flex items-center gap-1 rounded-full bg-[#B9F51E] hover:bg-[#A5E012] px-2.5 py-1 text-[10px] font-semibold text-[#0D1112] shadow transition active:scale-95 disabled:opacity-40"
                >
                  <Crosshair size={12} />
                  Pusatkan
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[9px] uppercase tracking-wide text-slate-400">{label}</p>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function Chip({
  label,
  selected,
  onClick,
  swatch,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  swatch?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold transition active:scale-95 ${
        selected ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]' : 'bg-[#1E2E16] text-slate-300'
      }`}
    >
      {swatch && (
        <span
          className="h-2 w-2 rounded-full border border-white/40"
          style={{ backgroundColor: swatch }}
          aria-hidden="true"
        />
      )}
      {label}
    </button>
  );
}
