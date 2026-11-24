'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bike,
  Check,
  Cloud,
  CloudOff,
  Crown,
  Gauge,
  Loader2,
  LogOut,
  Mail,
  Pencil,
  Save,
  UserRound,
  X,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import type { ActivityRecord } from '@/lib/activity';
import {
  BIKE_PHYSICS,
  BIKE_TYPES,
  DEFAULT_RIDER_PROFILE,
  computePowerZoneRanges,
  loadRiderProfile,
  sanitizeRiderProfile,
  sanitizeZonePercents,
  type BikeType,
  type RiderProfile,
} from '@/lib/riderProfile';
import { isLifetimePro } from '@/lib/subscription';
import ProPaywallSheet from './ProPaywallSheet';

type Props = {
  open: boolean;
  activities: ActivityRecord[];
  onClose: () => void;
  onSaved?: (profile: RiderProfile) => void;
};

type SyncState = 'cloud' | 'local';

const SAVED_NOTICE_MS = 2500;

/** Safe starting FTP when the athlete has no power meter data yet. */
const DEFAULT_ESTIMATED_FTP_WATTS = 150;

function hasStoredProfile(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

export default function AthleteProfileSheet({ open, activities, onClose, onSaved }: Props) {
  const {
    user,
    profile: account,
    isPro,
    isOwner,
    trialDaysLeft,
    refreshSubscription,
    ownerSimulatedTier,
    setOwnerSimulatedTier,
    signOut,
    saveAthleteProfile,
  } = useAuth();
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>(() =>
    typeof navigator !== 'undefined' && navigator.onLine === false ? 'local' : 'cloud',
  );
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  // The context profile is the source of truth; localStorage only fills the gap
  // before the cloud fetch finishes or while the device is offline.
  const savedProfile = useMemo<RiderProfile>(() => {
    if (hasStoredProfile(account?.riderProfile)) {
      return sanitizeRiderProfile({
        ...(account?.riderProfile as Partial<RiderProfile>),
        displayName: account?.displayName || undefined,
      });
    }
    const local = loadRiderProfile();
    return { ...local, displayName: account?.displayName || local.displayName };
  }, [account?.riderProfile, account?.displayName]);

  const [displayName, setDisplayName] = useState(savedProfile.displayName);
  const [bodyWeight, setBodyWeight] = useState(String(savedProfile.bodyWeightKg));
  const [bikeWeight, setBikeWeight] = useState(String(savedProfile.bikeWeightKg));
  const [bikeType, setBikeType] = useState<BikeType>(savedProfile.bikeType);
  const [ftp, setFtp] = useState(String(savedProfile.ftpWatts));
  const [zoneInputs, setZoneInputs] = useState<string[]>(() =>
    savedProfile.powerZonePercents.map(String),
  );

  const resetForm = () => {
    setDisplayName(savedProfile.displayName);
    setBodyWeight(String(savedProfile.bodyWeightKg));
    setBikeWeight(String(savedProfile.bikeWeightKg));
    setBikeType(savedProfile.bikeType);
    setFtp(String(savedProfile.ftpWatts));
    setZoneInputs(savedProfile.powerZonePercents.map(String));
  };

  // Reopening the sheet always starts in read mode with the saved values.
  useEffect(() => {
    if (!open) setIsEditing(false);
  }, [open]);

  // Opening the Athlete Profile re-checks tier, expiry and the active device.
  useEffect(() => {
    if (!open) return;
    void refreshSubscription();
  }, [open, refreshSubscription]);

  useEffect(() => {
    if (!open || isEditing) return;
    resetForm();
    // resetForm only derives from savedProfile, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEditing, savedProfile]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const stats = useMemo(() => {
    const recorded = activities.filter((activity) => !activity.isPlannedRoute);
    return {
      distanceKm: recorded.reduce((total, activity) => total + activity.distanceMeters, 0) / 1000,
      elevation: Math.round(
        recorded.reduce((total, activity) => total + activity.elevationGain, 0),
      ),
      hours: recorded.reduce((total, activity) => total + activity.durationSeconds, 0) / 3600,
      sessions: recorded.length,
    };
  }, [activities]);

  const lifetimePro = account ? isLifetimePro(account) : false;
  const trialBadge = !lifetimePro && trialDaysLeft !== null;

  const ftpValue = Number(ftp);
  const effectiveFtp =
    Number.isFinite(ftpValue) && ftpValue > 0 ? ftpValue : DEFAULT_RIDER_PROFILE.ftpWatts;
  const zonePercents = useMemo(
    () => sanitizeZonePercents(zoneInputs.map(Number)),
    [zoneInputs],
  );
  const zoneRanges = useMemo(
    () => computePowerZoneRanges(effectiveFtp, zonePercents),
    [effectiveFtp, zonePercents],
  );

  if (!open) return null;

  const selectBikeType = (next: BikeType) => {
    setBikeType(next);
    setBikeWeight(String(BIKE_PHYSICS[next].defaultWeightKg));
  };

  const startEditing = () => {
    resetForm();
    setSavedNotice(null);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    resetForm();
    setIsEditing(false);
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setAccountError(null);
    try {
      const result = await saveAthleteProfile({
        displayName,
        riderProfile: {
          displayName,
          bodyWeightKg: Number(bodyWeight),
          bikeWeightKg: Number(bikeWeight),
          bikeType,
          ftpWatts: Number(ftp),
          powerZonePercents: zonePercents,
        },
      });
      setSyncState(result.synced ? 'cloud' : 'local');
      onSaved?.(result.profile);
      setIsEditing(false);
      setSavedNotice('Profil berhasil disimpan');
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = window.setTimeout(() => setSavedNotice(null), SAVED_NOTICE_MS);
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    setAccountError(null);
    try {
      await signOut();
      onClose();
    } catch (cause) {
      setAccountError(cause instanceof Error ? cause.message : 'Gagal keluar dari akun.');
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-[#0D1112]/75 backdrop-blur-sm">
      <div className="flex max-h-[88dvh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#151B1D] shadow-2xl sm:rounded-2xl">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 pb-2.5 pt-[calc(env(safe-area-inset-top)+0.75rem)] sm:pt-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#B9F51E]/15 text-[#B9F51E]">
              <UserRound size={18} />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-slate-100">Profil Atlet</h2>
              {!isEditing && (
                <p className="truncate text-[10px] text-slate-400">
                  Profil atlet • estimasi daya &amp; kalibrasi FTP
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {isEditing ? (
              <>
                <button
                  type="button"
                  onClick={cancelEditing}
                  disabled={saving}
                  className="rounded-full border border-white/15 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition active:scale-95 disabled:opacity-60"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="flex items-center gap-1 rounded-full bg-[#B9F51E] px-3 py-1.5 text-[11px] font-bold text-[#0D1112] transition hover:bg-[#A5E012] active:scale-95 disabled:opacity-60"
                >
                  {saving ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Save size={12} />
                  )}
                  {saving ? 'Menyimpan…' : 'Simpan'}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={startEditing}
                className="flex items-center gap-1 rounded-full border border-[#B9F51E]/50 bg-[#B9F51E]/10 px-3 py-1.5 text-[11px] font-bold text-[#B9F51E] transition active:scale-95"
              >
                <Pencil size={12} />
                Edit
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Tutup profil atlet"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 active:bg-[#1E2E16]"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3 pb-28">
          {savedNotice && (
            <p
              role="status"
              className="mb-3 flex items-center justify-center gap-1.5 text-[11px] font-semibold text-[#B9F51E]"
            >
              <Check size={13} />
              {savedNotice}
            </p>
          )}

          <section className="rounded-xl border border-white/10 bg-[#151B1D]/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Identitas
              </p>
              {lifetimePro ? (
                <span className="rounded-full border border-[#B9F51E]/40 bg-[#B9F51E] px-2 py-0.5 text-[9px] font-bold text-[#0D1112]">
                  👑 PRO
                </span>
              ) : trialBadge ? (
                <span className="flex items-center gap-1 rounded-full border border-[#B9F51E] bg-[#B9F51E]/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#B9F51E]">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#B9F51E]" />
                  PRO TRIAL • Sisa {trialDaysLeft} Hari
                </span>
              ) : (
                <span className="rounded-full border border-slate-600 bg-[#1E2E16] px-2 py-0.5 text-[9px] font-bold text-slate-300">
                  AKUN FREE
                </span>
              )}
            </div>

            {isEditing ? (
              <>
                <label
                  htmlFor="rider-display-name"
                  className="mb-1 mt-2 block text-[11px] text-slate-400"
                >
                  Nama panggilan
                </label>
                <input
                  id="rider-display-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={DEFAULT_RIDER_PROFILE.displayName}
                  className="w-full rounded-xl border border-[#2A3538] bg-[#1E2E16] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#B9F51E]"
                />
              </>
            ) : (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-[#1E2E16]/70 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[10px] text-slate-400">Nama panggilan</p>
                  <p className="truncate text-sm font-semibold text-slate-100">
                    {savedProfile.displayName}
                  </p>
                </div>
              </div>
            )}

            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
              <Mail size={12} className="shrink-0" />
              <span className="truncate">
                {user?.email ?? account?.email ?? 'Email tidak tersedia'}
              </span>
            </p>

            <p
              className={`mt-1.5 flex items-center gap-1.5 text-[10px] font-medium ${
                syncState === 'cloud' ? 'text-emerald-300' : 'text-amber-300'
              }`}
            >
              {syncState === 'cloud' ? (
                <Cloud size={12} className="shrink-0" />
              ) : (
                <CloudOff size={12} className="shrink-0" />
              )}
              {syncState === 'cloud'
                ? 'Tersinkron ke Cloud ALLMOVA'
                : 'Tersimpan Lokal (Offline)'}
            </p>

            {trialBadge ? (
              <p className="mt-1 text-[10px] text-[#B9F51E]/80">
                Trial Pro aktif hingga{' '}
                {new Date(account?.proExpiresAt ?? '').toLocaleDateString('id-ID', {
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric',
                })}
              </p>
            ) : isPro ? (
              account?.proExpiresAt && (
                <p className="mt-1 text-[10px] text-amber-300/80">
                  Pro aktif hingga{' '}
                  {new Date(account.proExpiresAt).toLocaleDateString('id-ID', {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                  })}
                </p>
              )
            ) : (
              <button
                type="button"
                onClick={() => setPaywallOpen(true)}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] py-2 text-[11px] font-bold text-[#0D1112] shadow transition active:scale-[0.99]"
              >
                <Crown size={14} />
                Upgrade ke Pro
              </button>
            )}

            <dl className="mt-3 grid grid-cols-4 gap-1">
              <StatBox label="Total Jarak" value={stats.distanceKm.toFixed(1)} unit="km" />
              <StatBox label="Total Elevasi" value={`${stats.elevation}`} unit="m" />
              <StatBox label="Total Jam" value={stats.hours.toFixed(1)} unit="jam" />
              <StatBox label="Sesi" value={`${stats.sessions}`} unit="sesi" />
            </dl>
          </section>

          {isOwner && (
            <section className="mt-3 rounded-xl border border-sky-400/25 bg-sky-500/5 p-3">
              <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                <Crown size={11} />
                Kontrol Pemilik
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                Simulasi Tampilan untuk menguji fitur terkunci maupun terbuka.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-1 rounded-xl bg-[#1E2E16]/70 p-1">
                {(['pro', 'free'] as const).map((tier) => {
                  const selected = ownerSimulatedTier === tier;
                  return (
                    <button
                      key={tier}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setOwnerSimulatedTier(tier)}
                      className={`rounded-lg py-2 text-[11px] font-bold transition active:scale-95 ${
                        selected
                          ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]'
                          : 'text-slate-300 active:bg-[#1E2E16]'
                      }`}
                    >
                      {tier === 'pro' ? '👑 Pro' : 'Free'}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10px] text-slate-500">
                Tampilan aktif: {ownerSimulatedTier === 'pro' ? 'Pro' : 'Free'}
              </p>
            </section>
          )}

          <section className="mt-3 rounded-xl border border-white/10 bg-[#151B1D]/70 p-3">
            <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              <Bike size={11} />
              Data Fisik &amp; Profil Sepeda
            </p>

            {isEditing ? (
              <>
                <label
                  htmlFor="rider-body-weight"
                  className="mb-1 mt-2 block text-[11px] text-slate-400"
                >
                  Berat Badan (kg)
                </label>
                <input
                  id="rider-body-weight"
                  type="number"
                  inputMode="decimal"
                  min={20}
                  max={250}
                  step={0.1}
                  value={bodyWeight}
                  onChange={(event) => setBodyWeight(event.target.value)}
                  className="w-full rounded-xl border border-[#2A3538] bg-[#1E2E16] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#B9F51E]"
                />

                <p className="mb-1 mt-2 text-[11px] text-slate-400">Tipe Sepeda</p>
                <div className="grid grid-cols-2 gap-1" role="group" aria-label="Tipe sepeda">
                  {BIKE_TYPES.map((key) => {
                    const selected = bikeType === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => selectBikeType(key)}
                        className={`rounded-xl py-2 text-[11px] font-semibold transition active:scale-95 ${
                          selected
                            ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]'
                            : 'bg-[#1E2E16] text-slate-300'
                        }`}
                      >
                        {BIKE_PHYSICS[key].label}
                      </button>
                    );
                  })}
                </div>

                <label
                  htmlFor="rider-bike-weight"
                  className="mb-1 mt-2 block text-[11px] text-slate-400"
                >
                  Berat Sepeda (kg)
                </label>
                <input
                  id="rider-bike-weight"
                  type="number"
                  inputMode="decimal"
                  min={2}
                  max={40}
                  step={0.1}
                  value={bikeWeight}
                  onChange={(event) => setBikeWeight(event.target.value)}
                  className="w-full rounded-xl border border-[#2A3538] bg-[#1E2E16] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#B9F51E]"
                />
              </>
            ) : (
              <dl className="mt-2 grid grid-cols-3 gap-1.5">
                <ReadOnlyField label="Berat Badan" value={`${savedProfile.bodyWeightKg} kg`} />
                <ReadOnlyField
                  label="Jenis Sepeda"
                  value={BIKE_PHYSICS[savedProfile.bikeType].label}
                />
                <ReadOnlyField label="Berat Sepeda" value={`${savedProfile.bikeWeightKg} kg`} />
              </dl>
            )}
          </section>

          <section className="mt-3 rounded-xl border border-white/10 bg-[#151B1D]/70 p-3">
            <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              <Gauge size={11} />
              Kalibrasi FTP &amp; Zona Daya
            </p>

            {isEditing ? (
              <>
                <label htmlFor="rider-ftp" className="mb-1 mt-2 block text-[11px] text-slate-400">
                  FTP (Watt)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="rider-ftp"
                    type="number"
                    inputMode="numeric"
                    min={40}
                    max={700}
                    step={1}
                    value={ftp}
                    onChange={(event) => setFtp(event.target.value)}
                    className="min-w-0 flex-1 rounded-xl border border-[#2A3538] bg-[#1E2E16] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#B9F51E]"
                  />
                  <button
                    type="button"
                    onClick={() => setFtp(String(DEFAULT_ESTIMATED_FTP_WATTS))}
                    className="shrink-0 rounded-xl border border-sky-400/30 bg-sky-400/10 px-2.5 py-2 text-[10px] font-semibold text-sky-300 active:scale-95"
                  >
                    Estimasi Otomatis
                  </button>
                </div>

                <p className="mt-1 text-[10px] text-slate-500">
                  Estimasi Otomatis memakai nilai aman {DEFAULT_ESTIMATED_FTP_WATTS} W.
                </p>

                <p className="mb-1 mt-3 text-[11px] text-slate-400">
                  Batas Bawah Zona Daya (% FTP)
                </p>
                <ul className="flex flex-col gap-1">
                  {zoneRanges.map((zone, index) => (
                    <li
                      key={zone.zone}
                      className="flex items-center gap-2 rounded-lg bg-[#1E2E16]/60 px-2 py-1.5"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: zone.color }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 text-[11px] font-semibold text-slate-200">
                        {zone.zone}{' '}
                        <span className="text-[10px] font-normal text-slate-400">
                          {zone.name}
                        </span>
                      </span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={300}
                        step={1}
                        aria-label={`Batas bawah ${zone.zone} dalam persen FTP`}
                        value={zoneInputs[index] ?? ''}
                        onChange={(event) =>
                          setZoneInputs((current) =>
                            current.map((value, position) =>
                              position === index ? event.target.value : value,
                            ),
                          )
                        }
                        className="w-16 shrink-0 rounded-lg border border-[#2A3538] bg-[#0D1112] px-2 py-1 text-right text-[11px] font-semibold tabular-nums text-slate-100 outline-none focus:border-[#B9F51E]"
                      />
                      <span className="w-5 shrink-0 text-[10px] text-slate-500">%</span>
                      <span className="w-24 shrink-0 text-right text-[11px] font-semibold tabular-nums text-slate-100">
                        {zone.rangeLabel}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="mt-2 flex items-baseline justify-between rounded-xl bg-[#1E2E16]/70 px-3 py-2">
                <span className="text-[11px] text-slate-400">FTP</span>
                <span className="text-sm font-bold tabular-nums text-slate-100">
                  {savedProfile.ftpWatts} W
                </span>
              </div>
            )}

            {!isEditing && (
              <ul className="mt-3 flex flex-col gap-1">
                {zoneRanges.map((zone) => (
                  <li
                    key={zone.zone}
                    className="flex items-center gap-2 rounded-lg bg-[#1E2E16]/60 px-2 py-1.5"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: zone.color }}
                    />
                    <span className="min-w-0 flex-1 text-[11px] font-semibold text-slate-200">
                      {zone.zone}{' '}
                      <span className="text-[10px] font-normal text-slate-400">{zone.name}</span>
                    </span>
                    <span className="shrink-0 text-[11px] font-semibold tabular-nums text-slate-100">
                      {zone.rangeLabel}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/5 p-3">
            {confirmLogout ? (
              <>
                <p className="text-[11px] font-medium leading-relaxed text-rose-200">
                  Keluar dari akun ini? Data aktivitas tetap tersimpan di Cloud ALLMOVA.
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmLogout(false)}
                    className="flex-1 rounded-xl border border-white/15 py-2 text-[11px] font-semibold text-slate-200 active:scale-[0.98]"
                  >
                    Batal
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleLogout()}
                    disabled={loggingOut}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-rose-500 py-2 text-[11px] font-semibold text-white active:scale-[0.98] disabled:opacity-60"
                  >
                    {loggingOut ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <LogOut size={14} />
                    )}
                    Keluar
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmLogout(true)}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-500/40 py-2.5 text-[12px] font-semibold text-rose-300 active:scale-[0.98]"
              >
                <LogOut size={15} />
                Keluar Akun (Logout)
              </button>
            )}
            {accountError && (
              <p role="alert" className="mt-2 text-[10px] font-medium text-rose-300">
                {accountError}
              </p>
            )}
          </section>
        </div>
      </div>

      <ProPaywallSheet open={paywallOpen} onClose={() => setPaywallOpen(false)} />
    </div>
  );
}

function StatBox({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg bg-[#1E2E16]/70 px-1 py-1.5">
      <dt className="text-[8px] uppercase leading-tight tracking-wide text-slate-400">{label}</dt>
      <dd className="text-[12px] font-bold leading-tight tabular-nums text-slate-100">{value}</dd>
      <span className="text-[8px] text-slate-500">{unit}</span>
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col rounded-lg bg-[#1E2E16]/70 px-2 py-1.5">
      <dt className="text-[9px] uppercase leading-tight tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-[12px] font-bold leading-tight text-slate-100">{value}</dd>
    </div>
  );
}
