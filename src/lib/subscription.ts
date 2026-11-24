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

export const PROFILE_COLUMNS =
  'id,email,display_name,tier,pro_expires_at,is_owner,active_device_id,rider_profile,personal_goals';

export const OWNER_EMAIL = (process.env.NEXT_PUBLIC_OWNER_EMAIL ?? '').trim().toLowerCase();

export const ADMIN_WHATSAPP = (process.env.NEXT_PUBLIC_ADMIN_WHATSAPP ?? '').replace(/\D/g, '');

export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!OWNER_EMAIL || !email) return false;
  return email.trim().toLowerCase() === OWNER_EMAIL;
}

export function toAthleteProfile(
  row: ProfileRow,
  fallbackEmail: string | null,
  fallbackName: string,
): AthleteProfile {
  const displayName =
    typeof row.display_name === 'string' && row.display_name.trim().length > 0
      ? row.display_name.trim()
      : fallbackName;

  return {
    id: row.id,
    email: row.email ?? fallbackEmail,
    displayName,
    tier: row.tier === 'pro' ? 'pro' : 'free',
    proExpiresAt: typeof row.pro_expires_at === 'string' ? row.pro_expires_at : null,
    isOwner: row.is_owner === true,
    activeDeviceId:
      typeof row.active_device_id === 'string' && row.active_device_id.length > 0
        ? row.active_device_id
        : null,
    riderProfile: row.rider_profile ?? null,
    personalGoals: row.personal_goals ?? null,
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
