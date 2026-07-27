// Base URL for the backend API, from the VITE_API_BASE build-time env var.
// Default (unset) is '' — legacy Base44 calls then go to same-origin /api
// paths, which no longer have a backend anywhere. The failure shape differs
// by host: the local dev server returns a plain 404 (the proxy is dead),
// while Cloudflare Pages' SPA fallback answers /api paths with the app shell
// (index.html, HTTP 200). AuthContext tolerates both (error → fail-soft
// authError; a shell "success" is inert because nothing reads the settings),
// so the app renders either way. When a real API exists, set VITE_API_BASE
// in the Pages project's environment variables (build-time: changing it
// requires a rebuild).

// Trailing slashes are stripped because every consumer joins with a leading
// slash (the SDK builds `${serverUrl}/api`).
export function normalizeApiBase(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\/+$/, '');
}

export const API_BASE = normalizeApiBase(
  import.meta.env ? import.meta.env.VITE_API_BASE : undefined
);
