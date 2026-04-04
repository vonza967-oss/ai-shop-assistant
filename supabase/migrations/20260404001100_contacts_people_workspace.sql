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
