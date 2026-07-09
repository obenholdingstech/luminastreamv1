// OpenVoiceChanger WebSocket client helpers
// Protocol: https://github.com/sioaeko/OpenVoiceChanger
//
// Binary frame format: [uint32 seq_num][uint32 reserved][float32[] PCM samples]
// - seq_num: sequence number (little-endian)
// - reserved: 0 on send; on receive, carries server processing time in hundredths of a millisecond
// - PCM: float32 samples at the negotiated sample rate (44100Hz)

/**
 * Create a binary audio frame for sending to the OVC server.
 * @param {number} seqNum — sequence number
 * @param {Float32Array} samples — PCM float32 samples
 * @returns {ArrayBuffer} binary frame
 */
export function createOvcFrame(seqNum, samples) {
  const buffer = new ArrayBuffer(8 + samples.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, seqNum, true); // seq_num (little-endian)
  view.setUint32(4, 0, true); // reserved (0 on send)
  new Float32Array(buffer, 8).set(samples);
  return buffer;
}

/**
 * Parse a binary audio frame received from the OVC server.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ seqNum: number, processingTime: number, samples: Float32Array }}
 */
export function parseOvcFrame(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const seqNum = view.getUint32(0, true);
  const processingTime = view.getUint32(4, true); // hundredths of a millisecond
  const sampleCount = (arrayBuffer.byteLength - 8) / 4;
  const samples = new Float32Array(arrayBuffer, 8, sampleCount);
  return { seqNum, processingTime, samples };
}

/**
 * Connect to an OpenVoiceChanger WebSocket server.
 * @param {string} url — e.g. 'wss://server/ws/audio'
 * @param {Object} handlers
 * @param {Function} handlers.onAudio — (samples: Float32Array, processingTime: number) => void
 * @param {Function} handlers.onStatus — (status: Object) => void
 * @param {Function} handlers.onOpen — () => void
 * @param {Function} handlers.onClose — () => void
 * @param {Function} handlers.onError — (error: Event) => void
 * @param {number} sampleRate — e.g. 44100
 * @param {number} chunkSize — e.g. 4096
 * @returns {WebSocket}
 */
export function connectOvc(url, { onAudio, onStatus, onOpen, onClose, onError }, sampleRate = 44100, chunkSize = 4096) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    // Send initial config — tells the server our sample rate and chunk size
    ws.send(JSON.stringify({ sample_rate: sampleRate, chunk_size: chunkSize }));
    onOpen?.();
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      // JSON status message
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'status') onStatus?.(msg);
      } catch (_e) {
        // Ignore malformed JSON
      }
    } else {
      // Binary audio frame
      const { samples, processingTime } = parseOvcFrame(event.data);
      onAudio?.(samples, processingTime);
    }
  };

  ws.onclose = () => onClose?.();
  ws.onerror = (err) => onError?.(err);

  return ws;
}