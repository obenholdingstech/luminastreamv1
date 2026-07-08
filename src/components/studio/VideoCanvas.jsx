import StatusBadge from './StatusBadge';
import { PanelRight } from 'lucide-react';

export default function VideoCanvas({
  videoRef,
  connectionState,
  displayMode,
  isFullscreen,
  panelVisible,
  onShowPanel,
}) {
  const isActive = ['connecting', 'connected', 'disconnected'].includes(connectionState);

  return (
    <div className="w-full h-full relative bg-black flex items-center justify-center overflow-hidden">
      {/* Idle state — brand wordmark */}
      {!isActive && (
        <div className="text-center select-none">
          <h1 className="text-3xl font-light tracking-[0.4em] text-white/20 uppercase">Mirror</h1>
          <p className="text-xs text-white/15 mt-3 tracking-widest uppercase">Ready when you are</p>
        </div>
      )}

      {/* Video output — ref-based, srcObject set imperatively for zero re-render overhead */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`absolute inset-0 w-full h-full ${
          displayMode === 'portrait' ? 'object-contain' : 'object-cover'
        }`}
        style={{ display: isActive ? 'block' : 'none' }}
      />

      {/* Floating status + restore pill — visible when panel hidden or fullscreen */}
      {(!panelVisible || isFullscreen) && (
        <div className="absolute bottom-6 right-6 flex items-center gap-3 z-50">
          <StatusBadge state={connectionState} />
          <button
            onClick={onShowPanel}
            className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 flex items-center justify-center text-white hover:bg-white/20 transition"
            title="Show panel (H)"
          >
            <PanelRight size={18} />
          </button>
        </div>
      )}
    </div>
  );
}