-- RapidForge migration 0003 — Operational (PRD 5.3)
-- WRITE-ONLY: Joey pastes this into the Supabase web SQL editor.
-- Requires 0001_tenancy.sql.

create table jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) not null,
  job_type text not null,                 -- 'scout' | 'audit_business' | 'analyst' | ...
  payload jsonb not null,
  status text default 'queued',           -- queued | running | done | failed
  attempts int default 0,
  error text,
  created_at timestamptz default now(),
  started_at timestamptz, finished_at timestamptz
);
create index on jobs (status, created_at);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) not null,
  agent_name text not null,
  job_id uuid references jobs(id),
  target_id uuid,                         -- business_id typically
  status text not null,                   -- running | completed | failed
  input jsonb, output jsonb, error text,
  model_used text,
  tokens_used int default 0,
  cost_cents int default 0,
  guardrail_passed boolean default true,
  guardrail_notes text,
  duration_ms int,
  started_at timestamptz default now(),
  ended_at timestamptz
);

create table usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) not null,
  event_type text not null,               -- 'places_call' | 'pagespeed_call' | 'ai_call' | 'audit_run'
  cost_cents int default 0,
  metadata jsonb,
  created_at timestamptz default now()
);
create index on usage_events (workspace_id, created_at);
