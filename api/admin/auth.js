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
// only as Cloudflare Worker secrets (ADMIN_USERNAME, ADMIN_PASSWORD).

import { safeEqualStrings } from '../../lib/web-crypto.js';
import { jsonResponse } from '../../lib/http.js';
import {
  createSessionToken,
  buildSessionCookieHeader,
  buildClearCookieHeader,
  isAdminRequest,
} from '../../lib/admin-auth.js';

// Constant-time string comparison so an attacker can't use tiny timing
// differences to guess the password one character at a time.

async function handleLogin(req, env) {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }

  const ADMIN_USERNAME = env.ADMIN_USERNAME;
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD;
  const ADMIN_SESSION_SECRET = env.ADMIN_SESSION_SECRET;

  if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !ADMIN_SESSION_SECRET) {
    console.error('Admin env vars are missing (ADMIN_USERNAME/ADMIN_PASSWORD/ADMIN_SESSION_SECRET).');
    return jsonResponse(500, { error: 'Admin login is not configured on the server yet.' });
  }

  const { username, password } = req.body || {};

  if (!username || !password) {
    return jsonResponse(400, { error: 'Username and password are required.' });
  }

  const usernameMatches = await safeEqualStrings(username, ADMIN_USERNAME);
  const passwordMatches = await safeEqualStrings(password, ADMIN_PASSWORD);

  if (!usernameMatches || !passwordMatches) {
    // Deliberately vague error message — don't reveal which field was wrong
    return jsonResponse(401, { error: 'Invalid username or password.' });
  }

  // Credentials are correct — issue a signed session cookie
  const token = await createSessionToken(env);
  return jsonResponse(200, { success: true }, { 'Set-Cookie': buildSessionCookieHeader(token, req) });
}

async function handleLogout(req, env) {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }

  return jsonResponse(200, { success: true }, { 'Set-Cookie': buildClearCookieHeader() });
}

async function handleMe(req, env) {
  if (req.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  }

  if (!(await isAdminRequest(req, env))) {
    return jsonResponse(401, { authenticated: false });
  }

  return jsonResponse(200, { authenticated: true });
}

export default async function handler(req, env) {
  const action = req.query.action;

  if (action === 'login') return handleLogin(req, env);
  if (action === 'logout') return handleLogout(req, env);
  if (action === 'me') return handleMe(req, env);

  return jsonResponse(400, { error: 'Unknown or missing ?action= (expected "login", "logout", or "me").' });
}
