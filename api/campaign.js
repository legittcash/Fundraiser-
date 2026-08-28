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

  // Everything the public campaign page (campaign.html) needs, and
  // nothing that's private. phone_number and secondary_phone_number are
  // deliberately NOT in this list.
  const PUBLIC_CAMPAIGN_FIELDS =
    'id,slug,patient_name,hospital,diagnosis,story,image_url,goal_amount,raised_amount,donor_count,status,created_at';

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/fundraiser?select=${PUBLIC_CAMPAIGN_FIELDS}&slug=eq.${encodeURIComponent(slug)}&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!response.ok) {
      console.error('Supabase error:', await response.text());
      return res.status(500).json({ error: 'Failed to load campaign.' });
    }

    const rows = await response.json();
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }

    return res.status(200).json({ campaign: rows[0] });
  } catch (err) {
    console.error('Unexpected error in /api/campaign:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
