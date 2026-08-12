// Voice-preview decisions, pure (the house rule). The PLAYER (a shared
// <audio>, in src/hooks/usePreviewPlayer.js) binds the browser; THIS
// decides what a preview's source is and how a toggle behaves, so both
// are unit-tested without one.

/**
 * Where a voice's preview comes from. OUR vaulted sample wins whenever
 * the voice is the user's own (rowId present) — it is the audio they
 * uploaded, reachable with their session, and it exists even when the
 * vendor offers no clip. System voices fall back to the vendor's
 * preview URL. Null means: render no preview control at all — an
 * honest absence, never a dead player.
 * @returns {{ kind: 'sample'|'url', src: string } | null}
 */
export function previewSource({ rowId = null, previewUrl = null, apiBase = '' }) {
  if (rowId) {
    return { kind: 'sample', src: `${apiBase}/api/me/voices/${encodeURIComponent(rowId)}/sample` };
  }
  if (typeof previewUrl === 'string' && previewUrl) return { kind: 'url', src: previewUrl };
  return null;
}

/**
 * One player, one voice at a time: toggling the playing voice stops it;
 * toggling another switches to it.
 * @returns {{ playingId: string|null, action: 'play'|'stop' }}
 */
export function togglePreview(playingId, id) {
  if (playingId === id) return { playingId: null, action: 'stop' };
  return { playingId: id, action: 'play' };
}
