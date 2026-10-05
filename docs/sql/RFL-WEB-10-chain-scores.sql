-- RFL-WEB-10 — cap stale chain sellability scores at 40 (one-off backfill).
--
-- WRITE-ONLY from Claude Code. Joey pastes this into the Supabase web SQL
-- editor himself; nothing here has been executed by tooling.
--
-- Why: RFL-04 backfilled businesses.is_chain (docs/sql/RFL-04-chain-backfill.sql)
-- but deliberately did not recompute scores — the chain cap applies on the
-- next audit of each business. Audits completed BEFORE a business was
-- flagged therefore still carry a sellability above the cap (Ulta Beauty
-- showed > 40 on 2026-10-05). This applies the cap the scorer applies
-- (packages/shared/src/scoring.ts, CLAUDE.md 4.2: is_chain → 40, lowest
-- cap wins, `capped` names it, `chain: true` flag) to those stored rows.
--
-- Rule: for every audit whose business is_chain = true and whose
-- sellability_score > 40:
--   sellability_score := 40
--   score_breakdown.capped := 'chain', score_breakdown.chain := true
--   (mirrored into score_breakdown.sellability.{capped,chain}, where the
--   scorer also writes them; the pre-cap value is kept as
--   score_breakdown.sellability_before_chain_cap so nothing is lost)
-- Excluded, exactly as the scorer excludes them: no-website / social-only
-- special cases (score_breakdown.sellability.specialCase = 'no_website'
-- stays 95 — PRD 4.4 / CLAUDE.md 6.7 routing is never capped). PART 1
-- lists how many such rows exist so the exclusion is visible; to cap them
-- too, delete the two `and coalesce(...) is distinct from 'no_website'`
-- lines in PART 2.
--
-- Health and star grade are untouched (they measure the site, not the
-- lead). Analyst verdicts already written for these rows are left as they
-- are; the Analyst gate (RFL-05) skips chains going forward.
--
-- HOW TO RUN
--   1. Select PART 1 and run it (read-only): the count by business, the
--      row list, and the excluded no-website rows.
--   2. Select PART 2 and run it (one transaction, ends in COMMIT). The
--      RETURNING rows are what changed.
--   3. Select PART 3 and run it (read-only): 0 chain audits above 40, and
--      every Ulta Beauty row ≤ 40 with capped = 'chain'.


-- ===========================================================================
-- PART 1 — preview (read-only)
-- ===========================================================================

select count(*)                          as audits_to_cap,
       count(distinct a.business_id)     as businesses,
       min(a.sellability_score)          as lowest_current,
       max(a.sellability_score)          as highest_current
from audits a
join businesses b on b.id = a.business_id
where b.is_chain = true
  and a.sellability_score > 40
  and coalesce(a.score_breakdown #>> '{sellability,specialCase}', '') is distinct from 'no_website';

-- Per business, then per audit.
select b.name, b.chain_reason, count(*) as audits, max(a.sellability_score) as highest
from audits a
join businesses b on b.id = a.business_id
where b.is_chain = true
  and a.sellability_score > 40
  and coalesce(a.score_breakdown #>> '{sellability,specialCase}', '') is distinct from 'no_website'
group by b.name, b.chain_reason
order by highest desc, b.name;

select a.id as audit_id, b.name, a.status, a.completed_at,
       a.sellability_score,
       a.score_breakdown ->> 'capped'  as capped_today,
       a.score_breakdown ->  'chain'   as chain_flag_today,
       a.website_health_score, a.star_grade
from audits a
join businesses b on b.id = a.business_id
where b.is_chain = true
  and a.sellability_score > 40
  and coalesce(a.score_breakdown #>> '{sellability,specialCase}', '') is distinct from 'no_website'
order by b.name, a.completed_at desc nulls last;

-- Excluded on purpose (no-website / social-only chains stay 95).
select count(*) as excluded_no_website_chain_audits
from audits a
join businesses b on b.id = a.business_id
where b.is_chain = true
  and a.sellability_score > 40
  and a.score_breakdown #>> '{sellability,specialCase}' = 'no_website';


-- ===========================================================================
-- PART 2 — cap (one transaction)
-- ===========================================================================

begin;

update audits a
set sellability_score = 40,
    score_breakdown =
      coalesce(a.score_breakdown, '{}'::jsonb)
      || jsonb_build_object(
           'capped', 'chain',
           'chain', true,
           'sellability_before_chain_cap', a.sellability_score,
           'sellability',
             coalesce(a.score_breakdown -> 'sellability', '{}'::jsonb)
             || jsonb_build_object('capped', 'chain', 'chain', true)
         )
from businesses b
where b.id = a.business_id
  and b.is_chain = true
  and a.sellability_score > 40
  and coalesce(a.score_breakdown #>> '{sellability,specialCase}', '') is distinct from 'no_website'
returning a.id as audit_id, b.name,
          (a.score_breakdown ->> 'sellability_before_chain_cap')::int as was,
          a.sellability_score as now_score,
          a.score_breakdown ->> 'capped' as capped;

commit;


-- ===========================================================================
-- PART 3 — verify (read-only)
-- ===========================================================================

-- Expect 0 (only the excluded no-website special cases may remain above 40).
select count(*) as chain_audits_over_40
from audits a
join businesses b on b.id = a.business_id
where b.is_chain = true
  and a.sellability_score > 40
  and coalesce(a.score_breakdown #>> '{sellability,specialCase}', '') is distinct from 'no_website';

-- Ulta Beauty: every audit ≤ 40, capped = 'chain', chain = true.
select b.name, b.id as business_id, a.id as audit_id, a.status, a.completed_at,
       a.sellability_score,
       a.score_breakdown ->> 'capped'                         as capped,
       a.score_breakdown ->  'chain'                          as chain_flag,
       a.score_breakdown ->> 'sellability_before_chain_cap'   as was
from audits a
join businesses b on b.id = a.business_id
where b.name ilike 'ulta beauty%' or b.name_normalized like 'ulta%'
order by b.name, a.completed_at desc nulls last;

-- What the Leads view will now show for every chain (newest completed audit).
select distinct on (b.id)
       b.name, b.chain_reason, a.sellability_score, a.score_breakdown ->> 'capped' as capped, a.completed_at
from businesses b
join audits a on a.business_id = b.id and a.status = 'completed'
where b.is_chain = true
order by b.id, a.completed_at desc nulls last;
