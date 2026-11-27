-- ALLMOVA — admin broadcast announcements (bell icon in the app header)
--
-- Apply in the Supabase SQL editor or with `supabase db push`. The script is
-- idempotent so it can be re-run on a database that already has part of it.
--
-- `announcements` is editorial content: the mobile client only reads active
-- rows, while inserts/updates are made from the dashboard / admin panel with
-- the service role. No client write policy is granted on purpose.

begin;

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  -- Only drives the accent colour of the card in the bell sheet.
  kind text not null default 'info'
    check (kind in ('info', 'warning', 'success', 'promo')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The app reads `select('*')`, so a table created earlier by the admin panel
-- only needs the columns it is missing.
alter table public.announcements add column if not exists title text;
alter table public.announcements add column if not exists body text;
alter table public.announcements add column if not exists kind text not null default 'info';
alter table public.announcements add column if not exists is_active boolean not null default true;
alter table public.announcements add column if not exists created_at timestamptz not null default now();
alter table public.announcements add column if not exists updated_at timestamptz not null default now();

create index if not exists announcements_active_created_idx
  on public.announcements (is_active, created_at desc);

alter table public.announcements enable row level security;

-- Active announcements are public reading; the bell works before sign-in and
-- the client caps the list at the 20 newest rows.
drop policy if exists announcements_read_active on public.announcements;
create policy announcements_read_active
  on public.announcements
  for select
  to anon, authenticated
  using (is_active = true);

grant select on public.announcements to anon, authenticated;
revoke insert, update, delete on public.announcements from anon, authenticated;

-- Keeps `updated_at` honest for dashboard edits.
create or replace function public.touch_announcements_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists announcements_touch_updated_at on public.announcements;
create trigger announcements_touch_updated_at
  before update on public.announcements
  for each row
  execute function public.touch_announcements_updated_at();

commit;

-- ---------------------------------------------------------------------------
-- Example row (optional, safe to delete).
-- ---------------------------------------------------------------------------
-- insert into public.announcements (title, body, kind, is_active)
-- values (
--   'Selamat datang di ALLMOVA 1.3',
--   'Filter GPS baru sudah aktif: garis rute lebih rapi di bawah flyover.',
--   'info',
--   true
-- );
