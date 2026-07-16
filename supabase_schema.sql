-- ===================================================================
-- Supabase schema for the LINE slip-confirmation finance bot
-- Run this once in: Supabase Dashboard -> SQL Editor -> New query
-- ===================================================================

create extension if not exists "pgcrypto";

-- One row per "web app" installation. link_code is what the user types
-- into the LINE chat to connect their LINE account to this device.
create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  link_code text unique not null,
  line_user_id text unique,
  monthly_budget numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists transactions (
  id bigint generated always as identity primary key,
  device_id uuid not null references devices(id) on delete cascade,
  type text not null check (type in ('income', 'expense')),
  category text not null default 'อื่นๆ',
  description text default '',
  amount numeric not null check (amount > 0),
  date date not null,
  created_at timestamptz not null default now()
);

create index if not exists transactions_device_id_idx on transactions(device_id);
create index if not exists transactions_date_idx on transactions(date);

-- Tracks the multi-step conversation while the bot is asking the user
-- to confirm type / amount / category for a slip photo they just sent.
create table if not exists pending_slips (
  line_user_id text primary key,
  device_id uuid not null references devices(id) on delete cascade,
  step text not null default 'awaiting_type', -- awaiting_type | awaiting_amount | awaiting_category
  type text,
  amount numeric,
  category text,
  created_at timestamptz not null default now()
);

-- Lock every table down: only the server, using the SUPABASE_SERVICE_KEY
-- (service_role), may read or write. The web app never talks to Supabase
-- directly, so no anon-key policies are needed at all.
alter table devices enable row level security;
alter table transactions enable row level security;
alter table pending_slips enable row level security;
