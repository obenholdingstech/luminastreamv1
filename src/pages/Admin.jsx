// The admin console shell (realignment, CEO 7 Aug 2026 — P8 builds the real
// system here). The DOOR is the deliverable today: only an authenticated
// admin sees anything; a signed-out visitor, a signed-in ordinary user, or
// any stranger typing the URL is walked back to the public web with nothing
// learned — the page renders NOTHING until the verdict is in, so there is
// no flash of admin chrome to screenshot. The decision itself lives in
// src/lib/adminGate.js (pure, tested); this component only renders and
// navigates on its verdict.

import { LogOut, ShieldCheck } from 'lucide-react';

import { useAuth } from '@/hooks/useAuth';
import { adminGate } from '@/lib/adminGate';
import { SURFACE_URLS } from '@/lib/surface';
import { useEffect, useState } from 'react';

export default function Admin() {
  const auth = useAuth();
  const gate = adminGate(auth);
  // A rejected sign-out must be SAID: the session is still active, and a
  // silent failure on an admin surface reads as signed out while the cookie
  // lives on.
  const [signOutError, setSignOutError] = useState('');

  const onSignOut = async () => {
    setSignOutError('');
    try {
      await auth.signOut();
    } catch {
      setSignOutError('sign-out failed — the session is still active; try again');
    }
  };
  // Narrowed once so the effect deps carry a plain string|null — `to` only
  // exists on the redirect verdict.
  const redirectTo = gate.verdict === 'redirect' ? gate.to : null;

  useEffect(() => {
    if (redirectTo) globalThis.location?.replace(redirectTo);
  }, [redirectTo]);

  // Nothing renders until the verdict — a non-admin never sees this surface.
  if (gate.verdict !== 'allow') return null;

  return (
    <div className="min-h-screen bg-[#08080F] text-white flex flex-col">
      <header className="px-6 sm:px-10 py-6 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <span className="text-[13px] tracking-[0.42em] uppercase text-white/90">Lumina</span>
          <span className="text-[13px] tracking-[0.42em] uppercase text-white/35">Stream</span>
          <span className="ml-2 text-[10px] tracking-[0.3em] uppercase text-[#F59E0B]">admin</span>
        </div>
        <div className="flex items-center gap-3">
          {signOutError ? (
            <span role="alert" className="text-[10px] text-[#FCA5A5]">
              {signOutError}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onSignOut}
            className="flex items-center gap-1.5 rounded-full border border-[#475569] px-4 py-1.5 text-[10px] tracking-[0.14em] uppercase text-[#94A3B8] hover:border-[#A5B4FC] hover:text-[#E2E8F0] transition-colors"
          >
            <LogOut size={10} aria-hidden /> sign out
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <ShieldCheck size={28} className="text-[#6366F1] mb-4" aria-hidden />
        <h1 className="text-2xl font-light">
          Admin console{auth.user?.displayName ? ` — ${auth.user.displayName}` : ''}
        </h1>
        <p className="mt-3 max-w-md text-sm text-[#94A3B8] leading-relaxed">
          The door works; the rooms arrive with P8 — people, money, truth, safety, access. Until
          then, operations live in the studio's console and the deploy pipeline.
        </p>
        <a
          href={SURFACE_URLS.studio}
          className="mt-8 rounded-full border border-[#475569] px-6 py-2.5 text-[10px] tracking-[0.16em] uppercase text-[#E2E8F0] hover:border-[#A5B4FC] transition-colors"
        >
          to the studio
        </a>
      </main>

      <footer className="px-6 py-6 text-center text-[10px] text-[#2E2E44] tracking-wide">
        © {new Date().getFullYear()} Obenholding LTD
      </footer>
    </div>
  );
}
