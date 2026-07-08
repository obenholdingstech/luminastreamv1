import { useState, useRef, useCallback, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

const DEFAULT_PROMPT = 'Substitute the character in the video with the person in the reference image. Maintain the background and camera motion.';

export function useMirrorStream(videoRef) {
  const [connectionState, setConnectionState] = useState('idle');
  const [errorMessage, setErrorMessage] = useState(null);
  const [recordingUrl, setRecordingUrl] = useState(null);

  const localStreamRef = useRef(null);
  const realtimeClientRef = useRef(null);
  const sessionIdRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const configRef = useRef(null);
  const isConnectingRef = useRef(false);
  const isManualDisconnectRef = useRef(false);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const recordingUrlRef = useRef(null);
  const attemptReconnectRef = useRef(() => {});

  // ── Recording helpers ──────────────────────────────────────────
  const startRecording = useCallback((stream) => {
    try {
      recordedChunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        if (recordedChunksRef.current.length > 0) {
          const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
          const url = URL.createObjectURL(blob);
          recordingUrlRef.current = url;
          setRecordingUrl(url);
        }
      };
      recorder.start(1000); // flush chunks every 1s
      mediaRecorderRef.current = recorder;
    } catch (_e) {
      // MediaRecorder unsupported — recording silently skipped
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch (_e) {}
    }
    mediaRecorderRef.current = null;
  }, []);

  const clearRecording = useCallback(() => {
    if (recordingUrlRef.current) {
      URL.revokeObjectURL(recordingUrlRef.current);
      recordingUrlRef.current = null;
    }
    setRecordingUrl(null);
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
      reconnectAttemptsRef.current = 0;
      isManualDisconnectRef.current = false;

      // Clear any previous recording before starting fresh
      if (recordingUrlRef.current) {
        URL.revokeObjectURL(recordingUrlRef.current);
        recordingUrlRef.current = null;
        setRecordingUrl(null);
      }

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
          startRecording(remoteStream);
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
  }, [videoRef, startRecording]);

  // ── Update state (prompt / image / enhance) ───────────────────
  const updateState = useCallback(async ({ prompt, imageFile, enhance }) => {
    if (!realtimeClientRef.current) return;
    const fullPrompt = prompt?.trim() || DEFAULT_PROMPT;
    configRef.current = { prompt: fullPrompt, imageFile, enhance };
    try {
      await realtimeClientRef.current.set({
        prompt: fullPrompt,
        ...(imageFile && { image: imageFile }),
        enhance,
      });
    } catch (_e) {}
  }, []);

  // ── Disconnect (manual — stops recording, no auto-reconnect) ──
  const disconnect = useCallback(async () => {
    isManualDisconnectRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    stopRecording();
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
  }, [videoRef, stopRecording]);

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
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch (_e) {}
      }
      if (realtimeClientRef.current) {
        try { realtimeClientRef.current.disconnect(); } catch (_e) {}
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  return { connectionState, errorMessage, connect, disconnect, updateState, reconnect, recordingUrl, clearRecording };
}