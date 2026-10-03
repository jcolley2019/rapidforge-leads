-- RapidForge migration 0008 — businesses.chain_reason + name_normalized (RFL-04, audit finding 3)
-- WRITE-ONLY: Joey pastes this into the Supabase web SQL editor.
-- Requires 0002.
--
-- chain_reason: why the worker marked is_chain —
--   'known_brand'    name starts with a brand in lib/chains.ts KNOWN_CHAIN_BRANDS
--   'url_shape'      the GBP website link is a store-locator page
--   'multi_location' same normalized name at ≥3 distinct place ids in the
--                    workspace (one search or across searches)
--
-- name_normalized: the worker's canonical name (lowercase, punctuation and
-- "LLC/Inc/Co" dropped, "- Boise" / "#123" / "of Boise" suffixes dropped).
-- Written by the worker on every upsert; the UPDATE below is a SQL
-- approximation for existing rows so the index is useful immediately, and
-- the worker overwrites it on the next refresh. Indexed with workspace_id:
-- that pair is the multi-location lookup the worker runs at every upsert.
--
-- Apply BEFORE running a worker at RFL-04 or later — every business upsert
-- now writes both columns and will fail on a database without them.
-- Existing RLS policies on businesses cover the new columns.

alter table businesses
  add column if not exists chain_reason text
    check (chain_reason in ('known_brand', 'url_shape', 'multi_location')),
  add column if not exists name_normalized text;

update businesses
set name_normalized = nullif(
  trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(lower(name), '\s+(-|–|—|\||#|:)\s*.*$', ''),  -- " - Boise", " #123"
              '\s*\([^)]*\)\s*$', ''),                                     -- "(Boise)"
            '[^a-z0-9]+', ' ', 'g'),                                        -- punctuation → space
          '^the\s+', ''),                                                   -- leading "the"
        '\s+of\s+[a-z0-9 ]+$', ''),                                         -- "of Boise"
      '\s+(llc|inc|incorporated|co|corp|corporation|ltd|limited|lp|llp|pllc|pc|pa|dba)\s*$', '')
  ),
  ''
)
where name_normalized is null;

create index if not exists businesses_workspace_name_normalized_idx
  on businesses (workspace_id, name_normalized);
