// api/admin/beneficiaries.js
//
// Protected endpoint for managing a campaign's beneficiary (the verified
// bank account Paystack can automatically settle a share of donations
// to). Every campaign has AT MOST one beneficiary row, enforced by the
// unique constraint on beneficiaries.fundraiser_id.
//
//   GET  /api/admin/beneficiaries?fundraiser_id=123
//        -> full detail for ONE campaign's beneficiary (or null), used
//           when the admin opens the edit form. Includes the full,
//           unmasked account number since the admin explicitly asked
//           to view/edit it.
//
//   GET  /api/admin/beneficiaries?all=1
//        -> a lightweight summary for EVERY campaign's beneficiary in
//           one call (used to show inline status badges on the main
//           dashboard table without one request per row). Account
//           numbers are MASKED here (e.g. "••••6047") since this is a
//           list view, not a focused edit view.
//
//   POST /api/admin/beneficiaries
//        -> create or update the beneficiary's base info (name, bank,
//           account number, phones, settlement percentage) for a given
//           fundraiser_id. This does NOT verify the account or create a
//           Paystack subaccount — that's a deliberate separate step (see
//           api/admin/verify-beneficiary.js), so a campaign is never
//           automatically trusted with settlement just because someone
//           typed bank details in.
//
// SAFETY: if this endpoint is used to change an ALREADY-VERIFIED
// beneficiary's bank_code or account_number, verification is
// automatically reset to "pending" and settlement is automatically
// paused. This is the "appropriate admin control" gate requested for
// changing bank details — a beneficiary can never silently keep
// "Verified" / "Settlement Enabled" status after its underlying bank
// account changes.

import { rejectIfNotAdmin } from '../../lib/admin-auth.js';

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

export default async function handler(req, res) {
  if (rejectIfNotAdmin(req, res)) return;

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseConfig();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }
  const headers = supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY);

  try {
    // ---------------------------------------------------------------
    // GET — one campaign's full beneficiary detail, or a masked
    // summary of every campaign's beneficiary
    // ---------------------------------------------------------------
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

    // ---------------------------------------------------------------
    // POST — create or update a campaign's beneficiary base info
    // ---------------------------------------------------------------
    if (req.method === 'POST') {
      const body = req.body || {};
      const fundraiserId = body.fundraiser_id;
      const beneficiaryName = (body.beneficiary_name || '').trim();

      if (!fundraiserId) return res.status(400).json({ error: 'fundraiser_id is required.' });
      if (!beneficiaryName) return res.status(400).json({ error: 'Beneficiary name is required.' });
      if (!body.bank_code || !body.account_number) {
        return res.status(400).json({ error: 'Bank and account number are required.' });
      }

      // Look up any existing beneficiary row for this campaign first, so
      // we know whether this is a create or an update, and whether bank
      // details are actually changing (which would require re-verification).
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
      // beneficiary resets verification/settlement — see file header.
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
    console.error('Unexpected error in /api/admin/beneficiaries:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
