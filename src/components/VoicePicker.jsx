// The custom voice selector (CEO mandate, 12 Aug 2026: no native selects;
// search, filter tabs, and a premium panel). Built on Headless UI's
// Combobox — the input IS the trigger, the ElevenLabs-studio pattern:
// click the voice field, the panel opens; type, it filters. Keyboard,
// focus, and ARIA semantics come from the primitive; the DECISIONS
// (tab/query filtering, empty-state wording) live in src/lib/voicePicker
// and are unit-tested there.

import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from '@headlessui/react';
import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { PICKER_TABS, filterVoiceGroups, pickerEmptyLine } from '@/lib/voicePicker';

function OptionRow({ voice, personal }) {
  return (
    <ComboboxOption
      value={voice.id}
      className="group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 data-[focus]:bg-[#161626]"
    >
      <Check
        size={12}
        aria-hidden
        className="shrink-0 text-[#6366F1] opacity-0 group-data-[selected]:opacity-100"
      />
      <span className="min-w-0 flex-1 truncate text-[12px] normal-case tracking-normal text-[#E2E8F0]">
        {voice.label}
      </span>
      <span
        className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[8px] tracking-[0.14em] uppercase ${
          personal
            ? 'border-[#6366F1]/40 text-[#A5B4FC]'
            : 'border-[#1E1E2E] text-[#4A5568]'
        }`}
      >
        {personal ? 'yours' : 'system'}
      </span>
    </ComboboxOption>
  );
}

function GroupSection({ heading, voices, personal }) {
  if (voices.length === 0) return null;
  return (
    <div>
      <p className="px-3 pb-1 pt-2 text-[9px] tracking-[0.22em] uppercase text-[#4A5568]">
        {heading}
      </p>
      {voices.map((v) => (
        <OptionRow key={v.id} voice={v} personal={personal} />
      ))}
    </div>
  );
}

export default function VoicePicker({ id, value, onChange, groups, labels, disabled = false }) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('all');
  const filtered = filterVoiceGroups(groups, { tab, query });
  const empty = pickerEmptyLine(filtered, { tab, query });

  return (
    <Combobox
      value={value || null}
      onChange={(picked) => {
        // Headless UI reports null on clear-like interactions; the lens
        // never "unchooses" a voice — only a real pick is forwarded.
        if (picked) onChange(picked);
      }}
      onClose={() => setQuery('')}
      disabled={disabled}
      immediate
    >
      <div className="relative">
        <ComboboxInput
          id={id}
          aria-label="voice"
          placeholder="choose a voice…"
          displayValue={(v) => (v ? (labels[v] ?? v) : '')}
          onChange={(e) => setQuery(e.target.value)}
          className="w-56 max-w-full rounded-full border border-[#1A1A2E] bg-transparent py-1.5 pl-3 pr-8 text-[10px] text-[#94A3B8] placeholder:text-[#3E4A5F] focus:border-[#6366F1] focus:outline-none"
        />
        <ComboboxButton
          aria-label="open the voice list"
          className="absolute inset-y-0 right-0 flex items-center px-2.5 text-[#4A5568]"
        >
          <ChevronDown size={12} aria-hidden />
        </ComboboxButton>
      </div>

      <ComboboxOptions
        anchor="bottom start"
        transition
        className="z-50 mt-2 w-[var(--input-width)] min-w-64 origin-top rounded-xl border border-[#1E1E2E] bg-[#0B0B14]/95 p-1.5 shadow-2xl backdrop-blur-md transition duration-150 ease-out data-[closed]:scale-95 data-[closed]:opacity-0 motion-reduce:transition-none"
      >
        {/* the filter tabs — a REQUEST about which shelf to browse; the
            search below applies within it */}
        <div className="flex items-center gap-1 border-b border-[#14141F] px-1.5 pb-1.5">
          {PICKER_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-full px-2.5 py-1 text-[9px] tracking-[0.14em] uppercase transition-colors ${
                tab === t.id
                  ? 'bg-[#161626] text-[#E2E8F0]'
                  : 'text-[#4A5568] hover:text-[#94A3B8]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="max-h-72 overflow-y-auto custom-scrollbar">
          <GroupSection heading="your voices" voices={filtered.personal} personal />
          <GroupSection heading="system voices" voices={filtered.system} personal={false} />
          {empty && (
            <p className="px-3 py-4 text-center text-[11px] text-[#64748B]">{empty}</p>
          )}
        </div>
      </ComboboxOptions>
    </Combobox>
  );
}
