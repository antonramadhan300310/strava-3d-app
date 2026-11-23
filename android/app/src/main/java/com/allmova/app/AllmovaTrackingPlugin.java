package com.allmova.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

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
                        strings = { Manifest.permission.POST_NOTIFICATIONS }),
                @Permission(
                        alias = "storage",
                        strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
        })
public class AllmovaTrackingPlugin extends Plugin {

    /** Subfolder created inside Pictures/ and Movies/ for every export. */
    private static final String ALBUM_NAME = "ALLMOVA";

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

    /**
     * Copies a cached export into the public gallery through MediaStore.
     *
     * Images land in Pictures/ALLMOVA and videos in Movies/ALLMOVA. On API 29+
     * the row is inserted with IS_PENDING=1, filled, then released, which is the
     * only way a scoped-storage app may write outside its own sandbox. API 23–28
     * keeps the legacy DATA column plus a media scan so the gallery indexes it.
     */
    @PluginMethod
    public void saveMediaToGallery(PluginCall call) {
        String filePath = call.getString("filePath");
        if (filePath == null || filePath.trim().isEmpty()) {
            call.reject("filePath wajib diisi.");
            return;
        }

        String mimeType = call.getString("mimeType", "image/png");
        if (mimeType == null || mimeType.trim().isEmpty()) mimeType = "image/png";

        // Pre-scoped-storage devices still need the runtime write permission.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storageCallback");
            return;
        }

        File source = resolveSourceFile(filePath);
        if (source == null || !source.isFile() || source.length() == 0) {
            call.reject("Berkas media tidak ditemukan di cache aplikasi.");
            return;
        }

        boolean isVideo = mimeType.startsWith("video/");
        String fileName = source.getName();
        String directory = isVideo
                ? Environment.DIRECTORY_MOVIES
                : Environment.DIRECTORY_PICTURES;
        Uri collection = isVideo
                ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;

        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);

        Uri target = null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, directory + "/" + ALBUM_NAME);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);

                target = resolver.insert(collection, values);
                if (target == null) {
                    call.reject("Gagal membuat entri MediaStore.");
                    return;
                }

                copyToOutput(source, resolver.openOutputStream(target));

                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(target, done, null, null);
            } else {
                File album = new File(Environment.getExternalStoragePublicDirectory(directory), ALBUM_NAME);
                if (!album.isDirectory() && !album.mkdirs()) {
                    call.reject("Gagal membuat folder " + ALBUM_NAME + ".");
                    return;
                }

                File destination = uniqueFile(album, fileName);
                copyToOutput(source, new FileOutputStream(destination));

                values.put(MediaStore.MediaColumns.DATA, destination.getAbsolutePath());
                target = resolver.insert(collection, values);
                if (target == null) target = Uri.fromFile(destination);

                MediaScannerConnection.scanFile(
                        getContext(),
                        new String[]{destination.getAbsolutePath()},
                        new String[]{mimeType},
                        null);
            }

            JSObject result = new JSObject();
            result.put("uri", target.toString());
            result.put("path", directory + "/" + ALBUM_NAME + "/" + fileName);
            call.resolve(result);
        } catch (Exception error) {
            if (target != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // A pending row with no data would linger in the gallery forever.
                try {
                    resolver.delete(target, null, null);
                } catch (Exception ignored) {
                    // Nothing else can be done once the insert failed.
                }
            }
            call.reject("Gagal menyimpan media ke galeri.", error);
        }
    }

    @PermissionCallback
    private void storageCallback(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            call.reject("Izin penyimpanan diperlukan untuk menulis ke galeri.");
            return;
        }
        saveMediaToGallery(call);
    }

    /** Accepts a `file://` URI or a path relative to the app cache directory. */
    private File resolveSourceFile(String filePath) {
        if (filePath.startsWith("file://")) {
            Uri uri = Uri.parse(filePath);
            String path = uri.getPath();
            return path == null ? null : new File(path);
        }
        File direct = new File(filePath);
        return direct.isAbsolute() ? direct : new File(getContext().getCacheDir(), filePath);
    }

    private static File uniqueFile(File directory, String fileName) {
        File candidate = new File(directory, fileName);
        if (!candidate.exists()) return candidate;

        int dot = fileName.lastIndexOf('.');
        String base = dot > 0 ? fileName.substring(0, dot) : fileName;
        String extension = dot > 0 ? fileName.substring(dot) : "";
        for (int index = 1; index < 1000; index += 1) {
            candidate = new File(directory, base + " (" + index + ")" + extension);
            if (!candidate.exists()) return candidate;
        }
        return candidate;
    }

    private static void copyToOutput(File source, OutputStream output) throws Exception {
        if (output == null) throw new IllegalStateException("Output stream MediaStore null.");
        try (InputStream input = new FileInputStream(source); OutputStream out = output) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            out.flush();
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
