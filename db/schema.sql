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
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists widget_configs_agent_id_idx
  on public.widget_configs (agent_id);

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
  status text default 'new' check (status in ('new', 'reviewed', 'done', 'dismissed')),
  note text,
  outcome text,
  next_step text,
  follow_up_needed boolean,
  follow_up_completed boolean,
  contact_status text check (
    contact_status is null
    or contact_status in ('not_contacted', 'attempted', 'contacted', 'qualified')
  ),
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

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
  page_url text,
  first_seen_at timestamp with time zone default now(),
  last_seen_at timestamp with time zone default now()
);

create unique index if not exists agent_installations_agent_host_idx
  on public.agent_installations (agent_id, host);

create index if not exists agent_installations_agent_id_idx
  on public.agent_installations (agent_id);

create index if not exists agent_installations_last_seen_at_idx
  on public.agent_installations (last_seen_at desc);
