// Generate a static layout harness that renders the REAL agent_config broadcast
// with the exact KnobRow / groupKnobs markup from LiveKitTest.jsx, at both the
// old (max-w-2xl) and new (max-w-4xl) container widths — so the fix is verifiable
// by screenshot. Pure layout: this exercises the CSS/grid/flex, which is what
// ticket 4 is about; no live agent or LiveKit connection is needed for that.
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('.', import.meta.url).pathname;
const bc = JSON.parse(readFileSync(dir + 'broadcast.json', 'utf8'));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function knobDisplay(v) {
  if (v == null) return '—';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number')
    return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return String(v);
}

// groupKnobs — preserve broadcast order (exactly like the component)
function groupKnobs(metadata) {
  const groups = [], at = new Map();
  for (const k of metadata || []) {
    if (!at.has(k.group)) { at.set(k.group, groups.length); groups.push({ group: k.group, timing: k.timing, knobs: [] }); }
    groups[at.get(k.group)].knobs.push(k);
  }
  return groups;
}

// KnobRow — identical class strings to src/pages/LiveKitTest.jsx
function knobRow(knob, config) {
  const applied = config[knob.name];
  const value = applied;
  const labelName = (v) => (v != null && knob.choice_labels?.[v]) || v;
  const hasLatency = knob.hint && /latenc/i.test(knob.hint);
  const zap = hasLatency ? '<span class="inline-block ml-1 -mt-0.5 text-[#F59E0B] text-[9px]">⚡</span>' : '';

  let control;
  if (knob.kind === 'enum') {
    const opts = (knob.choices || []).map((c) =>
      `<option${c === value ? ' selected' : ''}>${esc(labelName(c))}</option>`).join('');
    control = `<select class="flex-1 min-w-0 bg-[#13131F] border border-[#1A1A2E] rounded-md px-2 py-1 text-[11px] font-mono text-white">${opts || '<option>—</option>'}</select>`;
  } else if (knob.kind === 'bool') {
    const on = Boolean(value);
    control = `<button class="flex-1 flex items-center gap-1.5 text-[11px] tracking-wide rounded-md px-3 py-1 ${on ? 'bg-[#10B981]/15 border border-[#10B981]/40 text-[#10B981]' : 'border border-[#1A1A2E] text-[#64748B]'}">`
      + `<span class="w-1.5 h-1.5 rounded-full" style="background-color:${on ? '#10B981' : '#4A5568'}"></span>${on ? 'on' : 'off'}</button>`;
  } else {
    control = `<input type="range" min="${knob.lo}" max="${knob.hi}" step="${knob.step}" value="${value ?? knob.lo}" class="flex-1 min-w-0 accent-[#6366F1]">`
      + `<span class="w-10 shrink-0 text-right text-[10px] font-mono tabular-nums text-[#64748B]">${value ?? '—'}</span>`;
  }

  const appliedText = knob.kind === 'enum' && applied != null ? labelName(applied) : knobDisplay(applied);
  return `<div class="flex items-center gap-2 min-w-0">`
    + `<label class="w-28 sm:w-32 shrink-0 truncate text-[10px] tracking-wide text-[#94A3B8]">${esc(knob.label)}${zap}</label>`
    + `<div class="flex-1 min-w-0 flex items-center gap-2">${control}</div>`
    + `<span class="w-16 shrink-0 text-right text-[10px] font-mono tabular-nums truncate" style="color:#10B981">${esc(appliedText)}</span>`
    + `</div>`;
}

function consoleCard(config, groups) {
  const groupHtml = groups.map((g) =>
    `<div class="mb-4 last:mb-0">`
    + `<div class="flex items-center gap-2 mb-2"><span class="text-[9px] tracking-widest uppercase text-[#64748B]">${esc(g.group)}</span>`
    + `<span class="text-[9px] text-[#4A5568] normal-case tracking-normal">applies ${esc(g.timing)}</span></div>`
    + `<div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-2.5">${g.knobs.map((k) => knobRow(k, config)).join('')}</div>`
    + `</div>`).join('');
  return `<div class="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-6 mb-6">`
    + `<div class="flex items-center justify-between mb-4"><h2 class="text-[11px] tracking-widest uppercase text-[#64748B]">Tuning <span class="ml-2 normal-case tracking-normal text-[#6366F1]">tts engine</span> <span class="ml-2 normal-case tracking-normal text-[#4A5568]">agent-confirmed values only</span></h2></div>`
    + groupHtml + `</div>`;
}

const groups = groupKnobs(bc.metadata);
const card = consoleCard(bc.config, groups);

function section(title, maxw, note) {
  return `<div class="text-[11px] tracking-widest uppercase text-[#F59E0B] px-6 pt-6 pb-1">${title}</div>`
    + `<div class="text-[10px] text-[#64748B] px-6 pb-2">${note}</div>`
    + `<div class="${maxw} mx-auto px-6 py-4">${card}</div>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="tw.css"></head>`
  + `<body class="bg-[#080810] text-white">`
  + section('BEFORE — max-w-2xl (672px)', 'max-w-2xl', 'The knob grid splits to 2 columns at lg (viewport ≥1024px) but the container stays 672px → ~320px per cell; the range inputs cannot shrink that far and collide.')
  + `<div class="border-t-2 border-[#F59E0B]/30 my-4"></div>`
  + section('AFTER — max-w-4xl (896px)', 'max-w-4xl', 'Same broadcast, same knob markup; the wider dev container gives each 2-column cell ~432px — sliders, selects and toggles all fit with room.')
  + `</body></html>`;

writeFileSync(dir + 'harness.html', html);
console.log('wrote harness.html with', bc.metadata.length, 'knobs across', groups.length, 'groups');
