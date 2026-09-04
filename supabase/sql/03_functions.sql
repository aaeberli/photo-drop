-- photo-drop 3/3: functions
--
-- Run 01_tables.sql first — claim_pending_photos returns `setof photos`, so the
-- photos table has to exist. Safe to re-run.
--
-- Then run 05_lock_functions.sql. These are SECURITY DEFINER and live in
-- `public`, which Supabase exposes over PostgREST, so until their grants are
-- revoked from anon and authenticated they are callable by anyone holding the
-- project's anon key — which makes RLS on these tables decorative.

-- Atomically claim a batch of photos for mirroring to Google.
-- `for update skip locked` means two concurrent sync runs (the fire-and-forget
-- kick from /commit and the cron tick) can never grab the same photo and upload
-- it twice. Rows stuck in 'syncing' for over 10 minutes are reclaimed, which
-- covers an edge function that timed out mid-batch.
create or replace function claim_pending_photos(batch_size int default 20, max_attempts int default 5)
returns setof photos
language plpgsql
security definer
set search_path = public
as $$
begin
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
$$;

-- Storage accounting. The free tier caps file storage at 1 GB; upload-url
-- checks this before minting a URL so guests get a clear message rather than a
-- broken upload.  Usage:  select * from storage_usage();
create or replace function storage_usage()
returns table (
  photos_total        bigint,
  photos_in_collage   bigint,
  display_bytes       bigint,
  staged_bytes        bigint,
  avg_display_bytes   bigint
)
language sql
security definer
set search_path = public
as $$
  select
    count(*),
    count(*) filter (where display_path is not null),
    coalesce(sum(display_bytes), 0),
    coalesce(sum(original_bytes) filter (where original_path is not null), 0),
    coalesce(avg(display_bytes)::bigint, 0)
  from photos;
$$;

-- Housekeeping, called nightly by cron.
create or replace function prune_auth_attempts() returns void
language sql
security definer
set search_path = public
as $$
  delete from auth_attempts where at < now() - interval '7 days';
$$;
