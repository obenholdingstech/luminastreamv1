// The P2b gating probe. Run: npm run probe:decart   (NEVER part of npm run e2e)
//
// THE QUESTION (ROADMAP §P2, the committed topology's wall #2): does Decart's
// `constraints.realtime.maxSessionDuration` cut a RUNNING session, or does it
// only gate new ones? The docs are silent; the answer calibrates how much
// weight the token constraint can carry as defense in depth.
//
// THIS IS AN EXPERIMENT, NOT A TEST OF DECART. It records the observed
// behaviour either way and only fails on instrumentation errors — a vendor
// behaving "badly" is a RESULT here, not a failure. The verdict lands in
// test-results/decart-probe.json and gets logged to devlog same-day.
//
// SPEND: one reservation of PROBE_GRANT_SECONDS (30 s ≈ $0.60 at the verified
// $0.02/s), taken through the ledger like any other spend, settled with the
// observed generation seconds afterwards. The wall meters its own probe.

import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

const API =
  process.env.E2E_API_BASE || 'https://luminastream-api.obenholdingsltd.workers.dev';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const PROBE_GRANT_SECONDS = 30;
// Watch to 2.5× the cap: long enough that "not enforced" is a conclusion,
// short enough that a runaway probe costs cents. The token grant bounds what
// we WANT to spend; this bounds what the probe will sit around observing.
const WATCH_SECONDS = 75;

test.skip(
  !process.env.E2E_DECART_PROBE,
  'vendor-spending probe — run explicitly via npm run probe:decart',
);

test('PROBE: does maxSessionDuration cut a running Lucy session?', async ({ page }) => {
  test.setTimeout((WATCH_SECONDS + 60) * 1000);
  expect(PASSWORD, 'E2E_ADMIN_PASSWORD must be set (npm run probe:decart wires it)').toBeTruthy();

  // ── mint through OUR wall: admin session → reserve-bound client token ──
  const adminRes = await fetch(`${API}/api/admin/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  }).then((r) => r.json());
  expect(adminRes.ok, 'admin verify').toBeTruthy();

  const grant = await fetch(`${API}/api/video/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminRes.token },
    body: JSON.stringify({ requestedSeconds: PROBE_GRANT_SECONDS }),
  }).then((r) => r.json());
  expect(grant.ok, `token mint: ${JSON.stringify(grant)}`).toBeTruthy();
  expect(grant.grantedSeconds).toBe(PROBE_GRANT_SECONDS);

  // ── the instrumented session, in a real browser with a fake camera ──
  // Everything after the reserve runs under a finally that settles: a probe
  // that crashes mid-watch must not leave its hold to the reaper — the wall
  // meters its own probe, including the failed runs.
  await page.goto('about:blank');
  let observed = { fatal: 'probe crashed before observation', lastTickSeconds: 0, log: [] };
  let settleOutcome = null;
  try {
  observed = await page.evaluate(
    async ({ clientToken, watchMs }) => {
      const log = [];
      const t0 = Date.now();
      const mark = (event, extra) =>
        log.push({ atMs: Date.now() - t0, event, ...(extra ?? {}) });

      // Probe-only pragmatism: the SDK arrives via CDN because this page is a
      // scratch document, not the product. The product integration (P2c) uses
      // the pinned npm dependency.
      const sdk = await import('https://esm.sh/@decartai/sdk');
      const createDecartClient = sdk.createDecartClient ?? sdk.default?.createDecartClient;
      if (!createDecartClient) return { fatal: 'SDK shape: createDecartClient not found' };

      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const client = createDecartClient({ apiKey: clientToken });

      let lastTickSeconds = 0;
      let ended = null;

      const models = ['lucy-2.5', 'lucy-2.1', 'lucy_v2_5'];
      let rt = null;
      let modelUsed = null;
      for (const model of models) {
        try {
          rt = await client.realtime.connect(stream, {
            model,
            onRemoteStream: () => mark('remoteStream'),
          });
          modelUsed = model;
          mark('connected', { model });
          break;
        } catch (err) {
          mark('connectError', { model, message: String(err?.message ?? err).slice(0, 200) });
        }
      }
      if (!rt) return { fatal: 'no model id accepted', log };

      // A probe that cannot hear MUST NOT conclude. If the SDK exposes no
      // listener surface, "observed nothing" would masquerade as "session
      // never ended" — instrumentation failure laundered into a NOT-ENFORCED
      // verdict. Fatal instead.
      if (typeof rt.on !== 'function') {
        try { rt.disconnect?.(); } catch {}
        return { fatal: 'SDK session exposes no .on() — cannot instrument', log };
      }
      rt.on('connectionChange', (state) => {
        mark('connectionChange', { state });
        if (state === 'disconnected') ended = ended ?? Date.now() - t0;
      });
      rt.on('generationTick', (tick) => {
        lastTickSeconds = tick?.seconds ?? lastTickSeconds;
      });
      rt.on('error', (err) =>
        mark('sdkError', { message: String(err?.message ?? err).slice(0, 200) }),
      );

      // Watch. Either the session dies (enforced) or the window elapses.
      // Tick progress is sampled sparsely (every 10 s) so the event log keeps
      // its connection/error events instead of drowning them in samples —
      // slice(-40) once discarded exactly the events the verdict reads.
      const deadline = t0 + watchMs;
      let lastSampleAt = 0;
      while (Date.now() < deadline && ended === null) {
        await new Promise((r) => setTimeout(r, 1000));
        if (Date.now() - lastSampleAt >= 10_000) {
          lastSampleAt = Date.now();
          mark('tickSample', { lastTickSeconds });
        }
      }
      try {
        rt.disconnect?.();
      } catch {}
      return { modelUsed, endedAtMs: ended, lastTickSeconds, log };
    },
    { clientToken: grant.clientToken, watchMs: WATCH_SECONDS * 1000 },
  );

  } finally {
    // ── settle honestly with what was observed — crash or not — and CHECK
    // the response: an unverified settle could silently leave the hold to
    // the reaper and the verdict would not say so.
    const used = Math.min(Math.ceil(observed.lastTickSeconds ?? 0), PROBE_GRANT_SECONDS);
    settleOutcome = await fetch(`${API}/api/video/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminRes.token },
      body: JSON.stringify({
        reservationId: grant.reservationId,
        settleToken: grant.settleToken,
        usedSeconds: used,
      }),
    })
      .then(async (r) => ({ status: r.status, ...(await r.json()) }))
      .catch((err) => ({ status: 0, ok: false, error: String(err).slice(0, 120) }));
  }

  expect(observed.fatal, observed.fatal ?? '').toBeFalsy();
  expect(settleOutcome?.ok, `settle must succeed: ${JSON.stringify(settleOutcome)}`).toBeTruthy();

  const enforced =
    observed.endedAtMs !== null &&
    observed.endedAtMs >= (PROBE_GRANT_SECONDS - 5) * 1000 &&
    observed.endedAtMs <= (PROBE_GRANT_SECONDS + 20) * 1000;
  const verdict = {
    question: 'does maxSessionDuration cut a RUNNING session?',
    maxSessionDuration: PROBE_GRANT_SECONDS,
    modelUsed: observed.modelUsed,
    sessionEndedAtMs: observed.endedAtMs,
    lastGenerationTickSeconds: observed.lastTickSeconds,
    watchedForMs: WATCH_SECONDS * 1000,
    verdict: enforced
      ? 'ENFORCED — the running session was cut at the constraint'
      : observed.endedAtMs === null
        ? 'NOT ENFORCED at runtime — session outlived the constraint for the whole watch window'
        : `ended at ${observed.endedAtMs}ms — outside the enforcement band; read the log`,
    ledgerSettle: settleOutcome,
    recordedAt: new Date().toISOString(),
    log: observed.log,
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/decart-probe.json', JSON.stringify(verdict, null, 2));
  console.log('\n════ DECART PROBE VERDICT ════');
  console.log(JSON.stringify({ ...verdict, log: `${verdict.log?.length ?? 0} events` }, null, 2));
});
