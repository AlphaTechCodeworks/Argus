// How many sub-streams an NVR will play at once for this server, learnt from its refusals.
//
// value4u (NVR-63432-16P-AI) plays 15. Every sub-stream asked for beyond that is refused in about
// 300 ms with SDK error 8, "cannot connect", however many main streams it plays (26 at once): 663
// refusals with 15 sub-streams playing, 12 with fewer (09-26/27). Its grid tiles, which all ask for
// sub-streams, were refused whenever the recorder (10 sub-streams since it records the sub of cameras
// whose main only trickles) and the warm-ups had taken the rest, and the worker asked again every
// minute: the "value4u is refusing streams" alert. The NVR worker asks for no more than this limit
// (nvr-worker.mjs): a viewer's tile beyond it is shown the camera's main stream meanwhile
// (sub-bridge.mjs), warm-ups leave room for viewers, and a viewer takes a warm-up's place.
//
// Only a refusal that looks like that limit counts: error 8, fast, with at least MIN_PLAYING other
// sub-streams of the NVR playing -- not a camera that is offline (98), a dropped session (9, "not
// connected") or nvr-2's silent refusals, which set nothing. Until a limit is known it takes CONFIRM
// such refusals within CONFIRM_MS, at about the same count, so one "cannot connect" on a busy nvr1
// sets none. A known limit follows what the NVR does: a refusal at it confirms it, CONFIRM refusals
// below it lower it, a sub-stream playing beyond it raises it, and one not confirmed for RETRY_MS lets
// one more stream through (refused: it stands; played: it rises, and the next one is tried CLIMB_MS
// later, so a limit lowered while something else held places climbs back in minutes, not hours).
// Pure: the worker hands in the counts and the clock.
export const LIMIT_ERROR = 8
export const MIN_PLAYING = 4
export const CONFIRM = 2
export const CONFIRM_MS = 10 * 60_000
export const RETRY_MS = 30 * 60_000
export const CLIMB_MS = 2 * 60_000
/** A limit saved before a restart is trusted this long (the worker saves it, sub-cap-<nvr>.json). */
export const SAVED_MS = 24 * 60 * 60_000

/**
 * @param {{ now?: () => number, saved?: { limit: number, at: number } | null }} o
 */
export function subCap({ now = Date.now, saved = null } = {}) {
  let limit = null // null: not known
  let seenAt = 0 // when the NVR last showed it (a refusal at it, or a stream playing beyond it)
  let seen = [] // { at, playing } refusals towards a limit not known yet
  if (saved && Number.isInteger(saved.limit) && saved.limit >= MIN_PLAYING && Number.isFinite(saved.at) && now() - saved.at < SAVED_MS) {
    limit = saved.limit
    seenAt = saved.at
  }
  return {
    /**
     * A sub-stream start that failed. playing: the NVR's other sub-streams playing at the time.
     * @returns {boolean} whether the limit changed
     */
    refused({ code, fast, playing }) {
      if (code !== LIMIT_ERROR || fast !== true || !(playing >= MIN_PLAYING)) return false
      const t = now()
      // at (or past) the limit: the NVR says it again. Below it, the limit is lowered only the way it
      // is learnt, by CONFIRM refusals (one start that came a moment before the NVR let go of a
      // stream just stopped says nothing)
      if (limit !== null && playing >= limit) {
        const was = limit
        limit = playing
        seenAt = t
        seen = []
        return limit !== was
      }
      seen = [...seen.filter((r) => t - r.at < CONFIRM_MS && Math.abs(r.playing - playing) <= 1), { at: t, playing }]
      if (seen.length < CONFIRM) return false
      limit = Math.min(...seen.map((r) => r.playing))
      seenAt = t
      seen = []
      return true
    },
    /**
     * The NVR's sub-streams playing now (all of them: the recorder's too).
     * @returns {boolean} whether the limit changed (it rose)
     */
    playing(n) {
      if (limit === null || !(n > limit)) return false
      limit = n
      seenAt = now() - RETRY_MS + CLIMB_MS // the next one is tried soon: it may go on rising
      return true
    },
    /** How many sub-streams may play: Infinity while none is known; one more once it is due a retry. */
    limit() {
      if (limit === null) return Infinity
      return now() - seenAt > RETRY_MS ? limit + 1 : limit
    },
    /** The limit itself (null: not known), for the stats and the saved file. */
    known() {
      return limit
    },
    toJSON() {
      return limit === null ? null : { limit, at: seenAt }
    }
  }
}
