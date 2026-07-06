-- 0006_screenshots_bucket.sql — Sprint 6 (PRD 6.8 screenshot pipeline)
--
-- Creates the public 'screenshots' Storage bucket the worker uploads
-- homepage screenshots into (service-role client; paths are
-- {business_id}/{audit_id}/{desktop|mobile}.jpg).
--
-- Access model (decided Sprint 6, documented in SESSION_REPORT S6):
--   * WRITES: worker only, via the service-role key — bypasses RLS, so no
--     insert/update policy is needed or wanted (browsers never write here).
--   * READS: bucket is PUBLIC — the dashboard renders plain public URLs
--     (https://<project>.supabase.co/storage/v1/object/public/screenshots/…).
--     Screenshots are captures of public homepages; nothing sensitive.
--
-- Paste into the Supabase web SQL editor. Safe to run more than once.

insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', true)
on conflict (id) do update set public = true;

-- Explicit public-read policy on the underlying objects table so the bucket
-- also reads through the Storage API (not just the /public URL endpoint).
-- Guarded: storage.objects policies error on duplicate names.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'screenshots_public_read'
  ) then
    create policy screenshots_public_read
      on storage.objects for select
      using (bucket_id = 'screenshots');
  end if;
end $$;
