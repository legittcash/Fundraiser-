// lib/admin-auth.js
//
// Small, dependency-free helper for admin login sessions.
//
// How it works (no database or session store needed):
//   1. On login, if the username/password match the values in Vercel's
//      environment variables, we create a "session token": a timestamp
//      saying when it expires, plus a cryptographic signature of that
//      timestamp made with a secret only our server knows
//      (ADMIN_SESSION_SECRET).
//   2. We send that token back to the browser as an HttpOnly cookie —
//      "HttpOnly" means JavaScript in the browser can't read it, which
//      protects it from being stolen by a malicious script.
//   3. On every admin API request, we recompute the signature from the
//      cookie's timestamp and compare it to the signature inside the
//      cookie. If they match and it hasn't expired, the request is
//      treated as coming from a logged-in admin.
//
// This avoids needing any extra database table or third-party auth
// service just to protect a handful of admin pages.

import crypto from 'crypto';

export const ADMIN_COOKIE_NAME = 'admin_session';
const SESSION_LENGTH_SECONDS = 60 * 60 * 8; // 8 hours

// Sign a value with our secret so we can tell later if it was tampered with
function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

// Build the cookie value we hand back to the browser after a successful login
export function createSessionToken() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  const expiresAt = Date.now() + SESSION_LENGTH_SECONDS * 1000;
  const signature = sign(String(expiresAt), secret);
  return `${expiresAt}.${signature}`;
}

// Turn that token into a ready-to-send "Set-Cookie" header string
export function buildSessionCookieHeader(token) {
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  return [
    `${ADMIN_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    isProd ? 'Secure' : '', // "Secure" requires HTTPS, which local dev may not have
    `Max-Age=${SESSION_LENGTH_SECONDS}`,
  ]
    .filter(Boolean)
    .join('; ');
}

// A cookie header that immediately clears the session (used for logout)
export function buildClearCookieHeader() {
  return `${ADMIN_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
}

// Parse the raw "Cookie" request header into a simple { name: value } object
function parseCookies(cookieHeader = '') {
  const cookies = {};
  cookieHeader.split(';').forEach((pair) => {
    const index = pair.indexOf('=');
    if (index === -1) return;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  });
  return cookies;
}

// The main check every protected admin API route calls first.
// Returns true if the request has a valid, unexpired admin session cookie.
export function isAdminRequest(req) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    console.error('ADMIN_SESSION_SECRET is not set — refusing all admin requests.');
    return false;
  }

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[ADMIN_COOKIE_NAME];
  if (!token || !token.includes('.')) return false;

  const [expiresAtStr, signature] = token.split('.');
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return false; // expired

  const expectedSignature = sign(expiresAtStr, secret);

  // Use a timing-safe comparison so an attacker can't guess the correct
  // signature one character at a time by measuring response speed.
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expectedSignature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Convenience helper: send a 401 response if the request isn't from a
// logged-in admin. Returns true if it rejected the request (caller should
// stop and return), false if the request is authenticated and can proceed.
export function rejectIfNotAdmin(req, res) {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: 'Not authenticated. Please log in again.' });
    return true;
  }
  return false;
}
