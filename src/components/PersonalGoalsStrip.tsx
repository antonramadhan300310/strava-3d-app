'use client';

import { useMemo, useState } from 'react';
import { Bike, Footprints, Mountain, Plus, Target, Trash2, X } from 'lucide-react';
import type { ActivityRecord } from '@/lib/activity';
import {
  GOAL_METRICS,
  GOAL_PERIODS,
  GOAL_SPORTS,
  computeGoalProgress,
  formatGoalValue,
  goalPeriodLabel,
  goalPresets,
  goalSportLabel,
  newPersonalGoal,
  type GoalMetric,
  type GoalPeriod,
  type GoalSport,
  type PersonalGoal,
} from '@/lib/trainingLog';

const SPORT_ICONS: Record<GoalSport, React.ReactNode> = {
  all: <Target size={15} />,
  cycling: <Bike size={15} />,
  run: <Footprints size={15} />,
  walking: <Footprints size={15} />,
  hike: <Mountain size={15} />,
};

const PERIOD_BADGE: Record<GoalPeriod, string> = {
  weekly: 'border-orange-400/40 bg-orange-500/15 text-orange-300',
  monthly: 'border-sky-400/40 bg-sky-500/15 text-sky-300',
  yearly: 'border-violet-400/40 bg-violet-500/15 text-violet-300',
};

function metricUnit(metric: GoalMetric): string {
  return GOAL_METRICS.find((option) => option.key === metric)?.unit ?? '';
}

type Props = {
  goals: PersonalGoal[];
  activities: ActivityRecord[];
  onSave: (goal: PersonalGoal) => void;
  onDelete: (id: string) => void;
};

/** Horizontal strip of personal goals under the heatmap shortcut. */
export default function PersonalGoalsStrip({ goals, activities, onSave, onDelete }: Props) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<PersonalGoal | null>(null);
  const [sport, setSport] = useState<GoalSport>('all');
  const [period, setPeriod] = useState<GoalPeriod>('weekly');
  const [metric, setMetric] = useState<GoalMetric>('distance_km');
  const [target, setTarget] = useState('20');

  const openCreate = () => {
    setEditingGoal(null);
    setSport('all');
    setPeriod('weekly');
    setMetric('distance_km');
    setTarget(String(goalPresets('distance_km', 'weekly')[0]));
    setEditorOpen(true);
  };

  const openEdit = (goal: PersonalGoal) => {
    setEditingGoal(goal);
    setSport(goal.sportType);
    setPeriod(goal.period);
    setMetric(goal.metric);
    setTarget(String(goal.targetValue));
    setEditorOpen(true);
  };

  const changePeriod = (next: GoalPeriod) => {
    setPeriod(next);
    setTarget(String(goalPresets(metric, next)[0]));
  };

  const changeMetric = (next: GoalMetric) => {
    setMetric(next);
    setTarget(String(goalPresets(next, period)[0]));
  };

  const parsedTarget = Number(target.replace(',', '.'));
  const canSave = Number.isFinite(parsedTarget) && parsedTarget > 0;

  const handleSave = () => {
    if (!canSave) return;
    const goal = editingGoal
      ? { ...editingGoal, sportType: sport, period, metric, targetValue: parsedTarget }
      : newPersonalGoal({ sportType: sport, period, metric, targetValue: parsedTarget });
    onSave(goal);
    setEditorOpen(false);
  };

  const handleDelete = () => {
    if (!editingGoal) return;
    onDelete(editingGoal.id);
    setEditorOpen(false);
  };

  return (
    <>
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between px-0.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Target Pribadi
          </p>
          <span className="text-[10px] text-slate-500">{goals.length} target</span>
        </div>

        <div className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {goals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              activities={activities}
              onPress={() => openEdit(goal)}
            />
          ))}
          <button
            type="button"
            onClick={openCreate}
            className="flex w-[92px] shrink-0 snap-start flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-white/20 bg-slate-900/50 py-3 text-slate-400 transition active:scale-[0.98] active:bg-slate-800/60"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/15 text-orange-400">
              <Plus size={16} />
            </span>
            <span className="text-[11px] font-semibold">+ Target</span>
          </button>
        </div>
      </div>

      {editorOpen && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-slate-950/75 backdrop-blur-sm">
          <button
            type="button"
            aria-label="Tutup editor target"
            onClick={() => setEditorOpen(false)}
            className="absolute inset-0"
          />
          <div className="relative max-h-[88vh] overflow-y-auto overscroll-contain rounded-t-3xl border-t border-white/10 bg-slate-900 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 shadow-2xl">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/15" />
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">
                {editingGoal ? 'Edit Target' : 'Target Baru'}
              </h2>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                aria-label="Tutup"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-slate-300 active:scale-95"
              >
                <X size={16} />
              </button>
            </div>

            <Field label="Olahraga">
              <div className="flex flex-wrap gap-1.5">
                {GOAL_SPORTS.map((option) => (
                  <Chip
                    key={option.key}
                    selected={sport === option.key}
                    onClick={() => setSport(option.key)}
                    icon={SPORT_ICONS[option.key]}
                  >
                    {option.label}
                  </Chip>
                ))}
              </div>
            </Field>

            <Field label="Periode">
              <div className="flex gap-1.5">
                {GOAL_PERIODS.map((option) => (
                  <Chip
                    key={option.key}
                    selected={period === option.key}
                    onClick={() => changePeriod(option.key)}
                    grow
                  >
                    {option.label}
                  </Chip>
                ))}
              </div>
            </Field>

            <Field label="Satuan">
              <div className="flex gap-1.5">
                {GOAL_METRICS.map((option) => (
                  <Chip
                    key={option.key}
                    selected={metric === option.key}
                    onClick={() => changeMetric(option.key)}
                    grow
                  >
                    {option.label}
                  </Chip>
                ))}
              </div>
            </Field>

            <Field label="Angka Target">
              <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-slate-950 px-3 py-2 focus-within:border-orange-500">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  className="w-full bg-transparent text-lg font-bold tabular-nums text-slate-100 outline-none"
                  aria-label="Angka target"
                />
                <span className="shrink-0 text-xs font-semibold text-slate-400">
                  {metricUnit(metric)}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {goalPresets(metric, period).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setTarget(String(preset))}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold tabular-nums transition active:scale-95 ${
                      parsedTarget === preset
                        ? 'border-orange-500/60 bg-orange-500/20 text-orange-300'
                        : 'border-white/10 bg-slate-800/70 text-slate-300'
                    }`}
                  >
                    {formatGoalValue(preset, metric, { withUnit: false })}
                  </button>
                ))}
              </div>
            </Field>

            <div className="mt-4 flex gap-2">
              {editingGoal && (
                <button
                  type="button"
                  onClick={handleDelete}
                  className="flex items-center justify-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2.5 text-sm font-semibold text-rose-300 active:scale-[0.98]"
                >
                  <Trash2 size={15} />
                  Hapus
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className="flex-1 rounded-xl bg-orange-500 py-2.5 text-sm font-semibold text-white shadow-lg transition active:scale-[0.98] disabled:opacity-40"
              >
                Simpan Target
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function GoalCard({
  goal,
  activities,
  onPress,
}: {
  goal: PersonalGoal;
  activities: ActivityRecord[];
  onPress: () => void;
}) {
  const progress = useMemo(() => computeGoalProgress(goal, activities), [goal, activities]);
  const width = Math.min(100, Math.max(0, progress.percent));
  const barClass =
    progress.paceTone === 'green'
      ? 'bg-gradient-to-r from-emerald-500 to-emerald-400'
      : 'bg-gradient-to-r from-amber-500 to-orange-400';
  const pillClass =
    progress.paceTone === 'green'
      ? 'bg-emerald-500/15 text-emerald-300'
      : 'bg-amber-500/15 text-amber-300';

  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={`Edit target ${goalSportLabel(goal.sportType)}`}
      className="w-[204px] shrink-0 snap-start rounded-2xl border border-white/10 bg-slate-900/80 p-2.5 text-left shadow-lg transition active:scale-[0.98]"
    >
      <div className="flex items-center justify-between gap-1.5">
        <span
          className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold ${PERIOD_BADGE[goal.period]}`}
        >
          {goalPeriodLabel(goal.period)}
        </span>
        <span className="flex items-center gap-1 text-[10px] font-semibold text-slate-300">
          <span className="text-orange-400">{SPORT_ICONS[goal.sportType]}</span>
          {goalSportLabel(goal.sportType)}
        </span>
      </div>

      <p className="mt-2 text-sm font-bold tabular-nums text-slate-100">
        {formatGoalValue(progress.currentValue, goal.metric, { withUnit: false })}
        <span className="text-slate-500"> / </span>
        {formatGoalValue(progress.targetValue, goal.metric)}
      </p>

      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${width}%` }} />
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-1">
        <span
          title={progress.paceLabel}
          className={`min-w-0 truncate rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${pillClass}`}
        >
          {progress.paceLabel}
        </span>
        <span className="shrink-0 text-[9px] font-bold tabular-nums text-slate-500">
          {Math.round(progress.percent)}%
        </span>
      </div>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      {children}
    </div>
  );
}

function Chip({
  selected,
  onClick,
  children,
  icon,
  grow = false,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
  grow?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex items-center justify-center gap-1 rounded-full border px-2.5 py-1.5 text-[11px] font-semibold transition active:scale-95 ${
        grow ? 'flex-1' : ''
      } ${
        selected
          ? 'border-orange-500/60 bg-orange-500/20 text-orange-200'
          : 'border-white/10 bg-slate-800/70 text-slate-300'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
