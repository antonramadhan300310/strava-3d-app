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
    }
  }
};

export default config;
