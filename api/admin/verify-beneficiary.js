// api/admin/verify-beneficiary.js
//
// Performs the actual Paystack verification for a campaign's
// beneficiary:
//   1. Resolve the account_number + bank_code with Paystack's
//      documented "Resolve Account Number" endpoint. This confirms the
//      account is real and returns the name it's registered under.
//   2. If that succeeds and no Paystack subaccount exists yet for this
//      beneficiary, create one via Paystack's documented "Create
//      Subaccount" endpoint. If a subaccount already exists (e.g.
//      re-verifying without any bank detail change), it's left as-is —
//      we never create a duplicate subaccount for the same beneficiary.
//
// IMPORTANT: verifying a beneficiary does NOT automatically enable
// settlement. settlement_enabled stays false until an admin takes the
// separate, deliberate action in api/admin/settlement.js. This is the
// "should not automatically settle to an unverified beneficiary" +
// "admin should verify before automatic settlement is enabled"
// requirement, enforced as two distinct steps rather than one.

import { rejectIfNotAdmin } from '../../lib/admin-auth.js';
import { resolveAccountNumber, createSubaccount } from '../../lib/paystack.js';

function getSupabaseConfig() {
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (rejectIfNotAdmin(req, res)) return;

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseConfig();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(500).json({ error: 'Server is missing PAYSTACK_SECRET_KEY.' });
  }

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

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
    console.error('Unexpected error in /api/admin/verify-beneficiary:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
