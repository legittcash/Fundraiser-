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

// Turn "Lucy Adebayo" into something like "lucy-adebayo-x7k2" — a clean,
// unique, URL-friendly identifier for the campaign's public page.
function generateSlug(patientName) {
  const base = String(patientName || 'patient')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const randomSuffix = crypto.randomBytes(3).toString('hex'); // e.g. "a1b2c3"
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

      const newCampaign = {
        patient_name: patientName,
        hospital: body.hospital || null,
        diagnosis: body.diagnosis || null,
        story: body.story || null,
        image_url: body.image_url || null,
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

      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        return res.status(500).json({ error: 'Failed to create campaign.' });
      }

      const created = await response.json();
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

      const response = await fetch(`${SUPABASE_URL}/rest/v1/fundraiser?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY, { Prefer: 'return=representation' }),
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        return res.status(500).json({ error: 'Failed to update campaign.' });
      }

      const updated = await response.json();
      if (!updated || updated.length === 0) {
        return res.status(404).json({ error: 'Campaign not found.' });
      }
      return res.status(200).json({ campaign: updated[0] });
    }

    // ---------------------------------------------------------------
    // DELETE — permanently remove a campaign (and its donation history,
    // thanks to the "on delete cascade" set up in supabase.sql)
    // ---------------------------------------------------------------
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Campaign id is required.' });

      const response = await fetch(`${SUPABASE_URL}/rest/v1/fundraiser?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers,
      });

      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        return res.status(500).json({ error: 'Failed to delete campaign.' });
      }

      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', ['GET', 'POST', 'PATCH', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Unexpected error in /api/admin/campaigns:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
