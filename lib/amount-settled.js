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

export async function getAmountSettled(supabaseUrl, headers, fundraiserId) {
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
