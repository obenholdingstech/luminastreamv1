// Avatar-selection sequencing, as a pure module (CodeRabbit, PR 97). The
// hazard: a signed-in local pick uploads in the background; if the user
// selects a stored avatar B while upload A is still in flight, A's late
// completion must NOT win the selection back — the user's newest intent is
// the selection, full stop.
//
// The mechanism is a revision counter: every act of intent (a pick starting,
// a stored selection, a clear) takes a new revision, and an async completion
// may apply itself only if its revision is still the newest. Same shape as
// the reload sequencing in the library components, extracted because THIS
// one guards what identity rides a paid session.

export function createAvatarSelection() {
  let revision = 0;
  return {
    /** A new intent begins — everything older is superseded. */
    begin() {
      revision += 1;
      return revision;
    },
    /** May the completion holding `rev` still apply itself? */
    isCurrent(rev) {
      return rev === revision;
    },
  };
}
