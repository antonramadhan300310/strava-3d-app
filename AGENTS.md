# AGENTS.md

Personal 3D Activity Tracker — Next.js 14 App Router + Capacitor (Android) + MapLibre.
UI copy is Indonesian; code and identifiers are English.

## Commands

```bash
npm run dev                 # dev server on :3000
npm run build               # static export to out/ (next.config.mjs output: 'export')
npx tsc --noEmit            # typecheck
npx cap sync android        # copies out/ into android/app/src/main/assets/public
```

`npm run build` rewrites `.next/`, which breaks a running `next dev` process. Kill the
dev server before building, and delete `.next/` before restarting it afterwards.

## Environment

- `NEXT_PUBLIC_MAPTILER_KEY` — unset falls back to a flat dark style (`FALLBACK_STYLE`
  in `FlyoverMap.tsx`); the route still renders, terrain does not.
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — both required, otherwise
  the Activities feed shows a "belum dikonfigurasi" notice instead of data.

## Architecture

- `src/components/AppShell.tsx` — tab state and overlay composition (`routes`, `record`,
  `activities`). The map stays mounted across tabs; `active` only toggles its interactivity.
- `src/lib/flyover.ts` — turf-based route maths: `buildFlyoverPath`, `pointAt`,
  `elevationAt`, `bearingAt` (look-ahead heading), `lerpBearing` (shortest-path smoothing).
- `src/hooks/useFlyoverPlayback.ts` — `requestAnimationFrame` driver. Map updates go through
  `onFrame` every frame; React state (HUD, scrubber) is throttled to ~16 Hz.
- `src/components/FlyoverMap.tsx` — imperative `applyFrame` handle; owns the map, marker,
  base line and progressive-reveal gradient. `captureFrame()` copies the WebGL buffer into a
  detached 2D canvas for the share poster.
- `src/lib/shareCard.ts` — HTML5 Canvas renderer for the share images. `poster` (1080×1350)
  draws the map frame as a cover background plus scrims, stats and an elevation profile;
  `sticker` (1080×1080) leaves the canvas transparent and draws only the glowing route and
  stats, so it can be composited onto a photo.
- `src/lib/shareImage.ts` — writes the PNG to `Directory.Cache` and opens the Android share
  sheet, or to `Directory.Documents` when saving; falls back to `navigator.share`/download
  on the web.
- `src/components/ShareCardModal.tsx` — style tabs, preview (checkerboard behind the sticker)
  and the share/save actions.

## Native Android & OTA

- `android/app/src/main/java/com/allmova/app/AllmovaTrackingService.java` — foreground
  service (`allmova_tracking_channel`, id 1001) that holds a `PARTIAL_WAKE_LOCK` while a
  recording runs, so the GPS watcher survives a locked screen. Started/stopped from the
  `AllmovaTrackingPlugin` (`startTrackingService` / `stopTrackingService`), which is
  registered in `MainActivity.onCreate` before `super.onCreate`.
- `src/lib/nativeTrackingService.ts` — the web-safe bridge; `useActivityRecorder` starts the
  service on Start/Resume and stops it on Pause/Finish/Save/discard. Exposes
  `nativeTrackingActive` for the `GPS Latar Belakang Aktif` badge in `RecordOverlay`.
- `src/lib/otaUpdater.ts` + `src/components/OtaUpdateManager.tsx` — `@capgo/capacitor-updater`
  with `autoUpdate: false`. On launch the app calls `notifyAppReady()`, reads
  `version.json` from the `ota-latest` GitHub release, gates on `minNativeVersion` against
  `NATIVE_APP_VERSION`, then downloads/applies the zip bundle. Every network call fails
  silently so an offline start still works.
- `.github/workflows/build-apk.yml` republishes `allmova-ota-bundle.zip` (zip of `out/`),
  `version.json` and `allmova-latest.apk` to the `ota-latest` release on every push to main.

## Gotchas

- `@capgo/capacitor-updater` pulls `androidx.work` 2.10+ / `lifecycle` 2.10+, which require
  `compileSdk 35` and `minSdk 23`. `android/variables.gradle` sets both, and
  `android/gradle.properties` carries `android.suppressUnsupportedCompileSdk=35` because the
  project stays on AGP 8.2.1 / Gradle 8.2.1.
- Android 14 throws when a `location` foreground service starts without the runtime location
  permission, so `AllmovaTrackingPlugin` requests it (and `POST_NOTIFICATIONS` on API 33+)
  before `ContextCompat.startForegroundService`.

- MapLibre's CSS sets `position: relative` on its container, which defeats `absolute inset-0`.
  `FlyoverMap` nests a `h-full w-full` div inside a positioned wrapper; keep that structure.
- MapLibre clamps `pitch` to `maxPitch`, default 60. The flyover uses pitch 70, so the map is
  created with `maxPitch: 85`.
- The flyover map needs `preserveDrawingBuffer: true`; without it the WebGL buffer is cleared
  after each frame and `map.getCanvas()` captures a blank poster on Android WebView.
- PostgREST returns a PostGIS `geometry` column as hex EWKB, not GeoJSON.
  `parseActivityGeometry` in `src/lib/activity.ts` handles both.
- `line-gradient` stops must be strictly ascending — see `gradient()` in `FlyoverMap.tsx`.
