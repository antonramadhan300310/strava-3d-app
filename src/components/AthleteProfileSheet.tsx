'use client';

import { useMemo, useState } from 'react';
import { Bike, Gauge, Save, UserRound, X } from 'lucide-react';
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

type Props = {
  open: boolean;
  activities: ActivityRecord[];
  onClose: () => void;
  onSaved?: (profile: RiderProfile) => void;
};

export default function AthleteProfileSheet({ open, activities, onClose, onSaved }: Props) {
  const [initial] = useState(loadRiderProfile);
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
    onSaved?.(saved);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/75 backdrop-blur-sm">
      <div className="flex max-h-[88dvh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#111827] shadow-2xl sm:rounded-2xl">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 pb-2.5 pt-[calc(env(safe-area-inset-top)+0.75rem)] sm:pt-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-500/15 text-orange-400">
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
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 active:bg-slate-800"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          <section className="rounded-xl border border-white/10 bg-slate-900/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Identitas
              </p>
              <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[9px] font-bold text-emerald-300">
                Mode Lokal
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
              className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-500"
            />

            <dl className="mt-3 grid grid-cols-4 gap-1">
              <StatBox label="Total Jarak" value={stats.distanceKm.toFixed(1)} unit="km" />
              <StatBox label="Total Elevasi" value={`${stats.elevation}`} unit="m" />
              <StatBox label="Total Jam" value={stats.hours.toFixed(1)} unit="jam" />
              <StatBox label="Sesi" value={`${stats.sessions}`} unit="sesi" />
            </dl>
          </section>

          <section className="mt-3 rounded-xl border border-white/10 bg-slate-900/70 p-3">
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
              className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-500"
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
                      selected ? 'bg-orange-500 text-white' : 'bg-slate-800 text-slate-300'
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
              className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-500"
            />
          </section>

          <section className="mt-3 rounded-xl border border-white/10 bg-slate-900/70 p-3">
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
              className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-500"
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
                  className="flex items-center gap-2 rounded-lg bg-slate-800/60 px-2 py-1.5"
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
        </div>

        <footer className="shrink-0 border-t border-white/10 bg-[#111827] px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={handleSave}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-orange-500 py-3 text-sm font-bold text-white transition active:scale-[0.99]"
          >
            <Save size={16} />
            Simpan Profil
          </button>
        </footer>
      </div>
    </div>
  );
}

function StatBox({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg bg-slate-800/70 px-1 py-1.5">
      <dt className="text-[8px] uppercase leading-tight tracking-wide text-slate-400">{label}</dt>
      <dd className="text-[12px] font-bold leading-tight tabular-nums text-slate-100">{value}</dd>
      <span className="text-[8px] text-slate-500">{unit}</span>
    </div>
  );
}
