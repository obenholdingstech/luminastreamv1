// Run: node --test src/lib/audioOnset.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnsetGate } from './audioOnset.js';

// Feed a level for a duration at a 20ms cadence; collect events.
function speak(gate, level, fromMs, untilMs, events) {
  for (let t = fromMs; t < untilMs; t += 20) {
    const e = gate.feed(level, t);
    if (e) events.push(e);
  }
}

test('speech produces one onset carrying the TRUE start time, then one offset', () => {
  const gate = createOnsetGate();
  const events = [];
  speak(gate, 0.01, 0, 200, events); // room tone
  speak(gate, 0.4, 200, 1200, events); // a second of speech
  speak(gate, 0.01, 1200, 2200, events); // silence through the hangover
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'onset');
  assert.equal(events[0].t, 200, 'the onset is when the level first crossed, not when it was believed');
  assert.equal(events[1].type, 'offset');
});

test('a click shorter than minOpenMs is never speech — no events at all', () => {
  const gate = createOnsetGate();
  const events = [];
  speak(gate, 0.01, 0, 100, events);
  speak(gate, 0.8, 100, 160, events); // 60ms transient
  speak(gate, 0.01, 160, 1500, events);
  assert.deepEqual(events, []);
});

test('hysteresis: a dip between open and close thresholds does not split the segment', () => {
  const gate = createOnsetGate();
  const events = [];
  speak(gate, 0.4, 0, 400, events);
  speak(gate, 0.08, 400, 600, events); // below open (0.12), above close (0.05)
  speak(gate, 0.4, 600, 1000, events);
  speak(gate, 0.01, 1000, 2000, events);
  assert.equal(events.filter((e) => e.type === 'onset').length, 1, 'one utterance, one onset');
});

test('natural inter-word pauses shorter than the hangover do not end the segment', () => {
  const gate = createOnsetGate();
  const events = [];
  speak(gate, 0.4, 0, 300, events);
  speak(gate, 0.0, 300, 600, events); // a 300ms pause — under the 400ms hangover
  speak(gate, 0.4, 600, 900, events);
  speak(gate, 0.0, 900, 2000, events);
  assert.equal(events.filter((e) => e.type === 'offset').length, 1, 'one segment end, after the real end');
});

test('two utterances separated by real silence are two onset/offset pairs', () => {
  const gate = createOnsetGate();
  const events = [];
  speak(gate, 0.4, 0, 500, events);
  speak(gate, 0.0, 500, 1500, events);
  speak(gate, 0.4, 1500, 2000, events);
  speak(gate, 0.0, 2000, 3000, events);
  assert.deepEqual(
    events.map((e) => e.type),
    ['onset', 'offset', 'onset', 'offset'],
  );
  assert.equal(events[2].t, 1500);
});

test('junk input changes nothing', () => {
  const gate = createOnsetGate();
  assert.equal(gate.feed(NaN, 100), null);
  assert.equal(gate.feed(0.5, NaN), null);
  const events = [];
  speak(gate, 0.4, 0, 400, events);
  assert.equal(events.length, 1, 'the gate still works after junk');
});
