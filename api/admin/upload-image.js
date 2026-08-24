// api/admin/upload-image.js
//
// Lets the admin upload a patient photo straight from the dashboard —
// no GitHub upload required. The browser reads the chosen file as a
// base64 string (see admin/dashboard.html) and POSTs it here as JSON.
// We then forward those bytes to Supabase Storage and hand back the
// public URL, which gets saved into the campaign's "image_url" column.

import { rejectIfNotAdmin } from '../../lib/admin-auth.js';

// Vercel's default body size limit is 4.5MB. Base64 encoding makes files
// ~33% bigger, so we cap the *decoded* image at a sensible size to keep
// uploads fast and within that limit.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (rejectIfNotAdmin(req, res)) return;

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }

  const { fileBase64, contentType } = req.body || {};

  if (!fileBase64 || !contentType) {
    return res.status(400).json({ error: 'A file and its content type are required.' });
  }
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    return res.status(400).json({ error: 'Only JPG, PNG, or WEBP images are allowed.' });
  }

  // The browser sends a "data:image/jpeg;base64,...." string — strip the
  // prefix so we're left with just the raw base64 data.
  const base64Data = fileBase64.includes(',') ? fileBase64.split(',')[1] : fileBase64;
  const fileBuffer = Buffer.from(base64Data, 'base64');

  if (fileBuffer.length > MAX_IMAGE_BYTES) {
    return res.status(400).json({ error: 'Image is too large. Please use a photo under 3MB.' });
  }

  // Build a unique filename so two uploads never overwrite each other
  const extension = contentType.split('/')[1];
  const fileName = `patient-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

  try {
    // Upload the raw bytes to the "campaign-images" Supabase Storage bucket
    const uploadResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/campaign-images/${fileName}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': contentType,
        },
        body: fileBuffer,
      }
    );

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      console.error('Supabase Storage upload failed:', errText);
      return res.status(500).json({ error: 'Failed to upload image. Make sure the "campaign-images" bucket exists (see README).' });
    }

    // Because the bucket is public, this fixed URL pattern always works
    // for any file inside it — no extra API call needed to fetch it.
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/campaign-images/${fileName}`;

    return res.status(200).json({ url: publicUrl });
  } catch (err) {
    console.error('Unexpected error in /api/admin/upload-image:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
