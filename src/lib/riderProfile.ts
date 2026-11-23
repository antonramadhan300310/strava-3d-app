import { readScopedStorage, writeScopedStorage } from './userStorage';

export type BikeType = 'road' | 'gravel' | 'mtb';

export type RiderProfile = {
  displayName: string;
  bodyWeightKg: number;
  bikeWeightKg: number;
  bikeType: BikeType;
  ftpWatts: number;
};

export const RIDER_PROFILE_KEY = 'tracker3d_rider_profile_v1';

export const DEFAULT_RIDER_PROFILE: RiderProfile = {
  displayName: 'Atlet Tracker 3D',
  bodyWeightKg: 68,
  bikeWeightKg: 9.5,
  bikeType: 'road',
  ftpWatts: 180,
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
  road: { label: 'Road', cda: 0.32, crr: 0.0045, defaultWeightKg: 9.5 },
  gravel: { label: 'Gravel', cda: 0.38, crr: 0.007, defaultWeightKg: 10.5 },
  mtb: { label: 'MTB', cda: 0.44, crr: 0.01, defaultWeightKg: 13 },
};

export const BIKE_TYPES: BikeType[] = ['road', 'gravel', 'mtb'];

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
  { zone: 'Z2', name: 'Endurance', color: '#22c55e', lowerFraction: 0.55, upperFraction: 0.75 },
  { zone: 'Z3', name: 'Tempo', color: '#eab308', lowerFraction: 0.75, upperFraction: 0.9 },
  { zone: 'Z4', name: 'Threshold', color: '#f97316', lowerFraction: 0.9, upperFraction: 1.05 },
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
  return value === 'road' || value === 'gravel' || value === 'mtb';
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

/** Lower/upper watt bounds for the six Coggan zones at a given FTP. */
export function computePowerZoneRanges(ftpWatts: number): PowerZoneRange[] {
  const ftp = ftpWatts > 0 && Number.isFinite(ftpWatts) ? ftpWatts : DEFAULT_RIDER_PROFILE.ftpWatts;

  return POWER_ZONE_DEFINITIONS.map((definition) => {
    const lowerWatts = Math.round(ftp * definition.lowerFraction);
    const upperWatts =
      definition.upperFraction === null ? null : Math.round(ftp * definition.upperFraction);

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
