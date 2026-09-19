-- supabase-tracking.sql
--
-- SAFE, ADDITIVE migration for the private campaign-submission tracking
-- feature. Run this in the Supabase SQL Editor AFTER supabase.sql has
-- already been applied at least once (this migration assumes the
-- "fundraiser" table already exists with its "status" column and
-- "fundraiser_status_check" constraint, both created by supabase.sql).
--
-- This file does NOT:
--   - drop or replace the "fundraiser" table
--   - remove or rename any existing column
--   - touch the "donations", "beneficiaries", or "platform_settings"
--     tables, or any Paystack-related function
--
-- Every statement below is written so it can be run again with no
-- effect the second time (idempotent), and every existing row in
-- "fundraiser" is preserved exactly as-is — new columns are added as
-- nullable, so no existing row needs a value for them.

-- =========================================================================
-- 1. Submitter contact fields + tracking token + rejection reason
-- =========================================================================
-- These columns do not exist yet on "fundraiser" as of the current
-- schema (confirmed by inspecting supabase.sql and every api/*.js file
-- that selects from "fundraiser" before writing this migration). They
-- are added here as plain nullable TEXT columns:
--
--   submitter_name     — the visitor's own name (who submitted the
--                         campaign on behalf of the patient), never
--                         shown on any public page.
--   submitter_email    — optional; only useful for future email
--                         notifications, which are NOT implemented yet.
--   submitter_phone    — the submitter's own contact number, separate
--                         from the patient/beneficiary phone numbers
--                         that already exist on this table.
--   tracking_token     — a long, cryptographically random, unguessable
--                         string generated server-side in
--                         api/submit-campaign.js. Knowing this token is
--                         itself the access credential for the private
--                         /track.html?token=... status page — nothing
--                         else (no login) is required to use it.
--   rejection_reason   — free text an admin enters when rejecting a
--                         submission (see api/admin/campaigns.js and
--                         admin/dashboard.html). Cleared back to NULL
--                         whenever a campaign is (re)approved.
alter table fundraiser add column if not exists submitter_name text;
alter table fundraiser add column if not exists submitter_email text;
alter table fundraiser add column if not exists submitter_phone text;
alter table fundraiser add column if not exists tracking_token text;
alter table fundraiser add column if not exists rejection_reason text;

-- =========================================================================
-- 2. Unique index on tracking_token
-- =========================================================================
-- A visitor's tracking link must resolve to exactly one campaign, and
-- two campaigns must never be able to collide on the same token. A
-- plain (non-unique) index would not prevent that; a unique index does,
-- while still allowing MANY rows to have tracking_token = NULL (Postgres
-- treats NULL values as distinct from one another in a unique index, so
-- older rows created before this feature existed — which will all have
-- a NULL token — are completely unaffected).
create unique index if not exists fundraiser_tracking_token_key on fundraiser (tracking_token);

-- =========================================================================
-- 3. Status constraint — verify it already supports every required value
-- =========================================================================
-- Before touching this constraint, its CURRENT definition (as created by
-- supabase.sql, section 18 "VISITOR CAMPAIGN SUBMISSIONS") was inspected:
--
--   alter table fundraiser
--     add constraint fundraiser_status_check
--     check (status in ('active', 'archived', 'pending', 'rejected'));
--
-- That already allows every status value this tracking feature needs
-- (pending, active, rejected, archived) — no widening is required. The
-- block below is a defensive, idempotent safety net only: it re-creates
-- the constraint with the exact same allowed set if, and only if, it is
-- ever found missing or different (e.g. on a database where
-- supabase.sql's section 18 was never run). Running this on a database
-- that already has the correct constraint is a safe no-op — every
-- existing row's status is one of these four values already, so nothing
-- can fail to validate.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'fundraiser_status_check'
  ) then
    alter table fundraiser drop constraint fundraiser_status_check;
  end if;

  alter table fundraiser
    add constraint fundraiser_status_check
    check (status in ('active', 'archived', 'pending', 'rejected'));
end $$;
