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

-- 2. Insert the initial fundraiser row only when the table is empty.
-- This makes the script safe to run again on an existing database.
-- If Lucy (or any existing campaign) is already present, nothing is inserted.
insert into fundraiser (raised_amount, goal_amount, donor_count)
select 0, 1000, 0
where not exists (select 1 from fundraiser);

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

-- =========================================================================
-- ADMIN DASHBOARD / MULTI-CAMPAIGN SCHEMA UPDATES
-- =========================================================================
-- Everything below turns the single "Lucy" fundraiser into a platform that
-- can host unlimited patient campaigns, managed from the admin dashboard.
-- These statements are safe to run even on a database that already has
-- data in it. Existing rows are preserved, columns are added only when
-- missing, and the backfill step only fills in blanks. The initial seed
-- row above is also conditional, so it cannot recreate Lucy or create a
-- duplicate fundraiser when this file is run again.

-- 6. Add the new campaign fields to "fundraiser"
alter table fundraiser add column if not exists patient_name text;
alter table fundraiser add column if not exists hospital text;
alter table fundraiser add column if not exists diagnosis text;
alter table fundraiser add column if not exists story text;
alter table fundraiser add column if not exists image_url text;
alter table fundraiser add column if not exists slug text;
alter table fundraiser add column if not exists status text not null default 'active';
alter table fundraiser add column if not exists created_at timestamptz not null default now();

-- Make sure "status" can only ever be 'active' or 'archived'
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'fundraiser_status_check'
  ) then
    alter table fundraiser
      add constraint fundraiser_status_check check (status in ('active', 'archived'));
  end if;
end $$;

-- Every campaign needs a unique, URL-friendly "slug" (e.g. "lucy-x7k2") so
-- the public site can link to /campaign.html?slug=lucy-x7k2
create unique index if not exists fundraiser_slug_key on fundraiser (slug);

-- 7. Backfill your existing "Lucy" row so it keeps working as a proper
-- campaign on the new multi-campaign homepage, instead of disappearing.
-- (Only fills in the row that has no patient_name yet — safe to re-run.)
update fundraiser
set
  patient_name = coalesce(patient_name, 'Lucy'),
  story = coalesce(story, 'Lucy urgently needs financial support for surgery, chemotherapy, hospital care, and medication.'),
  image_url = coalesce(image_url, '/images/lucy.jpg'),
  slug = coalesce(slug, 'lucy'),
  status = coalesce(status, 'active')
where patient_name is null;

-- 8. Let a campaign be deleted cleanly, taking its donation history with
-- it (so deleting a campaign in the admin dashboard never fails with a
-- "still referenced" foreign key error).
alter table donations drop constraint if exists donations_fundraiser_id_fkey;
alter table donations
  add constraint donations_fundraiser_id_fkey
  foreign key (fundraiser_id) references fundraiser (id) on delete cascade;

-- =========================================================================
-- STORAGE BUCKET FOR PATIENT PHOTOS
-- =========================================================================
-- The admin dashboard uploads patient photos to Supabase Storage instead
-- of asking you to upload files to GitHub. The easiest, most beginner-
-- friendly way to create the bucket is through the Supabase dashboard UI
-- (Storage → New bucket) — see README.md, step 4b, for the exact clicks.
--
-- If you'd rather do it here in SQL instead, this does the same thing:
insert into storage.buckets (id, name, public)
values ('campaign-images', 'campaign-images', true)
on conflict (id) do nothing;

-- Allow anyone to VIEW images in this bucket (needed so patient photos
-- show up on the public website), but only our server (using the SERVICE
-- ROLE key in api/admin/upload-image.js) can upload/replace/delete files.
-- The service role key bypasses RLS entirely, so no extra "insert" policy
-- is required for the admin upload function to work.
drop policy if exists "Public can view campaign images" on storage.objects;
create policy "Public can view campaign images"
  on storage.objects for select
  using (bucket_id = 'campaign-images');

-- =========================================================================
-- DONOR NAME / ANONYMOUS DONATIONS
-- =========================================================================
-- 9. Add the donor's name and their "give anonymously?" choice to
-- "donations". donor_email was already nullable, so no change was needed
-- there to make email optional — these two are the only new columns.
alter table donations add column if not exists donor_name text;
alter table donations add column if not exists anonymous boolean not null default false;

-- donor_name is intentionally NOT "not null": the column needs to exist
-- before we can backfill any old rows, and older donations recorded
-- before this feature existed simply won't have a name on file.

-- =========================================================================
-- PRIVATE CAMPAIGN CONTACT PHONE NUMBERS
-- =========================================================================
-- 10. Add the patient/authorized-contact phone numbers to "fundraiser".
-- These are PRIVATE administrative fields for the admin to use when
-- following up on a campaign — see api/campaign.js and api/campaigns.js,
-- which deliberately select an explicit list of columns (never "*") so
-- these two are never returned to the public website or donors.
--
-- Both are stored as TEXT, not a numeric type, since phone numbers can
-- start with a leading zero or a "+" country code and are never used in
-- arithmetic.
--
-- IMPORTANT: phone_number is NOT declared "not null" here, on purpose.
-- Existing campaigns (including the original "Lucy" row) were created
-- before this field existed and have no phone number on file — adding a
-- database-level NOT NULL constraint without backfilling every existing
-- row first would break them immediately. Instead, the requirement that
-- NEW campaigns must have a primary phone number is enforced in the
-- application layer (api/admin/campaigns.js), which is the safe way to
-- add a "required" field without a destructive migration.
alter table fundraiser add column if not exists phone_number text;
alter table fundraiser add column if not exists secondary_phone_number text;

-- =========================================================================
-- PAYSTACK TRANSACTION FEES
-- =========================================================================
-- 11. Add columns so "donations" records the full breakdown of every
-- payment: what the donor actually paid, what Paystack kept as its
-- transaction fee, and what the campaign actually received.
--
--   amount        — already existed: the GROSS amount the donor paid.
--   paystack_fee  — NEW: the fee Paystack deducted, taken directly from
--                   the "fees" field Paystack sends in the charge.success
--                   webhook payload (see api/paystack-webhook.js). Never
--                   a guessed or hard-coded value.
--   net_amount    — NEW: amount - paystack_fee. This is what the webhook
--                   now adds to fundraiser.raised_amount, so the
--                   progress bar reflects money actually received, not
--                   the donor's gross payment.
alter table donations add column if not exists paystack_fee numeric not null default 0;
alter table donations add column if not exists net_amount numeric;

-- Backfill EXISTING donations (recorded before this feature existed).
-- IMPORTANT: we do NOT know what Paystack actually charged in fees on
-- those historical transactions — that information was never captured
-- at the time, and retroactively guessing it would be inventing data.
-- The safe, honest choice is to treat historical rows as fee = 0 and
-- net_amount = amount. This also means the backfill causes NO change to
-- any existing fundraiser.raised_amount total, since those totals were
-- already computed by summing the gross "amount" of each donation back
-- when they were recorded — old totals stay exactly as they were.
-- Only NEW donations recorded after this migration will have a real,
-- Paystack-reported fee and a true net_amount.
update donations
set net_amount = coalesce(net_amount, amount)
where net_amount is null;
