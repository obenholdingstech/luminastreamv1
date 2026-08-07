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

  const applyMe = useCallback((res) => {
    if (!mountedRef.current) return;
    if (res.ok) {
      setState({ status: 'signedIn', user: res.user ?? null, profile: res.profile ?? null });
    } else {
      setState({ status: 'signedOut', user: null, profile: null });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    authClient.me().then(applyMe);
    return () => {
      mountedRef.current = false;
    };
  }, [authClient, applyMe]);

  const signIn = useCallback(
    async (credentials) => {
      const res = await authClient.signIn(credentials);
      if (res.ok) applyMe(await authClient.me());
      return res;
    },
    [authClient, applyMe],
  );

  const signUp = useCallback(
    async (fields) => {
      const res = await authClient.signUp(fields);
      if (res.ok) applyMe(await authClient.me());
      return res;
    },
    [authClient, applyMe],
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
