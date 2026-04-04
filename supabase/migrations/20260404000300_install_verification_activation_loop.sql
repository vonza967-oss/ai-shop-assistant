-- Legacy source: db/install_verification_activation_loop.sql

alter table if exists public.widget_configs
  add column if not exists install_id uuid default gen_random_uuid(),
  add column if not exists allowed_domains text[] not null default '{}',
  add column if not exists last_verification_status text,
  add column if not exists last_verified_at timestamp with time zone,
  add column if not exists last_verification_origin text,
  add column if not exists last_verification_target_url text,
  add column if not exists last_verification_details jsonb;

update public.widget_configs
set install_id = gen_random_uuid()
where install_id is null;

update public.widget_configs wc
set allowed_domains = array[
  lower(
    regexp_replace(
      split_part(split_part(coalesce(b.website_url, ''), '://', 2), '/', 1),
      '^www\\.',
      ''
    )
  )
]
from public.agents a
join public.businesses b
  on b.id = a.business_id
where wc.agent_id = a.id
  and (wc.allowed_domains is null or cardinality(wc.allowed_domains) = 0)
  and coalesce(b.website_url, '') <> '';

create unique index if not exists widget_configs_install_id_idx
  on public.widget_configs (install_id);

alter table if exists public.agent_installations
  add column if not exists origin text,
  add column if not exists last_session_id text,
  add column if not exists last_fingerprint text;

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
