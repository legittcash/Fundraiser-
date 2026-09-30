// api/progress.js
//
// This is a Vercel Serverless Function.
// It runs on Vercel's server (never in the visitor's browser), so it's
// safe to use our Supabase SERVICE ROLE key here.
//
// This is a multi-campaign platform, so every request MUST explicitly
// identify which campaign it wants — campaign.html always calls this
// with the specific campaign it's showing:
//     fetch('/api/progress?id=123')       // by numeric id, or
//     fetch('/api/progress?slug=patient-name-example') // by slug
//
// There is no "default" campaign to fall back to. An earlier version of
// this file silently returned whichever campaign happened to be first
// in the table when neither id nor slug was supplied — on a platform
// with many independent campaigns, that risks one campaign's progress
// being shown for a completely different one, so that fallback has been
// removed: a request with neither id nor slug is now rejected with 400,
// and a request for an id/slug that doesn't match any campaign is
// rejected with 404.
//
// A successful response's JSON shape is unchanged:
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

  // A campaign must be explicitly identified — no fallback to "just
  // grab the first one".
  if (!id && !slug) {
    return res.status(400).json({ error: 'A campaign id or slug is required.' });
  }

  const filter = id ? `&id=eq.${encodeURIComponent(id)}` : `&slug=eq.${encodeURIComponent(slug)}`;

  try {
    // Ask Supabase's auto-generated REST API for the one matching row
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
      // The requested campaign genuinely doesn't exist — never silently
      // substitute a different campaign's data.
      return res.status(404).json({ error: 'Campaign not found.' });
    }

    // Send the fundraiser stats back to the frontend as JSON
    return res.status(200).json(rows[0]);
  } catch (err) {
    console.error('Unexpected error in /api/progress:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
