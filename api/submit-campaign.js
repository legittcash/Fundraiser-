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

async function rollbackCampaign(SUPABASE_URL, headers, campaignId, imageUrl) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/fundraiser?id=eq.${campaignId}`, { method: 'DELETE', headers });
  } catch (err) {
    console.error(`Failed to roll back pending campaign ${campaignId}:`, err);
  }
  if (imageUrl) {
    const cleanup = await deleteCampaignImage(imageUrl);
    if (!cleanup.skipped && !cleanup.deleted) {
      console.error(
        `Rolled-back submission's photo could not be removed from storage. Manual cleanup needed ` +
          `in Supabase Storage (bucket "campaign-images"): ${imageUrl}. Storage error: ${cleanup.error}`
      );
    }
  }
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
  if (!patientName) return res.status(400).json({ error: 'Patient name is required.' });

  const goalAmount = Number(body.goal_amount);
  if (!Number.isFinite(goalAmount) || goalAmount <= 0) {
    return res.status(400).json({ error: 'A valid fundraising goal is required.' });
  }

  const phoneNumber = (body.phone_number || '').trim();
  if (!phoneNumber) {
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
    return res.status(400).json({
      error: 'Beneficiary name, bank, and account number are all required so the campaign can be reviewed.',
    });
  }

  // ---- Optional photo upload ----
  let imageUrl = null;
  if (body.fileBase64 && body.contentType) {
    const uploadResult = await uploadCampaignImage(body.fileBase64, body.contentType);
    if (!uploadResult.ok) {
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
    console.warn(
      `Visitor submission insert attempt ${attempt}/${MAX_SLUG_ATTEMPTS} failed` +
        (isSlugCollision ? ' due to a slug collision — retrying with a new slug.' : '.'),
      lastErrorText
    );
    if (!isSlugCollision) break;
  }

  if (!created) {
    console.error('Failed to create visitor-submitted campaign after retries:', lastErrorText);
    if (imageUrl) {
      const cleanup = await deleteCampaignImage(imageUrl);
      if (!cleanup.skipped && !cleanup.deleted) {
        console.error(
          `Visitor submission failed AND its uploaded photo could not be rolled back automatically. ` +
            `Manual cleanup needed in Supabase Storage (bucket "campaign-images"): ${imageUrl}. ` +
            `Storage error: ${cleanup.error}`
        );
      }
    }
    return res.status(500).json({ error: 'Something went wrong saving your submission. Please try again.' });
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
    console.error('Failed to create beneficiary for visitor submission, rolling back campaign:', beneficiaryResult.error);
    await rollbackCampaign(SUPABASE_URL, headers, campaign.id, imageUrl);
    return res.status(500).json({ error: 'Something went wrong saving your payout details. Please try again.' });
  }

  return res.status(201).json({
    success: true,
    message: 'Thank you! Your campaign has been submitted and is pending review by our team.',
  });
}
