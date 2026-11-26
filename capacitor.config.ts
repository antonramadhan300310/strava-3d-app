import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.allmova.app',
  appName: 'ALLMOVA',
  webDir: 'out',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    SplashScreen: {
      backgroundColor: '#0D1112',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      launchAutoHide: true
    },
    CapacitorUpdater: {
      // Self-hosted: the plugin must never call api.capgo.app on its own. The
      // app drives check → download → set() from `src/lib/otaUpdater.ts`.
      autoUpdate: false,
      // Idle socket timeout for the bundle GET; the default 20 s is tight for a
      // ~700 KB zip on a rural mobile link.
      responseTimeout: 60
    }
  }
};

export default config;
