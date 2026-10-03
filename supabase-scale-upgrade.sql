-- supabase-scale-upgrade.sql
--
-- SAFE, ADDITIVE migration that lets KODEP handle very large numbers of
-- campaigns and donations (tens of thousands of campaigns, hundreds of
-- thousands of donations). Run it ONCE in the Supabase SQL Editor.
--
-- This file does NOT delete, reset, rename, or change any table, column,
-- or row. It only:
--   1. adds indexes (so lookups stay fast as the tables grow), and
--   2. adds read-only functions that let the database add things up
--      itself instead of sending every row to the server.
--
-- Every statement can be run again with no effect the second time.
-- The website keeps working whether or not this file has been run: the
-- server code uses these functions when they exist and falls back to its
-- previous (slower) method when they do not. So the order of "run this
-- file" and "upload the new code to GitHub" does not matter.

-- =========================================================================
-- 1. INDEXES
-- =========================================================================

-- A campaign's donations, newest first: Recent Donors on the public page
-- and every per campaign lookup. (Postgres does NOT create an index for a
-- foreign key automatically.)
create index if not exists donations_fundraiser_created_idx
  on donations (fundraiser_id, created_at desc);

-- Only the donations that actually settled money, with the amount stored in
-- the index itself, so "Amount Settled" can be summed without reading the
-- table.
create index if not exists donations_settled_idx
  on donations (fundraiser_id) include (settled_amount)
  where settled_amount > 0;

-- The admin dashboard's "Recent Donations" (newest ten across all campaigns).
create index if not exists donations_created_idx
  on donations (created_at desc);

-- The homepage list (active campaigns, newest first) and the admin tabs.
create index if not exists fundraiser_status_created_idx
  on fundraiser (status, created_at desc, id desc);

-- The admin "All" tab and anything ordered newest first without a status.
create index if not exists fundraiser_created_idx
  on fundraiser (created_at desc, id desc);

-- Fast "contains" search on patient names (the homepage and admin search
-- boxes use ILIKE '%text%', which an ordinary index cannot help). This
-- uses the pg_trgm extension. The block finds whichever schema the
-- extension lives in, so it works whether Supabase placed it in
-- "extensions" or "public".
do $$
begin
  create extension if not exists pg_trgm with schema extensions;
exception when others then
  -- Extension may already exist elsewhere, or the schema may not exist;
  -- either way fall through and look it up below.
  null;
end $$;

do $$
declare
  ext_schema text;
begin
  select n.nspname into ext_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';

  if ext_schema is null then
    create extension if not exists pg_trgm;
    select n.nspname into ext_schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_trgm';
  end if;

  execute format(
    'create index if not exists fundraiser_patient_name_trgm_idx on fundraiser using gin (patient_name %I.gin_trgm_ops)',
    ext_schema
  );
end $$;

-- =========================================================================
-- 2. READ-ONLY FUNCTIONS (only the server, with the service role key, may
--    call them; the public and logged-in website visitors may not)
-- =========================================================================

-- 2a. Admin Overview totals, calculated by the database in one query.
-- Same definitions the dashboard has always used:
--   total_raised = sum of fundraiser.raised_amount (net)
--   total_donors = sum of fundraiser.donor_count
--   gross / Paystack fees / platform fees / settled = sums over donations
create or replace function admin_overview_totals()
returns table (
  total_patients bigint,
  active_campaigns bigint,
  total_raised numeric,
  total_donors numeric,
  total_gross_donations numeric,
  total_paystack_fees numeric,
  total_platform_fees numeric,
  total_amount_settled numeric
)
language sql
stable
as $$
  select
    (select count(*) from fundraiser),
    (select count(*) from fundraiser where status = 'active'),
    (select coalesce(sum(raised_amount), 0) from fundraiser),
    (select coalesce(sum(donor_count), 0) from fundraiser),
    (select coalesce(sum(amount), 0) from donations),
    (select coalesce(sum(paystack_fee), 0) from donations),
    (select coalesce(sum(platform_fee), 0) from donations),
    (select coalesce(sum(settled_amount), 0) from donations);
$$;

-- 2b. One page of the admin campaign list. p_tab is one of: active,
-- pending, goal_achieved, archived, rejected, all. Newest first, with the
-- id as a tie-break so paging never skips or repeats a campaign.
-- "goal_achieved" means the goal is above zero and raised >= goal, exactly
-- as the dashboard has always defined it (regardless of status).
create or replace function admin_list_campaigns(
  p_tab text,
  p_search text,
  p_limit integer,
  p_offset integer
)
returns setof fundraiser
language sql
stable
as $$
  select f.*
  from fundraiser f
  where (
          p_tab = 'all'
       or (p_tab in ('active', 'pending', 'archived', 'rejected') and f.status = p_tab)
       or (p_tab = 'goal_achieved' and f.goal_amount > 0 and f.raised_amount >= f.goal_amount)
        )
    and (coalesce(p_search, '') = '' or f.patient_name ilike '%' || p_search || '%')
  order by f.created_at desc, f.id desc
  limit greatest(p_limit, 1)
  offset greatest(p_offset, 0);
$$;

-- 2c. The numbers on the admin tabs (respecting the search box).
create or replace function admin_campaign_counts(p_search text)
returns table (
  all_count bigint,
  active_count bigint,
  pending_count bigint,
  goal_achieved_count bigint,
  archived_count bigint,
  rejected_count bigint
)
language sql
stable
as $$
  select
    count(*),
    count(*) filter (where status = 'active'),
    count(*) filter (where status = 'pending'),
    count(*) filter (where goal_amount > 0 and raised_amount >= goal_amount),
    count(*) filter (where status = 'archived'),
    count(*) filter (where status = 'rejected')
  from fundraiser
  where coalesce(p_search, '') = '' or patient_name ilike '%' || p_search || '%';
$$;

-- 2d. Amount Settled for a handful of campaigns at once (the admin table).
create or replace function admin_settled_for_campaigns(p_ids bigint[])
returns table (fundraiser_id bigint, settled numeric)
language sql
stable
as $$
  select d.fundraiser_id, sum(d.settled_amount)
  from donations d
  where d.fundraiser_id = any(p_ids) and d.settled_amount > 0
  group by d.fundraiser_id;
$$;

-- 2e. Amount Settled for ONE campaign (the public campaign page).
create or replace function campaign_amount_settled(p_fundraiser_id bigint)
returns numeric
language sql
stable
as $$
  select coalesce(sum(settled_amount), 0)
  from donations
  where fundraiser_id = p_fundraiser_id and settled_amount > 0;
$$;

-- Only our own trusted server (SERVICE ROLE key) may call these.
revoke all on function admin_overview_totals() from public, anon, authenticated;
revoke all on function admin_list_campaigns(text, text, integer, integer) from public, anon, authenticated;
revoke all on function admin_campaign_counts(text) from public, anon, authenticated;
revoke all on function admin_settled_for_campaigns(bigint[]) from public, anon, authenticated;
revoke all on function campaign_amount_settled(bigint) from public, anon, authenticated;

grant execute on function admin_overview_totals() to service_role;
grant execute on function admin_list_campaigns(text, text, integer, integer) to service_role;
grant execute on function admin_campaign_counts(text) to service_role;
grant execute on function admin_settled_for_campaigns(bigint[]) to service_role;
grant execute on function campaign_amount_settled(bigint) to service_role;
