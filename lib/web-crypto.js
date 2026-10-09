// lib/web-crypto.js
//
// Cloudflare-compatible replacements for the few Node `crypto` / `Buffer`
// calls the project used. Everything here uses only the standard Web
// Crypto API (crypto.subtle / crypto.getRandomValues), which Workers
// provide natively — no nodejs_compat flag needed.

const encoder = new TextEncoder();

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Strict hex decoder. Returns null for anything that is not an even-length
// string of hex digits (callers treat null as "does not match").
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// base64url without padding (same alphabet as Node's 'base64url').
export function bytesToBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Equivalent of crypto.randomBytes(n), returned as a Uint8Array.
export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomHex(n) {
  return bytesToHex(randomBytes(n));
}

export function randomBase64Url(n) {
  return bytesToBase64Url(randomBytes(n));
}

// HMAC (sha256 / sha512) of a string with a string secret; returns hex.
// Equivalent of crypto.createHmac(algo, secret).update(value).digest('hex').
export async function hmacHex(algorithm, secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToHex(new Uint8Array(signature));
}

// Constant-time comparison of two byte arrays of the SAME length
// (returns false immediately when lengths differ, like the old
// timingSafeEqual guard).
export function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Constant-time string comparison that does not leak the length either:
// both values are hashed with SHA-256 first, then the fixed-size digests
// are compared. Used for the admin username/password check.
export async function safeEqualStrings(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b))),
  ]);
  return timingSafeEqualBytes(new Uint8Array(da), new Uint8Array(db));
}

// Constant-time comparison of two hex strings (e.g. HMAC signatures).
// Returns false if either is not valid hex or the lengths differ.
export function timingSafeEqualHex(hexA, hexB) {
  const a = hexToBytes(hexA);
  const b = hexToBytes(hexB);
  if (!a || !b) return false;
  return timingSafeEqualBytes(a, b);
}

// Equivalent of Buffer.from(base64String, 'base64'): returns a Uint8Array,
// or null when the input is not valid base64. Whitespace is ignored and
// the URL-safe alphabet and missing padding are accepted, as Buffer does.
export function base64ToBytes(input) {
  try {
    let s = String(input).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4 !== 0) s += '=';
    const binary = atob(s);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
