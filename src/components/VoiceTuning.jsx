// Advanced Voice Settings (CEO mandate, 12 Aug 2026): the taste controls
// — stability, similarity, style — as studio sliders. WHAT renders is
// decided in src/lib/voiceTuning.js (pure, tested) from the agent's own
// broadcast; the REQUEST lifecycle is src/lib/tuningRequests.js
// (CodeRabbit, this PR): a committed value stays visibly pending until
// the agent's broadcast answers it — applied, adjusted, or rejected —
// because snapping back to stale truth would misreport the user's own
// action. A failed publish clears immediately with a visible error.
// Commits happen on release (the console's proven pointer-up/key-up
// pattern — a drag must not spray the data channel).

import { Disclosure, DisclosureButton, DisclosurePanel } from '@headlessui/react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';

import { knobDisplay } from '@/lib/knobState';
import { tuningSliders } from '@/lib/voiceTuning';
import { beginRequest, clearRequest, hasPending, resolveRequests } from '@/lib/tuningRequests';

const COMMIT_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];

export default function VoiceTuning({ metadata, config, adjusted, rejected, requestAgentConfig }) {
  // name → in-drag value (local, uncommitted)
  const [edits, setEdits] = useState({});
  // name → requested value, awaiting the agent's answer
  const [pending, setPending] = useState({});
  const [sendError, setSendError] = useState('');

  // Every fresh broadcast settles what it answers; the rest stays pending.
  useEffect(() => {
    setPending((prev) => resolveRequests(prev, { config, adjusted, rejected }));
  }, [config, adjusted, rejected]);

  const sliders = tuningSliders(metadata, config);
  if (sliders.length === 0) return null;

  const commit = async (name, value) => {
    // SINGLE-FLIGHT: one request per knob. The slider is disabled while
    // its knob is pending, and this guard covers the same-tick race —
    // without it, a stale answer to the first request could clear a
    // newer one the protocol has no id to distinguish.
    if (hasPending(pending, name)) return;
    setEdits((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    setSendError('');
    setPending((prev) => beginRequest(prev, name, value));
    const ok = await requestAgentConfig({ [name]: value });
    if (!ok) {
      // nothing was asked — pending clears NOW, with words, not silence
      setPending((prev) => clearRequest(prev, name));
      setSendError('that change did not reach the agent — try again');
    }
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
            const isPending = hasPending(pending, s.name);
            const shown = edits[s.name] ?? pending[s.name] ?? s.value;
            // disabled while in flight too — one request per knob is what
            // makes name-match correlation sound (see tuningRequests.js)
            const disabled = Boolean(s.disabledReason) || isPending;
            return (
              <div key={s.name}>
                <div className="flex items-baseline justify-between gap-2">
                  <label
                    htmlFor={`tune-${s.name}`}
                    className="text-[9px] tracking-[0.16em] uppercase text-[#94A3B8]"
                  >
                    {s.label}
                  </label>
                  {/* amber while the request is in flight — the number shown
                      is what was ASKED, and the tint says "not yet truth" */}
                  <span
                    className={`text-[10px] tabular-nums ${isPending ? 'text-[#FBBF24]' : 'text-[#E2E8F0]'}`}
                  >
                    {knobDisplay(shown)}
                    {isPending && '…'}
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
        {sendError && (
          <p role="alert" className="mt-2 text-[9px] text-[#FCA5A5]">
            {sendError}
          </p>
        )}
        <p className="mt-3 text-[8px] tracking-[0.14em] uppercase text-[#3E4A5F]">
          changes apply from the next utterance
        </p>
      </DisclosurePanel>
    </Disclosure>
  );
}
