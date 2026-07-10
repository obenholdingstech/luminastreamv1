import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Mic, Loader2, Check, ChevronDown, Cpu } from 'lucide-react';

export default function VoiceUploader({ selectedVoiceId, onSelectVoice, voiceState, voiceError, disabled, refreshTrigger }) {
  const [voices, setVoices] = useState([]);
  const [backend, setBackend] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Determine which voice backend is active
  useEffect(() => {
    base44.functions
      .invoke('getVoiceConfig', {})
      .then((res) => setBackend(res.data?.backend || 'elevenlabs'))
      .catch(() => setBackend('elevenlabs'));
  }, []);

  // Load voices whenever backend is known or refresh is triggered
  useEffect(() => {
    if (!backend) return;
    loadVoices();
  }, [backend, refreshTrigger]);

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
    setLoading(true);
    try {
      const fn = backend === 'rvc' ? 'listRvcModels' : 'listVoices';
      const res = await base44.functions.invoke(fn, {});
      setVoices(res.data?.voices || []);
    } catch (_err) {
      setLoadError('Failed to load voices');
    }
    setLoading(false);
  };

  const selectedVoice = voices.find((v) => v.voiceId === selectedVoiceId);
  const isRvc = backend === 'rvc';

  const handleSelect = (voice) => {
    onSelectVoice(voice.voiceId);
    setIsOpen(false);
  };

  return (
    <div className="space-y-2">
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
                {isRvc ? <Cpu size={14} className="text-[#6366F1] flex-shrink-0" /> : <Mic size={14} className="text-[#6366F1] flex-shrink-0" />}
                <span className="truncate">{selectedVoice.name}</span>
              </>
            ) : (
              <>
                {isRvc ? <Cpu size={14} className="flex-shrink-0" /> : <Mic size={14} className="flex-shrink-0" />}
                {isRvc ? 'Select a voice model' : 'Select a voice'}
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
                    {isRvc ? <Cpu size={12} className="text-[#64748B] flex-shrink-0" /> : <Mic size={12} className="text-[#64748B] flex-shrink-0" />}
                    <div className="min-w-0">
                      <p className="text-white truncate">{voice.name}</p>
                      {isRvc ? (
                        <div className="flex items-center gap-2">
                          {voice.active && (
                            <span className="text-[9px] text-[#10B981] uppercase tracking-wider font-medium">● Active</span>
                          )}
                          {!voice.hasIndex && (
                            <span className="text-[9px] text-[#F59E0B] uppercase tracking-wider">no index</span>
                          )}
                          {voice.sampleRate && (
                            <span className="text-[9px] text-[#64748B] uppercase tracking-wider">{voice.sampleRate}Hz</span>
                          )}
                        </div>
                      ) : voice.category === 'cloned' ? (
                        <span className="text-[9px] text-[#10B981] uppercase tracking-wider font-medium">★ Cloned</span>
                      ) : voice.category ? (
                        <p className="text-[9px] text-[#64748B] uppercase tracking-wider">{voice.category}</p>
                      ) : null}
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

      {loadError && <p className="text-[10px] text-red-400">{loadError}</p>}
      {voiceError && (
        <p className="text-[10px] text-red-400 leading-relaxed">{voiceError}</p>
      )}
    </div>
  );
}