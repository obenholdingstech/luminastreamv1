// The loading language (CEO mandate, 12 Aug 2026): no generic rotors.
// Two idioms, used everywhere:
//   <Shimmer> — a skeleton block with a soft highlight sweep, for content
//   that is on its way (lists, cards, tables).
//   <PulseDot> — a breathing glow dot, for inline "working" states
//   (cloning, connecting, joining).
// Both are purely presentational; reduced-motion fallbacks live in the
// CSS classes (index.css), not here.

/** A skeleton block. Size it with className (h-*, w-*, rounded-*). */
export function Shimmer({ className = '' }) {
  return <span aria-hidden className={`block lens-shimmer rounded-md ${className}`} />;
}

/**
 * A breathing status dot. `color` is any CSS color — the glow inherits it
 * via currentColor. Decorative by default; the text next to it carries
 * the meaning.
 */
export function PulseDot({ color = '#6366F1', size = 6, className = '' }) {
  return (
    <span
      aria-hidden
      className={`inline-block rounded-full lens-breathe shrink-0 ${className}`}
      style={{ width: size, height: size, backgroundColor: color, color }}
    />
  );
}
