package com.allmova.app;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
        name = "AllmovaTracking",
        permissions = {
                @Permission(
                        alias = "location",
                        strings = {
                                Manifest.permission.ACCESS_FINE_LOCATION,
                                Manifest.permission.ACCESS_COARSE_LOCATION
                        }),
                @Permission(
                        alias = "notifications",
                        strings = { Manifest.permission.POST_NOTIFICATIONS })
        })
public class AllmovaTrackingPlugin extends Plugin {

    @PluginMethod
    public void startTrackingService(PluginCall call) {
        // Android 14 refuses a location foreground service without the runtime
        // location permission, so ask for it before the service is created.
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationCallback");
            return;
        }
        ensureNotificationsThenStart(call);
    }

    @PermissionCallback
    private void locationCallback(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Izin lokasi diperlukan untuk merekam aktivitas.");
            return;
        }
        ensureNotificationsThenStart(call);
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        // The tracking notification is required by the foreground service, but a
        // denied permission must never block a recording.
        startService(call);
    }

    private void ensureNotificationsThenStart(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsCallback");
            return;
        }
        startService(call);
    }

    @PluginMethod
    public void stopTrackingService(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), AllmovaTrackingService.class));
            call.resolve();
        } catch (Exception error) {
            call.reject("Gagal menghentikan layanan GPS latar belakang.", error);
        }
    }

    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("URL tidak valid.");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Tidak ada aplikasi yang dapat membuka tautan ini.", error);
        }
    }

    private void startService(PluginCall call) {
        try {
            ContextCompat.startForegroundService(
                    getContext(), new Intent(getContext(), AllmovaTrackingService.class));
            call.resolve();
        } catch (Exception error) {
            call.reject("Gagal memulai layanan GPS latar belakang.", error);
        }
    }
}
