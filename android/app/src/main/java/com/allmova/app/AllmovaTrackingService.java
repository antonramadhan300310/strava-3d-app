package com.allmova.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps the CPU, the GPS chip and the location callback alive while a recording
 * runs, so Android's battery optimisations cannot suspend tracking when the
 * screen is locked or the phone is in a pocket.
 *
 * Besides the wake lock, the service owns its own high-accuracy location
 * request (1 s interval, 500 ms fastest, no batching) and copies every fix into
 * {@link GpsFixBuffer}. The web layer drains that buffer when it comes back to
 * the foreground, so a throttled WebView can never punch a hole in the track.
 */
public class AllmovaTrackingService extends Service {

    public static final String CHANNEL_ID = "allmova_tracking_channel";

    private static final String TAG = "AllmovaTrackingService";
    private static final int NOTIFICATION_ID = 1001;
    private static final String WAKE_LOCK_TAG = "ALLMOVA::TrackingWakeLock";
    private static final String NOTIFICATION_TITLE = "ALLMOVA sedang merekam aktivitas…";
    private static final String NOTIFICATION_BODY =
            "GPS aktif — rekaman tetap berjalan meski layar mati";

    /** Location updates requested once per second, at most twice per second. */
    private static final long UPDATE_INTERVAL_MS = 1000L;
    private static final long FASTEST_INTERVAL_MS = 500L;
    /** A fix older than this is a cached position, not the athlete's location. */
    private static final long MAX_FIX_AGE_MS = 30000L;
    /** Anything worse is a cell/Wi-Fi position and is not worth buffering. */
    private static final float MAX_BUFFERED_ACCURACY_METERS = 100f;

    private PowerManager.WakeLock wakeLock;
    private LocationManager locationManager;
    private LocationListener locationListener;
    private boolean locationUpdatesActive = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        // Load the persisted buffer before the first fix so a restart appends.
        GpsFixBuffer.get(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        acquireWakeLock();

        Notification notification = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                        NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception error) {
            // e.g. the location permission was revoked while recording: never
            // leave a half-started foreground service behind.
            Log.w(TAG, "Gagal memulai foreground service", error);
            releaseWakeLock();
            stopSelf();
            return START_NOT_STICKY;
        }

        startLocationUpdates();

        // Not sticky: a restart without the location permission would throw on
        // Android 12+ when the app is in the background.
        return START_NOT_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopLocationUpdates();
        releaseWakeLock();
        stopForeground(true);
        super.onDestroy();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Perekaman Aktivitas ALLMOVA",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Notifikasi persisten selama GPS merekam aktivitas.");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingIntentFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent =
                PendingIntent.getActivity(this, 0, launchIntent, pendingIntentFlags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(NOTIFICATION_TITLE)
                .setContentText(NOTIFICATION_BODY)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }

    /**
     * Requests the highest accuracy the platform offers.
     *
     * API 31+ gets a `LocationRequest` with high quality, a 1 s interval, a
     * 500 ms fastest interval and zero batching delay, which is the closest
     * platform equivalent of a continuous GPS stream. Older releases fall back
     * to the two providers with the same cadence.
     */
    private void startLocationUpdates() {
        if (locationUpdatesActive) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (locationManager == null) return;

        locationListener = new LocationListener() {
            @Override
            public void onLocationChanged(@NonNull Location location) {
                handleLocation(location);
            }

            @Override
            public void onProviderEnabled(@NonNull String provider) {
                // Nothing to do: the listener keeps running.
            }

            @Override
            public void onProviderDisabled(@NonNull String provider) {
                // The OS resumes the stream once the provider is back.
            }

            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {
                // Deprecated on API 30+, kept for older devices.
            }
        };

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                android.location.LocationRequest request =
                        new android.location.LocationRequest.Builder(
                                        LocationManager.GPS_PROVIDER, UPDATE_INTERVAL_MS)
                                .setQuality(android.location.LocationRequest.QUALITY_HIGH_ACCURACY)
                                .setMinUpdateIntervalMillis(FASTEST_INTERVAL_MS)
                                .setMaxUpdateDelayMillis(0L)
                                .setWaitForAccurateLocation(false)
                                .build();
                locationManager.requestLocationUpdates(
                        request, locationListener, Looper.getMainLooper());
            } else {
                requestProvider(LocationManager.GPS_PROVIDER);
                requestProvider(LocationManager.NETWORK_PROVIDER);
            }
            locationUpdatesActive = true;
        } catch (Exception error) {
            Log.w(TAG, "Gagal meminta pembaruan lokasi", error);
        }
    }

    private void requestProvider(String provider) {
        try {
            if (locationManager == null) return;
            if (!locationManager.isProviderEnabled(provider)) return;
            locationManager.requestLocationUpdates(
                    provider, UPDATE_INTERVAL_MS, 0f, locationListener, Looper.getMainLooper());
        } catch (Exception error) {
            Log.w(TAG, "Provider lokasi " + provider + " tidak tersedia", error);
        }
    }

    private void stopLocationUpdates() {
        if (!locationUpdatesActive || locationManager == null || locationListener == null) {
            locationUpdatesActive = false;
            return;
        }
        try {
            locationManager.removeUpdates(locationListener);
        } catch (Exception error) {
            Log.w(TAG, "Gagal menghentikan pembaruan lokasi", error);
        }
        locationUpdatesActive = false;
    }

    /** Buffers a fresh, accurate fix; cached and cell-tower fixes are dropped. */
    private void handleLocation(Location location) {
        if (location == null) return;

        long ageMs =
                (SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos())
                        / 1_000_000L;
        if (ageMs < 0 || ageMs > MAX_FIX_AGE_MS) return;
        if (!location.hasAccuracy()) return;

        float accuracy = location.getAccuracy();
        if (accuracy <= 0 || accuracy > MAX_BUFFERED_ACCURACY_METERS) return;

        GpsFixBuffer.get(this).append(
                location.getLatitude(),
                location.getLongitude(),
                accuracy,
                location.hasAltitude() ? location.getAltitude() : null,
                location.hasSpeed() ? location.getSpeed() : null,
                location.hasBearing() ? location.getBearing() : null,
                location.getTime());
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;

        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) return;

        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
        wakeLock.setReferenceCounted(false);
        // Held for the whole recording: a timeout would silently stop the GPS.
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }
}
