-- ALLMOVA — read the plan from every column the admin panel may write
--
-- The `allmova-landing` admin panel and older schema versions store the plan in
-- `plan_tier` / `tier` / `subscription_tier` and the expiry in
-- `pro_expires_at` / `plan_expires_at` / `subscription_expires_at` /
-- `expires_at` / `pro_until`. The previous RPCs only read `tier` and
-- `pro_expires_at`, so an activation written to `plan_tier` never reached the
-- app and it kept showing AKUN FREE.
--
-- Idempotent: safe to re-run on a database that already has part of it.

begin;

-- ---------------------------------------------------------------------------
-- 1. Column readers (jsonb keeps them working when a column does not exist)
-- ---------------------------------------------------------------------------
create or replace function public.profile_plan_tier(p_row jsonb)
returns text
language sql
immutable
as $$
  select lower(coalesce(
    nullif(btrim(p_row->>'plan_tier'), ''),
    nullif(btrim(p_row->>'tier'), ''),
    nullif(btrim(p_row->>'subscription_tier'), ''),
    'free'
  ));
$$;

create or replace function public.profile_plan_expires_at(p_row jsonb)
returns timestamptz
language plpgsql
immutable
as $$
declare
  v_text text;
begin
  v_text := coalesce(
    nullif(btrim(p_row->>'pro_expires_at'), ''),
    nullif(btrim(p_row->>'plan_expires_at'), ''),
    nullif(btrim(p_row->>'subscription_expires_at'), ''),
    nullif(btrim(p_row->>'expires_at'), ''),
    nullif(btrim(p_row->>'pro_until'), '')
  );
  if v_text is null then
    return null;
  end if;
  begin
    return v_text::timestamptz;
  exception
    when others then
      -- An editor may type a free-form note; treat it as "no expiry".
      return null;
  end;
end;
$$;

-- `pro`, `lifetime`, `owner` and `premium` all unlock the Pro features.
create or replace function public.profile_is_pro(p_row jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce((p_row->>'is_owner')::boolean, false)
      or public.profile_plan_tier(p_row) in ('pro', 'lifetime', 'owner', 'premium');
$$;

-- ---------------------------------------------------------------------------
-- 2. RPC: claim this device (last login wins)
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
  v_json jsonb;
  v_expires timestamptz;
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
         device_updated_at = v_now
   where id = v_uid
   returning * into v_row;

  v_json := to_jsonb(v_row);
  v_expires := public.profile_plan_expires_at(v_json);

  -- A dated Pro plan that has run out downgrades, mirroring the client rule.
  if v_row.is_owner = false
     and public.profile_plan_tier(v_json) = 'pro'
     and v_expires is not null
     and v_expires <= v_now then
    update public.profiles
       set tier = 'free'
     where id = v_uid
     returning * into v_row;
    v_json := to_jsonb(v_row);
    v_expires := public.profile_plan_expires_at(v_json);
  end if;

  return jsonb_build_object(
    'tier', case when public.profile_is_pro(v_json) then 'pro' else 'free' end,
    'plan_tier', public.profile_plan_tier(v_json),
    'pro_expires_at', v_expires,
    'plan_expires_at', v_expires,
    'is_owner', v_row.is_owner,
    'active_device_id', v_row.active_device_id,
    'downgraded', false,
    'server_now', v_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. RPC: sync subscription + read the active device (no device write)
-- ---------------------------------------------------------------------------
create or replace function public.sync_subscription_and_device()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.profiles%rowtype;
  v_now timestamptz := now();
  v_downgraded boolean := false;
  v_json jsonb;
  v_expires timestamptz;
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
    v_json := to_jsonb(v_row);
    v_expires := public.profile_plan_expires_at(v_json);

    if v_row.is_owner = false
       and public.profile_plan_tier(v_json) = 'pro'
       and v_expires is not null
       and v_expires <= v_now then
      update public.profiles
         set tier = 'free'
       where id = v_uid
       returning * into v_row;
      v_downgraded := true;
    end if;
  end if;

  v_json := to_jsonb(v_row);
  v_expires := public.profile_plan_expires_at(v_json);

  return jsonb_build_object(
    'tier', case when public.profile_is_pro(v_json) then 'pro' else 'free' end,
    'plan_tier', public.profile_plan_tier(v_json),
    'pro_expires_at', v_expires,
    'plan_expires_at', v_expires,
    'is_owner', v_row.is_owner,
    'active_device_id', v_row.active_device_id,
    'downgraded', v_downgraded,
    'server_now', v_now
  );
end;
$$;

revoke all on function public.profile_plan_tier(jsonb) from public;
revoke all on function public.profile_plan_expires_at(jsonb) from public;
revoke all on function public.profile_is_pro(jsonb) from public;
revoke all on function public.claim_active_device(text) from public;
revoke all on function public.sync_subscription_and_device() from public;
grant execute on function public.claim_active_device(text) to authenticated;
grant execute on function public.sync_subscription_and_device() to authenticated;

commit;
