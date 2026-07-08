import { useState, useRef, useCallback, useEffect } from 'react';

export function useRecording() {
  const [recordingUrl, setRecordingUrl] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [fileExtension, setFileExtension] = useState('webm');

  const videoElRef = useRef(null);
  const audioStreamRef = useRef(null);
  const canvasRef = useRef(null);
  const drawRafRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const fallbackTimerRef = useRef(null);
  const loadedDataHandlerRef = useRef(null);
  const recordingRef = useRef(false);

  // Draw video frames to canvas via requestAnimationFrame — runs continuously
  // while recording, producing a live video stream from the canvas
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoElRef.current;
    if (!canvas || !video) {
      drawRafRef.current = requestAnimationFrame(drawFrame);
      return;
    }
    const ctx = canvas.getContext('2d');
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
    drawRafRef.current = requestAnimationFrame(drawFrame);
  }, []);

  const startRecording = useCallback(() => {
    if (recordingRef.current) return;
    const videoEl = videoElRef.current;
    if (!videoEl || videoEl.videoWidth === 0) return;

    // Create canvas at the video's NATIVE resolution for high-quality capture
    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    canvasRef.current = canvas;

    // Start the draw loop — pumps video frames into the canvas
    drawRafRef.current = requestAnimationFrame(drawFrame);

    // Capture canvas as a 30fps video stream (standard MediaStream, not WebRTC)
    const canvasStream = canvas.captureStream(30);

    // Combine canvas video track + audio track
    const tracks = [...canvasStream.getVideoTracks()];
    const audio = audioStreamRef.current;
    if (audio) tracks.push(...audio.getAudioTracks());
    const combined = new MediaStream(tracks);

    // Pick the best supported codec — prefer MP4 (H.264 + AAC) for universal compatibility
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
    const isMp4 = mimeType.includes('mp4');

    try {
      chunksRef.current = [];
      const recorder = new MediaRecorder(combined, {
        mimeType,
        videoBitsPerSecond: 8000000, // 8 Mbps — high quality
        audioBitsPerSecond: 128000,
      });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        // Stop the draw loop
        if (drawRafRef.current) {
          cancelAnimationFrame(drawRafRef.current);
          drawRafRef.current = null;
        }
        if (chunksRef.current.length > 0) {
          const blobType = isMp4 ? 'video/mp4' : 'video/webm';
          const blob = new Blob(chunksRef.current, { type: blobType });
          setFileExtension(isMp4 ? 'mp4' : 'webm');
          setRecordingUrl(URL.createObjectURL(blob));
        }
        chunksRef.current = [];
        canvasRef.current = null;
      };
      recorder.start(1000); // Flush chunks every 1s
      recorderRef.current = recorder;
      recordingRef.current = true;
      setIsRecording(true);
    } catch (_e) {
      if (drawRafRef.current) {
        cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }
      canvasRef.current = null;
    }
  }, [drawFrame]);

  const tryStart = useCallback(() => {
    if (recordingRef.current) return;
    const videoEl = videoElRef.current;
    if (!videoEl || videoEl.videoWidth === 0) return;
    const audio = audioStreamRef.current;
    if (!audio) return;
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    startRecording();
  }, [startRecording]);

  // Accept the video ELEMENT (not the stream) — we draw from it to a canvas
  const setVideoElement = useCallback((videoEl) => {
    if (!videoEl) return;
    videoElRef.current = videoEl;

    // Remove any previous loadeddata listener
    if (loadedDataHandlerRef.current) {
      videoElRef.current?.removeEventListener('loadeddata', loadedDataHandlerRef.current);
      loadedDataHandlerRef.current = null;
    }

    if (videoEl.videoWidth > 0) {
      tryStart();
    } else {
      // Video element has the stream but hasn't decoded a frame yet — wait
      const onLoaded = () => {
        videoEl.removeEventListener('loadeddata', onLoaded);
        loadedDataHandlerRef.current = null;
        tryStart();
      };
      loadedDataHandlerRef.current = onLoaded;
      videoEl.addEventListener('loadeddata', onLoaded);
    }

    // Fallback: start after 3s even if audio never arrives (video-only recording)
    if (!fallbackTimerRef.current) {
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null;
        if (!recordingRef.current && videoElRef.current && videoElRef.current.videoWidth > 0) {
          startRecording();
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
    if (drawRafRef.current) {
      cancelAnimationFrame(drawRafRef.current);
      drawRafRef.current = null;
    }
    if (loadedDataHandlerRef.current && videoElRef.current) {
      videoElRef.current.removeEventListener('loadeddata', loadedDataHandlerRef.current);
      loadedDataHandlerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop(); } catch (_e) {}
    }
    recorderRef.current = null;
    recordingRef.current = false;
    videoElRef.current = null;
    audioStreamRef.current = null;
    canvasRef.current = null;
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
      if (drawRafRef.current) cancelAnimationFrame(drawRafRef.current);
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try { recorderRef.current.stop(); } catch (_e) {}
      }
    };
  }, []);

  return { recordingUrl, isRecording, fileExtension, setVideoElement, setAudioStream, stop, clear };
}