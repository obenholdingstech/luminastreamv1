// The per-user voice library (P4c-3). Signed-in users manage the clones
// attached to THEIR account — the server scopes every call by the session,
// so this component holds no user id and no vendor knowledge; it uploads a
// sample, lists what it owns, and deletes what it owns.
//
// Honesty rule inherited from the whole console: refusals are shown in the
// server's own terms. Until the CEO places the vendor key, cloning answers
// "not switched on yet" — the wall says it is a wall, not an outage.

import { Loader2, Mic2, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cloneMyVoice, deleteMyVoice, listMyVoices } from '@/lib/voiceLibraryClient';

const MAX_SAMPLE_BYTES = 10 * 1024 * 1024; // matches the server's decoded wall

export default function VoiceLibrary({ onLibraryChanged }) {
  const [voices, setVoices] = useState(null); // null = not yet loaded
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const fileRef = useRef(null);

  const reload = useCallback(async () => {
    setVoices(await listMyVoices());
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const onPick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // same file twice must still fire change
    if (!file) return;
    if (file.size > MAX_SAMPLE_BYTES) {
      setNotice('that file is over 10MB — a minute of clean speech is plenty');
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
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'My voice';
      const res = await cloneMyVoice({ name, sampleData, mimeType: file.type || undefined });
      if (res.ok) {
        setNotice('voice cloned — it appears in the selector shortly');
        await reload();
        onLibraryChanged?.();
      } else {
        setNotice(res.message ?? '');
      }
    } catch {
      setNotice('could not read that file — try another');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id) => {
    setBusy(true);
    setNotice('');
    const res = await deleteMyVoice(id);
    if (!res.ok) setNotice(res.message ?? '');
    await reload();
    onLibraryChanged?.();
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

      {voices === null ? (
        <p className="mt-2 text-[11px] text-[#64748B]">loading…</p>
      ) : voices.length === 0 ? (
        <p className="mt-2 text-[11px] text-[#64748B]">
          no cloned voices yet — upload a minute of clean speech to create one
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {voices.map((v) => (
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
