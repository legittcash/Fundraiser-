// api/track-campaign.js
//
// Public, unauthenticated endpoint behind track.html. A visitor who
// submitted a campaign (api/submit-campaign.js) gets back a private
// tracking link of the form /track.html?token=... — this endpoint is
// what that page calls to look up the current status.
//
//   GET /api/track-campaign?token=...
//
// No admin login is required or checked here — the token ITSELF is the
// private access credential, exactly like a long, unguessable password.
// It is a 256-bit random value (see generateTrackingToken() in
// api/submit-campaign.js), never derived from anything guessable, and
// never exposed by any other public endpoint.
//
// IMPORTANT — PRIVACY: this only ever selects an explicit allowlist of
// columns from "fundraiser", the same pattern already used by
// api/campaign.js and api/campaigns.js. It never selects "*", so a
// future column added to the table is never accidentally exposed here.
// submitter_name, submitter_email, submitter_phone, tracking_token, and
// every internal/admin field (id, beneficiary/settlement info, donation
// details) are NEVER returned by this endpoint.

function getSupabaseConfig() {
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
}

// Only the columns needed to look up a row by its token, plus the
// handful of fields the tracking page is allowed to show. Note "id" is
// intentionally excluded from what we send back to the browser — see
// the allowlist below, applied AFTER this query, not this select list.
const LOOKUP_FIELDS = 'patient_name,status,created_at,rejection_reason,slug';

export default async function handler(req, res) {
  // No-cache — a visitor may check this page repeatedly right after an
  // admin approves/rejects their submission, and must never see a
  // stale, cached status.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', ['GET', 'OPTIONS']);
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET', 'OPTIONS']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseConfig();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }

  const token = (req.query.token || '').trim();
  if (!token) {
    return res.status(400).json({ error: 'A tracking token is required.' });
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/fundraiser?select=${LOOKUP_FIELDS}&tracking_token=eq.${encodeURIComponent(token)}&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!response.ok) {
      // Never leak the raw Supabase error to an unauthenticated caller.
      console.error('[track-campaign] Supabase error:', await response.text());
      return res.status(500).json({ error: 'Something went wrong looking up your submission. Please try again later.' });
    }

    const rows = await response.json();
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'We could not find a submission with that tracking link.' });
    }

    const campaign = rows[0];

    // Build the response explicitly, field by field — never spread the
    // raw row — so it is structurally impossible for a future column
    // added to LOOKUP_FIELDS to leak through here by accident.
    const result = {
      patient_name: campaign.patient_name,
      status: campaign.status,
      created_at: campaign.created_at,
    };

    if (campaign.status === 'rejected') {
      result.rejection_reason = campaign.rejection_reason || 'Your submission was not approved at this time.';
    }

    if (campaign.status === 'active') {
      result.public_url = `/campaign.html?slug=${encodeURIComponent(campaign.slug)}`;
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[track-campaign] Unexpected error:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
