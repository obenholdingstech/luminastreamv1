import { useState, useRef, useCallback, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

const DEFAULT_PROMPT = 'Substitute the character in the video with the person in the reference image. Maintain the background and camera motion.';

export function useMirrorStream(videoRef) {
  const [connectionState, setConnectionState] = useState('idle');
  const [errorMessage, setErrorMessage] = useState(null);

  const localStreamRef = useRef(null);
  const realtimeClientRef = useRef(null);
  const sessionIdRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const configRef = useRef(null);
  const isConnectingRef = useRef(false);
  const attemptReconnectRef = useRef(() => {});

  const connect = useCallback(async ({ prompt, imageFile, enhance }) => {
    if (isConnectingRef.current) return;
    isConnectingRef.current = true;

    const fullPrompt = prompt?.trim() || DEFAULT_PROMPT;
    configRef.current = { prompt: fullPrompt, imageFile, enhance };

    try {
      setConnectionState('connecting');
      setErrorMessage(null);
      reconnectAttemptsRef.current = 0;

      // 1. Create session on backend (validates, rate-limits, returns credentials)
      const sessionRes = await base44.functions.invoke('createSession', {});
      const { sessionId, apiKey, modelConfig } = sessionRes.data;
      sessionIdRef.current = sessionId;

      // 2. Get camera stream with model-native specs (reuses existing stream on reconnect)
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

      // 3. Import SDK and create client (dynamic import keeps initial bundle lean)
      const { createDecartClient, models } = await import('@decartai/sdk');
      const model = models.realtime(modelConfig.modelId);
      const client = createDecartClient({ apiKey });

      // Define reconnection logic inside this closure so it has access to connect()
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

      // 4. Connect with initialState so frame 1 is already transformed (no raw camera flash)
      const realtimeClient = await client.realtime.connect(stream, {
        model,
        mirror: 'auto',
        onRemoteStream: (remoteStream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = remoteStream;
          }
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

      // 5. Immediately set image + prompt together (atomic, avoids intermediate state)
      if (imageFile) {
        try {
          await realtimeClient.set({
            prompt: fullPrompt,
            image: imageFile,
            enhance,
          });
        } catch (_e) {
          // set() may race with connection setup; safe to ignore
        }
      }

      // 6. Wire up connection state and error handlers
      realtimeClient.on('connectionChange', (state) => {
        if (state === 'connected') {
          setConnectionState('connected');
          reconnectAttemptsRef.current = 0;
        } else if (state === 'disconnected') {
          attemptReconnectRef.current();
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
  }, [videoRef]);

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
    } catch (_e) {
      // non-fatal — state will sync on next update
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
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
  }, [videoRef]);

  const reconnect = useCallback(() => {
    if (configRef.current) {
      reconnectAttemptsRef.current = 0;
      connect(configRef.current);
    }
  }, [connect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
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