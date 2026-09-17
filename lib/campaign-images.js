// lib/campaign-images.js
//
// Shared helpers for keeping the "campaign-images" Supabase Storage
// bucket in sync with the "fundraiser" table, so:
//   - a campaign's photo is never left behind (orphaned) if creating the
//     campaign fails after the photo already uploaded successfully
//   - replacing a campaign's photo never deletes the OLD photo until the
//     NEW one is safely saved and the database update has succeeded
//   - deleting a campaign also deletes its photo, and only its photo —
//     never another campaign's image
//
// Every function here is careful to only ever touch a URL that actually
// points into OUR "campaign-images" bucket. Anything else (the local
// images/lucy.jpg fallback, a blank image_url, some unrelated URL) is
// left completely alone.

const STORAGE_URL_MARKER = '/storage/v1/object/public/campaign-images/';

// Given one of our own public image URLs (as returned by
// api/admin/upload-image.js — something like
// "https://xxxx.supabase.co/storage/v1/object/public/campaign-images/patient-123.jpg"),
// pull out just the filename/path inside the bucket
// ("patient-123.jpg"). Returns null for anything that ISN'T one of our
// own campaign-images URLs — that's what keeps this safe to call with
// any image_url value, including empty ones.
function extractStoragePath(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  const index = imageUrl.indexOf(STORAGE_URL_MARKER);
  if (index === -1) return null;
  const path = imageUrl.slice(index + STORAGE_URL_MARKER.length);
  return path || null;
}

// Delete one object from the "campaign-images" bucket by its full public
// URL. This NEVER throws — every possible failure comes back as a
// regular return value — so callers can treat storage cleanup as
// best-effort while still reporting the real outcome honestly (per
// requirement #4: never claim something was deleted when it wasn't).
//
// Returns one of:
//   { skipped: true }                          — not one of our bucket's URLs, nothing to do
//   { deleted: true, path }                     — successfully deleted
//   { deleted: false, error: '...' }            — we tried and it failed
async function deleteCampaignImage(imageUrl) {
  const path = extractStoragePath(imageUrl);
  if (!path) {
    return { skipped: true, deleted: false };
  }

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { skipped: false, deleted: false, error: 'Missing Supabase configuration.' };
  }

  try {
    // Supabase Storage's delete endpoint takes a list of paths so
    // multiple files can be removed in one call — we only ever pass one.
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/campaign-images`, {
      method: 'DELETE',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes: [path] }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { skipped: false, deleted: false, error: errText };
    }

    return { skipped: false, deleted: true, path };
  } catch (err) {
    return { skipped: false, deleted: false, error: err.message || String(err) };
  }
}

const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB
const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Uploads a base64-encoded photo to the "campaign-images" bucket and
// returns its public URL. Shared by api/admin/campaigns.js's
// ?route=upload-image (the admin dashboard's photo upload) AND
// api/submit-campaign.js (the public visitor submission form) — both
// need the exact same upload behavior, so this is the one place it's
// implemented, rather than duplicating it in two files.
//
// Returns one of:
//   { ok: true, url }
//   { ok: false, error, status } — status is a suggested HTTP status code
async function uploadCampaignImage(fileBase64, contentType) {
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 500, error: 'Server is missing Supabase configuration.' };
  }

  if (!fileBase64 || !contentType) {
    return { ok: false, status: 400, error: 'A file and its content type are required.' };
  }
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    return { ok: false, status: 400, error: 'Only JPG, PNG, or WEBP images are allowed.' };
  }

  const base64Data = fileBase64.includes(',') ? fileBase64.split(',')[1] : fileBase64;
  const fileBuffer = Buffer.from(base64Data, 'base64');

  if (fileBuffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 400, error: 'Image is too large. Please use a photo under 3MB.' };
  }

  const extension = contentType.split('/')[1];
  const fileName = `patient-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

  try {
    const uploadResponse = await fetch(`${SUPABASE_URL}/storage/v1/object/campaign-images/${fileName}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': contentType,
      },
      body: fileBuffer,
    });

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      // Logging the HTTP status alongside the body matters here: a 404
      // ("Bucket not found") points at the bucket not existing (or being
      // misnamed) in the connected Supabase project, while a 400/403
      // usually points at a permissions/policy problem instead — the
      // generic message returned to the caller can't distinguish these,
      // but this log line lets a developer tell them apart immediately.
      console.error(`Supabase Storage upload failed — HTTP ${uploadResponse.status}:`, errText);
      return {
        ok: false,
        status: 500,
        error: 'Failed to upload image. Make sure the "campaign-images" bucket exists (see README).',
      };
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/campaign-images/${fileName}`;
    return { ok: true, url: publicUrl };
  } catch (err) {
    console.error('Unexpected error uploading image:', err);
    return { ok: false, status: 500, error: 'Unexpected server error.' };
  }
}

// ---------------------------------------------------------------------
// Exported as a SINGLE default-exported namespace object, deliberately,
// instead of three separate named exports (`export function ...` x3).
//
// Multiple named exports are handled consistently by Node's own native
// ESM loader (which is all local testing of this module ever went
// through), but named-export interop is exactly the part of the
// ESM/CommonJS boundary that behaves least consistently across
// different bundlers/build pipelines — depending on the toolchain, a
// named export can end up copied onto the module namespace directly,
// nested under `.default`, or (per-export) tree-shaken differently
// depending on how each export is referenced at each call site. A
// single default-exported object sidesteps all of that: there is only ever
// one thing to resolve (`.default`), and every mainstream bundler
// (esbuild — which is what Vercel's Node.js function builder uses —
// webpack, Babel, SWC) handles default-export interop identically. This
// is the one shared implementation, still — see uploadCampaignImage()
// above for the only place the actual Storage upload happens.
export default {
  uploadCampaignImage,
  deleteCampaignImage,
  extractStoragePath,
};
