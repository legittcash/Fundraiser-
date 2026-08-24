// api/progress.js
//
// This is a Vercel Serverless Function.
// It runs on Vercel's server (never in the visitor's browser), so it's
// safe to use our Supabase SERVICE ROLE key here.
//
// The original single-campaign page called this with no parameters:
//     fetch('/api/progress')
// and got back the one and only fundraiser row. Now that the site hosts
// unlimited campaigns, campaign.html calls it with the specific campaign
// it's showing:
//     fetch('/api/progress?id=123')       // by numeric id, or
//     fetch('/api/progress?slug=lucy-x7k2') // by slug
//
// Calling it with no parameters at all still works exactly like before
// (returns the first fundraiser row) so any old bookmarked pages or
// cached frontend code don't break.
//
// Either way, the JSON shape stays the same:
//     { raised_amount: 500, goal_amount: 1000, donor_count: 3 }

// We use plain "fetch" to talk to Supabase's REST API (PostgREST),
// so we don't need to install any extra npm packages.
export default async function handler(req, res) {
  // Only allow GET requests to this endpoint
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }

  // If SUPABASE_URL was saved in Vercel with a trailing slash (e.g.
  // "https://xxxx.supabase.co/"), building the endpoint below would
  // produce a double slash ("...supabase.co//rest/v1/fundraiser"), which
  // PostgREST rejects with "PGRST125: Invalid path specified in request
  // URL". Stripping any trailing slash here guarantees a clean,
  // single-slash path no matter how the env var was entered.
  const SUPABASE_BASE_URL = SUPABASE_URL.replace(/\/+$/, '');

  const { id, slug } = req.query;

  // Build the filter for whichever campaign was asked for. If neither
  // "id" nor "slug" was given, we fall back to the original behavior:
  // just grab the first row (this only makes sense while there's a
  // single campaign, but keeps any old integration from breaking).
  let filter = '';
  if (id) {
    filter = `&id=eq.${encodeURIComponent(id)}`;
  } else if (slug) {
    filter = `&slug=eq.${encodeURIComponent(slug)}`;
  }

  try {
    // Ask Supabase's auto-generated REST API for the matching row(s)
    // in the "public.fundraiser" table. We select just the columns we need.
    const response = await fetch(
      `${SUPABASE_BASE_URL}/rest/v1/fundraiser?select=raised_amount,goal_amount,donor_count${filter}&limit=1`,
      {
        method: 'GET',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Supabase error:', errText);
      return res.status(500).json({ error: 'Failed to fetch fundraiser data.' });
    }

    const rows = await response.json();

    if (!rows || rows.length === 0) {
      // No row found — return safe defaults so the page doesn't break
      return res.status(200).json({ raised_amount: 0, goal_amount: 1000, donor_count: 0 });
    }

    // Send the fundraiser stats back to the frontend as JSON
    return res.status(200).json(rows[0]);
  } catch (err) {
    console.error('Unexpected error in /api/progress:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
