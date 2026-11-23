'use client';

import { useState } from 'react';
import { Gauge, Pencil, Plus } from 'lucide-react';
import { RPE_SCALE, computeRelativeEffort, rpeLabel } from '@/lib/powerAndEffort';

type Props = {
  rpe: number | null;
  durationSeconds: number;
  onChange: (rpe: number) => void;
};

const CATEGORY_TONES: Record<string, string> = {
  Ringan: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  Sedang: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  Tinggi: 'border-orange-400/30 bg-orange-400/10 text-orange-300',
  'Sangat Tinggi': 'border-rose-400/30 bg-rose-400/10 text-rose-300',
};

export default function ActivityRpeCard({ rpe, durationSeconds, onChange }: Props) {
  const [editing, setEditing] = useState(false);
  const effort = rpe !== null ? computeRelativeEffort(durationSeconds, rpe) : null;
  const showPicker = editing || rpe === null;

  const select = (value: number) => {
    onChange(value);
    setEditing(false);
  };

  return (
    <section className="mt-2.5 rounded-xl border border-white/10 bg-slate-800/60 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
          <Gauge size={11} />
          Tingkat Usaha & Beban Latihan
        </p>
        {effort && !showPicker && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex items-center gap-1 rounded-full bg-slate-700/60 px-2 py-0.5 text-[10px] font-semibold text-slate-200 active:scale-95"
          >
            <Pencil size={10} />
            Ubah
          </button>
        )}
      </div>

      {effort && !showPicker ? (
        <div className="mt-2">
          <div className="flex items-end justify-between gap-2">
            <div>
              <p className="text-[22px] font-bold leading-none tabular-nums text-slate-100">
                {effort.rpe}
                <span className="text-sm font-semibold text-slate-400">/10</span>
              </p>
              <p className="mt-1 text-[11px] font-semibold text-slate-200">{effort.label}</p>
            </div>
            <div className="text-right">
              <span
                className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                  CATEGORY_TONES[effort.category] ?? CATEGORY_TONES.Sedang
                }`}
              >
                Beban Latihan: {effort.score}
              </span>
              <p className="mt-1 text-[9px] uppercase tracking-wide text-slate-500">
                Intensitas {effort.category}
              </p>
            </div>
          </div>

          <div className="relative mt-3 h-2 rounded-full bg-gradient-to-r from-emerald-500 via-amber-400 to-rose-500">
            <span
              className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-900 bg-white shadow"
              style={{ left: `${((effort.rpe - 1) / 9) * 100}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[9px] text-slate-500">
            <span>1 Sangat Ringan</span>
            <span>10 Maksimal</span>
          </div>
        </div>
      ) : (
        <div className="mt-2">
          {rpe === null && !editing ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/20 py-2 text-[11px] font-semibold text-slate-300 active:scale-[0.99]"
            >
              <Plus size={13} />
              Nilai Usaha (RPE 1–10)
            </button>
          ) : (
            <>
              <div className="grid grid-cols-5 gap-1" role="group" aria-label="RPE 1 sampai 10">
                {RPE_SCALE.map((entry) => {
                  const selected = rpe === entry.value;
                  return (
                    <button
                      key={entry.value}
                      type="button"
                      aria-pressed={selected}
                      aria-label={`RPE ${entry.value}: ${entry.label}`}
                      onClick={() => select(entry.value)}
                      className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                        selected
                          ? 'bg-orange-500 text-white'
                          : 'bg-slate-700/60 text-slate-200 active:bg-slate-600'
                      }`}
                    >
                      {entry.value}
                    </button>
                  );
                })}
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-400">
                <span>{rpe !== null ? `${rpe}/10 • ${rpeLabel(rpe)}` : 'Pilih 1–10'}</span>
                {rpe !== null && (
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="font-semibold text-slate-300 active:scale-95"
                  >
                    Batal
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
