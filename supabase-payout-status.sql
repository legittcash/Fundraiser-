-- supabase-payout-status.sql
--
-- SAFE, ADDITIVE migration that separates "the donor's payment succeeded"
-- from "the beneficiary has actually been paid out", and records what
-- Paystack reports about each beneficiary subaccount.
--
-- RUN THIS ONCE in the Supabase SQL Editor BEFORE deploying the new code.
-- Every statement is safe to run again. Nothing is deleted, no table is
-- dropped, no donation / campaign / beneficiary / payment reference is
-- touched or removed.
--
-- WHY: donations.settled_amount is written by the Paystack webhook at the
-- moment the CHARGE succeeds, from Paystack's fees_split.subaccount figure.
-- That is the beneficiary's EXPECTED SHARE of the donation, not proof of a
-- payout. The old totals summed that column and labelled it "settled".
-- From now on:
--   * settled_amount keeps its value but means "expected beneficiary share".
--   * donations.payout_status records the real payout state:
--       not_applicable  no subaccount was used (money stays in the main account)
--       pending_payout  split to a subaccount, NO evidence of payout yet
--       processing      found in a Paystack settlement that is pending/processing
--       settled         found in a Paystack settlement whose status is success
--       failed          found in a Paystack settlement whose status is failed
--   * Only 'settled' counts toward "Amount Settled" anywhere.
--   * Only the admin "Check payouts" action (api/admin/beneficiaries.js,
--     route=reconcile-payouts) may move a donation to processing/settled/
--     failed, using Paystack's Settlement API as the evidence. The webhook
--     can never set it.
--
-- HISTORICAL RECORDS: every donation that previously counted as "settled"
-- (settled_amount > 0) is set to pending_payout and flagged
-- payout_legacy_unconfirmed = true. Its settled_amount is NOT changed, so
-- the audit trail is intact. "Check payouts" can later confirm each one
-- against Paystack; until then it is shown as unconfirmed, never as paid.
--
-- If you ever re-run supabase-scale-upgrade.sql, run THIS file again
-- afterwards (it re-applies the payout aware totals functions).

begin;

-- 1. donations: payout columns (first run only, so the legacy flag below is
--    applied exactly once and never to donations created after this file).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'donations' and column_name = 'payout_status'
  ) then
    alter table donations
      add column payout_status text not null default 'pending_payout',
      add column payout_status_updated_at timestamptz,
      add column payout_settlement_id text,
      add column payout_settlement_date timestamptz,
      add column payout_confirmed_via text,
      add column payout_legacy_unconfirmed boolean not null default false;

    -- No subaccount used -> there is no beneficiary payout to wait for.
    update donations set payout_status = 'not_applicable'
    where settled_to_subaccount is null or settled_to_subaccount = '';

    -- Previously displayed as "settled" purely from the charge-time split.
    update donations set payout_legacy_unconfirmed = true
    where payout_status = 'pending_payout' and settled_amount > 0;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'donations_payout_status_check') then
    alter table donations
      add constraint donations_payout_status_check
      check (payout_status in ('not_applicable', 'pending_payout', 'processing', 'settled', 'failed'));
  end if;
end $$;

-- 2. New donations: decide the starting status automatically, so the
--    existing record_donation_and_update_totals function needs no change.
create or replace function donations_set_initial_payout_status()
returns trigger
language plpgsql
as $$
begin
  if new.settled_to_subaccount is null or new.settled_to_subaccount = '' then
    new.payout_status := 'not_applicable';
  else
    new.payout_status := 'pending_payout';
  end if;
  new.payout_status_updated_at := now();
  return new;
end;
$$;

drop trigger if exists donations_initial_payout_status on donations;
create trigger donations_initial_payout_status
  before insert on donations
  for each row execute function donations_set_initial_payout_status();

create index if not exists donations_payout_idx
  on donations (fundraiser_id, payout_status)
  include (settled_amount)
  where payout_status <> 'not_applicable';

-- 3. beneficiaries: what Paystack itself reports about the subaccount.
--    NULL means "not checked yet" (never assume verified).
alter table beneficiaries
  add column if not exists paystack_subaccount_id bigint,
  add column if not exists paystack_is_verified boolean,
  add column if not exists paystack_active boolean,
  add column if not exists paystack_status_checked_at timestamptz;

-- 4. Totals: "settled" now means CONFIRMED payout only. Same function
--    names and return shapes as before, so nothing else needs to change.
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
    (select coalesce(sum(settled_amount), 0) from donations where payout_status = 'settled');
$$;

create or replace function admin_settled_for_campaigns(p_ids bigint[])
returns table (fundraiser_id bigint, settled numeric)
language sql
stable
as $$
  select d.fundraiser_id, sum(d.settled_amount)
  from donations d
  where d.fundraiser_id = any(p_ids) and d.payout_status = 'settled' and d.settled_amount > 0
  group by d.fundraiser_id;
$$;

create or replace function campaign_amount_settled(p_fundraiser_id bigint)
returns numeric
language sql
stable
as $$
  select coalesce(sum(settled_amount), 0)
  from donations
  where fundraiser_id = p_fundraiser_id and payout_status = 'settled' and settled_amount > 0;
$$;

-- 5. Admin only: per campaign breakdown of the expected beneficiary share
--    by payout state. p_ids = NULL means every campaign.
create or replace function admin_payout_breakdown(p_ids bigint[])
returns table (
  fundraiser_id bigint,
  settled numeric,
  pending numeric,
  processing numeric,
  failed numeric,
  legacy_unconfirmed numeric
)
language sql
stable
as $$
  select
    d.fundraiser_id,
    coalesce(sum(d.settled_amount) filter (where d.payout_status = 'settled'), 0),
    coalesce(sum(d.settled_amount) filter (where d.payout_status = 'pending_payout'), 0),
    coalesce(sum(d.settled_amount) filter (where d.payout_status = 'processing'), 0),
    coalesce(sum(d.settled_amount) filter (where d.payout_status = 'failed'), 0),
    coalesce(sum(d.settled_amount) filter (where d.payout_legacy_unconfirmed and d.payout_status <> 'settled'), 0)
  from donations d
  where d.payout_status <> 'not_applicable'
    and d.settled_amount > 0
    and (p_ids is null or d.fundraiser_id = any(p_ids))
  group by d.fundraiser_id;
$$;

revoke all on function admin_overview_totals() from public, anon, authenticated;
revoke all on function admin_settled_for_campaigns(bigint[]) from public, anon, authenticated;
revoke all on function campaign_amount_settled(bigint) from public, anon, authenticated;
revoke all on function admin_payout_breakdown(bigint[]) from public, anon, authenticated;
grant execute on function admin_overview_totals() to service_role;
grant execute on function admin_settled_for_campaigns(bigint[]) to service_role;
grant execute on function campaign_amount_settled(bigint) to service_role;
grant execute on function admin_payout_breakdown(bigint[]) to service_role;

commit;

-- -------------------------------------------------------------------------
-- OPTIONAL read-only audit queries (safe to run any time):
--
--   -- Donations that used to be shown as "settled" and still need
--   -- confirmation from Paystack:
--   select id, paystack_reference, fundraiser_id, settled_amount, created_at
--   from donations where payout_legacy_unconfirmed and payout_status <> 'settled'
--   order by created_at;
--
--   -- Payout state summary:
--   select payout_status, count(*), sum(settled_amount) from donations group by 1;
-- -------------------------------------------------------------------------
