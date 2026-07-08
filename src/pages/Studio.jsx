import { useRef, useState, useEffect, useCallback } from 'react';
import ConfigPanel from '@/components/studio/ConfigPanel';
import VideoCanvas from '@/components/studio/VideoCanvas';
import { useMirrorStream } from '@/hooks/useMirrorStream';

export default function Studio() {
  const videoRef = useRef(null);
  const outputRef = useRef(null);
  const [panelVisible, setPanelVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [displayMode, setDisplayMode] = useState('landscape');

  const { connectionState, errorMessage, connect, disconnect, updateState, reconnect } =
    useMirrorStream(videoRef);

  const togglePanel = useCallback(() => {
    setPanelVisible((prev) => {
      const next = !prev;
      if (!next && outputRef.current) {
        outputRef.current.requestFullscreen?.().catch(() => {});
      } else if (next && document.fullscreenElement) {
        document.exitFullscreen?.();
      }
      return next;
    });
  }, []);

  // Global H key handler — hides/shows panel + toggles fullscreen
  useEffect(() => {
    const handleKey = (e) => {
      if (
        (e.key === 'h' || e.key === 'H') &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)
      ) {
        e.preventDefault();
        togglePanel();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [togglePanel]);

  // Sync fullscreen state — Escape restores panel
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      if (!document.fullscreenElement) setPanelVisible(true);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#080810] flex">
      {/* Config panel — slides out via width transition, inner content isolated */}
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
            onHideUI={togglePanel}
          />
        </div>
      </div>

      {/* Video output — flex-1 fills remaining space, goes fullscreen on H */}
      <div ref={outputRef} className="flex-1 h-full relative bg-black">
        <VideoCanvas
          videoRef={videoRef}
          connectionState={connectionState}
          displayMode={displayMode}
          isFullscreen={isFullscreen}
          panelVisible={panelVisible}
          onShowPanel={togglePanel}
        />
      </div>
    </div>
  );
}