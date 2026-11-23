'use client';

import { useMemo, useState } from 'react';
import { Bike, ChevronLeft, ChevronRight, Footprints, Mountain } from 'lucide-react';
import type { ActivityRecord } from '@/lib/activity';
import { formatDistanceKm, formatDuration } from '@/lib/metrics';
import { computeMonthlyBubbleCalendar, formatGoalValue } from '@/lib/trainingLog';
import { normalizeActivityType, type ActivityType } from '@/lib/valhalla';

const WEEKDAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

const SPORT_STYLES: Record<
  ActivityType,
  { bubble: string; legend: string; text: string; icon: React.ReactNode }
> = {
  cycling: {
    bubble: 'bg-[#B9F51E]/90',
    legend: 'bg-[#B9F51E] hover:bg-[#A5E012]',
    text: 'text-[#B9F51E]',
    icon: <Bike size={14} />,
  },
  run: {
    bubble: 'bg-emerald-500/90',
    legend: 'bg-emerald-500',
    text: 'text-emerald-300',
    icon: <Footprints size={14} />,
  },
  walking: {
    bubble: 'bg-sky-500/90',
    legend: 'bg-sky-500',
    text: 'text-sky-300',
    icon: <Footprints size={14} />,
  },
  hike: {
    bubble: 'bg-violet-500/90',
    legend: 'bg-violet-500',
    text: 'text-violet-300',
    icon: <Mountain size={14} />,
  },
};

const LEGEND: { sport: ActivityType; label: string }[] = [
  { sport: 'cycling', label: 'Cycling' },
  { sport: 'run', label: 'Run' },
  { sport: 'walking', label: 'Walking' },
  { sport: 'hike', label: 'Hike' },
];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatMonth(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString('id-ID', {
    month: 'long',
    year: 'numeric',
  });
}

function formatSelectedDate(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00`);
  return date.toLocaleDateString('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

type Props = {
  activities: ActivityRecord[];
  onOpen: (activity: ActivityRecord) => void;
};

/** Month grid where each active day is a bubble sized by that day's training volume. */
export default function BubbleCalendar({ activities, onOpen }: Props) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const days = useMemo(
    () => computeMonthlyBubbleCalendar(activities, cursor.year, cursor.month),
    [activities, cursor],
  );
  const dayMap = useMemo(
    () => new Map(days.map((day) => [day.dateKey, day])),
    [days],
  );
  const selectedDay = selectedKey ? dayMap.get(selectedKey) : undefined;

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const firstWeekday = (new Date(cursor.year, cursor.month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();

  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];

  const shiftMonth = (delta: number) => {
    setCursor((current) => {
      const next = new Date(current.year, current.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
    setSelectedKey(null);
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-[#151B1D]/80 p-3 shadow-lg">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          aria-label="Bulan sebelumnya"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1E2E16] text-slate-300 active:scale-95"
        >
          <ChevronLeft size={16} />
        </button>
        <p className="text-xs font-semibold text-slate-200">{formatMonth(cursor.year, cursor.month)}</p>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          aria-label="Bulan berikutnya"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1E2E16] text-slate-300 active:scale-95"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="mb-1 grid grid-cols-7 gap-1">
        {WEEKDAYS.map((label) => (
          <span
            key={label}
            className="text-center text-[9px] font-semibold uppercase tracking-wide text-slate-500"
          >
            {label}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((dayNumber, index) => {
          if (dayNumber === null) return <span key={`blank-${index}`} />;

          const dateKey = `${cursor.year}-${pad(cursor.month + 1)}-${pad(dayNumber)}`;
          const bubble = dayMap.get(dateKey);
          const isSelected = selectedKey === dateKey;

          if (!bubble) {
            return (
              <span
                key={dateKey}
                className={`flex h-11 items-center justify-center text-[10px] tabular-nums ${
                  dateKey === todayKey ? 'font-bold text-[#B9F51E]' : 'text-slate-600'
                }`}
              >
                {dayNumber}
              </span>
            );
          }

          const size = Math.round(18 + 16 * bubble.bubbleScale);
          return (
            <button
              key={dateKey}
              type="button"
              onClick={() => setSelectedKey(dateKey)}
              aria-pressed={isSelected}
              aria-label={`${formatSelectedDate(dateKey)}, ${bubble.activities.length} aktivitas`}
              className="flex h-11 items-center justify-center"
            >
              <span
                className={`flex items-center justify-center rounded-full text-[10px] font-bold tabular-nums text-white shadow transition-transform ${
                  SPORT_STYLES[bubble.primarySport].bubble
                } ${
                  isSelected
                    ? 'scale-110 ring-2 ring-white ring-offset-2 ring-offset-[#0D1112]'
                    : bubble.hasMultiple
                      ? 'ring-2 ring-white/60 ring-offset-2 ring-offset-[#0D1112]'
                      : ''
                }`}
                style={{ width: size, height: size }}
              >
                {dayNumber}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {LEGEND.map(({ sport, label }) => (
          <span key={sport} className="flex items-center gap-1 text-[9px] text-slate-400">
            <span className={`h-2 w-2 rounded-full ${SPORT_STYLES[sport].legend}`} />
            {label}
          </span>
        ))}
        <span className="flex items-center gap-1 text-[9px] text-slate-400">
          <span className="h-3 w-3 rounded-full border-2 border-white/60" />
          &gt;1 sesi
        </span>
      </div>

      {days.length === 0 && (
        <p className="mt-3 text-center text-[10px] text-slate-500">
          Belum ada aktivitas di bulan ini.
        </p>
      )}

      {selectedDay && (
        <div className="mt-2 rounded-xl bg-[#1E2E16]/50 p-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold capitalize text-slate-200">
              {formatSelectedDate(selectedDay.dateKey)}
            </p>
            <span className="shrink-0 text-[9px] tabular-nums text-slate-400">
              {selectedDay.activities.length} sesi •{' '}
              {formatGoalValue(selectedDay.totalDistanceKm, 'distance_km')}
            </span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {selectedDay.activities.map((activity) => (
              <li key={String(activity.id)}>
                <DayActivityCard activity={activity} onOpen={() => onOpen(activity)} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function DayActivityCard({
  activity,
  onOpen,
}: {
  activity: ActivityRecord;
  onOpen: () => void;
}) {
  const style = SPORT_STYLES[normalizeActivityType(activity.activityType)];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-lg bg-[#151B1D]/70 px-2 py-1.5 text-left active:scale-[0.99] active:bg-[#1E2E16]"
    >
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/5 ${style.text}`}>
        {style.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold text-slate-100">
          {activity.title}
        </span>
        <span className="block text-[9px] tabular-nums text-slate-400">
          {formatDistanceKm(activity.distanceMeters)} km •{' '}
          {formatDuration(activity.durationSeconds)} • +{Math.round(activity.elevationGain)} m
        </span>
      </span>
    </button>
  );
}
