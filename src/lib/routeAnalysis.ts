import type { LngLatEle } from './polyline';
import { getProfile, type ActivityType } from './valhalla';

const SAMPLE_SPACING_METERS = 45;
const MAX_GRADE_PERCENT = 35;
const EARTH_RADIUS_METERS = 6371000;
const MAX_SURFACE_SAMPLES = 120;
const VALHALLA_BASE = 'https://valhalla1.openstreetmap.de';

export type GradientSample = {
  /** Distance from the route start, in metres. */
  distanceMeters: number;
  elevationMeters: number;
  /** Smoothed grade at this sample, clamped to ±35%. */
  grade: number;
};

export type GradientBucketKey = 'flat' | 'moderate' | 'steep';

export type GradientBucket = {
  key: GradientBucketKey;
  label: string;
  distanceMeters: number;
  percent: number;
};

export type RouteGradientAnalysis = {
  samples: GradientSample[];
  totalDistanceMeters: number;
  /** Steepest absolute grade found, in percent. */
  maxGrade: number;
  /** Mean of the uphill (>0%) segments, in percent. */
  avgUphill: number;
  buckets: GradientBucket[];
  hasElevation: boolean;
};

export type SurfaceKey = 'paved' | 'rough' | 'unpaved' | 'unknown';

export type SurfaceBucket = {
  key: SurfaceKey;
  label: string;
  distanceMeters: number;
  percent: number;
};

export type RoadConditions = {
  buckets: SurfaceBucket[];
  totalMeters: number;
  /** False when the endpoint was unreachable or returned no usable edges. */
  available: boolean;
};

const GRADIENT_BUCKETS: { key: GradientBucketKey; label: string }[] = [
  { key: 'flat', label: 'Datar / Turunan' },
  { key: 'moderate', label: 'Tanjakan Sedang' },
  { key: 'steep', label: 'Tanjakan Curam' },
];

const SURFACE_GROUPS: { key: Exclude<SurfaceKey, 'unknown'>; label: string; surfaces: string[] }[] = [
  {
    key: 'paved',
    label: 'Aspal / Beton',
    surfaces: ['paved', 'paved_smooth', 'asphalt', 'concrete'],
  },
  {
    key: 'rough',
    label: 'Paving / Makadam',
    surfaces: ['paved_rough', 'cobblestone', 'compacted', 'gravel', 'fine_gravel', 'unhewn_cobblestone', 'sett'],
  },
  {
    key: 'unpaved',
    label: 'Tanah / Setapak',
    surfaces: ['dirt', 'earth', 'ground', 'mud', 'sand', 'grass', 'path', 'track', 'unpaved'],
  },
];

const UNKNOWN_SURFACE: { key: SurfaceKey; label: string } = {
  key: 'unknown',
  label: 'Jalan Lokal',
};

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function haversineMeters(a: readonly number[], b: readonly number[]): number {
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const dLat = lat2 - lat1;
  const dLng = toRadians(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function elevationOf(point: LngLatEle): number {
  return Number.isFinite(point[2]) ? point[2] : 0;
}

/**
 * Re-samples the polyline every ~45 m so a 30 m DEM cell boundary cannot turn
 * one noisy elevation step into a fake wall of gradient.
 */
function resample(coordinates: LngLatEle[], spacing: number): LngLatEle[] {
  if (coordinates.length < 2) return [...coordinates];

  const out: LngLatEle[] = [coordinates[0]];
  let distanceSinceSample = 0;

  for (let i = 1; i < coordinates.length; i += 1) {
    const from = coordinates[i - 1];
    const to = coordinates[i];
    const segment = haversineMeters(from, to);
    if (segment <= 0.01) continue;

    let travelled = 0;
    while (distanceSinceSample + (segment - travelled) >= spacing) {
      travelled += spacing - distanceSinceSample;
      const ratio = travelled / segment;
      out.push([
        from[0] + (to[0] - from[0]) * ratio,
        from[1] + (to[1] - from[1]) * ratio,
        elevationOf(from) + (elevationOf(to) - elevationOf(from)) * ratio,
      ]);
      distanceSinceSample = 0;
    }
    distanceSinceSample += segment - travelled;
  }

  const last = coordinates[coordinates.length - 1];
  const previous = out[out.length - 1];
  if (haversineMeters(previous, last) > 1) out.push(last);
  return out;
}

function clampGrade(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, -MAX_GRADE_PERCENT), MAX_GRADE_PERCENT);
}

/**
 * Smoothed climb analysis. The map line is intentionally left untouched; this
 * data only feeds the "Info Medan" sheet.
 */
export function analyzeRouteGradient(coordinates: LngLatEle[]): RouteGradientAnalysis {
  const empty: RouteGradientAnalysis = {
    samples: [],
    totalDistanceMeters: 0,
    maxGrade: 0,
    avgUphill: 0,
    buckets: GRADIENT_BUCKETS.map((bucket) => ({ ...bucket, distanceMeters: 0, percent: 0 })),
    hasElevation: false,
  };
  if (coordinates.length < 2) return empty;

  const points = resample(coordinates, SAMPLE_SPACING_METERS);
  if (points.length < 2) return empty;

  const samples: GradientSample[] = [
    { distanceMeters: 0, elevationMeters: elevationOf(points[0]), grade: 0 },
  ];
  let distance = 0;
  let hasElevation = false;

  for (let i = 1; i < points.length; i += 1) {
    const step = haversineMeters(points[i - 1], points[i]);
    if (step < 1) continue;
    distance += step;

    const climb = elevationOf(points[i]) - elevationOf(points[i - 1]);
    if (Math.abs(climb) > 1) hasElevation = true;

    samples.push({
      distanceMeters: distance,
      elevationMeters: elevationOf(points[i]),
      grade: clampGrade((climb / step) * 100),
    });
  }

  if (samples.length < 2) return empty;

  const totals: Record<GradientBucketKey, number> = { flat: 0, moderate: 0, steep: 0 };
  let maxGrade = 0;
  let uphillSum = 0;
  let uphillCount = 0;

  for (let i = 1; i < samples.length; i += 1) {
    const grade = samples[i].grade;
    const interval = samples[i].distanceMeters - samples[i - 1].distanceMeters;
    const absolute = Math.abs(grade);

    if (absolute > maxGrade) maxGrade = absolute;
    if (grade > 0) {
      uphillSum += grade;
      uphillCount += 1;
    }

    if (absolute < 3) totals.flat += interval;
    else if (absolute <= 7) totals.moderate += interval;
    else totals.steep += interval;
  }

  const totalDistanceMeters = distance;
  const buckets = GRADIENT_BUCKETS.map((bucket) => {
    const bucketDistance = totals[bucket.key];
    return {
      ...bucket,
      distanceMeters: bucketDistance,
      percent: totalDistanceMeters > 0 ? (bucketDistance / totalDistanceMeters) * 100 : 0,
    };
  });

  return {
    samples,
    totalDistanceMeters,
    maxGrade,
    avgUphill: uphillCount > 0 ? uphillSum / uphillCount : 0,
    buckets,
    hasElevation,
  };
}

type TraceAttributesResponse = {
  edges?: { length?: number; surface?: string; use?: string }[];
};

function sampleForTrace(coordinates: LngLatEle[]): LngLatEle[] {
  if (coordinates.length <= MAX_SURFACE_SAMPLES) return coordinates;

  const step = (coordinates.length - 1) / (MAX_SURFACE_SAMPLES - 1);
  const sample: LngLatEle[] = [];
  for (let i = 0; i < MAX_SURFACE_SAMPLES; i += 1) {
    sample.push(coordinates[Math.round(i * step)]);
  }
  return sample;
}

function surfaceGroup(surface: string | undefined): Exclude<SurfaceKey, 'unknown'> | null {
  if (!surface) return null;
  const value = surface.toLowerCase();
  for (const group of SURFACE_GROUPS) {
    if (group.surfaces.includes(value)) return group.key;
  }
  return null;
}

function emptyConditions(): RoadConditions {
  return {
    buckets: [
      ...SURFACE_GROUPS.map((group) => ({
        key: group.key,
        label: group.label,
        distanceMeters: 0,
        percent: 0,
      })),
      { ...UNKNOWN_SURFACE, distanceMeters: 0, percent: 0 },
    ],
    totalMeters: 0,
    available: false,
  };
}

/**
 * Valhalla `trace_attributes` gives per-edge OSM surface tags. Lengths come
 * back in kilometres. Failures degrade to an empty result, never an error.
 */
export async function fetchRoadConditions(
  coordinates: LngLatEle[],
  activityType: ActivityType,
): Promise<RoadConditions> {
  const fallback = emptyConditions();
  if (coordinates.length < 2) return fallback;

  const profile = getProfile(activityType);
  const sampled = sampleForTrace(coordinates);

  const body: Record<string, unknown> = {
    shape: sampled.map(([lng, lat]) => ({ lat, lon: lng })),
    costing: profile.costing,
    shape_match: 'map_snap',
    filters: {
      attributes: ['edge.surface', 'edge.use', 'edge.length'],
      action: 'include',
    },
  };
  if (profile.costingOptions) body.costing_options = profile.costingOptions;

  try {
    const response = await fetch(`${VALHALLA_BASE}/trace_attributes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return fallback;

    const data = (await response.json()) as TraceAttributesResponse;
    const edges = data.edges ?? [];
    if (edges.length === 0) return fallback;

    const totals: Record<SurfaceKey, number> = {
      paved: 0,
      rough: 0,
      unpaved: 0,
      unknown: 0,
    };

    for (const edge of edges) {
      const length = Number(edge.length);
      if (!Number.isFinite(length) || length <= 0) continue;
      const group = surfaceGroup(edge.surface);
      totals[group ?? 'unknown'] += length * 1000;
    }

    const totalMeters = Object.values(totals).reduce((sum, value) => sum + value, 0);
    if (totalMeters <= 0) return fallback;

    return {
      buckets: [
        ...SURFACE_GROUPS.map((group) => ({
          key: group.key,
          label: group.label,
          distanceMeters: totals[group.key],
          percent: (totals[group.key] / totalMeters) * 100,
        })),
        {
          ...UNKNOWN_SURFACE,
          distanceMeters: totals.unknown,
          percent: (totals.unknown / totalMeters) * 100,
        },
      ],
      totalMeters,
      available: true,
    };
  } catch {
    return fallback;
  }
}
