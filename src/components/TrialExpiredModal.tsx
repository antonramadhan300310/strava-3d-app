'use client';

import { ArrowUpRight, Hourglass, Sparkles } from 'lucide-react';

type Props = {
  open: boolean;
  /** Secondary action: keep using the free plan. */
  onContinue: () => void;
  /** Primary action: close this popup and open the Pro paywall. */
  onUpgrade: () => void;
};

/**
 * Shown exactly once per account after the 14-day Pro trial runs out. The
 * caller is responsible for persisting the "already notified" flag.
 */
export default function TrialExpiredModal({ open, onContinue, onUpgrade }: Props) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="trial-expired-title"
      className="fixed inset-0 z-[95] flex items-end justify-center bg-[#0D1112]/85 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] backdrop-blur-sm sm:items-center sm:pb-4"
    >
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-[#B9F51E]/25 bg-[#151B1D] shadow-2xl">
        <div className="flex flex-col items-center gap-2 bg-gradient-to-b from-[#B9F51E]/10 to-transparent px-5 pb-3 pt-5 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#B9F51E]/15 text-[#B9F51E]">
            <Hourglass size={22} />
          </span>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#B9F51E]">
            ALLMOVA PRO
          </p>
          <h2 id="trial-expired-title" className="text-base font-bold leading-snug text-slate-100">
            Masa Pro Trial 14 Hari Berakhir
          </h2>
        </div>

        <div className="px-5 pb-5">
          <p className="text-center text-[12px] leading-relaxed text-slate-400">
            Akun kamu kini beralih ke paket <span className="font-semibold text-slate-200">Free</span>.
            Perekaman GPS tetap gratis tanpa batas, sedangkan fitur analisis dan sinematik
            kembali terkunci.
          </p>

          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={onUpgrade}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#B9F51E] py-3 text-sm font-bold text-[#0D1112] shadow-lg shadow-[#B9F51E]/20 transition hover:bg-[#A5E012] active:scale-[0.99]"
            >
              <Sparkles size={16} />
              Upgrade ke ALLMOVA Pro
              <ArrowUpRight size={14} />
            </button>
            <button
              type="button"
              onClick={onContinue}
              className="w-full rounded-xl border border-white/15 bg-[#1E2E16]/60 py-2.5 text-[12px] font-semibold text-slate-200 transition active:scale-[0.99]"
            >
              Lanjutkan dengan Akun Free
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
