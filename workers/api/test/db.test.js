// Run: node --test (from workers/api)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb } from '../src/db.js';
import { createFakeD1 } from '../testkit/fakeD1.js';

const fixedDeps = () => {
  let n = 0;
  return { newId: () => `id-${++n}`, now: () => 1_754_000_000 };
};

test('user + first identity are created in ONE batch — never separable', async () => {
  const d1 = createFakeD1();
  const db = createDb(d1, fixedDeps());
  const { userId } = await db.createUserWithIdentity({
    provider: 'password',
    subject: 'ceo@example.com',
    passwordHash: 'scrypt$…',
    displayName: 'Amy',
  });
  assert.equal(userId, 'id-1');
  const batched = d1.executed.filter((e) => e.via === 'batch');
  assert.equal(batched.length, 2, 'both inserts travel in the batch');
  assert.match(batched[0].sql, /INSERT INTO users/);
  assert.match(batched[1].sql, /INSERT INTO auth_identities/);
  assert.equal(batched[1].binds[2], 'password');
  assert.equal(batched[1].binds[3], 'ceo@example.com');
  assert.equal(batched[1].binds[5], 0, 'unverified by default');
});

test('findIdentity joins the suspension check in — one query, one failure path', async () => {
  const d1 = createFakeD1({
    respond: (sql) =>
      /FROM auth_identities/.test(sql)
        ? { user_id: 'u1', password_hash: 'h', verified: 1 }
        : null,
  });
  const db = createDb(d1, fixedDeps());
  const found = await db.findIdentity('password', 'ceo@example.com');
  assert.deepEqual(found, { userId: 'u1', passwordHash: 'h', verified: true, role: 'user' });
  const q = d1.executed[0];
  assert.match(q.sql, /JOIN users/i, 'the user row is consulted');
  assert.match(q.sql, /status = \?3/, 'suspension enforced as a WHERE clause');
  assert.equal(q.binds[2], 'active');
});

test('findIdentity: a missing identity and a suspended user are the SAME answer', async () => {
  const d1 = createFakeD1({ respond: () => null });
  const db = createDb(d1, fixedDeps());
  assert.equal(await db.findIdentity('password', 'nobody@example.com'), null);
});

test('upsertProfile keeps unnamed fields — a voice change never erases an avatar', async () => {
  const d1 = createFakeD1();
  const db = createDb(d1, fixedDeps());
  await db.upsertProfile('u1', { voiceId: 'v9' });
  const q = d1.executed[0];
  assert.match(q.sql, /ON CONFLICT \(user_id\) DO UPDATE/);
  assert.match(q.sql, /COALESCE\(excluded\.avatar_key, avatar_key\)/, 'partial update preserves');
  assert.equal(q.binds[1], 'v9');
  assert.equal(q.binds[3], null, 'unnamed fields bind null so COALESCE keeps the old value');
});

test('session history: start writes machine time; close stores the vendor summary VERBATIM', async () => {
  const d1 = createFakeD1();
  const db = createDb(d1, fixedDeps());
  const { historyId } = await db.recordSessionStart({ userId: 'u1', room: 'r1', mode: 'convert' });
  assert.equal(historyId, 'id-1');
  await db.closeSession(historyId, {
    ttsChars: 1234,
    sttSeconds: 56.7,
    videoSeconds: 89,
    vendorSummary: { billed_seconds: 89 },
  });
  const close = d1.executed[1];
  assert.match(close.sql, /UPDATE session_history/);
  assert.equal(close.binds[0], 'id-1');
  assert.equal(close.binds[5], JSON.stringify({ billed_seconds: 89 }), 'verbatim, not paraphrased');
});

test('a completed session cannot be closed again — the first close wins by predicate', async () => {
  const d1 = createFakeD1();
  const db = createDb(d1, fixedDeps());
  await db.closeSession('h1', { ttsChars: 1 });
  assert.match(
    d1.executed[0].sql,
    /AND ended_at IS NULL/,
    'the idempotency predicate — a retry matches zero rows instead of overwriting the record',
  );
});

test('the schema enforces the credential invariant — a pin until real D1 executes it', () => {
  // The fake cannot execute SQL, so the constraint is pinned as text here;
  // execution-level proof arrives when migrations apply against real D1 in
  // the binding PR. A pin that disappears is a red test, not a silent loss.
  const sql = readFileSync(new URL('../migrations/0001_identity.sql', import.meta.url), 'utf8');
  assert.match(sql, /provider = 'password' AND password_hash IS NOT NULL/);
  assert.match(sql, /provider IN \('google', 'apple'\) AND password_hash IS NULL/);
  assert.match(sql, /verified IN \(0, 1\)/);
});

test('ids and clocks come from the injected deps — no second clock hides in SQL', async () => {
  const d1 = createFakeD1();
  const db = createDb(d1, fixedDeps());
  await db.recordSessionStart({ room: 'r1' });
  const q = d1.executed[0];
  assert.equal(q.binds[4], 1_754_000_000, 'the injected clock is the stored clock');
  assert.ok(!/unixepoch|CURRENT_TIMESTAMP|datetime\(/i.test(q.sql), 'SQL mints no time of its own');
});

test('addUserVoice: count-and-insert is ONE statement, and a cap refusal returns null', async () => {
  // The cap must be atomic — a read-then-write pair lets two concurrent
  // clones both pass the check (CodeRabbit, PR 94). The statement carries
  // its own COUNT guard; the caller learns refusal from meta.changes.
  const granted = createFakeD1();
  let db = createDb(granted, fixedDeps());
  const ok = await db.addUserVoice('u1', { vendorVoiceId: 'v-1', label: 'Me', cap: 3, vendorAccount: 'kabc12345' });
  assert.deepEqual(ok, { id: 'id-1' }, 'the fresh id is the row id — no read-back needed');
  const insert = granted.executed[0];
  assert.match(insert.sql, /SELECT COUNT\(\*\) FROM user_voices WHERE user_id/, 'the guard lives IN the insert');
  assert.equal(insert.binds[4], 'kabc12345', 'the creating account fingerprint rides the row');
  assert.equal(insert.binds[6], 3, 'the cap travels as a bind');
  // The clone flow mints the id BEFORE the vendor call so the sample and
  // the row share one identity — the override must be honoured.
  const explicit = await db.addUserVoice('u1', { id: 'row-fixed', vendorVoiceId: 'v-2', label: 'X', cap: 3 });
  assert.deepEqual(explicit, { id: 'row-fixed' });

  const refused = createFakeD1({ runMeta: () => ({ changes: 0 }) });
  db = createDb(refused, fixedDeps());
  assert.equal(await db.addUserVoice('u1', { vendorVoiceId: 'v-2', label: 'Me', cap: 3 }), null,
    'cap hit answers null so the caller can compensate at the vendor');
});
