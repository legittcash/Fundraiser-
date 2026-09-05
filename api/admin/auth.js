// api/admin/auth.js
//
// Combines what used to be three separate files — api/admin/login.js,
// api/admin/logout.js, and api/admin/me.js — into one, routed by an
// `action` query parameter. This exists purely to reduce the total
// number of Vercel Serverless Functions (Vercel's Hobby plan caps a
// deployment at 12); the actual login/logout/session-check LOGIC below
// is unchanged from those three original files, just combined into one
// file.
//
//   POST /api/admin/auth?action=login   { username, password } -> sets session cookie
//   POST /api/admin/auth?action=logout  -> clears session cookie
//   GET  /api/admin/auth?action=me      -> { authenticated: true|false }
//
// The admin username/password are NOT stored in Supabase — they live
// only as Vercel environment variables (ADMIN_USERNAME, ADMIN_PASSWORD).

import crypto from 'crypto';
import {
  createSessionToken,
  buildSessionCookieHeader,
  buildClearCookieHeader,
  isAdminRequest,
} from '../../lib/admin-auth.js';

// Constant-time string comparison so an attacker can't use tiny timing
// differences to guess the password one character at a time.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function handleLogin(req, res) {
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

async function handleLogout(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Set-Cookie', buildClearCookieHeader());
  return res.status(200).json({ success: true });
}

async function handleMe(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isAdminRequest(req)) {
    return res.status(401).json({ authenticated: false });
  }

  return res.status(200).json({ authenticated: true });
}

export default async function handler(req, res) {
  const action = req.query.action;

  if (action === 'login') return handleLogin(req, res);
  if (action === 'logout') return handleLogout(req, res);
  if (action === 'me') return handleMe(req, res);

  return res.status(400).json({ error: 'Unknown or missing ?action= (expected "login", "logout", or "me").' });
}
