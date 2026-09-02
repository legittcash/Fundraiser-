// api/paystack-webhook.js
//
// This is a Vercel Serverless Function that Paystack calls automatically
// every time something happens on your Paystack account (e.g. a
// successful payment). This is the ONLY place we trust to confirm that
// a payment really happened — never the frontend, since a browser can
// be tampered with.
//
// Flow:
//   1. A donor starts a donation on campaign.html, which calls
//      /api/initialize-donation (our OWN server). That endpoint — never
//      the browser — decides the final settlement subaccount and
//      platform fee, then asks Paystack to create the transaction and
//      hands the browser a redirect URL to Paystack's hosted checkout.
//   2. Paystack's servers send a POST request to this URL once payment
//      completes:
//        https://your-site.vercel.app/api/paystack-webhook
//   3. We verify the request really came from Paystack (using a
//      cryptographic signature check).
//   4. If it's a genuine "successful charge" event, we FIRST check
//      whether we've already recorded this exact payment before (using
//      Paystack's unique "reference" for the transaction). Paystack can
//      send the same webhook more than once (e.g. if our server is slow
//      to respond, or due to a network retry) — without this check we'd
//      add the same donation to the total twice.
//   5. We then work out WHICH campaign this donation belongs to. That,
//      along with the donor's name/email/anonymity choice, the
//      settlement subaccount actually used, and the platform fee actually
//      applied, all travel in the transaction's metadata — set entirely
//      by /api/initialize-donation (our trusted server), never by the
//      browser — and Paystack echoes that same metadata back to us here.
//      A donation with a missing or unrecognized fundraiser_id is
//      rejected and logged, never credited to any campaign — there is
//      no "default" campaign on a multi-campaign platform.
//   6. If the reference is new, we insert a row into "donations" (which
//      has a UNIQUE constraint on paystack_reference as a second line of
//      defense) — including gross amount, Paystack's fee, our platform
//      fee, and the resulting net amount — and only then update that ONE
//      campaign's row in Supabase: add the NET amount (never the gross)
//      to raised_amount, add 1 to donor_count.
//   7. The next time the frontend calls /api/progress for that campaign,
//      it will see the new, updated numbers.
//
// FEE ACCOUNTING:
// Paystack's charge.success webhook payload includes a documented
// "fees" field (an integer in kobo, same unit as "amount") — this is
// Paystack's own reported transaction fee for that specific payment, not
// a fixed or guessed percentage. We use that field directly:
//   gross amount  = event.data.amount
//   Paystack fee  = event.data.fees
//   platform fee  = event.data.metadata.platform_fee_kobo (see below)
//   net amount    = gross amount - Paystack fee - platform fee
// If a specific webhook payload is ever missing the "fees" field
// (uncommon, but not something to assume never happens across every
// payment channel), we fall back to treating the fee as 0 for that one
// payment rather than inventing a number — see the comment at
// PAYSTACK_FEE below.
//
// PLATFORM FEE — WHY METADATA IS TRUSTED HERE (AND WHY THIS IS SAFE):
// The platform fee actually charged on a transaction is fixed the
// moment /api/initialize-donation calls Paystack (it's what gets passed
// as "transaction_charge", which Paystack applies immediately as part of
// the split). That value is NEVER supplied by the browser — the browser
// only ever sends a donor name/email/amount to /api/initialize-donation;
// the fee itself is computed entirely server-side from the CURRENT
// platform-fee master switch at that moment. Reading it back out of
// metadata here is just retrieving OUR OWN server's earlier decision,
// via the same trusted metadata echo already relied on for
// fundraiser_id/donor_name — it is not trusting anything the browser
// said. This also has to come from metadata rather than being
// recomputed fresh in this webhook, because the master switch could have
// been toggled between initialization and webhook delivery — recomputing
// here could silently drift from what Paystack actually split, which
// would corrupt the accounting.

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
  const amountPaid = event.data.amount / 100; // GROSS amount the donor paid

  // Paystack's own reported transaction fee for THIS specific payment,
  // taken from the documented "fees" field in the charge.success webhook
  // payload (also in kobo). This is never a fixed percentage or a
  // hard-coded number — it's exactly what Paystack tells us it charged.
  // In the rare case a payload doesn't include it, we fall back to 0
  // for that one payment rather than fabricate a figure; this means
  // net_amount would equal the gross amount for that donation only.
  const feesRaw = event.data.fees;
  const paystackFee = typeof feesRaw === 'number' ? feesRaw / 100 : 0;
  if (typeof feesRaw !== 'number') {
    console.warn(
      `charge.success payload for reference ${event.data.reference} had no numeric "fees" field — ` +
        `treating the Paystack fee as 0 for this donation.`
    );
  }

  // What the campaign actually receives after Paystack's cut. This is
  // the figure that updates raised_amount — never the gross amount.
  // (Platform fee, if any, is subtracted further down once we've read
  // it from metadata below.)
  const netAmountBeforePlatformFee = amountPaid - paystackFee;

  // Paystack's unique reference for this specific transaction. This is
  // the key we use to detect duplicate/retried webhook deliveries.
  const reference = event.data.reference;

  // Which campaign this donation is for. campaign.html sets this as
  // metadata.fundraiser_id when it opens the Paystack popup, and
  // Paystack sends that same metadata back to us here.
  const fundraiserId = event.data.metadata?.fundraiser_id || null;

  // Donor name is required on the form, so it always travels in metadata.
  const donorName = event.data.metadata?.donor_name || null;

  // Email is OPTIONAL for the donor. Paystack's checkout still requires
  // *some* email string to initialize a transaction, so when the donor
  // leaves it blank, campaign.html sends Paystack a harmless placeholder
  // address instead (see campaign.html). That placeholder must never be
  // saved as if it were the donor's real email — so we read the donor's
  // actual, possibly-empty input back out of metadata.donor_email rather
  // than trusting event.data.customer.email.
  const donorEmail = event.data.metadata?.donor_email || null;

  // "Donate anonymously" checkbox — also travels in metadata.
  const isAnonymous = event.data.metadata?.anonymous === true || event.data.metadata?.anonymous === 'true';

  // Which Paystack subaccount (if any) was active for this campaign at
  // the moment of checkout — decided entirely by /api/initialize-donation
  // (our server), never the browser. Stored purely as an audit trail; it
  // never affects the fee/net accounting above, and the actual
  // settlement split (if any) already happened automatically as part of
  // THIS SAME Paystack transaction — our server never issues any
  // separate "settle this donation" call that could be duplicated.
  const settledToSubaccount = event.data.metadata?.subaccount_code || null;

  // The platform fee actually applied to this specific transaction, as
  // decided by /api/initialize-donation at the moment checkout began
  // (see the file header for why this is trusted here). Falls back to 0
  // if missing, exactly like the Paystack fee fallback above.
  const platformFeeRaw = event.data.metadata?.platform_fee_kobo;
  const platformFee = typeof platformFeeRaw === 'number' ? platformFeeRaw / 100 : 0;

  const netAmount = netAmountBeforePlatformFee - platformFee;

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

    // ---- STEP 4: Fetch the correct campaign's row from Supabase ----
    // This is a multi-campaign platform, so every donation MUST be
    // attributable to exactly one specific campaign. There is no
    // "default" campaign to fall back to — a webhook with a missing or
    // invalid fundraiser_id is rejected and logged rather than silently
    // credited to whichever campaign happens to be first in the table.
    // (An earlier version of this file fell back to the first campaign,
    // which made sense only when this was a single-campaign site; now
    // that many independent campaigns exist, that fallback would risk
    // crediting the wrong patient entirely, so it's been removed.)
    if (!fundraiserId) {
      console.error(
        `Webhook for reference ${reference} is missing metadata.fundraiser_id — rejecting without crediting any campaign.`
      );
      return res.status(400).json({ error: 'Missing fundraiser_id in transaction metadata.' });
    }

    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/fundraiser?select=id,raised_amount,donor_count&id=eq.${encodeURIComponent(fundraiserId)}&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!getRes.ok) {
      const errText = await getRes.text();
      console.error('Supabase error looking up fundraiser:', errText);
      return res.status(500).json({ error: 'Failed to look up campaign.' });
    }

    const rows = await getRes.json();
    if (!rows || rows.length === 0) {
      console.error(
        `Webhook for reference ${reference} references fundraiser_id ${fundraiserId}, which does not exist — ` +
          `rejecting without crediting any campaign.`
      );
      return res.status(400).json({ error: 'Campaign not found for this donation.' });
    }

    const current = rows[0];
    // IMPORTANT: the campaign's raised_amount increases by the NET
    // amount (after Paystack's fee), never the gross amount the donor
    // paid — that's the whole point of this accounting change.
    const newRaisedAmount = Number(current.raised_amount) + netAmount;
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
        amount: amountPaid, // gross amount the donor paid
        paystack_fee: paystackFee,
        platform_fee: platformFee,
        net_amount: netAmount,
        donor_name: donorName,
        donor_email: donorEmail,
        anonymous: isAnonymous,
        fundraiser_id: current.id,
        settled_to_subaccount: settledToSubaccount,
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
