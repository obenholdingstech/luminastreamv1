import { useState, useRef, useCallback, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

const TARGET_INPUT_RATE = 16000;
const CHUNK_SAMPLES = 4800; // ~300ms at 16kHz — balance of latency and quality

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
  const activeRef = useRef(false);
  const outputRateRef = useRef(44100);
  const queueTimerRef = useRef(null);

  // Pipelined sending + ordered playback
  const seqRef = useRef(0);           // next sequence number to assign
  const nextPlaySeqRef = useRef(0);   // next sequence number to play
  const responseMapRef = useRef({});  // seq → Float32Array | null
  const playTimeRef = useRef(0);      // next scheduled playback time
  const staleCheckRef = useRef({});   // seq → timestamp when gap first detected

  const playBuffer = useCallback((float32) => {
    const ctx = ctxRef.current;
    if (!ctx || !activeRef.current || !float32) return;

    const buffer = ctx.createBuffer(1, float32.length, outputRateRef.current);
    buffer.copyToChannel(float32, 0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    // Schedule seamlessly after previous chunk — no gaps
    const now = ctx.currentTime;
    if (playTimeRef.current < now) playTimeRef.current = now + 0.02;
    src.start(playTimeRef.current);
    playTimeRef.current += buffer.duration;
  }, []);

  // Play all consecutive responses from the queue; skip stale gaps after 1.5s
  const processQueue = useCallback(() => {
    const map = responseMapRef.current;
    const stale = staleCheckRef.current;
    const now = Date.now();

    let advanced = true;
    while (advanced) {
      advanced = false;
      const seq = nextPlaySeqRef.current;

      if (map[seq] !== undefined) {
        const float32 = map[seq];
        delete map[seq];
        delete stale[seq];
        nextPlaySeqRef.current++;
        if (float32) playBuffer(float32);
        advanced = true;
      } else if (seq < seqRef.current) {
        // Sent but not yet received — track staleness
        if (!stale[seq]) {
          stale[seq] = now;
        } else if (now - stale[seq] > 1500) {
          // Skip missing chunk to unblock the queue
          delete stale[seq];
          nextPlaySeqRef.current++;
          advanced = true;
        }
      }
    }
  }, [playBuffer]);

  // Fire-and-forget: sends chunk without blocking the next capture cycle
  const sendChunk = useCallback(async (pcm16, seq) => {
    try {
      const audioBase64 = int16ToBase64(pcm16);
      const res = await base44.functions.invoke('processVoice', {
        voiceId: voiceIdRef.current,
        audioBase64,
        outputFormat: `pcm_${outputRateRef.current}`,
      });
      if (res.data?.audioBase64) {
        responseMapRef.current[seq] = base64ToFloat32(res.data.audioBase64);
      } else {
        responseMapRef.current[seq] = null;
      }
    } catch (_err) {
      responseMapRef.current[seq] = null;
    }
    processQueue();
  }, [processQueue]);

  const startVoiceStream = useCallback(async ({ voiceId }) => {
    if (activeRef.current) return;
    activeRef.current = true;
    voiceIdRef.current = voiceId;
    setVoiceError(null);

    // Reset all pipeline state
    seqRef.current = 0;
    nextPlaySeqRef.current = 0;
    responseMapRef.current = {};
    staleCheckRef.current = {};
    playTimeRef.current = 0;
    bufRef.current = [];
    accRef.current = 0;

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
      // Critical: browsers auto-suspend contexts not created in a direct user gesture.
      // Without resume(), onaudioprocess never fires and no audio reaches the speakers.
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      ctxRef.current = ctx;

      // Match ElevenLabs output format to the context's native sample rate
      // to eliminate browser-side resampling and reduce latency.
      const sr = ctx.sampleRate;
      if (sr === 48000) outputRateRef.current = 48000;
      else if (sr === 44100) outputRateRef.current = 44100;
      else if (sr === 32000) outputRateRef.current = 32000;
      else if (sr === 24000) outputRateRef.current = 24000;
      else if (sr === 22050) outputRateRef.current = 22050;
      else outputRateRef.current = 44100;

      const inputRate = ctx.sampleRate;
      const source = ctx.createMediaStreamSource(micStream);
      sourceRef.current = source;

      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      // Zero-gain node silences mic passthrough to prevent speaker feedback.
      // Converted audio is played separately via playBuffer → ctx.destination.
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

        // Pipelined: send immediately when ready — do NOT wait for the response.
        // This keeps capture continuous and prevents the long gaps that caused silence.
        if (accRef.current >= CHUNK_SAMPLES) {
          const combined = combineChunks(bufRef.current);
          bufRef.current = [];
          accRef.current = 0;
          sendChunk(combined, seqRef.current);
          seqRef.current++;
        }
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(ctx.destination);

      // Safety net: process the playback queue periodically so stale chunks
      // get skipped even when no new API responses arrive.
      queueTimerRef.current = setInterval(() => {
        processQueue();
      }, 200);

      setVoiceState('active');
    } catch (err) {
      setVoiceError(err.message || 'Microphone access failed');
      setVoiceState('error');
      activeRef.current = false;
    }
  }, [sendChunk, processQueue]);

  const stopVoiceStream = useCallback(() => {
    activeRef.current = false;
    voiceIdRef.current = null;
    bufRef.current = [];
    accRef.current = 0;
    seqRef.current = 0;
    nextPlaySeqRef.current = 0;
    responseMapRef.current = {};
    staleCheckRef.current = {};
    playTimeRef.current = 0;

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