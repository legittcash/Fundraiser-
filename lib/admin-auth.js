// lib/admin-auth.js
//
// Small, dependency-free helper for admin login sessions.
//
// How it works (no database or session store needed):
//   1. On login, if the username/password match the values in Cloudflare
//      environment variables / secrets, we create a "session token": a timestamp
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

import { hmacHex, hexToBytes, timingSafeEqualBytes } from './web-crypto.js';
import { jsonResponse } from './http.js';

export const ADMIN_COOKIE_NAME = 'admin_session';
const SESSION_LENGTH_SECONDS = 60 * 60 * 8; // 8 hours

// Sign a value with our secret so we can tell later if it was tampered with
// (HMAC-SHA256, hex — identical output to the previous Node crypto version,
// so the token format is unchanged).
function sign(value, secret) {
  return hmacHex('SHA-256', secret, value);
}

// Build the cookie value we hand back to the browser after a successful login
export async function createSessionToken(env) {
  const secret = env.ADMIN_SESSION_SECRET;
  const expiresAt = Date.now() + SESSION_LENGTH_SECONDS * 1000;
  const signature = await sign(String(expiresAt), secret);
  return `${expiresAt}.${signature}`;
}

// Turn that token into a ready-to-send "Set-Cookie" header string.
// "Secure" is added whenever the request itself came in over HTTPS (always
// the case on a deployed Cloudflare Worker); plain-http local dev
// (wrangler dev) does not get it, because Secure cookies need HTTPS.
export function buildSessionCookieHeader(token, req) {
  const isHttps = req.url.protocol === 'https:';
  return [
    `${ADMIN_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    isHttps ? 'Secure' : '',
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
    if (!name) return;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // A malformed %-escape must never crash the request; treat the
      // cookie as unusable (it can then never validate).
      cookies[name] = '';
    }
  });
  return cookies;
}

// The main check every protected admin API route calls first.
// Returns true if the request has a valid, unexpired admin session cookie.
// `req` is the parsed request from lib/http.js (req.headers is a Headers).
export async function isAdminRequest(req, env) {
  const secret = env.ADMIN_SESSION_SECRET;
  if (!secret) {
    console.error('ADMIN_SESSION_SECRET is not set — refusing all admin requests.');
    return false;
  }

  const cookies = parseCookies(req.headers.get('cookie') || '');
  const token = cookies[ADMIN_COOKIE_NAME];
  if (!token || !token.includes('.')) return false;

  const [expiresAtStr, signature] = token.split('.');
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return false; // expired

  const expectedSignature = await sign(expiresAtStr, secret);

  // Constant-time comparison so an attacker can't guess the correct
  // signature one character at a time by measuring response speed.
  const a = hexToBytes(signature);
  const b = hexToBytes(expectedSignature);
  if (!a || !b) return false;
  return timingSafeEqualBytes(a, b);
}

// Convenience helper: returns a 401 Response if the request isn't from a
// logged-in admin, or null if the request is authenticated and can proceed.
//
//   const denied = await rejectIfNotAdmin(req, env);
//   if (denied) return denied;
export async function rejectIfNotAdmin(req, env) {
  if (!(await isAdminRequest(req, env))) {
    return jsonResponse(401, { error: 'Not authenticated. Please log in again.' });
  }
  return null;
}
