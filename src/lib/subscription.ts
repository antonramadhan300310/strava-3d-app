export type PlanTier = 'free' | 'pro';

/** Row shape returned by `public.profiles` (snake_case, PostgREST). */
export type ProfileRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  tier: string | null;
  pro_expires_at: string | null;
  is_owner: boolean | null;
  active_device_id: string | null;
  rider_profile: unknown;
  personal_goals: unknown;
  /** Aliases written by the admin panel and older schemas. */
  plan_tier?: string | null;
  subscription_tier?: string | null;
  plan_expires_at?: string | null;
  subscription_expires_at?: string | null;
  expires_at?: string | null;
  pro_until?: string | null;
};

export type AthleteProfile = {
  id: string;
  email: string | null;
  displayName: string;
  tier: PlanTier;
  proExpiresAt: string | null;
  isOwner: boolean;
  activeDeviceId: string | null;
  riderProfile: unknown;
  personalGoals: unknown;
  /**
   * Trusted-clock time of the server verdict that confirmed this plan, or
   * `null` when the plan only came from a row read or an offline copy. The
   * server already ran the expiry check, so a confirmed plan is never expired
   * locally by a device clock that is set wrong.
   */
  serverVerifiedAt: number | null;
};

/** Plan fields are server-owned; the client only writes editable columns. */
export type ProfileUpdate = {
  display_name?: string;
  rider_profile?: unknown;
  personal_goals?: unknown;
};

/**
 * `select('*')` on purpose: the admin panel (`allmova-landing`) writes the plan
 * into whichever column its schema version has (`plan_tier`, `tier`,
 * `subscription_tier`, …), and a named column list silently reads `null` for
 * the others.
 */
export const PROFILE_COLUMNS = '*';

const PRO_TIERS = new Set(['pro', 'lifetime', 'owner', 'premium']);

const TIER_KEYS = ['plan_tier', 'tier', 'subscription_tier'];
const EXPIRY_KEYS = [
  'pro_expires_at',
  'plan_expires_at',
  'subscription_expires_at',
  'expires_at',
  'pro_until',
];

function firstStringValue(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** First non-empty tier column, lower-cased; `free` when none is set. */
export function readProfileTier(row: Record<string, unknown>): string {
  return (firstStringValue(row, TIER_KEYS) ?? 'free').toLowerCase();
}

/** `pro`, `lifetime`, `owner` and `premium` all unlock the Pro features. */
export function isProTierKey(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  return PRO_TIERS.has(value.trim().toLowerCase());
}

/** First non-empty expiry column, whatever the admin panel named it. */
export function readProfileExpiry(row: Record<string, unknown>): string | null {
  return firstStringValue(row, EXPIRY_KEYS);
}

/**
 * PostgREST serialises a `timestamptz` as Postgres text, not ISO-8601:
 * `2026-12-09 23:32:40.194014+00` — a space instead of `T`, six fractional
 * digits and a two-digit offset. `Date.parse` accepts that only through V8's
 * legacy fallback parser: the shape is outside the spec, so any other engine
 * can return `NaN` and silently drop the expiry — and with it the plan.
 * Normalise once, here, before any date maths.
 */
const PG_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * The admin panel renders dates as `30/11/2026, 12.00` (id-ID) and a hand-typed
 * value can reach a text column in exactly that shape. `Date.parse` returns
 * `NaN` for it on every engine, which silently dropped the expiry and reported
 * a dated Pro account as "Pro aktif selamanya". Read it as local wall clock —
 * a bare date covers the whole day.
 */
const DMY_TIMESTAMP =
  /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[,\s]+(\d{1,2})[.:](\d{2})(?:[.:](\d{2}))?)?$/;

function parseDayMonthYear(raw: string): number | null {
  const match = DMY_TIMESTAMP.exec(raw);
  if (!match) return null;

  const [, day, month, year, hour, minute, second] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const h = hour === undefined ? 23 : Number(hour);
  const min = minute === undefined ? 59 : Number(minute);
  const s = second === undefined ? (hour === undefined ? 59 : 0) : Number(second);
  const ms = hour === undefined ? 999 : 0;

  const date = new Date(y, m - 1, d, h, min, s, ms);
  // Rejects 31/02 and any other impossible calendar day.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return null;
  }
  return date.getTime();
}

function normalizeOffset(offset: string): string {
  if (/^[+-]\d{2}$/.test(offset)) return `${offset}:00`;
  if (/^[+-]\d{4}$/.test(offset)) return `${offset.slice(0, 3)}:${offset.slice(3)}`;
  return offset;
}

/** Epoch milliseconds for an ISO string, Postgres text timestamp or epoch number. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (raw.length === 0) return null;

  const match = PG_TIMESTAMP.exec(raw);
  if (match) {
    const [, date, hourMinute, seconds, fraction, offset] = match;
    const millis = fraction ? fraction.slice(0, 3).padEnd(3, '0') : '000';
    // Postgres omits the offset for a `timestamp` (no time zone) column; the
    // server writes UTC, so a missing offset is read as UTC rather than local.
    const zone = offset === undefined ? 'Z' : offset === 'Z' ? 'Z' : normalizeOffset(offset);
    const parsed = Date.parse(`${date}T${hourMinute}:${seconds ?? '00'}.${millis}${zone}`);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  return parseDayMonthYear(raw);
}

/** Canonical ISO-8601 string, so every downstream `new Date()` is portable. */
export function toIsoTimestamp(value: unknown): string | null {
  const parsed = parseTimestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

/** A typo in an expiry column must not lock a paid account out of Pro. */
function normalizeExpiry(value: string | null): string | null {
  if (!value) return null;
  return toIsoTimestamp(value);
}

export const OWNER_EMAIL = (process.env.NEXT_PUBLIC_OWNER_EMAIL ?? '').trim().toLowerCase();

export const ADMIN_WHATSAPP = (process.env.NEXT_PUBLIC_ADMIN_WHATSAPP ?? '').replace(/\D/g, '');

export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!OWNER_EMAIL || !email) return false;
  return email.trim().toLowerCase() === OWNER_EMAIL;
}

export function toAthleteProfile(
  row: ProfileRow | Record<string, unknown>,
  fallbackEmail: string | null,
  fallbackName: string,
): AthleteProfile {
  const record = row as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : String(record.id ?? '');
  const email = typeof record.email === 'string' ? record.email : fallbackEmail;
  const displayName =
    typeof record.display_name === 'string' && record.display_name.trim().length > 0
      ? record.display_name.trim()
      : fallbackName;

  const tierKey = readProfileTier(record);
  const isOwner = record.is_owner === true;
  const tier: PlanTier = isOwner || isProTierKey(tierKey) ? 'pro' : 'free';

  return {
    id,
    email: email ?? fallbackEmail,
    displayName,
    tier,
    // Only an owner is permanent by definition. Every other account keeps the
    // date the server actually holds: forcing `null` here for a
    // `lifetime`/`owner` tier alias is what turned a dated Pro row into
    // "Pro aktif selamanya".
    proExpiresAt: isOwner ? null : normalizeExpiry(readProfileExpiry(record)),
    isOwner,
    activeDeviceId:
      typeof record.active_device_id === 'string' && record.active_device_id.length > 0
        ? record.active_device_id
        : null,
    riderProfile: record.rider_profile ?? null,
    personalGoals: record.personal_goals ?? null,
    serverVerifiedAt: null,
  };
}

/** A Pro plan with no expiry date is lifetime; a past date downgrades to Free. */
export function isProfilePro(profile: AthleteProfile, now: number = Date.now()): boolean {
  if (profile.isOwner) return true;
  if (profile.tier !== 'pro') return false;
  if (!profile.proExpiresAt) return true;
  if (profile.serverVerifiedAt !== null) return true;
  const expiresAt = parseTimestamp(profile.proExpiresAt);
  return expiresAt !== null && expiresAt > now;
}

/** Owner, or Pro with no date from the server: permanent, shows the crown badge. */
export function isLifetimePro(profile: AthleteProfile): boolean {
  return profile.isOwner || (profile.tier === 'pro' && profile.proExpiresAt === null);
}

export function isTrialPro(profile: AthleteProfile, now: number = Date.now()): boolean {
  if (profile.isOwner || profile.tier !== 'pro' || !profile.proExpiresAt) return false;
  if (profile.serverVerifiedAt !== null) return true;
  const expiresAt = parseTimestamp(profile.proExpiresAt);
  return expiresAt !== null && expiresAt > now;
}

/** Whole days left in the trial, never below 1 so the badge stays positive. */
export function trialDaysLeft(profile: AthleteProfile, now: number = Date.now()): number | null {
  if (!isTrialPro(profile, now) || !profile.proExpiresAt) return null;
  const expiresAt = parseTimestamp(profile.proExpiresAt);
  if (expiresAt === null) return null;
  // The device clock is not trusted once the server confirmed the plan.
  const reference = profile.serverVerifiedAt ?? now;
  return Math.max(1, Math.ceil((expiresAt - reference) / 86_400_000));
}

/** The trial has run out and the account is not an owner. */
export function isTrialExpired(profile: AthleteProfile, now: number = Date.now()): boolean {
  if (profile.isOwner || !profile.proExpiresAt) return false;
  if (profile.serverVerifiedAt !== null) return false;
  const expiresAt = parseTimestamp(profile.proExpiresAt);
  return expiresAt !== null && expiresAt <= now;
}

/**
 * Applies the offline auto-downgrade: an expired trial reads as Free even when
 * the device cannot reach Supabase, so Pro-only UI unlocks consistently.
 */
export function withTrustedTier(profile: AthleteProfile, now: number): AthleteProfile {
  return isTrialExpired(profile, now) ? { ...profile, tier: 'free' } : profile;
}

export const PRO_BENEFITS: { title: string; detail: string }[] = [
  {
    title: 'Export Video 3D Flyover 60 Detik',
    detail: 'Bagikan rekaman sinematik MP4 langsung dari ponsel.',
  },
  {
    title: 'Heatmap Personal Vektor',
    detail: 'Peta jelajah semua rute yang pernah kamu lewati.',
  },
  {
    title: 'GAP & Virtual Power FTP',
    detail: 'Pace tanjakan dan estimasi daya dengan zona FTP pribadi.',
  },
  {
    title: 'Splits & Personal Records',
    detail: 'Rincian per kilometer dan rekor pribadi per jenis olahraga.',
  },
  {
    title: 'Training Log & Target Tak Terbatas',
    detail: 'Pantau konsistensi latihan dan target mingguan tanpa batas.',
  },
  {
    title: 'Peta Satelit HD',
    detail: 'Gaya peta MapTiler resolusi tinggi untuk flyover.',
  },
];

export type ProPlan = {
  key: 'monthly' | 'yearly';
  name: string;
  price: string;
  period: string;
  note: string;
  badge?: string;
};

export const PRO_PLANS: ProPlan[] = [
  {
    key: 'monthly',
    name: 'Paket Bulanan',
    price: 'Rp 25.000',
    period: '/bulan',
    note: 'Semua fitur Pro, ditagih setiap bulan.',
  },
  {
    key: 'yearly',
    name: 'Paket Tahunan',
    price: 'Rp 240.000',
    period: '/tahun',
    note: 'Lebih hemat Rp 60.000 dibanding bulanan.',
    badge: 'Hemat 20%',
  },
];

export function buildProWhatsAppUrl(email: string | null, plan: ProPlan): string {
  const account = email && email.trim().length > 0 ? email.trim() : 'email belum tersedia';
  const message = [
    'Halo Admin ALLMOVA, saya ingin mengaktifkan ALLMOVA PRO.',
    '',
    `Email akun: ${account}`,
    `Paket: ${plan.name} (${plan.price}${plan.period})`,
    '',
    'Mohon dibantu proses aktivasinya. Terima kasih.',
  ].join('\n');

  const base = ADMIN_WHATSAPP ? `https://wa.me/${ADMIN_WHATSAPP}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(message)}`;
}
