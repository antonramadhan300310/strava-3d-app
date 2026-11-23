'use client';

import { Settings2, Zap } from 'lucide-react';
import type { CyclingPowerAnalysis } from '@/lib/powerAndEffort';

type Props = {
  analysis: CyclingPowerAnalysis;
  onOpenProfile: () => void;
};

export default function VirtualPowerCard({ analysis, onOpenProfile }: Props) {
  const peak = analysis.peak20MinWatts;

  return (
    <section className="mt-2.5 rounded-xl border border-sky-400/25 bg-gradient-to-br from-slate-900 via-slate-900 to-sky-950/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
          <Zap size={11} className="text-sky-300" />
          Estimasi Daya
        </p>
        <button
          type="button"
          onClick={onOpenProfile}
          className="flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[10px] font-semibold text-sky-300 active:scale-95"
        >
          <Settings2 size={10} />
          Profil &amp; FTP
        </button>
      </div>

      <dl className="mt-2 grid grid-cols-4 gap-1">
        <PowerMetric label="Rata-rata" value={`${analysis.avgPowerWatts}`} unit="W" />
        <PowerMetric label="NP" value={`${analysis.normalizedPowerWatts}`} unit="W" />
        <PowerMetric label="Rasio" value={`${analysis.wattsPerKg}`} unit="W/kg" />
        <PowerMetric label="TSS" value={`${analysis.tss}`} unit="" />
      </dl>

      {peak !== null && (
        <div className="mt-2 flex">
          <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[10px] font-semibold text-sky-200">
            Peak 20m: {peak} W
          </span>
        </div>
      )}

      <div className="mt-2 flex flex-col gap-1">
        <div className="flex items-center justify-between text-[9px] uppercase tracking-wide text-slate-500">
          <span>Distribusi Zona Daya</span>
          <span>Durasi • %</span>
        </div>
        {analysis.zones.map((zone) => (
          <div key={zone.zone} className="flex items-center gap-1.5">
            <span className="w-[4.6rem] shrink-0 truncate text-[9px] font-semibold" style={{ color: zone.color }}>
              {zone.zone} {zone.name}
            </span>
            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(zone.seconds > 0 ? 2 : 0, Math.min(100, zone.percent))}%`,
                  backgroundColor: zone.color,
                }}
              />
            </div>
            <span className="w-[3.4rem] shrink-0 text-right text-[9px] tabular-nums text-slate-300">
              {(zone.seconds / 60).toFixed(1)} mnt
            </span>
            <span className="w-8 shrink-0 text-right text-[9px] tabular-nums text-slate-400">
              {zone.percent}%
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function PowerMetric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg bg-slate-800/70 px-1 py-1.5">
      <dt className="text-[8px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-[11px] font-bold tabular-nums text-slate-100">
        {value}
        {unit && <span className="ml-0.5 text-[8px] font-normal text-slate-400">{unit}</span>}
      </dd>
    </div>
  );
}
