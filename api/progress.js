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
//     { raised_amount: 500, goal_amount: 1000, donor_count: 3, amount_settled: 0 }

// We use plain "fetch" to talk to Supabase's REST API (PostgREST),
// so we don't need to install any extra npm packages.
import { getAmountSettled } from '../lib/amount-settled.js';
import { jsonResponse } from '../lib/http.js';

export default async function handler(req, env) {
  // Only allow GET requests to this endpoint
  if (req.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse(500, { error: 'Server is missing Supabase configuration.' });
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
    return jsonResponse(400, { error: 'A campaign id or slug is required.' });
  }

  const filter = id ? `&id=eq.${encodeURIComponent(id)}` : `&slug=eq.${encodeURIComponent(slug)}`;

  try {
    // Ask Supabase's auto-generated REST API for the one matching row
    // in the "public.fundraiser" table. We select just the columns we need.
    const response = await fetch(
      `${SUPABASE_BASE_URL}/rest/v1/fundraiser?select=id,raised_amount,goal_amount,donor_count${filter}&limit=1`,
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
      return jsonResponse(500, { error: 'Failed to fetch fundraiser data.' });
    }

    const rows = await response.json();

    if (!rows || rows.length === 0) {
      // The requested campaign genuinely doesn't exist — never silently
      // substitute a different campaign's data.
      return jsonResponse(404, { error: 'Campaign not found.' });
    }

    // Send the fundraiser stats back to the frontend as JSON, plus the
    // single public aggregate "amount_settled" (SUM of
    // donations.settled_amount for this campaign; see
    // lib/amount-settled.js). The internal id is used only for that
    // lookup and is not returned, so the original three fields are
    // unchanged.
    const { id: campaignRowId, ...stats } = rows[0];
    const amountSettled = await getAmountSettled(SUPABASE_BASE_URL, {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    }, campaignRowId);
    return jsonResponse(200, { ...stats, amount_settled: amountSettled });
  } catch (err) {
    console.error('Unexpected error in /api/progress:', err);
    return jsonResponse(500, { error: 'Unexpected server error.' });
  }
}
