import { useState, useRef, useCallback, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

const TARGET_INPUT_RATE = 16000;
const OUTPUT_RATE = 44100;
const CHUNK_SAMPLES = 8000; // ~500ms at 16kHz

// ── Encoding helpers ────────────────────────────────────────────
function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function base64ToFloat32(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const count = Math.floor(bytes.length / 2);
  const int16 = new Int16Array(bytes.buffer, 0, count);
  const float32 = new Float32Array(count);
  for (let i = 0; i < count; i++) float32[i] = int16[i] / 0x8000;
  return float32;
}

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
  const bufRef = useRef([]);
  const accRef = useRef(0);
  const sendingRef = useRef(false);
  const playTimeRef = useRef(0);
  const activeRef = useRef(false);

  const playAudio = useCallback((float32) => {
    const ctx = ctxRef.current;
    if (!ctx || !activeRef.current) return;

    const buffer = ctx.createBuffer(1, float32.length, OUTPUT_RATE);
    buffer.copyToChannel(float32, 0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    if (playTimeRef.current < now) playTimeRef.current = now + 0.05;
    src.start(playTimeRef.current);
    playTimeRef.current += buffer.duration;
  }, []);

  const sendChunk = useCallback(async (pcm16) => {
    sendingRef.current = true;
    try {
      const audioBase64 = int16ToBase64(pcm16);
      const res = await base44.functions.invoke('processVoice', {
        voiceId: voiceIdRef.current,
        audioBase64,
      });
      if (res.data?.audioBase64) {
        playAudio(base64ToFloat32(res.data.audioBase64));
      }
    } catch (_err) {
      // Skip failed chunk — stream continues
    }
    sendingRef.current = false;
  }, [playAudio]);

  const startVoiceStream = useCallback(async ({ voiceId }) => {
    if (activeRef.current) return;
    activeRef.current = true;
    voiceIdRef.current = voiceId;
    setVoiceError(null);

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
      ctxRef.current = ctx;
      const inputRate = ctx.sampleRate;

      const source = ctx.createMediaStreamSource(micStream);
      sourceRef.current = source;

      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      // Zero-gain node keeps processor alive without echoing mic to speakers
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

        if (accRef.current >= CHUNK_SAMPLES && !sendingRef.current) {
          const combined = combineChunks(bufRef.current);
          bufRef.current = [];
          accRef.current = 0;
          sendChunk(combined);
        }
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(ctx.destination);

      setVoiceState('active');
    } catch (err) {
      setVoiceError(err.message || 'Microphone access failed');
      setVoiceState('error');
      activeRef.current = false;
    }
  }, [sendChunk]);

  const stopVoiceStream = useCallback(() => {
    activeRef.current = false;
    voiceIdRef.current = null;
    bufRef.current = [];
    accRef.current = 0;
    sendingRef.current = false;
    playTimeRef.current = 0;

    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (sourceRef.current) { sourceRef.current.disconnect(); sourceRef.current = null; }
    if (gainRef.current) { gainRef.current.disconnect(); gainRef.current = null; }
    if (micRef.current) { micRef.current.getTracks().forEach(t => t.stop()); micRef.current = null; }
    if (ctxRef.current) { ctxRef.current.close().catch(() => {}); ctxRef.current = null; }

    setVoiceState('idle');
  }, []);

  useEffect(() => {
    return () => stopVoiceStream();
  }, [stopVoiceStream]);

  return { voiceState, voiceError, startVoiceStream, stopVoiceStream };
}