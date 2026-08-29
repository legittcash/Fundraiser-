// api/admin/analytics.js
//
// Powers the "overview" numbers at the top of the admin dashboard:
// total patients, active campaigns, total raised, total donors, total
// gross donations, total Paystack fees, and a short list of the most
// recent donations across ALL campaigns (with their gross/fee/net
// breakdown).

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
    // "raised_amount" on each campaign is already a running NET total —
    // the webhook only ever adds net_amount to it — so this figure is
    // the platform's total NET amount actually received.
    const totalRaised = campaigns.reduce((sum, c) => sum + Number(c.raised_amount || 0), 0);
    const totalDonors = campaigns.reduce((sum, c) => sum + Number(c.donor_count || 0), 0);

    // Separately total up the GROSS amount donors paid and the Paystack
    // fees taken across every donation ever recorded, so the admin can
    // see the full financial picture (gross vs. fees vs. net) rather
    // than just the net figure already visible via campaign totals.
    const financialsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/donations?select=amount,paystack_fee`,
      { headers }
    );
    let totalGrossDonations = 0;
    let totalPaystackFees = 0;
    if (financialsRes.ok) {
      const allDonations = await financialsRes.json();
      totalGrossDonations = allDonations.reduce((sum, d) => sum + Number(d.amount || 0), 0);
      totalPaystackFees = allDonations.reduce((sum, d) => sum + Number(d.paystack_fee || 0), 0);
    } else {
      console.error('Supabase error fetching donation financials:', await financialsRes.text());
    }

    // Fetch the 10 most recent donations, joined with the patient name
    // they belong to, for the "Recent donations" list — including the
    // gross/fee/net breakdown for each individual donation.
    const recentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/donations?select=id,amount,paystack_fee,net_amount,donor_name,donor_email,anonymous,created_at,fundraiser:fundraiser_id(patient_name)&order=created_at.desc&limit=10`,
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
      total_gross_donations: totalGrossDonations,
      total_paystack_fees: totalPaystackFees,
      recent_donations: recentDonations,
    });
  } catch (err) {
    console.error('Unexpected error in /api/admin/analytics:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
}
