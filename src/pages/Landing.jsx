// The public hero (realignment skeleton — P7 owns the full visual pass).
// One promise, one action: a stranger meets the brand, presses Get Started,
// and lands on the account surface. Nothing here talks to any API.

import { ArrowRight } from 'lucide-react';

import { SURFACE_URLS } from '@/lib/surface';

export default function Landing() {
  return (
    <div className="min-h-screen bg-[#08080F] text-white flex flex-col">
      <header className="px-6 sm:px-10 py-6 flex items-baseline gap-3">
        <span className="text-[13px] tracking-[0.42em] uppercase text-white/90">Lumina</span>
        <span className="text-[13px] tracking-[0.42em] uppercase text-white/35">Stream</span>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <p className="text-[10px] tracking-[0.3em] uppercase text-[#6366F1] mb-6">coming soon</p>
        <h1 className="text-4xl sm:text-5xl font-light tracking-tight max-w-2xl leading-tight [text-wrap:balance]">
          Your identity, everywhere.
        </h1>
        <p className="mt-5 max-w-md text-sm text-[#94A3B8] leading-relaxed">
          One lens between you and every platform — your face, your voice, live. LuminaStream is
          in private development.
        </p>
        <a
          href={SURFACE_URLS.account}
          className="mt-10 inline-flex items-center gap-2 rounded-full bg-white text-[#08080F] px-8 py-3.5 text-[11px] tracking-[0.16em] uppercase hover:opacity-90 transition-opacity"
        >
          Get started <ArrowRight size={14} aria-hidden />
        </a>
      </main>

      <footer className="px-6 py-6 text-center text-[10px] text-[#2E2E44] tracking-wide">
        © {new Date().getFullYear()} Obenholding LTD
      </footer>
    </div>
  );
}
