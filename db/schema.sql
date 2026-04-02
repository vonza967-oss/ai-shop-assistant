create extension if not exists pgcrypto;

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text,
  website_url text unique,
  created_at timestamp with time zone default now()
);

create table if not exists public.website_content (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses (id) on delete cascade,
  website_url text,
  page_title text,
  meta_description text,
  content text,
  crawled_urls text[],
  page_count integer,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists website_content_business_id_idx
  on public.website_content (business_id);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses (id) on delete cascade,
  client_id text,
  owner_user_id uuid,
  access_status text default 'pending',
  public_agent_key text unique,
  name text,
  purpose text,
  system_prompt text,
  tone text,
  language text,
  is_active boolean default true,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists agents_business_id_idx
  on public.agents (business_id);

create index if not exists agents_client_id_idx
  on public.agents (client_id);

create index if not exists agents_owner_user_id_idx
  on public.agents (owner_user_id);

create table if not exists public.widget_configs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  assistant_name text,
  welcome_message text,
  button_label text,
  primary_color text,
  secondary_color text,
  launcher_text text,
  theme_mode text,
  install_id uuid default gen_random_uuid(),
  allowed_domains text[] not null default '{}',
  last_verification_status text,
  last_verified_at timestamp with time zone,
  last_verification_origin text,
  last_verification_target_url text,
  last_verification_details jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists widget_configs_agent_id_idx
  on public.widget_configs (agent_id);

create unique index if not exists widget_configs_install_id_idx
  on public.widget_configs (install_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  role text not null,
  content text not null,
  session_key text,
  created_at timestamp with time zone default now()
);

create index if not exists messages_agent_id_idx
  on public.messages (agent_id);

create index if not exists messages_agent_id_created_at_idx
  on public.messages (agent_id, created_at desc);

create index if not exists messages_agent_id_session_key_created_at_idx
  on public.messages (agent_id, session_key, created_at desc);

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

create unique index if not exists agent_action_queue_statuses_agent_action_key_idx
  on public.agent_action_queue_statuses (agent_id, action_key);

create index if not exists agent_action_queue_statuses_owner_user_id_idx
  on public.agent_action_queue_statuses (owner_user_id);

create index if not exists agent_action_queue_statuses_status_idx
  on public.agent_action_queue_statuses (status);

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

create unique index if not exists agent_follow_up_workflows_agent_dedupe_idx
  on public.agent_follow_up_workflows (agent_id, owner_user_id, dedupe_key);

create index if not exists agent_follow_up_workflows_agent_owner_idx
  on public.agent_follow_up_workflows (agent_id, owner_user_id);

create index if not exists agent_follow_up_workflows_status_idx
  on public.agent_follow_up_workflows (status);

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

create unique index if not exists agent_knowledge_fix_workflows_agent_dedupe_idx
  on public.agent_knowledge_fix_workflows (agent_id, owner_user_id, dedupe_key);

create index if not exists agent_knowledge_fix_workflows_agent_owner_idx
  on public.agent_knowledge_fix_workflows (agent_id, owner_user_id);

create index if not exists agent_knowledge_fix_workflows_status_idx
  on public.agent_knowledge_fix_workflows (status);

create table if not exists public.product_events (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  agent_id uuid references public.agents (id) on delete set null,
  event_name text not null,
  source text,
  metadata jsonb,
  created_at timestamp with time zone default now()
);

create index if not exists product_events_client_id_idx
  on public.product_events (client_id);

create index if not exists product_events_event_name_idx
  on public.product_events (event_name);

create index if not exists product_events_created_at_idx
  on public.product_events (created_at desc);

create table if not exists public.agent_installations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  host text not null,
  origin text,
  page_url text,
  last_session_id text,
  last_fingerprint text,
  first_seen_at timestamp with time zone default now(),
  last_seen_at timestamp with time zone default now()
);

create unique index if not exists agent_installations_agent_host_idx
  on public.agent_installations (agent_id, host);

create index if not exists agent_installations_agent_id_idx
  on public.agent_installations (agent_id);

create index if not exists agent_installations_last_seen_at_idx
  on public.agent_installations (last_seen_at desc);

create table if not exists public.agent_widget_events (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  install_id uuid,
  session_id text not null,
  fingerprint text,
  event_name text not null,
  origin text,
  page_url text,
  metadata jsonb,
  dedupe_key text not null,
  created_at timestamp with time zone default now()
);

create unique index if not exists agent_widget_events_dedupe_key_idx
  on public.agent_widget_events (dedupe_key);

create index if not exists agent_widget_events_agent_id_idx
  on public.agent_widget_events (agent_id);

create index if not exists agent_widget_events_event_name_idx
  on public.agent_widget_events (event_name);

create index if not exists agent_widget_events_created_at_idx
  on public.agent_widget_events (created_at desc);
