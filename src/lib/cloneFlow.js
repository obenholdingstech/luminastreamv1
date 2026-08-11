// The clone modal's workflow, as a pure module (CodeRabbit, PR 106 — the
// adminGate/voiceLibrary rule again). The component keeps React state and
// event binding; THIS owns validation, the read→clone sequence, and the
// outcome mapping. Dependencies are injected so every branch is unit-
// testable without a browser: `readFile(file) → Promise<dataUrl>` and
// `clone(args) → Promise<{ok, message?}>`.

/** Why this submission cannot proceed — or null when it can. */
export function cloneFormRefusal({ name }) {
  if (!name || !name.trim()) return 'give the voice a name';
  return null;
}

/**
 * Run one clone: read the sample, call the API, map the outcome.
 * @returns {Promise<{ ok: boolean, toast?: string, error?: string }>}
 */
export async function runCloneFlow({ file, name, language }, { readFile, clone }) {
  const refused = cloneFormRefusal({ name });
  if (refused) return { ok: false, error: refused };
  let sampleData;
  try {
    sampleData = await readFile(file);
  } catch {
    return { ok: false, error: 'could not read that file — try picking it again' };
  }
  const trimmed = name.trim();
  let res;
  try {
    res = await clone({
      name: trimmed,
      sampleData,
      mimeType: file?.type || undefined,
      ...(language ? { language } : {}),
    });
  } catch {
    // A rejecting transport must come back as a retryable OUTCOME — the
    // modal only re-enables its controls when an outcome returns.
    return { ok: false, error: 'the connection dropped mid-clone — try again' };
  }
  if (res?.ok) {
    return { ok: true, toast: `“${trimmed}” is ready — it's in your voice selector` };
  }
  return { ok: false, error: res?.message ?? 'that did not work — try again' };
}
