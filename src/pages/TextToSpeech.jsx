import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { Loader2, Play, Pause, Download, Volume2, ArrowLeft, Mic, ChevronDown } from 'lucide-react';

export default function TextToSpeech() {
  const [voices, setVoices] = useState([]);
  const [loadingVoices, setLoadingVoices] = useState(true);
  const [selectedVoiceId, setSelectedVoiceId] = useState('');
  const [text, setText] = useState('');
  const [generating, setGenerating] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);
  const [error, setError] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const audioRef = useRef(null);
  const dropdownRef = useRef(null);

  useEffect(() => {
    loadVoices();
  }, []);

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
      const v = res.data?.voices || [];
      setVoices(v);
      if (v.length > 0) setSelectedVoiceId(v[0].voiceId);
    } catch (_err) {
      setError('Failed to load voices');
    }
    setLoadingVoices(false);
  };

  const handleGenerate = async () => {
    if (!text.trim() || !selectedVoiceId) return;
    setGenerating(true);
    setError(null);

    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);

    try {
      const res = await base44.functions.invoke('generateSpeech', {
        text: text.trim(),
        voiceId: selectedVoiceId,
      });

      if (res.data?.audioBase64) {
        const binary = atob(res.data.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: res.data.mimeType || 'audio/mpeg' });
        setAudioUrl(URL.createObjectURL(blob));
      } else {
        setError(res.data?.error || 'Generation failed');
      }
    } catch (_err) {
      setError('Generation failed');
    }
    setGenerating(false);
  };

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
  };

  const handleDownload = () => {
    if (!audioUrl) return;
    const a = document.createElement('a');
    a.href = audioUrl;
    a.download = `tts-${Date.now()}.mp3`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const selectedVoice = voices.find((v) => v.voiceId === selectedVoiceId);

  return (
    <div className="min-h-screen bg-[#080810] text-white flex flex-col">
      {/* Header */}
      <div className="px-6 py-5 border-b border-[#1A1A2E] flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-[#64748B] hover:text-white transition">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-[13px] font-semibold tracking-[0.3em] text-white uppercase">Text to Speech</h1>
            <p className="text-[10px] tracking-widest text-[#64748B] uppercase mt-0.5">ElevenLabs Engine</p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-2xl space-y-6">
          {/* Voice selector */}
          <div>
            <label className="text-[11px] font-medium tracking-widest text-[#64748B] uppercase mb-2 block">
              Voice
            </label>
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => !loadingVoices && setIsOpen(!isOpen)}
                disabled={loadingVoices}
                className={`w-full bg-[#13131F] border rounded-md px-4 py-3 text-sm text-left transition flex items-center justify-between ${
                  isOpen ? 'border-[#6366F1]' : 'border-[#2A2A3E] hover:border-[#3A3A4E]'
                } ${loadingVoices ? 'opacity-50' : 'cursor-pointer'}`}
              >
                <span className="flex items-center gap-2 truncate">
                  {loadingVoices ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Loading voices…
                    </>
                  ) : selectedVoice ? (
                    <>
                      <Mic size={16} className="text-[#6366F1]" />
                      <span className="truncate">{selectedVoice.name}</span>
                    </>
                  ) : (
                    'Select a voice'
                  )}
                </span>
                {!loadingVoices && (
                  <ChevronDown size={16} className={`text-[#64748B] transition ${isOpen ? 'rotate-180' : ''}`} />
                )}
              </button>

              {isOpen && !loadingVoices && (
                <div className="absolute z-50 w-full mt-1 bg-[#13131F] border border-[#2A2A3E] rounded-md max-h-56 overflow-y-auto custom-scrollbar shadow-xl">
                  {voices.map((voice) => (
                    <button
                      key={voice.voiceId}
                      onClick={() => { setSelectedVoiceId(voice.voiceId); setIsOpen(false); }}
                      className={`w-full text-left px-4 py-2.5 text-xs hover:bg-[#1A1A2E] transition flex items-center justify-between ${
                        selectedVoiceId === voice.voiceId ? 'bg-[#6366F1]/10' : ''
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Mic size={12} className="text-[#64748B] flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-white truncate">{voice.name}</p>
                          {voice.category === 'cloned' ? (
                            <span className="text-[9px] text-[#10B981] uppercase tracking-wider font-medium">★ Cloned</span>
                          ) : voice.category ? (
                            <p className="text-[9px] text-[#64748B] uppercase tracking-wider">{voice.category}</p>
                          ) : null}
                        </div>
                      </div>
                      {selectedVoiceId === voice.voiceId && (
                        <span className="text-[#6366F1] text-xs">✓</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Text input */}
          <div>
            <label className="text-[11px] font-medium tracking-widest text-[#64748B] uppercase mb-2 block">
              Text
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type the text you want to convert to speech..."
              rows={6}
              className="w-full bg-[#13131F] border border-[#2A2A3E] rounded-md px-4 py-3 text-sm text-white placeholder:text-[#4A5568] focus:outline-none focus:border-[#6366F1] resize-none transition"
            />
            <p className="text-[10px] text-[#4A5568] mt-1.5">{text.length} characters</p>
          </div>

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={!text.trim() || !selectedVoiceId || generating}
            className="w-full py-3.5 bg-[#6366F1] hover:bg-[#5558E0] text-white text-sm font-medium rounded-md transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {generating ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Generating audio…
              </>
            ) : (
              <>
                <Volume2 size={16} />
                Generate Speech
              </>
            )}
          </button>

          {/* Error */}
          {error && (
            <p className="text-[11px] text-red-400 text-center">{error}</p>
          )}

          {/* Audio output */}
          {audioUrl && (
            <div className="bg-[#13131F] border border-[#2A2A3E] rounded-md p-5 space-y-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={togglePlay}
                  className="w-12 h-12 rounded-full bg-[#6366F1] hover:bg-[#5558E0] flex items-center justify-center text-white transition flex-shrink-0"
                >
                  {isPlaying ? <Pause size={20} /> : <Play size={20} />}
                </button>
                <div className="flex-1">
                  <p className="text-sm font-medium text-white">Audio Ready</p>
                  <p className="text-[10px] text-[#64748B]">Play or download your generated speech</p>
                </div>
              </div>
              <audio
                ref={audioRef}
                src={audioUrl}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                className="w-full"
                controls
              />
              <button
                onClick={handleDownload}
                className="w-full py-2.5 bg-[#10B981]/10 border border-[#10B981]/30 hover:bg-[#10B981]/20 text-[#10B981] text-sm font-medium rounded-md transition flex items-center justify-center gap-2"
              >
                <Download size={16} />
                Download MP3
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}