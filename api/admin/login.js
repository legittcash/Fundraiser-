// api/admin/login.js
//
// Handles the admin login form on admin/login.html.
//
// The admin username/password are NOT stored in Supabase — they live
// only as Vercel environment variables (ADMIN_USERNAME, ADMIN_PASSWORD).
// That keeps things simple: there's no "users" table to manage, and the
// credentials never touch the database at all.
//
// On success, we set a signed, HttpOnly cookie (see lib/admin-auth.js)
// that every other /api/admin/* route checks before doing anything.

import crypto from 'crypto';
import { createSessionToken, buildSessionCookieHeader } from '../../lib/admin-auth.js';

// Constant-time string comparison so an attacker can't use tiny timing
// differences to guess the password one character at a time.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;

  if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !ADMIN_SESSION_SECRET) {
    console.error('Admin env vars are missing (ADMIN_USERNAME/ADMIN_PASSWORD/ADMIN_SESSION_SECRET).');
    return res.status(500).json({ error: 'Admin login is not configured on the server yet.' });
  }

  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const usernameMatches = safeEqual(username, ADMIN_USERNAME);
  const passwordMatches = safeEqual(password, ADMIN_PASSWORD);

  if (!usernameMatches || !passwordMatches) {
    // Deliberately vague error message — don't reveal which field was wrong
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Credentials are correct — issue a signed session cookie
  const token = createSessionToken();
  res.setHeader('Set-Cookie', buildSessionCookieHeader(token));
  return res.status(200).json({ success: true });
}
