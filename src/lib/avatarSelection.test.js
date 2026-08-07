// Run: node --test src/lib/avatarSelection.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarSelection } from './avatarSelection.js';

test('a completion may apply only while its revision is the newest', () => {
  const seq = createAvatarSelection();
  const a = seq.begin();
  assert.equal(seq.isCurrent(a), true, 'nothing newer yet');
  const b = seq.begin();
  assert.equal(seq.isCurrent(a), false, 'superseded');
  assert.equal(seq.isCurrent(b), true);
});

test("the race itself: upload A resolves AFTER the user selects B — A's result is refused", async () => {
  const seq = createAvatarSelection();
  let selected = null;

  // Upload A begins (a local pick) and takes its revision…
  const revA = seq.begin();
  let releaseA;
  const uploadA = new Promise((r) => {
    releaseA = r;
  }).then(() => {
    // …the component's rule: apply only when still current.
    if (seq.isCurrent(revA)) selected = 'A';
  });

  // …the user selects stored avatar B while A is in flight.
  seq.begin();
  selected = 'B';

  releaseA();
  await uploadA;
  assert.equal(selected, 'B', "A's late completion never wins the selection back");
  // Deliberately removing the isCurrent guard makes `selected` end as 'A' —
  // verified by mutation before commit.
});
