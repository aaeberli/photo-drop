-- photo-drop: link photos to the share link they arrived on.
--
-- Only needed if you ran 01_tables.sql before this column existed —
-- `create table if not exists` will not add a column to a table that is
-- already there. A fresh setup gets this from 01_tables.sql and can skip this
-- file. Safe to re-run either way.

alter table photos
  add column if not exists uploaded_by_key uuid;

-- Added separately because `add constraint` has no `if not exists`.
do $$
begin
  alter table photos
    add constraint photos_uploaded_by_key_fkey
    foreign key (uploaded_by_key) references access_keys (id) on delete set null;
exception
  when duplicate_object then null;
end $$;

create index if not exists photos_uploaded_by_key_idx on photos (uploaded_by_key);

-- Now you can answer "which link let this in":
--
--   select k.label, count(*) as photos, max(p.created_at) as latest
--     from photos p
--     left join access_keys k on k.id = p.uploaded_by_key
--    group by k.label
--    order by photos desc;
