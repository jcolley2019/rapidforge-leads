-- RapidForge migration 0001 — Tenancy (PRD 5.1)
-- WRITE-ONLY: Joey pastes this into the Supabase web SQL editor. Never
-- executed by tooling. Apply order: 0001 → 0002 → 0003 → 0004.

create table plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,              -- 'founder' | 'free' | 'starter' | 'pro'
  monthly_search_limit int,               -- null = unlimited
  monthly_audit_limit int,
  max_radius_miles int default 25,
  max_results_per_search int default 100,
  price_cents int default 0
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan_id uuid references plans(id),
  owner_user_id uuid references auth.users(id),
  places_api_key text,                    -- BYOK, null = platform key (v2)
  created_at timestamptz default now()
);

create table workspace_members (
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member',    -- owner | admin | member
  created_at timestamptz default now(),
  primary key (workspace_id, user_id)
);

-- Cascading agent variables, per workspace
create table workspace_config (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  your_offer text,
  target_industry text,
  ideal_website_traits text,
  sales_tone text default 'direct, friendly, peer-to-peer, no-BS',
  user_location text,
  user_brand text default 'RapidForgeAI',
  updated_at timestamptz default now()
);
