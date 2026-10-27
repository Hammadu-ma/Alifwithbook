-- Run this in Supabase SQL Editor.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  uid text not null,
  endpoint text not null unique,
  subscription jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_uid_idx on public.push_subscriptions(uid);
alter table public.push_subscriptions enable row level security;
-- The browser never queries this table directly. Only the service-role API uses it.
-- No client policies are intentionally created.
