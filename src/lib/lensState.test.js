import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  CONNECTION,
  LENS_MODES,
  agentModeFor,
  deriveLensStatus,
  lensModeFor,
  medianTailMs,
} from './lensState.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── the two couplings this module cannot check by reasoning ────────────────
// lensState.js hardcodes strings that belong to somebody else: livekit-client's
// ConnectionState enum, and the agent's own wire vocabulary. Both are silent
// failures if they drift — the UI would just sit on "waiting for the agent"
// forever with no error anywhere. These two tests are the tripwire.

test('CONNECTION literals match livekit-client ConnectionState exactly', async () => {
  const { ConnectionState } = await import('livekit-client');
  assert.deepEqual(
    Object.values(CONNECTION).sort(),
    Object.values(ConnectionState).sort(),
    'livekit-client renamed or added a connection state',
  );
  for (const [name, value] of Object.entries(ConnectionState)) {
    const key = name[0].toLowerCase() + name.slice(1);
    assert.equal(CONNECTION[key], value, `CONNECTION.${key} drifted from the SDK`);
  }
});

test('every lens mode maps to a mode the agent actually accepts', () => {
  const src = readFileSync(join(REPO, 'agent', 'convert_agent.py'), 'utf8');
  const match = src.match(/^MODES = \(([^)]*)\)/m);
  assert.ok(match, 'could not find MODES in convert_agent.py');
  const agentModes = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(agentModes.length >= 2, 'MODES parsed as fewer than two modes');
  for (const mode of LENS_MODES) {
    assert.ok(
      agentModes.includes(mode.agentMode),
      `lens mode '${mode.id}' sends '${mode.agentMode}', which the agent does not accept`,
    );
  }
});

test('the utterance latency field is the one the agent publishes', () => {
  const src = readFileSync(join(REPO, 'agent', 'tts_engine.py'), 'utf8');
  // Guard the index. indexOf returns -1 when the marker is gone, and
  // src.slice(-1) is the file's last character — the assertion below would then
  // fail with "no longer publishes tail_latency_ms" when the real drift is that
  // the whole notice was renamed. A test that fails for the wrong reason sends
  // the next person to the wrong file.
  const at = src.indexOf('"type": "tts_utterance"');
  assert.notEqual(at, -1, 'tts_engine.py no longer publishes a tts_utterance notice');
  const notice = src.slice(at);
  assert.ok(
    /"tail_latency_ms"/.test(notice.slice(0, 800)),
    'tts_engine.py no longer publishes tail_latency_ms on tts_utterance',
  );
});

// ── mode mapping ───────────────────────────────────────────────────────────

test('mode mapping round-trips both ways', () => {
  assert.equal(agentModeFor('direct'), 'passthrough');
  assert.equal(agentModeFor('converted'), 'convert');
  assert.equal(lensModeFor('passthrough').id, 'direct');
  assert.equal(lensModeFor('convert').id, 'converted');
});

test('unknown modes yield null, never a default', () => {
  assert.equal(agentModeFor('sideways'), null);
  assert.equal(agentModeFor(undefined), null);
  assert.equal(lensModeFor('rvc_unavailable'), null);
  assert.equal(lensModeFor(null), null);
});

// ── status derivation ──────────────────────────────────────────────────────

test('disconnected is idle, and carries an error when one exists', () => {
  assert.equal(deriveLensStatus({ connectionState: CONNECTION.disconnected }).tone, 'idle');
  const failed = deriveLensStatus({
    connectionState: CONNECTION.disconnected,
    error: 'permission denied',
  });
  assert.equal(failed.tone, 'error');
  assert.match(failed.detail, /permission denied/);
});

test('connecting and reconnecting are distinguishable', () => {
  assert.equal(deriveLensStatus({ connectionState: CONNECTION.connecting }).tone, 'working');
  assert.equal(deriveLensStatus({ connectionState: CONNECTION.reconnecting }).tone, 'warn');
  assert.equal(
    deriveLensStatus({ connectionState: CONNECTION.signalReconnecting }).tone,
    'warn',
  );
});

test('connected with a confirmed mode is live, and names the mode', () => {
  const s = deriveLensStatus({
    connectionState: CONNECTION.connected,
    agentMode: 'convert',
  });
  assert.equal(s.tone, 'live');
  assert.equal(s.id, 'live-converted');
  assert.match(s.label, /Converted/);
});

test('connected with no agent yet is working, not live', () => {
  const s = deriveLensStatus({ connectionState: CONNECTION.connected, agentMode: null });
  assert.equal(s.tone, 'working');
  assert.equal(s.id, 'waiting');
});

// This is the ordering that matters. A busy agent means the mic is reaching
// the room and nothing is coming back — rendering that as "Live" is the exact
// confusion the agent_busy broadcast exists to prevent.
test('agent busy outranks a confirmed live mode', () => {
  const s = deriveLensStatus({
    connectionState: CONNECTION.connected,
    agentMode: 'convert',
    agentBusy: { processing: 'studio-abc', ignored: 'studio-xyz' },
  });
  assert.equal(s.id, 'busy');
  assert.equal(s.tone, 'warn');
  assert.match(s.detail, /studio-abc/);
});

test('agent busy without a named holder still reads sensibly', () => {
  const s = deriveLensStatus({
    connectionState: CONNECTION.connected,
    agentMode: 'convert',
    agentBusy: { processing: null, ignored: 'studio-xyz' },
  });
  assert.match(s.detail, /another speaker/);
});

test('blocked audio outranks live but not busy', () => {
  assert.equal(
    deriveLensStatus({
      connectionState: CONNECTION.connected,
      agentMode: 'passthrough',
      audioBlocked: true,
    }).id,
    'blocked',
  );
  assert.equal(
    deriveLensStatus({
      connectionState: CONNECTION.connected,
      agentMode: 'passthrough',
      audioBlocked: true,
      agentBusy: { processing: 'someone' },
    }).id,
    'busy',
  );
});

test('a stale error never leaks into a live session', () => {
  // error is set on the hook until the next connect clears it; a connected
  // room must not render a past failure as its current state.
  const s = deriveLensStatus({
    connectionState: CONNECTION.connected,
    agentMode: 'convert',
    error: 'Failed to connect to LiveKit.',
  });
  assert.equal(s.tone, 'live');
});

test('called with nothing at all, it does not throw', () => {
  const s = deriveLensStatus();
  assert.equal(typeof s.label, 'string');
  assert.equal(s.tone, 'working'); // unknown state → not idle, not live
});

// ── latency ────────────────────────────────────────────────────────────────

test('median of the recent window, not the newest sample', () => {
  // newest first; a single 4-second outlier must not move the readout
  const utterances = [
    { tail_latency_ms: 4000 },
    { tail_latency_ms: 640 },
    { tail_latency_ms: 700 },
    { tail_latency_ms: 610 },
    { tail_latency_ms: 660 },
  ];
  assert.equal(medianTailMs(utterances), 660);
});

test('even-sized windows average the two middles', () => {
  assert.equal(medianTailMs([{ tail_latency_ms: 600 }, { tail_latency_ms: 700 }]), 650);
});

test('only the newest sampleSize utterances count', () => {
  const utterances = [
    { tail_latency_ms: 100 },
    { tail_latency_ms: 100 },
    { tail_latency_ms: 100 },
    { tail_latency_ms: 9000 },
    { tail_latency_ms: 9000 },
  ];
  assert.equal(medianTailMs(utterances, 3), 100);
});

test('dropped utterances are skipped, not counted as zero', () => {
  const utterances = [
    { dropped: true, reason: 'governor' },
    { tail_latency_ms: 800 },
  ];
  assert.equal(medianTailMs(utterances), 800);
});

test('nothing measurable yields null, never zero', () => {
  assert.equal(medianTailMs([]), null);
  assert.equal(medianTailMs([{ dropped: true }]), null);
  assert.equal(medianTailMs([{ tail_latency_ms: null }]), null);
  assert.equal(medianTailMs([{ tail_latency_ms: 'fast' }]), null);
  assert.equal(medianTailMs([{ tail_latency_ms: NaN }]), null);
  assert.equal(medianTailMs(undefined), null);
  assert.equal(medianTailMs([{ tail_latency_ms: 600 }], 0), null);
});
