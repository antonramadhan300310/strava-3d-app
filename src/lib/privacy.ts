export const PRIVACY_POLICY_URL = 'https://allmova.vercel.app/privacy';

/**
 * Native builds open the policy in a Custom Tab; a plain `target="_blank"`
 * inside the WebView would strand the user with no way back.
 */
export async function openPrivacyPolicy(): Promise<void> {
  const { Capacitor } = await import('@capacitor/core');
  if (Capacitor.isNativePlatform()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url: PRIVACY_POLICY_URL });
    return;
  }

  window.open(PRIVACY_POLICY_URL, '_blank', 'noopener,noreferrer');
}
