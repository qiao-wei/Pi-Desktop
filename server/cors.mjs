/**
 * CORS policy for the local API server.
 *
 * The renderer/dev server runs on another origin (e.g. `127.0.0.1:5176` -> `127.0.0.1:6474`),
 * so every request that carries a non-safelisted header is preceded by a preflight.
 * `If-None-Match` is *not* a CORS-safelisted request header (only `If-Modified-Since`
 * is), which means `/api/bootstrap` revalidation needs it listed here - keeping this
 * list in sync with what `src/lib/api.ts` actually sends is asserted by
 * `tests/corsPreflight.test.ts`.
 */

/**
 * Headers the client is allowed to send. Matched case-insensitively by browsers,
 * so the spelling here is only for humans.
 */
export const ALLOWED_REQUEST_HEADERS = ["Content-Type", "If-None-Match", "X-Pi-Desktop-Trace-Id"];

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": ALLOWED_REQUEST_HEADERS.join(", "),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    // `/api/bootstrap` is polled; without this every tick can pay an extra round trip.
    "Access-Control-Max-Age": "600",
  };
}

export function setCors(res) {
  for (const [key, value] of Object.entries(corsHeaders())) {
    res.setHeader(key, value);
  }
}

/** Answer a preflight; returns true when the request was fully handled. */
export function respondToPreflight(req, res) {
  if (req.method !== "OPTIONS") {
    return false;
  }
  setCors(res);
  res.writeHead(204);
  res.end();
  return true;
}
