'use client';

import { useMemo, useState } from 'react';
import type { ActivityRecord } from '@/lib/activity';
import { formatDuration } from '@/lib/metrics';
import {
  computeWeeklyComparison,
  findWeeklyDistanceGoal,
  formatGoalValue,
  type GoalSport,
  type PersonalGoal,
} from '@/lib/trainingLog';

const SPORT_FILTERS: { key: GoalSport; label: string }[] = [
  { key: 'all', label: 'Semua' },
  { key: 'cycling', label: 'Cycling' },
  { key: 'run', label: 'Run' },
  { key: 'walking', label: 'Walking' },
  { key: 'hike', label: 'Hike' },
];

type Props = {
  activities: ActivityRecord[];
  goals: PersonalGoal[];
};

/** Twelve Monday–Sunday bars, with the active week's weekly distance target overlaid. */
export default function WeeklyBarChart({ activities, goals }: Props) {
  const [sport, setSport] = useState<GoalSport>('all');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(11);

  const weeks = useMemo(() => computeWeeklyComparison(activities, sport), [activities, sport]);
  const weeklyGoal = useMemo(() => findWeeklyDistanceGoal(goals, sport), [goals, sport]);

  const maxDistance = Math.max(
    ...weeks.map((week) => week.distanceKm),
    weeklyGoal?.targetValue ?? 0,
    1,
  );
  const targetPercent = weeklyGoal
    ? Math.min(100, (weeklyGoal.targetValue / maxDistance) * 100)
    : null;
  const selectedWeek = selectedIndex !== null ? weeks[selectedIndex] : undefined;
  const totalSessions = weeks.reduce((total, week) => total + week.sessionCount, 0);

  return (
    <section className="rounded-2xl border border-white/10 bg-[#151B1D]/80 p-3 shadow-lg">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-200">Perbandingan 12 Minggu</p>
        <span className="text-[10px] text-slate-500">Jarak (km)</span>
      </div>

      <div className="-mx-1 mb-2 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {SPORT_FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={sport === option.key}
            onClick={() => setSport(option.key)}
            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold transition active:scale-95 ${
              sport === option.key
                ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]'
                : 'bg-[#1E2E16]/80 text-slate-300'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {totalSessions === 0 ? (
        <p className="py-6 text-center text-[11px] text-slate-500">
          Belum ada aktivitas pada 12 minggu terakhir untuk filter ini.
        </p>
      ) : (
        <>
          <div className="relative mt-3 h-32">
            {weeklyGoal && targetPercent !== null && (
              <div
                className="pointer-events-none absolute inset-x-0 z-10"
                style={{ bottom: `${targetPercent}%` }}
              >
                <div className="border-t border-dashed border-emerald-400/80" />
                <span className="absolute -top-3 right-0 rounded bg-emerald-500/20 px-1 py-0.5 text-[8px] font-bold text-emerald-300">
                  Target {formatGoalValue(weeklyGoal.targetValue, 'distance_km')}
                </span>
              </div>
            )}

            <div className="flex h-full items-end gap-1">
              {weeks.map((week, index) => {
                const isSelected = selectedIndex === index;
                const height = week.distanceKm > 0
                  ? Math.max(4, (week.distanceKm / maxDistance) * 100)
                  : 1.5;
                return (
                  <button
                    key={week.weekKey}
                    type="button"
                    onClick={() => setSelectedIndex(index)}
                    aria-pressed={isSelected}
                    aria-label={`Minggu ${week.rangeText}, ${formatGoalValue(week.distanceKm, 'distance_km')}`}
                    className="flex h-full flex-1 flex-col items-stretch justify-end rounded-t-[4px] focus:outline-none"
                  >
                    <span
                      className={`w-full rounded-t-[3px] transition-all ${
                        week.isCurrentWeek
                          ? 'bg-[#B9F51E] hover:bg-[#A5E012]'
                          : isSelected
                            ? 'bg-[#A5E012]/70'
                            : 'bg-slate-600/80'
                      } ${isSelected ? 'ring-1 ring-white/70' : ''}`}
                      style={{ height: `${height}%` }}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-1 flex gap-1">
            {weeks.map((week, index) => (
              <span
                key={`${week.weekKey}-label`}
                className={`flex-1 text-center text-[7px] font-semibold tabular-nums ${
                  index === selectedIndex
                    ? 'text-[#B9F51E]'
                    : week.isCurrentWeek
                      ? 'text-slate-300'
                      : 'text-slate-500'
                }`}
              >
                {week.label.split(/\s+/)[0]}
              </span>
            ))}
          </div>

          {selectedWeek && (
            <div className="mt-2 rounded-xl bg-[#1E2E16]/60 px-2.5 py-2">
              <p className="text-[10px] font-semibold text-slate-200">
                Minggu {selectedWeek.rangeText}:
              </p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">
                {formatGoalValue(selectedWeek.distanceKm, 'distance_km')} •{' '}
                {formatDuration(selectedWeek.durationSeconds)} • +
                {selectedWeek.elevationGain} m • {selectedWeek.sessionCount} sesi
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
