-- BeSeen authentication, roles, subscriptions, Stripe IDs, and referral tracking.
-- Safe to run on a new project. The ALTER/UPDATE statements also support upgrading
-- an earlier BeSeen schema.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  full_name text,
  referral_code text,
  my_referral_code text,
  referred_by_code text,
  role text not null default 'member' check (role in ('member','admin','owner')),
  subscription text not null default 'none' check (subscription in ('none','gold','premium','platinum')),
  subscription_status text not null default 'inactive',
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upgrade columns for projects that already ran an older schema.
alter table public.profiles add column if not exists referral_code text;
alter table public.profiles add column if not exists my_referral_code text;
alter table public.profiles add column if not exists referred_by_code text;
alter table public.profiles add column if not exists stripe_customer_id text;
alter table public.profiles add column if not exists stripe_subscription_id text;

create unique index if not exists profiles_stripe_customer_id_unique
on public.profiles (stripe_customer_id)
where stripe_customer_id is not null;

create unique index if not exists profiles_my_referral_code_unique
on public.profiles (lower(my_referral_code))
where my_referral_code is not null;

-- Creates a readable, effectively unique code such as HUSSEIN-A1B2C3D4.
create or replace function public.make_referral_code(p_name text, p_email text, p_id uuid)
returns text
language sql
immutable
as $$
  select upper(
    left(
      regexp_replace(
        coalesce(nullif(trim(p_name),''), split_part(coalesce(p_email,'BESEEN'),'@',1), 'BESEEN'),
        '[^A-Za-z0-9]', '', 'g'
      ), 8
    )
    || '-' || left(replace(p_id::text,'-',''),8)
  );
$$;

-- Preserve referral codes entered under the older schema, then give every
-- existing account its own code.
update public.profiles
set referred_by_code = coalesce(referred_by_code, nullif(trim(referral_code),''))
where referred_by_code is null;

update public.profiles
set my_referral_code = public.make_referral_code(full_name,email,id)
where my_referral_code is null;

alter table public.profiles enable row level security;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  entered_referral text;
begin
  entered_referral := nullif(trim(coalesce(
    new.raw_user_meta_data->>'referred_by_code',
    new.raw_user_meta_data->>'referral_code',
    ''
  )), '');

  insert into public.profiles (
    id, email, full_name, referral_code, referred_by_code, my_referral_code, role
  )
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data->>'full_name',''),
    entered_referral,
    entered_referral,
    public.make_referral_code(coalesce(new.raw_user_meta_data->>'full_name',''), lower(new.email), new.id),
    case when lower(new.email) = 'akilhsen4@gmail.com' then 'owner' else 'member' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Users may read their own profile.
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile"
on public.profiles for select
to authenticated
using (id = auth.uid());

-- Owner/admin helper. Security definer prevents recursive RLS checks.
create or replace function public.is_beseen_staff()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('owner','admin')
  );
$$;

revoke all on function public.is_beseen_staff() from public;
grant execute on function public.is_beseen_staff() to authenticated;

-- Staff may read profiles for the control center.
drop policy if exists "staff read profiles" on public.profiles;
create policy "staff read profiles"
on public.profiles for select
to authenticated
using (public.is_beseen_staff());

-- A signed-in user can see aggregate referral counts without being allowed
-- to read the referred users' private profile rows.
create or replace function public.get_my_referral_stats()
returns table(total_referrals bigint, active_subscribers bigint)
language sql
stable
security definer set search_path = public
as $$
  with me as (
    select my_referral_code from public.profiles where id = auth.uid()
  )
  select
    count(*)::bigint as total_referrals,
    count(*) filter (
      where p.subscription <> 'none'
        and lower(coalesce(p.subscription_status,'')) in ('active','trialing')
    )::bigint as active_subscribers
  from public.profiles p, me
  where me.my_referral_code is not null
    and lower(coalesce(p.referred_by_code,'')) = lower(me.my_referral_code);
$$;

revoke all on function public.get_my_referral_stats() from public;
grant execute on function public.get_my_referral_stats() to authenticated;

-- If the owner account already existed BEFORE running this SQL, promote it once:
-- update public.profiles set role='owner' where lower(email)='akilhsen4@gmail.com';

-- IMPORTANT: do not allow browser clients to update role or subscription directly.
-- Stripe webhooks / secure server functions update subscription fields.

-- ============================================================
-- Owner account + no-code Location Manager
-- ============================================================

-- If the primary Owner account already exists when this script is rerun,
-- promote it immediately. Future signups are still handled by handle_new_user().
update public.profiles
set role = 'owner', updated_at = now()
where lower(email) = 'akilhsen4@gmail.com';

create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  city text,
  status text not null default 'future' check (status in ('live','future','paused')),
  visibility text not null default 'private' check (visibility in ('public','platinum','private')),
  short_description text,
  description text,
  device_count integer not null default 0 check (device_count >= 0),
  image_url text,
  gold_price_cents integer not null default 20000 check (gold_price_cents >= 0),
  premium_price_cents integer not null default 25000 check (premium_price_cents >= 0),
  platinum_price_cents integer not null default 30000 check (platinum_price_cents >= 0),
  stripe_product_id text,
  stripe_price_gold text,
  stripe_price_premium text,
  stripe_price_platinum text,
  sort_order integer not null default 100,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.locations enable row level security;

-- The public website reads locations through /api/locations and staff writes
-- through authenticated Vercel functions using the service-role key. No direct
-- browser write policy is intentionally created.

insert into public.locations (
  slug,name,city,status,visibility,short_description,description,device_count,
  gold_price_cents,premium_price_cents,platinum_price_cents,sort_order
) values (
  'exclusive','Exclusive Hookah Lounge','Dearborn','live','public',
  'Available now • subscriptions + photos',
  'BeSeen displays are strategically placed throughout Exclusive Hookah Lounge. Many units also function as portable charging stations, creating natural repeated exposure throughout a customer visit.',
  15,20000,25000,30000,10
)
on conflict (slug) do nothing;


-- ============================================================
-- Seed BeSeen future placements (private Platinum/FOMO only)
-- These are real planned location records, not sample analytics data.
-- Exact details can be edited later from Owner > Location Manager.
-- ============================================================
insert into public.locations
  (slug,name,city,status,visibility,short_description,description,device_count,
   gold_price_cents,premium_price_cents,platinum_price_cents,sort_order)
values
  ('magical-touch-inkster','Magical Touch Car Wash — Inkster','Inkster','future','platinum',
   'Future BeSeen placement at Magical Touch Car Wash in Inkster.',
   'Platinum advertisers can see this planned placement before it is released publicly.',0,20000,25000,30000,20),
  ('magical-touch-greenfield','Magical Touch Car Wash — Greenfield',null,'future','platinum',
   'Future BeSeen placement at Magical Touch Car Wash on Greenfield.',
   'Platinum advertisers can see this planned placement before it is released publicly.',0,20000,25000,30000,30),
  ('magical-touch-allen-park','Magical Touch Car Wash — Allen Park','Allen Park','future','platinum',
   'Future BeSeen placement at Magical Touch Car Wash in Allen Park.',
   'Platinum advertisers can see this planned placement before it is released publicly.',0,20000,25000,30000,40),
  ('magical-touch-redford','Magical Touch Car Wash — Redford','Redford','future','platinum',
   'Future BeSeen placement at Magical Touch Car Wash in Redford.',
   'Platinum advertisers can see this planned placement before it is released publicly.',0,20000,25000,30000,50),
  ('ev-station','EV Station',null,'future','platinum',
   'Future BeSeen EV-station advertising placement.',
   'Platinum advertisers can see this planned placement before it is released publicly.',0,20000,25000,30000,60),
  ('digital-billboard-greenfield','Digital Billboard — Greenfield',null,'future','platinum',
   'Future BeSeen digital billboard placement on Greenfield.',
   'Platinum advertisers can see this planned placement before it is released publicly.',0,20000,25000,30000,70),
  ('monday-coffee-club','Monday Coffee Club',null,'future','platinum',
   'Future BeSeen placement at Monday Coffee Club.',
   'Platinum advertisers can see this planned placement before it is released publicly.',0,20000,25000,30000,80),
  ('gallery','Gallery',null,'future','platinum',
   'Future BeSeen Gallery placement.',
   'Platinum advertisers can see this planned placement before it is released publicly.',0,20000,25000,30000,90)
on conflict (slug) do update
set name=excluded.name,
    city=coalesce(public.locations.city, excluded.city),
    status='future',
    visibility='platinum',
    short_description=case when coalesce(public.locations.short_description,'')='' then excluded.short_description else public.locations.short_description end,
    description=case when coalesce(public.locations.description,'')='' then excluded.description else public.locations.description end,
    updated_at=now();

-- ============================================================
-- Multi-location subscriptions
-- First location is billed at its normal plan price. Every additional
-- live location receives a permanent $50/month discount.
-- ============================================================
create table if not exists public.subscription_locations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text not null,
  location_id uuid references public.locations(id) on delete set null,
  location_slug text not null,
  plan text not null check (plan in ('gold','premium','platinum')),
  status text not null default 'active',
  list_price_cents integer not null default 0 check (list_price_cents >= 0),
  billed_price_cents integer not null default 0 check (billed_price_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stripe_subscription_id, location_slug)
);

create index if not exists subscription_locations_user_idx
on public.subscription_locations (user_id);

create index if not exists subscription_locations_customer_idx
on public.subscription_locations (stripe_customer_id);

alter table public.subscription_locations enable row level security;

drop policy if exists "read own subscription locations" on public.subscription_locations;
create policy "read own subscription locations"
on public.subscription_locations for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "staff read subscription locations" on public.subscription_locations;
create policy "staff read subscription locations"
on public.subscription_locations for select
to authenticated
using (public.is_beseen_staff());

-- ============================================================
-- Real campaign analytics foundation
-- No fake dashboard totals are seeded. All metrics start empty/zero
-- and are created only by actual tracked campaign events.
-- ============================================================
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  advertiser_id uuid not null references public.profiles(id) on delete cascade,
  location_id uuid references public.locations(id) on delete set null,
  name text not null,
  tracking_code text not null unique,
  landing_url text,
  status text not null default 'draft' check (status in ('draft','live','paused','ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tracking_events (
  id bigint generated by default as identity primary key,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  event_type text not null check (event_type in (
    'qr_scan','landing_visit','phone_click','form_start','form_submit',
    'directions_click','listing_view','custom'
  )),
  page_path text,
  session_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tracking_events_campaign_created_idx
on public.tracking_events (campaign_id, created_at desc);

alter table public.campaigns enable row level security;
alter table public.tracking_events enable row level security;

drop policy if exists "advertisers read own campaigns" on public.campaigns;
create policy "advertisers read own campaigns"
on public.campaigns for select to authenticated
using (advertiser_id = auth.uid() or public.is_beseen_staff());

-- Event rows are read through secured Vercel APIs. No browser insert/read policy
-- is created; server functions use the service-role key.

-- Location photos: uploads go through the authenticated staff-only Vercel API.
insert into storage.buckets (id, name, public)
values ('location-images','location-images',true)
on conflict (id) do update set public=true;

-- ============================================================
-- Subscription campaign intake + advertiser creative uploads
-- Captures real business/campaign information before Stripe checkout.
-- ============================================================
create table if not exists public.subscription_intakes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  business_name text not null,
  business_type text not null,
  website_or_social text,
  contact_phone text,
  campaign_details text not null,
  qr_destination_url text,
  creative_choice text not null check (creative_choice in ('own_ad','beseen_create')),
  ad_asset_path text,
  plan text not null check (plan in ('gold','premium','platinum')),
  location_slugs text[] not null default '{}'::text[],
  status text not null default 'checkout_started' check (status in ('checkout_started','paid','subscription_canceled')),
  stripe_checkout_session_id text,
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Migration-safe additions for automatic QR campaign setup.
alter table public.subscription_intakes
  add column if not exists qr_destination_url text;

alter table public.campaigns
  add column if not exists subscription_intake_id uuid references public.subscription_intakes(id) on delete set null,
  add column if not exists stripe_subscription_id text;

create unique index if not exists campaigns_intake_location_unique
on public.campaigns (subscription_intake_id, location_id);

create index if not exists campaigns_subscription_idx
on public.campaigns (stripe_subscription_id);

create index if not exists subscription_intakes_user_idx
on public.subscription_intakes (user_id, created_at desc);

create index if not exists subscription_intakes_subscription_idx
on public.subscription_intakes (stripe_subscription_id);

alter table public.subscription_intakes enable row level security;

drop policy if exists "read own subscription intakes" on public.subscription_intakes;
create policy "read own subscription intakes"
on public.subscription_intakes for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "staff read subscription intakes" on public.subscription_intakes;
create policy "staff read subscription intakes"
on public.subscription_intakes for select
to authenticated
using (public.is_beseen_staff());

-- Ad uploads stay private until BeSeen reviews/uses them.
insert into storage.buckets (id, name, public)
values ('advertiser-assets','advertiser-assets',false)
on conflict (id) do update set public=false;
