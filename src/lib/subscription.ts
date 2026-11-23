export type PlanTier = 'free' | 'pro';

/** Row shape returned by `public.profiles` (snake_case, PostgREST). */
export type ProfileRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  plan_tier: string | null;
  pro_expires_at: string | null;
  rider_profile: unknown;
  personal_goals: unknown;
};

export type AthleteProfile = {
  id: string;
  email: string | null;
  displayName: string;
  planTier: PlanTier;
  proExpiresAt: string | null;
  riderProfile: unknown;
  personalGoals: unknown;
};

export type ProfileUpdate = {
  display_name?: string;
  plan_tier?: PlanTier;
  pro_expires_at?: string | null;
  rider_profile?: unknown;
  personal_goals?: unknown;
};

export const PROFILE_COLUMNS =
  'id,email,display_name,plan_tier,pro_expires_at,rider_profile,personal_goals';

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
    planTier: row.plan_tier === 'pro' ? 'pro' : 'free',
    proExpiresAt: typeof row.pro_expires_at === 'string' ? row.pro_expires_at : null,
    riderProfile: row.rider_profile ?? null,
    personalGoals: row.personal_goals ?? null,
  };
}

/** A Pro plan with no expiry date is lifetime; a past date downgrades to Free. */
export function isProfilePro(profile: AthleteProfile, now: number = Date.now()): boolean {
  if (profile.planTier !== 'pro') return false;
  if (!profile.proExpiresAt) return true;
  const expiresAt = new Date(profile.proExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
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
    'Halo Admin Tracker 3D, saya ingin mengaktifkan Tracker 3D Pro.',
    '',
    `Email akun: ${account}`,
    `Paket: ${plan.name} (${plan.price}${plan.period})`,
    '',
    'Mohon dibantu proses aktivasinya. Terima kasih.',
  ].join('\n');

  const base = ADMIN_WHATSAPP ? `https://wa.me/${ADMIN_WHATSAPP}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(message)}`;
}
