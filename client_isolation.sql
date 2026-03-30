alter table public.agents
add column if not exists client_id text;

create index if not exists agents_client_id_idx
on public.agents (client_id);
