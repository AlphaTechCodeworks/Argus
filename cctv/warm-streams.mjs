// Each user's first screen of cameras, streaming before anyone opens Live, so the picture is there
// the moment the page is.
//
// A camera nobody is watching is not streaming, and the first viewer waits for the NVR to start it
// (seconds, on a busy NVR). The server knows each user's camera order (user-prefs.mjs), so it keeps
// the sub-streams of each user's first FIRST_SCREEN cameras running, at most CAP in all -- the
// sub-streams are small, but nvr-2 refuses streams once its bandwidth budget is spent, so this is
// kept to what makes a difference: the screen people open first. Re-read every minute; a camera
// that drops off the list is let go (and lingers the usual 3 minutes, stream-hub.mjs).
export const FIRST_SCREEN = 9
export const CAP = 16
// ...and, beyond that, up to PER_NVR online cameras of each NVR that is not refusing streams
// (roomy(nvrId)): an NVR takes 3.5 s on average to start a stream (up to 30 s), so a camera
// already streaming opens at once. Every extra sub-stream is also pulled by the NVR from its
// camera: with all 29 of value4u's warmed at once it refused streams and four cameras dropped off
// it. So at most PER_NVR each, and an NVR that refuses is left at the first-screen rule for
// STAY_OUT_MS (startWarmStreams), not warmed again ten quiet minutes later.
export const ALL_CAP = 200
export const PER_NVR = 16
export const STAY_OUT_MS = 6 * 60 * 60_000
const EVERY_MS = 60_000

/**
 * Which cameras to keep ready: each user's first screen in their own order (the default order for
 * a user who has none), online ones only, the first users' first, at most `cap`. Pure.
 * @param {{ cameras: {nvr:string,ch:number,online:boolean,configured?:boolean}[], orders: Record<string,string[]> }} o
 * @returns {string[]} "nvr/ch" keys
 */
export function pickWarm({ cameras, orders, perUser = FIRST_SCREEN, cap = CAP, roomy = null }) {
  const first = pickFirst({ cameras, orders, perUser, cap })
  if (!roomy) return first
  const out = [...first]
  const per = new Map()
  for (const k of out) per.set(k.slice(0, k.lastIndexOf('/')), (per.get(k.slice(0, k.lastIndexOf('/'))) ?? 0) + 1)
  for (const c of cameras) {
    if (out.length >= ALL_CAP) break
    const k = `${c.nvr}/${c.ch}`
    if (!c.online || c.configured === false || out.includes(k) || (per.get(c.nvr) ?? 0) >= PER_NVR || !roomy(c.nvr)) continue
    out.push(k)
    per.set(c.nvr, (per.get(c.nvr) ?? 0) + 1)
  }
  return out
}

function pickFirst({ cameras, orders, perUser, cap }) {
  const live = cameras.filter((c) => c.online && c.configured !== false)
  const known = new Set(live.map((c) => `${c.nvr}/${c.ch}`))
  const defaultOrder = live.map((c) => `${c.nvr}/${c.ch}`)
  const users = Object.values(orders)
  const lists = users.length ? users : [[]]
  const out = []
  for (const saved of lists) {
    // a saved order lists the cameras the user moved; the rest follow in the default order
    const order = [...saved.filter((k) => known.has(k)), ...defaultOrder.filter((k) => !saved.includes(k))]
    for (const k of order.slice(0, perUser)) {
      if (out.length >= cap) return out
      if (!out.includes(k)) out.push(k)
    }
  }
  return out
}

/** The stream's quiet viewer: takes the frames, sends them nowhere. */
const quietViewer = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, send() {}, on() {} })

/**
 * Keeps the picked sub-streams running.
 * @param {{ cameras: () => object[], orders: () => object, streamOf: (nvrId: string, ch: number) => {add: Function, remove: Function}|null, log?: Function }} o
 */
export function startWarmStreams({ cameras, orders, streamOf, roomy = null, log = console.log, everyMs = EVERY_MS, now = Date.now }) {
  const held = new Map() // key -> { stream, viewer }
  // an NVR that refused is kept out of the extra warm-up for STAY_OUT_MS, not just while it refuses
  const outUntil = new Map()
  const calm = roomy && ((id) => {
    const t = now()
    if (!roomy(id)) {
      if (!outUntil.has(id) || outUntil.get(id) <= t) log(`[warm] ${id} is refusing streams: only its first-screen cameras are kept ready for the next ${STAY_OUT_MS / 3_600_000} h`)
      outUntil.set(id, t + STAY_OUT_MS)
      return false
    }
    return (outUntil.get(id) ?? 0) <= t
  })
  const run = () => {
    let want
    try {
      want = new Set(pickWarm({ cameras: cameras(), orders: orders(), roomy: calm }))
    } catch (e) {
      return log(`[warm] ${e.message}`)
    }
    for (const [k, h] of held) {
      if (want.has(k)) continue
      h.stream.remove(h.viewer)
      held.delete(k)
    }
    let added = 0
    for (const k of want) {
      if (held.has(k)) continue
      const i = k.lastIndexOf('/')
      const stream = streamOf(k.slice(0, i), Number(k.slice(i + 1)))
      if (!stream) continue
      const viewer = quietViewer()
      viewer.background = true // (a real viewer's start goes ahead of this one)
      stream.add(viewer)
      held.set(k, { stream, viewer })
      added++
    }
    if (added) log(`[warm] keeping ${held.size} camera${held.size === 1 ? '' : 's'} streaming, ready for Live`)
  }
  const t = setInterval(run, everyMs)
  t.unref?.()
  setTimeout(run, 10_000).unref?.() // after the video logins (~4.5 s); viewers still go first
  return { run, held }
}
