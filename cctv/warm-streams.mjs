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
// ...and, beyond that, EVERY online camera of an NVR that is not refusing streams (roomy(nvrId)):
// an NVR takes 3.5 s on average to start a stream (up to 30 s), so any camera already streaming
// opens at once. An NVR that has refused a stream in the last 10 minutes (nvr-2 at its bandwidth
// budget) is left at the first-screen rule, so warm-ups never cost it a recording.
export const ALL_CAP = 200
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
  for (const c of cameras) {
    if (out.length >= ALL_CAP) break
    const k = `${c.nvr}/${c.ch}`
    if (c.online && c.configured !== false && roomy(c.nvr) && !out.includes(k)) out.push(k)
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
export function startWarmStreams({ cameras, orders, streamOf, roomy = null, log = console.log, everyMs = EVERY_MS }) {
  const held = new Map() // key -> { stream, viewer }
  const run = () => {
    let want
    try {
      want = new Set(pickWarm({ cameras: cameras(), orders: orders(), roomy }))
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
    if (added) log(`[warm] keeping ${held.size} first-screen camera${held.size === 1 ? '' : 's'} streaming, ready for Live`)
  }
  const t = setInterval(run, everyMs)
  t.unref?.()
  setTimeout(run, 30_000).unref?.() // after the NVRs have logged in
  return { run, held }
}
