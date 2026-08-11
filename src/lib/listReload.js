// List-reload policy, as a pure module (CodeRabbit, PR 111 — the
// avatarSelection rule again). Two decisions live here, not in components:
//
// 1. ORDERING — reloads race, and only the newest intent may apply. Same
//    revision-counter shape as createAvatarSelection: every intent (a
//    reload starting, a sign-out emptying the list) takes a new revision,
//    and an async completion applies only while its revision is newest —
//    so a response from the previous account can never land after
//    sign-out invalidated it.
// 2. FAILURE RETENTION — a failed fetch (null) keeps the last known list
//    rather than blanking the UI; an empty array is a real answer and
//    replaces it.

export function createReloadSequence() {
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

/** The next list state: null (failed fetch) retains, an array replaces. */
export function foldListResponse(previous, items) {
  return items === null ? previous : items;
}
