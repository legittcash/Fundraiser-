// api/campaign.js
//
// Public endpoint used by campaign.html to load one patient's full
// fundraising page: photo, story, goal, live totals, etc.
//
//   GET /api/campaign?slug=lucy-x7k2
//
// Archived campaigns can still be viewed directly by anyone who has the
// link (e.g. past donors checking back), they just won't appear in the
// homepage's active list from /api/campaigns.
//
// IMPORTANT — PRIVACY: this only ever selects an explicit list of
// columns, never "*". "fundraiser" also stores private administrative
// fields (phone_number, secondary_phone_number) that must never reach
// the public website — an explicit allowlist here is what guarantees
// that, even as more private fields get added to the table in future.
//
// IMPORTANT — SETTLEMENT SECURITY: this endpoint deliberately does NOT
// return anything about a campaign's beneficiary or Paystack subaccount
// (it used to, and that was a real gap — see api/initialize-donation.js
// for the full explanation). The browser has no way to know or
// influence which subaccount, if any, a donation will settle to.
// Settlement is decided fresh, entirely server-side, only at the moment
// a donation is actually initialized.
//
// FEE-PREVIEW FIELDS (platform_fee_enabled / platform_fee_applicable):
// campaign.html shows donors a live, pre-payment fee breakdown as they
// type an amount (see its "fee-breakdown" section). To be honest and
// accurate — never showing a platform fee that wouldn't actually be
// charged, or hiding one that would — it needs to know whether the
// SAME conditions api/initialize-donation.js checks at checkout
// (STEP 2 + STEP 3 there) are currently true. These two booleans below
// answer exactly that, computed with the identical conditions already
// used there, reused rather than reinvented:
//   platform_fee_enabled    — the platform-wide fee master switch
//                              (platform_settings.platform_fee_enabled)
//   platform_fee_applicable — the above AND this specific campaign
//                              currently has a verified,
//                              settlement-enabled beneficiary with a
//                              Paystack subaccount (without which no
//                              split — and therefore no platform fee —
//                              can actually be collected; see
//                              api/initialize-donation.js STEP 4)
// Nothing sensitive is exposed: no subaccount code, no bank details, no
// verification status text — just the two yes/no answers a donor-facing
// fee preview needs. The actual fee itself is still only ever computed,
// authoritatively, by api/initialize-donation.js at checkout — these
// fields only let the PREVIEW match that reality instead of guessing.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }

  const slug = (req.query.slug || '').trim();
  if (!slug) {
    return res.status(400).json({ error: 'A campaign slug is required.' });
  }

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  // Everything the public campaign page (campaign.html) needs, and
  // nothing that's private. phone_number and secondary_phone_number are
  // deliberately NOT in this list, and neither is anything about
  // beneficiaries/subaccounts.
  const PUBLIC_CAMPAIGN_FIELDS =
    'id,slug,patient_name,hospital,diagnosis,story,image_url,goal_amount,raised_amount,donor_count,status,created_at';

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/fundraiser?select=${PUBLIC_CAMPAIGN_FIELDS}&slug=eq.${encodeURIComponent(slug)}&limit=1`,
      { headers }
    );

    if (!response.ok) {
      console.error('Supabase error:', await response.text());
      return res.status(500).json({ error: 'Failed to load campaign.' });
    }

    const rows = await response.json();
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }

    const campaign = rows[0];

    // ---- Platform fee master switch (same table/field STEP 3 of
    // api/initialize-donation.js reads) ----
    let platformFeeEnabled = false;
    try {
      const settingsRes = await fetch(`${SUPABASE_URL}/rest/v1/platform_settings?select=platform_fee_enabled&limit=1`, {
        headers,
      });
      if (settingsRes.ok) {
        const settingsRows = await settingsRes.json();
        platformFeeEnabled = settingsRows[0]?.platform_fee_enabled === true;
      }
    } catch (err) {
      console.warn('Could not check platform fee master switch; defaulting the preview to disabled.', err);
    }

    // ---- Does THIS campaign currently have a beneficiary that could
    // actually collect a platform fee? (same conditions STEP 2 of
    // api/initialize-donation.js checks) ----
    let platformFeeApplicable = false;
    try {
      const beneficiaryRes = await fetch(
        `${SUPABASE_URL}/rest/v1/beneficiaries?select=verification_status,settlement_enabled,paystack_subaccount_code&fundraiser_id=eq.${encodeURIComponent(campaign.id)}&limit=1`,
        { headers }
      );
      if (beneficiaryRes.ok) {
        const beneficiaryRows = await beneficiaryRes.json();
        const beneficiary = beneficiaryRows[0];
        const hasReadySubaccount =
          !!beneficiary &&
          beneficiary.settlement_enabled === true &&
          beneficiary.verification_status === 'verified' &&
          !!beneficiary.paystack_subaccount_code;
        platformFeeApplicable = platformFeeEnabled && hasReadySubaccount;
      }
    } catch (err) {
      console.warn('Could not check beneficiary settlement status; defaulting the fee preview to not applicable.', err);
    }

    return res.status(200).json({
      campaign: {
        ...campaign,
        platform_fee_enabled: platformFeeEnabled,
        platform_fee_applicable: platformFeeApplicable,
      },
    });
  } catch (err) {
    console.error('Unexpected error in /api/campaign:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}

