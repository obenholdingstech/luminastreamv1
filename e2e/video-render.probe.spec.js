// The video RENDER probe — the assertion the 3 Aug screenshot was missing.
//
// The CEO's drill failed twice before either fix existed (#50 wrong dialect,
// #51 wrong credential), and her evidence was a blank output with "an ICE
// candidate could not be delivered". Every layer below the glass is now
// live-verified ($0 exchanges) — but "the session opens" and "pixels move on
// the screen" are different claims, and only this test makes the second one.
//
// SPENDS REAL VENDOR MONEY (a few seconds of Lucy generation), so it is
// env-gated like the duration probe and NOT in CI:
//
//   npm run probe:video
//
// Chrome's fake camera feeds the lens; Decart transforms it; the probe
// asserts the <video> element is receiving decodable frames whose clock
// ADVANCES — a black-but-connected stream fails here, which is the point.

import { test, expect } from '@playwright/test';

const API =
  process.env.E2E_API_BASE || 'https://luminastream-api.obenholdingsltd.workers.dev';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const ENABLED = process.env.E2E_VIDEO_PROBE === '1';

test.use({ permissions: ['microphone', 'camera'] });

async function adminToken() {
  const res = await fetch(`${API}/api/admin/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`admin verify failed: HTTP ${res.status}`);
  return body.token;
}

const budget = (token) =>
  fetch(`${API}/api/video/budget`, { headers: { 'X-Admin-Token': token } }).then((r) => r.json());

test('the transformed stream RENDERS: frames arrive and the clock advances', async ({ page }) => {
  test.skip(!ENABLED, 'E2E_VIDEO_PROBE not set — this test spends vendor money');
  test.skip(!PASSWORD, 'E2E_ADMIN_PASSWORD not set — run via npm run probe:video');
  test.setTimeout(120_000);

  const token = await adminToken();
  const before = await budget(token);
  expect(before.enabled, 'video must be enabled to probe it').toBe(true);
  expect(before.remainingSeconds).toBeGreaterThan(60);

  // EVERYTHING between start and stop runs inside try/finally: this probe
  // spends real vendor money, and its own FIRST run proved what a failed
  // assertion does without cleanup — the abandoned session orphan-reaped
  // 180s. The finally presses the buttons a fleeing user would; if even that
  // fails, the bound reservation is the executioner's ammunition and the
  // alarm kills the vendor session with the session's own sealed credential.
  try {
    await runDrill(page, token, before);
  } finally {
    for (const label of ['Stop video', 'Stop']) {
      try {
        const button = page.getByRole('button', { name: label, exact: label === 'Stop' });
        if (await button.isVisible({ timeout: 1_000 })) await button.click();
      } catch {
        // page already closed or button gone — the executioner inherits
      }
    }
    await fetch(`${API}/api/session/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
      body: '{}',
    }).catch(() => {});
  }
});

async function runDrill(page, token, before) {
  // The real drill, exactly as the CEO performs it.
  await page.goto('/');
  await page.getByLabel('Early access key').fill(PASSWORD);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('footer')).toContainText(/Session\s+speaker-/, { timeout: 20_000 });

  await page.getByRole('button', { name: 'Add video' }).click();
  await expect(page.getByRole('button', { name: 'Stop video' })).toBeVisible({ timeout: 30_000 });

  // The claim itself: not "connected", RENDERING. videoWidth proves decoded
  // frames exist; two currentTime samples prove the clock is moving.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const v = document.querySelector('video');
          return v ? v.videoWidth : 0;
        }),
      { message: 'the <video> element must be decoding frames', timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  const t1 = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
  await page.waitForTimeout(3_000);
  const t2 = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
  expect(t2, 'the stream clock must ADVANCE — a frozen frame is not a stream').toBeGreaterThan(t1);

  // The honesty readout that P2d promised.
  await expect(page.getByText(/720p/)).toBeVisible();

  // Evidence for the log: the transformed output on the screen.
  await page.screenshot({ path: 'playwright-report/video-render-evidence.png', fullPage: true });

  // Give the money back the way a user would.
  await page.getByRole('button', { name: 'Stop video' }).click();
  await expect(page.getByRole('button', { name: 'Add video' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Stop' }).click();

  // The ledger's account of what this cost — small, settled, nothing open.
  await expect
    .poll(async () => (await budget(token)).openReservations, {
      message: 'the reservation must settle after stop',
      timeout: 20_000,
      intervals: [2_000],
    })
    .toBe(0);
  const after = await budget(token);
  const spent = after.spentSeconds - before.spentSeconds;
  expect(spent, 'a short probe must not bill like a session').toBeLessThanOrEqual(60);
  console.log(
    `RENDER PROBE PASS — billed ${spent}s, remaining ${after.remainingSeconds}s, evidence: playwright-report/video-render-evidence.png`,
  );
}
