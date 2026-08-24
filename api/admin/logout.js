// api/admin/logout.js
//
// Clears the admin session cookie. Called when the admin taps "Log out"
// on the dashboard.

import { buildClearCookieHeader } from '../../lib/admin-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Set-Cookie', buildClearCookieHeader());
  return res.status(200).json({ success: true });
}
