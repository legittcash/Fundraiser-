// api/campaigns.js
//
// Public endpoint used by the new homepage (index.html) to show every
// active patient campaign, with an optional search box.
//
//   GET /api/campaigns                     -> all active campaigns
//   GET /api/campaigns?search=patient      -> active campaigns matching "patient"
//   GET /api/campaigns?page=1              -> first 24 active campaigns, plus has_more
//   GET /api/campaigns?page=2&search=ada   -> next 24 matching, plus has_more
//
// With ?page=N the homepage "Load more" button gets one page at a time
// ({ campaigns, has_more }). Without ?page the whole list is returned,
// exactly as before, so nothing that already calls this endpoint breaks.
//
// This never exposes archived campaigns, and only returns the fields the
// homepage cards and filters actually need (diagnosis is already public on
// every campaign page; the homepage filter bar uses it). Each campaign also carries a single
// yes/no field, beneficiary_verified, for the public "Verified" badge.
//
// The full list (no ?page) is read in pages of 1000
// (lib/supabase-paging.js) so every active campaign is returned even
// beyond Supabase's default 1000 row response limit. Search and
// ordering behave exactly as before.

import { fetchAllRows } from '../lib/supabase-paging.js';
import { jsonResponse } from '../lib/http.js';

// How many campaigns each "Load more" page returns. 24 divides evenly into
// the 2, 3 and 4 column homepage layouts, so rows are never left ragged.
const PAGE_SIZE = 24;

export default async function handler(req, env) {
  if (req.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  }

  const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse(500, { error: 'Server is missing Supabase configuration.' });
  }

  const search = (req.query.search || '').trim();

  let url =
    `${SUPABASE_URL}/rest/v1/fundraiser` +
    `?select=id,slug,patient_name,hospital,diagnosis,image_url,goal_amount,raised_amount,donor_count` +
    `&status=eq.active&order=created_at.desc,id.desc`; // id tie-break: same newest first order, stable paging

  if (search) {
    url += `&patient_name=ilike.*${encodeURIComponent(search)}*`;
  }

  try {
    const supabaseHeaders = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    };

    let campaigns;
    let hasMore = false;
    const pageParam = req.query.page;

    if (pageParam !== undefined) {
      // "Load more" mode: fetch just one page. One extra row is requested
      // so we know whether another page exists without a second query.
      const page = Math.max(1, Math.floor(Number(pageParam)) || 1);
      const response = await fetch(
        `${url}&limit=${PAGE_SIZE + 1}&offset=${(page - 1) * PAGE_SIZE}`,
        { headers: supabaseHeaders }
      );
      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        return jsonResponse(500, { error: 'Failed to load campaigns.' });
      }
      const rows = await response.json();
      hasMore = rows.length > PAGE_SIZE;
      campaigns = rows.slice(0, PAGE_SIZE);
    } else {
      const result = await fetchAllRows(url, supabaseHeaders);
      if (!result.ok) {
        console.error('Supabase error:', result.errorText);
        return jsonResponse(500, { error: 'Failed to load campaigns.' });
      }
      campaigns = result.rows;
    }

    // ---- Public "Verified" badge flag ----
    // Adds ONE boolean, beneficiary_verified, per campaign. It is true
    // only when that campaign's beneficiary row has
    // verification_status = 'verified' (settlement_enabled is
    // deliberately NOT considered: verification and settlement are
    // separate concepts). Only the fundraiser_id column of matching
    // rows is selected, so no beneficiary detail ever leaves the
    // server. If this lookup fails, every flag is simply false and the
    // campaign list still loads normally.
    const verifiedIds = new Set();
    try {
      const ids = campaigns.map((c) => c.id).filter(Boolean);
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100).map(encodeURIComponent).join(',');
        const bRes = await fetch(
          `${SUPABASE_URL}/rest/v1/beneficiaries?select=fundraiser_id&verification_status=eq.verified&fundraiser_id=in.(${chunk})`,
          {
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
          }
        );
        if (!bRes.ok) continue;
        (await bRes.json()).forEach((row) => verifiedIds.add(row.fundraiser_id));
      }
    } catch (err) {
      console.warn('Could not check beneficiary verification; no badges will show.', err);
    }

    const campaignsWithBadge = campaigns.map((c) => ({
      ...c,
      beneficiary_verified: verifiedIds.has(c.id),
    }));
    if (pageParam !== undefined) {
      return jsonResponse(200, { campaigns: campaignsWithBadge, has_more: hasMore });
    }
    return jsonResponse(200, { campaigns: campaignsWithBadge });
  } catch (err) {
    console.error('Unexpected error in /api/campaigns:', err);
    return jsonResponse(500, { error: 'Unexpected server error.' });
  }
}
