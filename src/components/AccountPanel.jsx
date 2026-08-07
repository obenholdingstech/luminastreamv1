// P4b-ui — the account surface on the access screen. Three states, no
// flashes: 'checking' renders nothing (a sign-in form that blinks into a
// signed-in chip reads as broken auth), 'signedOut' is the compact form,
// 'signedIn' is a one-line chip with the only action that matters there.
//
// The form owns its own draft state (email/password/mode/busy/error) — that
// state's lifecycle ends at submit, so it lives here rather than in a lib
// (the lib-with-a-test rule covers state that OUTLIVES interactions; a
// text field draft does not).

import { useEffect, useRef, useState } from 'react';
import { Loader2, LogOut, UserRound } from 'lucide-react';

// Cloudflare Turnstile, loaded once and rendered explicitly. The widget is
// the CLIENT half of the sign-up bot wall — the server enforces with
// siteverify whenever its secret exists, so shipping enforcement without
// this widget would 403 every human (CodeRabbit, PR 88).
let turnstileScriptPromise = null;
function loadTurnstile() {
  turnstileScriptPromise ??= new Promise((resolve, reject) => {
    if (globalThis.turnstile) return resolve(globalThis.turnstile);
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => resolve(globalThis.turnstile);
    script.onerror = () => {
      turnstileScriptPromise = null; // a CDN blip must not poison every retry
      reject(new Error('turnstile failed to load'));
    };
    document.head.appendChild(script);
  });
  return turnstileScriptPromise;
}

export function AccountPanel({ auth, turnstileSiteKey = null }) {
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileHostRef = useRef(null);
  const turnstileWidgetRef = useRef(null);

  const needsTurnstile = mode === 'signup' && Boolean(turnstileSiteKey);
  useEffect(() => {
    if (!needsTurnstile || !turnstileHostRef.current) return undefined;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !turnstileHostRef.current || turnstileWidgetRef.current != null) return;
        turnstileWidgetRef.current = turnstile.render(turnstileHostRef.current, {
          sitekey: turnstileSiteKey,
          theme: 'dark',
          callback: (token) => setTurnstileToken(token),
          'expired-callback': () => setTurnstileToken(''),
        });
      })
      .catch(() => {
        /* the server will refuse without a token; the error line explains */
      });
    return () => {
      cancelled = true;
      if (turnstileWidgetRef.current != null) {
        try {
          globalThis.turnstile?.remove(turnstileWidgetRef.current);
        } catch {
          /* widget already gone */
        }
        turnstileWidgetRef.current = null;
        setTurnstileToken('');
      }
    };
  }, [needsTurnstile, turnstileSiteKey]);

  if (auth.status === 'checking') return null;

  if (auth.status === 'signedIn') {
    return (
      <div className="flex items-center justify-center gap-3 text-[10px] tracking-[0.14em] uppercase text-[#94A3B8]">
        <UserRound size={11} aria-hidden />
        <span>
          signed in{auth.user?.displayName ? ` as ${auth.user.displayName}` : ''} — your identity
          loads with the lens
        </span>
        <button
          type="button"
          onClick={auth.signOut}
          className="flex items-center gap-1 rounded-full border border-[#475569] px-3 py-1 hover:text-[#A5B4FC] hover:border-[#A5B4FC] transition-colors"
        >
          <LogOut size={10} aria-hidden /> sign out
        </button>
      </div>
    );
  }

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const res =
      mode === 'signup'
        ? await auth.signUp({
            email,
            password,
            displayName: displayName || undefined,
            turnstileToken: turnstileToken || undefined,
          })
        : await auth.signIn({ email, password });
    setBusy(false);
    if (!res.ok) {
      if (res.message) setError(res.message);
      // A consumed/failed challenge token is single-use — reset the widget
      // so the retry gets a fresh one.
      if (needsTurnstile && turnstileWidgetRef.current != null) {
        try {
          globalThis.turnstile?.reset(turnstileWidgetRef.current);
        } catch {
          /* widget already gone */
        }
        setTurnstileToken('');
      }
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col items-center gap-2">
      <div className="flex items-center gap-2 text-[9px] tracking-[0.2em] uppercase text-[#4A5568]">
        <button
          type="button"
          onClick={() => setMode('signin')}
          className={mode === 'signin' ? 'text-[#E2E8F0]' : 'hover:text-[#94A3B8] transition-colors'}
        >
          sign in
        </button>
        <span aria-hidden>·</span>
        <button
          type="button"
          onClick={() => setMode('signup')}
          className={mode === 'signup' ? 'text-[#E2E8F0]' : 'hover:text-[#94A3B8] transition-colors'}
        >
          create account
        </button>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 w-full">
        {mode === 'signup' && (
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="name (optional)"
            autoComplete="name"
            className="flex-1 min-w-0 bg-[#0C0C16] border border-[#1A1A2E] rounded-full px-4 py-2 text-xs text-white placeholder:text-[#2E2E44] focus:outline-none focus:border-[#6366F1]/60 transition-colors"
          />
        )}
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email"
          autoComplete="email"
          className="flex-1 min-w-0 bg-[#0C0C16] border border-[#1A1A2E] rounded-full px-4 py-2 text-xs text-white placeholder:text-[#2E2E44] focus:outline-none focus:border-[#6366F1]/60 transition-colors"
        />
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === 'signup' ? 'password (10+ chars)' : 'password'}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          className="flex-1 min-w-0 bg-[#0C0C16] border border-[#1A1A2E] rounded-full px-4 py-2 text-xs text-white placeholder:text-[#2E2E44] focus:outline-none focus:border-[#6366F1]/60 transition-colors"
        />
        <button
          type="submit"
          disabled={busy || !email || !password}
          className="flex items-center justify-center gap-1.5 rounded-full border border-[#475569] px-4 py-2 text-[10px] tracking-[0.14em] uppercase text-[#E2E8F0] disabled:opacity-40 hover:border-[#A5B4FC] transition-colors"
        >
          {busy && <Loader2 size={11} className="animate-spin" aria-hidden />}
          {mode === 'signup' ? 'create' : 'sign in'}
        </button>
      </div>
      {needsTurnstile && <div ref={turnstileHostRef} className="flex justify-center" />}
      {error && (
        <p role="alert" className="text-[10px] text-[#F59E0B] text-center">
          {error}
        </p>
      )}
    </form>
  );
}
