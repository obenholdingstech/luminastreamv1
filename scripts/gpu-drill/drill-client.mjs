// GPU drill — the measuring client (Mac side). Produces the numbers the CEO
// asked for: what the server-hop topology COSTS (transport tax, measured) and
// what it BUYS (true motion-compensated ~57fps, downloadable to the eye).
//
//   node scripts/gpu-drill/drill-client.mjs
//
// Needs out/pod.json from provision.sh and out/source.webm from
// capture-source.mjs. All artifacts land in scripts/gpu-drill/out/.

import { readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const OUT = 'scripts/gpu-drill/out';
const pod = JSON.parse(readFileSync(`${OUT}/pod.json`, 'utf8'));
const base = `http://${pod.ip}:${pod.port}`;
const H = { 'X-Drill-Token': pod.token };

const q = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length * p)];
const stats = (arr) => ({
  p50: Math.round(q(arr, 0.5) * 10) / 10,
  p95: Math.round(q(arr, 0.95) * 10) / 10,
  n: arr.length,
});

// ---- 1. transport: RTT and frame-sized round trips over ONE persistent WS
console.log('[drill] transport measure —', base);
const ws = new WebSocket(`ws://${pod.ip}:${pod.port}/ws?token=${pod.token}`);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('ws failed to open'));
});

const rtts = [];
for (let i = 0; i < 60; i++) {
  const t0 = performance.now();
  ws.send(`ping-${i}`);
  await new Promise((res) => (ws.onmessage = res));
  rtts.push(performance.now() - t0);
}

// 120KB synthetic payload ≈ one 720p JPEG frame (no local ffmpeg to cut a
// real one; the wire does not care about pixel content, and the label is
// honest about what was sent).
const frame = new Uint8Array(120_000);
crypto.getRandomValues(frame.subarray(0, 65536));
const frameTrips = [];
for (let i = 0; i < 40; i++) {
  const t0 = performance.now();
  ws.send(frame);
  await new Promise((res) => (ws.onmessage = res));
  frameTrips.push(performance.now() - t0);
}
ws.close();
const transport = { rttMs: stats(rtts), frameRoundTripMs: stats(frameTrips), payloadBytes: frame.length };
console.log('[drill] transport:', JSON.stringify(transport));

// ---- 2. the clip goes up
console.log('[drill] uploading source clip');
const clip = readFileSync(`${OUT}/source.webm`);
const fd = new FormData();
fd.append('file', new Blob([clip], { type: 'video/webm' }), 'source.webm');
const clipRes = await (await fetch(`${base}/clip`, { method: 'POST', headers: H, body: fd })).json();
console.log('[drill] clip:', JSON.stringify(clipRes));

// ---- 3. pure synthesis cost on the GPU
console.log('[drill] bench (pure model inference)');
const bench = await (await fetch(`${base}/bench`, { method: 'POST', headers: H })).json();
console.log('[drill] bench:', JSON.stringify(bench));

// ---- 4. the artifact: multiply the real 19fps by 3 → ~57fps
console.log('[drill] interpolate ×3 (this is the long step)');
const interp = await (
  await fetch(`${base}/interpolate?multi=3`, { method: 'POST', headers: H })
).json();
console.log('[drill] interpolate:', JSON.stringify(interp));

// ---- 5. bring everything home
for (const name of ['source.mp4', 'interpolated.mp4', 'side-by-side.mp4', 'timings.json']) {
  const res = await fetch(`${base}/artifact/${name}`, { headers: H });
  if (!res.ok) {
    console.log(`[drill] artifact ${name}: HTTP ${res.status} (skipped)`);
    continue;
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${OUT}/${name}`));
  console.log(`[drill] downloaded ${name}`);
}

// ---- 6. the verdict arithmetic, from measured parts
const lookaheadMs = 1000 / 19; // interpolation needs the NEXT frame: one real-frame interval
const synthMs = bench.ok ? bench.p50_ms : interp.ms_per_output_frame_incl_io;
const addedMs = lookaheadMs + transport.frameRoundTripMs.p50 + synthMs;
const summary = {
  gpu: bench.gpu ?? 'see health',
  method: interp.method,
  transport,
  synthesis: bench,
  interpolation: interp,
  latencyTax: {
    lookaheadMs: Math.round(lookaheadMs * 10) / 10,
    frameRoundTripP50Ms: transport.frameRoundTripMs.p50,
    synthesisP50Ms: synthMs,
    totalAddedP50Ms: Math.round(addedMs * 10) / 10,
    note: 'added to the video path in a server-hop topology; converted mode absorbs part of it inside the existing elastic hold, Direct mode pays it in full',
  },
};
writeFileSync(`${OUT}/drill-summary.json`, JSON.stringify(summary, null, 2));
console.log('\nDRILL SUMMARY\n' + JSON.stringify(summary, null, 2));
