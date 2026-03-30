drop table if exists public.website_content;
drop table if exists public.businesses;
drop table if exists public.widget_configs;
drop table if exists public.agents;

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text,
  website_url text unique,
  created_at timestamp with time zone default now()
);

create table public.website_content (
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

create unique index website_content_business_id_idx
  on public.website_content (business_id);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses (id) on delete cascade,
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

create index agents_business_id_idx
  on public.agents (business_id);

create table public.widget_configs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  welcome_message text,
  button_label text,
  primary_color text,
  secondary_color text,
  launcher_text text,
  theme_mode text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index widget_configs_agent_id_idx
  on public.widget_configs (agent_id);
