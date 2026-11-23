'use client';

import { useState } from 'react';
import { Check, Crown, MessageCircle, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import {
  ADMIN_WHATSAPP,
  PRO_BENEFITS,
  PRO_PLANS,
  buildProWhatsAppUrl,
  type ProPlan,
} from '@/lib/subscription';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Short sentence naming the feature the user tapped. */
  reason?: string;
};

export default function ProPaywallSheet({ open, onClose, reason }: Props) {
  const { user, profile, isPro } = useAuth();
  const [planKey, setPlanKey] = useState<ProPlan['key']>('yearly');

  if (!open) return null;

  const plan = PRO_PLANS.find((entry) => entry.key === planKey) ?? PRO_PLANS[0];
  const email = user?.email ?? profile?.email ?? null;
  const whatsappUrl = buildProWhatsAppUrl(email, plan);

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-[#0D1112]/80 backdrop-blur-sm">
      <button
        type="button"
        aria-label="Tutup penawaran Pro"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default"
      />

      <div className="relative flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#151B1D] shadow-2xl sm:mb-4 sm:rounded-2xl">
        <header className="shrink-0 border-b border-white/10 bg-gradient-to-br from-[#B9F51E]/10 via-[#151B1D] to-[#151B1D] px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] sm:pt-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] text-[#0D1112] shadow-lg shadow-[#B9F51E]/30">
                <Crown size={20} />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-bold leading-tight text-slate-100">
                  ALLMOVA PRO
                </h2>
                <p className="text-[11px] text-slate-400">
                  {reason ?? 'Buka semua fitur analisis dan sinematik.'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Tutup"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 active:bg-[#1E2E16]"
            >
              <X size={18} />
            </button>
          </div>

          <div className="mt-3 flex items-center gap-1.5 rounded-xl border border-[#B9F51E]/20 bg-[#B9F51E]/10 px-2.5 py-1.5 text-[10px] font-medium text-[#B9F51E]">
            <Sparkles size={12} />
            {isPro
              ? 'Akun kamu sudah Pro. Perpanjang kapan saja lewat WhatsApp.'
              : 'Aktifkan sekali, nikmati semua fitur Pro di perangkat ini.'}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          <ul className="flex flex-col gap-2">
            {PRO_BENEFITS.map((benefit) => (
              <li key={benefit.title} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
                  <Check size={12} strokeWidth={3} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-semibold text-slate-100">
                    {benefit.title}
                  </span>
                  <span className="block text-[10px] leading-relaxed text-slate-400">
                    {benefit.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          <p className="mb-1.5 mt-4 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Pilih paket langganan
          </p>
          <div className="flex flex-col gap-2">
            {PRO_PLANS.map((entry) => {
              const selected = entry.key === planKey;
              return (
                <button
                  key={entry.key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setPlanKey(entry.key)}
                  className={`flex items-center gap-3 rounded-xl border p-3 text-left transition active:scale-[0.99] ${
                    selected
                      ? 'border-[#B9F51E]/60 bg-[#B9F51E]/10'
                      : 'border-white/10 bg-[#151B1D]/70'
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      selected ? 'border-[#B9F51E] bg-[#B9F51E]' : 'border-slate-600'
                    }`}
                  >
                    {selected && <Check size={10} strokeWidth={3} className="text-[#0D1112]" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] font-semibold text-slate-100">
                        {entry.name}
                      </span>
                      {entry.badge && (
                        <span className="rounded-full bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">
                          {entry.badge}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-slate-400">{entry.note}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-[13px] font-bold tabular-nums text-[#B9F51E]">
                      {entry.price}
                    </span>
                    <span className="block text-[9px] text-slate-500">{entry.period}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <footer className="shrink-0 border-t border-white/10 bg-[#151B1D] px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          {ADMIN_WHATSAPP ? (
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] py-3 text-sm font-bold text-[#0D1112] shadow-lg shadow-[#B9F51E]/25 transition active:scale-[0.99]"
            >
              <MessageCircle size={18} />
              Aktifkan Pro via WhatsApp
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#B9F51E]/60 py-3 text-sm font-bold text-[#0D1112]/80"
            >
              <MessageCircle size={18} />
              Aktifkan Pro via WhatsApp
            </button>
          )}

          <p className="mt-2 text-center text-[9px] leading-relaxed text-slate-500">
            {ADMIN_WHATSAPP
              ? `Pesan otomatis menyertakan email akun ${email ?? 'kamu'} agar admin bisa langsung mengaktifkan paket.`
              : 'Nomor WhatsApp admin belum dikonfigurasi (NEXT_PUBLIC_ADMIN_WHATSAPP).'}
          </p>
          <p className="mt-1 flex items-center justify-center gap-1 text-center text-[9px] text-slate-500">
            <ShieldCheck size={10} />
            Aktivasi manual oleh admin • pembayaran dibahas via WhatsApp
          </p>
        </footer>
      </div>
    </div>
  );
}
