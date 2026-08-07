// The per-user voice library (P4c-3). Signed-in users manage the clones
// attached to THEIR account — the server scopes every call by the session,
// so this component holds no user id and no vendor knowledge.
//
// The DECISIONS live in src/lib/voiceLibrary.js (pure, tested — CodeRabbit,
// PR 95); this component keeps only React state, the FileReader, and the
// mapping from {notice, changed} to the status line and the reload +
// refresh_voices pair. A failed LIST is its own rendered state with a retry
// — never an eternal "loading…".

import { Loader2, Mic2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { afterClone, afterDelete, cloneLabel, sampleRefusal } from '@/lib/voiceLibrary';
import { cloneMyVoice, deleteMyVoice, listMyVoices } from '@/lib/voiceLibraryClient';

export default function VoiceLibrary({ onLibraryChanged }) {
  // phase: 'loading' | 'error' | 'ready'
  const [list, setList] = useState({ phase: 'loading', items: [] });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const fileRef = useRef(null);
  // Reloads are sequenced: only the NEWEST request may set state, so a slow
  // older response can never overwrite a fresher list (CodeRabbit, PR 95).
  const reloadSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    const items = await listMyVoices();
    if (seq !== reloadSeq.current) return; // a newer reload owns the state now
    setList(items === null ? { phase: 'error', items: [] } : { phase: 'ready', items });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const applyOutcome = async ({ notice: line, changed }) => {
    setNotice(line);
    if (changed) {
      await reload();
      onLibraryChanged?.();
    }
  };

  const onPick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // same file twice must still fire change
    if (!file) return;
    const refused = sampleRefusal(file);
    if (refused) {
      setNotice(refused);
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const sampleData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const res = await cloneMyVoice({
        name: cloneLabel(file.name),
        sampleData,
        mimeType: file.type || undefined,
      });
      await applyOutcome(afterClone(res));
    } catch {
      setNotice('could not read that file — try another');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id) => {
    setBusy(true);
    setNotice('');
    await applyOutcome(afterDelete(await deleteMyVoice(id)));
    setBusy(false);
  };

  return (
    <div className="mt-3 rounded-lg border border-[#1E1E2E] bg-[#0B0B14] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] tracking-[0.18em] uppercase text-[#94A3B8]">
          <Mic2 size={11} aria-hidden /> my voices
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 rounded-full border border-[#475569] px-3 py-1 text-[10px] tracking-[0.12em] uppercase text-[#E2E8F0] hover:border-[#A5B4FC] transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 size={10} className="animate-spin" aria-hidden /> : <Upload size={10} aria-hidden />}
          clone from sample
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={onPick}
          aria-label="upload a voice sample"
        />
      </div>

      {list.phase === 'loading' ? (
        <p className="mt-2 text-[11px] text-[#64748B]">loading…</p>
      ) : list.phase === 'error' ? (
        <p className="mt-2 flex items-center gap-2 text-[11px] text-[#FBBF24]">
          could not load your voices
          <button
            type="button"
            onClick={reload}
            className="flex items-center gap-1 text-[#A5B4FC] hover:text-[#E2E8F0] transition-colors"
          >
            <RefreshCw size={10} aria-hidden /> retry
          </button>
        </p>
      ) : list.items.length === 0 ? (
        <p className="mt-2 text-[11px] text-[#64748B]">
          no cloned voices yet — upload a minute of clean speech to create one
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {list.items.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-2 text-[12px] text-[#E2E8F0]">
              <span className="truncate">{v.label}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDelete(v.id)}
                title={`delete ${v.label}`}
                className="text-[#64748B] hover:text-[#FCA5A5] transition-colors disabled:opacity-50"
              >
                <Trash2 size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {notice ? (
        <p role="status" className="mt-2 text-[11px] text-[#FBBF24]">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
