// The per-user voice library (P4c-3; modal flow 11 Aug 2026 — CEO: "we are
// building a premium product"). Picking a sample no longer fires a raw
// upload named after the file: a modal collects a proper voice name
// (pre-filled from the filename, editable) and a language/accent, the clone
// runs asynchronously with visible progress, and success lands as a toast
// while the new voice appears in the selector. Decisions stay in
// src/lib/voiceLibrary.js; refusals still speak the server's words.

import { Loader2, Mic2, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { afterDelete, cloneLabel, sampleRefusal } from '@/lib/voiceLibrary';
import { runCloneFlow } from '@/lib/cloneFlow';
import { cloneMyVoice, deleteMyVoice, listMyVoices } from '@/lib/voiceLibraryClient';
import { AUDIO_OR_VIDEO_ACCEPT, browserDecode, extractSample } from '@/lib/audioExtract';

// Curated, honest list — these are conditioning hints for the vendor, not a
// promise of translation. '' = let the vendor infer.
const LANGUAGES = [
  ['', 'auto-detect'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['pl', 'Polish'],
  ['hi', 'Hindi'],
  ['ar', 'Arabic'],
  ['zh', 'Chinese'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
];

export default function VoiceLibrary({ onLibraryChanged }) {
  // phase: 'loading' | 'error' | 'ready'
  const [list, setList] = useState({ phase: 'loading', items: [] });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [toast, setToast] = useState('');
  // The modal's world: a picked file plus its editable clone details.
  const [pending, setPending] = useState(null); // { file, name, language } | null
  const [cloning, setCloning] = useState(false);
  const [modalError, setModalError] = useState('');
  const fileRef = useRef(null);
  const reloadSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    const items = await listMyVoices();
    if (seq !== reloadSeq.current) return;
    setList(items === null ? { phase: 'error', items: [] } : { phase: 'ready', items });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Toasts announce and leave — six seconds, then gone.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const onPick = (event) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // same file twice must still fire change
    if (!file) return;
    const refused = sampleRefusal(file);
    if (refused) {
      setNotice(refused);
      return;
    }
    setNotice('');
    setModalError('');
    setPending({ file, name: cloneLabel(file.name), language: '' });
  };

  const onConfirmClone = async () => {
    if (!pending || cloning) return;
    setCloning(true);
    setModalError('');
    // The WORKFLOW lives in src/lib/cloneFlow.js (pure, tested); this
    // component only maps its outcome to modal/toast state.
    const outcome = await runCloneFlow(pending, {
      // EVERY pick — plain audio or a video container — goes through the
      // in-browser extractor: the audio track is decoded, trimmed to what
      // cloning needs, and re-encoded as a compact mono WAV. A 150MB
      // screen recording becomes a ~9MB sample without leaving the page.
      readFile: async (file) => {
        const { sampleData } = await extractSample(file, browserDecode);
        return sampleData;
      },
      clone: cloneMyVoice,
    });
    if (outcome.ok) {
      setPending(null);
      setToast(outcome.toast ?? '');
      await reload();
      onLibraryChanged?.();
    } else {
      setModalError(outcome.error ?? '');
    }
    setCloning(false);
  };

  const onDelete = async (id) => {
    setBusy(true);
    setNotice('');
    const outcome = afterDelete(await deleteMyVoice(id));
    setNotice(outcome.notice);
    if (outcome.changed) {
      await reload();
      onLibraryChanged?.();
    }
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
          disabled={busy || cloning}
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 rounded-full border border-[#475569] px-3 py-1 text-[10px] tracking-[0.12em] uppercase text-[#E2E8F0] hover:border-[#A5B4FC] transition-colors disabled:opacity-50"
        >
          <Upload size={10} aria-hidden />
          clone from sample
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={AUDIO_OR_VIDEO_ACCEPT}
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
          <button type="button" onClick={reload} className="flex items-center gap-1 text-[#A5B4FC] hover:text-[#E2E8F0]">
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
                disabled={busy || cloning}
                onClick={() => onDelete(v.id)}
                title={`delete ${v.label}`}
                className="p-2 -m-2 text-[#64748B] hover:text-[#FCA5A5] transition-colors disabled:opacity-50"
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

      {/* ── the clone modal ─────────────────────────────────────────── */}
      {pending ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
          role="dialog"
          aria-modal="true"
          aria-label="name your cloned voice"
        >
          <div className="w-full max-w-sm rounded-xl border border-[#1E1E2E] bg-[#0B0B14] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] tracking-[0.22em] uppercase text-[#94A3B8]">
                clone a voice
              </h2>
              <button
                type="button"
                disabled={cloning}
                onClick={() => setPending(null)}
                title="cancel"
                className="text-[#64748B] hover:text-[#E2E8F0] disabled:opacity-50"
              >
                <X size={14} aria-hidden />
              </button>
            </div>
            <p className="mt-2 truncate text-[11px] text-[#64748B]">
              sample: {pending.file.name}
              {/^video\//.test(pending.file.type ?? '') ? ' — the audio track will be extracted' : ''}
            </p>

            <label className="mt-4 block text-[10px] tracking-[0.14em] uppercase text-[#64748B]">
              voice name
              <input
                type="text"
                value={pending.name}
                maxLength={60}
                autoFocus
                disabled={cloning}
                onChange={(e) => setPending({ ...pending, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onConfirmClone();
                }}
                className="mt-1 w-full rounded-lg border border-[#1E1E2E] bg-[#08080F] px-3 py-2 text-[13px] normal-case tracking-normal text-[#E2E8F0] outline-none focus:border-[#6366F1]"
              />
            </label>

            <label className="mt-3 block text-[10px] tracking-[0.14em] uppercase text-[#64748B]">
              language / accent
              <select
                value={pending.language}
                disabled={cloning}
                onChange={(e) => setPending({ ...pending, language: e.target.value })}
                className="mt-1 w-full rounded-lg border border-[#1E1E2E] bg-[#08080F] px-3 py-2 text-[13px] normal-case tracking-normal text-[#E2E8F0] outline-none focus:border-[#6366F1]"
              >
                {LANGUAGES.map(([code, name]) => (
                  <option key={code} value={code} className="bg-[#08080F]">
                    {name}
                  </option>
                ))}
              </select>
            </label>

            {modalError ? (
              <p role="alert" className="mt-3 text-[11px] text-[#FCA5A5]">
                {modalError}
              </p>
            ) : null}

            <button
              type="button"
              disabled={cloning}
              onClick={onConfirmClone}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-white px-4 py-2.5 text-[11px] tracking-[0.16em] uppercase text-[#08080F] transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {cloning ? (
                <>
                  <Loader2 size={12} className="animate-spin" aria-hidden /> extracting &amp; cloning…
                </>
              ) : (
                'clone voice'
              )}
            </button>
            {cloning ? (
              <p className="mt-2 text-center text-[10px] text-[#64748B]">
                this takes a few seconds — the sample is being learned
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ── the success toast ───────────────────────────────────────── */}
      {toast ? (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-50 rounded-lg border border-[#14532D] bg-[#052E16] px-4 py-3 text-[12px] text-[#86EFAC] shadow-lg"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
