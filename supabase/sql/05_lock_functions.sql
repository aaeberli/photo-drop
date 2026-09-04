-- photo-drop: stop the SECURITY DEFINER functions being callable by anon.
--
-- THIS IS THE FIX. Six plain DDL statements, no function bodies, no dollar
-- quoting — so nothing here can be mangled by a SQL editor that splits
-- statements naively. Run this first. 06_function_guards.sql is optional
-- hardening on top.
--
-- The problem: these functions live in `public`, which Supabase exposes over
-- PostgREST, and they are SECURITY DEFINER, so they run as the owner and
-- bypass RLS. Anyone with the project's anon key could POST to
-- /rest/v1/rpc/<name> and mutate `photos` or wipe `auth_attempts`, which makes
-- RLS on those tables decorative.
--
-- Why `revoke ... from public` alone does NOT work: Supabase ships
--   alter default privileges in schema public
--     grant all on functions to postgres, anon, authenticated, service_role;
-- so anon and authenticated hold *direct* EXECUTE grants on every function
-- created here. They do not inherit from PUBLIC, so revoking PUBLIC changes
-- nothing. They have to be named.
--
-- Moving the functions to an unexposed schema would be stronger, but PostgREST
-- can only invoke functions in schemas it exposes, so that would break the
-- edge functions' own rpc() calls.
--
-- Safe to re-run.

revoke execute on function claim_pending_photos(int, int) from public, anon, authenticated;
revoke execute on function storage_usage() from public, anon, authenticated;
revoke execute on function prune_auth_attempts() from public, anon, authenticated;

grant execute on function claim_pending_photos(int, int) to service_role;
grant execute on function storage_usage() to service_role;
grant execute on function prune_auth_attempts() to service_role;

-- Confirm: anon and authenticated should be gone, service_role should remain.
select routine_name, grantee, privilege_type
  from information_schema.routine_privileges
 where routine_schema = 'public'
 order by routine_name, grantee;
