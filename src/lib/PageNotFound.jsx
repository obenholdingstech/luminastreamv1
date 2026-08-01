import { Link, useLocation } from 'react-router-dom';

// The previous version of this page asked a dead backend whether the visitor
// was an admin, purely so it could offer them build advice. Both the backend
// and the advice are gone; what a 404 owes a visitor is the way back.
export default function PageNotFound() {
  const { pathname } = useLocation();

  return (
    <div className="min-h-screen bg-[#08080F] text-white flex items-center justify-center px-6">
      <div className="text-center max-w-sm">
        <p className="text-[10px] tracking-[0.32em] uppercase text-[#4A5568]">Not found</p>
        <h1 className="mt-4 text-5xl font-extralight text-white/85">404</h1>
        <p className="mt-5 text-[12px] text-[#64748B] leading-relaxed break-words">
          There is nothing at <span className="font-mono text-[#94A3B8]">{pathname}</span>.
        </p>
        <Link
          to="/"
          className="mt-8 inline-flex items-center rounded-full border border-[#1A1A2E] px-6 py-2.5 text-[11px] tracking-[0.18em] uppercase text-[#94A3B8] hover:border-[#6366F1]/50 hover:text-white transition-colors"
        >
          Back to the lens
        </Link>
      </div>
    </div>
  );
}
