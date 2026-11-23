import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActivityRecord } from './activity';
import { timestampOf, type LngLatEle } from './polyline';

export type WeatherIconType =
  | 'clear'
  | 'partly-cloudy'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'thunderstorm';

export type ActivityWeather = {
  temperatureC: number;
  apparentTemperatureC: number;
  humidityPercent: number;
  windSpeedKmh: number;
  windDirectionDeg: number;
  windDirectionLabel: string;
  weatherCode: number;
  conditionLabel: string;
  iconType: WeatherIconType;
  fetchedAt: string;
};

export const WEATHER_CACHE_KEY = 'tracker3d_activity_weather_v1';

const HOURLY_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
].join(',');

const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_ENDPOINT = 'https://archive-api.open-meteo.com/v1/archive';
/** Open-Meteo's forecast endpoint can look back this many days. */
const RECENT_WINDOW_DAYS = 5;

const ICON_TYPES: WeatherIconType[] = [
  'clear',
  'partly-cloudy',
  'cloudy',
  'fog',
  'drizzle',
  'rain',
  'thunderstorm',
];

const WIND_DIRECTIONS = [
  'Utara',
  'Timur Laut',
  'Timur',
  'Tenggara',
  'Selatan',
  'Barat Daya',
  'Barat',
  'Barat Laut',
] as const;

type WeatherDescriptor = { label: string; iconType: WeatherIconType };

const WMO_DESCRIPTORS: Record<number, WeatherDescriptor> = {
  0: { label: 'Cerah', iconType: 'clear' },
  1: { label: 'Cerah Berawan', iconType: 'partly-cloudy' },
  2: { label: 'Cerah Berawan', iconType: 'partly-cloudy' },
  3: { label: 'Mendung', iconType: 'cloudy' },
  45: { label: 'Kabut', iconType: 'fog' },
  48: { label: 'Kabut', iconType: 'fog' },
  51: { label: 'Gerimis', iconType: 'drizzle' },
  53: { label: 'Gerimis', iconType: 'drizzle' },
  55: { label: 'Gerimis', iconType: 'drizzle' },
  56: { label: 'Gerimis', iconType: 'drizzle' },
  57: { label: 'Gerimis', iconType: 'drizzle' },
  61: { label: 'Hujan', iconType: 'rain' },
  63: { label: 'Hujan', iconType: 'rain' },
  65: { label: 'Hujan', iconType: 'rain' },
  66: { label: 'Hujan', iconType: 'rain' },
  67: { label: 'Hujan', iconType: 'rain' },
  71: { label: 'Hujan Es', iconType: 'cloudy' },
  73: { label: 'Hujan Es', iconType: 'cloudy' },
  75: { label: 'Hujan Es', iconType: 'cloudy' },
  77: { label: 'Hujan Es', iconType: 'cloudy' },
  80: { label: 'Hujan', iconType: 'rain' },
  81: { label: 'Hujan', iconType: 'rain' },
  82: { label: 'Hujan', iconType: 'rain' },
  85: { label: 'Hujan Es', iconType: 'cloudy' },
  86: { label: 'Hujan Es', iconType: 'cloudy' },
  95: { label: 'Badai Petir', iconType: 'thunderstorm' },
  96: { label: 'Badai Petir', iconType: 'thunderstorm' },
  99: { label: 'Badai Petir', iconType: 'thunderstorm' },
};

const UNKNOWN_DESCRIPTOR: WeatherDescriptor = { label: 'Tidak Diketahui', iconType: 'cloudy' };

export function describeWeatherCode(code: number): WeatherDescriptor {
  return WMO_DESCRIPTORS[code] ?? UNKNOWN_DESCRIPTOR;
}

export function windDirectionLabel(degrees: number): string {
  if (!Number.isFinite(degrees)) return WIND_DIRECTIONS[0];
  const normalized = ((degrees % 360) + 360) % 360;
  return WIND_DIRECTIONS[Math.round(normalized / 45) % 8];
}

export function isActivityWeather(value: unknown): value is ActivityWeather {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActivityWeather>;
  return (
    typeof candidate.temperatureC === 'number' &&
    typeof candidate.apparentTemperatureC === 'number' &&
    typeof candidate.humidityPercent === 'number' &&
    typeof candidate.windSpeedKmh === 'number' &&
    typeof candidate.windDirectionDeg === 'number' &&
    typeof candidate.windDirectionLabel === 'string' &&
    typeof candidate.weatherCode === 'number' &&
    typeof candidate.conditionLabel === 'string' &&
    typeof candidate.iconType === 'string' &&
    ICON_TYPES.includes(candidate.iconType as WeatherIconType) &&
    typeof candidate.fetchedAt === 'string'
  );
}

/** Reads weather embedded in the activity's GeoJSON properties, if any. */
export function getEmbeddedActivityWeather(activity: ActivityRecord): ActivityWeather | null {
  if (isActivityWeather(activity.weather)) return activity.weather;
  const value = activity.geojson?.properties?.weather;
  return isActivityWeather(value) ? value : null;
}

type WeatherCache = Record<string, ActivityWeather>;

function readCache(): WeatherCache {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(WEATHER_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, ActivityWeather] => isActivityWeather(entry[1]),
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function getCachedActivityWeather(activityId: string | number): ActivityWeather | null {
  return readCache()[String(activityId)] ?? null;
}

export function cacheActivityWeather(
  activityId: string | number,
  weather: ActivityWeather,
): void {
  if (typeof window === 'undefined') return;
  try {
    const cache = readCache();
    cache[String(activityId)] = weather;
    window.localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Private mode or a full quota must never break the activity screen.
  }
}

type OpenMeteoHourly = {
  time?: string[];
  temperature_2m?: (number | null)[];
  apparent_temperature?: (number | null)[];
  relative_humidity_2m?: (number | null)[];
  weather_code?: (number | null)[];
  wind_speed_10m?: (number | null)[];
  wind_direction_10m?: (number | null)[];
};

type OpenMeteoResponse = {
  hourly?: OpenMeteoHourly;
  utc_offset_seconds?: number;
};

function valueOr(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function shouldUseForecast(startedAt: Date): boolean {
  const days = Math.round(
    (startOfLocalDay(new Date()) - startOfLocalDay(startedAt)) / 86_400_000,
  );
  return days <= RECENT_WINDOW_DAYS;
}

function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Open-Meteo returns local wall-clock times plus the UTC offset to apply. */
function parseHourlyTime(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
}

function nearestHourIndex(
  times: string[],
  targetEpoch: number,
  utcOffsetSeconds: number,
): number {
  const targetLocal = targetEpoch + utcOffsetSeconds * 1000;
  let bestIndex = 0;
  let bestDiff = Number.POSITIVE_INFINITY;

  for (let index = 0; index < times.length; index += 1) {
    const parsed = parseHourlyTime(times[index]);
    if (parsed === null) continue;
    const diff = Math.abs(parsed - targetLocal);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = index;
    }
  }

  return bestIndex;
}

/**
 * Fetches the hourly weather closest to the activity start from Open-Meteo.
 * Always resolves; any network or parsing failure returns null.
 */
export async function fetchActivityWeather(input: {
  latitude: number;
  longitude: number;
  startedAt: Date | null;
  timeoutMs?: number;
}): Promise<ActivityWeather | null> {
  const { latitude, longitude } = input;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const startedAt = input.startedAt ?? new Date();
  if (Number.isNaN(startedAt.getTime())) return null;
  const recent = shouldUseForecast(startedAt);

  const url = new URL(recent ? FORECAST_ENDPOINT : ARCHIVE_ENDPOINT);
  url.searchParams.set('latitude', latitude.toFixed(6));
  url.searchParams.set('longitude', longitude.toFixed(6));
  url.searchParams.set('hourly', HOURLY_FIELDS);
  url.searchParams.set('timezone', 'auto');

  if (recent) {
    url.searchParams.set('past_days', String(RECENT_WINDOW_DAYS));
    url.searchParams.set('forecast_days', '1');
  } else {
    const date = formatDate(startedAt);
    url.searchParams.set('start_date', date);
    url.searchParams.set('end_date', date);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, input.timeoutMs ?? 5000));

  let data: OpenMeteoResponse;
  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    if (!response.ok) return null;
    data = (await response.json()) as OpenMeteoResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  const hourly = data.hourly;
  const times = hourly?.time;
  if (!hourly || !times || times.length === 0) return null;

  const index = nearestHourIndex(times, startedAt.getTime(), data.utc_offset_seconds ?? 0);
  const temperature = hourly.temperature_2m?.[index];
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) return null;

  const weatherCode = Math.round(valueOr(hourly.weather_code?.[index], 0));
  const descriptor = describeWeatherCode(weatherCode);
  const windDirectionDeg = Math.round(valueOr(hourly.wind_direction_10m?.[index], 0));

  return {
    temperatureC: Math.round(temperature),
    apparentTemperatureC: Math.round(valueOr(hourly.apparent_temperature?.[index], temperature)),
    humidityPercent: Math.round(valueOr(hourly.relative_humidity_2m?.[index], 0)),
    windSpeedKmh: Math.round(valueOr(hourly.wind_speed_10m?.[index], 0)),
    windDirectionDeg,
    windDirectionLabel: windDirectionLabel(windDirectionDeg),
    weatherCode,
    conditionLabel: descriptor.label,
    iconType: descriptor.iconType,
    fetchedAt: new Date().toISOString(),
  };
}

function toWeatherFeature(
  coordinates: LngLatEle[],
  weather: ActivityWeather,
  includeTimestamps: boolean,
) {
  const withTime =
    includeTimestamps && coordinates.every((coordinate) => timestampOf(coordinate) !== null);

  return {
    type: 'Feature' as const,
    properties: { weather },
    geometry: {
      type: 'LineString' as const,
      coordinates: coordinates.map(([lng, lat, ele, time]) =>
        withTime
          ? [lng, lat, Number.isFinite(ele) ? ele : 0, time as number]
          : [lng, lat, Number.isFinite(ele) ? ele : 0],
      ),
    },
  };
}

/**
 * Best-effort write of the weather back into the row so later visits can skip
 * the network call. The local cache remains the offline source of truth, so a
 * rejection (e.g. a strict PostGIS geometry column) is ignored.
 */
async function persistActivityWeather(
  activity: ActivityRecord,
  weather: ActivityWeather,
  supabaseClient: SupabaseClient,
): Promise<void> {
  try {
    const first = await supabaseClient
      .from('activities')
      .update({ geojson: toWeatherFeature(activity.coordinates, weather, true) })
      .eq('id', activity.id);
    if (!first.error) return;

    await supabaseClient
      .from('activities')
      .update({ geojson: toWeatherFeature(activity.coordinates, weather, false) })
      .eq('id', activity.id);
  } catch {
    // Silent by design: the card already has data from the cache.
  }
}

/**
 * Resolves the weather for an activity in this order: embedded GeoJSON
 * properties, local cache, then Open-Meteo. Planned routes never fetch.
 */
export async function getOrFetchActivityWeather(
  activity: ActivityRecord,
  supabaseClient: SupabaseClient | null,
): Promise<ActivityWeather | null> {
  const embedded = getEmbeddedActivityWeather(activity);
  if (embedded) return embedded;

  const cached = getCachedActivityWeather(activity.id);
  if (cached) return cached;

  if (activity.isPlannedRoute || activity.coordinates.length === 0) return null;

  const first = activity.coordinates[0];
  const pointTime = timestampOf(first);
  const startedAt = pointTime !== null ? new Date(pointTime) : new Date(activity.createdAt);

  const weather = await fetchActivityWeather({
    latitude: first[1],
    longitude: first[0],
    startedAt,
    timeoutMs: 5000,
  });
  if (!weather) return null;

  cacheActivityWeather(activity.id, weather);
  if (supabaseClient) void persistActivityWeather(activity, weather, supabaseClient);
  return weather;
}
