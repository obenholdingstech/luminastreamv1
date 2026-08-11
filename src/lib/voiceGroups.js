// Voice selector grouping (CEO mandate, 11 Aug 2026): "clear UI separation
// … between Personal Cloned Voices and Premade System Voices". The agent's
// broadcast now carries `choice_categories` (id → vendor category) next to
// the labels; older broadcasts and the committed manifest carry the
// category only as the label's trailing "(category)" suffix (knobs.py's own
// format), so this module resolves EXPLICIT-FIRST with a label-parse
// fallback — the grouping survives deploy skew and the pre-connect
// manifest alike. Pure and injected-free, per the house lib rule.

// "Your voices" is a POSITIVE claim: only categories the vendor uses for
// account-created voices land there. Anything unknown stays on the system
// side — a mystery voice presented as "yours" would be a lie; the same
// doctrine as the agent's `category == "premade"` policy check, applied
// from the opposite direction.
const PERSONAL_CATEGORIES = new Set(['cloned', 'generated', 'professional']);
// Tokens we recognize as categories when they appear as a label's trailing
// parenthetical. A name's own parenthetical ("Bob (Laid-Back)") must NOT
// be mistaken for a category — or stripped from the display.
const KNOWN_CATEGORIES = new Set([...PERSONAL_CATEGORIES, 'premade', 'famous']);

/**
 * Split a display label into { name, category } — category only when the
 * trailing parenthetical is a KNOWN vendor category, else null with the
 * label untouched.
 */
export function splitVoiceLabel(label) {
  const text = typeof label === 'string' ? label : '';
  const match = /^(.*\S)\s+\(([A-Za-z_-]+)\)$/.exec(text);
  if (match && KNOWN_CATEGORIES.has(match[2].toLowerCase())) {
    return { name: match[1], category: match[2].toLowerCase() };
  }
  return { name: text, category: null };
}

/**
 * Partition the selector's ids into { personal, system } entries
 * ({ id, label }), order preserved within each group. `categories` is the
 * broadcast's explicit id → category map (may be empty); the label suffix
 * is the fallback. Display labels drop the category parenthetical — the
 * group heading now says it.
 */
export function groupVoices(ids, labels = {}, categories = {}) {
  const personal = [];
  const system = [];
  for (const id of ids) {
    const parsed = splitVoiceLabel(labels[id] ?? id);
    const explicit = typeof categories[id] === 'string' ? categories[id].toLowerCase() : null;
    const category = explicit ?? parsed.category;
    // Strip the suffix only when it restates the resolved category —
    // never mangle a name over a parenthetical that meant something else.
    const label = parsed.category === category && parsed.category !== null ? parsed.name : (labels[id] ?? id);
    (PERSONAL_CATEGORIES.has(category ?? '') ? personal : system).push({ id, label });
  }
  return { personal, system };
}
