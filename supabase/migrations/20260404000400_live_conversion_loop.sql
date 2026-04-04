-- Legacy source: db/live_conversion_loop.sql

create table if not exists public.agent_contact_leads (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  install_id uuid,
  lead_key text not null,
  person_key text,
  visitor_session_key text,
  capture_state text not null default 'none',
  preferred_channel text,
  contact_name text,
  contact_email text,
  contact_phone text,
  contact_phone_normalized text,
  source_page_url text,
  source_origin text,
  latest_intent_type text,
  latest_action_type text,
  latest_action_key text,
  latest_message_id text,
  related_action_keys text[] not null default '{}',
  prompt_count integer not null default 0,
  prompted_at timestamp with time zone,
  captured_at timestamp with time zone,
  declined_at timestamp with time zone,
  blocked_at timestamp with time zone,
  first_seen_at timestamp with time zone default now(),
  last_seen_at timestamp with time zone default now(),
  capture_trigger text,
  capture_reason text,
  capture_prompt text,
  capture_source text not null default 'widget_live_chat',
  capture_metadata jsonb not null default '{}'::jsonb,
  related_follow_up_id uuid,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists agent_contact_leads_agent_owner_lead_key_idx
  on public.agent_contact_leads (agent_id, owner_user_id, lead_key);

create unique index if not exists agent_contact_leads_agent_owner_session_idx
  on public.agent_contact_leads (agent_id, owner_user_id, visitor_session_key)
  where visitor_session_key is not null;

create unique index if not exists agent_contact_leads_agent_owner_email_idx
  on public.agent_contact_leads (agent_id, owner_user_id, contact_email)
  where contact_email is not null;

create unique index if not exists agent_contact_leads_agent_owner_phone_idx
  on public.agent_contact_leads (agent_id, owner_user_id, contact_phone_normalized)
  where contact_phone_normalized is not null;

create index if not exists agent_contact_leads_agent_owner_updated_idx
  on public.agent_contact_leads (agent_id, owner_user_id, updated_at desc);

create index if not exists agent_contact_leads_agent_person_idx
  on public.agent_contact_leads (agent_id, person_key);
