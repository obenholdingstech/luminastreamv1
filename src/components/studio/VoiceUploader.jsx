import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Mic, Loader2, Check, Play, Pause, ChevronDown, Lock } from 'lucide-react';

export default function VoiceUploader({ selectedVoiceId, onSelectVoice, voiceState, voiceError, disabled }) {
  const [voices, setVoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const dropdownRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    loadVoices();
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const loadVoices = async () => {
    try {
      const res = await base44.functions.invoke('listVoices', {});
      setVoices(res.data?.voices || []);
    } catch (_err) {
      setLoadError('Failed to load voice library');
    }
    setLoading(false);
  };

  const selectedVoice = voices.find((v) => v.voiceId === selectedVoiceId);

  const togglePreview = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const handleSelect = (voice) => {
    onSelectVoice(voice.voiceId);
    if (voice.previewUrl) setPreviewUrl(voice.previewUrl);
    setIsOpen(false);
  };

  return (
    <div className="space-y-3">
      {/* Voice selector dropdown */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => !disabled && !loading && setIsOpen(!isOpen)}
          disabled={disabled || loading}
          className={`w-full bg-[#13131F] border rounded-md px-3 py-2.5 text-sm text-left transition flex items-center justify-between ${
            isOpen ? 'border-[#6366F1]' : 'border-[#2A2A3E]'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-[#3A3A4E]'} ${
            selectedVoiceId ? 'text-white' : 'text-[#4A5568]'
          }`}
        >
          <span className="flex items-center gap-2 truncate">
            {loading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Loading voices…
              </>
            ) : selectedVoice ? (
              <>
                <Mic size={14} className="text-[#6366F1] flex-shrink-0" />
                <span className="truncate">{selectedVoice.name}</span>
              </>
            ) : (
              <>
                <Mic size={14} className="flex-shrink-0" />
                Select a voice
              </>
            )}
          </span>
          {!loading && (
            <ChevronDown
              size={14}
              className={`text-[#64748B] transition flex-shrink-0 ${isOpen ? 'rotate-180' : ''}`}
            />
          )}
        </button>

        {/* Dropdown menu */}
        {isOpen && !loading && (
          <div className="absolute z-50 w-full mt-1 bg-[#13131F] border border-[#2A2A3E] rounded-md max-h-56 overflow-y-auto custom-scrollbar shadow-xl">
            {voices.length === 0 ? (
              <p className="px-3 py-3 text-xs text-[#64748B]">No voices available</p>
            ) : (
              voices.map((voice) => (
                <button
                  key={voice.voiceId}
                  onClick={() => handleSelect(voice)}
                  className={`w-full text-left px-3 py-2.5 text-xs hover:bg-[#1A1A2E] transition flex items-center justify-between ${
                    selectedVoiceId === voice.voiceId ? 'bg-[#6366F1]/10' : ''
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Mic size={12} className="text-[#64748B] flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-white truncate">{voice.name}</p>
                      {voice.category && (
                        <p className="text-[9px] text-[#64748B] uppercase tracking-wider">
                          {voice.category}
                        </p>
                      )}
                    </div>
                  </div>
                  {selectedVoiceId === voice.voiceId && (
                    <Check size={12} className="text-[#6366F1] flex-shrink-0" />
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Selected voice preview */}
      {selectedVoice && (
        <div className="bg-[#13131F] border border-[#2A2A3E] rounded-md p-2.5 flex items-center gap-3">
          <button
            onClick={togglePreview}
            disabled={!previewUrl}
            className="w-8 h-8 rounded-full bg-[#6366F1]/20 flex items-center justify-center text-[#6366F1] hover:bg-[#6366F1]/30 transition flex-shrink-0 disabled:opacity-30"
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-white truncate">{selectedVoice.name}</p>
            <p className="text-[10px] text-[#64748B]">
              {voiceState === 'active' ? 'Converting live' : 'Preview'}
            </p>
          </div>
          {voiceState === 'active' && (
            <span className="w-2 h-2 rounded-full bg-[#10B981] animate-pulse flex-shrink-0" />
          )}
        </div>
      )}

      {previewUrl && (
        <audio
          ref={audioRef}
          src={previewUrl}
          onEnded={() => setIsPlaying(false)}
          className="hidden"
        />
      )}

      {loadError && <p className="text-[10px] text-red-400">{loadError}</p>}
      {voiceError && voiceState === 'error' && (
        <p className="text-[10px] text-red-400">{voiceError}</p>
      )}

      {/* Option C — Instant Voice Cloning (Coming Soon)
          Architecture: When activated, this placeholder becomes an active uploader
          that calls `cloneVoice` with reference audio. The `VoiceProfile` entity
          stores cloned voices for reuse. A future external cloning service will
          enforce a 5-voice-per-user limit. Integration point: replace this
          placeholder with an active uploader when the external service is ready. */}
      <div className="rounded-md border border-dashed border-[#1A1A2E] p-3.5 text-center opacity-40">
        <div className="flex items-center justify-center gap-2 text-xs text-[#64748B]">
          <Lock size={13} />
          Coming Soon
        </div>
        <p className="text-[9px] text-[#4A5568] mt-1">Instant Voice Cloning</p>
      </div>
    </div>
  );
}