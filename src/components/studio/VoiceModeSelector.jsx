import { Mic, Waves } from 'lucide-react';

export default function VoiceModeSelector({ mode, onModeChange, disabled }) {
  return (
    <div className="flex gap-2">
      <button
        onClick={() => !disabled && onModeChange('direct')}
        disabled={disabled}
        className={`flex-1 py-2.5 text-xs rounded-md border transition flex items-center justify-center gap-2 ${
          mode === 'direct'
            ? 'bg-[#6366F1]/10 border-[#6366F1] text-white'
            : 'bg-[#13131F] border-[#2A2A3E] text-[#64748B] hover:border-[#3A3A4E]'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <Mic size={14} />
        Direct Voice
      </button>
      <button
        onClick={() => !disabled && onModeChange('converted')}
        disabled={disabled}
        className={`flex-1 py-2.5 text-xs rounded-md border transition flex items-center justify-center gap-2 ${
          mode === 'converted'
            ? 'bg-[#6366F1]/10 border-[#6366F1] text-white'
            : 'bg-[#13131F] border-[#2A2A3E] text-[#64748B] hover:border-[#3A3A4E]'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <Waves size={14} />
        Converted Voice
      </button>
    </div>
  );
}