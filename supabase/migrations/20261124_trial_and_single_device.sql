-- ALLMOVA — 14-day Pro trial (auto-downgrade) + single-device login (last login wins)
--
-- Apply in the Supabase SQL editor or with `supabase db push`. The script is
-- idempotent: it can be re-run on a database that already has part of it.
--
-- Server clock: every RPC returns `server_now` so the client can anchor its
-- trusted clock and refuse to extend a trial by rolling the phone clock back.

begin;

-- ---------------------------------------------------------------------------
-- 1. Profile columns
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists tier text not null default 'free';
alter table public.profiles add column if not exists pro_expires_at timestamptz;
alter table public.profiles add column if not exists is_owner boolean not null default false;
alter table public.profiles add column if not exists active_device_id text;
alter table public.profiles add column if not exists device_updated_at timestamptz;

alter table public.profiles drop constraint if exists profiles_tier_check;
alter table public.profiles
  add constraint profiles_tier_check check (tier in ('free', 'pro'));

create index if not exists profiles_active_device_idx
  on public.profiles (active_device_id);

-- Carry the legacy `plan_tier` value over when that column still exists.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'plan_tier'
  ) then
    execute $sql$
      update public.profiles
         set tier = 'pro'
       where plan_tier = 'pro' and tier <> 'pro'
    $sql$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. New profile -> 14-day Pro trial
-- ---------------------------------------------------------------------------
create or replace function public.start_pro_trial()
returns trigger
language plpgsql
as $$
begin
  if new.is_owner then
    new.tier := 'pro';
    new.pro_expires_at := null;
  elsif new.pro_expires_at is null then
    new.tier := 'pro';
    new.pro_expires_at := now() + interval '14 days';
  end if;
  return new;
end;
$$;

drop trigger if exists start_pro_trial on public.profiles;
create trigger start_pro_trial
  before insert on public.profiles
  for each row execute function public.start_pro_trial();

-- ---------------------------------------------------------------------------
-- 3. Plan fields are server-owned
-- ---------------------------------------------------------------------------
-- Service-role / SQL-editor writes are trusted (admin activation). A signed-in
-- client may only downgrade itself, never upgrade or self-mark as owner.
create or replace function public.protect_profile_plan()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), 'service_role') = 'service_role' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.is_owner is distinct from old.is_owner then
      new.is_owner := old.is_owner;
    end if;
    if new.tier = 'pro' and old.tier is distinct from 'pro' then
      new.tier := old.tier;
    end if;
    if new.pro_expires_at is distinct from old.pro_expires_at
       and (old.pro_expires_at is null or new.pro_expires_at > old.pro_expires_at) then
      new.pro_expires_at := old.pro_expires_at;
    end if;
  end if;

  return new;
end;
$$;

-- Older deployments guarded the same fields under a different name.
drop trigger if exists protect_profile_tier on public.profiles;
drop trigger if exists protect_profile_plan on public.profiles;
create trigger protect_profile_plan
  before update on public.profiles
  for each row execute function public.protect_profile_plan();

-- ---------------------------------------------------------------------------
-- 4. RPC: claim this device (last login wins)
-- ---------------------------------------------------------------------------
create or replace function public.claim_active_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.profiles%rowtype;
  v_now timestamptz := now();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_device_id is null or btrim(p_device_id) = '' then
    raise exception 'device_id_required' using errcode = '22023';
  end if;

  -- First login on a fresh account: the insert trigger starts the trial.
  insert into public.profiles (id, email, display_name, tier, pro_expires_at)
  values (
    v_uid,
    (select u.email from auth.users u where u.id = v_uid),
    null,
    'free',
    null
  )
  on conflict (id) do nothing;

  update public.profiles
     set active_device_id = p_device_id,
         device_updated_at = v_now,
         tier = case
           when is_owner = false
                and tier = 'pro'
                and pro_expires_at is not null
                and pro_expires_at <= v_now
           then 'free'
           else tier
         end
   where id = v_uid
   returning * into v_row;

  return jsonb_build_object(
    'tier', v_row.tier,
    'pro_expires_at', v_row.pro_expires_at,
    'is_owner', v_row.is_owner,
    'active_device_id', v_row.active_device_id,
    'downgraded', false,
    'server_now', v_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RPC: sync subscription + read the active device (no device write)
-- ---------------------------------------------------------------------------
create or replace function public.sync_subscription_and_device()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_before text;
  v_row public.profiles%rowtype;
  v_now timestamptz := now();
  v_downgraded boolean := false;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_row from public.profiles where id = v_uid;

  if v_row.id is null then
    insert into public.profiles (id, email, display_name, tier, pro_expires_at)
    values (
      v_uid,
      (select u.email from auth.users u where u.id = v_uid),
      null,
      'free',
      null
    )
    returning * into v_row;
  else
    v_before := v_row.tier;

    if v_row.is_owner = false
       and v_row.tier = 'pro'
       and v_row.pro_expires_at is not null
       and v_row.pro_expires_at <= v_now then
      update public.profiles
         set tier = 'free'
       where id = v_uid
       returning * into v_row;
      v_downgraded := true;
    end if;
  end if;

  return jsonb_build_object(
    'tier', v_row.tier,
    'pro_expires_at', v_row.pro_expires_at,
    'is_owner', v_row.is_owner,
    'active_device_id', v_row.active_device_id,
    'downgraded', v_downgraded,
    'server_now', v_now
  );
end;
$$;

revoke all on function public.claim_active_device(text) from public;
revoke all on function public.sync_subscription_and_device() from public;
grant execute on function public.claim_active_device(text) to authenticated;
grant execute on function public.sync_subscription_and_device() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Row level security + realtime
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

do $$
begin
  create policy profiles_select_own on public.profiles
    for select using (auth.uid() = id);
exception when duplicate_object then null;
end $$;

do $$
begin
  create policy profiles_insert_own on public.profiles
    for insert with check (auth.uid() = id);
exception when duplicate_object then null;
end $$;

do $$
begin
  create policy profiles_update_own on public.profiles
    for update using (auth.uid() = id) with check (auth.uid() = id);
exception when duplicate_object then null;
end $$;

-- Realtime needs the full row to detect a takeover in `active_device_id`.
alter table public.profiles replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.profiles;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 7. One-time rollout: give legacy accounts the 14-day trial too
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'plan_tier'
  ) then
    execute $sql$
      update public.profiles
         set tier = 'pro', pro_expires_at = now() + interval '14 days'
       where is_owner = false
         and pro_expires_at is null
         and coalesce(plan_tier, 'free') <> 'pro'
    $sql$;
  else
    update public.profiles
       set tier = 'pro', pro_expires_at = now() + interval '14 days'
     where is_owner = false and pro_expires_at is null;
  end if;
end $$;

commit;
