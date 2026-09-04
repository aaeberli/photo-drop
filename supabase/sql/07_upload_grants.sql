-- photo-drop: bound staging-bucket abuse.
--
-- Safe to re-run.
--
-- The problem: `upload-url` minted signed URLs with no record and no limit, and
-- nothing ever deleted an object that was uploaded but never committed. The
-- budget guard sums `display_bytes` from `photos`, so uncommitted originals
-- were invisible to it. Anyone holding the guest link could loop URL requests,
-- PUT bytes, never commit, and exhaust the 1 GB while the guard reported room.
--
-- Recording each issued URL fixes both halves: it gives a per-key rate limit,
-- and it turns orphan detection into an exact set difference rather than a
-- guess about what a stray object was for.

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
update storage.buckets set file_size_limit = 26214400 where id = 'uploads';
update storage.buckets set file_size_limit = 4194304  where id = 'display';

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

select 'upload_grants ready' as status, count(*) as existing_grants from upload_grants;
