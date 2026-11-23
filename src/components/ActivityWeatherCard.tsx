'use client';

import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSun,
  Droplets,
  Sun,
  Wind,
  type LucideIcon,
} from 'lucide-react';
import type { ActivityWeather, WeatherIconType } from '@/lib/weatherService';

const WEATHER_ICONS: Record<WeatherIconType, LucideIcon> = {
  clear: Sun,
  'partly-cloudy': CloudSun,
  cloudy: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  thunderstorm: CloudLightning,
};

const ICON_TONES: Record<WeatherIconType, string> = {
  clear: 'bg-amber-400/15 text-amber-300',
  'partly-cloudy': 'bg-amber-300/10 text-amber-200',
  cloudy: 'bg-slate-400/10 text-slate-300',
  fog: 'bg-slate-400/10 text-slate-300',
  drizzle: 'bg-sky-400/10 text-sky-300',
  rain: 'bg-sky-400/15 text-sky-300',
  thunderstorm: 'bg-violet-400/15 text-violet-300',
};

type Props = {
  weather: ActivityWeather | null;
  /** Shows a skeleton while a historical activity is being resolved. */
  loading?: boolean;
};

export default function ActivityWeatherCard({ weather, loading = false }: Props) {
  if (!weather) {
    return loading ? <WeatherSkeleton /> : null;
  }

  const Icon = WEATHER_ICONS[weather.iconType] ?? Cloud;
  const tone = ICON_TONES[weather.iconType] ?? ICON_TONES.cloudy;

  return (
    <div className="mt-2.5 rounded-xl border border-white/10 bg-slate-800/60 p-2.5">
      <p className="mb-2 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
        <CloudSun size={11} />
        Cuaca Saat Aktivitas
      </p>

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${tone}`}
            aria-hidden="true"
          >
            <Icon size={22} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <p className="text-[22px] font-bold leading-none tabular-nums text-slate-100">
              {weather.temperatureC}°C
            </p>
            <p className="mt-1 truncate text-[11px] font-semibold text-slate-200">
              {weather.conditionLabel}
            </p>
            <p className="text-[10px] text-slate-400">Terasa {weather.apparentTemperatureC}°C</p>
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-1.5">
          <WeatherStat
            icon={<Wind size={11} />}
            label="Angin"
            value={`${weather.windSpeedKmh} km/jam • ${weather.windDirectionLabel}`}
          />
          <WeatherStat
            icon={<Droplets size={11} />}
            label="Kelembapan"
            value={`${weather.humidityPercent}%`}
          />
        </div>
      </div>
    </div>
  );
}

function WeatherStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-slate-400">
        {icon}
        {label}
      </span>
      <span className="whitespace-nowrap text-[10px] font-semibold text-slate-100">{value}</span>
    </div>
  );
}

function WeatherSkeleton() {
  return (
    <div
      className="mt-2.5 animate-pulse rounded-xl border border-white/10 bg-slate-800/60 p-2.5"
      aria-hidden="true"
    >
      <div className="mb-2 h-2.5 w-28 rounded bg-slate-700/60" />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="h-11 w-11 rounded-full bg-slate-700/70" />
          <div className="space-y-1.5">
            <div className="h-5 w-14 rounded bg-slate-700/70" />
            <div className="h-2.5 w-20 rounded bg-slate-700/60" />
            <div className="h-2 w-16 rounded bg-slate-700/50" />
          </div>
        </div>
        <div className="space-y-2">
          <div className="h-2.5 w-24 rounded bg-slate-700/60" />
          <div className="h-2.5 w-20 rounded bg-slate-700/50" />
        </div>
      </div>
    </div>
  );
}
