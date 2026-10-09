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
//   6. If the reference is new, we call ONE Postgres function
//      (record_donation_and_update_totals — see supabase.sql) that
//      atomically, in a single transaction: inserts the donation row
//      (gross amount, Paystack's fee, our platform fee, net amount,
//      donor details) AND credits that ONE campaign's raised_amount
//      (by the NET amount, never the gross) and donor_count. Either
//      both happen together, or — if anything fails — neither does;
//      there is no way to end up with a donation recorded but its
//      campaign never credited, or vice versa. Duplicate detection is
//      built into that same atomic call via the UNIQUE constraint on
//      paystack_reference.
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

import { hmacHex, timingSafeEqualHex } from '../lib/web-crypto.js';
import { jsonResponse } from '../lib/http.js';

// Cloudflare Workers hands this function the standard Web Request. Unlike
// the old Vercel version there is no body-parser to switch off and no
// Node stream to read: request.text() returns the body EXACTLY as Paystack
// sent it, and nothing in the router touches this request's body first.
// (Every other route goes through parseRequest(); this one deliberately
// does not — see src/index.js.)

export default async function handler(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }

  const PAYSTACK_SECRET_KEY = env.PAYSTACK_SECRET_KEY;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!PAYSTACK_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required environment variables.');
    return jsonResponse(500, { error: 'Server misconfigured.' });
  }

  // ---- STEP 1: Read the raw body and verify Paystack's signature ----
  const rawBody = await request.text();

  // Paystack signs every webhook with your SECRET key and sends the
  // signature in the "x-paystack-signature" header. We recompute the
  // same signature ourselves; if it doesn't match, we reject the
  // request because it did NOT genuinely come from Paystack.
  const expectedSignature = await hmacHex('SHA-512', PAYSTACK_SECRET_KEY, rawBody);

  const paystackSignature = request.headers.get('x-paystack-signature');

  // Constant-time comparison of the two hex signatures. A missing,
  // malformed, or wrong header all fail the same way.
  if (!paystackSignature || !timingSafeEqualHex(expectedSignature, paystackSignature)) {
    console.warn('Invalid Paystack webhook signature received.');
    return jsonResponse(401, { error: 'Invalid signature.' });
  }

  // ---- STEP 2: Parse the verified body ----
  const event = JSON.parse(rawBody);

  // We only care about successful charge events
  if (event.event !== 'charge.success') {
    // Acknowledge receipt so Paystack doesn't keep retrying, but do nothing
    return jsonResponse(200, { received: true, ignored: true });
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

  // ACTUAL amount Paystack sent to the beneficiary's subaccount for THIS
  // transaction, taken from Paystack's own charge.success payload:
  // event.data.fees_split.subaccount, in kobo (Paystack's transaction
  // object documents fees_split as { paystack, integration, subaccount,
  // params }, where "subaccount" is the subaccount's share after
  // Paystack's fee and our transaction_charge were applied). Nothing is
  // estimated or recomputed here, and the existing settlement behaviour
  // is untouched: Paystack already performed the split inside this same
  // transaction.
  //
  // It is 0 whenever no subaccount was used for this donation (our own
  // checkout metadata carries no subaccount_code), or whenever the
  // payload does not contain a usable numeric figure; in that last case
  // we log a warning rather than invent a number. The value is clamped
  // to [0, gross amount] so a malformed payload can never record more
  // than the donor paid.
  let settledAmount = 0;
  if (settledToSubaccount) {
    const shareRaw = event.data.fees_split && typeof event.data.fees_split === 'object' ? event.data.fees_split.subaccount : null;
    const shareKobo = typeof shareRaw === 'string' && shareRaw.trim() !== '' ? Number(shareRaw) : shareRaw;
    if (typeof shareKobo === 'number' && Number.isFinite(shareKobo) && shareKobo > 0) {
      settledAmount = Math.min(shareKobo / 100, amountPaid);
    } else {
      console.warn(
        `Donation ${event.data.reference} used subaccount ${settledToSubaccount} but the payload had no ` +
          `usable fees_split.subaccount figure; recording settled_amount as 0 rather than guessing.`
      );
    }
  }

  // The platform fee actually applied to this specific transaction, as
  // decided by /api/initialize-donation at the moment checkout began
  // (see the file header for why this is trusted here). Metadata values
  // can arrive as either a JSON number or a numeric string (Paystack's
  // metadata echo doesn't strictly preserve JS types in every case), so
  // this accepts both — but never trusts an invalid, non-finite, or
  // negative value: malformed metadata must never be able to produce an
  // unexpected or negative platform fee. Falls back to 0 in every one
  // of those cases, exactly like the Paystack fee fallback above.
  //
  // DEFENSIVE CAP: /api/initialize-donation already caps this at ₦1,000
  // (100,000 kobo) when it computes the fee. This webhook independently
  // re-enforces that same ₦1,000 cap on whatever value arrives in
  // metadata, as a second line of defense — so even a corrupted,
  // tampered, or buggy metadata payload can never credit more than
  // ₦1,000 as a platform fee for a single transaction. This does not
  // change how the fee is calculated; it only clamps an already-decided
  // value.
  const PLATFORM_FEE_CAP_KOBO = 100000; // ₦1,000
  const platformFeeRaw = event.data.metadata?.platform_fee_kobo;
  const platformFeeKoboParsed = typeof platformFeeRaw === 'string' ? Number(platformFeeRaw) : platformFeeRaw;
  const platformFeeKobo =
    typeof platformFeeKoboParsed === 'number' && Number.isFinite(platformFeeKoboParsed) && platformFeeKoboParsed >= 0
      ? Math.min(Math.round(platformFeeKoboParsed), PLATFORM_FEE_CAP_KOBO)
      : 0;
  const platformFee = platformFeeKobo / 100;

  const netAmount = netAmountBeforePlatformFee - platformFee;

  if (!reference) {
    console.error('Webhook payload is missing event.data.reference.');
    return jsonResponse(400, { error: 'Missing transaction reference.' });
  }

  try {
    // ---- STEP 3: Fetch the correct campaign's row from Supabase ----
    // This is a multi-campaign platform, so every donation MUST be
    // attributable to exactly one specific campaign. There is no
    // "default" campaign to fall back to — a webhook with a missing or
    // invalid fundraiser_id is rejected and logged rather than silently
    // credited to whichever campaign happens to be first in the table.
    if (!fundraiserId) {
      console.error(
        `Webhook for reference ${reference} is missing metadata.fundraiser_id — rejecting without crediting any campaign.`
      );
      return jsonResponse(400, { error: 'Missing fundraiser_id in transaction metadata.' });
    }

    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/fundraiser?select=id&id=eq.${encodeURIComponent(fundraiserId)}&limit=1`,
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
      return jsonResponse(500, { error: 'Failed to look up campaign.' });
    }

    const rows = await getRes.json();
    if (!rows || rows.length === 0) {
      console.error(
        `Webhook for reference ${reference} references fundraiser_id ${fundraiserId}, which does not exist — ` +
          `rejecting without crediting any campaign.`
      );
      return jsonResponse(400, { error: 'Campaign not found for this donation.' });
    }

    const current = rows[0];

    // ---- STEP 4: Record the donation AND credit the campaign, ATOMICALLY, IN ONE CALL ----
    // This used to be three separate steps: (1) check for an existing
    // donation with this reference, (2) insert the donation, (3) call a
    // separate RPC to increment raised_amount/donor_count. That closed
    // the concurrent-donation race, but left a different gap: if the
    // insert succeeded and the totals-update call then failed for any
    // reason, the donation would be permanently recorded while the
    // campaign was never credited for it — and Paystack's retry of the
    // same webhook would then be treated as a duplicate and silently
    // skipped, so the campaign would NEVER receive that money's credit.
    //
    // record_donation_and_update_totals (see supabase.sql) does both the
    // insert AND the credit inside ONE PostgreSQL function call, which
    // PostgREST runs as a single transaction — if anything inside it
    // fails, the ENTIRE thing (donation insert included) rolls back
    // automatically. There is no way to end up with a recorded donation
    // whose campaign total was never updated.
    //
    // Duplicate detection is now "insert ... on conflict (paystack_reference)
    // do nothing" inside that same function — the UNIQUE constraint makes
    // it part of the same atomic statement, closing even the small race
    // window that existed before between a separate "does it exist?"
    // check and the insert that followed it.
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_donation_and_update_totals`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_fundraiser_id: current.id,
        p_paystack_reference: reference,
        p_amount: amountPaid, // gross amount the donor paid
        p_paystack_fee: paystackFee,
        p_platform_fee: platformFee,
        p_net_amount: netAmount,
        p_donor_name: donorName,
        p_donor_email: donorEmail,
        p_anonymous: isAnonymous,
        p_settled_to_subaccount: settledToSubaccount,
        p_settled_amount: settledAmount,
      }),
    });

    if (!rpcRes.ok) {
      const errText = await rpcRes.text();
      console.error('Failed to atomically record donation and update fundraiser totals:', errText);
      return jsonResponse(500, { error: 'Failed to record donation.' });
    }

    const rpcRows = await rpcRes.json();
    const result = rpcRows[0];

    if (result?.is_duplicate) {
      // A donation with this exact Paystack reference already existed —
      // acknowledge with 200 OK (so Paystack stops retrying) but confirm
      // nothing was credited a second time.
      console.log(`Duplicate webhook for reference ${reference}, skipping — totals unchanged.`);
      return jsonResponse(200, { received: true, duplicate: true });
    }

    // ---- STEP 5: Tell Paystack we successfully handled the event ----
    return jsonResponse(200, { received: true, updated: true });
  } catch (err) {
    console.error('Unexpected error handling webhook:', err);
    return jsonResponse(500, { error: 'Unexpected server error.' });
  }
}
