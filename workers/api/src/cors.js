// CORS allowlist. Three trusted browser origins:
//   - the production studio (studio.luminastream.live)
//   - the local Vite dev server (localhost:5173)
//   - our Cloudflare Pages preview deploys
//
// The spec says "*.pages.dev previews", but preview URLs for our project are
// always `<hash|branch>.luminastream-studio.pages.dev`, so we scope the
// suffix match to OUR project rather than every Cloudflare Pages site on the
// internet. CORS isn't the security boundary here (the admin password and the
// signed session token are), but least privilege costs nothing. If the Pages
// project is renamed, update PAGES_PROJECT.

const PAGES_PROJECT = 'luminastream-studio';

const STATIC_ALLOWED = new Set([
  'https://studio.luminastream.live',
  'http://localhost:5173',
]);

const ALLOW_METHODS = 'GET, POST, PUT, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, X-Admin-Token';
const MAX_AGE = '86400';

export function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  if (STATIC_ALLOWED.has(origin)) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return (
    url.hostname === `${PAGES_PROJECT}.pages.dev` ||
    url.hostname.endsWith(`.${PAGES_PROJECT}.pages.dev`)
  );
}

// Response CORS headers for an allowed origin, empty object otherwise (so a
// disallowed cross-origin caller can't read the body — the browser blocks it).
//
// Allow-Credentials arrived with P4b: auth sessions travel in an HttpOnly
// cookie, and a credentialed response REQUIRES the exact origin echo this
// module has always done (a wildcard would be rejected by the browser — and
// is forbidden here anyway). The allowlist stays the boundary; CSRF for the
// cookie-authed routes is the Origin gate in authRoutes.js.
export function corsHeaders(origin) {
  if (!isAllowedOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

// Preflight: 204 + CORS for an allowed origin, 403 otherwise.
export function handlePreflight(request) {
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': ALLOW_METHODS,
      'Access-Control-Allow-Headers': ALLOW_HEADERS,
      'Access-Control-Max-Age': MAX_AGE,
      Vary: 'Origin',
    },
  });
}
