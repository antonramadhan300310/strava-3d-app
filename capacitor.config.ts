import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.personal.tracker3d',
  appName: 'Tracker 3D',
  webDir: 'out',
  server: {
    androidScheme: 'https'
  }
};

export default config;
