// api/admin/me.js
//
// The admin dashboard page calls this as soon as it loads. If it gets
// back { authenticated: true }, it shows the dashboard. If it gets a 401,
// it redirects the visitor to the login page. This is what stops someone
// from using the dashboard without logging in first.

import { isAdminRequest } from '../../lib/admin-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isAdminRequest(req)) {
    return res.status(401).json({ authenticated: false });
  }

  return res.status(200).json({ authenticated: true });
}
