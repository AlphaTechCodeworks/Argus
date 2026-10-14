// A limit on how many cameras of one recorder may be sent to viewers in full quality (their main
// stream) at once, whatever the page asks for.
//
// On 2026-10-13 a browser's layout asked one recorder reached over a slow P2P relay (Site 3) for seven
// main streams at once: the recorder stopped answering and dropped its links again and again. The page
// was fixed, but no page, old copy or other client should be able to do that, so the server counts.
//
// What is counted: per NVR, the distinct cameras whose main stream is being sent to viewers -- a /live
// socket or /live-mux channel that asked for stream 0. Not the recorder's own taps, not a held or warm
// stream sent to nobody, not a main standing in for a cold sub-stream: those never come this way. A
// camera already among them may always be joined by another viewer (its main already runs: no new load
// on the NVR); only a new camera at the limit is refused, with MAIN_AT_LIMIT, which the page treats as
// "full quality not now": the tile keeps or goes over to the sub-stream, says why in a small mark, and
// a full-size view asks again later (live-tile.js, viewer.js).
//
// Pure: no SDK, no sockets of its own; the clock and log are handed in. Tested in test/main-limit.test.mjs.

/** The reason a refused main stream's socket is closed with (the page knows it: live-tile.js). */
export const MAIN_AT_LIMIT = 'main: recorder at its limit'
// a recorder reached by serial number (P2P relay, often a slow site link) and one on the network
export const P2P_DEFAULT = 3
export const LAN_DEFAULT = 8
// the refusal line, at most once in this long per recorder: a wall asking again is one line
export const REFUSED_QUIET_MS = 60_000

const fromEnv = (v, fallback) => {
  const n = Number(v)
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= 0 ? n : fallback
}

/**
 * How many cameras of this NVR may be in full quality for viewers at once. The environment is read at
 * each call, nothing cached. A value that is not a whole number of 0 or more is ignored (the default).
 * @param {{ cfg?: { sn?: string } }} nvr
 * @param {Record<string, string|undefined>} [env]
 */
export function maxViewerMains(nvr, env = process.env) {
  return nvr?.cfg?.sn
    ? fromEnv(env.CCTV_MAX_VIEWER_MAINS_P2P, P2P_DEFAULT)
    : fromEnv(env.CCTV_MAX_VIEWER_MAINS_LAN, LAN_DEFAULT)
}

/**
 * Whether a viewer may have this camera's main stream: always when the camera is already among those
 * sent in full quality, otherwise only while fewer than `limit` are.
 * @param {Set<string>|string[]} cameras the cameras of this NVR in full quality now
 * @param {string} camera @param {number} limit
 */
export function mayOpenMain(cameras, camera, limit) {
  const set = cameras instanceof Set ? cameras : new Set(cameras)
  return set.has(camera) || set.size < limit
}

/** The journal's line for a refusal. */
export const refusedLine = ({ nvr, camera, count, max }) =>
  `[live] ${nvr}: full quality refused for ${camera}: already ${count} of ${max} cameras in full quality on this recorder`

/**
 * The bookkeeping: which viewer handle has which camera's main, per NVR.
 * @param {{ limitOf?: (nvr: object) => number, now?: () => number, log?: (line: string) => void }} [o]
 */
export function makeMainLimit({ limitOf = (nvr) => maxViewerMains(nvr), now = Date.now, log = (line) => console.log(line) } = {}) {
  const byNvr = new Map() // nvr id -> Map(camera -> Set(handle))
  const byHandle = new Map() // handle -> { nvrId, camera }
  const saidAt = new Map() // nvr id -> when its refusal line was last said

  const camerasOf = (nvrId) => byNvr.get(nvrId) ?? new Map()

  const api = {
    /**
     * A viewer asking for a camera's main stream. Let in: counted under `handle` until leave(handle),
     * and true. Refused: MAIN_AT_LIMIT, nothing counted, and the line said (once a minute per NVR).
     * @param {{ id: string, cfg?: object }} nvr @param {number} ch 0-based @param {object} handle the socket or channel
     */
    ask(nvr, ch, handle) {
      const camera = `${nvr.id}/${ch + 1}`
      const cams = camerasOf(nvr.id)
      const max = limitOf(nvr)
      if (!mayOpenMain(new Set(cams.keys()), camera, max)) {
        const t = now()
        if (!(t - (saidAt.get(nvr.id) ?? -Infinity) < REFUSED_QUIET_MS)) {
          saidAt.set(nvr.id, t)
          log(refusedLine({ nvr: nvr.id, camera, count: cams.size, max }))
        }
        return MAIN_AT_LIMIT
      }
      api.leave(handle) // (one handle, one camera: a handle asking again is moved, never counted twice)
      if (!byNvr.has(nvr.id)) byNvr.set(nvr.id, cams)
      if (!cams.has(camera)) cams.set(camera, new Set())
      cams.get(camera).add(handle)
      byHandle.set(handle, { nvrId: nvr.id, camera })
      return true
    },
    /** The viewer is gone (its socket closed). Safe to call any number of times. */
    leave(handle) {
      const at = byHandle.get(handle)
      if (!at) return
      byHandle.delete(handle)
      const cams = byNvr.get(at.nvrId)
      const set = cams?.get(at.camera)
      if (!set) return
      set.delete(handle)
      if (set.size === 0) cams.delete(at.camera)
      if (cams.size === 0) byNvr.delete(at.nvrId)
    },
    /** The cameras of this NVR in full quality for viewers now, sorted (tests, and anyone asking). */
    cameras: (nvrId) => [...camerasOf(nvrId).keys()].sort()
  }
  return api
}
