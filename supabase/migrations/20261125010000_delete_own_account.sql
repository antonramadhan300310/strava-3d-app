-- ALLMOVA — permanent self-service account deletion (UU PDP compliance)
--
-- Idempotent: safe to re-run on a database that already has the function.
-- `security definer` is required because the authenticated role may not touch
-- `auth.users` directly; the function only ever deletes the caller's own rows.

begin;

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  delete from public.activities where user_id = v_uid;

  -- Some deployments never created this table; skip it instead of failing.
  if to_regclass('public.saved_routes') is not null then
    execute 'delete from public.saved_routes where user_id = $1' using v_uid;
  end if;

  delete from public.profiles where id = v_uid;

  -- Removing the auth row also invalidates every refresh token for the account.
  delete from auth.users where id = v_uid;
end;
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;

commit;
