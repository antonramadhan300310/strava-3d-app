'use client';

import { LogIn, ShieldAlert } from 'lucide-react';

type Props = {
  open: boolean;
  /** Returns to the login screen (the session is already cleared). */
  onReenter: () => void;
};

/** Shown after another device signs in and this session is ended locally. */
export default function SessionKickedModal({ open, onReenter }: Props) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-kicked-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[#0D1112]/90 px-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-[#B9F51E]/25 bg-[#151B1D] shadow-2xl">
        <div className="flex flex-col items-center gap-2 bg-gradient-to-b from-[#B9F51E]/10 to-transparent px-5 pb-3 pt-5 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#B9F51E]/15 text-[#B9F51E]">
            <ShieldAlert size={22} />
          </span>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#B9F51E]">
            KEAMANAN AKUN
          </p>
          <h2 id="session-kicked-title" className="text-base font-bold leading-snug text-slate-100">
            Sesi Diakhiri
          </h2>
        </div>

        <div className="px-5 pb-5">
          <p className="text-center text-[12px] leading-relaxed text-slate-400">
            Akun Anda telah masuk di perangkat lain. Untuk menjaga keamanan akun, sesi di
            perangkat ini diakhiri.
          </p>

          <button
            type="button"
            onClick={onReenter}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[#B9F51E] py-3 text-sm font-bold text-[#0D1112] shadow-lg shadow-[#B9F51E]/20 transition hover:bg-[#A5E012] active:scale-[0.99]"
          >
            <LogIn size={16} />
            Masuk Kembali
          </button>
        </div>
      </div>
    </div>
  );
}
