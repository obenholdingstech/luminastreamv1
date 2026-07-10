import { useState, useRef, useEffect } from 'react';
import AvatarUploader from './AvatarUploader';
import VoiceUploader from './VoiceUploader';
import VoiceModeSelector from './VoiceModeSelector';
import VoiceCloneUploader from './VoiceCloneUploader';
import StatusBadge from './StatusBadge';
import { Link } from 'react-router-dom';
import { Power, Square, EyeOff, Volume2, VolumeX } from 'lucide-react';

export default function ConfigPanel({
  connectionState,
  errorMessage,
  displayMode,
  setDisplayMode,
  onConnect,
  onDisconnect,
  onUpdateState,
  onReconnect,
  onHideUI,
  onStateChange,
  voiceMode,
  setVoiceMode,
  selectedVoiceId,
  onSelectVoice,
  voiceState,
  voiceError,
  muted,
  onToggleMute,
  onVoiceCloned,
  voiceRefreshTrigger,
}) {
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [enhance, setEnhance] = useState(true);
  const [showCloneUploader, setShowCloneUploader] = useState(false);
  const promptTimerRef = useRef(null);

  const isStreaming = connectionState === 'connected';
  const isDisconnected = connectionState === 'disconnected' || connectionState === 'error';

  const handleImageChange = (file, preview) => {
    setImageFile(file);
    setImagePreview(preview);
    if (isStreaming) {
      onUpdateState({ prompt, imageFile: file, enhance });
    }
  };

  const handlePromptChange = (value) => {
    setPrompt(value);
    if (isStreaming) {
      if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
      promptTimerRef.current = setTimeout(() => {
        onUpdateState({ prompt: value, imageFile, enhance });
      }, 500);
    }
  };

  const handleEnhanceChange = (value) => {
    setEnhance(value);
    if (isStreaming) {
      onUpdateState({ prompt, imageFile, enhance: value });
    }
  };

  useEffect(() => {
    return () => {
      if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
    };
  }, []);

  // Sync current state upward so keyboard shortcuts can use it
  useEffect(() => {
    onStateChange?.({ prompt, imageFile, enhance });
  }, [prompt, imageFile, enhance, onStateChange]);

  return (
    <div className="w-full h-full bg-[#0F0F1A] border-r border-[#1A1A2E] flex flex-col">
      {/* Brand header */}
      <div className="px-6 py-5 border-b border-[#1A1A2E]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[13px] font-semibold tracking-[0.3em] text-white uppercase">Mirror</h1>
            <p className="text-[10px] tracking-widest text-[#64748B] uppercase mt-1">Realtime Studio</p>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/roadmap" className="text-[10px] text-[#64748B] hover:text-white tracking-wider uppercase transition">
              Roadmap
            </Link>
            <Link to="/text-to-speech" className="text-[10px] text-[#64748B] hover:text-white tracking-wider uppercase transition">
              TTS
            </Link>
          </div>
        </div>
      </div>

      {/* Scrollable config area */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 custom-scrollbar">
        {/* Status */}
        <div className="flex items-center justify-between">
          <StatusBadge state={connectionState} />
          {errorMessage && (
            <span className="text-[10px] text-red-400 truncate max-w-[140px]">{errorMessage}</span>
          )}
        </div>

        {/* Reference image */}
        <div>
          <label className="text-[11px] font-medium tracking-widest text-[#64748B] uppercase mb-2 block">
            Reference Image
          </label>
          <AvatarUploader imagePreview={imagePreview} onImageSelect={handleImageChange} />
          <p className="text-[10px] text-[#4A5568] mt-2 leading-relaxed">
            Front-facing portrait, 512×512 minimum. Defines the identity.
          </p>
        </div>

        {/* Voice output */}
        <div>
          <label className="text-[11px] font-medium tracking-widest text-[#64748B] uppercase mb-2 block">
            Voice Output
          </label>
          <VoiceModeSelector mode={voiceMode} onModeChange={setVoiceMode} />
          {voiceMode === 'converted' && (
            <>
              <div className="mt-3">
                <VoiceUploader
                  selectedVoiceId={selectedVoiceId}
                  onSelectVoice={onSelectVoice}
                  voiceState={voiceState}
                  voiceError={voiceError}
                  refreshTrigger={voiceRefreshTrigger}
                />
              </div>
              <button
                onClick={() => setShowCloneUploader(!showCloneUploader)}
                className="mt-2 text-[10px] text-[#6366F1] hover:text-[#5558E0] tracking-wider uppercase transition"
              >
                {showCloneUploader ? '− Hide Voice Cloner' : '+ Clone New Voice'}
              </button>
              {showCloneUploader && (
                <div className="mt-3">
                  <VoiceCloneUploader onVoiceCloned={onVoiceCloned} />
                </div>
              )}
            </>
          )}
          <p className="text-[10px] text-[#4A5568] mt-2 leading-relaxed">
            {voiceMode === 'direct'
              ? 'Your natural microphone voice goes straight to the output with no conversion.'
              : 'Select a voice model. Your speech is converted in real-time on the voice server.'}
          </p>
        </div>

        {/* Audio output toggle */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium tracking-widest text-[#64748B] uppercase">Audio Output</span>
          <button
            onClick={onToggleMute}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition ${
              muted
                ? 'bg-[#2A2A3E] border-[#2A2A3E] text-[#64748B]'
                : 'bg-[#6366F1]/10 border-[#6366F1] text-white'
            }`}
          >
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            <span className="text-[10px] tracking-wider uppercase">{muted ? 'Muted' : 'On'}</span>
          </button>
        </div>
        <p className="text-[9px] text-[#4A5568] leading-relaxed mt-1.5">
          Mute silences your speakers only — recording always captures full audio. For SplitCam: keep unmuted + use headphones to avoid echo.
        </p>

        {/* Look prompt */}
        <div>
          <label className="text-[11px] font-medium tracking-widest text-[#64748B] uppercase mb-2 block">
            Look Prompt
          </label>
          <textarea
            value={prompt}
            onChange={(e) => handlePromptChange(e.target.value)}
            placeholder="Describe outfit, style, or scene..."
            rows={4}
            className="w-full bg-[#13131F] border border-[#2A2A3E] rounded-md px-3 py-2.5 text-sm text-white placeholder:text-[#4A5568] focus:outline-none focus:border-[#6366F1] resize-none transition"
          />
        </div>

        {/* Auto-enhance toggle */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium tracking-widest text-[#64748B] uppercase">Auto Enhance</span>
          <button
            onClick={() => handleEnhanceChange(!enhance)}
            className={`w-9 h-5 rounded-full transition relative ${enhance ? 'bg-[#6366F1]' : 'bg-[#2A2A3E]'}`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                enhance ? 'left-4' : 'left-0.5'
              }`}
            />
          </button>
        </div>

        {/* Display mode toggle */}
        <div>
          <label className="text-[11px] font-medium tracking-widest text-[#64748B] uppercase mb-2 block">
            Display Mode
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => setDisplayMode('landscape')}
              className={`flex-1 py-2 text-xs rounded-md border transition ${
                displayMode === 'landscape'
                  ? 'bg-[#6366F1]/10 border-[#6366F1] text-white'
                  : 'bg-[#13131F] border-[#2A2A3E] text-[#64748B]'
              }`}
            >
              Landscape 16:9
            </button>
            <button
              onClick={() => setDisplayMode('portrait')}
              className={`flex-1 py-2 text-xs rounded-md border transition ${
                displayMode === 'portrait'
                  ? 'bg-[#6366F1]/10 border-[#6366F1] text-white'
                  : 'bg-[#13131F] border-[#2A2A3E] text-[#64748B]'
              }`}
            >
              Portrait 9:16
            </button>
          </div>
        </div>
      </div>

      {/* Footer actions */}
      <div className="px-6 py-5 border-t border-[#1A1A2E] space-y-3">
        {!isStreaming ? (
          <button
            onClick={isDisconnected ? onReconnect : () => onConnect({ prompt, imageFile, enhance })}
            disabled={connectionState === 'connecting'}
            className="w-full py-3 bg-[#6366F1] hover:bg-[#5558E0] text-white text-sm font-medium rounded-md transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <Power size={16} />
            {connectionState === 'connecting'
              ? 'Connecting...'
              : isDisconnected
              ? 'Reconnect'
              : 'Go Live'}
          </button>
        ) : (
          <button
            onClick={onDisconnect}
            className="w-full py-3 border border-red-500/30 hover:bg-red-500/10 text-red-400 text-sm font-medium rounded-md transition flex items-center justify-center gap-2"
          >
            <Square size={16} />
            End Session
          </button>
        )}

        <button
          onClick={onHideUI}
          className="w-full py-2.5 text-[#64748B] hover:text-white text-xs tracking-widest uppercase transition flex items-center justify-center gap-2"
        >
          <EyeOff size={14} />
          Hide All UI (H)
        </button>

        <p className="text-[9px] text-[#4A5568] text-center tracking-wider pt-1">
          H Hide All · P Panel · Space Live/Stop · R Reconnect
        </p>
      </div>
    </div>
  );
}