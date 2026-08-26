// api/admin/campaigns.js
//
// Protected CRUD endpoint for managing patient campaigns from the admin
// dashboard. Every request here must include a valid admin session
// cookie (checked by lib/admin-auth.js) or it's rejected with 401.
//
// Supported requests:
//   GET    /api/admin/campaigns              -> list every campaign (active + archived)
//   GET    /api/admin/campaigns?search=lucy  -> list campaigns whose name matches
//   POST   /api/admin/campaigns              -> create a new campaign
//   PATCH  /api/admin/campaigns?id=123       -> edit an existing campaign
//   DELETE /api/admin/campaigns?id=123       -> permanently delete a campaign
//
// Note: "raised_amount" and "donor_count" are intentionally never
// accepted from the request body on create/edit — those two fields are
// read-only from the admin's point of view and are only ever changed by
// the Paystack webhook after a real, verified donation.

import crypto from 'crypto';
import { rejectIfNotAdmin } from '../../lib/admin-auth.js';
import { deleteCampaignImage } from '../../lib/campaign-images.js';

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

export default async function handler(req, res) {
  if (rejectIfNotAdmin(req, res)) return;

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseConfig();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }
  const headers = supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY);

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

        return res
          .status(500)
          .json({ error: 'Failed to create campaign. Any uploaded photo has been cleaned up automatically.' });
      }

      return res.status(201).json({ campaign: created[0] });
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
      const editableFields = ['patient_name', 'hospital', 'diagnosis', 'story', 'image_url', 'goal_amount', 'status'];
      for (const field of editableFields) {
        if (body[field] !== undefined) updates[field] = body[field];
      }

      if (updates.status && !['active', 'archived'].includes(updates.status)) {
        return res.status(400).json({ error: 'Status must be "active" or "archived".' });
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
