// lib/payout-status.js
//
// Payout (beneficiary settlement) status rules, kept separate from the
// donation PAYMENT status.
//
//   Payment status : did the donor's charge succeed?  (donations row exists
//                    only after a verified charge.success webhook)
//   Payout status  : has the beneficiary actually been paid?
//
// A successful charge, a created/verified subaccount, a calculated split
// (donations.settled_amount) or an expected payout date are NOT evidence of
// a payout. The only evidence this platform accepts is Paystack's own
// Settlement API: a settlement, listed for the beneficiary's subaccount,
// that CONTAINS the donation's transaction reference:
//
//   GET /settlement?subaccount=<id>            (settlements + their status)
//   GET /settlement/:id/transactions           (references inside one)
//
//   settlement status "success"               -> settled
//   settlement status "failed"                -> failed
//   settlement status "pending" | "processing"-> processing
//
// Paystack sends no webhook for settlements, and transfer.* events belong
// to the Transfers API (which this platform does not use), so webhooks are
// never used to mark a payout settled.

import { listSettlements, listSettlementTransactions } from './paystack.js';

export const PAYOUT_STATUSES = ['not_applicable', 'pending_payout', 'processing', 'settled', 'failed'];

// Paystack settlement status -> our payout status (null = unrecognised, ignored).
export function payoutStatusFromSettlement(settlementStatus) {
  switch (String(settlementStatus || '').toLowerCase()) {
    case 'success':
      return 'settled';
    case 'failed':
      return 'failed';
    case 'pending':
    case 'processing':
      return 'processing';
    default:
      return null;
  }
}

// Whether a donation currently in `current` may move to `target`.
// 'settled' is final and never downgraded; 'not_applicable' never changes.
export function canMovePayoutStatus(current, target) {
  if (current === target) return false;
  if (current === 'settled' || current === 'not_applicable') return false;
  if (target === 'settled') return true;
  if (target === 'failed') return current === 'pending_payout' || current === 'processing';
  if (target === 'processing') return current === 'pending_payout' || current === 'failed';
  return false;
}

const RANK = { processing: 1, failed: 2, settled: 3 };

// Looks through the subaccount's Paystack settlements for the given
// donations. Read-only. `budget.left` caps how many Paystack calls this
// may make (a Worker request has a limited number of subrequests); if the
// cap is hit, `truncated` is true and the caller can simply run it again.
//
//   donations: [{ id, paystack_reference, payout_status, created_at }]
//   returns { ok, proposals, settlements_checked, truncated } | { ok:false, error }
export async function findPayoutEvidence(env, { subaccountId, donations, budget }) {
  const wanted = new Map(); // reference -> donation
  let oldest = null;
  for (const d of donations) {
    if (!d.paystack_reference) continue;
    wanted.set(d.paystack_reference, d);
    const t = d.created_at ? Date.parse(d.created_at) : NaN;
    if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
  }
  if (wanted.size === 0) return { ok: true, proposals: [], settlements_checked: 0, truncated: false };

  // A settlement cannot predate the charge it contains; start a day early.
  const from = oldest !== null ? new Date(oldest - 24 * 3600 * 1000).toISOString().slice(0, 10) : undefined;

  const evidence = new Map(); // reference -> { status, settlement }
  let truncated = false;
  let settlementsChecked = 0;

  const spend = () => {
    if (budget.left <= 0) {
      truncated = true;
      return false;
    }
    budget.left -= 1;
    return true;
  };

  for (let page = 1; ; page++) {
    if (!spend()) break;
    const list = await listSettlements(env, { subaccountId, from, page });
    if (!list.ok) return { ok: false, error: list.error };

    for (const s of list.data) {
      const target = payoutStatusFromSettlement(s.status);
      if (!target) continue; // unknown status: never guess
      settlementsChecked += 1;

      for (let tp = 1; ; tp++) {
        if (!spend()) break;
        const txs = await listSettlementTransactions(env, s.id, { page: tp });
        if (!txs.ok) return { ok: false, error: txs.error };
        for (const tx of txs.data) {
          const ref = tx && tx.reference;
          if (!ref || !wanted.has(ref)) continue;
          const prev = evidence.get(ref);
          if (!prev || RANK[target] > RANK[prev.status]) {
            evidence.set(ref, { status: target, settlement: s });
          }
        }
        const pageCount = Number(txs.meta.pageCount) || 1;
        if (tp >= pageCount) break;
      }
      if (truncated) break;
    }
    if (truncated) break;
    const pageCount = Number(list.meta.pageCount) || 1;
    if (page >= pageCount) break;
  }

  const proposals = [];
  for (const [ref, ev] of evidence) {
    const d = wanted.get(ref);
    if (!canMovePayoutStatus(d.payout_status, ev.status)) continue;
    proposals.push({
      id: d.id,
      reference: ref,
      from: d.payout_status,
      to: ev.status,
      settlement_id: String(ev.settlement.id),
      settlement_status: ev.settlement.status,
      settlement_date: ev.settlement.settlement_date || ev.settlement.updatedAt || null,
    });
  }
  return { ok: true, proposals, settlements_checked: settlementsChecked, truncated };
}
