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
