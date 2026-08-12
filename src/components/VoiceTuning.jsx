// Advanced Voice Settings (CEO mandate, 12 Aug 2026): the taste controls
// — stability, similarity, style — as studio sliders. WHAT renders is
// decided in src/lib/voiceTuning.js (pure, tested) from the agent's own
// broadcast; this component draws, edits locally while dragging, and
// COMMITS on release (the console's proven pointer-up/key-up pattern —
// a drag must not spray the data channel). The value shown between
// edits is the agent's APPLIED truth; a mid-drag edit is local until
// the commit answers.

import { Disclosure, DisclosureButton, DisclosurePanel } from '@headlessui/react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';

import { knobDisplay } from '@/lib/knobState';
import { tuningSliders } from '@/lib/voiceTuning';

const COMMIT_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];

export default function VoiceTuning({ metadata, config, requestAgentConfig }) {
  // name → in-drag value; cleared on commit so the applied truth resumes
  const [edits, setEdits] = useState({});
  const sliders = tuningSliders(metadata, config);
  if (sliders.length === 0) return null;

  const commit = (name, value) => {
    setEdits((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    requestAgentConfig({ [name]: value });
  };

  return (
    <Disclosure>
      <DisclosureButton className="group mt-2 flex items-center gap-1.5 rounded-full border border-[#1A1A2E] px-3 py-1 text-[9px] tracking-[0.14em] uppercase text-[#64748B] transition-colors hover:border-[#475569] hover:text-[#94A3B8]">
        <SlidersHorizontal size={10} aria-hidden />
        advanced voice settings
        <ChevronDown
          size={10}
          aria-hidden
          className="text-[#4A5568] transition-transform group-data-[open]:rotate-180 motion-reduce:transition-none"
        />
      </DisclosureButton>
      <DisclosurePanel className="mt-2 w-full max-w-xs rounded-xl border border-[#1E1E2E] bg-[#0B0B14]/95 px-4 py-3 backdrop-blur-md">
        <div className="space-y-3">
          {sliders.map((s) => {
            const shown = edits[s.name] ?? s.value;
            const disabled = Boolean(s.disabledReason);
            return (
              <div key={s.name}>
                <div className="flex items-baseline justify-between gap-2">
                  <label
                    htmlFor={`tune-${s.name}`}
                    className="text-[9px] tracking-[0.16em] uppercase text-[#94A3B8]"
                  >
                    {s.label}
                  </label>
                  <span className="text-[10px] tabular-nums text-[#E2E8F0]">
                    {knobDisplay(shown)}
                  </span>
                </div>
                <input
                  id={`tune-${s.name}`}
                  type="range"
                  min={s.lo}
                  max={s.hi}
                  step={s.step}
                  value={shown}
                  disabled={disabled}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setEdits((prev) => ({ ...prev, [s.name]: v }));
                  }}
                  onPointerUp={(e) => commit(s.name, Number(e.currentTarget.value))}
                  onKeyUp={(e) => {
                    if (COMMIT_KEYS.includes(e.key)) commit(s.name, Number(e.currentTarget.value));
                  }}
                  className="mt-1 w-full accent-[#6366F1] disabled:opacity-40"
                />
                {disabled ? (
                  <p className="mt-0.5 text-[9px] text-[#F59E0B]">{s.disabledReason}</p>
                ) : (
                  s.hint && <p className="mt-0.5 text-[9px] leading-relaxed text-[#4A5568]">{s.hint}</p>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[8px] tracking-[0.14em] uppercase text-[#3E4A5F]">
          changes apply from the next utterance
        </p>
      </DisclosurePanel>
    </Disclosure>
  );
}
