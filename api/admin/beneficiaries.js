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
//   GET  /api/admin/beneficiaries?route=banks           -> list Nigerian banks (from Paystack)
//   POST /api/admin/beneficiaries?route=verify           { fundraiser_id } -> verify + create subaccount
//   POST /api/admin/beneficiaries?route=settlement        { fundraiser_id, action } -> enable/pause settlement
//   GET  /api/admin/beneficiaries?route=platform-fee     -> read the platform fee master switch
//   POST /api/admin/beneficiaries?route=platform-fee      { enabled } -> set the platform fee master switch
//
// Every campaign has AT MOST one beneficiary row, enforced by the
// unique constraint on beneficiaries.fundraiser_id. Note that the
// `route=settlement` action's own body already has a field called
// "action" (enable/pause) — this is a DIFFERENT thing from the `route`
// query parameter used to select which section of this file handles the
// request, so there's no naming collision between them.

import { rejectIfNotAdmin } from '../../lib/admin-auth.js';
import { listNigerianBanks, resolveAccountNumber, createSubaccount } from '../../lib/paystack.js';

const PLATFORM_FEE_RATE_PERCENT = 1;
const PLATFORM_FEE_CAP_NAIRA = 1000;

function getSupabaseConfig() {
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
async function handleBanks(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const result = await listNigerianBanks();
  if (!result.ok) {
    return res.status(502).json({ error: result.error });
  }
  return res.status(200).json({ banks: result.data });
}

// =========================================================================
// route=verify — from the original api/admin/verify-beneficiary.js
// =========================================================================
async function handleVerify(req, res, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(500).json({ error: 'Server is missing PAYSTACK_SECRET_KEY.' });
  }

  const headers = supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY);
  const fundraiserId = (req.body || {}).fundraiser_id;
  if (!fundraiserId) {
    return res.status(400).json({ error: 'fundraiser_id is required.' });
  }

  try {
    const beneficiaryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}&select=*&limit=1`,
      { headers }
    );
    if (!beneficiaryRes.ok) {
      console.error('Supabase error:', await beneficiaryRes.text());
      return res.status(500).json({ error: 'Failed to load beneficiary.' });
    }
    const rows = await beneficiaryRes.json();
    const beneficiary = rows[0];
    if (!beneficiary) {
      return res.status(404).json({ error: 'No beneficiary is on file for this campaign yet. Add one first.' });
    }
    if (!beneficiary.bank_code || !beneficiary.account_number) {
      return res.status(400).json({ error: 'Beneficiary is missing a bank or account number.' });
    }

    // ---- STEP 1: Resolve/verify the account number with Paystack ----
    const resolveResult = await resolveAccountNumber(beneficiary.account_number, beneficiary.bank_code);

    if (!resolveResult.ok) {
      // Mark verification as failed so the admin sees an honest status,
      // rather than leaving it silently "pending" forever.
      await fetch(`${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ verification_status: 'failed', updated_at: new Date().toISOString() }),
      });
      return res.status(422).json({ error: `Account verification failed: ${resolveResult.error}` });
    }

    // ---- STEP 2: Create the Paystack subaccount, if one doesn't exist ----
    let subaccountCode = beneficiary.paystack_subaccount_code;
    if (!subaccountCode) {
      const subaccountResult = await createSubaccount({
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
        return res.status(502).json({ error: `Could not set up settlement: ${subaccountResult.error}` });
      }

      subaccountCode = subaccountResult.data.subaccount_code;
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
          verified_by: process.env.ADMIN_USERNAME || 'admin',
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!updateRes.ok) {
      console.error('Supabase error:', await updateRes.text());
      return res.status(500).json({ error: 'Verification succeeded with Paystack, but saving the result failed. Please try again.' });
    }

    const updated = await updateRes.json();
    return res.status(200).json({ beneficiary: updated[0] });
  } catch (err) {
    console.error('Unexpected error verifying beneficiary:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}

// =========================================================================
// route=settlement — from the original api/admin/settlement.js
// =========================================================================
async function handleSettlement(req, res, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fundraiser_id: fundraiserId, action } = req.body || {};
  if (!fundraiserId || !['enable', 'pause'].includes(action)) {
    return res.status(400).json({ error: 'fundraiser_id and a valid action ("enable" or "pause") are required.' });
  }

  const headers = supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY);

  try {
    const beneficiaryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}&select=*&limit=1`,
      { headers }
    );
    if (!beneficiaryRes.ok) {
      console.error('Supabase error:', await beneficiaryRes.text());
      return res.status(500).json({ error: 'Failed to load beneficiary.' });
    }
    const rows = await beneficiaryRes.json();
    const beneficiary = rows[0];
    if (!beneficiary) {
      return res.status(404).json({ error: 'No beneficiary is on file for this campaign yet.' });
    }

    if (action === 'enable') {
      if (beneficiary.verification_status !== 'verified' || !beneficiary.paystack_subaccount_code) {
        return res.status(400).json({
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
      return res.status(500).json({ error: 'Failed to update settlement status.' });
    }

    const updated = await response.json();
    return res.status(200).json({ beneficiary: updated[0] });
  } catch (err) {
    console.error('Unexpected error updating settlement:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}

// =========================================================================
// route=platform-fee — from the original api/admin/platform-fee.js
// =========================================================================
async function handlePlatformFee(req, res, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }) {
  const headers = supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (req.method === 'GET') {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/platform_settings?select=platform_fee_enabled,updated_at,updated_by&limit=1`, {
        headers,
      });
      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        return res.status(500).json({ error: 'Failed to load platform fee setting.' });
      }
      const rows = await response.json();
      const row = rows[0];
      return res.status(200).json({
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
            updated_by: process.env.ADMIN_USERNAME || 'admin',
            updated_at: new Date().toISOString(),
          }),
        });
        if (!insertRes.ok) {
          console.error('Supabase error:', await insertRes.text());
          return res.status(500).json({ error: 'Failed to save platform fee setting.' });
        }
        const inserted = await insertRes.json();
        return res.status(200).json({
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
          updated_by: process.env.ADMIN_USERNAME || 'admin',
          updated_at: new Date().toISOString(),
        }),
      });
      if (!updateRes.ok) {
        console.error('Supabase error:', await updateRes.text());
        return res.status(500).json({ error: 'Failed to save platform fee setting.' });
      }
      const updated = await updateRes.json();
      return res.status(200).json({
        enabled: updated[0].platform_fee_enabled,
        rate_percent: PLATFORM_FEE_RATE_PERCENT,
        cap_naira: PLATFORM_FEE_CAP_NAIRA,
      });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Unexpected error with platform fee setting:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}

// =========================================================================
// Default (no ?route=) — from the original api/admin/beneficiaries.js
// base CRUD: view (full or masked-summary) and save beneficiary details
// =========================================================================
async function handleBeneficiaryCrud(req, res, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }) {
  const headers = supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (req.method === 'GET') {
      if (req.query.all) {
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/beneficiaries?select=fundraiser_id,beneficiary_name,bank_name,account_number,verification_status,settlement_enabled`,
          { headers }
        );
        if (!response.ok) {
          console.error('Supabase error:', await response.text());
          return res.status(500).json({ error: 'Failed to load beneficiary summaries.' });
        }
        const rows = await response.json();
        const summaries = rows.map((r) => ({
          fundraiser_id: r.fundraiser_id,
          beneficiary_name: r.beneficiary_name,
          bank_name: r.bank_name,
          account_number_masked: maskAccountNumber(r.account_number),
          verification_status: r.verification_status,
          settlement_enabled: r.settlement_enabled,
        }));
        return res.status(200).json({ beneficiaries: summaries });
      }

      const fundraiserId = req.query.fundraiser_id;
      if (!fundraiserId) {
        return res.status(400).json({ error: 'A fundraiser_id or ?all=1 is required.' });
      }

      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}&select=*&limit=1`,
        { headers }
      );
      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        return res.status(500).json({ error: 'Failed to load beneficiary.' });
      }
      const rows = await response.json();
      return res.status(200).json({ beneficiary: rows[0] || null });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const fundraiserId = body.fundraiser_id;
      const beneficiaryName = (body.beneficiary_name || '').trim();

      if (!fundraiserId) return res.status(400).json({ error: 'fundraiser_id is required.' });
      if (!beneficiaryName) return res.status(400).json({ error: 'Beneficiary name is required.' });
      if (!body.bank_code || !body.account_number) {
        return res.status(400).json({ error: 'Bank and account number are required.' });
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
        return res.status(500).json({ error: 'Failed to save beneficiary.', details: errText });
      }

      const saved = await response.json();
      return res.status(existing ? 200 : 201).json({
        beneficiary: saved[0],
        reverified_required: !existing || bankDetailsChanged,
      });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Unexpected error in beneficiary CRUD:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}

export default async function handler(req, res) {
  if (rejectIfNotAdmin(req, res)) return;

  const supabaseConfig = getSupabaseConfig();
  if (!supabaseConfig.SUPABASE_URL || !supabaseConfig.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }

  const route = req.query.route;

  if (route === 'banks') return handleBanks(req, res);
  if (route === 'verify') return handleVerify(req, res, supabaseConfig);
  if (route === 'settlement') return handleSettlement(req, res, supabaseConfig);
  if (route === 'platform-fee') return handlePlatformFee(req, res, supabaseConfig);

  return handleBeneficiaryCrud(req, res, supabaseConfig);
}
