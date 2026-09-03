-- photo-drop 1/3: tables, indexes, RLS
--
-- Paste into the Supabase SQL editor and Run. Safe to re-run.
-- Every table gets RLS enabled with NO policies, so anon and authenticated
-- clients can read nothing; only the service_role key used inside the edge
-- functions can touch these.

create table if not exists access_keys (
  id           uuid primary key default gen_random_uuid(),
  label        text        not null,
  key_hash     text        not null unique,
  scopes       text[]      not null default array['upload'],
  revoked      boolean     not null default false,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

alter table access_keys enable row level security;

create table if not exists auth_attempts (
  id  bigserial   primary key,
  ip  text        not null,
  ok  boolean     not null,
  at  timestamptz not null default now()
);

create index if not exists auth_attempts_ip_at_idx on auth_attempts (ip, at desc);
alter table auth_attempts enable row level security;

create table if not exists photos (
  id                    uuid primary key default gen_random_uuid(),

  original_path         text unique,
  original_mime         text        not null,
  original_bytes        bigint,
  original_name         text,

  display_path          text unique,
  display_mime          text,
  display_width         int,
  display_height        int,
  display_bytes         bigint,

  signed_url            text,
  signed_url_expires_at timestamptz,

  -- Which share link let this photo in. Kept on revocation rather than
  -- cascading, so revoking a key never destroys photos.
  uploaded_by_key       uuid references access_keys (id) on delete set null,
  uploader_ip           text,
  caption               text,

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
create index if not exists photos_display_created_idx
  on photos (created_at desc) where display_path is not null;

alter table photos enable row level security;

create table if not exists google_oauth (
  id            int primary key default 1 check (id = 1),
  refresh_token text        not null,
  album_id      text,
  album_title   text,
  updated_at    timestamptz not null default now()
);

alter table google_oauth enable row level security;

create table if not exists sync_state (
  id               int primary key default 1 check (id = 1),
  last_sync_run_at timestamptz,
  last_sync_error  text
);

alter table sync_state enable row level security;

insert into sync_state (id) values (1) on conflict (id) do nothing;
