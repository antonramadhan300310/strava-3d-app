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
  base line and progressive-reveal gradient.

## Gotchas

- MapLibre's CSS sets `position: relative` on its container, which defeats `absolute inset-0`.
  `FlyoverMap` nests a `h-full w-full` div inside a positioned wrapper; keep that structure.
- MapLibre clamps `pitch` to `maxPitch`, default 60. The flyover uses pitch 70, so the map is
  created with `maxPitch: 85`.
- PostgREST returns a PostGIS `geometry` column as hex EWKB, not GeoJSON.
  `parseActivityGeometry` in `src/lib/activity.ts` handles both.
- `line-gradient` stops must be strictly ascending — see `gradient()` in `FlyoverMap.tsx`.
