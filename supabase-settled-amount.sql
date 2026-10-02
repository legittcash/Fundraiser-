-- supabase-settled-amount.sql
--
-- SAFE, ADDITIVE migration for the public "Amount Settled" statistic.
-- Run this ONCE in the Supabase SQL Editor BEFORE deploying the updated
-- api/paystack-webhook.js (the webhook now sends p_settled_amount).
-- It is identical to the matching changes already folded into
-- supabase.sql (items 13b and the record_donation_and_update_totals
-- function), so use ONE of the two, not both... though running both is
-- harmless because every statement here can be run again.
--
-- This file does NOT delete, reset, or recreate any table, and it does
-- not touch existing rows: every existing donation keeps
-- settled_amount = 0, because the database holds no reliable figure for
-- what was settled historically, and none is invented.

begin;

alter table donations
  add column if not exists settled_amount numeric not null default 0;

-- The recording function gained one parameter, p_settled_amount.
-- Postgres treats a different parameter list as a different function,
-- so the previous 10 argument version is replaced (inside this same
-- transaction, so there is never a moment without a working function).
drop function if exists record_donation_and_update_totals(
  bigint, text, numeric, numeric, numeric, numeric, text, text, boolean, text
);

create or replace function record_donation_and_update_totals(
  p_fundraiser_id bigint,
  p_paystack_reference text,
  p_amount numeric,
  p_paystack_fee numeric,
  p_platform_fee numeric,
  p_net_amount numeric,
  p_donor_name text,
  p_donor_email text,
  p_anonymous boolean,
  p_settled_to_subaccount text,
  p_settled_amount numeric default 0
)
returns table (
  is_duplicate boolean,
  donation_id bigint,
  fundraiser_id bigint,
  raised_amount numeric,
  donor_count integer
)
language plpgsql
as $$
declare
  v_donation_id bigint;
  v_raised_amount numeric;
  v_donor_count integer;
begin
  if not exists (select 1 from fundraiser f where f.id = p_fundraiser_id) then
    raise exception 'Fundraiser % does not exist', p_fundraiser_id;
  end if;

  insert into donations (
    paystack_reference, amount, paystack_fee, platform_fee, net_amount,
    donor_name, donor_email, anonymous, fundraiser_id, settled_to_subaccount, settled_amount
  )
  values (
    p_paystack_reference, p_amount, p_paystack_fee, p_platform_fee, p_net_amount,
    p_donor_name, p_donor_email, p_anonymous, p_fundraiser_id, p_settled_to_subaccount,
    greatest(coalesce(p_settled_amount, 0), 0)
  )
  on conflict (paystack_reference) do nothing
  returning donations.id into v_donation_id;

  if v_donation_id is null then
    select f.raised_amount, f.donor_count into v_raised_amount, v_donor_count
    from fundraiser f where f.id = p_fundraiser_id;

    return query select true, null::bigint, p_fundraiser_id, v_raised_amount, v_donor_count;
    return;
  end if;

  update fundraiser
  set
    raised_amount = fundraiser.raised_amount + p_net_amount,
    donor_count = fundraiser.donor_count + 1,
    updated_at = now()
  where fundraiser.id = p_fundraiser_id
  returning fundraiser.raised_amount, fundraiser.donor_count
  into v_raised_amount, v_donor_count;

  return query select false, v_donation_id, p_fundraiser_id, v_raised_amount, v_donor_count;
end;
$$;

revoke all on function record_donation_and_update_totals(
  bigint, text, numeric, numeric, numeric, numeric, text, text, boolean, text, numeric
) from public;
revoke all on function record_donation_and_update_totals(
  bigint, text, numeric, numeric, numeric, numeric, text, text, boolean, text, numeric
) from anon;
revoke all on function record_donation_and_update_totals(
  bigint, text, numeric, numeric, numeric, numeric, text, text, boolean, text, numeric
) from authenticated;
grant execute on function record_donation_and_update_totals(
  bigint, text, numeric, numeric, numeric, numeric, text, text, boolean, text, numeric
) to service_role;

commit;
