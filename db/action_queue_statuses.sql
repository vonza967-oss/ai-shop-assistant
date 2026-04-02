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

update public.agent_action_queue_statuses as statuses
set owner_user_id = agents.owner_user_id
from public.agents
where statuses.agent_id = agents.id
  and statuses.owner_user_id is null
  and agents.owner_user_id is not null;

update public.agent_action_queue_statuses
set status = lower(trim(status))
where status is not null
  and status <> lower(trim(status));

update public.agent_action_queue_statuses
set status = 'new'
where status is null
  or status not in ('new', 'reviewed', 'done', 'dismissed');

update public.agent_action_queue_statuses
set contact_status = null
where contact_status is not null
  and lower(trim(contact_status)) = '';

update public.agent_action_queue_statuses
set contact_status = lower(trim(contact_status))
where contact_status is not null
  and contact_status <> lower(trim(contact_status));

update public.agent_action_queue_statuses
set contact_status = null
where contact_status is not null
  and contact_status not in ('not_contacted', 'attempted', 'contacted', 'qualified');

create unique index if not exists agent_action_queue_statuses_agent_action_key_idx
  on public.agent_action_queue_statuses (agent_id, action_key);

create index if not exists agent_action_queue_statuses_owner_user_id_idx
  on public.agent_action_queue_statuses (owner_user_id);

create index if not exists agent_action_queue_statuses_status_idx
  on public.agent_action_queue_statuses (status);

create index if not exists agent_action_queue_statuses_agent_owner_updated_idx
  on public.agent_action_queue_statuses (agent_id, owner_user_id, updated_at desc);

create index if not exists agent_action_queue_statuses_agent_owner_status_updated_idx
  on public.agent_action_queue_statuses (agent_id, owner_user_id, status, updated_at desc);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agent_action_queue_statuses_status_check'
  ) then
    alter table public.agent_action_queue_statuses
      add constraint agent_action_queue_statuses_status_check
      check (status in ('new', 'reviewed', 'done', 'dismissed')) not valid;
  end if;
end
$$;

alter table public.agent_action_queue_statuses
  validate constraint agent_action_queue_statuses_status_check;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agent_action_queue_statuses_contact_status_check'
  ) then
    alter table public.agent_action_queue_statuses
      add constraint agent_action_queue_statuses_contact_status_check
      check (
        contact_status is null
        or contact_status in ('not_contacted', 'attempted', 'contacted', 'qualified')
      ) not valid;
  end if;
end
$$;

alter table public.agent_action_queue_statuses
  validate constraint agent_action_queue_statuses_contact_status_check;
