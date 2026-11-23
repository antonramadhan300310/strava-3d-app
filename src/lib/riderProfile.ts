import { readScopedStorage, writeScopedStorage } from './userStorage';

export type BikeType = 'road' | 'gravel' | 'mtb' | 'tt' | 'hybrid';

export type RiderProfile = {
  displayName: string;
  bodyWeightKg: number;
  bikeWeightKg: number;
  bikeType: BikeType;
  ftpWatts: number;
  /** Lower bound of Z1–Z6 as a percentage of FTP. */
  powerZonePercents: number[];
};

export const RIDER_PROFILE_KEY = 'tracker3d_rider_profile_v1';

export const DEFAULT_RIDER_PROFILE: RiderProfile = {
  displayName: 'Atlet ALLMOVA',
  bodyWeightKg: 68,
  bikeWeightKg: 9.5,
  bikeType: 'road',
  ftpWatts: 180,
  powerZonePercents: [0, 55, 75, 90, 105, 120],
};

export type BikePhysics = {
  label: string;
  /** Drag area, m². */
  cda: number;
  /** Rolling resistance coefficient. */
  crr: number;
  defaultWeightKg: number;
};

export const BIKE_PHYSICS: Record<BikeType, BikePhysics> = {
  road: { label: 'Road Bike', cda: 0.32, crr: 0.0045, defaultWeightKg: 9.5 },
  gravel: { label: 'Gravel', cda: 0.38, crr: 0.007, defaultWeightKg: 10.5 },
  mtb: { label: 'MTB', cda: 0.44, crr: 0.01, defaultWeightKg: 13 },
  tt: { label: 'Time Trial / Aero', cda: 0.26, crr: 0.0035, defaultWeightKg: 9 },
  hybrid: { label: 'Hybrid / Lipat', cda: 0.4, crr: 0.0065, defaultWeightKg: 12.5 },
};

export const BIKE_TYPES: BikeType[] = ['road', 'gravel', 'mtb', 'tt', 'hybrid'];

export type PowerZoneKey = 'Z1' | 'Z2' | 'Z3' | 'Z4' | 'Z5' | 'Z6';

export type PowerZoneDefinition = {
  zone: PowerZoneKey;
  name: string;
  color: string;
  lowerFraction: number;
  upperFraction: number | null;
};

/** Coggan six-zone model; fractions are of FTP. */
export const POWER_ZONE_DEFINITIONS: PowerZoneDefinition[] = [
  { zone: 'Z1', name: 'Pemulihan', color: '#64748b', lowerFraction: 0, upperFraction: 0.55 },
  { zone: 'Z2', name: 'Daya Tahan', color: '#22c55e', lowerFraction: 0.55, upperFraction: 0.75 },
  { zone: 'Z3', name: 'Tempo', color: '#eab308', lowerFraction: 0.75, upperFraction: 0.9 },
  { zone: 'Z4', name: 'Threshold', color: '#B9F51E', lowerFraction: 0.9, upperFraction: 1.05 },
  { zone: 'Z5', name: 'VO2 Max', color: '#ef4444', lowerFraction: 1.05, upperFraction: 1.2 },
  { zone: 'Z6', name: 'Anaerobik', color: '#a855f7', lowerFraction: 1.2, upperFraction: null },
];

export type PowerZoneRange = {
  zone: PowerZoneKey;
  name: string;
  color: string;
  lowerWatts: number;
  upperWatts: number | null;
  rangeLabel: string;
};

function isBikeType(value: unknown): value is BikeType {
  return BIKE_TYPES.includes(value as BikeType);
}

/**
 * Six lower bounds (percent of FTP), clamped to 0–300% and kept ascending so
 * every zone still has a positive width.
 */
export function sanitizeZonePercents(value: unknown): number[] {
  const fallback = DEFAULT_RIDER_PROFILE.powerZonePercents;
  if (!Array.isArray(value) || value.length !== fallback.length) return [...fallback];

  const percents = value.map((entry, index) => {
    const parsed = Number(entry);
    if (!Number.isFinite(parsed)) return fallback[index];
    return Math.min(300, Math.max(0, Math.round(parsed)));
  });

  for (let index = 1; index < percents.length; index += 1) {
    if (percents[index] < percents[index - 1]) percents[index] = percents[index - 1];
  }
  return percents;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function sanitizeRiderProfile(value: unknown): RiderProfile {
  const candidate =
    value && typeof value === 'object' ? (value as Partial<RiderProfile>) : {};

  return {
    displayName:
      typeof candidate.displayName === 'string' && candidate.displayName.trim().length > 0
        ? candidate.displayName.trim()
        : DEFAULT_RIDER_PROFILE.displayName,
    bodyWeightKg: positiveNumber(candidate.bodyWeightKg, DEFAULT_RIDER_PROFILE.bodyWeightKg),
    bikeWeightKg: positiveNumber(candidate.bikeWeightKg, DEFAULT_RIDER_PROFILE.bikeWeightKg),
    bikeType: isBikeType(candidate.bikeType) ? candidate.bikeType : DEFAULT_RIDER_PROFILE.bikeType,
    ftpWatts: positiveNumber(candidate.ftpWatts, DEFAULT_RIDER_PROFILE.ftpWatts),
    powerZonePercents: sanitizeZonePercents(candidate.powerZonePercents),
  };
}

export function loadRiderProfile(): RiderProfile {
  if (typeof window === 'undefined') return { ...DEFAULT_RIDER_PROFILE };
  try {
    const raw = readScopedStorage(RIDER_PROFILE_KEY);
    if (!raw) return { ...DEFAULT_RIDER_PROFILE };
    return sanitizeRiderProfile(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_RIDER_PROFILE };
  }
}

export function saveRiderProfile(profile: RiderProfile): RiderProfile {
  const sanitized = sanitizeRiderProfile(profile);
  writeScopedStorage(RIDER_PROFILE_KEY, JSON.stringify(sanitized));
  return sanitized;
}

/**
 * Lower/upper watt bounds for the six Coggan zones at a given FTP.
 *
 * `percents` lets the athlete retune each zone's lower bound; a zone's upper
 * bound is the next zone's lower bound, so the bands always meet.
 */
export function computePowerZoneRanges(
  ftpWatts: number,
  percents: number[] = DEFAULT_RIDER_PROFILE.powerZonePercents,
): PowerZoneRange[] {
  const ftp = ftpWatts > 0 && Number.isFinite(ftpWatts) ? ftpWatts : DEFAULT_RIDER_PROFILE.ftpWatts;
  const bounds = sanitizeZonePercents(percents);

  return POWER_ZONE_DEFINITIONS.map((definition, index) => {
    const lowerWatts = Math.round((ftp * bounds[index]) / 100);
    const nextPercent = index + 1 < bounds.length ? bounds[index + 1] : null;
    const upperWatts = nextPercent === null ? null : Math.round((ftp * nextPercent) / 100);

    return {
      zone: definition.zone,
      name: definition.name,
      color: definition.color,
      lowerWatts,
      upperWatts,
      rangeLabel:
        upperWatts === null ? `${lowerWatts}+ W` : `${lowerWatts}–${upperWatts} W`,
    };
  });
}
