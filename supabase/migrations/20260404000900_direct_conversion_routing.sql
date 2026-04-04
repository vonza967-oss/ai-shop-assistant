-- Legacy source: db/direct_conversion_routing.sql

alter table if exists public.widget_configs
  add column if not exists booking_url text;

alter table if exists public.widget_configs
  add column if not exists quote_url text;

alter table if exists public.widget_configs
  add column if not exists checkout_url text;

alter table if exists public.widget_configs
  add column if not exists contact_email text;

alter table if exists public.widget_configs
  add column if not exists contact_phone text;

alter table if exists public.widget_configs
  add column if not exists primary_cta_mode text;

alter table if exists public.widget_configs
  add column if not exists fallback_cta_mode text;

alter table if exists public.widget_configs
  add column if not exists business_hours_note text;
