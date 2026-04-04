-- Legacy source: db/connected_operator_workspace.sql

create table if not exists public.google_oauth_states (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  provider text not null default 'google',
  requested_scopes text[] not null default '{}',
  redirect_path text,
  selected_mailbox text,
  state_token_hash text not null unique,
  status text not null default 'pending',
  expires_at timestamp with time zone not null,
  completed_at timestamp with time zone,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists google_oauth_states_agent_owner_idx
  on public.google_oauth_states (agent_id, owner_user_id);

create index if not exists google_oauth_states_status_idx
  on public.google_oauth_states (status);

create table if not exists public.google_connected_accounts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  provider text not null default 'google',
  provider_account_id text,
  account_email text,
  display_name text,
  selected_mailbox text default 'INBOX',
  scopes text[] not null default '{}',
  scope_audit jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamp with time zone,
  last_refreshed_at timestamp with time zone,
  last_sync_at timestamp with time zone,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists google_connected_accounts_provider_account_idx
  on public.google_connected_accounts (agent_id, owner_user_id, provider, provider_account_id);

create unique index if not exists google_connected_accounts_email_idx
  on public.google_connected_accounts (agent_id, owner_user_id, provider, account_email)
  where account_email is not null;

create index if not exists google_connected_accounts_agent_owner_idx
  on public.google_connected_accounts (agent_id, owner_user_id);

create index if not exists google_connected_accounts_status_idx
  on public.google_connected_accounts (status);

create unique index if not exists google_connected_accounts_agent_provider_idx
  on public.google_connected_accounts (agent_id, owner_user_id, provider);

create table if not exists public.operator_inbox_threads (
  id uuid primary key default gen_random_uuid(),
  connected_account_id uuid references public.google_connected_accounts (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  provider_thread_id text not null,
  provider_history_id text,
  mailbox_label text,
  subject text,
  snippet text,
  classification text not null default 'follow_up_needed',
  priority text not null default 'normal',
  status text not null default 'open',
  complaint_state text not null default 'none',
  follow_up_state text not null default 'open',
  needs_reply boolean not null default false,
  risk_level text not null default 'normal',
  unread_count integer not null default 0,
  participants jsonb not null default '[]'::jsonb,
  related_lead_id uuid references public.agent_contact_leads (id) on delete set null,
  related_follow_up_id uuid references public.agent_follow_up_workflows (id) on delete set null,
  related_action_key text,
  last_message_at timestamp with time zone,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_inbox_threads_provider_thread_idx
  on public.operator_inbox_threads (connected_account_id, provider_thread_id);

create index if not exists operator_inbox_threads_agent_owner_idx
  on public.operator_inbox_threads (agent_id, owner_user_id, updated_at desc);

create index if not exists operator_inbox_threads_classification_idx
  on public.operator_inbox_threads (classification, status);

create table if not exists public.operator_inbox_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references public.operator_inbox_threads (id) on delete cascade,
  connected_account_id uuid references public.google_connected_accounts (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  provider_message_id text not null,
  direction text not null default 'inbound',
  approval_status text not null default 'not_required',
  message_state text not null default 'stored',
  sender text,
  recipients text[] not null default '{}',
  cc text[] not null default '{}',
  subject text,
  body_preview text,
  body_text text,
  sent_at timestamp with time zone,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_inbox_messages_provider_message_idx
  on public.operator_inbox_messages (connected_account_id, provider_message_id);

create index if not exists operator_inbox_messages_thread_idx
  on public.operator_inbox_messages (thread_id, created_at desc);

create table if not exists public.operator_calendar_events (
  id uuid primary key default gen_random_uuid(),
  connected_account_id uuid references public.google_connected_accounts (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  provider_event_id text,
  action_type text not null default 'view',
  source_kind text not null default 'google_sync',
  status text not null default 'confirmed',
  approval_status text not null default 'synced',
  title text,
  description text,
  attendee_emails text[] not null default '{}',
  start_at timestamp with time zone,
  end_at timestamp with time zone,
  timezone text,
  location text,
  lead_id uuid references public.agent_contact_leads (id) on delete set null,
  related_action_key text,
  conflict_state text not null default 'clear',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_calendar_events_provider_event_idx
  on public.operator_calendar_events (connected_account_id, provider_event_id)
  where provider_event_id is not null;

create index if not exists operator_calendar_events_agent_owner_idx
  on public.operator_calendar_events (agent_id, owner_user_id, start_at asc);

create index if not exists operator_calendar_events_approval_idx
  on public.operator_calendar_events (approval_status, status);

create table if not exists public.operator_campaigns (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  goal text not null,
  title text not null,
  status text not null default 'draft',
  approval_status text not null default 'draft',
  recipient_source text not null default 'captured_leads',
  source_filters jsonb not null default '{}'::jsonb,
  schedule_config jsonb not null default '{}'::jsonb,
  sequence_summary text,
  reply_handling_mode text not null default 'manual_review',
  approved_at timestamp with time zone,
  activated_at timestamp with time zone,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists operator_campaigns_agent_owner_idx
  on public.operator_campaigns (agent_id, owner_user_id, created_at desc);

create index if not exists operator_campaigns_status_idx
  on public.operator_campaigns (status, approval_status);

create table if not exists public.operator_campaign_steps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.operator_campaigns (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  step_order integer not null,
  channel text not null default 'email',
  timing_offset_hours integer not null default 0,
  subject text,
  body text,
  approval_status text not null default 'pending_owner',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_campaign_steps_campaign_order_idx
  on public.operator_campaign_steps (campaign_id, step_order);

create table if not exists public.operator_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.operator_campaigns (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  lead_id uuid references public.agent_contact_leads (id) on delete set null,
  person_key text,
  contact_name text,
  contact_email text,
  status text not null default 'pending',
  current_step_index integer not null default 0,
  next_send_at timestamp with time zone,
  last_contacted_at timestamp with time zone,
  reply_state text not null default 'awaiting_reply',
  last_thread_id uuid references public.operator_inbox_threads (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_campaign_recipients_campaign_email_idx
  on public.operator_campaign_recipients (campaign_id, contact_email)
  where contact_email is not null;

create index if not exists operator_campaign_recipients_campaign_status_idx
  on public.operator_campaign_recipients (campaign_id, status, next_send_at);

create table if not exists public.operator_tasks (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  source_type text not null,
  source_id text not null,
  task_type text not null,
  title text not null,
  description text,
  status text not null default 'open',
  priority text not null default 'normal',
  approval_required boolean not null default false,
  related_thread_id uuid references public.operator_inbox_threads (id) on delete set null,
  related_event_id uuid references public.operator_calendar_events (id) on delete set null,
  related_campaign_id uuid references public.operator_campaigns (id) on delete set null,
  related_lead_id uuid references public.agent_contact_leads (id) on delete set null,
  related_action_key text,
  task_state jsonb not null default '{}'::jsonb,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_tasks_source_dedupe_idx
  on public.operator_tasks (agent_id, owner_user_id, source_type, source_id, task_type);

create index if not exists operator_tasks_status_idx
  on public.operator_tasks (status, priority, created_at desc);

create table if not exists public.operator_workspace_activations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  operator_workspace_enabled boolean not null default true,
  google_connected boolean not null default false,
  inbox_context_selected boolean not null default false,
  calendar_context_selected boolean not null default false,
  inbox_synced boolean not null default false,
  calendar_synced boolean not null default false,
  first_inbox_review_completed boolean not null default false,
  first_reply_draft_created boolean not null default false,
  first_campaign_draft_created boolean not null default false,
  first_calendar_action_reviewed boolean not null default false,
  activation_completed_at timestamp with time zone,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists operator_workspace_activations_agent_owner_idx
  on public.operator_workspace_activations (agent_id, owner_user_id);

create table if not exists public.operator_audit_logs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  owner_user_id uuid,
  connected_account_id uuid references public.google_connected_accounts (id) on delete set null,
  actor_type text not null,
  actor_id text,
  action_type text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now()
);

create index if not exists operator_audit_logs_agent_owner_idx
  on public.operator_audit_logs (agent_id, owner_user_id, created_at desc);
