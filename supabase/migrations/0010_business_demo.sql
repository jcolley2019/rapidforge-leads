-- RapidForge migration 0010 — businesses.demo_* (RFL.DEMO.1, the Build demo button)
-- WRITE-ONLY: Joey pastes this into the Supabase web SQL editor.
-- Requires 0002. Joey has ALREADY applied these statements by hand; this
-- file exists so the repo matches the database. `if not exists` makes a
-- second paste a no-op.
--
-- The worker runs `npm run demo -- --lead <businessId>` in the
-- rapidforge-demos checkout (DEMOS_DIR) and writes the outcome here:
--   demo_status       building | ready | failed
--   demo_url          https://<sub>.demos.rapidforge.ai (stored even while DNS is pending)
--   demo_preview_url  the Vercel deployment URL (needs a Vercel login to view)
--   demo_sub          the <sub> label used
--   demo_built_at     when the build reached ready
--   demo_error        "<stage>: <error>" when failed, else null
-- Existing RLS policies on businesses cover the new columns (web reads them
-- through the worker API only).

alter table businesses
  add column if not exists demo_status text
    check (demo_status in ('building', 'ready', 'failed')),
  add column if not exists demo_url text,
  add column if not exists demo_preview_url text,
  add column if not exists demo_sub text,
  add column if not exists demo_built_at timestamptz,
  add column if not exists demo_error text;
