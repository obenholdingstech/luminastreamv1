import { useState, useRef, useCallback, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

const DEFAULT_PROMPT = 'Substitute the character in the video with the person in the reference image. Maintain the background and camera motion.';

export function useMirrorStream(videoRef, onRemoteStream) {
  const [connectionState, setConnectionState] = useState('idle');
  const [errorMessage, setErrorMessage] = useState(null);

  const localStreamRef = useRef(null);
  const realtimeClientRef = useRef(null);
  const sessionIdRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const configRef = useRef(null);
  const isConnectingRef = useRef(false);
  const isManualDisconnectRef = useRef(false);
  const attemptReconnectRef = useRef(() => {});
  const metricsIntervalRef = useRef(null);
  const metricsStateRef = useRef({
    prevTotalFrames: 0, prevDroppedFrames: 0, prevSampleTime: 0,
    currentFps: 0, droppedFrameRate: 0, latencyMs: 0, reconnectCount: 0,
  });
  const latencySamplesRef = useRef([]);
  const totalReconnectsRef = useRef(0);

  // ── Performance metrics collection ───────────────────────────
  const startMetricsCollection = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    metricsStateRef.current = {
      prevTotalFrames: 0, prevDroppedFrames: 0, prevSampleTime: Date.now(),
      currentFps: 0, droppedFrameRate: 0, latencyMs: 0, reconnectCount: 0,
    };

    // Sample video playback quality every 2s for FPS + dropped frames
    const sampleInterval = setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.getVideoPlaybackQuality) return;
      const q = v.getVideoPlaybackQuality();
      const now = Date.now();
      const st = metricsStateRef.current;
      const dt = (now - st.prevSampleTime) / 1000;
      const framesDelta = q.totalVideoFrames - st.prevTotalFrames;
      const droppedDelta = q.droppedVideoFrames - st.prevDroppedFrames;
      st.currentFps = dt > 0 ? Math.round(framesDelta / dt) : 0;
      st.droppedFrameRate = framesDelta > 0 ? Math.round((droppedDelta / framesDelta) * 1000) / 10 : 0;
      st.prevTotalFrames = q.totalVideoFrames;
      st.prevDroppedFrames = q.droppedVideoFrames;
      st.prevSampleTime = now;
      st.reconnectCount = totalReconnectsRef.current;
      if (latencySamplesRef.current.length > 0) {
        st.latencyMs = Math.round(
          latencySamplesRef.current.reduce((s, v) => s + v, 0) / latencySamplesRef.current.length
        );
      }
    }, 2000);

    // Report to backend every 5s
    const reportInterval = setInterval(async () => {
      if (!sessionIdRef.current) return;
      const st = metricsStateRef.current;
      const fpsScore = st.currentFps >= 20 ? 100 : st.currentFps >= 15 ? 75 : st.currentFps >= 10 ? 50 : 25;
      const dropScore = st.droppedFrameRate <= 2 ? 100 : st.droppedFrameRate <= 5 ? 80 : st.droppedFrameRate <= 10 ? 60 : 40;
      const qualityScore = Math.round(fpsScore * 0.6 + dropScore * 0.4);
      try {
        await base44.functions.invoke('reportMetrics', {
          sessionId: sessionIdRef.current,
          currentFps: st.currentFps,
          droppedFrameRate: st.droppedFrameRate,
          qualityScore,
          latencyMs: st.latencyMs,
          reconnectCount: st.reconnectCount,
        });
      } catch (_e) {}
    }, 5000);

    metricsIntervalRef.current = { sampleInterval, reportInterval };
  }, [videoRef]);

  const stopMetricsCollection = useCallback(() => {
    if (metricsIntervalRef.current) {
      clearInterval(metricsIntervalRef.current.sampleInterval);
      clearInterval(metricsIntervalRef.current.reportInterval);
      metricsIntervalRef.current = null;
    }
    latencySamplesRef.current = [];
  }, []);

  // ── Connect ────────────────────────────────────────────────────
  const connect = useCallback(async ({ prompt, imageFile, enhance }) => {
    if (isConnectingRef.current) return;
    isConnectingRef.current = true;

    const fullPrompt = prompt?.trim() || DEFAULT_PROMPT;
    configRef.current = { prompt: fullPrompt, imageFile, enhance };

    try {
      setConnectionState('connecting');
      setErrorMessage(null);
      const isReconnect = reconnectAttemptsRef.current > 0;
      reconnectAttemptsRef.current = 0;
      isManualDisconnectRef.current = false;
      if (!isReconnect) totalReconnectsRef.current = 0;
      const connectStartTime = Date.now();

      // 1. Create session on backend (validates, rate-limits, returns credentials)
      const sessionRes = await base44.functions.invoke('createSession', {});
      const { sessionId, apiKey, modelConfig } = sessionRes.data;
      sessionIdRef.current = sessionId;

      // 2. Get camera stream with model-native specs
      let stream = localStreamRef.current;
      if (!stream || !stream.active) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            frameRate: { ideal: modelConfig.fps },
            width: { ideal: modelConfig.width },
            height: { ideal: modelConfig.height },
          },
          audio: false,
        });
        localStreamRef.current = stream;
      }

      // 3. Import SDK and create client
      const { createDecartClient, models } = await import('@decartai/sdk');
      const model = models.realtime(modelConfig.modelId);
      const client = createDecartClient({ apiKey });

      // Reconnection logic — defined inside closure so it can call connect()
      const attemptReconnect = () => {
        if (reconnectAttemptsRef.current >= 3) {
          setConnectionState('error');
          setErrorMessage('Connection lost — tap retry to reconnect.');
          return;
        }
        setConnectionState('disconnected');
        const delay = Math.pow(2, reconnectAttemptsRef.current) * 1000;
        reconnectAttemptsRef.current++;
        totalReconnectsRef.current++;
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(async () => {
          if (configRef.current) {
            await connect(configRef.current);
          }
        }, delay);
      };
      attemptReconnectRef.current = attemptReconnect;

      // 4. Connect with initialState so frame 1 is already transformed
      const realtimeClient = await client.realtime.connect(stream, {
        model,
        mirror: 'auto',
        onRemoteStream: (remoteStream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = remoteStream;
          }
          // Notify parent so recording can capture the video stream
          onRemoteStream?.(remoteStream);
          latencySamplesRef.current.push(Date.now() - connectStartTime);
          if (latencySamplesRef.current.length > 10) latencySamplesRef.current.shift();
          startMetricsCollection();
          setConnectionState('connected');
          reconnectAttemptsRef.current = 0;
        },
        initialState: {
          prompt: {
            text: fullPrompt,
            enhance,
          },
          ...(imageFile && { image: imageFile }),
        },
      });

      realtimeClientRef.current = realtimeClient;

      // 5. Set image immediately if provided
      if (imageFile) {
        try {
          await realtimeClient.set({
            prompt: fullPrompt,
            image: imageFile,
            enhance,
          });
        } catch (_e) {}
      }

      // 6. Event handlers
      realtimeClient.on('connectionChange', (state) => {
        if (state === 'connected') {
          setConnectionState('connected');
          reconnectAttemptsRef.current = 0;
        } else if (state === 'disconnected') {
          // Only auto-reconnect if this wasn't a manual user disconnect
          if (!isManualDisconnectRef.current) {
            attemptReconnectRef.current();
          }
        }
      });

      realtimeClient.on('error', (err) => {
        setErrorMessage(err.message || 'Connection issue');
        setConnectionState('error');
        base44.functions.invoke('logError', {
          sessionId: sessionIdRef.current,
          errorCode: err.code || 'UNKNOWN',
          errorMessage: err.message || 'Unknown error',
        }).catch(() => {});
      });

    } catch (error) {
      setErrorMessage(error.message || 'Failed to connect');
      setConnectionState('error');
      base44.functions.invoke('logError', {
        sessionId: sessionIdRef.current,
        errorCode: 'CONNECT_FAILED',
        errorMessage: error.message || 'Connection failed',
      }).catch(() => {});
    } finally {
      isConnectingRef.current = false;
    }
  }, [videoRef, onRemoteStream, startMetricsCollection]);

  // ── Update state (prompt / image / enhance) ───────────────────
  const updateState = useCallback(async ({ prompt, imageFile, enhance }) => {
    if (!realtimeClientRef.current) return;
    const fullPrompt = prompt?.trim() || DEFAULT_PROMPT;
    configRef.current = { prompt: fullPrompt, imageFile, enhance };
    try {
      const t0 = Date.now();
      await realtimeClientRef.current.set({
        prompt: fullPrompt,
        ...(imageFile && { image: imageFile }),
        enhance,
      });
      const latency = Date.now() - t0;
      latencySamplesRef.current.push(latency);
      if (latencySamplesRef.current.length > 10) latencySamplesRef.current.shift();
    } catch (_e) {}
  }, []);

  // ── Disconnect (manual — stops recording, no auto-reconnect) ──
  const disconnect = useCallback(async () => {
    isManualDisconnectRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    stopMetricsCollection();
    if (realtimeClientRef.current) {
      try { realtimeClientRef.current.disconnect(); } catch (_e) {}
      realtimeClientRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (sessionIdRef.current) {
      base44.functions.invoke('endSession', { sessionId: sessionIdRef.current }).catch(() => {});
      sessionIdRef.current = null;
    }
    setConnectionState('idle');
    reconnectAttemptsRef.current = 0;
  }, [videoRef, stopMetricsCollection]);

  // ── Reconnect (manual reset) ──────────────────────────────────
  const reconnect = useCallback(() => {
    if (configRef.current) {
      reconnectAttemptsRef.current = 0;
      connect(configRef.current);
    }
  }, [connect]);

  // ── Cleanup on unmount ────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      stopMetricsCollection();
      if (realtimeClientRef.current) {
        try { realtimeClientRef.current.disconnect(); } catch (_e) {}
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  return { connectionState, errorMessage, connect, disconnect, updateState, reconnect };
}