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


// Diagnostics only report numbers Paystack actually sent; anything else is null.
function numberOrNull(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// Names (never values) of the fields Paystack sent on a transaction, so an
// unexpected shape can be diagnosed without exposing any data.
function shapeOf(tx) {
  const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).slice(0, 20) : null);
  return {
    subaccount_fields: keys(tx.subaccount),
    fees_split_type: tx.fees_split === null ? 'null' : Array.isArray(tx.fees_split) ? 'array' : typeof tx.fees_split,
    fees_split_fields: keys(tx.fees_split),
    has_split: Boolean(tx.split && typeof tx.split === 'object' && Object.keys(tx.split).length),
  };
}

// Names of the fields in a Paystack object (no values), for diagnostics.
function fieldNames(tx) {
  const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort().slice(0, 40) : null);
  return { transaction: keys(tx), subaccount: keys(tx && tx.subaccount), fees_split: keys(tx && tx.fees_split) };
}

const RANK = { processing: 1, failed: 2, settled: 3 };

// How many settlements are described in the diagnostics block returned to
// the admin page. Only ids, statuses, dates and counts are ever reported:
// nothing about bank accounts, donors or credentials.
const MAX_SETTLEMENTS_REPORTED = 20;

// Looks through the subaccount's Paystack settlements for the given
// donations. Read-only. `budget.left` caps how many Paystack calls this
// may make (a Worker request has a limited number of subrequests); if the
// cap is hit, `truncated` is true and the caller can simply run it again.
//
// The lookup runs in up to two passes over the SAME subaccount's settlement
// list, and the evidence rule is identical in both:
//   pass 1  settlements created from one day before the oldest donation
//   pass 2  only when some donations are still unmatched after pass 1:
//           the list again WITHOUT a start date, so a start-date quirk on
//           Paystack's side can never hide a settlement
// A settlement already opened in pass 1 is not opened again.
//
// The result also carries `diagnostics`, a plain description of what
// Paystack returned (how many settlements, their ids / statuses / dates,
// how many transactions were opened in each and how many of the donations
// being checked were found), so an empty result can be explained.
//
//   donations: [{ id, paystack_reference, payout_status, created_at }]
//   returns { ok, proposals, settlements_checked, settlements_listed,
//             truncated, diagnostics } | { ok:false, error }
export async function findPayoutEvidence(env, { subaccountId, subaccountCode = null, donations, budget }) {
  const wanted = new Map(); // reference -> donation
  let oldest = null;
  for (const d of donations) {
    if (!d.paystack_reference) continue;
    wanted.set(d.paystack_reference, d);
    const t = d.created_at ? Date.parse(d.created_at) : NaN;
    if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
  }
  if (wanted.size === 0) {
    return { ok: true, proposals: [], settlements_checked: 0, settlements_listed: 0, truncated: false, diagnostics: null };
  }

  // A settlement cannot predate the charge it contains; start a day early.
  const from = oldest !== null ? new Date(oldest - 24 * 3600 * 1000).toISOString().slice(0, 10) : undefined;

  const evidence = new Map(); // reference -> { status, settlement }
  const rows = new Map(); // settlement id -> what was seen (for diagnostics)
  const opened = new Set(); // settlement ids whose transactions were fully read
  const unrecognised = new Set();
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

  // One walk over the subaccount's settlement list (all pages).
  // Returns { listed: Set of settlement ids, error? }.
  async function scan(fromDate) {
    const listed = new Set();
    for (let page = 1; ; page++) {
      if (!spend()) break;
      const list = await listSettlements(env, { subaccountId, from: fromDate, page });
      if (!list.ok) return { listed, error: list.error };

      for (const s of list.data) {
        if (!s || s.id === undefined || s.id === null) continue;
        const key = String(s.id);
        listed.add(key);
        const target = payoutStatusFromSettlement(s.status);
        if (!rows.has(key)) {
          rows.set(key, {
            id: key,
            status: s.status === undefined || s.status === null ? null : String(s.status),
            settlement_date: s.settlement_date || s.updatedAt || null,
            recognised: Boolean(target),
            transactions_opened: 0,
            transactions_reported: null, // Paystack's own count (meta.total) for this settlement
            total_amount: numberOrNull(s.total_amount),
            effective_amount: numberOrNull(s.effective_amount),
            currency: typeof s.currency === 'string' ? s.currency : null,
            donations_found: new Set(),
            complete: false,
          });
        }
        if (!target) {
          unrecognised.add(String(s.status)); // unknown status: never guess
          continue;
        }
        if (opened.has(key)) continue; // already read in an earlier pass
        settlementsChecked += 1;

        const row = rows.get(key);
        let readAll = true;
        for (let tp = 1; ; tp++) {
          if (!spend()) {
            readAll = false;
            break;
          }
          const txs = await listSettlementTransactions(env, s.id, { page: tp });
          if (!txs.ok) return { listed, error: txs.error };
          if (tp === 1) row.transactions_reported = numberOrNull(txs.meta && txs.meta.total);
          for (const tx of txs.data) {
            row.transactions_opened += 1;
            const ref = tx && tx.reference;
            if (!ref || !wanted.has(ref)) continue;
            row.donations_found.add(ref);
            const prev = evidence.get(ref);
            if (!prev || RANK[target] > RANK[prev.status]) {
              evidence.set(ref, { status: target, settlement: s });
            }
          }
          const pageCount = Number(txs.meta.pageCount) || 1;
          if (tp >= pageCount) break;
        }
        if (readAll) {
          opened.add(key);
          row.complete = true;
        }
        if (truncated) break;
      }
      if (truncated) break;
      const pageCount = Number(list.meta.pageCount) || 1;
      if (page >= pageCount) break;
    }
    return { listed };
  }

  const first = await scan(from);
  if (first.error) return { ok: false, error: first.error };

  let fallback = { ran: false, settlements_listed: 0, additional_settlements: 0 };
  if (evidence.size < wanted.size && !truncated && from !== undefined) {
    const second = await scan(undefined);
    if (second.error) return { ok: false, error: second.error };
    let additional = 0;
    for (const id of second.listed) if (!first.listed.has(id)) additional += 1;
    fallback = { ran: true, settlements_listed: second.listed.size, additional_settlements: additional };
  }

  // Looking through the MAIN account's settlements (Paystack's documented
  // `subaccount=none`). Paystack support confirmed (Oct 2026) that a
  // transaction is listed inside the main account's settlement N, while the
  // subaccount's own payout (a separate settlement) returns an empty
  // transaction list. So a donation's reference is found in N, never in the
  // subaccount payout. No Paystack document links N to the payout, so a link
  // is accepted only when ALL of these hold (otherwise the donation stays
  // Pending payout and the reason is reported):
  //   1. the reference is listed in main settlement N (all of N was read);
  //   2. a settlement N+1 was listed by Paystack for THIS subaccount
  //      (the subaccount filter, not just an adjacent number);
  //   3. N+1's amount equals, to the kobo, the beneficiary share of the
  //      transactions in N: the sum of fees_split.subaccount of N's
  //      transactions that used this subaccount (Paystack's own figures), or,
  //      if Paystack's transaction items carry no subaccount details, the
  //      recorded settled_amount of the donations found in N (a coincidence
  //      is impossible if N also holds other donations to this subaccount:
  //      their share would make the sums differ, so it fails closed);
  //   4. N+1 has a status this platform recognises; its status is the one used.
  const mainAccount = { ran: false, settlements_listed: 0, settlements_opened: 0, found: [] };
  const matchesMine = (tx) => {
    const sub = tx && tx.subaccount;
    if (!sub || typeof sub !== 'object') return null; // Paystack gave no subaccount details
    const id = sub.id !== undefined && sub.id !== null ? String(sub.id) : null;
    const code = sub.subaccount_code || null;
    if (id === null && code === null) return null;
    return (id !== null && id === String(subaccountId)) || (code !== null && subaccountCode && code === subaccountCode);
  };
  if (evidence.size < wanted.size && !truncated) {
    mainAccount.ran = true;
    const missing = new Set([...wanted.keys()].filter((ref) => !evidence.has(ref)));
    scanMain: for (let page = 1; ; page++) {
      if (!spend()) break;
      const list = await listSettlements(env, { subaccountId: 'none', from, page });
      if (!list.ok) {
        mainAccount.error = list.error;
        break;
      }
      for (const s of list.data) {
        if (!s || s.id === undefined || s.id === null) continue;
        mainAccount.settlements_listed += 1;

        const all = []; // every transaction of this main settlement
        for (let tp = 1; ; tp++) {
          if (!spend()) break scanMain; // not fully read: never judge a partial settlement
          const txs = await listSettlementTransactions(env, s.id, { page: tp });
          if (!txs.ok) {
            mainAccount.error = txs.error;
            break scanMain;
          }
          all.push(...txs.data);
          if (tp >= (Number(txs.meta.pageCount) || 1)) break;
        }
        mainAccount.settlements_opened += 1;

        const hits = all.filter((tx) => tx && tx.reference && missing.has(tx.reference));
        if (hits.length) {
          const next = rows.get(String(Number(s.id) + 1)) || null;
          const mine = all.filter((tx) => matchesMine(tx) === true);
          const hitsKnown = hits.every((tx) => matchesMine(tx) !== null);
          let basis = null;
          let expected = null;
          let reason = null;
          if (hits.some((tx) => matchesMine(tx) === false)) {
            reason = 'a transaction in this main settlement used a different subaccount';
          } else {
            // Preferred: Paystack's own figures for the transactions that used this subaccount.
            if (hitsKnown) {
              const shares = mine.map((tx) => numberOrNull(tx.fees_split && tx.fees_split.subaccount));
              if (shares.length && shares.every((n) => n !== null)) {
                basis = 'paystack_transaction_split';
                expected = shares.reduce((a, b) => a + b, 0);
              }
            }
            // Otherwise: the share recorded for these donations when they were paid.
            if (expected === null && hitsKnown && mine.some((tx) => !missing.has(tx.reference))) {
              // Paystack names this subaccount on every transaction but gives no split figure, and N also holds
              // transactions of this subaccount that are not the donations being checked: their shares are unknown.
              reason = 'not every transaction of this subaccount in this main settlement is one of the donations being checked, so the beneficiary share cannot be totalled';
            } else if (expected === null) {
              const parts = hits.map((tx) => numberOrNull(wanted.get(tx.reference).settled_amount));
              if (parts.every((n) => n !== null && n > 0)) {
                basis = 'recorded_settled_amount';
                expected = Math.round(parts.reduce((a, b) => a + b, 0) * 100);
              }
            }
            if (expected === null && !reason) reason = 'neither Paystack nor the donation record gives the beneficiary share';
          }
          let confirmed = false;
          if (!reason && !next) reason = 'no settlement for this subaccount follows this main settlement';
          if (!reason && !next.recognised) reason = 'the subaccount settlement has a status this platform does not recognise';
          if (!reason && next.total_amount === null) reason = 'Paystack gave no amount for the subaccount settlement';
          if (!reason && next.total_amount !== expected) {
            reason = 'the subaccount settlement amount does not equal the beneficiary share of this main settlement';
          }
          if (!reason) confirmed = true;

          for (const tx of hits) {
            if (confirmed) {
              evidence.set(tx.reference, {
                status: payoutStatusFromSettlement(next.status),
                settlement: { id: next.id, status: next.status, settlement_date: next.settlement_date },
                via: 'paystack_main_settlement_pair',
                main_settlement_id: String(s.id),
              });
            }
            missing.delete(tx.reference);
            mainAccount.found.push({
              reference: tx.reference,
              settlement_id: String(s.id),
              status: s.status === undefined || s.status === null ? null : String(s.status),
              settlement_date: s.settlement_date || s.updatedAt || null,
              total_amount: numberOrNull(s.total_amount),
              next_subaccount_settlement: next
                ? { id: next.id, status: next.status, settlement_date: next.settlement_date, total_amount: next.total_amount, currency: next.currency }
                : null,
              link: {
                confirmed, basis, expected_amount: expected, reason,
                // Field NAMES Paystack sent for this transaction (never values), to explain a failed check.
                transaction_fields: confirmed ? null : fieldNames(tx),
              },
              shape: shapeOf(tx), // field NAMES only, to explain an unconfirmed link
            });
          }
        }
        if (missing.size === 0) break scanMain;
      }
      if (page >= (Number(list.meta.pageCount) || 1)) break;
    }
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
      via: ev.via || 'paystack_settlement_api',
      main_settlement_id: ev.main_settlement_id || null,
    });
  }

  const allRows = [...rows.values()];
  const diagnostics = {
    start_date: from || null,
    settlements_listed_with_start_date: first.listed.size,
    start_date_fallback: fallback,
    settlements_total: allRows.length,
    settlements: allRows.slice(0, MAX_SETTLEMENTS_REPORTED).map((r) => ({
      id: r.id,
      status: r.status,
      settlement_date: r.settlement_date,
      recognised: r.recognised,
      transactions_opened: r.transactions_opened,
      transactions_reported: r.transactions_reported,
      total_amount: r.total_amount,
      effective_amount: r.effective_amount,
      currency: r.currency,
      donations_found: r.donations_found.size,
      complete: r.complete,
    })),
    unrecognised_statuses: [...unrecognised],
    main_account: mainAccount,
  };

  return { ok: true, proposals, settlements_checked: settlementsChecked, settlements_listed: allRows.length, truncated, diagnostics };
}
