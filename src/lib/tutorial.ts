export const TUTORIAL_URL = 'https://allmova.vercel.app/tutorial';

/**
 * Native builds open the guide in a Custom Tab; a plain `target="_blank"`
 * inside the WebView would strand the user with no way back.
 */
export async function openTutorial(): Promise<void> {
  const { Capacitor } = await import('@capacitor/core');
  if (Capacitor.isNativePlatform()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url: TUTORIAL_URL });
    return;
  }

  window.open(TUTORIAL_URL, '_blank', 'noopener,noreferrer');
}
