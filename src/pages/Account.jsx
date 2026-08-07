// The account surface (realignment skeleton — P7 owns the polish). This is
// where auth LIVES now: sign in / create account / Google, verification
// status, and the one outbound edge — a signed-in, allowed user is walked
// into the studio. Nobody has to find this page by typing; the hero's Get
// Started lands here, and the studio bounces the signed-out here.

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, Loader2, MailWarning } from 'lucide-react';

import { AccountPanel } from '@/components/AccountPanel';
import { useAuth } from '@/hooks/useAuth';
import { API_BASE } from '@/lib/apiBase';
import { SURFACE_URLS } from '@/lib/surface';

export default function Account() {
  const auth = useAuth();
  const [config, setConfig] = useState(null);
  const [resendState, setResendState] = useState('idle'); // idle | busy | sent

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/config`)
      .then((r) => r.json())
      .then((c) => setConfig(c?.ok ? c : null))
      .catch(() => setConfig(null));
  }, []);

  // ?verify=ok|expired|invalid — the landing spot for the email link.
  const verifyOutcome = useMemo(
    () => new URLSearchParams(globalThis.location?.search ?? '').get('verify'),
    [],
  );

  const user = auth.status === 'signedIn' ? auth.user : null;
  const mayEnter = Boolean(user && (user.role === 'admin' || user.verified));

  const resend = async () => {
    setResendState('busy');
    try {
      await fetch(`${API_BASE}/api/auth/resend-verification`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      /* the banner below stays; the user can try again */
    }
    setResendState('sent');
  };

  return (
    <div className="min-h-screen bg-[#08080F] text-white flex flex-col">
      <header className="px-6 sm:px-10 py-6 flex items-baseline gap-3">
        <a href={SURFACE_URLS.landing} className="flex items-baseline gap-3">
          <span className="text-[13px] tracking-[0.42em] uppercase text-white/90">Lumina</span>
          <span className="text-[13px] tracking-[0.42em] uppercase text-white/35">Stream</span>
        </a>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-md flex flex-col gap-6">
          <div className="text-center">
            <p className="text-[10px] tracking-[0.3em] uppercase text-[#6366F1]">your account</p>
            <h1 className="mt-2 text-2xl font-light">
              {auth.status === 'signedIn' ? 'Welcome back' : 'Sign in to LuminaStream'}
            </h1>
          </div>

          {verifyOutcome === 'ok' && (
            <p className="flex items-center justify-center gap-2 text-[12px] text-[#10B981]" role="status">
              <CheckCircle2 size={14} aria-hidden /> Email verified — you're clear to enter the studio.
            </p>
          )}
          {(verifyOutcome === 'expired' || verifyOutcome === 'invalid') && (
            <p className="flex items-center justify-center gap-2 text-[12px] text-[#F59E0B]" role="alert">
              <MailWarning size={14} aria-hidden /> That verification link is no longer valid — sign
              in and request a fresh one below.
            </p>
          )}

          <AccountPanel auth={auth} />

          {auth.status === 'signedOut' && config?.googleEnabled && (
            <a
              href={`${API_BASE}/api/auth/google`}
              className="flex items-center justify-center gap-2 rounded-full border border-[#475569] px-4 py-2.5 text-[10px] tracking-[0.14em] uppercase text-[#E2E8F0] hover:border-[#A5B4FC] transition-colors"
            >
              continue with Google
            </a>
          )}

          {user && mayEnter && (
            <a
              href={SURFACE_URLS.studio}
              className="flex items-center justify-center gap-2 rounded-full bg-white text-[#08080F] px-6 py-3 text-[11px] tracking-[0.16em] uppercase hover:opacity-90 transition-opacity"
            >
              enter the studio <ArrowRight size={13} aria-hidden />
            </a>
          )}

          {user && !mayEnter && (
            <div className="flex flex-col items-center gap-2 text-center">
              <p className="text-[12px] text-[#F59E0B]">
                <MailWarning size={13} className="inline mr-1" aria-hidden />
                Verify your email to enter the studio — check your inbox for the link.
              </p>
              <button
                type="button"
                onClick={resend}
                disabled={resendState === 'busy'}
                className="flex items-center gap-1.5 rounded-full border border-[#475569] px-4 py-1.5 text-[10px] tracking-[0.14em] uppercase text-[#94A3B8] hover:border-[#A5B4FC] hover:text-[#E2E8F0] disabled:opacity-40 transition-colors"
              >
                {resendState === 'busy' && <Loader2 size={10} className="animate-spin" aria-hidden />}
                {resendState === 'sent' ? 'sent — check your inbox' : 'resend verification email'}
              </button>
              {config && !config.emailEnabled && (
                <p className="text-[10px] text-[#64748B]">
                  (verification mail is not yet enabled on this deployment)
                </p>
              )}
            </div>
          )}
        </div>
      </main>

      <footer className="px-6 py-6 text-center text-[10px] text-[#2E2E44] tracking-wide">
        © {new Date().getFullYear()} Obenholding LTD
      </footer>
    </div>
  );
}
