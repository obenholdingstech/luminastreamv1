import { useState, useRef, useCallback, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1920; // 120ms at 16kHz — low latency, safely above API 100ms minimum
const MAX_IN_FLIGHT = 5;   // Deeper pipeline — absorbs API jitter without audio gaps
const OUTPUT_RATE = 44100;  // ElevenLabs PCM output format
const PCM_PLAYBACK_CHUNK_BYTES = OUTPUT_RATE * 2 * 0.05; // 50ms of 16-bit mono = 4410 bytes

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

// Convert raw PCM bytes (44100Hz, 16-bit, little-endian) → AudioBuffer
function pcmBytesToAudioBuffer(ctx, bytes) {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount);
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = int16[i] / 0x8000;
  }
  const audioBuffer = ctx.createBuffer(1, sampleCount, OUTPUT_RATE);
  audioBuffer.copyToChannel(float32, 0);
  return audioBuffer;
}

// ── Hook ────────────────────────────────────────────────────────
export function useVoiceStream() {
  const [voiceState, setVoiceState] = useState('idle');
  const [voiceError, setVoiceError] = useState(null);

  const ctxRef = useRef(null);
  const sourceRef = useRef(null);
  const processorRef = useRef(null);
  const micRef = useRef(null);
  const voiceIdRef = useRef(null);
  const modeRef = useRef('direct');
  const outputGainRef = useRef(null);
  const recordingDestRef = useRef(null);
  const silencerRef = useRef(null);

  const bufRef = useRef([]);
  const accRef = useRef(0);
  const activeRef = useRef(false);
  const playTimeRef = useRef(0);
  const queueTimerRef = useRef(null);
  const inFlightRef = useRef(0);
  const mutedRef = useRef(false);
  const consecutiveFailuresRef = useRef(0);

  // Direct-to-ElevenLabs streaming state
  const apiKeyRef = useRef(null);
  const streamQueuesRef = useRef({});       // { streamSeq: { buffers: [], complete: false } }
  const nextStreamToPlayRef = useRef(0);     // Next stream sequence to play
  const currentStreamSeqRef = useRef(0);     // Sequence counter for sendChunk calls

  const getAudioStream = useCallback(() => {
    return recordingDestRef.current?.stream || null;
  }, []);

  // Fetch ElevenLabs API key — same pattern as video pipeline's createSession
  const ensureApiKey = useCallback(async () => {
    if (apiKeyRef.current) return apiKeyRef.current;
    const res = await base44.functions.invoke('getVoiceApiKey', {});
    apiKeyRef.current = res.data?.apiKey;
    return apiKeyRef.current;
  }, []);

  const processPlaybackQueue = useCallback(() => {
    const ctx = ctxRef.current;
    const gain = outputGainRef.current;
    const recDest = recordingDestRef.current;
    if (!ctx || !gain || !recDest || !activeRef.current) return;

    // Play streams in input order — each stream may contain multiple AudioBuffers
    while (streamQueuesRef.current[nextStreamToPlayRef.current]) {
      const stream = streamQueuesRef.current[nextStreamToPlayRef.current];

      if (stream.buffers.length > 0) {
        const audioBuffer = stream.buffers.shift();
        const src = ctx.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(gain);
        src.connect(recDest);
        const now = ctx.currentTime;
        // First chunk: 150ms jitter buffer. Late chunks: 30ms re-buffer.
        if (playTimeRef.current < now) {
          playTimeRef.current = now + (playTimeRef.current === 0 ? 0.15 : 0.03);
        }
        src.start(playTimeRef.current);
        playTimeRef.current += audioBuffer.duration;
      } else if (stream.complete) {
        // Stream finished — advance to next stream
        delete streamQueuesRef.current[nextStreamToPlayRef.current];
        nextStreamToPlayRef.current++;
      } else {
        // Stream still in flight — wait for more buffers
        break;
      }
    }
  }, []);

  const sendChunk = useCallback(async (pcm16) => {
    const streamSeq = currentStreamSeqRef.current++;
    streamQueuesRef.current[streamSeq] = { buffers: [], complete: false };

    // Safe accessor — queue may be wiped by stopVoiceStream while this chunk is in flight
    const markComplete = () => {
      const s = streamQueuesRef.current[streamSeq];
      if (s) s.complete = true;
    };
    const pushBuffer = (buf) => {
      const s = streamQueuesRef.current[streamSeq];
      if (s) s.buffers.push(buf);
    };

    try {
      const apiKey = apiKeyRef.current;
      if (!apiKey || !voiceIdRef.current) {
        markComplete();
        return;
      }

      // Build multipart form with raw PCM — sent DIRECTLY to ElevenLabs, NO intermediary
      const audioBlob = new Blob([pcm16], { type: 'application/octet-stream' });
      const formData = new FormData();
      formData.append('audio', audioBlob, 'input.pcm');
      formData.append('model_id', 'eleven_english_sts_v2');
      formData.append('file_format', 'pcm_s16le_16');
      formData.append('remove_background_noise', 'false');

      // DIRECT call to ElevenLabs STS streaming endpoint — bypasses Base44 entirely
      const response = await fetch(
        `https://api.us.elevenlabs.io/v1/speech-to-speech/${voiceIdRef.current}/stream?output_format=pcm_44100&optimize_streaming_latency=4`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey },
          body: formData,
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        consecutiveFailuresRef.current++;
        if (consecutiveFailuresRef.current === 3) {
          setVoiceError(errorData.detail?.message || errorData.detail || 'Voice conversion failed.');
        }
        markComplete();
        processPlaybackQueue();
        return;
      }

      // Success — read streaming PCM and play audio as it arrives
      consecutiveFailuresRef.current = 0;
      setVoiceError(null);
      const ctx = ctxRef.current;
      if (!ctx || !activeRef.current) {
        markComplete();
        return;
      }

      const reader = response.body.getReader();
      let pendingBytes = new Uint8Array(0);

      while (true) {
        const { done, value } = await reader.read();
        if (done || !activeRef.current) break;

        // Accumulate incoming PCM bytes
        const combined = new Uint8Array(pendingBytes.length + value.length);
        combined.set(pendingBytes, 0);
        combined.set(value, pendingBytes.length);
        pendingBytes = combined;

        // Extract 50ms playback chunks — enables immediate playback as bytes arrive
        while (pendingBytes.length >= PCM_PLAYBACK_CHUNK_BYTES) {
          const chunkBytes = pendingBytes.slice(0, PCM_PLAYBACK_CHUNK_BYTES);
          pendingBytes = pendingBytes.slice(PCM_PLAYBACK_CHUNK_BYTES);
          const audioBuffer = pcmBytesToAudioBuffer(ctx, chunkBytes);
          pushBuffer(audioBuffer);
        }

        processPlaybackQueue();
      }

      // Process any remaining bytes (< 50ms)
      if (pendingBytes.length >= 2 && activeRef.current) {
        const evenLength = pendingBytes.length - (pendingBytes.length % 2);
        if (evenLength > 0) {
          const chunkBytes = pendingBytes.slice(0, evenLength);
          const audioBuffer = pcmBytesToAudioBuffer(ctx, chunkBytes);
          pushBuffer(audioBuffer);
        }
      }

      markComplete();
    } catch (err) {
      consecutiveFailuresRef.current++;
      if (consecutiveFailuresRef.current === 3) {
        setVoiceError(err.message || 'Voice conversion connection failed.');
      }
      markComplete();
    }
    processPlaybackQueue();
  }, [processPlaybackQueue]);

  const startVoiceStream = useCallback(async ({ voiceId, mode, muted }) => {
    if (activeRef.current) return;
    activeRef.current = true;
    modeRef.current = mode;
    voiceIdRef.current = voiceId;
    mutedRef.current = muted || false;
    setVoiceError(null);

    // Reset pipeline state
    streamQueuesRef.current = {};
    nextStreamToPlayRef.current = 0;
    currentStreamSeqRef.current = 0;
    playTimeRef.current = 0;
    bufRef.current = [];
    accRef.current = 0;
    inFlightRef.current = 0;
    consecutiveFailuresRef.current = 0;

    try {
      // For converted voice: fetch API key for direct ElevenLabs connection
      if (mode === 'converted') {
        await ensureApiKey();
        if (!apiKeyRef.current) {
          throw new Error('Unable to retrieve voice service credentials.');
        }
      }

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

      const ctx = new AudioContext({ latencyHint: 'interactive' });
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (_e) {}
      }
      if (ctx.state === 'suspended') {
        const resumeOnClick = () => {
          ctx.resume().catch(() => {});
          document.removeEventListener('click', resumeOnClick);
          document.removeEventListener('touchstart', resumeOnClick);
        };
        document.addEventListener('click', resumeOnClick);
        document.addEventListener('touchstart', resumeOnClick);
      }
      ctxRef.current = ctx;

      // ── Master output chain ──
      const outputGain = ctx.createGain();
      outputGain.gain.value = mutedRef.current ? 0 : 1;
      outputGain.connect(ctx.destination);
      outputGainRef.current = outputGain;

      const recordingDest = ctx.createMediaStreamDestination();
      recordingDestRef.current = recordingDest;

      const source = ctx.createMediaStreamSource(micStream);
      sourceRef.current = source;

      if (mode === 'direct') {
        // ── Direct Voice: mic → speakers + recording ──
        source.connect(outputGain);
        source.connect(recordingDest);
        setVoiceState('active');
      } else {
        // ── Converted Voice ──
        // mic → ScriptProcessor → silencer (prevents feedback)
        // converted PCM streamed directly from ElevenLabs → outputGain + recordingDest
        const inputRate = ctx.sampleRate;
        const processor = ctx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        const silencer = ctx.createGain();
        silencer.gain.value = 0;
        silencerRef.current = silencer;

        processor.onaudioprocess = (e) => {
          if (!activeRef.current || !voiceIdRef.current) return;
          const input = e.inputBuffer.getChannelData(0);
          const resampled = resample(input, inputRate, TARGET_RATE);
          const pcm16 = float32ToInt16(resampled);
          bufRef.current.push(pcm16);
          accRef.current += pcm16.length;

          if (accRef.current >= CHUNK_SAMPLES) {
            if (inFlightRef.current < MAX_IN_FLIGHT) {
              const totalLen = bufRef.current.reduce((s, c) => s + c.length, 0);
              const combined = new Int16Array(totalLen);
              let off = 0;
              for (const c of bufRef.current) { combined.set(c, off); off += c.length; }
              bufRef.current = [];
              accRef.current = 0;
              inFlightRef.current++;
              sendChunk(combined).finally(() => { inFlightRef.current--; });
            } else {
              bufRef.current = [];
              accRef.current = 0;
            }
          }
        };

        source.connect(processor);
        processor.connect(silencer);
        silencer.connect(ctx.destination);

        // Process playback queue at 20ms for smooth, gap-free scheduling
        queueTimerRef.current = setInterval(() => {
          processPlaybackQueue();
        }, 20);

        setVoiceState('active');
      }
    } catch (err) {
      setVoiceError(err.message || 'Microphone access failed');
      setVoiceState('error');
      activeRef.current = false;
    }
  }, [sendChunk, processPlaybackQueue, ensureApiKey]);

  const stopVoiceStream = useCallback(() => {
    activeRef.current = false;
    voiceIdRef.current = null;
    bufRef.current = [];
    accRef.current = 0;
    streamQueuesRef.current = {};
    nextStreamToPlayRef.current = 0;
    currentStreamSeqRef.current = 0;
    playTimeRef.current = 0;
    inFlightRef.current = 0;
    consecutiveFailuresRef.current = 0;

    if (queueTimerRef.current) {
      clearInterval(queueTimerRef.current);
      queueTimerRef.current = null;
    }
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (silencerRef.current) { silencerRef.current.disconnect(); silencerRef.current = null; }
    if (sourceRef.current) { sourceRef.current.disconnect(); sourceRef.current = null; }
    if (outputGainRef.current) { outputGainRef.current.disconnect(); outputGainRef.current = null; }
    if (recordingDestRef.current) { recordingDestRef.current.disconnect(); recordingDestRef.current = null; }
    if (micRef.current) { micRef.current.getTracks().forEach((t) => t.stop()); micRef.current = null; }
    if (ctxRef.current) { ctxRef.current.close().catch(() => {}); ctxRef.current = null; }

    setVoiceState('idle');
  }, []);

  const setMuted = useCallback((muted) => {
    mutedRef.current = muted;
    if (outputGainRef.current && ctxRef.current) {
      outputGainRef.current.gain.setValueAtTime(muted ? 0 : 1, ctxRef.current.currentTime);
    }
  }, []);

  useEffect(() => {
    return () => stopVoiceStream();
  }, [stopVoiceStream]);

  return {
    voiceState,
    voiceError,
    startVoiceStream,
    stopVoiceStream,
    setMuted,
    getAudioStream,
  };
}