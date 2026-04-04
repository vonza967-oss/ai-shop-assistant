-- Vonza production full recovery / current-main parity bundle.
-- Audited against origin/main on 2026-04-04.
-- Source: exact supabase/migrations SQL, concatenated in the audited order.
--
-- Use this bundle when:
-- - production drift is unknown
-- - you need to bootstrap or reconcile migration history on an existing project
-- - you want full current-main schema parity, not only a startup fix
--
-- Ordering dependencies preserved here:
-- - 20260404000100_owner_access before 20260404000500_action_queue_statuses
-- - 20260404000400_live_conversion_loop and 20260404000600_agent_follow_up_workflows before 20260404001000_connected_operator_workspace
-- - 20260404001000_connected_operator_workspace and 20260404000800_conversion_outcomes before 20260404001100_contacts_people_workspace
-- - 20260404000800_conversion_outcomes before 20260404001200_cross_channel_outcomes
--
-- Safety notes:
-- - This file intentionally preserves the audited migration bodies and order.
-- - It is not wrapped in a transaction so Supabase surfaces the first failing statement.
-- - Unique indexes can still fail if legacy duplicate data already exists.
-- - The first section is the foundational bootstrap baseline for pre-CLI projects.

-- Source: supabase/migrations/20260404000000_initial_schema_base.sql
-- Bootstrap baseline for Vonza projects that existed before Supabase CLI migrations.
-- Legacy source: db/schema.sql (foundational tables only)

create extension if not exists pgcrypto;

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text,
  website_url text unique,
  created_at timestamp with time zone default now()
);

create table if not exists public.website_content (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses (id) on delete cascade,
  website_url text,
  page_title text,
  meta_description text,
  content text,
  crawled_urls text[],
  page_count integer,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists website_content_business_id_idx
  on public.website_content (business_id);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses (id) on delete cascade,
  client_id text,
  public_agent_key text unique,
  name text,
  purpose text,
  system_prompt text,
  tone text,
  language text,
  is_active boolean default true,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists agents_business_id_idx
  on public.agents (business_id);

create index if not exists agents_client_id_idx
  on public.agents (client_id);

create table if not exists public.widget_configs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  assistant_name text,
  welcome_message text,
  button_label text,
  primary_color text,
  secondary_color text,
  launcher_text text,
  theme_mode text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists widget_configs_agent_id_idx
  on public.widget_configs (agent_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamp with time zone default now()
);

create index if not exists messages_agent_id_idx
  on public.messages (agent_id);

create index if not exists messages_agent_id_created_at_idx
  on public.messages (agent_id, created_at desc);

create table if not exists public.product_events (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  agent_id uuid references public.agents (id) on delete set null,
  event_name text not null,
  source text,
  metadata jsonb,
  created_at timestamp with time zone default now()
);

create index if not exists product_events_client_id_idx
  on public.product_events (client_id);

create index if not exists product_events_event_name_idx
  on public.product_events (event_name);

create index if not exists product_events_created_at_idx
  on public.product_events (created_at desc);

create table if not exists public.agent_installations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  host text not null,
  page_url text,
  first_seen_at timestamp with time zone default now(),
  last_seen_at timestamp with time zone default now()
);

create unique index if not exists agent_installations_agent_host_idx
  on public.agent_installations (agent_id, host);

create index if not exists agent_installations_agent_id_idx
  on public.agent_installations (agent_id);

create index if not exists agent_installations_last_seen_at_idx
  on public.agent_installations (last_seen_at desc);
-- Source: supabase/migrations/20260404000100_owner_access.sql
-- Legacy source: db/owner_access.sql

alter table public.agents
  add column if not exists owner_user_id uuid;

alter table public.agents
  add column if not exists access_status text default 'pending';

update public.agents
set access_status = 'pending'
where access_status is null;

create index if not exists agents_owner_user_id_idx
  on public.agents (owner_user_id);
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
-- Source: supabase/migrations/20260404000900_direct_conversion_routing.sql
-- Legacy source: db/direct_conversion_routing.sql

alter table if exists public.widget_configs
  add column if not exists booking_url text;

alter table if exists public.widget_configs
  add column if not exists quote_url text;

alter table if exists public.widget_configs
  add column if not exists checkout_url text;

alter table if exists public.widget_configs
  add column if not exists contact_email text;

alter table if exists public.widget_configs
  add column if not exists contact_phone text;

alter table if exists public.widget_configs
  add column if not exists primary_cta_mode text;

alter table if exists public.widget_configs
  add column if not exists fallback_cta_mode text;

alter table if exists public.widget_configs
  add column if not exists business_hours_note text;
-- Source: supabase/migrations/20260404001000_connected_operator_workspace.sql
-- Legacy source: db/connected_operator_workspace.sql

create table if not exists public.google_oauth_states (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  provider text not null default 'google',
  requested_scopes text[] not null default '{}',
  redirect_path text,
  selected_mailbox text,
  state_token_hash text not null unique,
  status text not null default 'pending',
  expires_at timestamp with time zone not null,
  completed_at timestamp with time zone,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists google_oauth_states_agent_owner_idx
  on public.google_oauth_states (agent_id, owner_user_id);

create index if not exists google_oauth_states_status_idx
  on public.google_oauth_states (status);

create table if not exists public.google_connected_accounts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  provider text not null default 'google',
  provider_account_id text,
  account_email text,
  display_name text,
  selected_mailbox text default 'INBOX',
  scopes text[] not null default '{}',
  scope_audit jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamp with time zone,
  last_refreshed_at timestamp with time zone,
  last_sync_at timestamp with time zone,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists google_connected_accounts_provider_account_idx
  on public.google_connected_accounts (agent_id, owner_user_id, provider, provider_account_id);

create unique index if not exists google_connected_accounts_email_idx
  on public.google_connected_accounts (agent_id, owner_user_id, provider, account_email)
  where account_email is not null;

create index if not exists google_connected_accounts_agent_owner_idx
  on public.google_connected_accounts (agent_id, owner_user_id);

create index if not exists google_connected_accounts_status_idx
  on public.google_connected_accounts (status);

create unique index if not exists google_connected_accounts_agent_provider_idx
  on public.google_connected_accounts (agent_id, owner_user_id, provider);

create table if not exists public.operator_inbox_threads (
  id uuid primary key default gen_random_uuid(),
  connected_account_id uuid references public.google_connected_accounts (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  provider_thread_id text not null,
  provider_history_id text,
  mailbox_label text,
  subject text,
  snippet text,
  classification text not null default 'follow_up_needed',
  priority text not null default 'normal',
  status text not null default 'open',
  complaint_state text not null default 'none',
  follow_up_state text not null default 'open',
  needs_reply boolean not null default false,
  risk_level text not null default 'normal',
  unread_count integer not null default 0,
  participants jsonb not null default '[]'::jsonb,
  related_lead_id uuid references public.agent_contact_leads (id) on delete set null,
  related_follow_up_id uuid references public.agent_follow_up_workflows (id) on delete set null,
  related_action_key text,
  last_message_at timestamp with time zone,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_inbox_threads_provider_thread_idx
  on public.operator_inbox_threads (connected_account_id, provider_thread_id);

create index if not exists operator_inbox_threads_agent_owner_idx
  on public.operator_inbox_threads (agent_id, owner_user_id, updated_at desc);

create index if not exists operator_inbox_threads_classification_idx
  on public.operator_inbox_threads (classification, status);

create table if not exists public.operator_inbox_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references public.operator_inbox_threads (id) on delete cascade,
  connected_account_id uuid references public.google_connected_accounts (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  provider_message_id text not null,
  direction text not null default 'inbound',
  approval_status text not null default 'not_required',
  message_state text not null default 'stored',
  sender text,
  recipients text[] not null default '{}',
  cc text[] not null default '{}',
  subject text,
  body_preview text,
  body_text text,
  sent_at timestamp with time zone,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_inbox_messages_provider_message_idx
  on public.operator_inbox_messages (connected_account_id, provider_message_id);

create index if not exists operator_inbox_messages_thread_idx
  on public.operator_inbox_messages (thread_id, created_at desc);

create table if not exists public.operator_calendar_events (
  id uuid primary key default gen_random_uuid(),
  connected_account_id uuid references public.google_connected_accounts (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  provider_event_id text,
  action_type text not null default 'view',
  source_kind text not null default 'google_sync',
  status text not null default 'confirmed',
  approval_status text not null default 'synced',
  title text,
  description text,
  attendee_emails text[] not null default '{}',
  start_at timestamp with time zone,
  end_at timestamp with time zone,
  timezone text,
  location text,
  lead_id uuid references public.agent_contact_leads (id) on delete set null,
  related_action_key text,
  conflict_state text not null default 'clear',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_calendar_events_provider_event_idx
  on public.operator_calendar_events (connected_account_id, provider_event_id)
  where provider_event_id is not null;

create index if not exists operator_calendar_events_agent_owner_idx
  on public.operator_calendar_events (agent_id, owner_user_id, start_at asc);

create index if not exists operator_calendar_events_approval_idx
  on public.operator_calendar_events (approval_status, status);

create table if not exists public.operator_campaigns (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  goal text not null,
  title text not null,
  status text not null default 'draft',
  approval_status text not null default 'draft',
  recipient_source text not null default 'captured_leads',
  source_filters jsonb not null default '{}'::jsonb,
  schedule_config jsonb not null default '{}'::jsonb,
  sequence_summary text,
  reply_handling_mode text not null default 'manual_review',
  approved_at timestamp with time zone,
  activated_at timestamp with time zone,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists operator_campaigns_agent_owner_idx
  on public.operator_campaigns (agent_id, owner_user_id, created_at desc);

create index if not exists operator_campaigns_status_idx
  on public.operator_campaigns (status, approval_status);

create table if not exists public.operator_campaign_steps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.operator_campaigns (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  step_order integer not null,
  channel text not null default 'email',
  timing_offset_hours integer not null default 0,
  subject text,
  body text,
  approval_status text not null default 'pending_owner',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_campaign_steps_campaign_order_idx
  on public.operator_campaign_steps (campaign_id, step_order);

create table if not exists public.operator_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.operator_campaigns (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  lead_id uuid references public.agent_contact_leads (id) on delete set null,
  person_key text,
  contact_name text,
  contact_email text,
  status text not null default 'pending',
  current_step_index integer not null default 0,
  next_send_at timestamp with time zone,
  last_contacted_at timestamp with time zone,
  reply_state text not null default 'awaiting_reply',
  last_thread_id uuid references public.operator_inbox_threads (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_campaign_recipients_campaign_email_idx
  on public.operator_campaign_recipients (campaign_id, contact_email)
  where contact_email is not null;

create index if not exists operator_campaign_recipients_campaign_status_idx
  on public.operator_campaign_recipients (campaign_id, status, next_send_at);

create table if not exists public.operator_tasks (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  source_type text not null,
  source_id text not null,
  task_type text not null,
  title text not null,
  description text,
  status text not null default 'open',
  priority text not null default 'normal',
  approval_required boolean not null default false,
  related_thread_id uuid references public.operator_inbox_threads (id) on delete set null,
  related_event_id uuid references public.operator_calendar_events (id) on delete set null,
  related_campaign_id uuid references public.operator_campaigns (id) on delete set null,
  related_lead_id uuid references public.agent_contact_leads (id) on delete set null,
  related_action_key text,
  task_state jsonb not null default '{}'::jsonb,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_tasks_source_dedupe_idx
  on public.operator_tasks (agent_id, owner_user_id, source_type, source_id, task_type);

create index if not exists operator_tasks_status_idx
  on public.operator_tasks (status, priority, created_at desc);

create table if not exists public.operator_workspace_activations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  operator_workspace_enabled boolean not null default true,
  google_connected boolean not null default false,
  inbox_context_selected boolean not null default false,
  calendar_context_selected boolean not null default false,
  inbox_synced boolean not null default false,
  calendar_synced boolean not null default false,
  first_inbox_review_completed boolean not null default false,
  first_reply_draft_created boolean not null default false,
  first_campaign_draft_created boolean not null default false,
  first_calendar_action_reviewed boolean not null default false,
  activation_completed_at timestamp with time zone,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_workspace_activations_agent_owner_idx
  on public.operator_workspace_activations (agent_id, owner_user_id);

create table if not exists public.operator_audit_logs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  connected_account_id uuid references public.google_connected_accounts (id) on delete set null,
  actor_type text not null,
  actor_id text,
  action_type text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now()
);

create index if not exists operator_audit_logs_agent_owner_idx
  on public.operator_audit_logs (agent_id, owner_user_id, created_at desc);
-- Source: supabase/migrations/20260404001100_contacts_people_workspace.sql
-- Legacy source: db/contacts_people_workspace.sql

create table if not exists public.operator_contacts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  display_name text,
  primary_email text,
  primary_phone text,
  primary_phone_normalized text,
  primary_person_key text,
  lifecycle_state text not null default 'new',
  lifecycle_state_source text not null default 'system',
  suggested_lifecycle_state text not null default 'new',
  activity_sources text[] not null default '{}',
  high_priority_flags text[] not null default '{}',
  last_activity_at timestamp with time zone,
  next_action_type text not null default 'no_action_needed',
  next_action_title text,
  next_action_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists operator_contacts_agent_owner_idx
  on public.operator_contacts (agent_id, owner_user_id, last_activity_at desc);

create index if not exists operator_contacts_lifecycle_idx
  on public.operator_contacts (agent_id, owner_user_id, lifecycle_state, last_activity_at desc);

create index if not exists operator_contacts_primary_email_idx
  on public.operator_contacts (agent_id, owner_user_id, primary_email)
  where primary_email is not null;

create index if not exists operator_contacts_primary_phone_idx
  on public.operator_contacts (agent_id, owner_user_id, primary_phone_normalized)
  where primary_phone_normalized is not null;

create table if not exists public.operator_contact_identities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.operator_contacts (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  identity_type text not null,
  identity_value text not null,
  is_primary boolean not null default false,
  source_type text not null default 'contact_sync',
  first_seen_at timestamp with time zone default now(),
  last_seen_at timestamp with time zone default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_contact_identities_unique_idx
  on public.operator_contact_identities (agent_id, owner_user_id, identity_type, identity_value);

create index if not exists operator_contact_identities_contact_idx
  on public.operator_contact_identities (contact_id, identity_type, last_seen_at desc);

alter table public.agent_contact_leads
  add column if not exists contact_id uuid references public.operator_contacts (id) on delete set null;

create index if not exists agent_contact_leads_contact_idx
  on public.agent_contact_leads (contact_id);

alter table public.agent_follow_up_workflows
  add column if not exists contact_id uuid references public.operator_contacts (id) on delete set null;

create index if not exists agent_follow_up_workflows_contact_idx
  on public.agent_follow_up_workflows (contact_id);

alter table public.agent_conversion_outcomes
  add column if not exists contact_id uuid references public.operator_contacts (id) on delete set null;

create index if not exists agent_conversion_outcomes_contact_idx
  on public.agent_conversion_outcomes (contact_id);

alter table public.operator_inbox_threads
  add column if not exists contact_id uuid references public.operator_contacts (id) on delete set null;

create index if not exists operator_inbox_threads_contact_idx
  on public.operator_inbox_threads (contact_id);

alter table public.operator_calendar_events
  add column if not exists contact_id uuid references public.operator_contacts (id) on delete set null;

create index if not exists operator_calendar_events_contact_idx
  on public.operator_calendar_events (contact_id);

alter table public.operator_campaign_recipients
  add column if not exists contact_id uuid references public.operator_contacts (id) on delete set null;

create index if not exists operator_campaign_recipients_contact_idx
  on public.operator_campaign_recipients (contact_id);

alter table public.operator_tasks
  add column if not exists contact_id uuid references public.operator_contacts (id) on delete set null;

create index if not exists operator_tasks_contact_idx
  on public.operator_tasks (contact_id);
-- Source: supabase/migrations/20260404001200_cross_channel_outcomes.sql
-- Legacy source: db/cross_channel_outcomes.sql

alter table public.agent_conversion_outcomes
  add column if not exists inbox_thread_id uuid,
  add column if not exists calendar_event_id uuid,
  add column if not exists campaign_id uuid,
  add column if not exists campaign_recipient_id uuid,
  add column if not exists operator_task_id uuid,
  add column if not exists attribution_path text;

update public.agent_conversion_outcomes
set attribution_path = nullif(metadata->>'attributionPath', '')
where attribution_path is null
  and metadata ? 'attributionPath';

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
-- Source: supabase/migrations/20260404001300_operator_business_profiles.sql
-- Legacy source: db/operator_business_profiles.sql

create table if not exists public.operator_business_profiles (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  business_summary text,
  services jsonb not null default '[]'::jsonb,
  pricing jsonb not null default '[]'::jsonb,
  policies jsonb not null default '[]'::jsonb,
  service_areas jsonb not null default '[]'::jsonb,
  operating_hours jsonb not null default '[]'::jsonb,
  approved_contact_channels text[] not null default '{}',
  approval_preferences jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_business_profiles_agent_owner_idx
  on public.operator_business_profiles (agent_id, owner_user_id);

create index if not exists operator_business_profiles_business_idx
  on public.operator_business_profiles (business_id, updated_at desc);
