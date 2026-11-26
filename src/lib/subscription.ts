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
const LIFETIME_TIERS = new Set(['lifetime', 'owner']);

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

/** A typo in an expiry column must not lock a paid account out of Pro. */
function normalizeExpiry(value: string | null): string | null {
  if (!value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
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
  // Lifetime/owner tiers never carry an expiry, so an admin row with both a
  // "lifetime" tier and a leftover date still reads as permanent Pro.
  const isLifetime = isOwner || LIFETIME_TIERS.has(tierKey);
  const tier: PlanTier = isLifetime || isProTierKey(tierKey) ? 'pro' : 'free';

  return {
    id,
    email: email ?? fallbackEmail,
    displayName,
    tier,
    proExpiresAt: isLifetime ? null : normalizeExpiry(readProfileExpiry(record)),
    isOwner,
    activeDeviceId:
      typeof record.active_device_id === 'string' && record.active_device_id.length > 0
        ? record.active_device_id
        : null,
    riderProfile: record.rider_profile ?? null,
    personalGoals: record.personal_goals ?? null,
  };
}

/** A Pro plan with no expiry date is lifetime; a past date downgrades to Free. */
export function isProfilePro(profile: AthleteProfile, now: number = Date.now()): boolean {
  if (profile.isOwner) return true;
  if (profile.tier !== 'pro') return false;
  if (!profile.proExpiresAt) return true;
  const expiresAt = Date.parse(profile.proExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/** Owner and lifetime Pro never expire; both show the crown badge. */
export function isLifetimePro(profile: AthleteProfile): boolean {
  return profile.isOwner || (profile.tier === 'pro' && profile.proExpiresAt === null);
}

export function isTrialPro(profile: AthleteProfile, now: number = Date.now()): boolean {
  if (profile.isOwner || profile.tier !== 'pro' || !profile.proExpiresAt) return false;
  const expiresAt = Date.parse(profile.proExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/** Whole days left in the trial, never below 1 so the badge stays positive. */
export function trialDaysLeft(profile: AthleteProfile, now: number = Date.now()): number | null {
  if (!isTrialPro(profile, now) || !profile.proExpiresAt) return null;
  const expiresAt = Date.parse(profile.proExpiresAt);
  return Math.max(1, Math.ceil((expiresAt - now) / 86_400_000));
}

/** The trial has run out and the account is not an owner. */
export function isTrialExpired(profile: AthleteProfile, now: number = Date.now()): boolean {
  if (profile.isOwner || !profile.proExpiresAt) return false;
  const expiresAt = Date.parse(profile.proExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
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
