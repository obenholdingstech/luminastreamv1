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
let firstTest = true;
test.beforeEach(async () => {
  // Pace between tests. /api/admin/verify allows 5/60s per IP — it is a
  // password oracle and that limit is doctrine — and every unlockAndStart
  // spends one verify. Seven-plus tests back-to-back would trip it and read
  // as product failures. The robot slows down; the control stays tight.
  if (!firstTest) await new Promise((r) => setTimeout(r, 15_000));
  firstTest = false;
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
  expect(cap.available).toBe(cap.capacity - 1);
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
  // The drill step that found the incident. Release is PROVEN by the poll
  // below — the server agreeing live===0 — not merely by the second start
  // succeeding, which a pool of more than one room would let pass anyway.
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
  // Every slot is held by somebody else (simulated via the API, which is what
  // other people's browsers would do). Capacity-agnostic on purpose: the test
  // reads the pool size from the server and fills it, so growing the pool
  // never quietly turns this into a test of nothing.
  const cap = await capacity(token);
  const held = [];
  try {
    for (let i = 0; i < cap.capacity; i += 1) {
      const h = await post('/api/session/create', token);
      expect(h.status, `filling slot ${i + 1} of ${cap.capacity}`).toBe(200);
      held.push(h.body);
    }

    await unlockAndStart(page);
    await expect(page.getByText(/the lens is busy right now/)).toBeVisible({ timeout: 15_000 });

    // One person leaves; ours retries with ONE click — the admin session
    // survived the refusal, so no password re-entry.
    await post('/api/session/end', token, {
      sessionId: held[0].sessionId,
      endToken: held[0].endToken,
    });
    await page.getByRole('button', { name: 'Start the lens' }).click();
    await expectHolding(page);
    await page.getByRole('button', { name: 'Stop' }).click();
  } finally {
    // EVERY held slot goes back, assertion failure or not. A crashed run must
    // not strand real capacity behind test sessions until the lease expires —
    // ending an already-ended session is a designed no-op, so this is safe to
    // run unconditionally.
    for (const h of held) {
      await post('/api/session/end', token, { sessionId: h.sessionId, endToken: h.endToken });
    }
  }
});

test('TWO people at once — the first multi-user moment, proven', async ({ browser }) => {
  // The point of P1c. Two separate browser contexts — two people, two
  // sessionStorages, two mics — each holds a session AT THE SAME TIME, and
  // the server hands each a DIFFERENT room, because a room with an agent in
  // it serves one speaker. Before the pool had two rooms this was impossible,
  // and this test skips rather than lies if it ever shrinks back.
  const cap = await capacity(token);
  test.skip(cap.capacity < 2, `pool capacity is ${cap.capacity} — multi-user needs 2+`);

  const ctxA = await browser.newContext({ permissions: ['microphone'] });
  const ctxB = await browser.newContext({ permissions: ['microphone'] });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  try {
    // CONCURRENT, not sequential — this is the Durable Object's entire reason
    // to exist: two Starts in the same instant must serialize inside the DO
    // and come out holding two DIFFERENT rooms. Awaiting A before starting B
    // would never exercise the overlap.
    await Promise.all([unlockAndStart(A), unlockAndStart(B)]);
    await expectHolding(A);
    await expectHolding(B);

    const roomOf = async (p) =>
      (await p.locator('footer').textContent()).match(/room\s+(\S+)/)?.[1];
    const roomA = await roomOf(A);
    const roomB = await roomOf(B);
    expect(roomA, 'each person gets their own agent-served room').not.toBe(roomB);

    const mid = await capacity(token);
    expect(mid.live).toBe(2);

    // Both leave; both slots come home.
    await A.getByRole('button', { name: 'Stop' }).click();
    await B.getByRole('button', { name: 'Stop' }).click();
    await expect
      .poll(async () => (await capacity(token)).live, { intervals: [1000, 2000], timeout: 15_000 })
      .toBe(0);
  } finally {
    // Stop is attempted while each document is still ALIVE. Closing a context
    // is not guaranteed to fire pagehide — our own leave-page test documents
    // exactly that — so a mid-test assertion failure must not strand two
    // slots for the lease. The clicks are best-effort (the happy path already
    // stopped both, so the buttons may be gone); the reset is the backstop
    // that makes "this test leaked" impossible by construction.
    for (const p of [A, B]) {
      await p
        .getByRole('button', { name: 'Stop' })
        .click({ timeout: 2000 })
        .catch(() => {});
    }
    await ctxA.close();
    await ctxB.close();
    await post('/api/session/reset', token);
  }
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
