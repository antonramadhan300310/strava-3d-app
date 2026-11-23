'use client';

import { useMemo } from 'react';
import type { ActivityRecord } from '@/lib/activity';
import { formatDuration } from '@/lib/metrics';
import {
  computeWeeklyComparison,
  computeWeeklyStreak,
  formatGoalValue,
  type PersonalGoal,
} from '@/lib/trainingLog';
import WeeklyBarChart from './WeeklyBarChart';
import BubbleCalendar from './BubbleCalendar';

type Props = {
  activities: ActivityRecord[];
  goals: PersonalGoal[];
  onOpen: (activity: ActivityRecord) => void;
};

/** Training Log tab: streak recap, 12-week bars and the monthly bubble calendar. */
export default function TrainingLogView({ activities, goals, onOpen }: Props) {
  const streak = useMemo(() => computeWeeklyStreak(activities), [activities]);
  const currentWeek = useMemo(
    () => computeWeeklyComparison(activities, 'all')[11],
    [activities],
  );

  return (
    <div className="flex flex-col gap-2.5">
      <section className="rounded-2xl border border-orange-500/25 bg-gradient-to-br from-slate-900 via-slate-900 to-orange-950/40 p-3 shadow-xl">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 rounded-full border border-orange-400/40 bg-orange-500/15 px-2.5 py-1 text-[11px] font-bold text-orange-300">
            🔥 {streak} Minggu Beruntun
          </span>
          <span className="shrink-0 text-[9px] uppercase tracking-wide text-slate-400">
            Minggu ini
          </span>
        </div>

        <div className="mt-2 grid grid-cols-3 gap-1.5">
          <RecapStat label="Jarak" value={formatGoalValue(currentWeek.distanceKm, 'distance_km')} />
          <RecapStat label="Durasi" value={formatDuration(currentWeek.durationSeconds)} />
          <RecapStat label="Elevasi" value={`${currentWeek.elevationGain} m`} />
        </div>

        {streak === 0 && (
          <p className="mt-1.5 text-[10px] text-slate-500">
            Rekam aktivitas minggu ini untuk memulai streak baru.
          </p>
        )}
      </section>

      <WeeklyBarChart activities={activities} goals={goals} />
      <BubbleCalendar activities={activities} onOpen={onOpen} />
    </div>
  );
}

function RecapStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-800/60 px-1 py-1.5 text-center">
      <p className="text-[9px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-[11px] font-bold tabular-nums text-slate-100">{value}</p>
    </div>
  );
}
