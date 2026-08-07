// The per-user avatar library (P4c). Signed-in users manage the identities
// attached to THEIR account — the server scopes every key by the session,
// so this component holds no user id. Decisions live in
// src/lib/avatarLibrary.js (pure, tested); this component keeps React
// state, the thumbnail object-URL lifecycle, and the {notice, changed}
// mapping. A failed list is a rendered state with a retry — never an
// eternal "loading…" — and reloads are sequenced so a stale response can
// never overwrite a fresher list (the #95 lessons, applied at birth).
//
// Selection here is SERVER truth (the profile's avatar_key); the parent
// learns the chosen id through onSelected and decides what it means for a
// running or future session.

import { ImagePlus, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { afterDelete, afterSelect } from '@/lib/avatarLibrary';
import { avatarObjectUrl, deleteAvatar, listAvatars, selectAvatar } from '@/lib/avatarClient';

export default function AvatarLibrary({ onSelected, revision = 0 }) {
  // phase: 'loading' | 'error' | 'ready'
  const [list, setList] = useState({ phase: 'loading', items: [] });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [thumbs, setThumbs] = useState({}); // id → object URL
  const reloadSeq = useRef(0);
  const thumbsRef = useRef({});

  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    const items = await listAvatars();
    if (seq !== reloadSeq.current) return;
    setList(items === null ? { phase: 'error', items: [] } : { phase: 'ready', items });
  }, []);

  useEffect(() => {
    reload();
  }, [reload, revision]);

  // Thumbnails: fetch bytes for ids we don't hold yet; revoke what vanished.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const wanted = new Set(list.items.map((a) => a.id));
      const current = thumbsRef.current;
      for (const [id, url] of Object.entries(current)) {
        if (!wanted.has(id)) {
          URL.revokeObjectURL(url);
          delete current[id];
        }
      }
      for (const a of list.items) {
        if (current[a.id]) continue;
        const url = await avatarObjectUrl(a.id);
        if (cancelled) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (url) current[a.id] = url;
      }
      if (!cancelled) setThumbs({ ...current });
    })();
    return () => {
      cancelled = true;
    };
  }, [list.items]);

  // Unmount: every URL handed out must meet revokeObjectURL.
  useEffect(
    () => () => {
      for (const url of Object.values(thumbsRef.current)) URL.revokeObjectURL(url);
      thumbsRef.current = {};
    },
    [],
  );

  const applyOutcome = async ({ notice: line, changed }, selectedId) => {
    setNotice(line);
    if (changed) {
      await reload();
      if (selectedId) onSelected?.(selectedId);
    }
  };

  const onPick = async (id) => {
    setBusy(true);
    setNotice('');
    await applyOutcome(afterSelect(await selectAvatar(id)), id);
    setBusy(false);
  };

  const onDelete = async (id) => {
    setBusy(true);
    setNotice('');
    await applyOutcome(afterDelete(await deleteAvatar(id)), null);
    setBusy(false);
  };

  if (list.phase === 'loading') {
    return <p className="mt-2 text-[11px] text-[#64748B]">loading your avatars…</p>;
  }
  if (list.phase === 'error') {
    return (
      <p className="mt-2 flex items-center gap-2 text-[11px] text-[#FBBF24]">
        could not load your avatars
        <button
          type="button"
          onClick={reload}
          className="flex items-center gap-1 text-[#A5B4FC] hover:text-[#E2E8F0] transition-colors"
        >
          <RefreshCw size={10} aria-hidden /> retry
        </button>
      </p>
    );
  }

  return (
    <div className="mt-2">
      {list.items.length === 0 ? (
        <p className="flex items-center gap-1.5 text-[11px] text-[#64748B]">
          <ImagePlus size={11} aria-hidden /> uploads are saved here — your identities, ready on
          any device
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {list.items.map((a) => (
            <li key={a.id} className="relative group">
              <button
                type="button"
                disabled={busy}
                onClick={() => onPick(a.id)}
                title={a.selected ? `${a.name} (selected)` : `use ${a.name}`}
                className={`block h-12 w-12 overflow-hidden rounded-lg border transition-colors ${
                  a.selected
                    ? 'border-[#6366F1] ring-1 ring-[#6366F1]'
                    : 'border-[#1E1E2E] hover:border-[#475569]'
                } disabled:opacity-50`}
              >
                {thumbs[a.id] ? (
                  <img src={thumbs[a.id]} alt={a.name} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center">
                    <Loader2 size={12} className="animate-spin text-[#475569]" aria-hidden />
                  </span>
                )}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDelete(a.id)}
                title={`delete ${a.name}`}
                // Always rendered and focusable — touch users cannot hover
                // and keyboard users cannot focus a hidden control
                // (CodeRabbit, PR 97); hover/focus only raises emphasis.
                className="absolute -right-1.5 -top-1.5 rounded-full bg-[#0B0B14] p-0.5 text-[#3E4A5F] hover:text-[#FCA5A5] focus-visible:text-[#FCA5A5] group-hover:text-[#64748B] disabled:opacity-50"
              >
                <Trash2 size={10} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice ? (
        <p role="status" className="mt-1.5 text-[11px] text-[#FBBF24]">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
