-- photo-drop: rate-limit uploads per uploader, not per link.
--
-- Safe to re-run. Run this instead of / after 07 — it replaces the function
-- 07 created.
--
-- Why: the guest link is ONE key shared by everybody, so a per-key cap is a
-- cap on the whole party. Thirty guests uploading five photos each would trip
-- a 120/hour key limit and start returning 429 to legitimate uploaders. The
-- abuse we actually want to bound is one client looping, which is per-IP.
--
-- Both are returned so upload-url can apply a tight per-IP limit with a loose
-- per-key backstop, which still catches a distributed attempt without
-- punishing a crowd on one venue wifi... with the caveat that a venue behind a
-- single NAT looks like one IP. Hence PER_IP is generous rather than tight,
-- and the real ceiling is the storage budget plus the sweeper.

drop function if exists recent_grant_count(uuid, int);

create or replace function grant_rate(p_key_id uuid, p_ip text, window_minutes int default 60)
returns table (by_key bigint, by_ip bigint)
language plpgsql
security definer
set search_path = public
as $rate$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'permission denied for grant_rate' using errcode = '42501';
  end if;

  return query
  select
    count(*) filter (where key_id = p_key_id),
    count(*) filter (where ip = p_ip)
  from upload_grants
  where created_at > now() - make_interval(mins => window_minutes);
end;
$rate$;

-- `create or replace function` restores the schema default grants, which on
-- Supabase means anon and authenticated get EXECUTE. Always re-apply.
revoke execute on function grant_rate(uuid, text, int) from public, anon, authenticated;
grant execute on function grant_rate(uuid, text, int) to service_role;

-- ---------------------------------------------------------------------------
-- Keep upload_grants from growing forever. Committed grants are only needed
-- until the sweeper can no longer mistake them for orphans.
-- ---------------------------------------------------------------------------
create or replace function prune_upload_grants() returns void
language plpgsql
security definer
set search_path = public
as $prunegrants$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'permission denied for prune_upload_grants' using errcode = '42501';
  end if;

  delete from upload_grants
   where committed and created_at < now() - interval '7 days';
end;
$prunegrants$;

revoke execute on function prune_upload_grants() from public, anon, authenticated;
grant execute on function prune_upload_grants() to service_role;

-- Add to the nightly prune job:
--   select cron.unschedule('photo-drop-prune');
--   select cron.schedule('photo-drop-prune', '17 3 * * *',
--     $$select prune_auth_attempts(); select prune_upload_grants();$$);

select 'grant_rate ready' as status;
