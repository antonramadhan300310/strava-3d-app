-- ALLMOVA — isolate activities and saved routes per account
--
-- Apply in the Supabase SQL editor or with `supabase db push`. The script is
-- idempotent and can be re-run on a database that already has part of it.
--
-- The client already filters every read and write by `user_id`; these policies
-- make that guarantee server-side, so a stale token or a hand-crafted request
-- cannot read another athlete's tracks.

begin;

-- ---------------------------------------------------------------------------
-- 1. Activities: ownership column, index and RLS
-- ---------------------------------------------------------------------------
alter table public.activities
  add column if not exists user_id uuid references auth.users (id) on delete cascade;

alter table public.activities
  alter column user_id set default auth.uid();

create index if not exists activities_user_id_idx
  on public.activities (user_id, created_at desc);

alter table public.activities enable row level security;

drop policy if exists activities_select_own on public.activities;
create policy activities_select_own
  on public.activities
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists activities_insert_own on public.activities;
create policy activities_insert_own
  on public.activities
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists activities_update_own on public.activities;
create policy activities_update_own
  on public.activities
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists activities_delete_own on public.activities;
create policy activities_delete_own
  on public.activities
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- The anon key has no business reading tracks, even before RLS kicks in.
revoke all on public.activities from anon;

-- ---------------------------------------------------------------------------
-- 2. Saved routes: same ownership rules when the table exists
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.saved_routes') is null then
    return;
  end if;

  execute $sql$
    alter table public.saved_routes
      add column if not exists user_id uuid references auth.users (id) on delete cascade
  $sql$;

  execute $sql$
    alter table public.saved_routes
      alter column user_id set default auth.uid()
  $sql$;

  execute $sql$
    create index if not exists saved_routes_user_id_idx
      on public.saved_routes (user_id)
  $sql$;

  execute 'alter table public.saved_routes enable row level security';

  execute 'drop policy if exists saved_routes_select_own on public.saved_routes';
  execute $sql$
    create policy saved_routes_select_own
      on public.saved_routes
      for select
      to authenticated
      using (auth.uid() = user_id)
  $sql$;

  execute 'drop policy if exists saved_routes_insert_own on public.saved_routes';
  execute $sql$
    create policy saved_routes_insert_own
      on public.saved_routes
      for insert
      to authenticated
      with check (auth.uid() = user_id)
  $sql$;

  execute 'drop policy if exists saved_routes_update_own on public.saved_routes';
  execute $sql$
    create policy saved_routes_update_own
      on public.saved_routes
      for update
      to authenticated
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id)
  $sql$;

  execute 'drop policy if exists saved_routes_delete_own on public.saved_routes';
  execute $sql$
    create policy saved_routes_delete_own
      on public.saved_routes
      for delete
      to authenticated
      using (auth.uid() = user_id)
  $sql$;

  execute 'revoke all on public.saved_routes from anon';
end $$;

commit;
