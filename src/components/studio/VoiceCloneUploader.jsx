import { useState, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Upload, Loader2, AlertCircle, Check } from 'lucide-react';

export default function VoiceCloneUploader({ onVoiceCloned, disabled }) {
  const [name, setName] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  // Convert an AudioBuffer to a WAV Blob (16-bit PCM)
  function audioBufferToWav(buffer) {
    const numChannels = 1;
    const sampleRate = buffer.sampleRate;
    const bitDepth = 16;
    const channelData = buffer.getChannelData(0);
    const dataLength = channelData.length * (bitDepth / 8);
    const headerLength = 44;
    const totalLength = headerLength + dataLength;
    const arrayBuffer = new ArrayBuffer(totalLength);
    const view = new DataView(arrayBuffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, totalLength - 8, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
    view.setUint16(32, numChannels * (bitDepth / 8), true);
    view.setUint16(34, bitDepth, true);
    writeStr(36, 'data');
    view.setUint32(40, dataLength, true);

    let offset = 44;
    for (let i = 0; i < channelData.length; i++) {
      const s = Math.max(-1, Math.min(1, channelData[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  const handleFile = async (file) => {
    if (!file) return;
    setError(null);

    try {
      let audioBlob = file;

      // If video, extract audio using Web Audio API
      if (file.type.startsWith('video/')) {
        setStatus('extracting');
        const arrayBuffer = await file.arrayBuffer();
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        audioBlob = audioBufferToWav(audioBuffer);
        ctx.close();
      }

      // Upload — convert Blob to a named File (UploadFile integration requires a File, not a raw Blob)
      setStatus('uploading');
      const fileToUpload = audioBlob instanceof File
        ? audioBlob
        : new File([audioBlob], 'reference.wav', { type: 'audio/wav' });
      const uploadRes = await base44.integrations.Core.UploadFile({ file: fileToUpload });
      if (!uploadRes?.file_url) throw new Error('Upload failed');

      // Clone the voice via backend
      const cloneRes = await base44.functions.invoke('cloneVoice', {
        audioUrl: uploadRes.file_url,
        name: name.trim() || `voice_${Date.now()}`,
      });

      if (cloneRes.data?.voiceId) {
        setStatus('success');
        onVoiceCloned?.(cloneRes.data.voiceId);
        setTimeout(() => setStatus('idle'), 3000);
      } else {
        throw new Error(cloneRes.data?.error || 'Cloning failed');
      }
    } catch (err) {
      setError(err.message || 'Voice cloning failed');
      setStatus('error');
    }
  };

  const isWorking = status === 'extracting' || status === 'uploading';

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Voice name (optional)"
        disabled={disabled || isWorking}
        className="w-full bg-[#13131F] border border-[#2A2A3E] rounded-md px-3 py-2 text-sm text-white placeholder:text-[#4A5568] focus:outline-none focus:border-[#6366F1] transition disabled:opacity-50"
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,video/*"
        onChange={(e) => handleFile(e.target.files?.[0])}
        disabled={disabled || isWorking}
        className="hidden"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled || isWorking}
        className="w-full py-2.5 bg-[#13131F] border border-dashed border-[#2A2A3E] hover:border-[#6366F1] rounded-md text-xs text-[#64748B] hover:text-white transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {status === 'extracting' ? (
          <><Loader2 size={14} className="animate-spin" /> Extracting audio…</>
        ) : status === 'uploading' ? (
          <><Loader2 size={14} className="animate-spin" /> Cloning voice…</>
        ) : status === 'success' ? (
          <><Check size={14} className="text-[#10B981]" /> Voice cloned!</>
        ) : (
          <><Upload size={14} /> Upload Voice Sample</>
        )}
      </button>
      <p className="text-[10px] text-[#4A5568] leading-relaxed">
        Upload an MP3 or video file. Audio is extracted from video automatically. Max 5 voices per account.
      </p>
      {status === 'error' && (
        <div className="flex items-start gap-2 text-[10px] text-red-400">
          <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}