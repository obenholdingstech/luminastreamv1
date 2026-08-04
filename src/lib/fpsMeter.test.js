// Run: node --test src/lib/fpsMeter.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFpsMeter } from './fpsMeter.js';

function feed(meter, fps, fromMs, untilMs) {
  const step = 1000 / fps;
  for (let t = fromMs; t < untilMs; t += step) meter.frame(t);
}

test('a steady 25fps stream reads 25', () => {
  const m = createFpsMeter();
  feed(m, 25, 0, 2000);
  assert.equal(m.read(), 25);
});

test('below minFrames the answer is null — "measuring", never an invented number', () => {
  const m = createFpsMeter();
  m.frame(0);
  m.frame(40);
  assert.equal(m.read(), null);
});

test('the window follows a rate CHANGE within its own length', () => {
  const m = createFpsMeter({ windowMs: 1000 });
  feed(m, 30, 0, 2000);
  assert.equal(m.read(), 30);
  feed(m, 15, 2000, 4000); // the vendor slowed down
  const settled = m.read();
  assert.ok(Math.abs(settled - 15) <= 1, `follows the new rate, read ${settled}`);
});

test('a backward clock starts over instead of lying about the span', () => {
  const m = createFpsMeter();
  feed(m, 25, 1000, 3000);
  m.frame(0); // the clock jumped back
  assert.equal(m.read(), null, 'a fresh measurement, not a poisoned span');
});

test('junk timestamps are refused; reset forgets', () => {
  const m = createFpsMeter();
  feed(m, 25, 0, 2000);
  m.frame(NaN);
  assert.equal(m.read(), 25, 'junk changed nothing');
  m.reset();
  assert.equal(m.read(), null);
});
