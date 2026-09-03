-- photo-drop: verify the setup landed. Read-only, changes nothing.
--
-- Expect exactly this:
--   tables      5 rows, all rls_enabled = true
--   buckets     2 rows, both public = false
--   functions   3 rows
--   sync_state  1 row

select 'tables' as check, table_name as name, c.relrowsecurity as rls_enabled
  from information_schema.tables t
  join pg_class c on c.relname = t.table_name
 where t.table_schema = 'public'
   and t.table_name in ('access_keys','auth_attempts','photos','google_oauth','sync_state')
 order by table_name;

select 'buckets' as check, id as name, public, file_size_limit
  from storage.buckets
 where id in ('uploads','display')
 order by id;

select 'functions' as check, routine_name as name
  from information_schema.routines
 where routine_schema = 'public'
   and routine_name in ('claim_pending_photos','storage_usage','prune_auth_attempts')
 order by routine_name;

select 'sync_state' as check, id::text as name from sync_state;
