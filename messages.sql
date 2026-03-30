create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null,
  role text not null,
  content text not null,
  created_at timestamp with time zone default now()
);
