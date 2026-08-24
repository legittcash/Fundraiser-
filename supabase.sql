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

-- =========================================================================
-- ADMIN DASHBOARD / MULTI-CAMPAIGN SCHEMA UPDATES
-- =========================================================================
-- Everything below turns the single "Lucy" fundraiser into a platform that
-- can host unlimited patient campaigns, managed from the admin dashboard.
-- These statements are safe to run even on a database that already has
-- data in it — "add column if not exists" won't touch columns that are
-- already there, and the backfill step only fills in blanks.

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
