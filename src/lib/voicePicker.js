// The voice picker's decisions, as a pure module (the house rule): which
// tab shows which group, and what a search query keeps. The component
// (VoicePicker.jsx) renders and binds keys; THIS owns filtering, so the
// behavior is unit-tested without a browser.

export const PICKER_TABS = [
  { id: 'all', label: 'all' },
  { id: 'mine', label: 'my voices' },
  { id: 'system', label: 'system' },
];

/** Case-insensitive substring match; a blank query keeps everything. */
export function matchesQuery(label, query) {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return true;
  return (label ?? '').toLowerCase().includes(q);
}

/**
 * Apply tab + query to grouped voices ({ personal, system } of
 * { id, label }). Returns the same shape, filtered — the tab EMPTIES the
 * group it excludes rather than reordering anything, so the rendered
 * sections keep their meaning and order.
 */
export function filterVoiceGroups({ personal = [], system = [] }, { tab = 'all', query = '' } = {}) {
  const keep = (list) => list.filter((v) => matchesQuery(v.label, query));
  return {
    personal: tab === 'system' ? [] : keep(personal),
    system: tab === 'mine' ? [] : keep(system),
  };
}

/** The empty-state sentence, honest about WHY the list is empty. */
export function pickerEmptyLine({ personal, system }, { tab = 'all', query = '' } = {}) {
  if (personal.length > 0 || system.length > 0) return null;
  const q = (query ?? '').trim();
  if (q) return `nothing matches “${q}”`;
  if (tab === 'mine') return 'no cloned voices yet — clone one from a sample below';
  return 'no voices available';
}
