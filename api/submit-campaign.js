// api/submit-campaign.js
//
// Public endpoint behind the homepage's "Start a Fundraiser" button
// (submit-campaign.html). Lets any visitor submit a new patient
// campaign, together with the beneficiary/payout details needed to pay
// that patient out later — WITHOUT publishing anything immediately.
//
//   POST /api/submit-campaign
//   {
//     patient_name, hospital, diagnosis, story, goal_amount,
//     phone_number, secondary_phone_number,
//     fileBase64, contentType,               // photo, optional
//     beneficiary_name, bank_code, bank_name, account_number,
//     beneficiary_phone, beneficiary_secondary_phone
//   }
//
// EVERY visitor submission starts as:
//   fundraiser.status              = 'pending'   (never publicly listed,
//                                                  never shows a working
//                                                  donate button — both
//                                                  already true of any
//                                                  non-'active' campaign
//                                                  in the existing code)
//   beneficiary.verification_status = 'pending'  (the table's own default)
//   beneficiary.settlement_enabled  = false      (the table's own default)
//   beneficiary.paystack_subaccount_code = null  (the table's own default)
//
// A visitor has NO way, through this endpoint or any other public one,
// to set any of those to anything else. Only an authenticated admin,
// through the existing api/admin/campaigns.js (approve/reject) and
// api/admin/beneficiaries.js (verify/enable settlement) endpoints, can
// ever move a submission out of this fully-inert starting state. This
// endpoint reuses that same campaign/beneficiary creation logic (via
// lib/beneficiary.js and lib/campaign-images.js) rather than
// reimplementing it — the only difference from the admin's combined
// creation flow is the starting status ('pending' here vs 'active'
// there) and that no admin session is required to call it.
//
// This file does NOT touch donations, Paystack, or payment processing
// in any way — it only ever creates a fundraiser + beneficiary row pair
// that starts completely inert.

import crypto from 'crypto';
import { uploadCampaignImage, deleteCampaignImage } from '../lib/campaign-images.js';
import { insertBeneficiary } from '../lib/beneficiary.js';

function getSupabaseConfig() {
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
}

function supabaseHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Same slug generator already used by api/admin/campaigns.js. Kept as
// its own small copy here rather than a shared import — it's a tiny,
// pure, ~8-line utility with no state, so duplicating it is simpler and
// safer than adding a cross-file dependency just for this.
function generateSlug(patientName) {
  const base = String(patientName || 'patient')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const randomSuffix = crypto.randomBytes(5).toString('hex');
  return `${base || 'patient'}-${randomSuffix}`;
}

// Short, non-sensitive reference code included in error responses so a
// visitor can quote it to support, and an admin can grep Vercel's logs
// for the matching `[submit-campaign:...] ref=<code>` line to see the
// FULL diagnostic detail (including the raw Supabase error text) —
// without ever putting that raw detail into the public HTTP response
// itself, which could otherwise leak internal schema/query details.
function makeErrorRef() {
  return crypto.randomBytes(4).toString('hex');
}

// Uniform stage-labeled logger, per the four stages this endpoint can
// fail at: validation, image upload, fundraiser insert, beneficiary
// insert. Always goes to console.error (visible in Vercel's function
// logs) so failures at every stage are easy to find, not just the ones
// that already happened to log something.
function logStage(stage, message, details) {
  if (details !== undefined) {
    console.error(`[submit-campaign:${stage}] ${message}`, details);
  } else {
    console.error(`[submit-campaign:${stage}] ${message}`);
  }
}

// Rolls back a just-created 'pending' campaign after its beneficiary
// failed to save. IMPORTANT: fetch() only rejects on a genuine network
// error — an HTTP error status (403, 500, etc.) comes back as a normal
// resolved response with response.ok === false. The previous version of
// this function never checked response.ok, so a rollback that failed at
// the HTTP level (as opposed to a thrown network error) was silently
// treated as if it had succeeded, potentially leaving an orphaned
// 'pending' campaign behind with no beneficiary and no record that
// cleanup had failed. This version checks response.ok explicitly and
// reports the real outcome.
async function rollbackCampaign(SUPABASE_URL, headers, campaignId, imageUrl, ref) {
  let campaignDeleted = false;
  try {
    const deleteRes = await fetch(`${SUPABASE_URL}/rest/v1/fundraiser?id=eq.${campaignId}`, {
      method: 'DELETE',
      headers,
    });
    if (deleteRes.ok) {
      campaignDeleted = true;
    } else {
      const errText = await deleteRes.text();
      logStage(
        'rollback',
        `ref=${ref} Failed to roll back pending campaign ${campaignId} after its beneficiary failed to save — HTTP ${deleteRes.status}. This campaign row is now ORPHANED (no beneficiary) and needs manual cleanup in Supabase.`,
        errText
      );
    }
  } catch (err) {
    logStage(
      'rollback',
      `ref=${ref} Network error rolling back pending campaign ${campaignId}. This campaign row may now be ORPHANED (no beneficiary) and needs manual cleanup in Supabase.`,
      err.message || String(err)
    );
  }

  if (campaignDeleted && imageUrl) {
    const cleanup = await deleteCampaignImage(imageUrl);
    if (!cleanup.skipped && !cleanup.deleted) {
      logStage(
        'rollback',
        `ref=${ref} Campaign ${campaignId} was rolled back, but its photo could not be removed from storage. Manual cleanup needed in Supabase Storage (bucket "campaign-images"): ${imageUrl}.`,
        cleanup.error
      );
    }
  }

  return { campaignDeleted };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseConfig();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }
  const headers = supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY);

  const body = req.body || {};

  // ---- Validate campaign fields ----
  const patientName = (body.patient_name || '').trim();
  if (!patientName) {
    logStage('validation', 'Rejected — missing patient_name.');
    return res.status(400).json({ error: 'Patient name is required.' });
  }

  const goalAmount = Number(body.goal_amount);
  if (!Number.isFinite(goalAmount) || goalAmount <= 0) {
    logStage('validation', 'Rejected — invalid goal_amount.', body.goal_amount);
    return res.status(400).json({ error: 'A valid fundraising goal is required.' });
  }

  const phoneNumber = (body.phone_number || '').trim();
  if (!phoneNumber) {
    logStage('validation', 'Rejected — missing phone_number.');
    return res.status(400).json({ error: 'A primary contact phone number is required.' });
  }
  const secondaryPhoneNumber = (body.secondary_phone_number || '').trim() || null;

  // ---- Validate beneficiary fields ----
  // Required here, unlike the admin's combined form — a visitor
  // submission with no payout details at all wouldn't be reviewable, so
  // this endpoint asks for them up front.
  const beneficiaryName = (body.beneficiary_name || '').trim();
  const bankCode = body.bank_code;
  const accountNumber = (body.account_number || '').trim();
  if (!beneficiaryName || !bankCode || !accountNumber) {
    logStage('validation', 'Rejected — missing beneficiary_name, bank_code, or account_number.', {
      hasBeneficiaryName: !!beneficiaryName,
      hasBankCode: !!bankCode,
      hasAccountNumber: !!accountNumber,
    });
    return res.status(400).json({
      error: 'Beneficiary name, bank, and account number are all required so the campaign can be reviewed.',
    });
  }

  // ---- Optional photo upload ----
  let imageUrl = null;
  if (body.fileBase64 && body.contentType) {
    // Defensive guard against exactly the failure mode reported in
    // production (TypeError: uploadCampaignImage is not a function).
    // Source-level inspection confirms lib/campaign-images.js DOES
    // export a callable uploadCampaignImage — api/admin/campaigns.js
    // imports the same function from the same file the same way, and
    // that path is confirmed working — so this should never actually
    // trip. It exists so that IF a future refactor ever breaks this
    // export, or a stale/partial deployment ever serves a build without
    // it, the failure is a clear, logged, diagnosable 500 instead of an
    // unhandled TypeError crashing the function with no context.
    if (typeof uploadCampaignImage !== 'function') {
      const ref = makeErrorRef();
      logStage(
        'image upload',
        `ref=${ref} uploadCampaignImage is not available as a function (got: ${typeof uploadCampaignImage}). ` +
          `This points to a stale/partial deployment of lib/campaign-images.js — redeploy with the build cache cleared.`
      );
      return res.status(500).json({
        error: 'Photo upload is temporarily unavailable. Please try again without a photo, or contact support with the reference code below.',
        reference: ref,
      });
    }

    const uploadResult = await uploadCampaignImage(body.fileBase64, body.contentType);
    if (!uploadResult.ok) {
      logStage('image upload', `Failed — HTTP ${uploadResult.status || 500}.`, uploadResult.error);
      return res.status(uploadResult.status || 500).json({ error: uploadResult.error });
    }
    imageUrl = uploadResult.url;
  }

  // ---- Create the campaign, status 'pending' ----
  const MAX_SLUG_ATTEMPTS = 5;
  let created = null;
  let lastErrorText = '';

  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    const newCampaign = {
      patient_name: patientName,
      hospital: body.hospital || null,
      diagnosis: body.diagnosis || null,
      story: body.story || null,
      image_url: imageUrl,
      phone_number: phoneNumber,
      secondary_phone_number: secondaryPhoneNumber,
      goal_amount: goalAmount,
      raised_amount: 0,
      donor_count: 0,
      status: 'pending', // NEVER 'active' — only an admin approval can change this
      slug: generateSlug(patientName),
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/fundraiser`, {
      method: 'POST',
      headers: supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY, { Prefer: 'return=representation' }),
      body: JSON.stringify(newCampaign),
    });

    if (response.ok) {
      created = await response.json();
      break;
    }

    lastErrorText = await response.text();
    const isSlugCollision = lastErrorText.includes('fundraiser_slug_key') || lastErrorText.includes('23505');
    logStage(
      'fundraiser insert',
      `Attempt ${attempt}/${MAX_SLUG_ATTEMPTS} failed — HTTP ${response.status}` +
        (isSlugCollision ? ' (slug collision — retrying with a new slug).' : '.'),
      lastErrorText
    );
    if (!isSlugCollision) break;
  }

  if (!created) {
    const ref = makeErrorRef();
    logStage(
      'fundraiser insert',
      `ref=${ref} Failed to create visitor-submitted campaign after ${MAX_SLUG_ATTEMPTS} attempt(s). Full Supabase response body follows.`,
      lastErrorText
    );
    if (imageUrl) {
      const cleanup = await deleteCampaignImage(imageUrl);
      if (!cleanup.skipped && !cleanup.deleted) {
        logStage(
          'fundraiser insert',
          `ref=${ref} Visitor submission failed AND its uploaded photo could not be rolled back automatically. Manual cleanup needed in Supabase Storage (bucket "campaign-images"): ${imageUrl}.`,
          cleanup.error
        );
      }
    }
    // Don't send the raw Supabase error text to a public, unauthenticated
    // caller — it can contain internal column/constraint names. Send a
    // safe reference code instead; the full detail is in the server log
    // line above (`ref=${ref}`) for a developer/admin to look up.
    return res.status(500).json({
      error: 'Something went wrong saving your submission. Please try again, or contact support with the reference code below.',
      reference: ref,
    });
  }

  const campaign = created[0];

  // ---- Create the linked beneficiary — always fully inert (pending
  // verification, settlement disabled, no Paystack subaccount) ----
  const beneficiaryResult = await insertBeneficiary(
    { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY },
    {
      fundraiserId: campaign.id,
      beneficiaryName,
      bankCode,
      bankName: body.bank_name || null,
      accountNumber,
      primaryPhoneNumber: body.beneficiary_phone || null,
      secondaryPhoneNumber: body.beneficiary_secondary_phone || null,
    }
  );

  if (!beneficiaryResult.ok) {
    const ref = makeErrorRef();
    logStage(
      'beneficiary insert',
      `ref=${ref} Failed to create beneficiary for fundraiser ${campaign.id} — rolling back the campaign. Full Supabase response body follows.`,
      beneficiaryResult.error
    );
    const rollbackOutcome = await rollbackCampaign(SUPABASE_URL, headers, campaign.id, imageUrl, ref);
    if (!rollbackOutcome.campaignDeleted) {
      logStage(
        'beneficiary insert',
        `ref=${ref} ROLLBACK DID NOT SUCCEED — fundraiser ${campaign.id} is still in the database with no beneficiary and needs manual review/cleanup.`
      );
    }
    // Same reasoning as the fundraiser-insert failure above: a safe
    // reference code goes to the visitor, the raw Supabase error and the
    // rollback outcome are both in the server log next to `ref=${ref}`.
    return res.status(500).json({
      error: 'Something went wrong saving your payout details. Please try again, or contact support with the reference code below.',
      reference: ref,
    });
  }

  return res.status(201).json({
    success: true,
    message: 'Thank you! Your campaign has been submitted and is pending review by our team.',
  });
}
