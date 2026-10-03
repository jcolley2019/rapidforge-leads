-- RapidForge migration 0007a — audits.provisional (audit finding 4, RFL-03)
-- WRITE-ONLY: Joey pastes this into the Supabase web SQL editor.
-- Requires 0002.
--
-- provisional = the audit's scores are placeholders, not measurements. Set
-- when bot protection (HTTP 401/403/429/503 or a challenge page) answered
-- instead of the site: health is the neutral 50, the audit carries one low
-- issue "Site could not be audited (bot protection)", and the dashboard
-- tags the score "provisional". Provisional audits are never reused by the
-- 30-day cache — the next audit re-probes the site.
--
-- The worker only ever WRITES this column as true (blocked audits); every
-- other insert omits it and gets the default, so normal audits keep working
-- on a database that has not applied this yet. Apply it BEFORE running a
-- worker at RFL-03 or later, or blocked-site audits will fail to insert.
--
-- One column, nothing else. Existing RLS policies on audits cover it.

alter table audits
  add column if not exists provisional boolean not null default false;
