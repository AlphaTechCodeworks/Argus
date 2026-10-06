// Box-wide cap on the live streams the server asks the workers to run (settings.mjs liveCap). On the
// 8-core box ~70 open streams saturate the CPU and a full-size HD main can no longer start -- it falls
// back to the sub stream. The streams play in the per-NVR workers, but the DEMAND (what we ask them to
// run) is born and torn down entirely in this one parent process, at just two places: a real viewer
// (live-attach.mjs) and a warm-up (warm-streams.mjs). So the cap is counted and granted here, with no
// worker <-> main coordination and no new IPC: the box-wide count is the sum of every worker's wanted
// streams (the same reduce server.mjs uses for /healthz), which is lag-free and authoritative. A worker
// that dies, a slow STATS message or a viewer and a warm-up racing for the last slot cannot confuse it,
// because the parent's hub ledger -- not the workers -- is what is counted, and the event loop grants
// one request at a time.
//
// Two rules, both enforced where the stream is born:
//  - a warm-up may be started only while the box is below maxStreams - hdHeadroom (warmBudget), so the
//    headroom is never spent on warm-ups and a camera opened full-size always finds room for its main;
//  - a real viewer never piles on at the cap: a background warm-up is dropped to make room (viewer >
//    warm-up), and a full-size main drops warm-ups so it starts rather than fall back to the sub (HD
//    upgrade > warm-up). A stream a viewer is actually watching is never dropped -- only warm-ups are,
//    so the order is viewer > HD upgrade > warm-up with warm-ups always the ones sacrificed.
//
// enabled off: every method is a pass-through (no count, no preemption), so the two call sites run
// exactly as they do today. Pure: the settings, the live count and the warm-up handle are injected, so
// it unit-tests with no NVR (see test/live-cap.test.mjs).

/**
 * @param {{ settings: () => ({ enabled?: boolean, maxStreams?: number, hdHeadroom?: number, warmRemote?: boolean } | undefined),
 *   count: () => number, warm?: { release: (n: number) => number } | null }} o
 *   settings: the current liveCap, read fresh on every call so a Settings change applies live;
 *   count: the box-wide wanted-stream count now; warm: drops background warm-ups to free slots (attached
 *   after both are built, since the warm-up driver needs the cap's budget to start)
 */
export function makeLiveCap({ settings, count, warm = null }) {
  let warmHandle = warm
  const cfg = () => settings() ?? {}
  const on = () => cfg().enabled !== false // default on
  const max = () => { const n = cfg().maxStreams; return Number.isInteger(n) && n > 0 ? n : Infinity }
  const headroom = () => { const n = cfg().hdHeadroom; return Number.isInteger(n) && n >= 0 ? n : 0 }
  /** Drop up to n background warm-ups (never a watched stream); returns how many slots that freed. */
  const shed = (n) => (n > 0 && warmHandle ? warmHandle.release(n) : 0)
  // One place a new stream is admitted: if it would push the box past the cap, drop that many warm-ups.
  // fresh false: the stream is already wanted (a viewer back within the linger, a second viewer on a
  // tile), so the add does not grow the count and there is nothing to make room for.
  const makeRoom = (fresh) => (on() && fresh ? shed(count() + 1 - max()) : 0)
  return {
    /** Hands the warm-up driver in once it exists, so the cap can preempt warm-ups (server.mjs). */
    attachWarm(w) { warmHandle = w },
    /** Whether the cap is on; warm-streams.mjs and live-attach.mjs guard every new step on this. */
    enabled: on,
    /** Whether remote (P2P / serial) NVRs are warmed too (server.mjs filters them out when not). */
    warmRemote() { return cfg().warmRemote === true },
    /**
     * The count the box may be brought to by warm-ups: the cap less the main headroom, Infinity when
     * off. warm-streams.run() stops adding once the box reaches it and sheds back down to it.
     */
    warmBudget() { return on() ? Math.max(0, max() - headroom()) : Infinity },
    /**
     * A real viewer is about to open a tile. It is always let in -- a grid tile must show a picture --
     * but a background warm-up is dropped so the box does not climb past the cap.
     * @param {boolean} fresh whether the viewer's stream is new (not already wanted)
     * @returns {number} warm-ups dropped
     */
    admitViewer(fresh = true) { return makeRoom(fresh) },
    /**
     * A full-size view's main (HD) stream is about to start. Background warm-ups are dropped so it has
     * room rather than fall back to the sub; the headroom reserve means it rarely has to.
     * @param {boolean} fresh whether the main is a new stream (not already wanted)
     * @returns {number} warm-ups dropped
     */
    admitMain(fresh = true) { return makeRoom(fresh) }
  }
}
