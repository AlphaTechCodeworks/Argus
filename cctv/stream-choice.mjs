// Which stream to record when the NVR will not give us the good one.
//
// An NVR shares one fixed bandwidth budget between recording to its own disk and serving streams
// to us. When it is spent it simply refuses the next request, and the recorder backs off for five
// to ten minutes and tries again. On an NVR that is permanently at its ceiling that loop never
// ends, and those cameras record nothing at all -- for ever.
//
// On 2026-09-25 nvr-2 was at 128 Mb of its 192 Mb budget with 32 cameras. Channels 1-17 recorded
// happily; every refusal was on channels 18-32. Eleven cameras were online, looked healthy on
// every page, and had not written a frame. That is the worst kind of failure this system can have:
// footage nobody knows is missing until they go looking for it.
//
// A sub-stream costs a fraction of a main stream. Lower resolution is worth having and nothing is
// not, so after a couple of refusals the recorder asks for the sub-stream instead. It keeps trying
// the main stream now and again, so a camera drops back to full quality by itself once somebody
// frees up capacity -- otherwise one bad afternoon would quietly downgrade a site permanently.
//
// Deliberately NOT automatic in the other direction: nothing here ever changes a setting on the
// NVR or a camera to make room. Choosing what to sacrifice is the owner's decision, and the Health
// page states the bandwidth so it can be made with the facts to hand.

/** Refusals of the main stream in a row before the sub-stream is worth trying. */
export const REFUSALS_BEFORE_SUB = 2
/** How often a camera on its sub-stream tries the main one again. */
export const RETRY_MAIN_MS = 30 * 60_000

export const MAIN = 0
export const SUB = 1

/**
 * Which stream this camera should ask for now.
 *
 * Pure so the rule can be tested without an NVR: the bug this fixes was invisible for exactly as
 * long as it was, because nothing that decided it could be run on a development PC.
 *
 * @param {object} s the camera's recording state
 * @param {number} s.refusals consecutive refusals of whatever stream it last asked for
 * @param {boolean} s.onSub whether it is currently recording the sub-stream
 * @param {number} s.subSince when it moved to the sub-stream, or 0
 * @param {number} nowMs
 * @param {object} [o]
 * @param {boolean} [o.allowSub] false keeps the old behaviour: main stream or nothing
 * @returns {{ type: 0|1, changed: boolean, why: string }}
 */
export function chooseStream({ refusals = 0, onSub = false, subSince = 0, lastRefusedAt = 0 } = {}, nowMs, { allowSub = true, prefer = 'auto', refusalsBeforeSub = REFUSALS_BEFORE_SUB, retryMainMs = RETRY_MAIN_MS } = {}) {
  // A deliberate per-camera or per-NVR choice (settings recording.stream): record this stream and never
  // switch. `sub` is how a constrained NVR is recorded continuously -- nvr-2 has 32 cameras and, near
  // its serving budget, would not relay channels 18-32 as a smooth main stream, so their server-side
  // recording gapped constantly while the NVR's own disk had them in full. A sub-stream is a fraction
  // of the bandwidth, so the NVR can serve every camera. This is a choice, not a fallback: not degraded.
  if (prefer === 'sub') return { type: SUB, changed: !onSub, why: 'recording the sub-stream (set for this camera)' }
  if (prefer === 'main') return { type: MAIN, changed: onSub, why: 'recording the main stream (set for this camera)' }
  if (!allowSub) return { type: MAIN, changed: onSub, why: 'sub-stream fallback is switched off' }

  if (onSub) {
    // Back to full quality the moment there is any sign there might be room. Trying costs one
    // refusal; never trying costs a camera that stays at reduced quality until somebody notices.
    //
    // The clock runs from the last refusal, not from when the camera was first degraded. Reading
    // it from subSince means a failed retry is instantly due for another one, and the camera
    // hammers an NVR that has already said no -- the opposite of what a backoff is for.
    const since = Math.max(Number(subSince) || 0, Number(lastRefusedAt) || 0)
    if (since > 0 && nowMs - since >= retryMainMs) {
      return { type: MAIN, changed: true, why: 'trying the main stream again in case the NVR has room now' }
    }
    return { type: SUB, changed: false, why: 'recording the sub-stream: the NVR refused the main one' }
  }

  if (refusals >= refusalsBeforeSub) {
    return { type: SUB, changed: true, why: `the NVR refused the main stream ${refusals} times; recording the sub-stream rather than nothing` }
  }
  return { type: MAIN, changed: false, why: 'recording the main stream' }
}

/**
 * The camera's state after the NVR refused it, ready for the next decision.
 * Kept apart from chooseStream so the counting and the choosing can be tested separately.
 */
export function afterRefusal(s = {}, nowMs) {
  const refusals = (s.refusals ?? 0) + 1
  // A refusal of the sub-stream while already on it means the NVR has nothing left at all. The
  // count keeps rising so the backoff lengthens, but there is nowhere further down to go.
  return { ...s, refusals, lastRefusedAt: nowMs }
}

/** The camera's state once video is flowing again: the refusal count only means anything in a row. */
export function afterVideo(s = {}, nowMs, type) {
  const onSub = type === SUB
  return {
    ...s,
    refusals: 0,
    onSub,
    // Only stamped when it first moves to the sub-stream, so the retry clock measures how long it
    // has been degraded rather than restarting on every frame.
    subSince: onSub ? (s.onSub && s.subSince ? s.subSince : nowMs) : 0
  }
}

/** What the Health page and the logs should say about a camera recording less than it should. */
export function degradedNote(s = {}, nowMs) {
  if (!s?.onSub) return null
  const mins = Number.isFinite(s.subSince) && s.subSince > 0 ? Math.round((nowMs - s.subSince) / 60_000) : null
  return `recording the sub-stream${mins === null ? '' : ` for ${mins} min`}: the NVR would not give the main one`
}
