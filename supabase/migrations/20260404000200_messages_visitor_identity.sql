-- Legacy source: db/messages_visitor_identity.sql

alter table public.messages
  add column if not exists session_key text;

create index if not exists messages_agent_id_session_key_created_at_idx
  on public.messages (agent_id, session_key, created_at desc);
