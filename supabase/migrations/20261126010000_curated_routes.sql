-- ALLMOVA — curated route recommendations
--
-- Apply in the Supabase SQL editor or with `supabase db push`. The script is
-- idempotent so it can be re-run on a database that already has part of it.
--
-- `curated_routes` is editorial content: the mobile client only reads active
-- rows, while inserts/updates are made from the dashboard or a service-role
-- script. No client write policy is granted on purpose.

begin;

create table if not exists public.curated_routes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text,
  sport_type text not null default 'cycling'
    check (sport_type in ('cycling', 'run', 'walking', 'hike')),
  distance_meters integer not null default 0 check (distance_meters >= 0),
  elevation_gain integer not null default 0 check (elevation_gain >= 0),
  difficulty text not null default 'easy'
    check (difficulty in ('easy', 'medium', 'hard')),
  description text,
  -- GeoJSON LineString (lng/lat order) consumed by parseActivityGeometry.
  coordinates jsonb not null,
  is_pro boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists curated_routes_active_created_idx
  on public.curated_routes (is_active, created_at desc);

create index if not exists curated_routes_sport_idx
  on public.curated_routes (sport_type, is_active);

alter table public.curated_routes enable row level security;

-- Active recommendations are public reading; the feed works before sign-in and
-- the app filters by sport on the device.
drop policy if exists curated_routes_read_active on public.curated_routes;
create policy curated_routes_read_active
  on public.curated_routes
  for select
  to anon, authenticated
  using (is_active = true);

grant select on public.curated_routes to anon, authenticated;
revoke insert, update, delete on public.curated_routes from anon, authenticated;

-- Keeps `updated_at` honest for dashboard edits.
create or replace function public.touch_curated_routes_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists curated_routes_touch_updated_at on public.curated_routes;
create trigger curated_routes_touch_updated_at
  before update on public.curated_routes
  for each row
  execute function public.touch_curated_routes_updated_at();

commit;

-- ---------------------------------------------------------------------------
-- Example rows (optional, safe to delete). `coordinates` accepts a GeoJSON
-- LineString or a plain `[[lng, lat, ele], ...]` array.
-- ---------------------------------------------------------------------------
-- insert into public.curated_routes
--   (name, city, sport_type, distance_meters, elevation_gain, difficulty, description, is_pro, coordinates)
-- values
--   (
--     'Loop Bukit Sentul',
--     'Bogor',
--     'cycling',
--     42000,
--     780,
--     'hard',
--     'Tanjakan panjang dengan tikungan cepat menuju puncak Bukit Sentul.',
--     true,
--     '{"type":"LineString","coordinates":[[106.85,-6.55,500],[106.86,-6.56,640],[106.87,-6.57,780]]}'::jsonb
--   );
