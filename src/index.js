// src/index.js
//
// Cloudflare Worker entry point for the KODEP fundraising platform.
//
// wrangler.jsonc serves everything in ./public (the HTML/CSS/JS site) as
// static assets and runs THIS Worker first only for /api/* requests
// ("run_worker_first": ["/api/*"]). So:
//
//   /api/...          -> routed below to the same handler files the Vercel
//                        version used (api/*.js), at the same URLs
//   everything else   -> static website from ./public
//
// Handlers receive (req, env):
//   req  a small parsed view of the Request (lib/http.js parseRequest)
//   env  the Worker's secrets / variables (never process.env)
// and return a standard Web Response.
//
// EXCEPTION: /api/paystack-webhook receives the untouched Request, because
// its HMAC signature has to be checked against the raw body text.

import { parseRequest, InvalidJsonError, jsonResponse } from '../lib/http.js';

import campaign from '../api/campaign.js';
import campaigns from '../api/campaigns.js';
import donations from '../api/donations.js';
import initializeDonation from '../api/initialize-donation.js';
import paystackWebhook from '../api/paystack-webhook.js';
import progress from '../api/progress.js';
import submitCampaign from '../api/submit-campaign.js';
import trackCampaign from '../api/track-campaign.js';
import adminAuth from '../api/admin/auth.js';
import adminBeneficiaries from '../api/admin/beneficiaries.js';
import adminCampaigns from '../api/admin/campaigns.js';

// pathname -> handler. These are exactly the public URLs the frontend
// already calls; none were renamed.
const ROUTES = {
  '/api/campaign': campaign,
  '/api/campaigns': campaigns,
  '/api/donations': donations,
  '/api/initialize-donation': initializeDonation,
  '/api/progress': progress,
  '/api/submit-campaign': submitCampaign,
  '/api/track-campaign': trackCampaign,
  '/api/admin/auth': adminAuth,
  '/api/admin/beneficiaries': adminBeneficiaries,
  '/api/admin/campaigns': adminCampaigns,
};

// Routes that must see the raw Request instead of the parsed view.
const RAW_BODY_ROUTES = {
  '/api/paystack-webhook': paystackWebhook,
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // Treat "/api/campaigns/" the same as "/api/campaigns".
    const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

    const rawHandler = RAW_BODY_ROUTES[path];
    const handler = ROUTES[path];

    if (!rawHandler && !handler) {
      // Not an API route this app knows. /api/* only reaches the Worker
      // (see run_worker_first), so anything else here is an unknown API path.
      if (path.startsWith('/api/') || path === '/api') {
        return jsonResponse(404, { error: 'Not found' });
      }
      return env.ASSETS.fetch(request);
    }

    try {
      const response = rawHandler
        ? await rawHandler(request, env)
        : await handler(await parseRequest(request), env);

      if (!(response instanceof Response)) {
        console.error(`Handler for ${path} did not return a Response.`);
        return jsonResponse(500, { error: 'Unexpected server error.' });
      }
      return response;
    } catch (err) {
      if (err instanceof InvalidJsonError) {
        return jsonResponse(400, { error: err.message });
      }
      console.error(`Unhandled error in ${path}:`, err);
      return jsonResponse(500, { error: 'Unexpected server error.' });
    }
  },
};
