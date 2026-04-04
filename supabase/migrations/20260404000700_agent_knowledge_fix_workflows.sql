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
