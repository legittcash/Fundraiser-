// api/campaigns.js
//
// Public endpoint used by the new homepage (index.html) to show every
// active patient campaign, with an optional search box.
//
//   GET /api/campaigns              -> all active campaigns
//   GET /api/campaigns?search=patient  -> active campaigns matching "patient"
//
// This never exposes archived campaigns, and only returns the fields the
// homepage cards actually need. Each campaign also carries a single
// yes/no field, beneficiary_verified, for the public "Verified" badge.

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

  const search = (req.query.search || '').trim();

  let url =
    `${SUPABASE_URL}/rest/v1/fundraiser` +
    `?select=id,slug,patient_name,hospital,image_url,goal_amount,raised_amount,donor_count` +
    `&status=eq.active&order=created_at.desc`;

  if (search) {
    url += `&patient_name=ilike.*${encodeURIComponent(search)}*`;
  }

  try {
    const response = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });

    if (!response.ok) {
      console.error('Supabase error:', await response.text());
      return res.status(500).json({ error: 'Failed to load campaigns.' });
    }

    const campaigns = await response.json();

    // ---- Public "Verified" badge flag ----
    // Adds ONE boolean, beneficiary_verified, per campaign. It is true
    // only when that campaign's beneficiary row has
    // verification_status = 'verified' (settlement_enabled is
    // deliberately NOT considered: verification and settlement are
    // separate concepts). Only the fundraiser_id column of matching
    // rows is selected, so no beneficiary detail ever leaves the
    // server. If this lookup fails, every flag is simply false and the
    // campaign list still loads normally.
    const verifiedIds = new Set();
    try {
      const ids = campaigns.map((c) => c.id).filter(Boolean);
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100).map(encodeURIComponent).join(',');
        const bRes = await fetch(
          `${SUPABASE_URL}/rest/v1/beneficiaries?select=fundraiser_id&verification_status=eq.verified&fundraiser_id=in.(${chunk})`,
          {
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
          }
        );
        if (!bRes.ok) continue;
        (await bRes.json()).forEach((row) => verifiedIds.add(row.fundraiser_id));
      }
    } catch (err) {
      console.warn('Could not check beneficiary verification; no badges will show.', err);
    }

    const campaignsWithBadge = campaigns.map((c) => ({
      ...c,
      beneficiary_verified: verifiedIds.has(c.id),
    }));
    return res.status(200).json({ campaigns: campaignsWithBadge });
  } catch (err) {
    console.error('Unexpected error in /api/campaigns:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
