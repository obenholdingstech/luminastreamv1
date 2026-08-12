// The one preview player. A MODULE-scoped <audio> is deliberate: every
// surface that offers previews (the picker, the voice cards) shares it,
// so two previews can never talk over each other — the pure toggle rule
// lives in src/lib/previewPlayer.js. Vaulted samples are fetched WITH
// credentials (the cookie is the authority, same as avatarObjectUrl) and
// played from an object URL, which is revoked on the next play and on
// unload; vendor clips play straight from their public URL.

import { useCallback, useEffect, useState } from 'react';

import { togglePreview } from '@/lib/previewPlayer';

const shared = {
  audio: null,
  objectUrl: null,
  playingId: null,
  // EVERY mounted hook paints the playing indicator — the picker and the
  // library cards share one player, so both must repaint on a switch.
  listeners: new Set(),
};

function announce(id) {
  shared.playingId = id;
  for (const paint of shared.listeners) paint(id);
}

function stopShared() {
  if (shared.audio) {
    shared.audio.pause();
    shared.audio.src = '';
  }
  if (shared.objectUrl) {
    URL.revokeObjectURL(shared.objectUrl);
    shared.objectUrl = null;
  }
}

export function usePreviewPlayer() {
  const [playingId, setPlayingId] = useState(null);

  useEffect(() => {
    shared.listeners.add(setPlayingId);
    return () => {
      shared.listeners.delete(setPlayingId);
      if (shared.listeners.size === 0) {
        stopShared();
        shared.playingId = null;
      }
    };
  }, []);

  const toggle = useCallback(async (id, source) => {
    const next = togglePreview(shared.playingId, id);
    announce(next.playingId);
    stopShared();
    if (next.action === 'stop' || !source) return;
    try {
      if (!shared.audio) {
        shared.audio = new Audio();
        shared.audio.addEventListener('ended', () => announce(null));
      }
      let src = source.src;
      if (source.kind === 'sample') {
        // cookie-walled route — fetch with credentials, play the blob
        const res = await fetch(source.src, { credentials: 'include' });
        if (!res.ok) throw new Error('sample unavailable');
        const blob = await res.blob();
        // staleness is checked BEFORE the object URL exists — a superseded
        // response must never mint a URL nothing will ever revoke
        if (shared.playingId !== id) return;
        shared.objectUrl = URL.createObjectURL(blob);
        src = shared.objectUrl;
      }
      // a newer toggle may have superseded this async fetch
      if (shared.playingId !== id) return;
      shared.audio.src = src;
      await shared.audio.play();
    } catch {
      // an unplayable preview clears the state instead of lying
      if (shared.playingId === id) announce(null);
    }
  }, []);

  return { playingId, toggle };
}
