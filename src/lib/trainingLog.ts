import type { ActivityRecord } from './activity';
import { normalizeActivityType, type ActivityType } from './valhalla';

export const PERSONAL_GOALS_KEY = 'personal_goals_v1';

/** 12 weeks is four bars per quarter: long enough to show a trend, short enough to read. */
export const WEEKLY_COMPARISON_WEEKS = 12;

export type GoalSport = 'all' | ActivityType;
export type GoalPeriod = 'weekly' | 'monthly' | 'yearly';
export type GoalMetric = 'distance_km' | 'duration_hours' | 'sessions';

export type PersonalGoal = {
  id: string;
  sportType: GoalSport;
  period: GoalPeriod;
  metric: GoalMetric;
  targetValue: number;
  createdAt: string;
};

export const GOAL_SPORTS: { key: GoalSport; label: string }[] = [
  { key: 'all', label: 'Semua Olahraga' },
  { key: 'cycling', label: 'Cycling' },
  { key: 'run', label: 'Run' },
  { key: 'walking', label: 'Walking' },
  { key: 'hike', label: 'Hike' },
];

export const GOAL_PERIODS: { key: GoalPeriod; label: string }[] = [
  { key: 'weekly', label: 'Mingguan' },
  { key: 'monthly', label: 'Bulanan' },
  { key: 'yearly', label: 'Tahunan' },
];

export const GOAL_METRICS: { key: GoalMetric; label: string; unit: string }[] = [
  { key: 'distance_km', label: 'Jarak', unit: 'km' },
  { key: 'duration_hours', label: 'Durasi', unit: 'jam' },
  { key: 'sessions', label: 'Frekuensi', unit: 'sesi' },
];

/** Quick-pick values, sized for the period and the unit. */
const GOAL_PRESETS: Record<GoalMetric, Record<GoalPeriod, number[]>> = {
  distance_km: {
    weekly: [20, 50, 100],
    monthly: [50, 250, 500],
    yearly: [1000, 3000, 5000],
  },
  duration_hours: {
    weekly: [3, 5, 10],
    monthly: [15, 30, 60],
    yearly: [150, 300, 600],
  },
  sessions: {
    weekly: [3, 5, 7],
    monthly: [12, 20, 30],
    yearly: [100, 200, 365],
  },
};

export function goalPresets(metric: GoalMetric, period: GoalPeriod): number[] {
  return GOAL_PRESETS[metric][period];
}

export function goalSportLabel(sport: GoalSport): string {
  return GOAL_SPORTS.find((option) => option.key === sport)?.label ?? 'Semua Olahraga';
}

export function goalPeriodLabel(period: GoalPeriod): string {
  return GOAL_PERIODS.find((option) => option.key === period)?.label ?? 'Mingguan';
}

export function goalMetricLabel(metric: GoalMetric): string {
  return GOAL_METRICS.find((option) => option.key === metric)?.label ?? 'Jarak';
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Indonesian formatting: `1.420` for 1420, `12,5` for 12.5. */
export function formatGoalValue(
  value: number,
  metric: GoalMetric,
  options: { withUnit?: boolean } = {},
): string {
  const safe = Number.isFinite(value) ? value : 0;
  const formatted = safe.toLocaleString('id-ID', {
    maximumFractionDigits: metric === 'sessions' ? 0 : 1,
  });
  if (options.withUnit === false) return formatted;
  if (metric === 'distance_km') return `${formatted} km`;
  if (metric === 'duration_hours') return `${formatted} jam`;
  return `${formatted} sesi`;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Monday 00:00 of the week containing `date`, in device-local time. */
export function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  const offset = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - offset);
  return day;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** `YYYY-MM-DD` from the device-local calendar, not from UTC. */
export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatDayMonth(date: Date): string {
  return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

function activityTime(activity: ActivityRecord): number | null {
  const stamp = Date.parse(activity.createdAt);
  return Number.isFinite(stamp) ? stamp : null;
}

function recordedActivities(activities: ActivityRecord[]): ActivityRecord[] {
  return activities.filter((activity) => !activity.isPlannedRoute);
}

function matchesSport(activity: ActivityRecord, sport: GoalSport): boolean {
  if (sport === 'all') return true;
  return normalizeActivityType(activity.activityType) === sport;
}

/** Whole calendar days between two local dates; UTC maths ignores DST shifts. */
function calendarDaysBetween(from: Date, to: Date): number {
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end - start) / 86400000);
}

export type GoalPeriodRange = {
  start: Date;
  /** Exclusive end: the first instant after the period. */
  end: Date;
  totalDays: number;
  elapsedDays: number;
};

/** Local-time window for a goal, with the day counts the pace check needs. */
export function goalPeriodRange(period: GoalPeriod, now: Date = new Date()): GoalPeriodRange {
  let start: Date;
  let end: Date;

  if (period === 'weekly') {
    start = startOfWeek(now);
    end = addDays(start, 7);
  } else if (period === 'monthly') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  } else {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear() + 1, 0, 1);
  }

  const totalDays = Math.max(1, calendarDaysBetween(start, end));
  const elapsedDays = clamp(calendarDaysBetween(start, now) + 1, 1, totalDays);

  return { start, end, totalDays, elapsedDays };
}

function metricValue(metric: GoalMetric, activities: ActivityRecord[]): number {
  if (metric === 'distance_km') {
    return activities.reduce((total, activity) => total + activity.distanceMeters, 0) / 1000;
  }
  if (metric === 'duration_hours') {
    return activities.reduce((total, activity) => total + activity.durationSeconds, 0) / 3600;
  }
  return activities.length;
}

export type GoalProgress = {
  goal: PersonalGoal;
  currentValue: number;
  targetValue: number;
  /** Uncapped so a 140% week still reads as such in the label. */
  percent: number;
  isCompleted: boolean;
  expectedValue: number;
  /** Positive when ahead of schedule, negative when behind. */
  delta: number;
  paceStatus: 'completed' | 'ahead' | 'behind';
  paceLabel: string;
  paceTone: 'green' | 'amber';
  periodLabel: string;
};

export function computeGoalProgress(
  goal: PersonalGoal,
  activities: ActivityRecord[],
  now: Date = new Date(),
): GoalProgress {
  const range = goalPeriodRange(goal.period, now);
  const startTime = range.start.getTime();
  const endTime = range.end.getTime();

  const scoped = recordedActivities(activities).filter((activity) => {
    if (!matchesSport(activity, goal.sportType)) return false;
    const stamp = activityTime(activity);
    return stamp !== null && stamp >= startTime && stamp < endTime;
  });

  const currentValue = round(metricValue(goal.metric, scoped));
  const targetValue = Math.max(0, goal.targetValue);
  const percent = targetValue > 0 ? round((currentValue / targetValue) * 100, 1) : 0;
  const isCompleted = targetValue > 0 && currentValue >= targetValue;
  const expectedValue = targetValue * (range.elapsedDays / range.totalDays);
  const delta = round(currentValue - expectedValue);

  let paceStatus: GoalProgress['paceStatus'];
  let paceLabel: string;
  let paceTone: GoalProgress['paceTone'];

  if (isCompleted) {
    paceStatus = 'completed';
    paceLabel = 'Target tercapai! 🎉';
    paceTone = 'green';
  } else if (currentValue >= expectedValue) {
    paceStatus = 'ahead';
    paceLabel = `Unggul +${formatGoalValue(Math.abs(delta), goal.metric)} dari jadwal`;
    paceTone = 'green';
  } else {
    paceStatus = 'behind';
    paceLabel = `Tertinggal ${formatGoalValue(Math.abs(delta), goal.metric)} dari jadwal`;
    paceTone = 'amber';
  }

  return {
    goal,
    currentValue,
    targetValue,
    percent,
    isCompleted,
    expectedValue: round(expectedValue),
    delta,
    paceStatus,
    paceLabel,
    paceTone,
    periodLabel: goalPeriodLabel(goal.period),
  };
}

export type WeeklyComparisonEntry = {
  weekKey: string;
  /** Short start-of-week label, e.g. `16 Nov`. */
  label: string;
  /** Full Monday–Sunday span, e.g. `16 Nov – 22 Nov`. */
  rangeText: string;
  isCurrentWeek: boolean;
  distanceKm: number;
  durationSeconds: number;
  elevationGain: number;
  sessionCount: number;
};

/** The last 12 Monday–Sunday weeks, oldest first; index 11 is the running week. */
export function computeWeeklyComparison(
  activities: ActivityRecord[],
  sport: GoalSport = 'all',
  now: Date = new Date(),
): WeeklyComparisonEntry[] {
  const recorded = recordedActivities(activities).filter((activity) => matchesSport(activity, sport));
  const currentWeekStart = startOfWeek(now);
  const weeks: WeeklyComparisonEntry[] = [];

  for (let offset = WEEKLY_COMPARISON_WEEKS - 1; offset >= 0; offset -= 1) {
    const start = addDays(currentWeekStart, -offset * 7);
    const end = addDays(start, 7);
    const startTime = start.getTime();
    const endTime = end.getTime();

    let meters = 0;
    let durationSeconds = 0;
    let elevationGain = 0;
    let sessionCount = 0;

    for (const activity of recorded) {
      const stamp = activityTime(activity);
      if (stamp === null || stamp < startTime || stamp >= endTime) continue;
      meters += activity.distanceMeters;
      durationSeconds += activity.durationSeconds;
      elevationGain += activity.elevationGain;
      sessionCount += 1;
    }

    weeks.push({
      weekKey: localDateKey(start),
      label: formatDayMonth(start),
      rangeText: `${formatDayMonth(start)} – ${formatDayMonth(addDays(start, 6))}`,
      isCurrentWeek: offset === 0,
      distanceKm: round(meters / 1000),
      durationSeconds,
      elevationGain: Math.round(elevationGain),
      sessionCount,
    });
  }

  return weeks;
}

export type BubbleDay = {
  dateKey: string;
  dayNumber: number;
  activities: ActivityRecord[];
  totalDistanceKm: number;
  totalDurationSeconds: number;
  primarySport: ActivityType;
  hasMultiple: boolean;
  /** 0.48 for the quietest active day, 1.0 for the busiest day of the month. */
  bubbleScale: number;
};

function primarySportOf(activities: ActivityRecord[]): ActivityType {
  const totals = new Map<ActivityType, { distance: number; duration: number }>();

  for (const activity of activities) {
    const sport = normalizeActivityType(activity.activityType);
    const current = totals.get(sport) ?? { distance: 0, duration: 0 };
    current.distance += activity.distanceMeters;
    current.duration += activity.durationSeconds;
    totals.set(sport, current);
  }

  let winner: ActivityType = 'cycling';
  let bestDistance = -1;
  let bestDuration = -1;

  for (const [sport, total] of Array.from(totals.entries())) {
    if (
      total.distance > bestDistance ||
      (total.distance === bestDistance && total.duration > bestDuration)
    ) {
      winner = sport;
      bestDistance = total.distance;
      bestDuration = total.duration;
    }
  }

  return winner;
}

/** Active days of one month, keyed by local date, with a proportional bubble size. */
export function computeMonthlyBubbleCalendar(
  activities: ActivityRecord[],
  year: number,
  month: number,
  sport: GoalSport = 'all',
): BubbleDay[] {
  const buckets = new Map<string, ActivityRecord[]>();

  for (const activity of recordedActivities(activities)) {
    if (!matchesSport(activity, sport)) continue;
    const stamp = activityTime(activity);
    if (stamp === null) continue;
    const date = new Date(stamp);
    if (date.getFullYear() !== year || date.getMonth() !== month) continue;
    const key = localDateKey(date);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(activity);
    else buckets.set(key, [activity]);
  }

  const days = Array.from(buckets.entries()).map(([dateKey, dayActivities]) => {
    dayActivities.sort((a, b) => (activityTime(a) ?? 0) - (activityTime(b) ?? 0));
    const totalDistanceKm = round(
      dayActivities.reduce((total, activity) => total + activity.distanceMeters, 0) / 1000,
    );
    const totalDurationSeconds = dayActivities.reduce(
      (total, activity) => total + activity.durationSeconds,
      0,
    );
    return {
      dateKey,
      dayNumber: Number(dateKey.slice(8, 10)),
      activities: dayActivities,
      totalDistanceKm,
      totalDurationSeconds,
      primarySport: primarySportOf(dayActivities),
      hasMultiple: dayActivities.length > 1,
      volume: totalDistanceKm > 0 ? totalDistanceKm : totalDurationSeconds / 3600,
    };
  });

  const maxVolume = days.reduce((max, day) => Math.max(max, day.volume), 0);

  return days
    .sort((a, b) => a.dayNumber - b.dayNumber)
    .map(({ volume, ...day }) => ({
      ...day,
      bubbleScale: round(maxVolume > 0 ? 0.48 + 0.52 * (volume / maxVolume) : 1),
    }));
}

/**
 * Consecutive weeks with at least one recorded activity. The running week
 * counts when it has activity; otherwise the streak may still be alive from
 * last week, so the count starts there instead of dropping to zero on Monday.
 */
export function computeWeeklyStreak(
  activities: ActivityRecord[],
  now: Date = new Date(),
): number {
  const weekKeys = new Set<string>();
  for (const activity of recordedActivities(activities)) {
    const stamp = activityTime(activity);
    if (stamp === null) continue;
    weekKeys.add(localDateKey(startOfWeek(new Date(stamp))));
  }

  let cursor = startOfWeek(now);
  if (!weekKeys.has(localDateKey(cursor))) cursor = addDays(cursor, -7);

  let streak = 0;
  while (weekKeys.has(localDateKey(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -7);
  }
  return streak;
}

/** The weekly distance goal that applies to the chart's active sport filter. */
export function findWeeklyDistanceGoal(
  goals: PersonalGoal[],
  sport: GoalSport,
): PersonalGoal | null {
  const candidates = goals.filter(
    (goal) => goal.period === 'weekly' && goal.metric === 'distance_km' && goal.targetValue > 0,
  );
  return (
    candidates.find((goal) => goal.sportType === sport) ??
    candidates.find((goal) => goal.sportType === 'all') ??
    null
  );
}

export function newPersonalGoal(
  input: Pick<PersonalGoal, 'sportType' | 'period' | 'metric' | 'targetValue'>,
): PersonalGoal {
  return {
    ...input,
    id: `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
}

function isGoalSport(value: unknown): value is GoalSport {
  return GOAL_SPORTS.some((option) => option.key === value);
}

function isGoalPeriod(value: unknown): value is GoalPeriod {
  return GOAL_PERIODS.some((option) => option.key === value);
}

function isGoalMetric(value: unknown): value is GoalMetric {
  return GOAL_METRICS.some((option) => option.key === value);
}

function parseGoal(value: unknown): PersonalGoal | null {
  if (!value || typeof value !== 'object') return null;
  const goal = value as Partial<PersonalGoal>;
  if (typeof goal.id !== 'string' || !goal.id) return null;
  if (!isGoalSport(goal.sportType) || !isGoalPeriod(goal.period) || !isGoalMetric(goal.metric)) {
    return null;
  }
  const targetValue = Number(goal.targetValue);
  if (!Number.isFinite(targetValue) || targetValue <= 0) return null;

  return {
    id: goal.id,
    sportType: goal.sportType,
    period: goal.period,
    metric: goal.metric,
    targetValue,
    createdAt: typeof goal.createdAt === 'string' ? goal.createdAt : new Date(0).toISOString(),
  };
}

export function loadPersonalGoals(): PersonalGoal[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PERSONAL_GOALS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseGoal)
      .filter((goal): goal is PersonalGoal => goal !== null);
  } catch {
    return [];
  }
}

function persistGoals(goals: PersonalGoal[]): PersonalGoal[] {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(PERSONAL_GOALS_KEY, JSON.stringify(goals));
    } catch {
      // Quota or private mode: keep the goals for this session.
    }
  }
  return goals;
}

/** Inserts or replaces one goal, returning the whole list for React state. */
export function savePersonalGoal(goal: PersonalGoal): PersonalGoal[] {
  const goals = loadPersonalGoals();
  const exists = goals.some((entry) => entry.id === goal.id);
  return persistGoals(
    exists ? goals.map((entry) => (entry.id === goal.id ? goal : entry)) : [...goals, goal],
  );
}

export function deletePersonalGoal(id: string): PersonalGoal[] {
  return persistGoals(loadPersonalGoals().filter((goal) => goal.id !== id));
}
