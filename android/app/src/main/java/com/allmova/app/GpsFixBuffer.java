package com.allmova.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Native record of every location fix the tracking service receives.
 *
 * The WebView is throttled (and sometimes frozen) while the screen is off, so
 * bridge callbacks can be delayed by minutes. The service writes each fix here
 * instead, and the web layer drains it whenever it becomes visible again: the
 * track recorded with the screen locked is then complete, with no gap.
 *
 * Fixes are kept in memory (capped) and appended to a JSON-lines file in the
 * app's private storage, so a process death mid-ride does not lose them either.
 */
final class GpsFixBuffer {

    private static final String TAG = "AllmovaGpsBuffer";
    private static final String FILE_NAME = "allmova_gps_buffer.jsonl";
    /** ~17 hours at 1 Hz; the file is cleared on every new recording. */
    private static final int MAX_FIXES = 60000;

    private static GpsFixBuffer instance;

    private final File file;
    private final List<JSONObject> fixes = new ArrayList<>();
    private long nextIndex = 0;
    private long lastTime = Long.MIN_VALUE;
    private boolean loaded = false;

    private GpsFixBuffer(Context context) {
        this.file = new File(context.getApplicationContext().getFilesDir(), FILE_NAME);
    }

    static synchronized GpsFixBuffer get(Context context) {
        if (instance == null) instance = new GpsFixBuffer(context);
        instance.ensureLoaded();
        return instance;
    }

    private synchronized void ensureLoaded() {
        if (loaded) return;
        loaded = true;
        if (!file.isFile()) return;

        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isEmpty()) continue;
                try {
                    JSONObject fix = new JSONObject(line);
                    fix.put("i", nextIndex);
                    nextIndex += 1;
                    lastTime = fix.optLong("t", lastTime);
                    fixes.add(fix);
                } catch (JSONException ignored) {
                    // A truncated last line after a crash is simply skipped.
                }
            }
            trim();
        } catch (Exception error) {
            Log.w(TAG, "Gagal membaca buffer GPS native", error);
        }
    }

    /**
     * Stores one fix. Non-increasing timestamps are dropped so the same position
     * reported by two providers cannot duplicate a point.
     */
    synchronized void append(
            double lat,
            double lng,
            double accuracy,
            Double altitude,
            Double speed,
            Double bearing,
            long time) {
        if (!Double.isFinite(lat) || !Double.isFinite(lng)) return null;
        if (!Double.isFinite(accuracy) || accuracy <= 0) return null;
        if (time <= 0 || time <= lastTime) return null;

        JSONObject fix = new JSONObject();
        try {
            fix.put("i", nextIndex);
            fix.put("lat", lat);
            fix.put("lng", lng);
            fix.put("acc", accuracy);
            if (altitude != null && Double.isFinite(altitude)) fix.put("alt", altitude);
            if (speed != null && Double.isFinite(speed)) fix.put("spd", speed);
            if (bearing != null && Double.isFinite(bearing)) fix.put("brg", bearing);
            fix.put("t", time);
        } catch (JSONException error) {
            return null;
        }

        nextIndex += 1;
        lastTime = time;
        fixes.add(fix);
        trim();
        appendToFile(fix);
        return fix;
    }

    private void trim() {
        while (fixes.size() > MAX_FIXES) fixes.remove(0);
    }

    /** Appends one line and closes immediately so a kill cannot lose the fix. */
    private void appendToFile(JSONObject fix) {
        try (BufferedWriter writer = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(file, true), StandardCharsets.UTF_8))) {
            writer.write(fix.toString());
            writer.newLine();
        } catch (Exception error) {
            Log.w(TAG, "Gagal menulis buffer GPS native", error);
        }
    }

    /** Fixes whose `i` is at least `since`, in recording order. */
    synchronized JSONArray since(long since) {
        JSONArray result = new JSONArray();
        for (JSONObject fix : fixes) {
            if (fix.optLong("i", -1) < since) continue;
            try {
                result.put(fix);
            } catch (JSONException ignored) {
                // Skip a row that cannot be serialised; the rest still drain.
            }
        }
        return result;
    }

    synchronized long nextIndex() {
        return nextIndex;
    }

    synchronized int size() {
        return fixes.size();
    }

    /** Drops every fix; called when a new recording starts or after a save. */
    synchronized void clear() {
        fixes.clear();
        nextIndex = 0;
        lastTime = Long.MIN_VALUE;
        try {
            if (file.exists() && !file.delete()) {
                // Truncating is enough when the delete is refused.
                try (FileOutputStream ignored = new FileOutputStream(file, false)) {
                    // Empty file.
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "Gagal menghapus buffer GPS native", error);
        }
    }
}
