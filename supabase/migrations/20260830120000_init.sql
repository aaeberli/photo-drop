-- photo-drop schema
--
-- Every table has RLS enabled with NO policies: anon/authenticated clients get
-- nothing, and only the service_role key (used exclusively inside edge
-- functions) can read or write. Nothing here is ever exposed to the browser.
--
-- `supabase/sql/` holds the same statements split into paste-sized pieces, for
-- when `db push` cannot reach Postgres. Change one, change the other.
--
-- No `create extension pgcrypto` here: gen_random_uuid() has been core Postgres
-- since 13, and asking for the extension only adds a statement that can fail on
-- permissions in the SQL editor.

-- ---------------------------------------------------------------------------
-- Access keys (the secret in the share link)
--
-- Two are expected in practice: one 'upload'-only key handed to everybody, and
-- one 'view'-only key the owner uses for the collage screen.
-- ---------------------------------------------------------------------------
create table if not exists access_keys (
  id           uuid primary key default gen_random_uuid(),
  label        text        not null,
  key_hash     text        not null unique,   -- sha256(key || AUTH_KEY_PEPPER), hex
  scopes       text[]      not null default array['upload'],
  revoked      boolean     not null default false,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

alter table access_keys enable row level security;

-- ---------------------------------------------------------------------------
-- Auth attempt log, used for rate limiting and for spotting brute force
-- ---------------------------------------------------------------------------
create table if not exists auth_attempts (
  id  bigserial   primary key,
  ip  text        not null,
  ok  boolean     not null,
  at  timestamptz not null default now()
);

create index if not exists auth_attempts_ip_at_idx on auth_attempts (ip, at desc);
alter table auth_attempts enable row level security;

-- ---------------------------------------------------------------------------
-- Photos
--
-- Each upload produces two files:
--
--   original_path  the untouched camera file, full resolution and full EXIF,
--                  staged in the private `uploads` bucket purely as a retry
--                  buffer. Deleted the moment it is mirrored to Google Photos,
--                  which is then the only place the original exists.
--
--   display_path   a re-encoded copy capped on the long edge (1920px WebP by
--                  default, ~250 KB), generated in the browser before upload.
--                  This is permanent and is what the collage renders. Going
--                  through a canvas bakes in EXIF orientation and drops all
--                  metadata, so this copy carries no GPS.
--
-- The collage reads display_path and does not care about Google at all, so a
-- photo appears on screen seconds after upload and an expired Google token
-- degrades to "the album mirror is behind" rather than "the collage is down".
-- ---------------------------------------------------------------------------
create table if not exists photos (
  id                    uuid primary key default gen_random_uuid(),

  original_path         text unique,          -- null once mirrored and deleted
  original_mime         text        not null,
  original_bytes        bigint,
  original_name         text,

  display_path          text unique,          -- null if the browser could not decode
  display_mime          text,                 -- image/webp, or image/jpeg fallback
  display_width         int,
  display_height        int,
  display_bytes         bigint,

  -- Cached signed URL for display_path. Held here so /photos returns the SAME
  -- url on every poll: a URL that changed each minute would bust the browser
  -- cache and re-download every tile, which on a collage left running all day
  -- is the difference between megabytes and gigabytes of egress.
  signed_url            text,
  signed_url_expires_at timestamptz,

  -- Which share link let this photo in. Kept on revocation rather than
  -- cascading, so revoking a key never destroys photos.
  uploaded_by_key       uuid references access_keys (id) on delete set null,
  uploader_ip           text,
  caption               text,

  -- Mirror-to-Google state. Independent of whether the collage can show it.
  status                text        not null default 'pending'
                          check (status in ('pending', 'syncing', 'synced', 'failed')),
  attempts              int         not null default 0,
  claimed_at            timestamptz,
  last_error            text,
  google_media_id       text,

  created_at            timestamptz not null default now(),
  synced_at             timestamptz
);

create index if not exists photos_status_created_idx on photos (status, created_at);
create index if not exists photos_uploaded_by_key_idx on photos (uploaded_by_key);
-- Drives the collage listing.
create index if not exists photos_display_created_idx
  on photos (created_at desc) where display_path is not null;

alter table photos enable row level security;

-- ---------------------------------------------------------------------------
-- Google OAuth state. Single row. The refresh token never leaves the server.
--
-- Only `photoslibrary.appendonly` is needed now that the collage reads from
-- Storage: this app writes to Google Photos and never reads back.
-- ---------------------------------------------------------------------------
create table if not exists google_oauth (
  id            int primary key default 1 check (id = 1),
  refresh_token text        not null,
  album_id      text,
  album_title   text,
  updated_at    timestamptz not null default now()
);

alter table google_oauth enable row level security;

-- ---------------------------------------------------------------------------
-- Bookkeeping for the sync worker
-- ---------------------------------------------------------------------------
create table if not exists sync_state (
  id               int primary key default 1 check (id = 1),
  last_sync_run_at timestamptz,
  last_sync_error  text
);

alter table sync_state enable row level security;

insert into sync_state (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Storage buckets
--
--   uploads  originals in transit. Emptied continuously by the sync worker.
--   display  permanent, collage-sized copies.
--
-- Both private. `uploads` is reachable only via the signed upload URLs minted
-- by the upload-url function; `display` only via the signed read URLs minted by
-- the photos function. No storage policies are created, so nothing else can
-- touch either bucket.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  -- These limits are the ONLY server-side enforcement of upload size. The
  -- `sizeBytes` checked in upload-url is client-declared and a signed upload
  -- URL carries no size constraint, so Storage is the only layer that sees the
  -- real payload. 26214400 = 25 MB, matching MAX_UPLOAD_BYTES.
  ('uploads', 'uploads', false, 26214400,
   array['image/jpeg', 'image/png', 'image/webp', 'image/avif',
         'image/heic', 'image/heif', 'image/gif']),
  ('display', 'display', false, 4194304, array['image/webp', 'image/jpeg'])
on conflict (id) do update
  set file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Atomically claim a batch of photos for mirroring to Google.
--
-- `for update skip locked` means two concurrent sync runs (the fire-and-forget
-- kick from /commit and the cron tick) can never grab the same photo and upload
-- it to the album twice. Rows stuck in 'syncing' for over 10 minutes are
-- reclaimed, which covers an edge function that timed out mid-batch.
-- ---------------------------------------------------------------------------
create or replace function claim_pending_photos(batch_size int default 20, max_attempts int default 5)
returns setof photos
language plpgsql
security definer
set search_path = public
as $$
begin
  -- SECURITY DEFINER bypasses RLS, and `public` is exposed over PostgREST, so
  -- without this anyone with the anon key could call this and mutate `photos`.
  -- Grants are revoked below too; this check does not depend on them.
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
$$;

-- ---------------------------------------------------------------------------
-- Storage accounting.
--
-- The free tier caps file storage at 1 GB, and blowing through it fails uploads
-- in ways that are confusing from a phone. `upload-url` checks this before
-- minting a URL so guests get a clear message instead.
--
--   select * from storage_usage();
-- ---------------------------------------------------------------------------
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
    -- Originals still waiting to be mirrored. Transient by design.
    coalesce(sum(original_bytes) filter (where original_path is not null), 0),
    coalesce(avg(display_bytes)::bigint, 0)
  from photos;
$$;

-- ---------------------------------------------------------------------------
-- Housekeeping: drop old auth attempts so the table cannot grow forever
-- ---------------------------------------------------------------------------
create or replace function prune_auth_attempts() returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'permission denied for prune_auth_attempts' using errcode = '42501';
  end if;

  delete from auth_attempts where at < now() - interval '7 days';
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock the SECURITY DEFINER functions down.
--
-- Supabase ships `alter default privileges in schema public grant all on
-- functions to postgres, anon, authenticated, service_role`, so anon and
-- authenticated hold *direct* EXECUTE grants on everything created here. They
-- do not inherit from PUBLIC, so revoking PUBLIC alone changes nothing — they
-- have to be named.
--
-- Without this, RLS on these tables is decorative: `public` is exposed over
-- PostgREST, so /rest/v1/rpc/<name> with the anon key would run as the owner.
-- ---------------------------------------------------------------------------
revoke execute on function claim_pending_photos(int, int) from public, anon, authenticated;
revoke execute on function storage_usage()                from public, anon, authenticated;
revoke execute on function prune_auth_attempts()          from public, anon, authenticated;

grant execute on function claim_pending_photos(int, int) to service_role;
grant execute on function storage_usage()                to service_role;
grant execute on function prune_auth_attempts()          to service_role;
create table if not exists upload_grants (
  id            uuid primary key default gen_random_uuid(),
  key_id        uuid        references access_keys (id) on delete set null,
  original_path text        not null unique,
  display_path  text,
  ip            text,
  committed     boolean     not null default false,
  created_at    timestamptz not null default now()
);

-- Drives the per-key rate limit.
create index if not exists upload_grants_key_created_idx
  on upload_grants (key_id, created_at desc);

-- Drives the orphan sweep: uncommitted grants, oldest first.
create index if not exists upload_grants_uncommitted_idx
  on upload_grants (created_at) where not committed;

alter table upload_grants enable row level security;

-- ---------------------------------------------------------------------------
-- Enforce the size ceiling where the bytes actually arrive.
--
-- `upload-url` validated a client-supplied `sizeBytes`, which a client can
-- simply lie about — the signed URL carries no size constraint. Storage is the
-- only layer that sees the real payload, so the limit belongs here.
--
-- 26214400 = 25 MB, matching MAX_UPLOAD_BYTES.
-- 4194304  = 4 MB, generous for a 1920px WebP that normally lands under 400 KB.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Uncommitted grants past their grace period, for the sweeper.
-- ---------------------------------------------------------------------------
create or replace function orphaned_grants(grace_minutes int default 60, batch_size int default 200)
returns setof upload_grants
language plpgsql
security definer
set search_path = public
as $orphans$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'permission denied for orphaned_grants' using errcode = '42501';
  end if;

  return query
  select *
    from upload_grants
   where not committed
     and created_at < now() - make_interval(mins => grace_minutes)
   order by created_at
   limit batch_size;
end;
$orphans$;

-- ---------------------------------------------------------------------------
-- Count recent grants for one key, for the rate limit.
-- ---------------------------------------------------------------------------
create or replace function recent_grant_count(p_key_id uuid, window_minutes int default 60)
returns bigint
language plpgsql
security definer
set search_path = public
as $grants$
declare
  n bigint;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'permission denied for recent_grant_count' using errcode = '42501';
  end if;

  select count(*) into n
    from upload_grants
   where key_id = p_key_id
     and created_at > now() - make_interval(mins => window_minutes);

  return n;
end;
$grants$;

-- `create or replace function` resets privileges to the schema defaults, which
-- on Supabase hands EXECUTE back to anon and authenticated. Always re-apply.
revoke execute on function orphaned_grants(int, int) from public, anon, authenticated;
revoke execute on function recent_grant_count(uuid, int) from public, anon, authenticated;
grant execute on function orphaned_grants(int, int) to service_role;
grant execute on function recent_grant_count(uuid, int) to service_role;
