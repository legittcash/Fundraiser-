// api/initialize-donation.js
//
// THIS is now where a donation actually begins — replacing the old
// approach where campaign.html called PaystackPop.setup() directly in
// the browser using only the public key.
//
// Why this changed: with the old approach, the browser itself decided
// which Paystack "subaccount" to split a donation with, based on a
// subaccount code the public API had already handed it. A technical
// visitor could tamper with that value (or reuse a stale one from an
// old page load) before the payment was ever sent to Paystack — meaning
// the BROWSER, not our server, was the final authority on where money
// would settle. That's exactly backwards for something this sensitive.
//
// Now: the browser only ever tells us WHO is donating and HOW MUCH.
// Everything that decides where the money goes — the beneficiary's
// current subaccount, whether settlement is currently enabled, and
// whether the platform fee is currently switched on — is looked up
// fresh, right here, on the server, at the moment payment starts. If an
// admin pauses settlement or changes a beneficiary while a donor already
// has the campaign page open, that donor's payment (initialized after
// the pause) automatically reflects the new configuration — there is no
// stale subaccount code sitting in their browser to fall back on.
//
//   POST /api/initialize-donation
//   { fundraiser_id, donor_name, donor_email?, amount, anonymous }
//   -> { authorization_url, reference }
//
// The frontend redirects the browser to authorization_url — Paystack's
// own hosted checkout page — rather than opening an in-page popup. This
// is a real, deliberate change to the checkout UX, necessary because the
// subaccount/fee terms must be finalized BEFORE Paystack starts
// collecting payment, which only server-side initialization can do.
//
// FEE-BEARER ACCOUNTING: when a subaccount is actually used, Paystack's
// documented "bearer" parameter is set to "subaccount" — meaning the
// beneficiary, not the platform's main account, absorbs Paystack's own
// transaction fee. This is what makes the beneficiary's real settlement
// match our own accounting formula exactly:
//   beneficiary receives = gross - paystack_fee - platform_fee
// The platform fee itself is only ever computed (and only ever sent to
// Paystack as "transaction_charge") when there's an actual subaccount to
// split through — see STEP 4 below for why.

import { initializeTransaction } from '../lib/paystack.js';
import { jsonResponse } from '../lib/http.js';

const PLATFORM_FEE_RATE = 0.01; // 1%
const PLATFORM_FEE_CAP_NAIRA = 1000; // ₦1,000 maximum per transaction

function getSupabaseConfig(env) {
  const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  return { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
}

export default async function handler(req, env) {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseConfig(env);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse(500, { error: 'Server is missing Supabase configuration.' });
  }
  if (!env.PAYSTACK_SECRET_KEY) {
    return jsonResponse(500, { error: 'Server is missing PAYSTACK_SECRET_KEY.' });
  }

  const body = req.body || {};
  const fundraiserId = body.fundraiser_id;
  const donorName = (body.donor_name || '').trim();
  const donorEmail = (body.donor_email || '').trim();
  const amount = Number(body.amount);
  const anonymous = body.anonymous === true;

  if (!fundraiserId) return jsonResponse(400, { error: 'fundraiser_id is required.' });
  if (!donorName) return jsonResponse(400, { error: 'Your name is required.' });
  // Number.isFinite() also rejects Infinity, which `!amount` lets through.
  if (!Number.isFinite(amount) || amount < 100) {
    return jsonResponse(400, { error: 'Minimum donation is ₦100.' });
  }
  if (donorEmail && !donorEmail.includes('@')) {
    return jsonResponse(400, { error: 'That email address doesn\'t look right. You can also leave it blank.' });
  }

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    // ---- STEP 1: Confirm the campaign exists ----
    const campaignRes = await fetch(
      `${SUPABASE_URL}/rest/v1/fundraiser?select=id,patient_name,slug&id=eq.${encodeURIComponent(fundraiserId)}&limit=1`,
      { headers }
    );
    if (!campaignRes.ok) {
      console.error('Supabase error:', await campaignRes.text());
      return jsonResponse(500, { error: 'Failed to load campaign.' });
    }
    const campaignRows = await campaignRes.json();
    const campaign = campaignRows[0];
    if (!campaign) return jsonResponse(404, { error: 'Campaign not found.' });

    // ---- STEP 2: Look up the CURRENT beneficiary/settlement state ----
    // This is looked up fresh on every single donation initialization —
    // never cached, never trusted from anything the browser sent.
    const beneficiaryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/beneficiaries?select=verification_status,settlement_enabled,paystack_subaccount_code&fundraiser_id=eq.${encodeURIComponent(fundraiserId)}&limit=1`,
      { headers }
    );
    let subaccountCode = null;
    if (beneficiaryRes.ok) {
      const beneficiaryRows = await beneficiaryRes.json();
      const beneficiary = beneficiaryRows[0];
      if (beneficiary && beneficiary.settlement_enabled && beneficiary.verification_status === 'verified' && beneficiary.paystack_subaccount_code) {
        subaccountCode = beneficiary.paystack_subaccount_code;
      }
    } else {
      console.warn('Could not check beneficiary settlement status; proceeding without a subaccount.');
    }

    // ---- STEP 3: Look up the CURRENT platform fee master switch ----
    const settingsRes = await fetch(`${SUPABASE_URL}/rest/v1/platform_settings?select=platform_fee_enabled&limit=1`, {
      headers,
    });
    let platformFeeEnabled = false;
    if (settingsRes.ok) {
      const settingsRows = await settingsRes.json();
      platformFeeEnabled = settingsRows[0]?.platform_fee_enabled === true;
    }

    // ---- STEP 4: Compute the platform fee (server-side, never from the browser) ----
    // Formula: min(gross × 1%, ₦1,000) — but ONLY when there's an actual
    // verified, settlement-enabled subaccount to collect it through via
    // Paystack's split. Without a subaccount, the entire gross amount
    // already goes straight to the platform's main Paystack account —
    // there is no split for a "platform fee" to be carved out of, so
    // recording one in Supabase without Paystack actually being
    // configured to collect it would make our database disagree with
    // what Paystack really did. Rather than invent an alternative fee
    // mechanism for that case, the platform fee is simply ₦0.
    //
    // IMPORTANT — PRECISION: this is calculated entirely in KOBO, not
    // naira. Paystack's smallest unit is the kobo (1 naira = 100 kobo),
    // so amountKobo is always a whole number and dividing that isn't a
    // source of error — but rounding to whole NAIRA first (as an
    // earlier version of this file did) throws away up to 99 kobo of
    // precision before the fee is even converted back to kobo. E.g. a
    // ₦150 donation's true 1% fee is ₦1.50 (150 kobo); rounding to whole
    // naira first turns that into ₦2 (200 kobo) — a real, avoidable
    // rounding error. Computing directly in kobo, with a single
    // Math.round() at the kobo level (Paystack's smallest possible
    // unit), removes that intermediate rounding step entirely.
    const amountKobo = Math.round(amount * 100);
    const platformFeeCapKobo = PLATFORM_FEE_CAP_NAIRA * 100;
    const platformFeeKobo =
      platformFeeEnabled && subaccountCode
        ? Math.min(Math.round(amountKobo * PLATFORM_FEE_RATE), platformFeeCapKobo)
        : 0;

    // ---- STEP 5: Initialize the transaction with Paystack ----
    // Paystack requires SOME email to initialize a transaction, even
    // though our form makes email optional for the donor.
    const emailForPaystack = donorEmail || `donor-${Date.now()}@no-email-provided.example.com`;
    const host = req.headers.get('host') || req.url.host;
    const callbackUrl = `https://${host}/campaign.html?slug=${encodeURIComponent(campaign.slug)}`;

    const result = await initializeTransaction(env, {
      email: emailForPaystack,
      amountKobo,
      callbackUrl,
      subaccountCode,
      transactionChargeKobo: platformFeeKobo,
      // Whenever a subaccount is actually being used, the beneficiary
      // bears Paystack's own transaction fee (Paystack's documented
      // "bearer" parameter) — this is what makes the beneficiary's real
      // settlement match our accounting formula exactly:
      //   beneficiary receives = gross - paystack_fee - platform_fee
      // Left unset (and therefore never sent) when there's no
      // subaccount at all, since "bearer" only has meaning for a split
      // payment.
      bearer: subaccountCode ? 'subaccount' : undefined,
      metadata: {
        fundraiser_id: campaign.id,
        donor_name: donorName,
        donor_email: donorEmail || null,
        anonymous,
        subaccount_code: subaccountCode,
        // Round-tripped back to us via the webhook's metadata, exactly
        // like fundraiser_id/donor_name already are — this value was
        // computed by OUR server just now, never supplied by the
        // browser, so the webhook can trust it as the fee that was
        // actually applied to this specific transaction.
        platform_fee_kobo: platformFeeKobo,
        custom_fields: [
          { display_name: 'Fundraiser', variable_name: 'fundraiser', value: `Help ${campaign.patient_name}` },
          { display_name: 'Donor Name', variable_name: 'donor_name', value: donorName },
        ],
      },
    });

    if (!result.ok) {
      console.error('Paystack initialize failed:', result.error);
      return jsonResponse(502, { error: result.error });
    }

    return jsonResponse(200, {
      authorization_url: result.data.authorization_url,
      reference: result.data.reference,
    });
  } catch (err) {
    console.error('Unexpected error in /api/initialize-donation:', err);
    return jsonResponse(500, { error: 'Unexpected server error.' });
  }
}
