import { useState, useRef, useCallback, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 2400; // 150ms at 16kHz — smaller chunks = lower latency
const MAX_IN_FLIGHT = 3;   // Pipeline cap — prevents unbounded latency if API is slow
const OUTPUT_RATE = 44100;  // ElevenLabs output format

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

function int16ArrayToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function base64ToInt16Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
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
  const outputGainRef = useRef(null);    // Speaker output gain (mute control)
  const recordingDestRef = useRef(null);  // MediaStream destination (for recording — always full volume)
  const silencerRef = useRef(null);

  const bufRef = useRef([]);
  const accRef = useRef(0);
  const activeRef = useRef(false);
  const playTimeRef = useRef(0);
  const queueTimerRef = useRef(null);
  const inFlightRef = useRef(0);
  const seqRef = useRef(0);
  const nextPlaySeqRef = useRef(0);
  const decodedMapRef = useRef({});
  const mutedRef = useRef(false);
  const consecutiveFailuresRef = useRef(0);

  // Expose the audio output MediaStream for recording
  const getAudioStream = useCallback(() => {
    return recordingDestRef.current?.stream || null;
  }, []);

  const processPlaybackQueue = useCallback(() => {
    const ctx = ctxRef.current;
    const gain = outputGainRef.current;
    const recDest = recordingDestRef.current;
    if (!ctx || !gain || !recDest || !activeRef.current) return;

    while (decodedMapRef.current[nextPlaySeqRef.current] !== undefined) {
      const audioBuffer = decodedMapRef.current[nextPlaySeqRef.current];
      delete decodedMapRef.current[nextPlaySeqRef.current];
      nextPlaySeqRef.current++;

      if (audioBuffer) {
        const src = ctx.createBufferSource();
        src.buffer = audioBuffer;
        // Connect to both speakers (muteable) and recording (always full volume)
        src.connect(gain);
        src.connect(recDest);
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
      // Convert PCM Int16 to base64 — sent directly to backend, NO storage upload
      const audioBase64 = int16ArrayToBase64(pcm16);

      // Call ElevenLabs STS via backend (audio sent inline in POST body)
      const res = await base44.functions.invoke('processVoice', {
        voiceId: voiceIdRef.current,
        audioBase64,
      });

      if (res.data?.audioBase64) {
        consecutiveFailuresRef.current = 0;
        setVoiceError(null);
        const ctx = ctxRef.current;
        if (!ctx || !activeRef.current) return;

        // Decode MP3 → AudioBuffer via Web Audio API's built-in decoder
        const binary = atob(res.data.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        try {
          const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
          decodedMapRef.current[seq] = audioBuffer;
        } catch (_e) {
          decodedMapRef.current[seq] = null;
        }
      } else {
        decodedMapRef.current[seq] = null;
        consecutiveFailuresRef.current++;
        if (consecutiveFailuresRef.current === 3) {
          setVoiceError(res.data?.error || 'Voice conversion failed — no audio returned from the service.');
        }
      }
    } catch (err) {
      decodedMapRef.current[seq] = null;
      consecutiveFailuresRef.current++;
      if (consecutiveFailuresRef.current === 3) {
        const apiError = err.response?.data?.error || err.message || 'Voice conversion connection failed.';
        setVoiceError(apiError);
      }
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
    seqRef.current = 0;
    nextPlaySeqRef.current = 0;
    decodedMapRef.current = {};
    playTimeRef.current = 0;
    bufRef.current = [];
    accRef.current = 0;
    inFlightRef.current = 0;
    consecutiveFailuresRef.current = 0;

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

      const ctx = new AudioContext({ latencyHint: 'interactive' });
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (_e) {}
      }
      // If still suspended (user gesture expired during Decart connect delay),
      // resume on the next click/touch anywhere on the page
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
      // outputGain controls SPEAKER output only (mute toggle).
      // recordingDest captures audio at FULL VOLUME always (so recording
      // has audio even when the user mutes speakers to prevent echo).
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
        // Zero processing, zero API calls, zero latency.
        // Natural voice passes straight through.
        source.connect(outputGain);
        source.connect(recordingDest);
        setVoiceState('active');
      } else {
        // ── Converted Voice ──
        // mic → ScriptProcessor → silencer (no speaker passthrough, prevents feedback)
        // converted PCM → outputGain (speakers, muteable) + recordingDest (recording)
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

          // Pipelined: send immediately when chunk is ready, don't wait for response
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
              // API can't keep up — drop chunk to prevent unbounded latency
              bufRef.current = [];
              accRef.current = 0;
            }
          }
        };

        source.connect(processor);
        processor.connect(silencer);
        silencer.connect(ctx.destination);

        // Process playback queue frequently for low-latency playback
        queueTimerRef.current = setInterval(() => {
          processPlaybackQueue();
        }, 50);

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