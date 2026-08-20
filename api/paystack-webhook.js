// api/paystack-webhook.js
//
// This is a Vercel Serverless Function that Paystack calls automatically
// every time something happens on your Paystack account (e.g. a
// successful payment). This is the ONLY place we trust to confirm that
// a payment really happened — never the frontend, since a browser can
// be tampered with.
//
// Flow:
//   1. A donor pays through the Paystack popup on index.html.
//   2. Paystack's servers send a POST request to this URL:
//        https://your-site.vercel.app/api/paystack-webhook
//   3. We verify the request really came from Paystack (using a
//      cryptographic signature check).
//   4. If it's a genuine "successful charge" event, we FIRST check
//      whether we've already recorded this exact payment before (using
//      Paystack's unique "reference" for the transaction). Paystack can
//      send the same webhook more than once (e.g. if our server is slow
//      to respond, or due to a network retry) — without this check we'd
//      add the same donation to the total twice.
//   5. If the reference is new, we insert a row into "donations" (which
//      has a UNIQUE constraint on paystack_reference as a second line of
//      defense) and only then update the "fundraiser" row in Supabase:
//      add to raised_amount, add 1 to donor_count.
//   6. The next time the frontend calls /api/progress, it will see
//      the new, updated numbers.

import crypto from 'crypto';

// Vercel needs the RAW request body (not pre-parsed JSON) so we can
// verify Paystack's signature correctly. This config disables Vercel's
// automatic body parsing for this function.
export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper: read the raw request body as a string/buffer
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!PAYSTACK_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required environment variables.');
    return res.status(500).json({ error: 'Server misconfigured.' });
  }

  // ---- STEP 1: Read the raw body and verify Paystack's signature ----
  const rawBody = await getRawBody(req);

  // Paystack signs every webhook with your SECRET key and sends the
  // signature in the "x-paystack-signature" header. We recompute the
  // same signature ourselves; if it doesn't match, we reject the
  // request because it did NOT genuinely come from Paystack.
  const expectedSignature = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  const paystackSignature = req.headers['x-paystack-signature'];

  if (expectedSignature !== paystackSignature) {
    console.warn('Invalid Paystack webhook signature received.');
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  // ---- STEP 2: Parse the verified body ----
  const event = JSON.parse(rawBody);

  // We only care about successful charge events
  if (event.event !== 'charge.success') {
    // Acknowledge receipt so Paystack doesn't keep retrying, but do nothing
    return res.status(200).json({ received: true, ignored: true });
  }

  // Amount from Paystack is in kobo, so we convert back to naira
  const amountPaid = event.data.amount / 100;

  // Paystack's unique reference for this specific transaction. This is
  // the key we use to detect duplicate/retried webhook deliveries.
  const reference = event.data.reference;
  const donorEmail = event.data.customer?.email || null;

  if (!reference) {
    console.error('Webhook payload is missing event.data.reference.');
    return res.status(400).json({ error: 'Missing transaction reference.' });
  }

  try {
    // ---- STEP 3: Check whether we've already processed this reference ----
    // We look this reference up in "donations" BEFORE touching the
    // fundraiser totals. If it's already there, this webhook call is a
    // duplicate (Paystack retry) of one we've already handled, so we
    // acknowledge it with 200 OK but do NOT add to the totals again.
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/donations?select=id&paystack_reference=eq.${encodeURIComponent(reference)}&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!existingRes.ok) {
      const errText = await existingRes.text();
      console.error('Failed to check for existing donation:', errText);
      return res.status(500).json({ error: 'Failed to check donation history.' });
    }

    const existingRows = await existingRes.json();
    if (existingRows && existingRows.length > 0) {
      // We've already recorded this exact payment — do nothing, but
      // still return 200 so Paystack knows not to keep retrying.
      console.log(`Duplicate webhook for reference ${reference}, skipping.`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // ---- STEP 4: Fetch the current fundraiser row from Supabase ----
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/fundraiser?select=id,raised_amount,donor_count&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    const rows = await getRes.json();
    if (!rows || rows.length === 0) {
      console.error('No fundraiser row found in Supabase.');
      return res.status(500).json({ error: 'Fundraiser row not found.' });
    }

    const current = rows[0];
    const newRaisedAmount = Number(current.raised_amount) + amountPaid;
    const newDonorCount = Number(current.donor_count) + 1;

    // ---- STEP 5: Insert this donation into "donations" ----
    // The table's UNIQUE constraint on paystack_reference is our second,
    // database-level line of defense: even if two webhook deliveries
    // somehow raced past the check in STEP 3 at the same time, only one
    // of these inserts can succeed — the other will fail with a unique
    // violation, which we catch below and treat as a duplicate.
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/donations`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        paystack_reference: reference,
        amount: amountPaid,
        donor_email: donorEmail,
        fundraiser_id: current.id,
      }),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();

      // Postgres unique-violation error code is 23505. If that's what
      // happened here, another (near-simultaneous) webhook delivery for
      // the same reference already won the race and recorded the
      // donation — so we treat this as a duplicate rather than an error.
      if (errText.includes('23505') || errText.toLowerCase().includes('duplicate')) {
        console.log(`Duplicate donation insert for reference ${reference}, skipping totals update.`);
        return res.status(200).json({ received: true, duplicate: true });
      }

      console.error('Failed to insert donation record:', errText);
      return res.status(500).json({ error: 'Failed to record donation.' });
    }

    // ---- STEP 6: Update the fundraiser row with the new totals ----
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/fundraiser?id=eq.${current.id}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          raised_amount: newRaisedAmount,
          donor_count: newDonorCount,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('Failed to update Supabase:', errText);
      return res.status(500).json({ error: 'Failed to update fundraiser totals.' });
    }

    // ---- STEP 7: Tell Paystack we successfully handled the event ----
    return res.status(200).json({ received: true, updated: true });
  } catch (err) {
    console.error('Unexpected error handling webhook:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
