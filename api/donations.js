// api/donations.js
//
// Public endpoint used by campaign.html to show the "Recent Donors"
// list on a patient's page.
//
//   GET /api/donations?id=123          -> last 10 donations for campaign 123
//   GET /api/donations?id=123&limit=20 -> last 20 donations
//
// IMPORTANT PRIVACY NOTE:
// We resolve "Anonymous" HERE on the server, not in the browser. That
// means if a donor ticked "Donate anonymously", their real name is never
// even sent to the page in the first place — there's nothing for
// frontend JavaScript to accidentally leak. Email is never included in
// this response at all, public or private.
//
// This response DOES include the gross amount, Paystack fee, and net
// amount for each donation — that breakdown isn't sensitive (it doesn't
// identify the donor or expose any secret), and showing it is what lets
// the public campaign page be transparent about how much of a donation
// actually reaches the campaign after payment processing costs.

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

  const fundraiserId = req.query.id;
  if (!fundraiserId) {
    return res.status(400).json({ error: 'A campaign id is required.' });
  }

  // Cap how many rows can be requested at once, and default to 10
  const requestedLimit = Number(req.query.limit) || 10;
  const limit = Math.min(Math.max(requestedLimit, 1), 50);

  try {
    // Only select the columns we're willing to make public. donor_email
    // is deliberately never selected here.
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/donations?select=donor_name,anonymous,amount,paystack_fee,net_amount,created_at` +
        `&fundraiser_id=eq.${encodeURIComponent(fundraiserId)}` +
        `&order=created_at.desc&limit=${limit}`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!response.ok) {
      console.error('Supabase error:', await response.text());
      return res.status(500).json({ error: 'Failed to load recent donations.' });
    }

    const rows = await response.json();

    // Turn each row into exactly what's safe to show publicly: a display
    // name (never the real name if the donor asked to stay anonymous),
    // the gross/fee/net breakdown, and when it happened.
    const donations = rows.map((row) => ({
      display_name: row.anonymous || !row.donor_name ? 'Anonymous' : row.donor_name,
      amount: row.amount, // gross amount the donor paid
      paystack_fee: row.paystack_fee,
      net_amount: row.net_amount,
      created_at: row.created_at,
    }));

    return res.status(200).json({ donations });
  } catch (err) {
    console.error('Unexpected error in /api/donations:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
