// Who is holding the slot, and when it must be given back.
//
// This started life inside Studio.jsx, where it acquired four separate
// lifecycle decisions — claim, release, unmount, page-hide — and could not be
// tested, because every one of them is a React or browser lifecycle event.
// AGENTS.md is explicit about why that is the wrong home: "anything with real
// logic belongs here rather than inside a component, because this is the part
// that can be tested without a browser." The races below are the reason that
// rule exists; each one is now a unit test rather than a comment.
//
// Nothing here imports React or touches the DOM. Every collaborator is
// injected, so a test can resolve a create in the middle of an unmount and
// assert what happened to the slot.
//
// ─── the thing being protected ────────────────────────────────────────────
//
// A slot is one of a very small number of rooms with an agent in it — one, at
// the time of writing. A slot nobody releases stays held until its lease
// expires, two hours later. So "we forgot to release" is not untidiness; it is
// the product being unavailable to everyone until the afternoon is over.

/** @typedef {{ sessionId: string, endToken: string }} HeldSession */

export const PHASE = {
  idle: 'idle',
  starting: 'starting',
  held: 'held',
};

const EMPTY = {
  phase: PHASE.idle,
  adminToken: '',
  error: '',
  /** @type {HeldSession|null} */
  session: null,
  /** @type {{ room: string, identity: string }|null} */
  allocation: null,
  url: '',
  token: '',
};

/**
 * @param {{
 *   open: (args: { password?: string, adminToken?: string }) => Promise<any>,
 *   end: (adminToken: string, session: HeldSession) => Promise<unknown>,
 *   beacon: (adminToken: string, session: HeldSession) => unknown,
 *   onChange?: (state: typeof EMPTY) => void,
 * }} deps
 */
export function createSessionHolder({ open, end, beacon, onChange }) {
  let state = { ...EMPTY };

  // Not part of `state` because nothing renders them, and mixing lifecycle
  // bookkeeping into the published snapshot invites a component to branch on
  // it and re-introduce the coupling this module exists to remove.
  let disposed = false;
  let hidden = false;
  // Set when a slot was released while the page was hidden. On restore the
  // credentials in `state` name a room we no longer hold, and reconnecting
  // with them would put this tab into a room the registry has already given
  // to somebody else.
  let releasedWhileHidden = false;

  function publish(next) {
    state = next;
    onChange?.(state);
  }

  /**
   * Hand a slot back through whichever channel is still available.
   *
   * **Never rejects, on any path.** Not a convenience — the contract.
   *
   * `hide()` and `dispose()` cannot await, so a rejection there has nobody to
   * catch it and becomes an unhandled rejection: fatal in some Node and worker
   * contexts, noise in browser error reporting. And the paths that DO await —
   * `stop()`, and the in-flight race in `start()` — are reached from a click
   * handler and a submit handler, where a rejection lands in exactly the same
   * place for exactly the same reason.
   *
   * Releasing is also best-effort by nature: the lease reclaims the slot
   * regardless, and stopping is something the user has already finished doing.
   * There is no caller anywhere for whom a failure here is actionable, which is
   * the same conclusion `sessionClient.endSession` reaches independently.
   */
  function surrender(adminToken, session, { viaBeacon }) {
    if (!session) return undefined;
    try {
      const result = viaBeacon ? beacon(adminToken, session) : end(adminToken, session);
      return Promise.resolve(result).catch(() => undefined);
    } catch {
      // A collaborator that throws synchronously rather than rejecting. The
      // collaborator is injected, so this is not hypothetical politeness.
      return undefined;
    }
  }

  return {
    snapshot: () => state,

    /**
     * Claim a slot.
     *
     * The awkward part is everything that can happen while the request is in
     * flight — up to the client's whole timeout, which is long enough that
     * following a link right after pressing Start lands inside it.
     */
    async start(/** @type {{ password?: string }} */ { password } = {}) {
      if (state.phase === PHASE.starting || state.phase === PHASE.held) return;
      publish({ ...state, phase: PHASE.starting, error: '' });

      let opened;
      try {
        opened = await open({ password, adminToken: state.adminToken });
      } catch (err) {
        // Nothing was allocated, so there is nothing to release.
        if (disposed) return;
        if (hidden) {
          // But the PHASE still has to come back. A hidden page can be
          // restored, and `restored()` only resets state when a slot was
          // surrendered — which never happened here, because the claim failed.
          // Returning early would leave `starting` published forever, and the
          // guard at the top of start() would then refuse every later attempt:
          // a Start button that is permanently inert until a reload.
          publish({ ...state, phase: PHASE.idle, error: '' });
          return;
        }
        publish({
          ...state,
          phase: PHASE.idle,
          // A 401 means the admin session is the thing that is wrong, so drop
          // it. Any other failure hands back a still-valid one (see
          // sessionClient.openSession), because a busy lens must not also cost
          // the user their access key.
          adminToken: err?.status === 401 ? '' : err?.adminToken || state.adminToken,
          error: err?.message || 'could not start the lens',
        });
        return;
      }

      const session = { sessionId: opened.sessionId, endToken: opened.endToken };

      // THE RACE. The page is already gone, so nothing will read this holder
      // again — the unmount and page-hide handlers have both already run and
      // found nothing to release. Give the slot back here or it is held for
      // the full lease.
      if (disposed || hidden) {
        if (hidden) releasedWhileHidden = true;
        await surrender(opened.adminToken, session, { viaBeacon: hidden });
        return;
      }

      publish({
        phase: PHASE.held,
        adminToken: opened.adminToken,
        error: '',
        session,
        allocation: { room: opened.room, identity: opened.identity },
        url: opened.url,
        token: opened.token,
      });
    },

    /** Give the slot back. Keeps the admin session — only the slot is returned. */
    async stop() {
      const { adminToken, session } = state;
      publish({ ...EMPTY, adminToken });
      if (session) await surrender(adminToken, session, { viaBeacon: false });
    },

    /**
     * The page is being hidden: closed, backgrounded, or put in the bfcache.
     *
     * Released through the beacon path because a `pagehide` handler cannot
     * await. The published state is deliberately NOT cleared here — a hidden
     * page may be restored, and clearing during hide would flash an empty UI
     * on the way out. `restored()` does that instead, at the only moment it
     * can be observed.
     */
    hide() {
      hidden = true;
      if (state.session) {
        releasedWhileHidden = true;
        surrender(state.adminToken, state.session, { viaBeacon: true });
      }
    },

    /**
     * Restored from the bfcache.
     *
     * If a slot was surrendered on the way out, the credentials still sitting
     * in state name a room the registry has since handed to somebody else.
     * Reconnecting with them would put this tab into a stranger's session, so
     * they are cleared and the user starts a fresh one.
     */
    restored() {
      hidden = false;
      if (!releasedWhileHidden) return;
      releasedWhileHidden = false;
      publish({ ...EMPTY, adminToken: state.adminToken });
    },

    /**
     * Unmount — an in-app navigation, which `pagehide` never sees.
     *
     * Uses the ordinary request, not the beacon: the document is alive and
     * will stay alive, so a normal fetch is the more reliable of the two. The
     * result is not awaited because a React cleanup cannot await, and there is
     * nothing useful to do with a failure the user has already navigated past.
     */
    dispose() {
      disposed = true;
      const { adminToken, session } = state;
      if (session) surrender(adminToken, session, { viaBeacon: false });
    },
  };
}
