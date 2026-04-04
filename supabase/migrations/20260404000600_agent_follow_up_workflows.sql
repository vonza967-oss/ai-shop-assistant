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
