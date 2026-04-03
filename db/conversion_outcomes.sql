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
