import { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';

export default function AvatarUploader({ imagePreview, onImageSelect }) {
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState(null);

  const validateAndSet = (file) => {
    setError(null);
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('JPEG, PNG, or WebP only');
      return;
    }

    const img = new Image();
    img.onload = () => {
      if (img.width < 512 || img.height < 512) {
        setError('Minimum 512×512 resolution');
        URL.revokeObjectURL(img.src);
        return;
      }
      URL.revokeObjectURL(img.src);
      onImageSelect(file, URL.createObjectURL(file));
    };
    img.onerror = () => setError('Invalid image file');
    img.src = URL.createObjectURL(file);
  };

  return (
    <div>
      {imagePreview ? (
        <div className="relative w-full aspect-square rounded-md overflow-hidden border border-[#2A2A3E]">
          <img src={imagePreview} alt="Reference" className="w-full h-full object-cover" />
          <button
            onClick={() => onImageSelect(null, null)}
            className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 backdrop-blur-sm flex items-center justify-center text-white hover:bg-black/80 transition"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); validateAndSet(e.dataTransfer.files[0]); }}
          className={`w-full aspect-square rounded-md border border-dashed cursor-pointer flex flex-col items-center justify-center gap-2 transition ${
            dragOver ? 'border-[#6366F1] bg-[#6366F1]/5' : 'border-[#2A2A3E] hover:border-[#64748B]'
          }`}
        >
          <Upload size={24} className="text-[#64748B]" />
          <span className="text-[11px] text-[#64748B] tracking-wide">Drop image or click</span>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => validateAndSet(e.target.files[0])}
      />
      {error && <p className="text-[10px] text-red-400 mt-1.5">{error}</p>}
    </div>
  );
}