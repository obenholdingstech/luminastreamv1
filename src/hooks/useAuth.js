// P4b-ui — account state for the lens. One status machine, no surprises:
//
//   checking   the mount probe (/api/auth/me) is in flight — render neither
//              a sign-in form nor a signed-in chip; a flash of the wrong one
//              is the kind of jank that reads as broken auth
//   signedOut  no live session — show the form
//   signedIn   user + profile loaded — the lens applies the saved identity
//
// The session itself is an HttpOnly cookie: this hook never sees a token,
// only the answers the server gives a credentialed request.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createAuthClient } from '@/lib/authClient';

/** @param {{ client?: ReturnType<typeof createAuthClient> }} [deps] */
export function useAuth({ client } = {}) {
  const authClient = useMemo(() => client ?? createAuthClient(), [client]);
  const [state, setState] = useState({ status: 'checking', user: null, profile: null });
  const mountedRef = useRef(true);

  // Only an AUTHENTICATION answer may downgrade to signedOut — a transport
  // failure on the probe says nothing about the session (the cookie may be
  // perfectly valid), and discarding a just-accepted sign-in over a network
  // blip would show the form again with no explanation (CodeRabbit, PR 86).
  const applyProbe = useCallback((res) => {
    if (!mountedRef.current) return;
    if (res.ok) {
      setState({ status: 'signedIn', user: res.user ?? null, profile: res.profile ?? null });
    } else if (res.error === 'unauthenticated') {
      setState({ status: 'signedOut', user: null, profile: null });
    } else {
      // Transport failure: leave signedIn alone; resolve the mount-time
      // 'checking' to the form (the one state that must not persist).
      setState((prev) =>
        prev.status === 'checking' ? { status: 'signedOut', user: null, profile: null } : prev,
      );
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    authClient.me().then(applyProbe);
    return () => {
      mountedRef.current = false;
    };
  }, [authClient, applyProbe]);

  // A successful sign-in IS the truth — the server accepted the credentials
  // and set the cookie — so signedIn lands immediately from that response;
  // the follow-up probe only ENRICHES (profile), and its failure cannot
  // un-sign-in anyone (applyProbe above).
  const settle = useCallback(
    async (res) => {
      if (!res.ok) return res;
      if (mountedRef.current) {
        setState({ status: 'signedIn', user: res.user ?? null, profile: null });
      }
      applyProbe(await authClient.me());
      return res;
    },
    [authClient, applyProbe],
  );

  const signIn = useCallback(
    async (credentials) => settle(await authClient.signIn(credentials)),
    [authClient, settle],
  );

  const signUp = useCallback(
    async (fields) => settle(await authClient.signUp(fields)),
    [authClient, settle],
  );

  const signOut = useCallback(async () => {
    await authClient.signOut();
    if (mountedRef.current) setState({ status: 'signedOut', user: null, profile: null });
  }, [authClient]);

  // Fire-and-forget by design: identity autosave must never block the lens,
  // and a failed save costs one localStorage-only session, not a feature.
  const saveProfile = useCallback(
    (fields) => {
      authClient.saveProfile(fields).catch(() => {});
    },
    [authClient],
  );

  return { ...state, signIn, signUp, signOut, saveProfile };
}
