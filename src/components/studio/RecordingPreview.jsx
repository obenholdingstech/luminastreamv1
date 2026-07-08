import { X, Download } from 'lucide-react';

export default function RecordingPreview({ recordingUrl, onClose, onDownload }) {
  if (!recordingUrl) return null;

  return (
    <div className="absolute bottom-6 right-6 z-50 w-96 bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg overflow-hidden shadow-2xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1A1A2E]">
        <span className="text-[11px] font-medium tracking-widest text-white uppercase">Last Recording</span>
        <div className="flex items-center gap-3">
          <button
            onClick={onDownload}
            className="text-[#10B981] hover:text-[#10B981]/80 transition"
            title="Download"
          >
            <Download size={16} />
          </button>
          <button
            onClick={onClose}
            className="text-[#64748B] hover:text-white transition"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
      </div>
      <video
        src={recordingUrl}
        controls
        autoPlay
        className="w-full max-h-[240px] bg-black"
      />
    </div>
  );
}