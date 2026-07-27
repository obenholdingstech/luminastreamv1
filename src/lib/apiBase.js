// Base URL for the backend API, from the VITE_API_BASE build-time env var.
// Default (unset) is '' — legacy Base44 calls then hit same-origin /api paths,
// where they fail soft exactly as they do on localhost now that the Base44
// proxy is dead. When a real API exists, set VITE_API_BASE in the Pages
// project's environment variables (build-time: changing it requires a rebuild).

// Trailing slashes are stripped because every consumer joins with a leading
// slash (the SDK builds `${serverUrl}/api`).
export function normalizeApiBase(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\/+$/, '');
}

export const API_BASE = normalizeApiBase(
  import.meta.env ? import.meta.env.VITE_API_BASE : undefined
);
