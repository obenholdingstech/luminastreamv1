// The stream-stats readout, as data (CEO mandate, 12 Aug 2026: the raw
// metrics leave the viewport and live in a collapsible panel). This module
// decides WHAT the panel says; the component decides where. The honesty
// rules from the inline readout carry over unchanged:
//  - raw passthrough claims VENDOR truth only — native resolution, measured
//    rate, no pipeline labels for work the presented pixels never received
//    (CEO verdict, 6 Aug).
//  - the synthesis tier is the stage's CLAIM; fps is the meter's
//    MEASUREMENT of what the element presents. When they disagree, the
//    disagreement is the diagnosis — so they stay separate lines.
//  - missing numbers render as an honest em dash, never as 0.

/** The always-visible chip: the two numbers a glance needs. */
export function statChip({ presentingRaw, fidelity, deliveredFps }) {
  const height = presentingRaw ? fidelity.vendorNative.height : fidelity.delivering.height;
  return `${height}p${deliveredFps != null ? ` · ${deliveredFps}fps` : ''}`;
}

/** The panel: [term, value] pairs, in render order. */
export function statLines({ presentingRaw, fidelity, deliveredFps, appliedHoldMs }) {
  const rate = deliveredFps != null ? `${deliveredFps} fps` : '—';
  if (presentingRaw) {
    return [
      ['source', 'vendor stream, untouched'],
      ['resolution', `${fidelity.vendorNative.height}p native`],
      ['measured rate', rate],
    ];
  }
  return [
    ['resolution', `${fidelity.delivering.height}p`],
    ['measured rate', rate],
    ['synthesis', fidelity.synthLabel ?? '—'],
    ['upscale', fidelity.upscaleActive ? 'active' : 'pending'],
    ['video hold', fidelity.alignActive ? `${(appliedHoldMs / 1000).toFixed(1)}s behind live` : 'off'],
  ];
}
