// api/admin/settlement.js
//
// The explicit ON/OFF switch for automatic settlement — this is the
// "admin control" half of the hybrid model. Verifying a beneficiary
// (api/admin/verify-beneficiary.js) never turns this on by itself.
//
//   POST /api/admin/settlement { fundraiser_id, action: "enable" }
//   POST /api/admin/settlement { fundraiser_id, action: "pause" }
//
// Enabling requires the beneficiary to already be verified and have a
// Paystack subaccount on file — pausing is always allowed immediately,
// with no preconditions, since it's the safety valve.
//
// A problem with one campaign's beneficiary can never affect another:
// this only ever reads/writes the single beneficiaries row matching the
// given fundraiser_id.

import { rejectIfNotAdmin } from '../../lib/admin-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (rejectIfNotAdmin(req, res)) return;

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }

  const { fundraiser_id: fundraiserId, action } = req.body || {};
  if (!fundraiserId || !['enable', 'pause'].includes(action)) {
    return res.status(400).json({ error: 'fundraiser_id and a valid action ("enable" or "pause") are required.' });
  }

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

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
    console.error('Unexpected error in /api/admin/settlement:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
