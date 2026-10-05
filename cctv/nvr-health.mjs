// Small pure helpers about an NVR's own health, shared by the two processes that know the facts.
//
// It imports nothing, so the live worker (nvr-worker.mjs) and the main process (server.mjs) can
// both use it, and the offline tests can import it on a machine without the native SDK.

/** A refused start counts for this long: the same window the nvr-refusing alert talks about. */
export const REFUSAL_WINDOW_MS = 10 * 60_000

/**
 * How many of this NVR's live streams were last refused rather than merely slow, recently.
 *
 * What we can honestly say is limited by what is kept: live.mjs remembers only the *last* failed
 * start per stream (`lastFailure`), not a running count, so this is "streams showing a recent
 * refusal", not "refusals in the last ten minutes". That is still the fact the owner needs —
 * nvr-2 sits at its stream limit and silently refuses the rest — and it is honest about which
 * streams are affected right now. A stream whose start merely timed out (`fast: false`) is not
 * counted: that is a slow network, not the NVR saying no.
 *
 * @param {Iterable<{ lastFailure?: { at: number, fast: boolean } }>} streams
 * @param {number} nowMs
 * @returns {number}
 */
export function recentRefusals(streams, nowMs, windowMs = REFUSAL_WINDOW_MS) {
  let n = 0
  for (const s of streams ?? []) {
    const f = s?.lastFailure
    if (f?.fast && Number.isFinite(f.at) && nowMs - f.at <= windowMs) n++
  }
  return n
}
