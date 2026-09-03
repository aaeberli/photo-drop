-- photo-drop 2/3: storage buckets
--
-- Safe to re-run.
--
--   uploads  originals in transit to Google Photos. Emptied by the sync worker.
--   display  permanent collage-sized copies. What the collage renders.
--
-- Both private. No storage policies are created, so the buckets are reachable
-- only through the signed URLs minted by the edge functions.
--
-- If this errors on permissions, create the two buckets by hand instead:
-- Dashboard -> Storage -> New bucket, named `uploads` and `display`, both with
-- "Public bucket" OFF. The size and MIME limits below are belt-and-braces; the
-- edge functions enforce their own.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('uploads', 'uploads', false, 52428800,
   array['image/jpeg', 'image/png', 'image/webp', 'image/avif',
         'image/heic', 'image/heif', 'image/gif']),
  ('display', 'display', false, 10485760,
   array['image/webp', 'image/jpeg'])
on conflict (id) do update
  set file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
