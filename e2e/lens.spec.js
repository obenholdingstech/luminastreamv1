// The CEO's drill, automated. Run: npm run e2e
//
// Every test here is a thing a person did (or should have done) by hand on
// 2 Aug 2026, the day a manual click found a stuck slot that the entire unit
// suite could not see. The assertions are the product's promises, not the
// code's internals: the lens starts, says who holds it, stops, starts AGAIN —
// that second start is the release path, the exact path that leaked.

import { test, expect } from '@playwright/test';

const API =
  process.env.E2E_API_BASE || 'https://luminastream-api.obenholdingsltd.workers.dev';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD;

// ─── talking to the Worker directly (setup/teardown, not the thing under test) ──

async function adminToken() {
  const res = await fetch(`${API}/api/admin/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`admin verify failed: HTTP ${res.status} ${body.error ?? ''}`);
  return body.token;
}

const post = (path, token, body) =>
  fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const capacity = (token) =>
  fetch(`${API}/api/session/capacity`, { headers: { 'X-Admin-Token': token } }).then((r) =>
    r.json(),
  );

// A dirty registry would make every result a lie: a pre-existing stuck slot
// reads as "the lens is broken", and a slot this suite leaks reads as "the
// next run is broken". Reset at both ends, and ASSERT the reset worked rather
// than trusting it — a reset that silently failed would un-diagnose everything
// after it.
let token;
test.beforeAll(async () => {
  test.skip(!PASSWORD, 'E2E_ADMIN_PASSWORD not set — run via `npm run e2e`');
  token = await adminToken();
});

// EVERY test starts from an empty registry — asserted, not assumed. The first
// version reset only in beforeAll, and a test that finished while holding
// (test 1 does, deliberately: it asserts the HELD state) poisoned every test
// after it with at_capacity. The suite was recreating the exact incident it
// exists to detect, as a fixture bug.
test.beforeEach(async () => {
  await post('/api/session/reset', token);
  const cap = await capacity(token);
  expect(cap.live, 'registry must be empty before each drill step').toBe(0);
});

test.afterAll(async () => {
  // Leave production the way a good guest leaves a kitchen. This also makes
  // the suite safe to re-run immediately — including after a mid-run crash,
  // since the NEXT run's beforeAll resets whatever this one left behind.
  if (token) await post('/api/session/reset', token);
});

// ─── the drill ─────────────────────────────────────────────────────────────

async function unlockAndStart(page) {
  await page.goto('/');
  await expect(page.getByText('Lens off')).toBeVisible();
  await page.getByLabel('Early access key').fill(PASSWORD);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
}

/** The lens holds a session: the footer names the server's allocation. */
async function expectHolding(page) {
  await expect(page.locator('footer')).toContainText(/Session\s+speaker-/, { timeout: 20_000 });
  await expect(page.locator('footer')).toContainText('room');
}

test('the lens starts: a real slot, allocated by the server, visible in the UI', async ({
  page,
}) => {
  await unlockAndStart(page);

  // The client no longer chooses a room, so what the footer shows can only
  // have come from the Worker → Durable Object → pool. Seeing it IS seeing
  // the whole session layer work.
  await expectHolding(page);

  // And the server agrees the slot is held — the UI is not narrating a hope.
  const cap = await capacity(token);
  expect(cap.live).toBe(1);
  expect(cap.available).toBe(0);
});

test('stop releases the slot, and the server agrees', async ({ page }) => {
  await unlockAndStart(page);
  await expectHolding(page);

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Lens off')).toBeVisible({ timeout: 15_000 });

  // THE assertion of the whole file. A UI that says "stopped" while the
  // server still counts the slot as held is exactly the 2 Aug incident.
  await expect
    .poll(async () => (await capacity(token)).live, {
      message: 'the server must agree the slot was released',
      // Gentle intervals: /api/session/* shares a 20-req/60s per-IP limit,
      // and a tight poll would spend the whole suite's budget re-asking.
      intervals: [1000, 2000],
      timeout: 10_000,
    })
    .toBe(0);
});

test('start → stop → START AGAIN — the release path, proven by reuse', async ({ page }) => {
  // The drill step that found the incident. If any stop/unload path fails to
  // release, this second start refuses with "busy" — there is only one slot,
  // so reuse is PROOF of release, not just absence of error.
  await unlockAndStart(page);
  await expectHolding(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Lens off')).toBeVisible({ timeout: 15_000 });

  // The UI flips to "Lens off" the moment Stop is clicked; the release lands a
  // beat later. A robot can click Start-again inside that beat and correctly
  // get "busy" — a transient a human would never see and one more click cures.
  // "Released" MEANS the server agrees, so that is what reuse waits for.
  // (Known wart, deliberately accepted for now: a phase='stopping' that holds
  // the button until the release confirms is sketched for the design session.)
  await expect
    .poll(async () => (await capacity(token)).live, { intervals: [500, 1000] })
    .toBe(0);
  await page.getByRole('button', { name: 'Start the lens' }).click();
  await expectHolding(page);
  await expect(page.getByText('the lens is busy')).not.toBeVisible();

  await page.getByRole('button', { name: 'Stop' }).click();
});

test('a busy lens says so in words — and recovers when the holder releases', async ({ page }) => {
  // Somebody else holds the only slot (simulated via the API, which is what a
  // second person's browser would do). The UI must refuse in prose, keep the
  // access key exchanged (no re-login), and work the moment the slot frees.
  const held = await post('/api/session/create', token);
  expect(held.status).toBe(200);

  await unlockAndStart(page);
  await expect(page.getByText(/the lens is busy right now/)).toBeVisible({ timeout: 15_000 });

  // The other person leaves; ours retries with ONE click — the admin session
  // survived the refusal, so no password re-entry.
  await post('/api/session/end', token, {
    sessionId: held.body.sessionId,
    endToken: held.body.endToken,
  });
  await page.getByRole('button', { name: 'Start the lens' }).click();
  await expectHolding(page);
  await page.getByRole('button', { name: 'Stop' }).click();
});

test('leaving the page releases the slot — the leak of 2 Aug, pinned', async ({ page }) => {
  await unlockAndStart(page);
  await expectHolding(page);

  // A real cross-document navigation, which fires `pagehide` and lets the
  // keepalive release outlive the document — the exact path a closed tab or a
  // clicked-away user takes. (context.close() is NOT used here: an abrupt
  // teardown is not guaranteed to run pagehide handlers, so it tests the
  // browser's mood rather than our code.)
  await page.goto('about:blank');

  // Give the keepalive release its moment to land, then insist. If this row
  // ever goes red, the incident has recurred and scripts/reset-sessions.sh is
  // the stopgap while it is chased.
  await expect
    .poll(async () => (await capacity(token)).live, {
      message: 'a departed page must not hold the only slot',
      intervals: [1000, 2000],
      timeout: 15_000,
    })
    .toBe(0);
});
