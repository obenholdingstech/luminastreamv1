import { useState, useRef, useCallback, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { voiceCaptureProcessorCode } from '@/worklets/voiceCaptureProcessorCode';
import { createOvcFrame, connectOvc, buildOvcWsUrl, buildOvcHttpUrl } from '@/lib/ovcClient';

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100ms at 16kHz — ElevenLabs minimum, lowest possible input latency
const MAX_IN_FLIGHT = 5;   // Deeper pipeline — absorbs API jitter without audio gaps
const OUTPUT_RATE = 44100;  // ElevenLabs PCM output format
const PCM_PLAYBACK_CHUNK_BYTES = OUTPUT_RATE * 2 * 0.02; // 20ms of 16-bit mono — faster time-to-first-audio

// RVC / OpenVoiceChanger config — WebSocket-based real-time voice conversion on a GPU server
const OVC_RATE = 44100;   // OVC server sample rate — matches AudioContext for zero-resample playback
const OVC_CHUNK = 2048;    // Tuning (Phase 2A): smaller window (~46ms at 44100Hz) — halves latency floor vs 4096

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

// Convert float32 samples → AudioBuffer (for RVC/OpenVoiceChanger output at 44100Hz)
function float32ToAudioBuffer(ctx, samples) {
  const audioBuffer = ctx.createBuffer(1, samples.length, OVC_RATE);
  audioBuffer.copyToChannel(samples, 0);
  return audioBuffer;
}

// ── Hook ────────────────────────────────────────────────────────
export function useVoiceStream(sessionId) {
  const [voiceState, setVoiceState] = useState('idle');
  const [voiceError, setVoiceError] = useState(null);
  const [voiceMetrics, setVoiceMetrics] = useState(null);

  const ctxRef = useRef(null);
  const sourceRef = useRef(null);
  const processorRef = useRef(null);
  const workletNodeRef = useRef(null);
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

  // RVC / OpenVoiceChanger WebSocket state
  const wsRef = useRef(null);
  const voiceBackendRef = useRef('elevenlabs');  // 'elevenlabs' or 'rvc'
  const rvcServerUrlRef = useRef(null);
  const ovcSendSeqRef = useRef(0);
  const ovcRecvSeqRef = useRef(0);
  const streamQueuesRef = useRef({});       // { streamSeq: { buffers: [], complete: false } }
  const nextStreamToPlayRef = useRef(0);     // Next stream sequence to play
  const currentStreamSeqRef = useRef(0);     // Sequence counter for sendChunk calls

  // Voice metrics — server processing time, round-trip latency, frame counts
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const sendTimestampsRef = useRef({});       // { sendSeq: performance.now() }
  const voiceMetricsRef = useRef({ framesSent: 0, framesReceived: 0, processingSamples: [], rttSamples: [] });
  const metricsTimerRef = useRef(null);
  const metricsReportTickRef = useRef(0);

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

  // Fetch voice backend config — determines whether to use RVC server or ElevenLabs
  const ensureVoiceConfig = useCallback(async () => {
    const res = await base44.functions.invoke('getVoiceConfig', {});
    const { backend, serverUrl } = res.data || {};
    voiceBackendRef.current = backend || 'elevenlabs';
    rvcServerUrlRef.current = serverUrl || null;
    return voiceBackendRef.current;
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
        if (playTimeRef.current < now) {
          playTimeRef.current = now + (playTimeRef.current === 0 ? 0.06 : 0.015);
        }
        src.start(playTimeRef.current);
        playTimeRef.current += audioBuffer.duration;
      } else if (stream.complete) {
        delete streamQueuesRef.current[nextStreamToPlayRef.current];
        nextStreamToPlayRef.current++;
      } else {
        break;
      }
    }
  }, []);

  const sendChunk = useCallback(async (pcm16) => {
    const streamSeq = currentStreamSeqRef.current++;
    streamQueuesRef.current[streamSeq] = { buffers: [], complete: false };

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

      const audioBlob = new Blob([pcm16], { type: 'application/octet-stream' });
      const formData = new FormData();
      formData.append('audio', audioBlob, 'input.pcm');
      formData.append('model_id', 'eleven_english_sts_v2');
      formData.append('file_format', 'pcm_s16le_16');
      formData.append('remove_background_noise', 'false');

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

        const combined = new Uint8Array(pendingBytes.length + value.length);
        combined.set(pendingBytes, 0);
        combined.set(value, pendingBytes.length);
        pendingBytes = combined;

        while (pendingBytes.length >= PCM_PLAYBACK_CHUNK_BYTES) {
          const chunkBytes = pendingBytes.slice(0, PCM_PLAYBACK_CHUNK_BYTES);
          pendingBytes = pendingBytes.slice(PCM_PLAYBACK_CHUNK_BYTES);
          const audioBuffer = pcmBytesToAudioBuffer(ctx, chunkBytes);
          pushBuffer(audioBuffer);
        }

        processPlaybackQueue();
      }

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

    // Reset pipeline + metrics state
    streamQueuesRef.current = {};
    nextStreamToPlayRef.current = 0;
    currentStreamSeqRef.current = 0;
    ovcSendSeqRef.current = 0;
    ovcRecvSeqRef.current = 0;
    playTimeRef.current = 0;
    bufRef.current = [];
    accRef.current = 0;
    inFlightRef.current = 0;
    consecutiveFailuresRef.current = 0;
    sendTimestampsRef.current = {};
    voiceMetricsRef.current = { framesSent: 0, framesReceived: 0, processingSamples: [], rttSamples: [] };
    metricsReportTickRef.current = 0;
    setVoiceMetrics(null);

    try {
      if (mode === 'converted') {
        await ensureVoiceConfig();
        if (voiceBackendRef.current === 'elevenlabs') {
          await ensureApiKey();
          if (!apiKeyRef.current) {
            throw new Error('Unable to retrieve voice service credentials.');
          }
        } else if (!rvcServerUrlRef.current) {
          throw new Error('RVC server not configured.');
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
        const isRvc = voiceBackendRef.current === 'rvc';
        const captureRate = isRvc ? OVC_RATE : TARGET_RATE;
        const captureChunk = isRvc ? OVC_CHUNK : CHUNK_SAMPLES;
        const outputFormat = isRvc ? 'float32' : 'int16';

        const blob = new Blob([voiceCaptureProcessorCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);

        const workletNode = new AudioWorkletNode(ctx, 'voice-capture-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
        });
        workletNodeRef.current = workletNode;
        workletNode.port.postMessage({ type: 'config', chunkSamples: captureChunk, targetRate: captureRate, outputFormat });

        const silencer = ctx.createGain();
        silencer.gain.value = 0;
        silencerRef.current = silencer;

        if (isRvc) {
          // ── RVC path: activate model, then WebSocket to OpenVoiceChanger GPU server ──
          // Activate the selected model server-side (no-op if already active)
          try {
            const httpBase = buildOvcHttpUrl(rvcServerUrlRef.current);
            await fetch(`${httpBase}/api/models/${encodeURIComponent(voiceIdRef.current)}/activate`, { method: 'POST' });
          } catch (_e) { /* non-fatal — model may already be active */ }

          ovcSendSeqRef.current = 0;
          ovcRecvSeqRef.current = 0;

          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('RVC server connection timeout.')), 10000);
            const ws = connectOvc(buildOvcWsUrl(rvcServerUrlRef.current), {
              onOpen: () => { clearTimeout(timeout); resolve(); },
              onAudio: (samples, processingTime, seqNum) => {
                if (!activeRef.current || !ctxRef.current) return;
                // Round-trip latency: match returned seq to its send timestamp
                const sendTs = sendTimestampsRef.current[seqNum];
                if (sendTs) {
                  const rtt = performance.now() - sendTs;
                  voiceMetricsRef.current.rttSamples.push(rtt);
                  if (voiceMetricsRef.current.rttSamples.length > 30) voiceMetricsRef.current.rttSamples.shift();
                  delete sendTimestampsRef.current[seqNum];
                }
                // Server GPU processing time (reserved field = hundredths of a millisecond)
                if (processingTime) {
                  const ms = processingTime / 100;
                  voiceMetricsRef.current.processingSamples.push(ms);
                  if (voiceMetricsRef.current.processingSamples.length > 30) voiceMetricsRef.current.processingSamples.shift();
                }
                voiceMetricsRef.current.framesReceived++;

                const audioBuffer = float32ToAudioBuffer(ctxRef.current, samples);
                const seq = ovcRecvSeqRef.current++;
                streamQueuesRef.current[seq] = { buffers: [audioBuffer], complete: true };
                processPlaybackQueue();
              },
              onStatus: (_status) => {},
              onClose: () => {
                clearTimeout(timeout);
                if (activeRef.current) {
                  setVoiceError('RVC server connection closed.');
                  setVoiceState('error');
                }
              },
              onError: () => { clearTimeout(timeout); reject(new Error('Failed to connect to RVC server.')); },
            }, OVC_RATE, OVC_CHUNK);
            wsRef.current = ws;
          });

          // AudioWorklet → WebSocket: wrap float32 chunks in OVC binary frames and send
          workletNode.port.onmessage = (e) => {
            if (e.data.type !== 'chunk' || !activeRef.current) return;
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
            const seq = ovcSendSeqRef.current++;
            sendTimestampsRef.current[seq] = performance.now();
            voiceMetricsRef.current.framesSent++;
            const samples = new Float32Array(e.data.samples);
            const frame = createOvcFrame(seq, samples);
            wsRef.current.send(frame);
          };
        } else {
          // ── ElevenLabs path: direct HTTP streaming ──
          workletNode.port.onmessage = (e) => {
            if (e.data.type !== 'chunk' || !activeRef.current || !voiceIdRef.current) return;
            if (inFlightRef.current >= MAX_IN_FLIGHT) return;
            const pcm16 = new Int16Array(e.data.pcm16);
            inFlightRef.current++;
            sendChunk(pcm16).finally(() => { inFlightRef.current--; });
          };
        }

        source.connect(workletNode);
        workletNode.connect(silencer);
        silencer.connect(ctx.destination);

        // Process playback queue at 20ms for smooth, gap-free scheduling
        queueTimerRef.current = setInterval(() => {
          processPlaybackQueue();
        }, 20);

        // Voice metrics — sample every 1s for live UI, report to backend every 5s
        metricsTimerRef.current = setInterval(() => {
          const m = voiceMetricsRef.current;
          const avg = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
          const processingMs = Math.round(avg(m.processingSamples) * 10) / 10;
          const rttMs = Math.round(avg(m.rttSamples));
          setVoiceMetrics({
            backend: voiceBackendRef.current,
            model: voiceIdRef.current,
            processingMs,
            rttMs,
            framesSent: m.framesSent,
            framesReceived: m.framesReceived,
          });
          metricsReportTickRef.current++;
          if (metricsReportTickRef.current % 5 === 0 && sessionIdRef.current) {
            base44.functions.invoke('reportMetrics', {
              sessionId: sessionIdRef.current,
              voiceBackend: voiceBackendRef.current,
              voiceModel: voiceIdRef.current,
              voiceProcessingMs: processingMs,
              voiceRttMs: rttMs,
              voiceFramesSent: m.framesSent,
              voiceFramesReceived: m.framesReceived,
              voiceActive: true,
            }).catch(() => {});
          }
        }, 1000);

        setVoiceState('active');
      }
    } catch (err) {
      setVoiceError(err.message || 'Microphone access failed');
      setVoiceState('error');
      activeRef.current = false;
    }
  }, [sendChunk, processPlaybackQueue, ensureApiKey, ensureVoiceConfig]);

  const stopVoiceStream = useCallback(() => {
    activeRef.current = false;
    voiceIdRef.current = null;
    bufRef.current = [];
    accRef.current = 0;
    streamQueuesRef.current = {};
    nextStreamToPlayRef.current = 0;
    currentStreamSeqRef.current = 0;
    ovcSendSeqRef.current = 0;
    ovcRecvSeqRef.current = 0;
    playTimeRef.current = 0;
    inFlightRef.current = 0;
    consecutiveFailuresRef.current = 0;
    sendTimestampsRef.current = {};

    if (metricsTimerRef.current) {
      clearInterval(metricsTimerRef.current);
      metricsTimerRef.current = null;
    }
    // Final report — mark voice inactive
    if (sessionIdRef.current) {
      base44.functions.invoke('reportMetrics', {
        sessionId: sessionIdRef.current,
        voiceActive: false,
      }).catch(() => {});
    }
    setVoiceMetrics(null);

    if (queueTimerRef.current) {
      clearInterval(queueTimerRef.current);
      queueTimerRef.current = null;
    }
    if (wsRef.current) {
      try { wsRef.current.close(); } catch (_e) {}
      wsRef.current = null;
    }
    if (workletNodeRef.current) {
      try { workletNodeRef.current.port.close(); } catch (_e) {}
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
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
    voiceMetrics,
    startVoiceStream,
    stopVoiceStream,
    setMuted,
    getAudioStream,
  };
}