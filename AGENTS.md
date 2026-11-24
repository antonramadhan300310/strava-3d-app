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
- `src/lib/routePlannerEngine.ts` — `planRoute(waypoints, sportMode, routingMode)`.
  `snap` posts per-sport `costing`/`costing_options` to Valhalla, decodes its shape at
  precision 6, then falls back to OSRM and finally to a densified straight geodesic.
  `offtrail` skips the routers entirely. Elevation comes from Open-Meteo (≤80 samples,
  zeroes offline); `elevationGainOf` smooths before summing so DEM steps do not inflate
  the climb. `estimateSportMetrics` holds the speed/pace/Naismith formulas and feeds both
  the Routes summary card and the duration saved with a route.
- `src/hooks/useFlyoverPlayback.ts` — `requestAnimationFrame` driver. Map updates go through
  `onFrame` every frame; React state (HUD, scrubber) is throttled to ~16 Hz.
- `src/components/FlyoverMap.tsx` — imperative `applyFrame` handle; owns the map, marker,
  base line and progressive-reveal gradient. `captureFrame()` copies the WebGL buffer into a
  detached 2D canvas for the share poster.
- `src/lib/heatmapCache.ts` — splits every track into ~11 m `segmentKey` buckets and sums how
  often each one was ridden into a `weight` property.
- `src/lib/heatmapRenderer.ts` — paint for the three heatmap layers: charcoal `casing`
  (+8 px, blur 4), a soft `glow`, and the neon `core` (blur 1). Colour is a `step` on
  `weight`: cyan `#00E5FF` under 2, orange `#FF6D00` 2–4, laser red `#FF1744` from 5.
- `src/lib/mapStyleSanitizer.ts` — neutralises the basemap for cycling/run/walking;
  `sportMode: 'hike'` additionally paints path/footway/track/steps amber (`#D97706`,
  dashed, 2.6 px), keeps peak/camp/spring labels, and turns up hillshade/contours.
  Originals are snapshotted per map so switching sport restores the neutral style;
  `resetCleanAllmovaMapStyleSnapshots` clears them after `setStyle`.
- `src/lib/shareCard.ts` — HTML5 Canvas renderer for the share images. `SHARE_SIZES` holds the
  `feed` (1080×1350) and `story` (1080×1920) presets that drive both preview and export, and
  two modes: `poster` (3D map frame + vignettes, stats, elevation chart) and `sticker`
  (transparent, or a gallery photo). Stickers take a `stickerLayout` preset — `compact`
  (lockup + 1×3 metrics), `grid` (lockup + 2×3 metrics), `vertical-route` and
  `vertical-clean` (centred lockup over six stacked metrics; the route variant draws the GPS
  line as a lime accent between the third and fourth metric) — plus an optional `photo`
  (`zoom` 1–3, `offsetX/offsetY` as canvas fractions, so the DOM preview and the export share
  one set of numbers) and a `statsPosition` of `top`/`center`/`bottom`.
  `WATERMARK_WIDTH_RATIO` (18% of canvas width) drives the slim bottom-right ALLMOVA lockup
  that every tier gets — bottom-anchored text must stay above it. The MP4 exporter reuses
  `watermarkMetrics()` so the video mark matches the poster.
- `src/lib/sharePoster.ts` — offscreen MapLibre instance (`preserveDrawingBuffer`, pitch 48,
  route bearing, `applyCleanAllmovaMapStyle`, terrain + hillshade) that captures the tilted
  basemap; `fitBounds` ignores pitch, so `frameRoute` re-projects the track for a few passes
  until it sits inside the band left free by the poster typography. Returns `null` on tainted
  tiles so the poster falls back to the flat charcoal route.
- `src/lib/shareImage.ts` — writes the PNG to `Directory.Cache`, then hands it to the native
  `saveMediaToGallery` bridge for `Pictures/ALLMOVA`; falls back to Documents, the share
  sheet, or `navigator.share`/download on the web.
- `src/components/ShareActivitySheet.tsx` — size picker, mode tabs, checkerboard preview
  (the photo is layered in the DOM, only the readability gradient is baked into the canvas),
  pan/pinch gestures and the share/save actions.
- `src/lib/riderProfile.ts` — `powerZonePercents` (six lower bounds as % of FTP) feed both
  `computePowerZoneRanges` and the zone histogram, so a custom Z1–Z6 split stays consistent.
- `src/lib/subscriptionAndDeviceGuard.ts` — device UUID (`allmova_device_id`), trusted clock
  (`allmova_last_server_ms` = newest `server_now`, so a rolled-back phone clock cannot extend
  a trial), cached `active_device_id`, per-account plan snapshot, and the two RPC wrappers.
  Every network call resolves to `null` instead of throwing: offline recording always wins.
- `AuthContext` calls `sync_subscription_and_device` on launch, on foreground and from the
  athlete profile; an expired trial downgrades to `free` locally even offline.
  `claim_active_device` only runs on a *real* sign-in — Supabase also emits `SIGNED_IN` when
  it restores a stored session, and claiming there would overwrite the device that logged in
  later and defeat last-login-wins. Realtime `postgres_changes` + sync results feed
  `handleForeignDevice`, which signs out with `scope: 'local'` only when the server returns a
  non-empty id that differs from this device (never offline, never during a claim, 12 s grace).
- `TrialExpiredModal` / `SessionKickedModal` are mounted by `AccountGuardModals` above the auth
  gate. The trial flag `allmova_trial_expired_notified_${userId}` is written when the modal is
  shown, not when it is dismissed.

## Native Android & OTA

- `android/app/src/main/java/com/allmova/app/AllmovaTrackingService.java` — foreground
  service (`allmova_tracking_channel`, id 1001) that holds a `PARTIAL_WAKE_LOCK` while a
  recording runs, so the GPS watcher survives a locked screen. Started/stopped from the
  `AllmovaTrackingPlugin` (`startTrackingService` / `stopTrackingService`), which is
  registered in `MainActivity.onCreate` before `super.onCreate`.
- `src/lib/nativeTrackingService.ts` — the web-safe bridge; `useActivityRecorder` starts the
  service on Start/Resume and stops it on Pause/Finish/Save/discard. Exposes
  `nativeTrackingActive` for the `GPS Latar Belakang Aktif` badge in `RecordOverlay`, and
  `saveMediaToGallery` for the MediaStore gallery write (`Pictures/ALLMOVA`,
  `Movies/ALLMOVA`; `IS_PENDING` on API 29+, legacy path + media scan below that).
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
- MapLibre only accepts a `zoom` expression as the input of a top-level `step`/`interpolate`.
  Adding pixels to an interpolated width has to be folded into each stop (see `neonWidth()` in
  `heatmapRenderer.ts`); wrapping it in `['+', ...]` fails with a layer paint error.
- The same rule applies to `scaleLineWidth()` in `mapStyleSanitizer.ts`: it scales the output
  stops of a top-level `interpolate`/`step` instead of wrapping the expression in `['*', ...]`.
- `ShareActivitySheet` and the video exporter both draw the watermark unconditionally — there
  is no Pro gate to re-add.
