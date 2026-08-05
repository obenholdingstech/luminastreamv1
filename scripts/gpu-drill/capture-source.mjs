// Capture ~12s of the REAL transformed stream from production as the drill's
// source clip. The interpolation verdict must be earned on the pixels the
// product actually delivers — Lucy's faces at their true ~19fps — not on a
// synthetic clip with convenient motion.
//
// Run from the repo root (Playwright resolves from the project node_modules):
//   E2E_ADMIN_PASSWORD="$(grep -E '^ADMIN_PASSWORD=' secrets.env | head -1 | cut -d= -f2-)" \
//     node scripts/gpu-drill/capture-source.mjs scripts/gpu-drill/out/source.webm
//
// Mirrors the render probe's flow exactly (unified lens, one Start, one Stop,
// reservation settled). Records the element's srcObject directly with
// MediaRecorder — the raw delivered frames, not a screen capture of the page.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL || 'https://studio.luminastream.live';
const API = process.env.E2E_API_BASE || 'https://luminastream-api.obenholdingsltd.workers.dev';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const OUT = resolve(process.argv[2] ?? 'scripts/gpu-drill/out/source.webm');
const SECONDS = Number(process.env.CAPTURE_SECONDS ?? 12);

if (!PASSWORD) {
  console.error('E2E_ADMIN_PASSWORD missing — see the header for the invocation');
  process.exit(1);
}

const verify = await fetch(`${API}/api/admin/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
const { ok, token } = await verify.json();
if (!ok) throw new Error('admin verify failed');

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
try {
  const page = await browser.newPage({ permissions: ['microphone', 'camera'] });
  await page.goto(BASE + '/');
  await page.getByLabel('Early access key').fill(PASSWORD);
  await page.getByRole('button', { name: 'Start the lens' }).click();

  const transformed = '[data-role="transformed-stream"]';
  await page.waitForFunction(
    (sel) => (document.querySelector(sel)?.videoWidth ?? 0) > 0,
    transformed,
    { timeout: 60_000 },
  );
  console.log('transformed stream decoding — recording', SECONDS, 's');

  const b64 = await page.evaluate(
    ([sel, seconds]) =>
      new Promise((resolveDone, reject) => {
        const el = document.querySelector(sel);
        if (!el?.srcObject) return reject(new Error('no srcObject on the transformed element'));
        const chunks = [];
        const rec = new MediaRecorder(el.srcObject, {
          mimeType: 'video/webm;codecs=vp9',
          videoBitsPerSecond: 12_000_000,
        });
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.onerror = (e) => reject(e.error ?? new Error('recorder error'));
        rec.onstop = async () => {
          const blob = new Blob(chunks, { type: 'video/webm' });
          const buf = await blob.arrayBuffer();
          let s = '';
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i += 0x8000)
            s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          resolveDone(btoa(s));
        };
        rec.start(250);
        setTimeout(() => rec.stop(), seconds * 1000);
      }),
    [transformed, SECONDS],
  );

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.from(b64, 'base64'));
  console.log(`captured ${OUT} (${(Buffer.from(b64, 'base64').length / 1e6).toFixed(1)}MB)`);

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page
    .getByRole('button', { name: 'Start the lens' })
    .waitFor({ state: 'visible', timeout: 20_000 });
} finally {
  await browser.close();
  // Belt and braces: never leave a slot held by a capture script.
  await fetch(`${API}/api/session/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
    body: '{}',
  }).catch(() => {});
}
console.log('capture done, session released');
