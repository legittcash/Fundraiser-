// api/progress.js
//
// This is a Vercel Serverless Function.
// It runs on Vercel's server (never in the visitor's browser), so it's
// safe to use our Supabase SERVICE ROLE key here.
//
// The frontend (index.html) calls this endpoint via:
//     fetch('/api/progress')
// and expects back a JSON object like:
//     { raised_amount: 500, goal_amount: 1000, donor_count: 3 }
//
// That JSON is what fills in the amount raised, percentage, and
// green progress bar on the page.

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

  try {
    // Ask Supabase's auto-generated REST API for the single row
    // in the "fundraiser" table. We select just the columns we need.
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/fundraiser?select=raised_amount,goal_amount,donor_count&limit=1`,
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
