-- Run once in the Supabase SQL editor before using Owner Billing Control.
alter table public.subscription_locations
  add column if not exists stripe_subscription_item_id text,
  add column if not exists stripe_price_id text,
  add column if not exists current_period_end timestamptz,
  add column if not exists custom_price_cents integer,
  add column if not exists custom_price_active boolean not null default false,
  add column if not exists billing_source text,
  add column if not exists paid_through timestamptz,
  add column if not exists next_charge_at timestamptz;

create table if not exists public.billing_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  location_id uuid references public.locations(id) on delete set null,
  location_slug text not null,
  plan text not null,
  standard_price_cents integer,
  custom_price_cents integer,
  custom_price_active boolean not null default false,
  billing_source text,
  paid_through timestamptz,
  next_charge_at timestamptz,
  migration_status text,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_subscription_item_id text,
  stripe_custom_price_id text,
  stripe_checkout_session_id text,
  owner_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, location_slug)
);
alter table public.billing_overrides enable row level security;

create table if not exists public.billing_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  stripe_customer_id text,
  stripe_subscription_id text,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists billing_events_user_idx on public.billing_events(user_id);
alter table public.billing_events enable row level security;
