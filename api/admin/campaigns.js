// api/admin/campaigns.js
//
// Protected CRUD endpoint for managing patient campaigns from the admin
// dashboard. Every request here must include a valid admin session
// cookie (checked by lib/admin-auth.js) or it's rejected with 401.
//
// Supported requests:
//   GET    /api/admin/campaigns              -> list every campaign (active + archived + pending + rejected)
//   GET    /api/admin/campaigns?search=lucy  -> list campaigns whose name matches
//   POST   /api/admin/campaigns              -> create a new campaign TOGETHER WITH its beneficiary
//   PATCH  /api/admin/campaigns?id=123       -> edit an existing campaign (also used for approve/reject/archive/reactivate)
//   DELETE /api/admin/campaigns?id=123       -> permanently delete a campaign
//
// COMBINED CAMPAIGN + BENEFICIARY CREATION: the admin "+ New Campaign"
// form always includes beneficiary/payout fields (beneficiary_name,
// bank_code, bank_name, account_number, and the two phone numbers)
// alongside the campaign fields, in the SAME POST body — beneficiary
// name, bank, and account number are REQUIRED, exactly like the public
// visitor submission flow (api/submit-campaign.js) already requires
// them. This endpoint validates all of that FIRST, before creating
// anything, then creates the campaign, then creates the linked
// beneficiary row (via lib/beneficiary.js) using the new campaign's id.
// If the beneficiary insert still fails for some other reason after the
// campaign was created (a genuine database error, not missing input),
// the campaign row (and its uploaded photo) are rolled back — the same
// compensating-rollback pattern already used elsewhere in this file for
// a failed slug-collision retry — so a submission never ends up
// half-created (a campaign with no beneficiary, or vice versa).
// The beneficiary created this way ALWAYS starts as 'pending'
// verification with settlement disabled and no Paystack subaccount —
// exactly like a beneficiary created through the existing standalone
// "Beneficiary" admin form. Only the existing verification workflow
// (api/admin/beneficiaries.js) can ever change that.
//
// This file ALSO absorbs what used to be two separate files —
// api/admin/analytics.js and api/admin/upload-image.js — via a `route`
// query parameter, purely to reduce the total number of Vercel
// Serverless Functions (Vercel's Hobby plan caps a deployment at 12).
// Their actual LOGIC is unchanged from those original files:
//
//   GET  /api/admin/campaigns?route=analytics      -> dashboard overview numbers
//   POST /api/admin/campaigns?route=upload-image    { fileBase64, contentType } -> uploads a photo
//
// Note: "raised_amount" and "donor_count" are intentionally never
// accepted from the request body on create/edit — those two fields are
// read-only from the admin's point of view and are only ever changed by
// the Paystack webhook after a real, verified donation.

import crypto from 'crypto';
import { rejectIfNotAdmin } from '../../lib/admin-auth.js';
import campaignImages from '../../lib/campaign-images.js';
// Destructured once, right here, from the module's single default
// export — every call site below (uploadCampaignImage(...),
// deleteCampaignImage(...)) is unchanged; only how they're obtained
// from lib/campaign-images.js changed. See the comment at the bottom of
// that file for why.
const { uploadCampaignImage, deleteCampaignImage } = campaignImages;
import { insertBeneficiary } from '../../lib/beneficiary.js';

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

// Turn "Lucy Adebayo" into something like "lucy-adebayo-a1b2c3d4e5" — a
// clean, unique, URL-friendly identifier for the campaign's public page.
//
// Uses 5 random bytes (10 hex characters = ~1.1 trillion combinations).
// The original version of this used only 3 bytes (~16.7 million
// combinations), which was fine at small scale but caused occasional
// duplicate-slug collisions once hundreds of campaigns existed — that
// collision was exactly what caused campaign creation to intermittently
// fail right after a successful photo upload. The POST handler below
// also retries on a slug collision, as a second line of defense.
function generateSlug(patientName) {
  const base = String(patientName || 'patient')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const randomSuffix = crypto.randomBytes(5).toString('hex');
  return `${base || 'patient'}-${randomSuffix}`;
}

// Deletes a just-created campaign row (and, best-effort, its uploaded
// photo) — used to roll back a combined campaign+beneficiary creation
// when the campaign succeeded but the beneficiary failed, so a
// submission never ends up half-created. Deleting the fundraiser row
// also removes any beneficiary row already inserted for it, via the
// existing "on delete cascade" foreign key — though in the normal
// failure path here, the beneficiary insert is what failed, so there's
// usually nothing there to cascade yet.
async function rollbackCampaign(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, headers, campaign, imageUrl) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/fundraiser?id=eq.${campaign.id}`, {
      method: 'DELETE',
      headers,
    });
  } catch (err) {
    console.error(`Failed to roll back campaign ${campaign.id} after a linked beneficiary failure:`, err);
  }

  if (imageUrl) {
    const cleanup = await deleteCampaignImage(imageUrl);
    if (!cleanup.skipped && !cleanup.deleted) {
      console.error(
        `Rolled-back campaign's photo could not be removed from storage. Manual cleanup needed ` +
          `in Supabase Storage (bucket "campaign-images"): ${imageUrl}. Storage error: ${cleanup.error}`
      );
    }
  }
}

// =========================================================================
// route=analytics — from the original api/admin/analytics.js
// =========================================================================
async function handleAnalytics(req, res, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const campaignsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/fundraiser?select=id,raised_amount,donor_count,status`,
      { headers }
    );
    if (!campaignsRes.ok) {
      console.error('Supabase error:', await campaignsRes.text());
      return res.status(500).json({ error: 'Failed to load campaign totals.' });
    }
    const campaigns = await campaignsRes.json();

    const totalPatients = campaigns.length;
    const activeCampaigns = campaigns.filter((c) => c.status === 'active').length;
    const totalRaised = campaigns.reduce((sum, c) => sum + Number(c.raised_amount || 0), 0);
    const totalDonors = campaigns.reduce((sum, c) => sum + Number(c.donor_count || 0), 0);

    const financialsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/donations?select=amount,paystack_fee,platform_fee`,
      { headers }
    );
    let totalGrossDonations = 0;
    let totalPaystackFees = 0;
    let totalPlatformFees = 0;
    if (financialsRes.ok) {
      const allDonations = await financialsRes.json();
      totalGrossDonations = allDonations.reduce((sum, d) => sum + Number(d.amount || 0), 0);
      totalPaystackFees = allDonations.reduce((sum, d) => sum + Number(d.paystack_fee || 0), 0);
      totalPlatformFees = allDonations.reduce((sum, d) => sum + Number(d.platform_fee || 0), 0);
    } else {
      console.error('Supabase error fetching donation financials:', await financialsRes.text());
    }

    // The nested `fundraiser:fundraiser_id(patient_name)` embed relies on
    // PostgREST correctly recognizing the donations -> fundraiser foreign
    // key relationship. That embed can fail on its own (e.g. after a
    // schema-cache reload, an ambiguous relationship name, or a transient
    // PostgREST hiccup) even when the plain "donations" table is perfectly
    // queryable. Rather than let a failure here take down the WHOLE
    // analytics endpoint (which also returns totals used elsewhere on the
    // dashboard), we fall back to fetching donations and fundraiser names
    // as two separate, simpler requests and merging them in JS.
    let recentDonations = [];
    const recentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/donations?select=id,amount,paystack_fee,platform_fee,net_amount,donor_name,donor_email,anonymous,created_at,fundraiser:fundraiser_id(patient_name)&order=created_at.desc&limit=10`,
      { headers }
    );

    if (recentRes.ok) {
      recentDonations = await recentRes.json();
    } else {
      console.error(
        'Supabase error fetching recent donations with the nested fundraiser embed — falling back to a separate patient-name lookup:',
        await recentRes.text()
      );

      // ---- SAFE FALLBACK ----
      // 1) Fetch recent donations WITHOUT the nested relationship.
      const fallbackRes = await fetch(
        `${SUPABASE_URL}/rest/v1/donations?select=id,amount,paystack_fee,platform_fee,net_amount,donor_name,donor_email,anonymous,created_at,fundraiser_id&order=created_at.desc&limit=10`,
        { headers }
      );

      if (!fallbackRes.ok) {
        // Both the embedded query AND the plain fallback query failed —
        // something is actually wrong with the donations table/connection,
        // not just the embed. Log it and continue with an empty list
        // rather than failing the whole analytics endpoint.
        console.error('Supabase error fetching recent donations (fallback also failed):', await fallbackRes.text());
      } else {
        const donations = await fallbackRes.json();

        // 2) Collect the distinct fundraiser_id values referenced by
        // these donations.
        const fundraiserIds = [...new Set(donations.map((d) => d.fundraiser_id).filter((id) => id != null))];

        // 3) Fetch matching fundraiser patient names separately.
        let patientNameById = {};
        if (fundraiserIds.length > 0) {
          const fundraisersRes = await fetch(
            `${SUPABASE_URL}/rest/v1/fundraiser?select=id,patient_name&id=in.(${fundraiserIds.join(',')})`,
            { headers }
          );
          if (fundraisersRes.ok) {
            const fundraisers = await fundraisersRes.json();
            patientNameById = Object.fromEntries(fundraisers.map((f) => [f.id, f.patient_name]));
          } else {
            console.error(
              'Supabase error fetching fundraiser patient names for the recent-donations fallback:',
              await fundraisersRes.text()
            );
          }
        }

        // 4) Merge patient_name back in, in the same shape the nested
        // embed would have produced (donation.fundraiser.patient_name),
        // so the admin dashboard's renderDonations() doesn't need to
        // know which path was taken.
        recentDonations = donations.map((d) => ({
          ...d,
          fundraiser: { patient_name: patientNameById[d.fundraiser_id] ?? null },
        }));
      }
    }

    return res.status(200).json({
      total_patients: totalPatients,
      active_campaigns: activeCampaigns,
      total_raised: totalRaised,
      total_donors: totalDonors,
      total_gross_donations: totalGrossDonations,
      total_paystack_fees: totalPaystackFees,
      total_platform_fees: totalPlatformFees,
      recent_donations: recentDonations,
    });
  } catch (err) {
    console.error('Unexpected error fetching analytics:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}

// =========================================================================
// route=upload-image — now a thin wrapper around the shared
// lib/campaign-images.js uploadCampaignImage() helper, which is also
// used by the public api/submit-campaign.js endpoint. This used to
// duplicate the full upload implementation here; it's now the single
// shared implementation instead.
// =========================================================================
async function handleUploadImage(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Defensive guard against an import/export or bundling problem making
  // this shared helper uncallable — mirrors the same guard in
  // api/submit-campaign.js, which imports this exact function from this
  // exact file the exact same way. Both entry points now fail the same
  // safe, diagnosable way instead of an unhandled TypeError if this ever
  // genuinely happens (e.g. a future refactor breaking the export).
  if (typeof uploadCampaignImage !== 'function') {
    console.error(
      `[admin/campaigns:upload-image] uploadCampaignImage is not available as a function (got: ${typeof uploadCampaignImage}). ` +
        `This points to a broken import from lib/campaign-images.js or a stale/partial deployment.`
    );
    return res.status(500).json({ error: 'Image upload is temporarily unavailable. Please try again shortly.' });
  }

  const { fileBase64, contentType } = req.body || {};
  const result = await uploadCampaignImage(fileBase64, contentType);

  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error });
  }

  return res.status(200).json({ url: result.url });
}

export default async function handler(req, res) {
  if (rejectIfNotAdmin(req, res)) return;

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseConfig();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }
  const headers = supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY);

  const route = req.query.route;
  if (route === 'analytics') return handleAnalytics(req, res, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY });
  if (route === 'upload-image') return handleUploadImage(req, res);

  try {
    // ---------------------------------------------------------------
    // GET — list all campaigns (with optional ?search= filtering)
    // ---------------------------------------------------------------
    if (req.method === 'GET') {
      const search = (req.query.search || '').trim();
      let url = `${SUPABASE_URL}/rest/v1/fundraiser?select=*&order=created_at.desc`;
      if (search) {
        // ilike = case-insensitive "contains" match on patient_name
        url += `&patient_name=ilike.*${encodeURIComponent(search)}*`;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        return res.status(500).json({ error: 'Failed to fetch campaigns.' });
      }
      const campaigns = await response.json();
      return res.status(200).json({ campaigns });
    }

    // ---------------------------------------------------------------
    // POST — create a new campaign
    // ---------------------------------------------------------------
    if (req.method === 'POST') {
      const body = req.body || {};
      const patientName = (body.patient_name || '').trim();

      if (!patientName) {
        return res.status(400).json({ error: 'Patient name is required.' });
      }
      const goalAmount = Number(body.goal_amount);
      if (!goalAmount || goalAmount <= 0) {
        return res.status(400).json({ error: 'A valid goal amount is required.' });
      }

      // Primary contact phone number is required for every NEW campaign
      // — this is enforced here in the application layer rather than as
      // a database NOT NULL constraint, so that existing campaigns
      // created before this field existed are never broken (see
      // supabase.sql for why). Secondary phone number stays optional.
      const phoneNumber = (body.phone_number || '').trim();
      if (!phoneNumber) {
        return res.status(400).json({ error: 'A primary contact phone number is required.' });
      }
      const secondaryPhoneNumber = (body.secondary_phone_number || '').trim() || null;

      // Beneficiary/payout details are now REQUIRED when creating a
      // campaign through this endpoint — every admin-created campaign
      // must have its beneficiary set up in the same submission, exactly
      // like a visitor submission (api/submit-campaign.js) already
      // requires. Validated here, before we even attempt to create the
      // campaign row, so a missing beneficiary never leaves an orphaned
      // campaign behind that then needs a rollback.
      const beneficiaryName = (body.beneficiary_name || '').trim();
      const beneficiaryBankCode = body.bank_code;
      const beneficiaryAccountNumber = (body.account_number || '').trim();
      if (!beneficiaryName || !beneficiaryBankCode || !beneficiaryAccountNumber) {
        return res.status(400).json({
          error: 'Beneficiary name, bank, and account number are all required to create a campaign.',
        });
      }

      // The admin dashboard uploads the photo to Supabase Storage in a
      // SEPARATE request (api/admin/upload-image.js) before ever calling
      // this endpoint — by the time we get here, imageUrl already points
      // at a real, already-uploaded file. That's exactly why a rollback
      // step is needed below if the insert doesn't ultimately succeed.
      const imageUrl = body.image_url || null;

      // A campaign's slug must be unique. Collisions are rare but not
      // impossible — this is what retry logic below guards against, on
      // top of widening the random suffix in generateSlug().
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
          raised_amount: 0, // always starts at zero — never trust a client-supplied value
          donor_count: 0,
          status: 'active',
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
        const isSlugCollision =
          lastErrorText.includes('fundraiser_slug_key') || lastErrorText.includes('23505');

        console.warn(
          `Campaign insert attempt ${attempt}/${MAX_SLUG_ATTEMPTS} failed` +
            (isSlugCollision ? ' due to a slug collision — retrying with a new slug.' : '.'),
          lastErrorText
        );

        // Only retry when it's specifically a slug collision. Any other
        // database error (missing column, bad value, etc.) won't be
        // fixed by trying again, so fail fast instead of looping.
        if (!isSlugCollision) break;
      }

      if (!created) {
        console.error('Failed to create campaign after retries:', lastErrorText);

        // ---- ROLLBACK ----
        // The image already uploaded successfully to Storage, but the
        // campaign row never made it into the database. Without this
        // step, that photo would sit in the bucket forever with nothing
        // pointing to it. This is best-effort: if the cleanup itself
        // fails, we log it clearly so it can be found and removed by
        // hand rather than silently losing track of it.
        if (imageUrl) {
          const cleanup = await deleteCampaignImage(imageUrl);
          if (!cleanup.skipped && !cleanup.deleted) {
            console.error(
              `Campaign save failed AND its uploaded photo could not be rolled back automatically. ` +
                `Manual cleanup needed in Supabase Storage (bucket "campaign-images"): ${imageUrl}. ` +
                `Storage error: ${cleanup.error}`
            );
          } else if (cleanup.deleted) {
            console.log(`Rolled back orphaned photo after failed campaign creation: ${cleanup.path}`);
          }
        }

        return res.status(500).json({
          error: 'Failed to create campaign. Any uploaded photo has been cleaned up automatically.',
          // Safe to expose: this endpoint already requires a valid admin
          // session, and seeing the real database error is what lets you
          // fix the actual problem instead of guessing.
          details: lastErrorText,
        });
      }

      const newCampaignRecord = created[0];

      // ---- Create the linked beneficiary in the SAME request ----
      // Required fields were already validated above, before the
      // campaign row was even created — this always runs now, since
      // every campaign created through this endpoint must have a
      // beneficiary. If it fails here (a genuine database error rather
      // than missing input), we roll back the campaign rather than
      // leaving one without its required beneficiary.
      const beneficiaryResult = await insertBeneficiary(
        { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY },
        {
          fundraiserId: newCampaignRecord.id,
          beneficiaryName,
          bankCode: beneficiaryBankCode,
          bankName: body.bank_name || null,
          accountNumber: beneficiaryAccountNumber,
          primaryPhoneNumber: body.beneficiary_phone || null,
          secondaryPhoneNumber: body.beneficiary_secondary_phone || null,
        }
      );

      if (!beneficiaryResult.ok) {
        console.error('Failed to create linked beneficiary, rolling back campaign:', beneficiaryResult.error);
        await rollbackCampaign(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, headers, newCampaignRecord, imageUrl);
        return res.status(500).json({
          error: 'Campaign could not be saved because its beneficiary details failed to save. Nothing was created — please try again.',
          details: beneficiaryResult.error,
        });
      }

      return res.status(201).json({ campaign: newCampaignRecord, beneficiary: beneficiaryResult.data });
    }

    // ---------------------------------------------------------------
    // PATCH — edit an existing campaign (also used to archive/reactivate)
    // ---------------------------------------------------------------
    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Campaign id is required.' });

      const body = req.body || {};
      const updates = {};

      // Only allow a specific safe list of fields to be edited.
      // "raised_amount" and "donor_count" are deliberately excluded —
      // they can only change via a real, verified Paystack payment.
      // "phone_number" and "secondary_phone_number" are editable here,
      // but — unlike on creation — are NOT required to be non-empty:
      // existing campaigns created before these fields existed may not
      // have one on file yet, and must remain editable regardless.
      const editableFields = [
        'patient_name',
        'hospital',
        'diagnosis',
        'story',
        'image_url',
        'goal_amount',
        'status',
        'phone_number',
        'secondary_phone_number',
      ];
      for (const field of editableFields) {
        if (body[field] !== undefined) updates[field] = body[field];
      }

      // 'pending' and 'rejected' are here for visitor campaign
      // submissions (see api/submit-campaign.js) — a visitor submission
      // starts as 'pending', and admin approval/rejection is just a
      // PATCH to this same endpoint (status: 'active' to approve,
      // 'rejected' to reject), reusing this existing endpoint rather
      // than adding a separate approve/reject one.
      if (updates.status && !['active', 'archived', 'pending', 'rejected'].includes(updates.status)) {
        return res.status(400).json({ error: 'Status must be "active", "archived", "pending", or "rejected".' });
      }

      // Rejecting a visitor submission: save the admin's reason (or a
      // sensible default when none was given) so the visitor's private
      // tracking page (api/track-campaign.js) can show WHY. Approving
      // (status -> 'active') always clears any previous rejection
      // reason back to null, since it no longer applies — this also
      // covers a "re-approval" after an earlier rejection.
      if (updates.status === 'rejected') {
        const reason = (body.rejection_reason || '').trim();
        updates.rejection_reason = reason || 'Your submission was not approved at this time.';
      } else if (updates.status === 'active') {
        updates.rejection_reason = null;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No editable fields were provided.' });
      }

      // ---- IMAGE REPLACEMENT: capture the OLD image first ----
      // If this edit is changing image_url, the admin dashboard has
      // already uploaded the NEW photo to Storage by this point (that
      // upload is a separate request that happens before this one). We
      // deliberately look up the campaign's current (soon-to-be-old)
      // image_url now, before touching the database, so that if the
      // update below fails for any reason, we still have the old image
      // intact and simply do nothing further — never deleting anything
      // ahead of a confirmed, successful save.
      const isReplacingImage = Object.prototype.hasOwnProperty.call(updates, 'image_url');
      let oldImageUrl = null;
      if (isReplacingImage) {
        const currentRes = await fetch(
          `${SUPABASE_URL}/rest/v1/fundraiser?id=eq.${encodeURIComponent(id)}&select=image_url`,
          { headers }
        );
        if (currentRes.ok) {
          const rows = await currentRes.json();
          oldImageUrl = rows[0]?.image_url || null;
        } else {
          console.warn('Could not look up the campaign\'s previous image before updating it:', await currentRes.text());
        }
      }

      const response = await fetch(`${SUPABASE_URL}/rest/v1/fundraiser?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY, { Prefer: 'return=representation' }),
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        // The update failed — we haven't touched Storage at all, so the
        // old image (if any) is still exactly where it was.
        return res.status(500).json({ error: 'Failed to update campaign.' });
      }

      const updated = await response.json();
      if (!updated || updated.length === 0) {
        return res.status(404).json({ error: 'Campaign not found.' });
      }

      // ---- The update succeeded. ONLY NOW is it safe to remove the old
      // photo, and only if it actually changed to something different. ----
      let imageCleanupWarning = null;
      if (isReplacingImage && oldImageUrl && oldImageUrl !== updates.image_url) {
        const cleanup = await deleteCampaignImage(oldImageUrl);
        if (!cleanup.skipped && !cleanup.deleted) {
          console.error(
            `Campaign ${id} was updated successfully, but its old photo could not be removed from ` +
              `storage. Manual cleanup needed in Supabase Storage (bucket "campaign-images"): ${oldImageUrl}. ` +
              `Storage error: ${cleanup.error}`
          );
          imageCleanupWarning =
            'Campaign updated, but the old photo could not be removed from storage automatically. It may need manual cleanup.';
        }
      }

      return res.status(200).json({
        campaign: updated[0],
        ...(imageCleanupWarning ? { warning: imageCleanupWarning } : {}),
      });
    }

    // ---------------------------------------------------------------
    // DELETE — permanently remove a campaign (and its donation history,
    // thanks to the "on delete cascade" set up in supabase.sql), plus
    // its photo in Supabase Storage.
    // ---------------------------------------------------------------
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Campaign id is required.' });

      // We need this campaign's image_url BEFORE deleting the row —
      // once the row is gone, there's no record left of which file in
      // Storage belonged to it.
      const currentRes = await fetch(
        `${SUPABASE_URL}/rest/v1/fundraiser?id=eq.${encodeURIComponent(id)}&select=image_url`,
        { headers }
      );
      let imageUrl = null;
      if (currentRes.ok) {
        const rows = await currentRes.json();
        imageUrl = rows[0]?.image_url || null;
      } else {
        console.warn('Could not look up the campaign\'s image before deleting it:', await currentRes.text());
      }

      const response = await fetch(`${SUPABASE_URL}/rest/v1/fundraiser?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers,
      });

      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        return res.status(500).json({ error: 'Failed to delete campaign.' });
      }

      // The campaign row (and its donations, via ON DELETE CASCADE) is
      // gone. Now clean up its photo — this ONLY ever touches the exact
      // file this one campaign was using, never another campaign's image,
      // since we're deleting by this campaign's own stored image_url.
      const cleanup = await deleteCampaignImage(imageUrl);

      if (!cleanup.skipped && !cleanup.deleted) {
        // The database delete succeeded, but Storage cleanup didn't.
        // Report this honestly instead of claiming everything was
        // deleted — the admin dashboard surfaces this as a warning.
        console.error(
          `Campaign ${id} was deleted, but its photo could not be removed from storage. ` +
            `Manual cleanup needed in Supabase Storage (bucket "campaign-images"): ${imageUrl}. ` +
            `Storage error: ${cleanup.error}`
        );
        return res.status(200).json({
          success: true,
          campaign_deleted: true,
          image_deleted: false,
          warning:
            'Campaign deleted, but its photo could not be removed from storage automatically. It may need manual cleanup in Supabase Storage.',
        });
      }

      return res.status(200).json({ success: true, campaign_deleted: true, image_deleted: cleanup.deleted });
    }

    res.setHeader('Allow', ['GET', 'POST', 'PATCH', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Unexpected error in /api/admin/campaigns:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
