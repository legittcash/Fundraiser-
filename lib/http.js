// lib/http.js
//
// Tiny helpers that sit between the Cloudflare Workers Request/Response
// objects and the existing API handlers.
//
// The handlers in api/ used to receive Vercel's Node-style (req, res).
// They now receive a small, parsed view of the incoming Request (built by
// parseRequest below) plus the Worker `env` bindings, and they RETURN a
// standard Web Response (built by jsonResponse below). Nothing here
// changes any handler's business logic, query/body shape or JSON output.

// Thrown by parseRequest when a JSON body is present but malformed.
export class InvalidJsonError extends Error {}

// Build a JSON Response. `extraHeaders` is a plain { name: value } object.
// Same output as the old res.status(status).json(body).
export function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

// A response with no body (e.g. 204 for CORS preflight).
export function emptyResponse(status, extraHeaders = {}) {
  return new Response(null, { status, headers: extraHeaders });
}

// Turn a Workers Request into the small object the handlers read:
//   method   "GET" | "POST" | ...
//   url      the parsed URL object
//   query    { name: value } from the query string (like Vercel's req.query)
//   headers  the standard Web Headers object (use headers.get('name'))
//   body     parsed JSON body ({} when there is none), like Vercel's req.body
//   raw      the original Request
//
// A JSON body is parsed when the Content-Type says it is JSON, which is
// exactly when Vercel parsed it. Malformed JSON throws InvalidJsonError
// (Vercel also rejected it with a 400 before the handler ran).
export async function parseRequest(request) {
  const url = new URL(request.url);
  const query = {};
  for (const [key, value] of url.searchParams) {
    if (!(key in query)) query[key] = value;
  }

  let body = {};
  const method = request.method.toUpperCase();
  const contentType = request.headers.get('content-type') || '';
  if (method !== 'GET' && method !== 'HEAD' && contentType.toLowerCase().includes('application/json')) {
    const text = await request.text();
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        throw new InvalidJsonError('Invalid JSON in request body.');
      }
    }
  }

  return { method, url, query, headers: request.headers, body, raw: request };
}
