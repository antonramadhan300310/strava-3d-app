'use client';

import { useMemo, useState } from 'react';
import { Bike, Crown, Gauge, Loader2, LogOut, Mail, Save, UserRound, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import type { ActivityRecord } from '@/lib/activity';
import { findSuggestedFtpFromHistory } from '@/lib/powerAndEffort';
import {
  BIKE_PHYSICS,
  BIKE_TYPES,
  DEFAULT_RIDER_PROFILE,
  computePowerZoneRanges,
  loadRiderProfile,
  sanitizeRiderProfile,
  saveRiderProfile,
  type BikeType,
  type RiderProfile,
} from '@/lib/riderProfile';
import ProPaywallSheet from './ProPaywallSheet';

type Props = {
  open: boolean;
  activities: ActivityRecord[];
  onClose: () => void;
  onSaved?: (profile: RiderProfile) => void;
};

export default function AthleteProfileSheet({ open, activities, onClose, onSaved }: Props) {
  const {
    user,
    profile: account,
    isPro,
    isOwner,
    ownerSimulatedTier,
    setOwnerSimulatedTier,
    signOut,
    updateProfile,
  } = useAuth();
  const [initial] = useState(loadRiderProfile);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [bodyWeight, setBodyWeight] = useState(String(initial.bodyWeightKg));
  const [bikeWeight, setBikeWeight] = useState(String(initial.bikeWeightKg));
  const [bikeType, setBikeType] = useState<BikeType>(initial.bikeType);
  const [ftp, setFtp] = useState(String(initial.ftpWatts));

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

  const ftpValue = Number(ftp);
  const effectiveFtp =
    Number.isFinite(ftpValue) && ftpValue > 0 ? ftpValue : DEFAULT_RIDER_PROFILE.ftpWatts;
  const zoneRanges = useMemo(() => computePowerZoneRanges(effectiveFtp), [effectiveFtp]);

  // FTP itself does not affect peak power, so typing in the FTP field must not
  // rescan the whole history.
  const suggestedFtp = useMemo(() => {
    const profile = sanitizeRiderProfile({
      displayName,
      bodyWeightKg: Number(bodyWeight),
      bikeWeightKg: Number(bikeWeight),
      bikeType,
      ftpWatts: DEFAULT_RIDER_PROFILE.ftpWatts,
    });
    return findSuggestedFtpFromHistory(activities, profile);
  }, [activities, displayName, bodyWeight, bikeWeight, bikeType]);

  if (!open) return null;

  const selectBikeType = (next: BikeType) => {
    setBikeType(next);
    setBikeWeight(String(BIKE_PHYSICS[next].defaultWeightKg));
  };

  const handleSave = () => {
    const saved = saveRiderProfile({
      displayName,
      bodyWeightKg: Number(bodyWeight),
      bikeWeightKg: Number(bikeWeight),
      bikeType,
      ftpWatts: Number(ftp),
    });
    void updateProfile({
      display_name: saved.displayName,
      rider_profile: saved,
    }).catch(() => {
      // The scoped local copy stays authoritative until the next sync.
    });
    onSaved?.(saved);
    onClose();
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
              <p className="truncate text-[10px] text-slate-400">
                Data lokal • dipakai untuk estimasi daya
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup profil atlet"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 active:bg-[#1E2E16]"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          <section className="rounded-xl border border-white/10 bg-[#151B1D]/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Identitas
              </p>
              <span
                className={`rounded-full border px-2 py-0.5 text-[9px] font-bold ${
                  isPro
                    ? 'border-[#B9F51E]/40 bg-[#B9F51E] text-[#0D1112]'
                    : 'border-slate-600 bg-[#1E2E16] text-slate-300'
                }`}
              >
                {isPro ? '👑 AKUN PRO' : 'AKUN FREE'}
              </span>
            </div>

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

            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
              <Mail size={12} className="shrink-0" />
              <span className="truncate">{user?.email ?? account?.email ?? 'Email tidak tersedia'}</span>
            </p>

            {isPro ? (
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

            <label htmlFor="rider-body-weight" className="mb-1 mt-2 block text-[11px] text-slate-400">
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

            <p className="mb-1 mt-2 text-[11px] text-slate-400">Jenis sepeda</p>
            <div className="grid grid-cols-3 gap-1" role="group" aria-label="Jenis sepeda">
              {BIKE_TYPES.map((key) => {
                const selected = bikeType === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => selectBikeType(key)}
                    className={`rounded-xl py-2 text-[11px] font-semibold transition active:scale-95 ${
                      selected ? 'bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112]' : 'bg-[#1E2E16] text-slate-300'
                    }`}
                  >
                    {BIKE_PHYSICS[key].label}
                  </button>
                );
              })}
            </div>

            <label htmlFor="rider-bike-weight" className="mb-1 mt-2 block text-[11px] text-slate-400">
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
          </section>

          <section className="mt-3 rounded-xl border border-white/10 bg-[#151B1D]/70 p-3">
            <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              <Gauge size={11} />
              Kalibrasi FTP &amp; Zona Daya
            </p>

            <label htmlFor="rider-ftp" className="mb-1 mt-2 block text-[11px] text-slate-400">
              FTP (Watt)
            </label>
            <input
              id="rider-ftp"
              type="number"
              inputMode="numeric"
              min={40}
              max={700}
              step={1}
              value={ftp}
              onChange={(event) => setFtp(event.target.value)}
              className="w-full rounded-xl border border-[#2A3538] bg-[#1E2E16] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#B9F51E]"
            />

            {suggestedFtp !== null && (
              <button
                type="button"
                onClick={() => setFtp(String(suggestedFtp))}
                className="mt-2 flex w-full items-center justify-center gap-1 rounded-xl border border-sky-400/30 bg-sky-400/10 py-2 text-[11px] font-semibold text-sky-300 active:scale-[0.99]"
              >
                Gunakan 95% Peak 20m ({suggestedFtp} W)
              </button>
            )}

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
          </section>

          <section className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/5 p-3">
            {confirmLogout ? (
              <>
                <p className="text-[11px] font-medium leading-relaxed text-rose-200">
                  Keluar dari akun ini? Data aktivitas tetap tersimpan di cloud.
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

        <footer className="shrink-0 border-t border-white/10 bg-[#151B1D] px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={handleSave}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] py-3 text-sm font-bold text-[#0D1112] transition active:scale-[0.99]"
          >
            <Save size={16} />
            Simpan Profil
          </button>
        </footer>
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
