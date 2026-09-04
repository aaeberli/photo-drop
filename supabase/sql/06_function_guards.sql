-- photo-drop: optional hardening on top of 05_lock_functions.sql.
--
-- Grants drift. A later `grant all on all functions in schema public` — which
-- plenty of tutorials suggest — would silently undo 05 with no visible
-- symptom. These guards do not depend on grants at all.
--
-- PostgREST issues `set local role` from the JWT, so a service-role key
-- arrives as `service_role`. pg_cron runs jobs as the role that scheduled
-- them, normally `postgres`. Everything else is refused.
--
-- Note the $fn$ / $prune$ tags rather than $$: some SQL editors split pasted
-- input on semicolons without tracking dollar quotes, and a distinctive tag
-- survives that better. If you still get `syntax error at or near "if"`, run
-- the two CREATE statements below one at a time.
--
-- Safe to re-run.

create or replace function claim_pending_photos(batch_size int default 20, max_attempts int default 5)
returns setof photos
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'permission denied for claim_pending_photos' using errcode = '42501';
  end if;

  return query
  update photos p
     set status     = 'syncing',
         attempts   = p.attempts + 1,
         claimed_at = now()
   where p.id in (
     select id
       from photos
      where attempts < max_attempts
        and original_path is not null
        and (
          status = 'pending'
          or (status = 'syncing'
              and (claimed_at is null or claimed_at < now() - interval '10 minutes'))
        )
      order by created_at
      limit batch_size
      for update skip locked
   )
  returning p.*;
end;
$fn$;

create or replace function prune_auth_attempts() returns void
language plpgsql
security definer
set search_path = public
as $prune$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'permission denied for prune_auth_attempts' using errcode = '42501';
  end if;

  delete from auth_attempts where at < now() - interval '7 days';
end;
$prune$;

-- `create or replace function` resets privileges to the schema defaults, which
-- on Supabase means anon and authenticated get EXECUTE back. Re-apply.
revoke execute on function claim_pending_photos(int, int) from public, anon, authenticated;
revoke execute on function prune_auth_attempts() from public, anon, authenticated;
grant execute on function claim_pending_photos(int, int) to service_role;
grant execute on function prune_auth_attempts() to service_role;
