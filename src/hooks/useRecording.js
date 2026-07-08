import { useState, useRef, useCallback, useEffect } from 'react';

export function useRecording() {
  const [recordingUrl, setRecordingUrl] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const videoStreamRef = useRef(null);
  const audioStreamRef = useRef(null);
  const fallbackTimerRef = useRef(null);
  const recordingRef = useRef(false);

  const startRecording = useCallback((videoStream, audioStream) => {
    if (recordingRef.current) return;

    // Combine video + audio (if available) into a single MediaStream
    const tracks = [...videoStream.getVideoTracks()];
    if (audioStream) {
      tracks.push(...audioStream.getAudioTracks());
    }
    const combined = new MediaStream(tracks);

    // Choose the best supported codec — prefer vp9+opus, fall back gracefully
    const mimeTypes = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const mimeType = mimeTypes.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';

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
          const blob = new Blob(chunksRef.current, { type: 'video/webm' });
          const url = URL.createObjectURL(blob);
          setRecordingUrl(url);
        }
        chunksRef.current = [];
      };
      recorder.start(1000); // Flush chunks every 1s
      recorderRef.current = recorder;
      recordingRef.current = true;
      setIsRecording(true);
    } catch (_e) {
      // MediaRecorder unsupported — recording silently skipped
    }
  }, []);

  const tryStart = useCallback(() => {
    if (recordingRef.current) return;
    const video = videoStreamRef.current;
    if (!video) return;

    const audio = audioStreamRef.current;
    // Wait for both video AND audio before starting — ensures recording has audio
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
    // Fallback: if no audio arrives within 3s (e.g. no voice mode selected),
    // start recording with video only so the user still gets a recording
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

  return { recordingUrl, isRecording, setVideoStream, setAudioStream, stop, clear };
}