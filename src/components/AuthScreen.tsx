'use client';

import { useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import AllmovaLogo from '@/components/AllmovaLogo';
import { translateAuthError } from '@/lib/authErrors';

type Mode = 'login' | 'signup' | 'forgot';
type ForgotStep = 'email' | 'otp';

const MIN_PASSWORD_LENGTH = 6;

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function AuthScreen() {
  const { isConfigured, signIn, signUp, requestPasswordReset, resetPasswordWithOtp } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [forgotStep, setForgotStep] = useState<ForgotStep>('email');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const resetMessages = () => {
    setError(null);
    setInfo(null);
  };

  const applyMode = (next: Mode) => {
    resetMessages();
    setMode(next);
    setForgotStep('email');
    setPassword('');
    setNewPassword('');
    setOtp('');
    setShowPassword(false);
    setShowNewPassword(false);
  };

  const switchMode = (next: Mode) => {
    if (busy) return;
    applyMode(next);
  };

  const guard = (): boolean => {
    if (!isConfigured) {
      setError('Server ALLMOVA belum dikonfigurasi. Hubungi admin aplikasi.');
      return false;
    }
    return true;
  };

  const handleLogin = async () => {
    if (!guard()) return;
    if (!isEmail(email)) {
      setError('Format email tidak valid');
      return;
    }
    if (password.length === 0) {
      setError('Password wajib diisi');
      return;
    }

    setBusy(true);
    resetMessages();
    try {
      await signIn(email, password);
    } catch (cause) {
      setError(translateAuthError(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleSignUp = async () => {
    if (!guard()) return;
    if (displayName.trim().length === 0) {
      setError('Nama panggilan wajib diisi');
      return;
    }
    if (!isEmail(email)) {
      setError('Format email tidak valid');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password minimal ${MIN_PASSWORD_LENGTH} karakter`);
      return;
    }

    setBusy(true);
    resetMessages();
    try {
      const result = await signUp(displayName, email, password);
      if (result.needsEmailConfirmation) {
        applyMode('login');
        setInfo('Akun dibuat. Cek email untuk konfirmasi lalu masuk.');
      }
    } catch (cause) {
      setError(translateAuthError(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleRequestOtp = async () => {
    if (!guard()) return;
    if (!isEmail(email)) {
      setError('Format email tidak valid');
      return;
    }

    setBusy(true);
    resetMessages();
    try {
      await requestPasswordReset(email);
      setForgotStep('otp');
      setInfo(`Kode OTP 6 digit telah dikirim ke ${email.trim()}. Cek kotak masuk atau folder spam.`);
    } catch (cause) {
      setError(translateAuthError(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleResetPassword = async () => {
    if (!guard()) return;
    if (!/^\d{6}$/.test(otp.trim())) {
      setError('Kode OTP harus 6 digit angka');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Password baru minimal ${MIN_PASSWORD_LENGTH} karakter`);
      return;
    }

    setBusy(true);
    resetMessages();
    try {
      await resetPasswordWithOtp(email, otp, newPassword);
      setInfo('Password berhasil diperbarui. Kamu langsung masuk ke aplikasi.');
    } catch (cause) {
      setError(translateAuthError(cause));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (mode === 'login') void handleLogin();
    else if (mode === 'signup') void handleSignUp();
    else if (forgotStep === 'email') void handleRequestOtp();
    else void handleResetPassword();
  };

  const canGoBack = mode !== 'login';
  const heading =
    mode === 'login'
      ? 'Masuk'
      : mode === 'signup'
        ? 'Daftar Akun Baru'
        : forgotStep === 'email'
          ? 'Lupa Password'
          : 'Verifikasi Kode OTP';
  const subheading =
    mode === 'login'
      ? 'Lanjutkan perjalanan dan rekor latihanmu.'
      : mode === 'signup'
        ? 'Satu akun untuk semua rekaman GPS dan rute 3D.'
        : forgotStep === 'email'
          ? 'Masukkan email akun untuk menerima kode OTP 6 digit.'
          : 'Masukkan kode dari email dan password baru kamu.';

  const goBack = () => {
    if (mode === 'forgot' && forgotStep === 'otp') {
      setForgotStep('email');
      resetMessages();
      return;
    }
    switchMode('login');
  };

  return (
    <main className="relative flex h-dvh w-full flex-col overflow-y-auto bg-[#0D1112] text-slate-100">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-[#B9F51E]/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0 h-64 w-64 translate-x-1/3 translate-y-1/3 rounded-full bg-sky-500/10 blur-3xl"
      />

      <div className="relative mx-auto flex w-full max-w-md flex-1 flex-col px-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+2.25rem)]">
        <header className="flex flex-col items-center text-center">
          <AllmovaLogo variant="full" className="h-24 w-auto" />
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{heading}</h1>
          <p className="mt-1 max-w-[19rem] text-xs leading-relaxed text-slate-400">{subheading}</p>
        </header>

        <form
          onSubmit={onSubmit}
          className="mt-6 flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#151B1D]/95 p-4 shadow-2xl backdrop-blur"
        >
          {canGoBack && (
            <button
              type="button"
              onClick={goBack}
              className="flex w-fit items-center gap-1 text-[11px] font-semibold text-slate-400 active:text-slate-200"
            >
              <ArrowLeft size={14} />
              Kembali
            </button>
          )}

          {!isConfigured && (
            <p className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              Server ALLMOVA belum dikonfigurasi. Hubungi admin aplikasi.
            </p>
          )}

          {mode === 'signup' && (
            <Field label="Nama Panggilan" icon={<UserRound size={16} />} htmlFor="auth-name">
              <input
                id="auth-name"
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  setError(null);
                }}
                autoComplete="name"
                placeholder="Nama kamu"
                className={inputClass}
              />
            </Field>
          )}

          {!(mode === 'forgot' && forgotStep === 'otp') && (
            <Field label="Email" icon={<Mail size={16} />} htmlFor="auth-email">
              <input
                id="auth-email"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setError(null);
                }}
                autoComplete="email"
                placeholder="nama@email.com"
                className={inputClass}
              />
            </Field>
          )}

          {mode === 'login' && (
            <Field label="Password" icon={<Lock size={16} />} htmlFor="auth-password">
              <input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
                autoComplete="current-password"
                placeholder="••••••"
                className={`${inputClass} pr-11`}
              />
              <VisibilityToggle
                visible={showPassword}
                onToggle={() => setShowPassword((value) => !value)}
              />
            </Field>
          )}

          {mode === 'signup' && (
            <Field label="Password" icon={<Lock size={16} />} htmlFor="auth-signup-password">
              <input
                id="auth-signup-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
                autoComplete="new-password"
                placeholder={`Minimal ${MIN_PASSWORD_LENGTH} karakter`}
                className={`${inputClass} pr-11`}
              />
              <VisibilityToggle
                visible={showPassword}
                onToggle={() => setShowPassword((value) => !value)}
              />
            </Field>
          )}

          {mode === 'forgot' && forgotStep === 'otp' && (
            <>
              <p className="rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-[11px] leading-relaxed text-emerald-200">
                Kode dikirim ke <span className="font-semibold">{email.trim()}</span>
              </p>

              <Field label="Kode OTP 6 Digit" icon={<KeyRound size={16} />} htmlFor="auth-otp">
                <input
                  id="auth-otp"
                  value={otp}
                  onChange={(event) => {
                    setOtp(event.target.value.replace(/\D/g, '').slice(0, 6));
                    setError(null);
                  }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="••••••"
                  className={`${inputClass} text-center text-lg tracking-[0.45em]`}
                />
              </Field>

              <Field
                label="Password Baru"
                icon={<Lock size={16} />}
                htmlFor="auth-new-password"
              >
                <input
                  id="auth-new-password"
                  type={showNewPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(event) => {
                    setNewPassword(event.target.value);
                    setError(null);
                  }}
                  autoComplete="new-password"
                  placeholder={`Minimal ${MIN_PASSWORD_LENGTH} karakter`}
                  className={`${inputClass} pr-11`}
                />
                <VisibilityToggle
                  visible={showNewPassword}
                  onToggle={() => setShowNewPassword((value) => !value)}
                />
              </Field>
            </>
          )}

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] font-medium leading-relaxed text-rose-300"
            >
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              {error}
            </p>
          )}

          {info && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-[11px] font-medium leading-relaxed text-emerald-200"
            >
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
              {info}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !isConfigured}
            className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl bg-[#B9F51E] hover:bg-[#A5E012] py-3 text-sm font-bold text-[#0D1112] shadow-lg shadow-[#B9F51E]/20 transition active:scale-[0.99] disabled:opacity-60"
          >
            {busy ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <ShieldCheck size={18} />
            )}
            {mode === 'login'
              ? 'Masuk'
              : mode === 'signup'
                ? 'Buat Akun'
                : forgotStep === 'email'
                  ? 'Kirim Kode OTP'
                  : 'Simpan Password & Masuk'}
          </button>

          {mode === 'login' && (
            <button
              type="button"
              onClick={() => switchMode('forgot')}
              className="text-center text-[11px] font-semibold text-[#B9F51E] active:text-[#B9F51E]"
            >
              Lupa Password?
            </button>
          )}

          {mode === 'forgot' && forgotStep === 'otp' && (
            <button
              type="button"
              onClick={() => void handleRequestOtp()}
              disabled={busy}
              className="text-center text-[11px] font-semibold text-slate-400 active:text-slate-200 disabled:opacity-60"
            >
              Kirim ulang kode OTP
            </button>
          )}
        </form>

        <div className="mt-4 rounded-2xl border border-white/5 bg-white/[0.02] px-4 py-3 text-center">
          {mode === 'login' ? (
            <p className="text-[11px] text-slate-400">
              Belum punya akun?{' '}
              <button
                type="button"
                onClick={() => switchMode('signup')}
                className="font-semibold text-[#B9F51E] active:text-[#B9F51E]"
              >
                Daftar sekarang
              </button>
            </p>
          ) : (
            <p className="text-[11px] text-slate-400">
              Sudah punya akun?{' '}
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="font-semibold text-[#B9F51E] active:text-[#B9F51E]"
              >
                Masuk
              </button>
            </p>
          )}
        </div>

        <p className="mt-auto pt-6 text-center text-[10px] leading-relaxed text-slate-500">
          Data aktivitas terikat ke akunmu dan hanya bisa dilihat setelah masuk.
        </p>
      </div>
    </main>
  );
}

const inputClass =
  'w-full rounded-xl border border-[#2A3538] bg-[#1E2E16]/80 px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-[#B9F51E]';

function Field({
  label,
  icon,
  htmlFor,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 flex items-center gap-1 text-[11px] text-slate-400">
        {icon}
        {label}
      </label>
      <div className="relative">{children}</div>
    </div>
  );
}

function VisibilityToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={visible ? 'Sembunyikan password' : 'Tampilkan password'}
      aria-pressed={visible}
      className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 active:bg-[#2A3538]/60"
    >
      {visible ? <EyeOff size={17} /> : <Eye size={17} />}
    </button>
  );
}
