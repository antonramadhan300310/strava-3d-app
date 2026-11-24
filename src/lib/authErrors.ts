const TRANSLATIONS: { match: RegExp; message: string }[] = [
  {
    match: /invalid login credentials/i,
    message: 'Email atau password salah',
  },
  {
    match: /user already registered|already been registered/i,
    message: 'Email ini sudah terdaftar, silakan langsung masuk',
  },
  {
    match: /token has expired or is invalid|invalid token|otp.*expired/i,
    message: 'Kode OTP salah atau sudah kedaluwarsa',
  },
  {
    match: /email not confirmed/i,
    message: 'Email belum dikonfirmasi. Cek kotak masuk lalu coba lagi',
  },
  {
    match: /password should be at least 6 characters/i,
    message: 'Password minimal 6 karakter',
  },
  {
    match: /unable to validate email address|invalid email/i,
    message: 'Format email tidak valid',
  },
  {
    match: /for security purposes, you can only request this after/i,
    message: 'Terlalu sering mencoba. Tunggu sebentar lalu coba lagi',
  },
  {
    match: /email rate limit exceeded|rate limit/i,
    message: 'Terlalu banyak permintaan. Coba lagi beberapa saat lagi',
  },
  {
    match: /failed to fetch|networkerror|network error|fetch failed/i,
    message: 'Tidak dapat terhubung ke server. Periksa koneksi internet',
  },
  {
    match: /provider is not enabled|unsupported provider|missing oauth secret/i,
    message: 'Login Google belum diaktifkan di server ALLMOVA. Hubungi admin aplikasi',
  },
  {
    match: /redirect_uri_mismatch|redirect url.*not allowed|url not allowed/i,
    message: 'Redirect URL login Google belum terdaftar. Hubungi admin aplikasi',
  },
  {
    match: /access_denied|user (denied|cancelled|canceled)|login google dibatalkan/i,
    message: 'Login Google dibatalkan',
  },
  {
    match: /code verifier|invalid request.*code|pkce/i,
    message: 'Sesi login Google kedaluwarsa. Coba masuk lagi',
  },
];

/** Turns raw authentication errors into short Indonesian copy. */
export function translateAuthError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message: unknown }).message)
          : '';

  const known = TRANSLATIONS.find((entry) => entry.match.test(raw));
  if (known) return known.message;

  const message =
    raw.trim().length > 0
      ? `Gagal memproses permintaan: ${raw}`
      : 'Terjadi kesalahan. Coba lagi.';

  // The SDK can echo its own brand in provider errors; never show it in the UI.
  return message.replace(/supabase/gi, 'Server ALLMOVA');
}
