// api/campaigns.js
//
// Public endpoint used by the new homepage (index.html) to show every
// active patient campaign, with an optional search box.
//
//   GET /api/campaigns              -> all active campaigns
//   GET /api/campaigns?search=lucy  -> active campaigns matching "lucy"
//
// This never exposes archived campaigns, and only returns the fields the
// homepage cards actually need.

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
    return res.status(200).json({ campaigns });
  } catch (err) {
    console.error('Unexpected error in /api/campaigns:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
