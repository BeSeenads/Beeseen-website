-- BeSeen authentication / role setup
-- Run this once in Supabase SQL Editor.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  full_name text,
  role text not null default 'member' check (role in ('member','admin','owner')),
  subscription text not null default 'none' check (subscription in ('none','gold','premium','platinum')),
  subscription_status text not null default 'inactive',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data->>'full_name',''),
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

-- If the owner account already existed BEFORE running this SQL, promote it once:
-- update public.profiles set role='owner' where lower(email)='akilhsen4@gmail.com';

-- IMPORTANT: do not allow clients to update role or subscription directly.
-- Stripe webhooks / secure server functions should update subscription fields later.
