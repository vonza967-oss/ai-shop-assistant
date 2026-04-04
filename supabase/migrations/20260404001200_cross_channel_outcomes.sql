-- Legacy source: db/cross_channel_outcomes.sql

alter table public.agent_conversion_outcomes
  add column if not exists inbox_thread_id uuid,
  add column if not exists calendar_event_id uuid,
  add column if not exists campaign_id uuid,
  add column if not exists campaign_recipient_id uuid,
  add column if not exists operator_task_id uuid,
  add column if not exists attribution_path text;

update public.agent_conversion_outcomes
set attribution_path = nullif(metadata->>'attributionPath', '')
where attribution_path is null
  and metadata ? 'attributionPath';

create index if not exists agent_conversion_outcomes_inbox_thread_idx
  on public.agent_conversion_outcomes (inbox_thread_id);

create index if not exists agent_conversion_outcomes_calendar_event_idx
  on public.agent_conversion_outcomes (calendar_event_id);

create index if not exists agent_conversion_outcomes_campaign_idx
  on public.agent_conversion_outcomes (campaign_id);

create index if not exists agent_conversion_outcomes_campaign_recipient_idx
  on public.agent_conversion_outcomes (campaign_recipient_id);

create index if not exists agent_conversion_outcomes_operator_task_idx
  on public.agent_conversion_outcomes (operator_task_id);

create index if not exists agent_conversion_outcomes_attribution_path_idx
  on public.agent_conversion_outcomes (attribution_path);
