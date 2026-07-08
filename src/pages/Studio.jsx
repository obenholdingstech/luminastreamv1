import { useRef, useState, useEffect, useCallback } from 'react';
import ConfigPanel from '@/components/studio/ConfigPanel';
import VideoCanvas from '@/components/studio/VideoCanvas';
import RecordingPreview from '@/components/studio/RecordingPreview';
import { useMirrorStream } from '@/hooks/useMirrorStream';
import { useVoiceStream } from '@/hooks/useVoiceStream';
import { useRecording } from '@/hooks/useRecording';

export default function Studio() {
  const videoRef = useRef(null);
  const [panelVisible, setPanelVisible] = useState(true);
  const [uiHidden, setUiHidden] = useState(false);
  const [displayMode, setDisplayMode] = useState('landscape');
  const [muted, setMuted] = useState(false);
  const [voiceRefreshTrigger, setVoiceRefreshTrigger] = useState(0);

  const recording = useRecording();

  // Handle remote video stream — pass to recording hook
  const handleRemoteStream = useCallback((stream) => {
    recording.setVideoStream(stream);
  }, [recording]);

  const { connectionState, errorMessage, connect, disconnect, updateState, reconnect } =
    useMirrorStream(videoRef, handleRemoteStream);

  const [voiceMode, setVoiceMode] = useState('direct');
  const [selectedVoiceId, setSelectedVoiceId] = useState(null);
  const { voiceState, voiceError, startVoiceStream, stopVoiceStream, setMuted: setVoiceMuted, getAudioStream } =
    useVoiceStream();

  // Track current panel state so keyboard shortcuts can use it
  const panelStateRef = useRef({ prompt: '', imageFile: null, enhance: true });
  const handlePanelStateChange = useCallback((state) => {
    panelStateRef.current = state;
  }, []);

  // ── Recording wiring ──
  // When voice becomes active, feed the audio stream to the recording hook
  useEffect(() => {
    if (voiceState === 'active') {
      const audioStream = getAudioStream();
      if (audioStream) {
        recording.setAudioStream(audioStream);
      }
    }
  }, [voiceState, getAudioStream, recording]);

  // Stop recording when session ends
  useEffect(() => {
    if (connectionState === 'idle' || connectionState === 'error') {
      recording.stop();
    }
  }, [connectionState, recording]);

  // ── Mute control ──
  useEffect(() => {
    setVoiceMuted(muted);
  }, [muted, setVoiceMuted]);

  // ── Voice mode switching ──
  // When mode changes during streaming, restart the voice stream with the new mode
  const prevModeRef = useRef(voiceMode);
  useEffect(() => {
    if (connectionState === 'connected' && prevModeRef.current !== voiceMode) {
      prevModeRef.current = voiceMode;
      stopVoiceStream();
    }
  }, [voiceMode, connectionState, stopVoiceStream]);

  // ── Voice coordination ──
  // Starts/stops the voice stream based on connection state and mode
  useEffect(() => {
    if (connectionState === 'connected' && voiceMode && voiceState === 'idle') {
      if (voiceMode === 'converted' && !selectedVoiceId) return;
      startVoiceStream({ voiceId: selectedVoiceId, mode: voiceMode, muted });
    } else if ((connectionState === 'idle' || connectionState === 'error') && voiceState === 'active') {
      stopVoiceStream();
    }
  }, [connectionState, voiceMode, selectedVoiceId, voiceState, muted, startVoiceStream, stopVoiceStream]);

  // ── Connect / Reconnect wrappers (clear previous recording) ──
  const handleConnect = useCallback((config) => {
    recording.clear();
    connect(config);
  }, [recording, connect]);

  const handleReconnect = useCallback(() => {
    recording.clear();
    reconnect();
  }, [recording, reconnect]);

  // ── Voice clone callback ──
  const handleVoiceCloned = useCallback(() => {
    setVoiceRefreshTrigger((prev) => prev + 1);
  }, []);

  // ── Download recording ──
  const handleDownload = useCallback(() => {
    if (recording.recordingUrl) {
      const a = document.createElement('a');
      a.href = recording.recordingUrl;
      a.download = `mirror-session-${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }, [recording.recordingUrl]);

  // ── Keyboard shortcuts ──
  const togglePanel = useCallback(() => {
    setUiHidden(false);
    setPanelVisible((prev) => !prev);
  }, []);

  const toggleAllUI = useCallback(() => {
    setUiHidden((prev) => {
      const next = !prev;
      setPanelVisible(!next);
      return next;
    });
  }, []);

  const handleSpace = useCallback(() => {
    if (connectionState === 'connected') {
      disconnect();
    } else if (connectionState === 'idle') {
      const { prompt, imageFile, enhance } = panelStateRef.current;
      handleConnect({ prompt, imageFile, enhance });
    } else if (connectionState === 'error' || connectionState === 'disconnected') {
      handleReconnect();
    }
  }, [connectionState, disconnect, handleConnect, handleReconnect]);

  const handleReconnectKey = useCallback(() => {
    if (connectionState === 'error' || connectionState === 'disconnected') {
      handleReconnect();
    }
  }, [connectionState, handleReconnect]);

  useEffect(() => {
    const handleKey = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        toggleAllUI();
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        togglePanel();
      } else if (e.code === 'Space') {
        e.preventDefault();
        handleSpace();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        handleReconnectKey();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        setMuted((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [toggleAllUI, togglePanel, handleSpace, handleReconnectKey]);

  const isStreaming = connectionState === 'connected';

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#080810] flex">
      {/* Config panel — slides out via width transition */}
      <div
        className="h-full transition-all duration-300 ease-out overflow-hidden flex-shrink-0"
        style={{ width: panelVisible ? '320px' : '0px' }}
      >
        <div className="w-[320px] h-full" style={{ isolation: 'isolate' }}>
          <ConfigPanel
            connectionState={connectionState}
            errorMessage={errorMessage}
            displayMode={displayMode}
            setDisplayMode={setDisplayMode}
            onConnect={handleConnect}
            onDisconnect={disconnect}
            onUpdateState={updateState}
            onReconnect={handleReconnect}
            onHideUI={toggleAllUI}
            onStateChange={handlePanelStateChange}
            voiceMode={voiceMode}
            setVoiceMode={setVoiceMode}
            selectedVoiceId={selectedVoiceId}
            onSelectVoice={setSelectedVoiceId}
            voiceState={voiceState}
            voiceError={voiceError}
            muted={muted}
            onToggleMute={() => setMuted((prev) => !prev)}
            onVoiceCloned={handleVoiceCloned}
            voiceRefreshTrigger={voiceRefreshTrigger}
          />
        </div>
      </div>

      {/* Video output */}
      <div className="flex-1 h-full relative bg-black">
        <VideoCanvas
          videoRef={videoRef}
          connectionState={connectionState}
          displayMode={displayMode}
          uiHidden={uiHidden}
          panelVisible={panelVisible}
          onShowPanel={togglePanel}
        />

        {/* Recording preview — shows after session ends, user can close */}
        {!isStreaming && recording.recordingUrl && !uiHidden && (
          <RecordingPreview
            recordingUrl={recording.recordingUrl}
            onClose={() => recording.clear()}
            onDownload={handleDownload}
          />
        )}
      </div>
    </div>
  );
}