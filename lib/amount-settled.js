// lib/amount-settled.js
//
// Single shared implementation of the public "Amount Settled" figure,
// used by BOTH public campaign endpoints (api/campaign.js and
// api/progress.js) so there is exactly one definition of it.
//
//   Amount Settled = SUM(donations.settled_amount) for one campaign
//
// donations.settled_amount is written once per donation by the Paystack
// webhook (see api/paystack-webhook.js) from Paystack's own reported
// subaccount share. This helper only ever reads that single column,
// filtered to ONE campaign, and returns ONE number. It never reads or
// returns any beneficiary, bank, subaccount, or per donation detail.
//
// Rows are read in pages of 1000 (PostgREST's default maximum) so a
// campaign with many donations is still summed in full. The sum is
// done in whole kobo to avoid floating point drift, then converted
// back to naira.
//
// Returns a number (0 when nothing has been settled), or null if the
// lookup could not be completed (for example the settled_amount column
// has not been added yet). Callers treat null as "unknown" and simply
// leave the figure out, instead of showing a misleading 0.

import { callRpc } from './supabase-paging.js';

export async function getAmountSettled(supabaseUrl, headers, fundraiserId) {
  // Fast path: let the database add it up (campaign_amount_settled, from
  // supabase-scale-upgrade.sql). Same sum, one small request, so a very
  // popular campaign is not re-read row by row on every page view. If the
  // function does not exist yet, fall through to the row by row method.
  const rpc = await callRpc(supabaseUrl, headers, 'campaign_amount_settled', {
    p_fundraiser_id: Number(fundraiserId),
  });
  if (rpc.ok && rpc.data !== null && rpc.data !== undefined && Number.isFinite(Number(rpc.data))) {
    return Number(rpc.data);
  }

  try {
    const PAGE = 1000;
    const MAX_PAGES = 200; // safety stop: 200,000 donations per campaign
    let totalKobo = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/donations?select=settled_amount` +
          `&fundraiser_id=eq.${encodeURIComponent(fundraiserId)}` +
          `&order=id.asc&limit=${PAGE}&offset=${page * PAGE}`,
        { headers }
      );
      if (!res.ok) {
        console.warn('Could not read settled amounts:', await res.text());
        return null;
      }
      const rows = await res.json();
      for (const row of rows) {
        const n = Number(row.settled_amount);
        if (Number.isFinite(n) && n > 0) totalKobo += Math.round(n * 100);
      }
      if (rows.length < PAGE) return totalKobo / 100;
    }
    return null; // hit the safety stop; do not show a partial figure
  } catch (err) {
    console.warn('Could not calculate amount settled.', err);
    return null;
  }
}

// ---------------------------------------------------------------------
// ADMIN ONLY: Amount Settled for a SMALL set of campaigns (the ones on
// the current admin page). Returns { [fundraiser_id]: nairaTotal } or
// null if it could not be read. Uses admin_settled_for_campaigns
// (supabase-scale-upgrade.sql) when it exists, otherwise sums the
// matching donation rows (an index on fundraiser_id keeps that quick).
export async function getSettledForCampaigns(supabaseUrl, headers, ids) {
  const cleanIds = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n)))];
  if (cleanIds.length === 0) return {};

  const rpc = await callRpc(supabaseUrl, headers, 'admin_settled_for_campaigns', { p_ids: cleanIds });
  if (rpc.ok && Array.isArray(rpc.data)) {
    return Object.fromEntries(rpc.data.map((r) => [r.fundraiser_id, Number(r.settled) || 0]));
  }

  try {
    const PAGE = 1000;
    const MAX_PAGES = 500;
    const kobo = {};
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/donations?select=fundraiser_id,settled_amount` +
          `&settled_amount=gt.0&fundraiser_id=in.(${cleanIds.join(',')})` +
          `&order=id.asc&limit=${PAGE}&offset=${page * PAGE}`,
        { headers }
      );
      if (!res.ok) {
        console.warn('Could not read settled amounts for admin page:', await res.text());
        return null;
      }
      const rows = await res.json();
      for (const row of rows) {
        const k = Math.round((Number(row.settled_amount) || 0) * 100);
        if (k > 0) kobo[row.fundraiser_id] = (kobo[row.fundraiser_id] || 0) + k;
      }
      if (rows.length < PAGE) {
        return Object.fromEntries(Object.entries(kobo).map(([id, k]) => [id, k / 100]));
      }
    }
    return null;
  } catch (err) {
    console.warn('Could not calculate settled amounts for admin page.', err);
    return null;
  }
}

// ---------------------------------------------------------------------
// ADMIN ONLY: settled totals for ALL campaigns in one pass, used by the
// admin dashboard (api/admin/campaigns.js) for the Overview total and
// the per campaign column. It uses the very same source as the public
// figure above (donations.settled_amount) and only reads rows where
// settled_amount > 0, so it stays small. Returns
//   { byCampaign: { [fundraiser_id]: nairaTotal }, total: nairaTotal }
// or null if the lookup could not be completed, in which case the
// dashboard just leaves the new figures blank and everything else
// keeps working. Summed in whole kobo to avoid floating point drift.
// This is never imported by any public endpoint.
export async function getSettledTotalsByCampaign(supabaseUrl, headers) {
  try {
    const PAGE = 1000;
    const MAX_PAGES = 500;
    const kobo = {};
    let totalKobo = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/donations?select=fundraiser_id,settled_amount` +
          `&settled_amount=gt.0&order=id.asc&limit=${PAGE}&offset=${page * PAGE}`,
        { headers }
      );
      if (!res.ok) {
        console.warn('Could not read settled amounts for admin:', await res.text());
        return null;
      }
      const rows = await res.json();
      for (const row of rows) {
        const k = Math.round((Number(row.settled_amount) || 0) * 100);
        if (k > 0 && row.fundraiser_id != null) {
          kobo[row.fundraiser_id] = (kobo[row.fundraiser_id] || 0) + k;
          totalKobo += k;
        }
      }
      if (rows.length < PAGE) {
        const byCampaign = Object.fromEntries(Object.entries(kobo).map(([id, k]) => [id, k / 100]));
        return { byCampaign, total: totalKobo / 100 };
      }
    }
    return null;
  } catch (err) {
    console.warn('Could not calculate admin settled totals.', err);
    return null;
  }
}
