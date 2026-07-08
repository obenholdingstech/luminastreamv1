import { useState, useRef, useCallback, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

const TARGET_INPUT_RATE = 16000;
const CHUNK_SAMPLES = 4800; // ~300ms at 16kHz
const MAX_IN_FLIGHT = 3;   // Prevent pile-up if API is slow

// ── Audio helpers ───────────────────────────────────────────────
function resample(input, inputRate, targetRate) {
  if (inputRate === targetRate) return input;
  const ratio = inputRate / targetRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const idx = i * ratio;
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = idx - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

function float32ToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function combineChunks(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function pcmToWavBlob(pcm16, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcm16.byteLength;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, headerSize).set(
    new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
  );

  return new Blob([buffer], { type: 'audio/wav' });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Hook ────────────────────────────────────────────────────────
export function useVoiceStream() {
  const [voiceState, setVoiceState] = useState('idle');
  const [voiceError, setVoiceError] = useState(null);

  const ctxRef = useRef(null);
  const sourceRef = useRef(null);
  const processorRef = useRef(null);
  const gainRef = useRef(null);
  const micRef = useRef(null);
  const voiceIdRef = useRef(null);
  const modeRef = useRef('direct');
  const bufRef = useRef([]);
  const accRef = useRef(0);
  const activeRef = useRef(false);
  const playTimeRef = useRef(0);
  const queueTimerRef = useRef(null);
  const inFlightRef = useRef(0);

  // Pipelined sending + ordered playback (converted mode only)
  const seqRef = useRef(0);
  const nextPlaySeqRef = useRef(0);
  const decodedMapRef = useRef({});

  const processPlaybackQueue = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || !activeRef.current) return;

    while (decodedMapRef.current[nextPlaySeqRef.current] !== undefined) {
      const audioBuffer = decodedMapRef.current[nextPlaySeqRef.current];
      delete decodedMapRef.current[nextPlaySeqRef.current];
      nextPlaySeqRef.current++;

      if (audioBuffer) {
        const src = ctx.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(ctx.destination);

        const now = ctx.currentTime;
        if (playTimeRef.current < now) playTimeRef.current = now + 0.02;
        src.start(playTimeRef.current);
        playTimeRef.current += audioBuffer.duration;
      }
    }
  }, []);

  const sendChunk = useCallback(async (pcm16) => {
    const seq = seqRef.current++;
    try {
      // 1. Convert PCM to WAV blob
      const wavBlob = pcmToWavBlob(pcm16, TARGET_INPUT_RATE);

      // 2. Upload WAV to storage (most direct route to a URL Resemble can fetch)
      const uploadRes = await base44.integrations.Core.UploadFile({ file: wavBlob });
      if (!uploadRes?.file_url) throw new Error('Upload failed');

      // 3. Call Resemble STS via backend (keeps API key server-side)
      const res = await base44.functions.invoke('convertVoice', {
        voiceUuid: voiceIdRef.current,
        audioUrl: uploadRes.file_url,
        sampleRate: TARGET_INPUT_RATE,
      });

      if (res.data?.audioBase64) {
        const ctx = ctxRef.current;
        if (!ctx || !activeRef.current) return;

        // 4. Decode WAV to AudioBuffer (browser handles resampling)
        const bytes = base64ToBytes(res.data.audioBase64);
        const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
        decodedMapRef.current[seq] = audioBuffer;
      } else {
        decodedMapRef.current[seq] = null;
      }
    } catch (_err) {
      decodedMapRef.current[seq] = null;
    }
    processPlaybackQueue();
  }, [processPlaybackQueue]);

  const startVoiceStream = useCallback(async ({ voiceId, mode }) => {
    if (activeRef.current) return;
    activeRef.current = true;
    modeRef.current = mode;
    voiceIdRef.current = voiceId;
    setVoiceError(null);

    // Reset pipeline state
    seqRef.current = 0;
    nextPlaySeqRef.current = 0;
    decodedMapRef.current = {};
    playTimeRef.current = 0;
    bufRef.current = [];
    accRef.current = 0;
    inFlightRef.current = 0;

    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      micRef.current = micStream;

      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      ctxRef.current = ctx;

      const source = ctx.createMediaStreamSource(micStream);
      sourceRef.current = source;

      if (mode === 'direct') {
        // ── Direct Voice: mic to speakers, zero processing ──
        // No ScriptProcessor, no API calls, no conversion.
        // The natural voice goes straight to the output.
        source.connect(ctx.destination);
        setVoiceState('active');
      } else {
        // ── Converted Voice: mic to WAV to upload to Resemble STS to speakers ──
        const inputRate = ctx.sampleRate;
        const processor = ctx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        // Zero-gain node silences mic passthrough (prevents feedback).
        // Converted audio is played separately via the playback queue.
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gainRef.current = gain;

        processor.onaudioprocess = (e) => {
          if (!activeRef.current || !voiceIdRef.current) return;
          const input = e.inputBuffer.getChannelData(0);
          const resampled = resample(input, inputRate, TARGET_INPUT_RATE);
          const pcm16 = float32ToInt16(resampled);
          bufRef.current.push(pcm16);
          accRef.current += pcm16.length;

          // Pipelined: send immediately when ready, do not wait for response
          if (accRef.current >= CHUNK_SAMPLES) {
            if (inFlightRef.current < MAX_IN_FLIGHT) {
              const combined = combineChunks(bufRef.current);
              bufRef.current = [];
              accRef.current = 0;
              inFlightRef.current++;
              sendChunk(combined).finally(() => { inFlightRef.current--; });
            } else {
              // API cannot keep up — drop this chunk to prevent unbounded latency
              bufRef.current = [];
              accRef.current = 0;
            }
          }
        };

        source.connect(processor);
        processor.connect(gain);
        gain.connect(ctx.destination);

        // Safety net: process the playback queue periodically
        queueTimerRef.current = setInterval(() => {
          processPlaybackQueue();
        }, 100);

        setVoiceState('active');
      }
    } catch (err) {
      setVoiceError(err.message || 'Microphone access failed');
      setVoiceState('error');
      activeRef.current = false;
    }
  }, [sendChunk, processPlaybackQueue]);

  const stopVoiceStream = useCallback(() => {
    activeRef.current = false;
    voiceIdRef.current = null;
    bufRef.current = [];
    accRef.current = 0;
    seqRef.current = 0;
    nextPlaySeqRef.current = 0;
    decodedMapRef.current = {};
    playTimeRef.current = 0;
    inFlightRef.current = 0;

    if (queueTimerRef.current) {
      clearInterval(queueTimerRef.current);
      queueTimerRef.current = null;
    }
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (sourceRef.current) { sourceRef.current.disconnect(); sourceRef.current = null; }
    if (gainRef.current) { gainRef.current.disconnect(); gainRef.current = null; }
    if (micRef.current) { micRef.current.getTracks().forEach((t) => t.stop()); micRef.current = null; }
    if (ctxRef.current) { ctxRef.current.close().catch(() => {}); ctxRef.current = null; }

    setVoiceState('idle');
  }, []);

  useEffect(() => {
    return () => stopVoiceStream();
  }, [stopVoiceStream]);

  return { voiceState, voiceError, startVoiceStream, stopVoiceStream };
}