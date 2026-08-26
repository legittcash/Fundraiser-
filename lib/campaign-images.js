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
export function extractStoragePath(imageUrl) {
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
export async function deleteCampaignImage(imageUrl) {
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
