import { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause } from 'lucide-react';

export default function VideoPlayer({ src, autoPlay = false }) {
  const videoRef = useRef(null);
  const seekBarRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => { if (!isDragging) setCurrentTime(video.currentTime); };
    const onLoadedMetadata = () => setDuration(video.duration || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, [isDragging]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play(); else video.pause();
  }, []);

  const formatTime = (s) => {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const seekToPosition = useCallback((clientX) => {
    const video = videoRef.current;
    const bar = seekBarRef.current;
    if (!video || !bar || !video.duration) return;
    const rect = bar.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    video.currentTime = percent * video.duration;
    setCurrentTime(video.currentTime);
  }, []);

  const handleSeekMouseDown = useCallback((e) => {
    setIsDragging(true);
    seekToPosition(e.clientX);
    const onMove = (ev) => seekToPosition(ev.clientX);
    const onUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [seekToPosition]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="w-full bg-black">
      <video
        ref={videoRef}
        src={src}
        autoPlay={autoPlay}
        playsInline
        className="w-full max-h-[200px] cursor-pointer object-contain"
        onClick={togglePlay}
      />
      {/* Custom controls */}
      <div className="px-3 py-2.5 bg-[#0F0F1A] space-y-2">
        {/* Seek bar — click + drag to scrub */}
        <div
          ref={seekBarRef}
          onMouseDown={handleSeekMouseDown}
          className="relative h-1.5 bg-[#2A2A3E] rounded-full cursor-pointer group hover:h-2 transition-all"
        >
          <div
            className="absolute h-full bg-[#6366F1] rounded-full"
            style={{ width: `${progress}%` }}
          />
          <div
            className="absolute h-3 w-3 bg-white rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ left: `calc(${progress}% - 6px)`, top: '-3px' }}
          />
        </div>
        {/* Play/pause + time */}
        <div className="flex items-center gap-3">
          <button
            onClick={togglePlay}
            className="text-white hover:text-white/80 transition flex-shrink-0"
          >
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <span className="text-[10px] text-[#64748B] tabular-nums">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>
      </div>
    </div>
  );
}