import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Mic, Loader2, Check, Play, Pause } from 'lucide-react';

export default function VoiceUploader({ selectedVoiceId, onSelectVoice, voiceState, voiceError, disabled }) {
  const [isCloning, setIsCloning] = useState(false);
  const [error, setError] = useState(null);
  const [voices, setVoices] = useState([]);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef(null);

  useEffect(() => {
    loadVoices();
  }, []);

  const loadVoices = async () => {
    try {
      const profiles = await base44.entities.VoiceProfile.filter({ status: 'ready' }, '-created_date', 20);
      setVoices(profiles);
    } catch (_e) {}
  };

  const handleFile = async (file) => {
    if (!file || !file.type.startsWith('audio/')) {
      setError('Please select an audio file (wav, mp3, etc.)');
      return;
    }
    setIsCloning(true);
    setError(null);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setPreviewUrl(file_url);
      const res = await base44.functions.invoke('cloneVoice', {
        audioUrl: file_url,
        name: file.name.replace(/\.[^/.]+$/, ''),
      });
      if (res.data?.voiceId) {
        onSelectVoice(res.data.voiceId);
        loadVoices();
      } else {
        setError(res.data?.error || 'Cloning failed');
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Cloning failed');
    }
    setIsCloning(false);
  };

  const handleInputChange = (e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    if (disabled || isCloning) return;
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

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

  const handleSelectExisting = (voiceId) => {
    setPreviewUrl(null);
    onSelectVoice(voiceId);
  };

  const selectedVoice = voices.find((v) => v.voiceId === selectedVoiceId);
  const audioSrc = previewUrl || selectedVoice?.sampleUrl;

  if (selectedVoiceId && selectedVoice) {
    return (
      <div className="space-y-2">
        <div className="bg-[#13131F] border border-[#2A2A3E] rounded-md p-3 flex items-center gap-3">
          <button
            onClick={togglePreview}
            className="w-8 h-8 rounded-full bg-[#6366F1]/20 flex items-center justify-center text-[#6366F1] hover:bg-[#6366F1]/30 transition flex-shrink-0"
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-white truncate">{selectedVoice.name}</p>
            <p className="text-[10px] text-[#64748B]">
              {voiceState === 'active' ? 'Converting live' : 'Voice ready'}
            </p>
          </div>
          <Check size={14} className="text-[#10B981] flex-shrink-0" />
        </div>
        {audioSrc && (
          <audio
            ref={audioRef}
            src={audioSrc}
            onEnded={() => setIsPlaying(false)}
            className="hidden"
          />
        )}
        {voiceError && voiceState === 'error' && (
          <p className="text-[10px] text-red-400">{voiceError}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        className={`block cursor-pointer rounded-md border border-dashed transition p-4 text-center ${
          disabled ? 'border-[#1A1A2E] opacity-50 cursor-not-allowed' : 'border-[#2A2A3E] hover:border-[#6366F1]'
        }`}
      >
        <input
          type="file"
          accept="audio/*"
          onChange={handleInputChange}
          disabled={disabled || isCloning}
          className="hidden"
        />
        {isCloning ? (
          <div className="flex items-center justify-center gap-2 text-xs text-[#64748B]">
            <Loader2 size={14} className="animate-spin" />
            Cloning voice…
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 text-xs text-[#64748B]">
            <Mic size={14} />
            Upload voice sample
          </div>
        )}
      </label>
      {error && <p className="text-[10px] text-red-400">{error}</p>}
      {voices.length > 0 && (
        <div className="space-y-1 max-h-32 overflow-y-auto custom-scrollbar">
          {voices.map((v) => (
            <button
              key={v.id}
              onClick={() => handleSelectExisting(v.voiceId)}
              disabled={disabled}
              className={`w-full text-left px-3 py-2 rounded-md text-xs transition flex items-center gap-2 ${
                selectedVoiceId === v.voiceId
                  ? 'bg-[#6366F1]/10 border border-[#6366F1] text-white'
                  : 'bg-[#13131F] border border-[#2A2A3E] text-[#64748B] hover:border-[#3A3A4E]'
              }`}
            >
              <Mic size={12} className="flex-shrink-0" />
              <span className="truncate">{v.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}