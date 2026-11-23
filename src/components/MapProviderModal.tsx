'use client';

import { useState } from 'react';
import { ArrowLeft, Check, Globe2, KeyRound, Lock, ShieldCheck, X } from 'lucide-react';
import { MAPTILER_PIN, type MapProvider } from '@/lib/mapProvider';

type Props = {
  /** Currently stored provider, or null on the first launch. */
  current: MapProvider | null;
  onSelect: (provider: MapProvider) => void;
  /** Present only when the modal is reopened from the map badge. */
  onClose?: () => void;
  isPro?: boolean;
  /** Opens the Pro paywall when a free account taps the satellite stack. */
  onRequirePro?: () => void;
};

export default function MapProviderModal({
  current,
  onSelect,
  onClose,
  isPro = true,
  onRequirePro,
}: Props) {
  const [pinMode, setPinMode] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const chooseMaptiler = () => {
    if (!isPro) {
      onRequirePro?.();
      return;
    }
    setError(null);
    setPinMode(true);
  };

  const submitPin = () => {
    if (pin === MAPTILER_PIN) {
      onSelect('maptiler');
      return;
    }
    setError('PIN salah');
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-[#0D1112] px-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1.5rem)]">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
        <header className="flex items-start gap-3">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Tutup pilihan mesin peta"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/15 bg-[#151B1D]/85 text-slate-100 active:scale-95"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#B9F51E]">
              ALLMOVA
            </p>
            <h1 className="mt-1 text-xl font-bold text-slate-100">Pilih Mesin Peta</h1>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Pilihan tersimpan otomatis di perangkat ini dan bisa diganti kapan saja dari peta.
            </p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Tutup"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-400 active:bg-[#1E2E16]"
            >
              <X size={18} />
            </button>
          )}
        </header>

        {!pinMode ? (
          <div className="mt-5 flex flex-col gap-3">
            <ProviderCard
              title="Open Data Stack"
              subtitle="Gratis Tanpa Batas"
              description="AWS 3D Terrain + OpenFreeMap + Esri Satellite • Langsung masuk tanpa kuota"
              icon={<Globe2 size={22} />}
              selected={current === 'opendata'}
              onClick={() => onSelect('opendata')}
            />
            <ProviderCard
              title="MapTiler Pro"
              subtitle="Peta Satelit HD"
              description="Outdoor v2 + Hybrid + Terrain RGB • Fitur Pro, memerlukan PIN akses"
              icon={<Lock size={22} />}
              selected={current === 'maptiler'}
              badge={isPro ? undefined : '👑 PRO'}
              onClick={chooseMaptiler}
            />
          </div>
        ) : (
          <form
            className="mt-5 rounded-2xl border border-white/10 bg-[#151B1D] p-4 shadow-2xl"
            onSubmit={(event) => {
              event.preventDefault();
              submitPin();
            }}
          >
            <div className="flex items-center gap-2">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#B9F51E]/15 text-[#B9F51E]">
                <KeyRound size={20} />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-100">MapTiler Pro</h2>
                <p className="text-[11px] text-slate-400">Masukkan PIN akses pribadi</p>
              </div>
            </div>

            <label htmlFor="map-provider-pin" className="mt-4 mb-1 block text-xs text-slate-400">
              PIN
            </label>
            <input
              id="map-provider-pin"
              value={pin}
              onChange={(event) => {
                setPin(event.target.value.replace(/\D/g, '').slice(0, 6));
                setError(null);
              }}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              placeholder="••••••"
              className="w-full rounded-xl border border-[#2A3538] bg-[#1E2E16] px-3 py-2.5 text-center text-lg tracking-[0.4em] text-slate-100 outline-none focus:border-[#B9F51E]"
            />

            {error && (
              <p className="mt-2 text-xs font-medium text-rose-400" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] py-3 text-sm font-semibold text-[#0D1112] transition active:scale-[0.98]"
            >
              <ShieldCheck size={16} />
              Masuk
            </button>
            <button
              type="button"
              onClick={() => {
                setPinMode(false);
                setPin('');
                setError(null);
              }}
              className="mt-2 w-full rounded-xl border border-white/15 py-2.5 text-sm font-semibold text-slate-200 active:scale-[0.98]"
            >
              Pilih Open Data Stack
            </button>
          </form>
        )}

        <p className="mt-auto pt-6 text-center text-[10px] leading-relaxed text-slate-500">
          Open Data Stack memakai tile publik tanpa kunci. MapTiler memakai kunci API pribadi untuk
          gaya outdoor dan citra hybrid.
        </p>
      </div>
    </div>
  );
}

function ProviderCard({
  title,
  subtitle,
  description,
  icon,
  selected,
  badge,
  onClick,
}: {
  title: string;
  subtitle: string;
  description: string;
  icon: React.ReactNode;
  selected: boolean;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full items-start gap-3 rounded-2xl border p-4 text-left shadow-lg transition active:scale-[0.99] ${
        selected
          ? 'border-[#B9F51E]/60 bg-[#B9F51E]/10'
          : 'border-white/10 bg-[#151B1D]/80 active:bg-[#1E2E16]/80'
      }`}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#B9F51E]/15 text-[#B9F51E]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-sm font-semibold text-slate-100">{title}</span>
          {selected && <Check size={14} className="text-[#B9F51E]" />}
          {badge && (
            <span className="rounded-full border border-[#B9F51E]/40 bg-[#B9F51E] px-1.5 py-0.5 text-[9px] font-bold text-[#0D1112]">
              {badge}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[11px] font-semibold uppercase tracking-wide text-[#B9F51E]">
          {subtitle}
        </span>
        <span className="mt-1.5 block text-[11px] leading-relaxed text-slate-400">
          {description}
        </span>
      </span>
    </button>
  );
}
