-- supabase.sql
--
-- Run this file inside Supabase's SQL Editor (see README.md for
-- step-by-step instructions). It creates the "fundraiser" table that
-- stores the live totals shown on the progress bar, and inserts one
-- starting row.

-- 1. Create the table
create table if not exists fundraiser (
  id bigint generated always as identity primary key,
  raised_amount numeric not null default 0,   -- total naira raised so far
  goal_amount numeric not null default 1000,  -- fundraising target in naira
  donor_count integer not null default 0,     -- number of successful donations
  updated_at timestamptz not null default now()
);

-- 2. Insert the single starting row for Lucy's fundraiser
-- (Only run this once — running it again will create a duplicate row.)
insert into fundraiser (raised_amount, goal_amount, donor_count)
values (0, 1000, 0);

-- 3. (Recommended) Enable Row Level Security so the table can only be
-- read/written using the service role key from our serverless
-- functions, never directly by anonymous website visitors.
alter table fundraiser enable row level security;

-- No policies are created for the "anon" role on purpose — this means
-- the public API key cannot read or write this table directly. Only
-- our Vercel functions, which use the SERVICE ROLE key, can access it.

-- 4. Create the "donations" table
-- This records every individual donation we've already processed, keyed
-- by Paystack's unique transaction reference. The webhook checks this
-- table BEFORE touching the fundraiser totals: if a reference is already
-- here, it means we've already counted that payment, so we skip it.
-- This is what stops a duplicate/retried webhook from double-counting.
create table if not exists donations (
  id bigint generated always as identity primary key,
  paystack_reference text not null unique,   -- Paystack's transaction reference (idempotency key)
  amount numeric not null,                   -- amount donated, in naira
  donor_email text,                          -- email the donor paid with
  fundraiser_id bigint references fundraiser (id), -- which fundraiser this donation belongs to
  created_at timestamptz not null default now()
);

-- 5. Enable Row Level Security on donations too, for the same reason as
-- above: only our Vercel functions (using the SERVICE ROLE key) should
-- be able to read or write this table.
alter table donations enable row level security;
