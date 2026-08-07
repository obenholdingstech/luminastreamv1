// The admin surface's access decision, as a pure function (extracted at
// CodeRabbit's review of #91 — the voiceSelection lesson: logic with real
// behavior lives in src/lib/ with a test beside it, not inside a component).
//
// The component renders and navigates; THIS decides. Three verdicts:
//   'pending'   the auth probe has not resolved — render nothing, go nowhere
//               (no flash of admin chrome, no premature redirect)
//   'allow'     a signed-in admin — the only state that sees the surface
//   'redirect'  everyone else — walked back to the public web
//
// Security note, honest: this gate is UX. The real walls are server-side —
// every admin-worthy endpoint checks the session's role at the Worker; this
// merely declines to show a locked door to people without the key.

import { SURFACE_URLS } from './surface.js';

/**
 * @param {{ status: string, user?: { role?: string } | null }} auth
 * @returns {{ verdict: 'pending' } | { verdict: 'allow' } |
 *           { verdict: 'redirect', to: string }}
 */
export function adminGate(auth) {
  if (auth?.status === 'checking') return { verdict: 'pending' };
  if (auth?.status === 'signedIn' && auth.user?.role === 'admin') {
    return { verdict: 'allow' };
  }
  return { verdict: 'redirect', to: SURFACE_URLS.landing };
}
