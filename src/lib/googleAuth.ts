import { Capacitor } from '@capacitor/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Must match the intent-filter scheme/host in AndroidManifest.xml. */
export const OAUTH_CALLBACK_URL = 'com.allmova.app://login-callback';

export type OAuthCallbackParams = {
  code: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  error: string | null;
  errorDescription: string | null;
};

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export function isOAuthCallbackUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith(OAUTH_CALLBACK_URL);
}

/**
 * Reads the query and hash of the callback URL by hand: a custom scheme is not
 * a special URL for older Android WebViews, where `new URL()` can throw.
 */
function readCallbackParams(url: string): OAuthCallbackParams {
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex + 1) : '';
  const queryIndex = withoutHash.indexOf('?');
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '';

  const merged = new URLSearchParams(query);
  new URLSearchParams(hash).forEach((value, key) => merged.set(key, value));

  const valueOf = (key: string): string | null => {
    const value = merged.get(key);
    return value && value.trim().length > 0 ? value : null;
  };

  return {
    code: valueOf('code'),
    accessToken: valueOf('access_token'),
    refreshToken: valueOf('refresh_token'),
    error: valueOf('error'),
    errorDescription: valueOf('error_description'),
  };
}

export function parseOAuthCallback(url: string): OAuthCallbackParams {
  return readCallbackParams(url);
}

/**
 * Native: the OAuth URL is opened in a Custom Tab, so Supabase must not try to
 * navigate the WebView. Web: a normal full-page redirect back to the origin.
 */
export async function startGoogleOAuth(supabase: SupabaseClient): Promise<void> {
  if (isNativePlatform()) {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_CALLBACK_URL, skipBrowserRedirect: true },
    });
    if (error) throw error;
    if (!data.url) throw new Error('URL login Google tidak tersedia.');

    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url: data.url });
    return;
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}

/**
 * Turns the deep-link URL into a session. PKCE returns `?code=`, the implicit
 * flow returns `#access_token=...&refresh_token=...`; both are accepted.
 */
export async function completeGoogleOAuth(
  supabase: SupabaseClient,
  url: string,
): Promise<void> {
  const params = parseOAuthCallback(url);

  if (params.error) {
    throw new Error(params.errorDescription ?? params.error);
  }

  if (params.code) {
    const { error } = await supabase.auth.exchangeCodeForSession(params.code);
    if (error) throw error;
    return;
  }

  if (params.accessToken && params.refreshToken) {
    const { error } = await supabase.auth.setSession({
      access_token: params.accessToken,
      refresh_token: params.refreshToken,
    });
    if (error) throw error;
    return;
  }

  throw new Error('Login Google tidak mengembalikan sesi.');
}

export async function closeInAppBrowser(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const { Browser } = await import('@capacitor/browser');
    await Browser.close();
  } catch {
    // Already closed by the system when the deep link took over.
  }
}

/** Returns an unsubscribe function; a no-op on the web. */
export async function addOAuthUrlListener(
  handler: (url: string) => void,
): Promise<() => void> {
  if (!isNativePlatform()) return () => {};
  try {
    const { App } = await import('@capacitor/app');
    const listener = await App.addListener('appUrlOpen', ({ url }) => handler(url));
    return () => {
      void listener.remove();
    };
  } catch {
    return () => {};
  }
}

/** Fires when the user dismisses the Custom Tab without finishing. */
export async function addBrowserFinishedListener(
  handler: () => void,
): Promise<() => void> {
  if (!isNativePlatform()) return () => {};
  try {
    const { Browser } = await import('@capacitor/browser');
    const listener = await Browser.addListener('browserFinished', () => handler());
    return () => {
      void listener.remove();
    };
  } catch {
    return () => {};
  }
}
