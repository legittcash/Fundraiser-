// api/admin/beneficiaries.js
//
// Combines what used to be FIVE separate files — api/admin/beneficiaries.js
// (base CRUD), api/admin/banks.js, api/admin/verify-beneficiary.js,
// api/admin/settlement.js, and api/admin/platform-fee.js — into one,
// routed by a `route` query parameter. This exists purely to reduce the
// total number of Vercel Serverless Functions (Vercel's Hobby plan caps
// a deployment at 12); the actual LOGIC in each section below is
// unchanged from those original files, just combined into one file.
//
//   GET  /api/admin/beneficiaries?fundraiser_id=123   -> one campaign's full beneficiary detail
//   GET  /api/admin/beneficiaries?all=1                -> masked summary for every campaign
//   POST /api/admin/beneficiaries                      -> create/update beneficiary base info
//   GET  /api/admin/beneficiaries?route=banks           -> list Nigerian banks (from Paystack) — PUBLIC, see below
//   POST /api/admin/beneficiaries?route=verify           { fundraiser_id } -> verify + create subaccount
//   POST /api/admin/beneficiaries?route=settlement        { fundraiser_id, action } -> enable/pause the automatic split (NOT a payout)
//   POST /api/admin/beneficiaries?route=paystack-status   { fundraiser_id } -> re-read the subaccount's is_verified/active from Paystack (read-only)
//   POST /api/admin/beneficiaries?route=reconcile-payouts { fundraiser_id, apply } -> compare donations with Paystack settlements (preview, or apply)
//   GET  /api/admin/beneficiaries?route=platform-fee     -> read the platform fee master switch
//   POST /api/admin/beneficiaries?route=platform-fee      { enabled } -> set the platform fee master switch
//
// IMPORTANT: ?route=banks is the one exception to "everything here
// requires an admin session". A list of Nigerian bank names/codes is
// just Paystack's own public reference data — it doesn't reveal
// anything about any campaign, donor, or beneficiary — so it's exposed
// without authentication. This lets the public visitor campaign
// submission form (submit-campaign.html) reuse this exact same
// endpoint for its own bank-search field, rather than a second,
// duplicate bank-listing endpoint being created. Every other route on
// this file still requires a valid admin session.
//
// Every campaign has AT MOST one beneficiary row, enforced by the
// unique constraint on beneficiaries.fundraiser_id. Note that the
// `route=settlement` action's own body already has a field called
// "action" (enable/pause) — this is a DIFFERENT thing from the `route`
// query parameter used to select which section of this file handles the
// request, so there's no naming collision between them.

import { rejectIfNotAdmin } from '../../lib/admin-auth.js';
import { listNigerianBanks, resolveAccountNumber, createSubaccount, fetchSubaccount } from '../../lib/paystack.js';
import { findPayoutEvidence } from '../../lib/payout-evidence.js';
import { fetchAllRows } from '../../lib/supabase-paging.js';
import { jsonResponse } from '../../lib/http.js';

const PLATFORM_FEE_RATE_PERCENT = 1;
const PLATFORM_FEE_CAP_NAIRA = 1000;

function getSupabaseConfig(env) {
  const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  return { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
}

function supabaseHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}


// Saves what PAYSTACK reports about a subaccount (id, is_verified, active)
// on the beneficiary row. This is deliberately separate from KODEP's own
// verification_status: a local "verified" never implies Paystack verified
// the subaccount. Best effort - if the payout-status migration has not been
// run yet the write is skipped and the main flow is unaffected.
async function savePaystackStatus(env, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }, fundraiserId, subaccountCode, known) {
  let status = known && known.id != null && typeof known.is_verified === 'boolean' && typeof known.active === 'boolean' ? known : null;
  let fetchError = null;
  if (!status) {
    const fetched = await fetchSubaccount(env, subaccountCode);
    if (fetched.ok) status = fetched.data;
    else fetchError = fetched.error;
  }
  if (!status) return { ok: false, error: fetchError || 'Could not read the Paystack subaccount.' };

  const fields = {
    paystack_subaccount_id: status.id ?? null,
    paystack_is_verified: typeof status.is_verified === 'boolean' ? status.is_verified : null,
    paystack_active: typeof status.active === 'boolean' ? status.active : null,
    paystack_status_checked_at: new Date().toISOString(),
  };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}`, {
      method: 'PATCH',
      headers: supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY),
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      console.warn('Could not save Paystack subaccount status (has supabase-payout-status.sql been run?):', await res.text());
      return { ok: false, error: 'Could not save the Paystack status. Run supabase-payout-status.sql in Supabase first.' };
    }
  } catch (err) {
    console.warn('Could not save Paystack subaccount status:', err);
    return { ok: false, error: 'Could not save the Paystack status.' };
  }
  return { ok: true, fields };
}

// "0123456789" -> "••••6789". Never reveals more than the last 4 digits.
function maskAccountNumber(accountNumber) {
  if (!accountNumber) return null;
  const str = String(accountNumber);
  if (str.length <= 4) return '••••';
  return `••••${str.slice(-4)}`;
}

// =========================================================================
// route=banks — from the original api/admin/banks.js
// =========================================================================
async function handleBanks(req, env) {
  if (req.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  }
  const result = await listNigerianBanks(env);
  if (!result.ok) {
    return jsonResponse(502, { error: result.error });
  }
  return jsonResponse(200, { banks: result.data });
}

// =========================================================================
// route=verify — from the original api/admin/verify-beneficiary.js
// =========================================================================
async function handleVerify(req, env, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }) {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }
  if (!env.PAYSTACK_SECRET_KEY) {
    return jsonResponse(500, { error: 'Server is missing PAYSTACK_SECRET_KEY.' });
  }

  const headers = supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY);
  const fundraiserId = (req.body || {}).fundraiser_id;
  if (!fundraiserId) {
    return jsonResponse(400, { error: 'fundraiser_id is required.' });
  }

  try {
    const beneficiaryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}&select=*&limit=1`,
      { headers }
    );
    if (!beneficiaryRes.ok) {
      console.error('Supabase error:', await beneficiaryRes.text());
      return jsonResponse(500, { error: 'Failed to load beneficiary.' });
    }
    const rows = await beneficiaryRes.json();
    const beneficiary = rows[0];
    if (!beneficiary) {
      return jsonResponse(404, { error: 'No beneficiary is on file for this campaign yet. Add one first.' });
    }
    if (!beneficiary.bank_code || !beneficiary.account_number) {
      return jsonResponse(400, { error: 'Beneficiary is missing a bank or account number.' });
    }

    // ---- STEP 1: Resolve/verify the account number with Paystack ----
    const resolveResult = await resolveAccountNumber(env, beneficiary.account_number, beneficiary.bank_code);

    if (!resolveResult.ok) {
      // Mark verification as failed so the admin sees an honest status,
      // rather than leaving it silently "pending" forever.
      await fetch(`${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ verification_status: 'failed', updated_at: new Date().toISOString() }),
      });
      return jsonResponse(422, { error: `Account verification failed: ${resolveResult.error}` });
    }

    // ---- STEP 2: Create the Paystack subaccount, if one doesn't exist ----
    let subaccountCode = beneficiary.paystack_subaccount_code;
    let createdSubaccountStatus = null;
    if (!subaccountCode) {
      const subaccountResult = await createSubaccount(env, {
        businessName: beneficiary.beneficiary_name,
        bankCode: beneficiary.bank_code,
        accountNumber: beneficiary.account_number,
        percentageCharge: Number(beneficiary.settlement_percentage) || 0,
        primaryContactPhone: beneficiary.primary_phone_number,
      });

      if (!subaccountResult.ok) {
        await fetch(`${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ verification_status: 'failed', updated_at: new Date().toISOString() }),
        });
        return jsonResponse(502, { error: `Could not set up settlement: ${subaccountResult.error}` });
      }

      subaccountCode = subaccountResult.data.subaccount_code;
      createdSubaccountStatus = {
        id: subaccountResult.data.id,
        is_verified: subaccountResult.data.is_verified,
        active: subaccountResult.data.active,
      };
    }

    // ---- STEP 3: Mark verified (settlement stays OFF until an admin
    // explicitly enables it in a separate step) ----
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}`,
      {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          verification_status: 'verified',
          account_name: resolveResult.data.account_name,
          paystack_subaccount_code: subaccountCode,
          verified_at: new Date().toISOString(),
          verified_by: env.ADMIN_USERNAME || 'admin',
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!updateRes.ok) {
      console.error('Supabase error:', await updateRes.text());
      return jsonResponse(500, { error: 'Verification succeeded with Paystack, but saving the result failed. Please try again.' });
    }

    const updated = await updateRes.json();

    // KODEP's verification above only means the bank account resolved and a
    // subaccount exists. Paystack has its OWN verification of the subaccount
    // (is_verified) which this platform cannot set - Paystack documents no
    // API for it. Record what Paystack reports, and never assume it.
    const paystackStatus = await savePaystackStatus(env, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }, fundraiserId, subaccountCode, createdSubaccountStatus);
    const beneficiaryOut = paystackStatus.ok ? { ...updated[0], ...paystackStatus.fields } : updated[0];
    return jsonResponse(200, { beneficiary: beneficiaryOut });
  } catch (err) {
    console.error('Unexpected error verifying beneficiary:', err);
    return jsonResponse(500, { error: 'Unexpected server error.' });
  }
}

// =========================================================================
// route=settlement — from the original api/admin/settlement.js
// =========================================================================
async function handleSettlement(req, env, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }) {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }

  const { fundraiser_id: fundraiserId, action } = req.body || {};
  if (!fundraiserId || !['enable', 'pause'].includes(action)) {
    return jsonResponse(400, { error: 'fundraiser_id and a valid action ("enable" or "pause") are required.' });
  }

  const headers = supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY);

  try {
    const beneficiaryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}&select=*&limit=1`,
      { headers }
    );
    if (!beneficiaryRes.ok) {
      console.error('Supabase error:', await beneficiaryRes.text());
      return jsonResponse(500, { error: 'Failed to load beneficiary.' });
    }
    const rows = await beneficiaryRes.json();
    const beneficiary = rows[0];
    if (!beneficiary) {
      return jsonResponse(404, { error: 'No beneficiary is on file for this campaign yet.' });
    }

    if (action === 'enable') {
      if (beneficiary.verification_status !== 'verified' || !beneficiary.paystack_subaccount_code) {
        return jsonResponse(400, {
          error: 'This beneficiary must be successfully verified before settlement can be enabled.',
        });
      }
    }

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}`,
      {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          settlement_enabled: action === 'enable',
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!response.ok) {
      console.error('Supabase error:', await response.text());
      return jsonResponse(500, { error: 'Failed to update settlement status.' });
    }

    const updated = await response.json();
    return jsonResponse(200, { beneficiary: updated[0] });
  } catch (err) {
    console.error('Unexpected error updating settlement:', err);
    return jsonResponse(500, { error: 'Unexpected server error.' });
  }
}


// =========================================================================
// route=paystack-status - read-only refresh of Paystack's own view of the
// subaccount (is_verified / active). Changes nothing on Paystack.
// =========================================================================
async function loadBeneficiary(config, fundraiserId) {
  const res = await fetch(
    `${config.SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}&select=*&limit=1`,
    { headers: supabaseHeaders(config.SUPABASE_SERVICE_ROLE_KEY) }
  );
  if (!res.ok) {
    console.error('Supabase error:', await res.text());
    return { error: jsonResponse(500, { error: 'Failed to load beneficiary.' }) };
  }
  const rows = await res.json();
  if (!rows[0]) return { error: jsonResponse(404, { error: 'No beneficiary is on file for this campaign yet.' }) };
  return { beneficiary: rows[0] };
}

async function handlePaystackStatus(req, env, config) {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }
  if (!env.PAYSTACK_SECRET_KEY) return jsonResponse(500, { error: 'Server is missing PAYSTACK_SECRET_KEY.' });
  const fundraiserId = (req.body || {}).fundraiser_id;
  if (!fundraiserId) return jsonResponse(400, { error: 'fundraiser_id is required.' });

  try {
    const loaded = await loadBeneficiary(config, fundraiserId);
    if (loaded.error) return loaded.error;
    const code = loaded.beneficiary.paystack_subaccount_code;
    if (!code) return jsonResponse(400, { error: 'This beneficiary has no Paystack subaccount yet. Use "Verify with Paystack" first.' });

    const saved = await savePaystackStatus(env, config, fundraiserId, code, null);
    if (!saved.ok) return jsonResponse(502, { error: saved.error });
    return jsonResponse(200, { beneficiary: { ...loaded.beneficiary, ...saved.fields } });
  } catch (err) {
    console.error('Unexpected error reading Paystack subaccount status:', err);
    return jsonResponse(500, { error: 'Unexpected server error.' });
  }
}

// =========================================================================
// route=reconcile-payouts - the ONLY place a donation's payout status can
// move to processing / settled / failed. Evidence = Paystack's Settlement
// API for this beneficiary's subaccount (see lib/payout-status.js).
//
//   { fundraiser_id }                 -> preview: lists what WOULD change
//   { fundraiser_id, apply: true }    -> applies exactly those changes
//
// Idempotent: a donation already 'settled' is never changed, and every
// update is conditional on the donation still being in an earlier state.
// =========================================================================
const PAYSTACK_CALL_BUDGET = 24; // Workers cap subrequests per request
const MAX_CANDIDATES = 1000;
const FROM_STATES_FOR = {
  settled: ['pending_payout', 'processing', 'failed'],
  processing: ['pending_payout', 'failed'],
  failed: ['pending_payout', 'processing'],
};

async function handleReconcilePayouts(req, env, config) {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }
  if (!env.PAYSTACK_SECRET_KEY) return jsonResponse(500, { error: 'Server is missing PAYSTACK_SECRET_KEY.' });
  const body = req.body || {};
  const fundraiserId = body.fundraiser_id;
  const apply = body.apply === true;
  if (!fundraiserId) return jsonResponse(400, { error: 'fundraiser_id is required.' });

  const headers = supabaseHeaders(config.SUPABASE_SERVICE_ROLE_KEY);
  try {
    const loaded = await loadBeneficiary(config, fundraiserId);
    if (loaded.error) return loaded.error;
    let beneficiary = loaded.beneficiary;
    const code = beneficiary.paystack_subaccount_code;
    if (!code) return jsonResponse(400, { error: 'This beneficiary has no Paystack subaccount yet.' });

    // The Settlement API filters by subaccount ID (not the ACCT_ code).
    if (!beneficiary.paystack_subaccount_id) {
      const saved = await savePaystackStatus(env, config, fundraiserId, code, null);
      if (!saved.ok) return jsonResponse(502, { error: saved.error });
      beneficiary = { ...beneficiary, ...saved.fields };
    }

    const candRes = await fetch(
      `${config.SUPABASE_URL}/rest/v1/donations?select=id,paystack_reference,payout_status,created_at` +
        `&fundraiser_id=eq.${encodeURIComponent(fundraiserId)}` +
        `&settled_to_subaccount=eq.${encodeURIComponent(code)}` +
        `&payout_status=in.(pending_payout,processing,failed)&order=created_at.asc&limit=${MAX_CANDIDATES}`,
      { headers }
    );
    if (!candRes.ok) {
      console.error('Supabase error loading donations for payout check:', await candRes.text());
      return jsonResponse(500, { error: 'Could not load donations. Has supabase-payout-status.sql been run?' });
    }
    const candidates = await candRes.json();

    const budget = { left: PAYSTACK_CALL_BUDGET };
    const found = await findPayoutEvidence(env, { subaccountId: beneficiary.paystack_subaccount_id, donations: candidates, budget });
    if (!found.ok) return jsonResponse(502, { error: `Paystack settlement lookup failed: ${found.error}` });

    const counts = { settled: 0, processing: 0, failed: 0 };
    for (const p of found.proposals) counts[p.to] += 1;

    const result = {
      mode: apply ? 'applied' : 'preview',
      donations_checked: candidates.length,
      settlements_checked: found.settlements_checked,
      truncated: found.truncated,
      will_change: counts,
      unmatched: candidates.length - found.proposals.length,
      changes: found.proposals.slice(0, 50).map((p) => ({
        reference: p.reference, from: p.from, to: p.to, settlement_id: p.settlement_id, settlement_status: p.settlement_status,
      })),
    };

    if (!apply) return jsonResponse(200, result);

    // Apply: one conditional PATCH per (target status, settlement).
    const groups = new Map();
    for (const p of found.proposals) {
      const key = `${p.to}|${p.settlement_id}|${p.settlement_date || ''}`;
      if (!groups.has(key)) groups.set(key, { to: p.to, settlement_id: p.settlement_id, date: p.settlement_date, ids: [] });
      groups.get(key).ids.push(p.id);
    }
    let applied = 0;
    let skippedForBudget = 0;
    const nowIso = new Date().toISOString();
    for (const g of groups.values()) {
      for (let i = 0; i < g.ids.length; i += 100) {
        if (budget.left <= 0) {
          skippedForBudget += g.ids.length - i;
          break;
        }
        budget.left -= 1;
        const chunk = g.ids.slice(i, i + 100);
        const res = await fetch(
          `${config.SUPABASE_URL}/rest/v1/donations?id=in.(${chunk.join(',')})&payout_status=in.(${FROM_STATES_FOR[g.to].join(',')})`,
          {
            method: 'PATCH',
            headers: { ...headers, Prefer: 'return=representation' },
            body: JSON.stringify({
              payout_status: g.to,
              payout_status_updated_at: nowIso,
              payout_settlement_id: g.settlement_id,
              payout_settlement_date: g.date,
              payout_confirmed_via: 'paystack_settlement_api',
            }),
          }
        );
        if (!res.ok) {
          console.error('Supabase error applying payout status:', await res.text());
          return jsonResponse(500, { error: 'Could not save payout statuses.', applied });
        }
        applied += (await res.json()).length;
      }
    }
    return jsonResponse(200, { ...result, applied, truncated: result.truncated || skippedForBudget > 0 });
  } catch (err) {
    console.error('Unexpected error reconciling payouts:', err);
    return jsonResponse(500, { error: 'Unexpected server error.' });
  }
}

// =========================================================================
// route=platform-fee — from the original api/admin/platform-fee.js
// =========================================================================
async function handlePlatformFee(req, env, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }) {
  const headers = supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (req.method === 'GET') {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/platform_settings?select=platform_fee_enabled,updated_at,updated_by&limit=1`, {
        headers,
      });
      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        return jsonResponse(500, { error: 'Failed to load platform fee setting.' });
      }
      const rows = await response.json();
      const row = rows[0];
      return jsonResponse(200, {
        enabled: row?.platform_fee_enabled === true,
        rate_percent: PLATFORM_FEE_RATE_PERCENT,
        cap_naira: PLATFORM_FEE_CAP_NAIRA,
        updated_at: row?.updated_at || null,
        updated_by: row?.updated_by || null,
      });
    }

    if (req.method === 'POST') {
      const enabled = (req.body || {}).enabled === true;

      const existingRes = await fetch(`${SUPABASE_URL}/rest/v1/platform_settings?select=id&limit=1`, { headers });
      const existingRows = existingRes.ok ? await existingRes.json() : [];
      const existingId = existingRows[0]?.id;

      if (!existingId) {
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/platform_settings`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify({
            platform_fee_enabled: enabled,
            updated_by: env.ADMIN_USERNAME || 'admin',
            updated_at: new Date().toISOString(),
          }),
        });
        if (!insertRes.ok) {
          console.error('Supabase error:', await insertRes.text());
          return jsonResponse(500, { error: 'Failed to save platform fee setting.' });
        }
        const inserted = await insertRes.json();
        return jsonResponse(200, {
          enabled: inserted[0].platform_fee_enabled,
          rate_percent: PLATFORM_FEE_RATE_PERCENT,
          cap_naira: PLATFORM_FEE_CAP_NAIRA,
        });
      }

      const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/platform_settings?id=eq.${existingId}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          platform_fee_enabled: enabled,
          updated_by: env.ADMIN_USERNAME || 'admin',
          updated_at: new Date().toISOString(),
        }),
      });
      if (!updateRes.ok) {
        console.error('Supabase error:', await updateRes.text());
        return jsonResponse(500, { error: 'Failed to save platform fee setting.' });
      }
      const updated = await updateRes.json();
      return jsonResponse(200, {
        enabled: updated[0].platform_fee_enabled,
        rate_percent: PLATFORM_FEE_RATE_PERCENT,
        cap_naira: PLATFORM_FEE_CAP_NAIRA,
      });
    }

    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
  } catch (err) {
    console.error('Unexpected error with platform fee setting:', err);
    return jsonResponse(500, { error: 'Unexpected server error.' });
  }
}

// =========================================================================
// Default (no ?route=) — from the original api/admin/beneficiaries.js
// base CRUD: view (full or masked-summary) and save beneficiary details
// =========================================================================
async function handleBeneficiaryCrud(req, env, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }) {
  const headers = supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (req.method === 'GET') {
      if (req.query.all) {
        // Optional ?ids=1,2,3 limits the summaries to those campaigns (the
        // admin dashboard only needs the ones currently on screen, which
        // keeps this response small with very many campaigns). Without
        // ids, every beneficiary is returned, as before.
        let idFilter = '';
        if (req.query.ids !== undefined) {
          const rawIds = String(req.query.ids);
          if (!/^\d+(,\d+)*$/.test(rawIds) || rawIds.split(',').length > 200) {
            return jsonResponse(400, { error: 'ids must be up to 200 comma separated campaign ids.' });
          }
          idFilter = `&fundraiser_id=in.(${rawIds})`;
        }

        // Paged so every beneficiary is included beyond Supabase's
        // default 1000 row response limit.
        // paystack_is_verified exists only after supabase-payout-status.sql;
        // fall back to the original column list so the dashboard keeps
        // working either way.
        const baseCols = 'fundraiser_id,beneficiary_name,bank_name,account_number,verification_status,settlement_enabled,paystack_subaccount_code';
        let allResult = await fetchAllRows(
          `${SUPABASE_URL}/rest/v1/beneficiaries?select=${baseCols},paystack_is_verified${idFilter}`,
          headers,
          'id.asc'
        );
        if (!allResult.ok) {
          allResult = await fetchAllRows(`${SUPABASE_URL}/rest/v1/beneficiaries?select=${baseCols}${idFilter}`, headers, 'id.asc');
        }
        if (!allResult.ok) {
          console.error('Supabase error:', allResult.errorText);
          return jsonResponse(500, { error: 'Failed to load beneficiary summaries.' });
        }
        const rows = allResult.rows;
        const summaries = rows.map((r) => ({
          fundraiser_id: r.fundraiser_id,
          beneficiary_name: r.beneficiary_name,
          bank_name: r.bank_name,
          account_number_masked: maskAccountNumber(r.account_number),
          verification_status: r.verification_status,
          settlement_enabled: r.settlement_enabled,
          has_subaccount: Boolean(r.paystack_subaccount_code),
          // Paystack's own flag; null = not checked yet. Never inferred from verification_status.
          paystack_is_verified: typeof r.paystack_is_verified === 'boolean' ? r.paystack_is_verified : null,
        }));
        return jsonResponse(200, { beneficiaries: summaries });
      }

      const fundraiserId = req.query.fundraiser_id;
      if (!fundraiserId) {
        return jsonResponse(400, { error: 'A fundraiser_id or ?all=1 is required.' });
      }

      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}&select=*&limit=1`,
        { headers }
      );
      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        return jsonResponse(500, { error: 'Failed to load beneficiary.' });
      }
      const rows = await response.json();
      return jsonResponse(200, { beneficiary: rows[0] || null });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const fundraiserId = body.fundraiser_id;
      const beneficiaryName = (body.beneficiary_name || '').trim();

      if (!fundraiserId) return jsonResponse(400, { error: 'fundraiser_id is required.' });
      if (!beneficiaryName) return jsonResponse(400, { error: 'Beneficiary name is required.' });
      if (!body.bank_code || !body.account_number) {
        return jsonResponse(400, { error: 'Bank and account number are required.' });
      }

      const existingRes = await fetch(
        `${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}&select=*&limit=1`,
        { headers }
      );
      const existingRows = existingRes.ok ? await existingRes.json() : [];
      const existing = existingRows[0] || null;

      const bankDetailsChanged =
        existing && (existing.bank_code !== body.bank_code || existing.account_number !== body.account_number);

      const payload = {
        fundraiser_id: fundraiserId,
        beneficiary_name: beneficiaryName,
        bank_name: body.bank_name || null,
        bank_code: body.bank_code,
        account_number: String(body.account_number),
        primary_phone_number: body.primary_phone_number || null,
        secondary_phone_number: body.secondary_phone_number || null,
        settlement_percentage: Number(body.settlement_percentage) || 0,
        updated_at: new Date().toISOString(),
      };

      // Changing the bank details on an existing, already-processed
      // beneficiary resets verification/settlement — a beneficiary can
      // never silently keep "Verified" / "Settlement Enabled" status
      // after its underlying bank account changes.
      if (!existing || bankDetailsChanged) {
        payload.verification_status = 'pending';
        payload.settlement_enabled = false;
        payload.paystack_subaccount_code = null;
        payload.account_name = null;
        payload.verified_at = null;
        payload.verified_by = null;
      }

      let response;
      if (existing) {
        response = await fetch(
          `${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}`,
          {
            method: 'PATCH',
            headers: supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY, { Prefer: 'return=representation' }),
            body: JSON.stringify(payload),
          }
        );
      } else {
        response = await fetch(`${SUPABASE_URL}/rest/v1/beneficiaries`, {
          method: 'POST',
          headers: supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY, { Prefer: 'return=representation' }),
          body: JSON.stringify(payload),
        });
      }

      if (!response.ok) {
        const errText = await response.text();
        console.error('Supabase error:', errText);
        return jsonResponse(500, { error: 'Failed to save beneficiary.', details: errText });
      }

      const saved = await response.json();

      if (existing && bankDetailsChanged) {
        // The old subaccount no longer matches these bank details, so what
        // Paystack reported for it no longer applies. Best effort (columns
        // exist only after supabase-payout-status.sql).
        const resetRes = await fetch(
          `${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}`,
          {
            method: 'PATCH',
            headers: supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY),
            body: JSON.stringify({
              paystack_subaccount_id: null,
              paystack_is_verified: null,
              paystack_active: null,
              paystack_status_checked_at: null,
            }),
          }
        );
        if (!resetRes.ok) console.warn('Could not reset Paystack status fields:', await resetRes.text());
      }

      return jsonResponse(existing ? 200 : 201, {
        beneficiary: saved[0],
        reverified_required: !existing || bankDetailsChanged,
      });
    }

    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
  } catch (err) {
    console.error('Unexpected error in beneficiary CRUD:', err);
    return jsonResponse(500, { error: 'Unexpected server error.' });
  }
}

export default async function handler(req, env) {
  const route = req.query.route;

  // The bank list is public reference data — no campaign, donor, or
  // beneficiary information is in it — so it's the one route on this
  // file that doesn't require an admin session. This is what lets the
  // public visitor submission form search banks too.
  if (route === 'banks') return handleBanks(req, env);

  const denied = await rejectIfNotAdmin(req, env);
  if (denied) return denied;

  const supabaseConfig = getSupabaseConfig(env);
  if (!supabaseConfig.SUPABASE_URL || !supabaseConfig.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse(500, { error: 'Server is missing Supabase configuration.' });
  }

  if (route === 'verify') return handleVerify(req, env, supabaseConfig);
  if (route === 'settlement') return handleSettlement(req, env, supabaseConfig);
  if (route === 'platform-fee') return handlePlatformFee(req, env, supabaseConfig);
  if (route === 'paystack-status') return handlePaystackStatus(req, env, supabaseConfig);
  if (route === 'reconcile-payouts') return handleReconcilePayouts(req, env, supabaseConfig);

  return handleBeneficiaryCrud(req, env, supabaseConfig);
}
