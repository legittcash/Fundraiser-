// api/admin/platform-fee.js
//
// The platform fee master switch. This is the ONLY thing an admin
// controls about the platform fee — the 1% rate and ₦1,000 cap are
// fixed business rules enforced in api/initialize-donation.js, not
// stored or adjustable here.
//
//   GET  /api/admin/platform-fee  -> { enabled, rate_percent, cap_naira }
//   POST /api/admin/platform-fee { enabled: true|false } -> persists it
//
// This is stored in Supabase's "platform_settings" table (a single row),
// not in browser localStorage, so it persists across logout, redeploys,
// and different browsers/devices — and only an authenticated admin can
// ever change it.

import { rejectIfNotAdmin } from '../../lib/admin-auth.js';

const PLATFORM_FEE_RATE_PERCENT = 1;
const PLATFORM_FEE_CAP_NAIRA = 1000;

function getSupabaseConfig() {
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
}

export default async function handler(req, res) {
  if (rejectIfNotAdmin(req, res)) return;

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseConfig();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    if (req.method === 'GET') {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/platform_settings?select=platform_fee_enabled,updated_at,updated_by&limit=1`, {
        headers,
      });
      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        return res.status(500).json({ error: 'Failed to load platform fee setting.' });
      }
      const rows = await response.json();
      const row = rows[0];
      return res.status(200).json({
        enabled: row?.platform_fee_enabled === true,
        rate_percent: PLATFORM_FEE_RATE_PERCENT,
        cap_naira: PLATFORM_FEE_CAP_NAIRA,
        updated_at: row?.updated_at || null,
        updated_by: row?.updated_by || null,
      });
    }

    if (req.method === 'POST') {
      const enabled = (req.body || {}).enabled === true;

      // There should only ever be one row — fetch its id first so we
      // update the existing row rather than accidentally creating a
      // second one.
      const existingRes = await fetch(`${SUPABASE_URL}/rest/v1/platform_settings?select=id&limit=1`, { headers });
      const existingRows = existingRes.ok ? await existingRes.json() : [];
      const existingId = existingRows[0]?.id;

      if (!existingId) {
        // Should never happen since supabase.sql seeds one row, but
        // handle it gracefully rather than failing outright.
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/platform_settings`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify({
            platform_fee_enabled: enabled,
            updated_by: process.env.ADMIN_USERNAME || 'admin',
            updated_at: new Date().toISOString(),
          }),
        });
        if (!insertRes.ok) {
          console.error('Supabase error:', await insertRes.text());
          return res.status(500).json({ error: 'Failed to save platform fee setting.' });
        }
        const inserted = await insertRes.json();
        return res.status(200).json({
          enabled: inserted[0].platform_fee_enabled,
          rate_percent: PLATFORM_FEE_RATE_PERCENT,
          cap_naira: PLATFORM_FEE_CAP_NAIRA,
        });
      }

      const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/platform_settings?id=eq.${existingId}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          platform_fee_enabled: enabled,
          updated_by: process.env.ADMIN_USERNAME || 'admin',
          updated_at: new Date().toISOString(),
        }),
      });
      if (!updateRes.ok) {
        console.error('Supabase error:', await updateRes.text());
        return res.status(500).json({ error: 'Failed to save platform fee setting.' });
      }
      const updated = await updateRes.json();
      return res.status(200).json({
        enabled: updated[0].platform_fee_enabled,
        rate_percent: PLATFORM_FEE_RATE_PERCENT,
        cap_naira: PLATFORM_FEE_CAP_NAIRA,
      });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Unexpected error in /api/admin/platform-fee:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
