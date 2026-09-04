-- photo-drop: guard the last unguarded SECURITY DEFINER function.
--
-- Safe to re-run.
--
-- Why this exists: 05_lock_functions.sql revokes EXECUTE from anon and
-- authenticated, but a REVOKE only removes grants made by the current user. If
-- the grant came from a different role than the one your SQL editor runs as,
-- the revoke is a silent no-op — which is what happened here.
--
-- So grants cannot be relied on, and every SECURITY DEFINER function in
-- `public` needs a guard that does not depend on them. This was the only one
-- left: it was `language sql` on the assumption the revoke would hold.
--
-- PostgREST issues `set local role` from the JWT, so a service-role key
-- arrives as `service_role`. pg_cron runs jobs as the role that scheduled
-- them, normally `postgres`.

create or replace function storage_usage()
returns table (
  photos_total        bigint,
  photos_in_collage   bigint,
  display_bytes       bigint,
  staged_bytes        bigint,
  avg_display_bytes   bigint
)
language plpgsql
security definer
set search_path = public
as $usage$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'permission denied for storage_usage' using errcode = '42501';
  end if;

  return query
  select
    count(*),
    count(*) filter (where display_path is not null),
    coalesce(sum(display_bytes), 0),
    coalesce(sum(original_bytes) filter (where original_path is not null), 0),
    coalesce(avg(display_bytes)::bigint, 0)
  from photos;
end;
$usage$;

revoke execute on function storage_usage() from public, anon, authenticated;
grant execute on function storage_usage() to service_role;

-- ---------------------------------------------------------------------------
-- Verify every definer function in `public` now carries a guard.
--
-- prosecdef = true  means SECURITY DEFINER (bypasses RLS).
-- has_guard = false on a definer function is a hole, whatever the ACL says.
-- ---------------------------------------------------------------------------
select p.proname,
       p.prosecdef                                        as security_definer,
       p.prosrc like '%permission denied for%'             as has_guard,
       pg_get_userbyid(p.proowner)                        as owner,
       coalesce(p.proacl::text, 'default (all roles)')    as acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prokind = 'f'
 order by p.prosecdef desc, p.proname;
