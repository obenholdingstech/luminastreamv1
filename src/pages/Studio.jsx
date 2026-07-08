import { useRef, useState, useEffect, useCallback } from 'react';
import ConfigPanel from '@/components/studio/ConfigPanel';
import VideoCanvas from '@/components/studio/VideoCanvas';
import { useMirrorStream } from '@/hooks/useMirrorStream';

export default function Studio() {
  const videoRef = useRef(null);
  const [panelVisible, setPanelVisible] = useState(true);
  const [uiHidden, setUiHidden] = useState(false);
  const [displayMode, setDisplayMode] = useState('landscape');

  const { connectionState, errorMessage, connect, disconnect, updateState, reconnect, recordingUrl, clearRecording } =
    useMirrorStream(videoRef);

  // Track current panel state so keyboard shortcuts can use it
  const panelStateRef = useRef({ prompt: '', imageFile: null, enhance: true });
  const handlePanelStateChange = useCallback((state) => {
    panelStateRef.current = state;
  }, []);

  // P: toggle config panel only — floating overlays stay visible
  const togglePanel = useCallback(() => {
    setUiHidden(false);
    setPanelVisible((prev) => !prev);
  }, []);

  // H: hide ALL UI (panel + overlays) — pure video. Press again to restore.
  const toggleAllUI = useCallback(() => {
    setUiHidden((prev) => {
      const next = !prev;
      setPanelVisible(!next);
      return next;
    });
  }, []);

  // Space: Go Live / End Session / Reconnect depending on state
  const handleSpace = useCallback(() => {
    if (connectionState === 'connected') {
      disconnect();
    } else if (connectionState === 'idle') {
      const { prompt, imageFile, enhance } = panelStateRef.current;
      connect({ prompt, imageFile, enhance });
    } else if (connectionState === 'error' || connectionState === 'disconnected') {
      reconnect();
    }
  }, [connectionState, connect, disconnect, reconnect]);

  // R: Reconnect (only in error/disconnected state)
  const handleReconnectKey = useCallback(() => {
    if (connectionState === 'error' || connectionState === 'disconnected') {
      reconnect();
    }
  }, [connectionState, reconnect]);

  // Download recording
  const handleDownload = useCallback(() => {
    if (recordingUrl) {
      const a = document.createElement('a');
      a.href = recordingUrl;
      a.download = `mirror-session-${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }, [recordingUrl]);

  // Global keyboard shortcuts
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
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [toggleAllUI, togglePanel, handleSpace, handleReconnectKey]);

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
            onConnect={connect}
            onDisconnect={disconnect}
            onUpdateState={updateState}
            onReconnect={reconnect}
            onHideUI={toggleAllUI}
            onStateChange={handlePanelStateChange}
            recordingUrl={recordingUrl}
            onDownload={handleDownload}
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
          recordingUrl={recordingUrl}
          onDownload={handleDownload}
        />
      </div>
    </div>
  );
}