// api/admin/analytics.js
//
// Powers the "overview" numbers at the top of the admin dashboard:
// total patients, active campaigns, total raised, total donors, and a
// short list of the most recent donations across ALL campaigns.

import { rejectIfNotAdmin } from '../../lib/admin-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (rejectIfNotAdmin(req, res)) return;

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    // Pull every campaign's summary numbers in one request, then total
    // them up here in code — simplest approach for a beginner-friendly
    // project, and plenty fast even at 1,000+ campaigns.
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

    // Fetch the 10 most recent donations, joined with the patient name
    // they belong to, for the "Recent donations" list.
    const recentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/donations?select=id,amount,donor_name,donor_email,anonymous,created_at,fundraiser:fundraiser_id(patient_name)&order=created_at.desc&limit=10`,
      { headers }
    );
    let recentDonations = [];
    if (recentRes.ok) {
      recentDonations = await recentRes.json();
    } else {
      console.error('Supabase error fetching recent donations:', await recentRes.text());
    }

    return res.status(200).json({
      total_patients: totalPatients,
      active_campaigns: activeCampaigns,
      total_raised: totalRaised,
      total_donors: totalDonors,
      recent_donations: recentDonations,
    });
  } catch (err) {
    console.error('Unexpected error in /api/admin/analytics:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
