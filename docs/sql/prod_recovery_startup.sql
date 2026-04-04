-- Vonza production startup recovery bundle for current main.
-- Audited against origin/main on 2026-04-04.
-- Source: exact supabase/migrations SQL, concatenated in the audited startup order.
--
-- Use this bundle when production is failing startup schema validation and you only need
-- the app to boot again.
--
-- Preconditions:
-- - This is for an existing production database, not a fresh bootstrap.
-- - Base schema from supabase/migrations/20260404000000_initial_schema_base.sql already exists.
-- - public.agents.owner_user_id already exists from supabase/migrations/20260404000100_owner_access.sql.
--   supabase/migrations/20260404000500_action_queue_statuses.sql reads that column. If you are unsure, run
--   docs/sql/prod_recovery_full_current_main.sql instead.
--
-- Safety notes:
-- - This file intentionally preserves the audited migration bodies and order.
-- - It is not wrapped in a transaction so Supabase surfaces the first failing statement.
-- - Unique indexes can still fail if legacy duplicate data already exists.

-- Source: supabase/migrations/20260404000200_messages_visitor_identity.sql
-- Legacy source: db/messages_visitor_identity.sql

alter table public.messages
  add column if not exists session_key text;

create index if not exists messages_agent_id_session_key_created_at_idx
  on public.messages (agent_id, session_key, created_at desc);
-- Source: supabase/migrations/20260404000300_install_verification_activation_loop.sql
-- Legacy source: db/install_verification_activation_loop.sql

alter table if exists public.widget_configs
  add column if not exists install_id uuid default gen_random_uuid(),
  add column if not exists allowed_domains text[] not null default '{}',
  add column if not exists last_verification_status text,
  add column if not exists last_verified_at timestamp with time zone,
  add column if not exists last_verification_origin text,
  add column if not exists last_verification_target_url text,
  add column if not exists last_verification_details jsonb;

update public.widget_configs
set install_id = gen_random_uuid()
where install_id is null;

update public.widget_configs wc
set allowed_domains = array[
  lower(
    regexp_replace(
      split_part(split_part(coalesce(b.website_url, ''), '://', 2), '/', 1),
      '^www\\.',
      ''
    )
  )
]
from public.agents a
join public.businesses b
  on b.id = a.business_id
where wc.agent_id = a.id
  and (wc.allowed_domains is null or cardinality(wc.allowed_domains) = 0)
  and coalesce(b.website_url, '') <> '';

create unique index if not exists widget_configs_install_id_idx
  on public.widget_configs (install_id);

alter table if exists public.agent_installations
  add column if not exists origin text,
  add column if not exists last_session_id text,
  add column if not exists last_fingerprint text;

create table if not exists public.agent_widget_events (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  install_id uuid,
  session_id text not null,
  fingerprint text,
  event_name text not null,
  origin text,
  page_url text,
  metadata jsonb,
  dedupe_key text not null,
  created_at timestamp with time zone default now()
);

create unique index if not exists agent_widget_events_dedupe_key_idx
  on public.agent_widget_events (dedupe_key);

create index if not exists agent_widget_events_agent_id_idx
  on public.agent_widget_events (agent_id);

create index if not exists agent_widget_events_event_name_idx
  on public.agent_widget_events (event_name);

create index if not exists agent_widget_events_created_at_idx
  on public.agent_widget_events (created_at desc);
-- Source: supabase/migrations/20260404000400_live_conversion_loop.sql
-- Legacy source: db/live_conversion_loop.sql

create table if not exists public.agent_contact_leads (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  install_id uuid,
  lead_key text not null,
  person_key text,
  visitor_session_key text,
  capture_state text not null default 'none',
  preferred_channel text,
  contact_name text,
  contact_email text,
  contact_phone text,
  contact_phone_normalized text,
  source_page_url text,
  source_origin text,
  latest_intent_type text,
  latest_action_type text,
  latest_action_key text,
  latest_message_id text,
  related_action_keys text[] not null default '{}',
  prompt_count integer not null default 0,
  prompted_at timestamp with time zone,
  captured_at timestamp with time zone,
  declined_at timestamp with time zone,
  blocked_at timestamp with time zone,
  first_seen_at timestamp with time zone default now(),
  last_seen_at timestamp with time zone default now(),
  capture_trigger text,
  capture_reason text,
  capture_prompt text,
  capture_source text not null default 'widget_live_chat',
  capture_metadata jsonb not null default '{}'::jsonb,
  related_follow_up_id uuid,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists agent_contact_leads_agent_owner_lead_key_idx
  on public.agent_contact_leads (agent_id, owner_user_id, lead_key);

create unique index if not exists agent_contact_leads_agent_owner_session_idx
  on public.agent_contact_leads (agent_id, owner_user_id, visitor_session_key)
  where visitor_session_key is not null;

create unique index if not exists agent_contact_leads_agent_owner_email_idx
  on public.agent_contact_leads (agent_id, owner_user_id, contact_email)
  where contact_email is not null;

create unique index if not exists agent_contact_leads_agent_owner_phone_idx
  on public.agent_contact_leads (agent_id, owner_user_id, contact_phone_normalized)
  where contact_phone_normalized is not null;

create index if not exists agent_contact_leads_agent_owner_updated_idx
  on public.agent_contact_leads (agent_id, owner_user_id, updated_at desc);

create index if not exists agent_contact_leads_agent_person_idx
  on public.agent_contact_leads (agent_id, person_key);
-- Source: supabase/migrations/20260404000500_action_queue_statuses.sql
-- Legacy source: db/action_queue_statuses.sql

create table if not exists public.agent_action_queue_statuses (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  owner_user_id uuid,
  action_key text not null,
  status text default 'new',
  note text,
  outcome text,
  next_step text,
  follow_up_needed boolean,
  follow_up_completed boolean,
  contact_status text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

alter table public.agent_action_queue_statuses
  add column if not exists note text;

alter table public.agent_action_queue_statuses
  add column if not exists outcome text;

alter table public.agent_action_queue_statuses
  add column if not exists next_step text;

alter table public.agent_action_queue_statuses
  add column if not exists follow_up_needed boolean;

alter table public.agent_action_queue_statuses
  add column if not exists follow_up_completed boolean;

alter table public.agent_action_queue_statuses
  add column if not exists contact_status text;

create unique index if not exists agent_action_queue_statuses_agent_action_key_idx
  on public.agent_action_queue_statuses (agent_id, action_key);

create index if not exists agent_action_queue_statuses_owner_user_id_idx
  on public.agent_action_queue_statuses (owner_user_id);

create index if not exists agent_action_queue_statuses_status_idx
  on public.agent_action_queue_statuses (status);
-- Source: supabase/migrations/20260404000600_agent_follow_up_workflows.sql
-- Legacy source: db/agent_follow_up_workflows.sql

create table if not exists public.agent_follow_up_workflows (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  owner_user_id uuid,
  dedupe_key text not null,
  source_action_key text not null,
  linked_action_keys text[] not null default '{}',
  action_type text not null,
  person_key text,
  status text not null default 'draft',
  channel text,
  contact_name text,
  contact_email text,
  contact_phone text,
  subject text,
  draft_content text,
  last_generated_subject text,
  last_generated_content text,
  draft_edited_manually boolean not null default false,
  evidence text,
  why_prepared text,
  topic text,
  page_hint text,
  source_hash text,
  last_error text,
  sent_at timestamp with time zone,
  dismissed_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

alter table public.agent_follow_up_workflows
  add column if not exists linked_action_keys text[] not null default '{}';

alter table public.agent_follow_up_workflows
  add column if not exists action_type text;

alter table public.agent_follow_up_workflows
  add column if not exists person_key text;

alter table public.agent_follow_up_workflows
  add column if not exists status text default 'draft';

alter table public.agent_follow_up_workflows
  add column if not exists channel text;

alter table public.agent_follow_up_workflows
  add column if not exists contact_name text;

alter table public.agent_follow_up_workflows
  add column if not exists contact_email text;

alter table public.agent_follow_up_workflows
  add column if not exists contact_phone text;

alter table public.agent_follow_up_workflows
  add column if not exists subject text;

alter table public.agent_follow_up_workflows
  add column if not exists draft_content text;

alter table public.agent_follow_up_workflows
  add column if not exists last_generated_subject text;

alter table public.agent_follow_up_workflows
  add column if not exists last_generated_content text;

alter table public.agent_follow_up_workflows
  add column if not exists draft_edited_manually boolean not null default false;

alter table public.agent_follow_up_workflows
  add column if not exists evidence text;

alter table public.agent_follow_up_workflows
  add column if not exists why_prepared text;

alter table public.agent_follow_up_workflows
  add column if not exists topic text;

alter table public.agent_follow_up_workflows
  add column if not exists page_hint text;

alter table public.agent_follow_up_workflows
  add column if not exists source_hash text;

alter table public.agent_follow_up_workflows
  add column if not exists last_error text;

alter table public.agent_follow_up_workflows
  add column if not exists sent_at timestamp with time zone;

alter table public.agent_follow_up_workflows
  add column if not exists dismissed_at timestamp with time zone;

create unique index if not exists agent_follow_up_workflows_agent_dedupe_idx
  on public.agent_follow_up_workflows (agent_id, owner_user_id, dedupe_key);

create index if not exists agent_follow_up_workflows_agent_owner_idx
  on public.agent_follow_up_workflows (agent_id, owner_user_id);

create index if not exists agent_follow_up_workflows_status_idx
  on public.agent_follow_up_workflows (status);
-- Source: supabase/migrations/20260404000700_agent_knowledge_fix_workflows.sql
-- Legacy source: db/agent_knowledge_fix_workflows.sql

create table if not exists public.agent_knowledge_fix_workflows (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  owner_user_id uuid,
  dedupe_key text not null,
  source_action_key text not null,
  linked_action_keys text[] not null default '{}',
  action_type text not null,
  status text not null default 'draft',
  target_type text not null default 'system_prompt',
  target_label text,
  topic text,
  issue_key text,
  issue_summary text,
  matters_summary text,
  proposed_guidance text,
  last_generated_guidance text,
  draft_edited_manually boolean not null default false,
  evidence jsonb,
  occurrence_count integer not null default 1,
  source_hash text,
  applied_guidance text,
  applied_at timestamp with time zone,
  dismissed_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

alter table public.agent_knowledge_fix_workflows
  add column if not exists linked_action_keys text[] not null default '{}';

alter table public.agent_knowledge_fix_workflows
  add column if not exists action_type text;

alter table public.agent_knowledge_fix_workflows
  add column if not exists status text default 'draft';

alter table public.agent_knowledge_fix_workflows
  add column if not exists target_type text default 'system_prompt';

alter table public.agent_knowledge_fix_workflows
  add column if not exists target_label text;

alter table public.agent_knowledge_fix_workflows
  add column if not exists topic text;

alter table public.agent_knowledge_fix_workflows
  add column if not exists issue_key text;

alter table public.agent_knowledge_fix_workflows
  add column if not exists issue_summary text;

alter table public.agent_knowledge_fix_workflows
  add column if not exists matters_summary text;

alter table public.agent_knowledge_fix_workflows
  add column if not exists proposed_guidance text;

alter table public.agent_knowledge_fix_workflows
  add column if not exists last_generated_guidance text;

alter table public.agent_knowledge_fix_workflows
  add column if not exists draft_edited_manually boolean not null default false;

alter table public.agent_knowledge_fix_workflows
  add column if not exists evidence jsonb;

alter table public.agent_knowledge_fix_workflows
  add column if not exists occurrence_count integer not null default 1;

alter table public.agent_knowledge_fix_workflows
  add column if not exists source_hash text;

alter table public.agent_knowledge_fix_workflows
  add column if not exists applied_guidance text;

alter table public.agent_knowledge_fix_workflows
  add column if not exists applied_at timestamp with time zone;

alter table public.agent_knowledge_fix_workflows
  add column if not exists dismissed_at timestamp with time zone;

alter table public.agent_knowledge_fix_workflows
  add column if not exists last_error text;

create unique index if not exists agent_knowledge_fix_workflows_agent_dedupe_idx
  on public.agent_knowledge_fix_workflows (agent_id, owner_user_id, dedupe_key);

create index if not exists agent_knowledge_fix_workflows_agent_owner_idx
  on public.agent_knowledge_fix_workflows (agent_id, owner_user_id);

create index if not exists agent_knowledge_fix_workflows_status_idx
  on public.agent_knowledge_fix_workflows (status);
-- Source: supabase/migrations/20260404000800_conversion_outcomes.sql
-- Legacy source: db/conversion_outcomes.sql

alter table public.widget_configs
  add column if not exists booking_start_url text;

alter table public.widget_configs
  add column if not exists quote_start_url text;

alter table public.widget_configs
  add column if not exists booking_success_url text;

alter table public.widget_configs
  add column if not exists quote_success_url text;

alter table public.widget_configs
  add column if not exists checkout_success_url text;

alter table public.widget_configs
  add column if not exists success_url_match_mode text;

alter table public.widget_configs
  add column if not exists manual_outcome_mode boolean not null default false;

create table if not exists public.agent_conversion_outcomes (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  install_id uuid,
  outcome_type text not null,
  source_type text not null,
  confirmation_level text not null default 'observed',
  dedupe_key text not null,
  cta_event_id uuid,
  related_cta_type text,
  related_target_type text,
  related_action_type text,
  related_intent_type text,
  visitor_id text,
  session_id text,
  fingerprint text,
  conversation_id text,
  person_key text,
  lead_id uuid,
  contact_id uuid,
  action_key text,
  follow_up_id uuid,
  inbox_thread_id uuid,
  calendar_event_id uuid,
  campaign_id uuid,
  campaign_recipient_id uuid,
  operator_task_id uuid,
  page_url text,
  origin text,
  target_url text,
  success_url text,
  attribution_path text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamp with time zone default now(),
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists agent_conversion_outcomes_dedupe_key_idx
  on public.agent_conversion_outcomes (dedupe_key);

create index if not exists agent_conversion_outcomes_agent_owner_idx
  on public.agent_conversion_outcomes (agent_id, owner_user_id);

create index if not exists agent_conversion_outcomes_cta_event_idx
  on public.agent_conversion_outcomes (cta_event_id);

create index if not exists agent_conversion_outcomes_lead_idx
  on public.agent_conversion_outcomes (lead_id);

create index if not exists agent_conversion_outcomes_type_idx
  on public.agent_conversion_outcomes (outcome_type);

create index if not exists agent_conversion_outcomes_occurred_at_idx
  on public.agent_conversion_outcomes (occurred_at desc);

create index if not exists agent_conversion_outcomes_contact_idx
  on public.agent_conversion_outcomes (contact_id);

create index if not exists agent_conversion_outcomes_inbox_thread_idx
  on public.agent_conversion_outcomes (inbox_thread_id);

create index if not exists agent_conversion_outcomes_calendar_event_idx
  on public.agent_conversion_outcomes (calendar_event_id);

create index if not exists agent_conversion_outcomes_campaign_idx
  on public.agent_conversion_outcomes (campaign_id);

create index if not exists agent_conversion_outcomes_campaign_recipient_idx
  on public.agent_conversion_outcomes (campaign_recipient_id);

create index if not exists agent_conversion_outcomes_operator_task_idx
  on public.agent_conversion_outcomes (operator_task_id);

create index if not exists agent_conversion_outcomes_attribution_path_idx
  on public.agent_conversion_outcomes (attribution_path);
