import { useState, useRef, useCallback, useEffect } from 'react';

export function useRecording() {
  const [recordingUrl, setRecordingUrl] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [fileExtension, setFileExtension] = useState('webm');
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const videoStreamRef = useRef(null);
  const audioStreamRef = useRef(null);
  const fallbackTimerRef = useRef(null);
  const recordingRef = useRef(false);

  const pickMimeType = useCallback(() => {
    // Prefer MP4 (H.264 + AAC) — universally recognized as a video file.
    // Fall back to WebM if the browser doesn't support MP4 recording.
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const supported = candidates.find((t) => MediaRecorder.isTypeSupported(t));
    return supported || 'video/webm';
  }, []);

  const startRecording = useCallback((videoStream, audioStream) => {
    if (recordingRef.current) return;

    const tracks = [...videoStream.getVideoTracks()];
    if (audioStream) tracks.push(...audioStream.getAudioTracks());
    const combined = new MediaStream(tracks);

    const mimeType = pickMimeType();
    const isMp4 = mimeType.includes('mp4');

    try {
      chunksRef.current = [];
      const recorder = new MediaRecorder(combined, {
        mimeType,
        videoBitsPerSecond: 4000000,
        audioBitsPerSecond: 128000,
      });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        if (chunksRef.current.length > 0) {
          const blobType = isMp4 ? 'video/mp4' : 'video/webm';
          const blob = new Blob(chunksRef.current, { type: blobType });
          const url = URL.createObjectURL(blob);
          setFileExtension(isMp4 ? 'mp4' : 'webm');
          setRecordingUrl(url);
        }
        chunksRef.current = [];
      };
      recorder.start(1000);
      recorderRef.current = recorder;
      recordingRef.current = true;
      setIsRecording(true);
    } catch (_e) {
      // MediaRecorder unsupported — recording silently skipped
    }
  }, [pickMimeType]);

  const tryStart = useCallback(() => {
    if (recordingRef.current) return;
    const video = videoStreamRef.current;
    if (!video) return;
    const audio = audioStreamRef.current;
    if (!audio) return;
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    startRecording(video, audio);
  }, [startRecording]);

  const setVideoStream = useCallback((stream) => {
    if (!stream) return;
    videoStreamRef.current = stream;
    tryStart();
    if (!recordingRef.current) {
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = setTimeout(() => {
        if (!recordingRef.current && videoStreamRef.current) {
          startRecording(videoStreamRef.current, null);
        }
      }, 3000);
    }
  }, [tryStart, startRecording]);

  const setAudioStream = useCallback((stream) => {
    if (!stream) return;
    audioStreamRef.current = stream;
    tryStart();
  }, [tryStart]);

  const stop = useCallback(() => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop(); } catch (_e) {}
    }
    recorderRef.current = null;
    recordingRef.current = false;
    videoStreamRef.current = null;
    audioStreamRef.current = null;
    setIsRecording(false);
  }, []);

  const clear = useCallback(() => {
    setRecordingUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try { recorderRef.current.stop(); } catch (_e) {}
      }
    };
  }, []);

  return { recordingUrl, isRecording, fileExtension, setVideoStream, setAudioStream, stop, clear };
}