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
