-- RapidForge migration 0002 — Domain (PRD 5.2)
-- WRITE-ONLY: Joey pastes this into the Supabase web SQL editor.
-- Requires 0001_tenancy.sql.

create table searches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade not null,
  created_by uuid references auth.users(id) not null,
  mode text not null,                     -- 'zip_radius' | 'map_draw' | 'keyword'
  params jsonb not null,
  category text not null,
  status text default 'pending',
  results_count int default 0,
  created_at timestamptz default now(),
  completed_at timestamptz
);

create table businesses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade not null,
  google_place_id text not null,
  name text not null,
  phone text, website_url text, address text,
  lat numeric, lng numeric,
  google_rating numeric, review_count int,
  category text, business_status text,
  is_chain boolean default false,
  website_kind text default 'unknown',    -- 'real' | 'social_only' | 'none' | 'unknown'
  first_seen_at timestamptz default now(),
  last_refreshed_at timestamptz default now(),
  unique(workspace_id, google_place_id)   -- upsert on conflict
);

create table search_results (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade not null,
  search_id uuid references searches(id) on delete cascade not null,
  business_id uuid references businesses(id) not null,
  latest_audit_id uuid,
  status text default 'new',              -- new | called | interested | sold | dead
  notes text, last_contacted_at timestamptz, next_followup_at timestamptz,
  created_at timestamptz default now(),
  unique(search_id, business_id)
);

create table audits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade not null,
  business_id uuid references businesses(id) on delete cascade not null,
  website_url text,
  ps_performance int, ps_mobile_performance int,
  ps_accessibility int, ps_seo int, ps_best_practices int,
  ps_lcp_ms int, ps_cls numeric,
  http_status int, ssl_valid boolean, response_ms int,
  platform text, copyright_year int,
  has_phone boolean, has_form boolean,
  has_booking boolean, has_chat boolean,
  has_viewport_meta boolean, has_schema_markup boolean,
  gbp_photo_count int, gbp_review_velocity numeric,
  has_crux_data boolean,
  screenshot_desktop_url text, screenshot_mobile_url text,
  website_health_score int, star_grade numeric, sellability_score int,
  score_breakdown jsonb, issues jsonb,
  analyst_output jsonb,                   -- Fable 5 narrative (v1.5)
  builder_brief_md text,                  -- Fable 5 brief (v1.5)
  sales_summary jsonb,                    -- talk track (v1.5)
  status text default 'pending',
  error_message text,
  created_at timestamptz default now(),
  completed_at timestamptz
);
