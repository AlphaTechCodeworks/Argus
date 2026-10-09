// A camera's main stream kept running on the server for a viewer who is likely to open it next, so
// that when they do it is there at once: the NVR does not have to start it (0.5-3 s, more when busy).
//
// The Live page says which camera it expects next (public/viewer.js: the one a step on in the
// full-size view) and the server holds that stream the way warm-streams.mjs holds first screens: a
// quiet viewer on it that takes the frames and sends them nowhere, marked background so a real
// viewer's stream is always started first. Nothing goes to the browser, so it costs the viewer's
// link nothing, works the same for a phone or a remote viewer as for a PC in the office, and is not
// somebody "watching" (presence never hears of it).
//
// Held, not kept: a hold lasts HOLD_MS and the page asks again while it still expects that camera.
// A page that goes away without saying so loses it by itself. And bounded, because every held main
// stream is one the NVR pulls from its camera at full size:
//   - one per viewer: a new hold replaces that viewer's last;
//   - PER_NVR on one NVR and MAX in all, counted over distinct cameras (two viewers expecting the
//     same camera share one stream);
//   - never on an NVR that is refusing streams, nor a camera that is offline (the caller says:
//     streamOf answers null).
// When the hold ends the stream lingers as any stream nobody watches does (stream-hub.mjs: 10 s for
// a main stream), so a viewer arriving a moment late still finds it.
//
//   POST /api/live/hold  { nvr, ch }  -> { held: true, ms } | { held: false, why }
//
// Pure apart from its timers (handed in for tests: test/stream-holds.test.mjs).

export const HOLD_PATH = '/api/live/hold'
export const HOLD_MS = 20_000
export const PER_NVR = 2
export const MAX = 8
export const BODY_LIMIT = 1024
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const NO_STORE = { 'cache-control': 'no-store' }

/** The stream's quiet viewer: takes the frames, sends them nowhere; a real viewer's start goes first. */
const quietViewer = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, background: true, send() {}, on() {} })

/**
 * @param {{ streamOf: (nvr: string, ch: number) => { add: Function, remove: Function }|null,
 *   holdMs?: number, perNvr?: number, max?: number, later?: Function, cancel?: Function, log?: Function }} o
 *   streamOf: the camera's main stream, or null when it must not be held now (NVR offline or refusing)
 */
export function makeHolds({ streamOf, holdMs = HOLD_MS, perNvr = PER_NVR, max = MAX, later = setTimeout, cancel = clearTimeout, log = () => {} }) {
  const byViewer = new Map() // viewer key -> { cam, timer }
  const streams = new Map() // cam "nvr/ch" -> { stream, quiet, viewers: Set<viewer key> }

  const let_go = (viewer) => {
    const h = byViewer.get(viewer)
    if (!h) return
    cancel(h.timer)
    byViewer.delete(viewer)
    const s = streams.get(h.cam)
    if (!s) return
    s.viewers.delete(viewer)
    if (s.viewers.size > 0) return
    streams.delete(h.cam)
    try { s.stream.remove(s.quiet) } catch {} // (a stream already closed: nothing to let go of)
  }

  return {
    /**
     * Holds nvr/ch for this viewer for holdMs from now, in place of whatever they held.
     * @returns {{ held: true, ms: number }|{ held: false, why: string }}
     */
    hold(viewer, nvr, ch) {
      const cam = `${nvr}/${ch}`
      const mine = byViewer.get(viewer)
      if (mine?.cam === cam && streams.has(cam)) {
        // asked again while still expected: the same hold, its time started over
        cancel(mine.timer)
        mine.timer = later(() => let_go(viewer), holdMs)
        mine.timer?.unref?.()
        return { held: true, ms: holdMs }
      }
      let_go(viewer) // (before counting: the one it replaces makes room)
      let s = streams.get(cam)
      if (!s) {
        if (streams.size >= max) return { held: false, why: 'the server is holding as many as it may' }
        let onNvr = 0
        for (const k of streams.keys()) if (k.slice(0, k.lastIndexOf('/')) === nvr) onNvr++
        if (onNvr >= perNvr) return { held: false, why: 'this NVR is holding as many as it may' }
        const stream = streamOf(nvr, ch)
        if (!stream) return { held: false, why: 'not now' }
        const quiet = quietViewer()
        try {
          stream.add(quiet)
        } catch (e) {
          log(`[hold] ${cam}: ${e.message}`)
          return { held: false, why: 'not now' }
        }
        streams.set(cam, (s = { stream, quiet, viewers: new Set() }))
      }
      s.viewers.add(viewer)
      const timer = later(() => let_go(viewer), holdMs)
      timer?.unref?.()
      byViewer.set(viewer, { cam, timer })
      return { held: true, ms: holdMs }
    },
    /** The viewer has gone, or opened something: what they held is let go. */
    release: let_go,
    /** What is held now, for /healthz and tests: { cameras: [...], viewers: n }. */
    state: () => ({ cameras: [...streams.keys()], viewers: byViewer.size })
  }
}

async function bodyOf(req) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > BODY_LIMIT) return undefined
    chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * The route. mayHd(nvr, ch): whether this session may watch that camera's main stream (the same
 * question a main stream asks: live and Live HD). viewer: this browser's key, as presence has it.
 * @returns {Promise<[number, object, object]|null>} null: not this route
 */
export async function handleHold(req, pathname, { user, viewer, mayHd, holds }) {
  if (pathname !== HOLD_PATH) return null
  if (!user) return [401, { error: 'Sign in' }, NO_STORE]
  if (req.method !== 'POST') return [405, { error: 'Method not allowed' }, { ...NO_STORE, allow: 'POST' }]
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return [415, { error: 'JSON only' }, NO_STORE]
  const origin = req.headers.origin
  let from = null
  try { from = origin ? new URL(origin).host : null } catch { from = '' }
  if (origin && from !== req.headers.host) return [403, { error: 'Wrong origin' }, NO_STORE]
  const b = await bodyOf(req)
  if (!b || typeof b.nvr !== 'string' || !ID_RE.test(b.nvr) || !Number.isInteger(b.ch) || b.ch < 0 || b.ch > 255) return [400, { error: 'Which camera?' }, NO_STORE]
  // (the same answer for a camera that is not theirs as for one that cannot be held: nothing is told)
  if (mayHd(b.nvr, b.ch) !== true) return [200, { held: false, why: 'not now' }, NO_STORE]
  return [200, holds.hold(viewer, b.nvr, b.ch), NO_STORE]
}
