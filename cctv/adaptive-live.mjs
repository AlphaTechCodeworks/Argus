// Live video for remote viewers, at the best frame rate their connection and the server's uplink
// can carry.
//
// Who is remote: whoever reaches the server through Tailscale -- the public Funnel link arrives
// from tailscaled on this machine (127.0.0.1), a tailnet device from 100.64.0.0/10. Everyone on the
// local network gets the cameras' own streams, untouched, as before.
//
// Each remote viewer (one browser: its sockets grouped by session) sits on one LEVEL:
//   full   the camera's own stream, as on the local network
//   15     15 fps, re-encoded lighter (phone-live.mjs PhoneStream)
//   8      8 fps, lighter still
//   4      4 fps, the least that still shows movement
// Every 2 s the controller looks at each viewer's sockets. Video piling up on any of them (the
// socket's send buffer over PRESSURE_BYTES, or the send gate holding it back as over its cap) means that viewer's link cannot keep up: it goes down a level at once. Twenty seconds
// with nothing piling up and it goes back up one. On top of that, when all remote viewers together
// send more than the uplink budget (CCTV_WAN_BUDGET_MBPS, 20 by default), the viewer taking the most
// is stepped down first: one person on a good link must not starve everyone else.
//
// Viewers on the same level share one conversion per camera, so the cost follows the number of
// cameras being watched remotely, not the number of people watching. Conversions have their own cap
// (phone-live.mjs maxPhoneStreams); a viewer who cannot get a slot gets the camera's own stream.
import { PhoneStream, maxPhoneStreams } from './phone-live.mjs'
import { TranscodePool } from './transcode.mjs'

export const LEVELS = Object.freeze([
  { id: 'full' },
  // Quality first, then frame rate: a sharp picture at 15 fps beats a blocky one at 30, and the
  // first rounds (crf 30-34, 100-300 kbit/s) came out grainy and blocky, worst on the first frames.
  { id: '15', fps: 15, crf: 25, subKbps: 700, mainKbps: 2500 },
  { id: '8', fps: 8, crf: 27, subKbps: 450, mainKbps: 1500 },
  { id: '4', fps: 4, crf: 29, subKbps: 280, mainKbps: 900 }
])
export const TICK_MS = 2000
/** A socket with this much waiting to go out is a link that is not keeping up. */
export const PRESSURE_BYTES = 256 * 1024
/** Clean for this long before a viewer is tried one level up. */
export const CLIMB_AFTER_MS = 20_000
/** A level change is given this long to show its effect before another. */
export const SETTLE_MS = 4000

/** The uplink budget for all remote viewers together, in bytes per second. */
export function wanBudgetBps(env = process.env) {
  const m = Number(env.CCTV_WAN_BUDGET_MBPS)
  return (Number.isFinite(m) && m > 0 ? m : 20) * 1e6 / 8
}

/** Whether this address is a remote viewer (through Tailscale), not the local network. */
export function isRemoteAddress(addr) {
  const a = String(addr ?? '').replace(/^::ffff:/, '')
  if (a === '127.0.0.1' || a === '::1') return true // the Cloudflare tunnel (cloudflared) forwards from this machine
  const m = /^100\.(\d+)\./.exec(a)
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127) // 100.64.0.0/10, the tailnet
}

/**
 * The level a viewer starts on: the camera's own stream. Starting at 15 meant waiting for a conversion
 * to start before the first picture; the link shows within seconds whether it can carry more, and
 * the controller steps down at once if not. (An H.265 camera still gets its converted H.264 stream:
 * #streamFor.)
 */
export const startLevel = () => 0

/**
 * The next level for one viewer, from what its sockets showed this tick. Pure: the tests drive it.
 * @param {{ level: number, changedAt: number, cleanSince: number }} v
 * @param {{ pressure: boolean, now: number, overBudget?: boolean }} o
 * @returns {{ level: number, changedAt: number, cleanSince: number, why?: string }}
 */
export function nextLevel(v, { pressure, now, overBudget = false }) {
  const settled = now - v.changedAt >= SETTLE_MS
  const worst = LEVELS.length - 1
  if ((pressure || overBudget) && settled && v.level < worst) {
    return { level: v.level + 1, changedAt: now, cleanSince: now, why: pressure ? 'video backing up on its link' : 'the uplink budget is used up' }
  }
  if (pressure) return { ...v, cleanSince: now }
  if (v.level > 0 && settled && now - v.cleanSince >= CLIMB_AFTER_MS && !overBudget) {
    return { level: v.level - 1, changedAt: now, cleanSince: now, why: 'clean for 20 s' }
  }
  return v
}

/** One remote browser: its sockets and the level they are on. */
class Viewer {
  constructor(key, now) {
    this.key = key
    this.level = startLevel()
    this.changedAt = now
    this.cleanSince = now
    this.sockets = new Set() // { ws, nvrId, ch, type, source, stream }
    this.sentAt = 0
    this.sentBytes = 0
    this.bps = 0
  }
}

export class AdaptiveLive {
  constructor({ pool = new TranscodePool(maxPhoneStreams()), makeTranscoder, log = (l) => console.log(l), budgetBps = wanBudgetBps(), now = () => Date.now() } = {}) {
    Object.assign(this, { pool, makeTranscoder, log, budgetBps, now })
    this.viewers = new Map() // key -> Viewer
    this.streams = new Map() // `${nvr}/${ch}/${type}@${level}` -> PhoneStream
    this.timer = null
  }

  /** Where a socket's frames come from at this level: a shared thinned stream, or the camera's own. */
  #streamFor(entry, level) {
    // the camera's own stream where this device can play it: H.264 always; H.265 only for a device
    // that said it can (&h265=1) -- half the data of H.264 for the same picture. Otherwise an H.265
    // camera is converted at the next level, never sent raw to a laptop that would show black.
    if (level === 0 && entry.source.gop?.[0]?.[1] === 1 && !entry.clientH265) level = 1
    if (level === 0) return entry.source
    const key = `${entry.nvrId}/${entry.ch}/${entry.type}@${LEVELS[level].id}`
    let s = this.streams.get(key)
    if (!s || s.closed) {
      const slot = this.pool.acquire()
      if (!slot) return entry.source // no room for another conversion: the camera's own stream
      const L = LEVELS[level]
      s = new PhoneStream({ source: entry.source, type: entry.type, slot, makeTranscoder: this.makeTranscoder, log: this.log, fps: L.fps, crf: L.crf, subKbps: L.subKbps, mainKbps: L.mainKbps, onEmpty: () => this.streams.get(key) === s && this.streams.delete(key) })
      this.streams.set(key, s)
    }
    return s
  }

  /**
   * Takes a remote viewer's /live socket.
   * @param {string} viewerKey one per browser (the session), so all its tiles move together
   */
  attach(viewerKey, { ws, nvrId, ch, type, source, clientH265 = false }) {
    const now = this.now()
    let v = this.viewers.get(viewerKey)
    if (!v) this.viewers.set(viewerKey, (v = new Viewer(viewerKey, now)))
    const entry = { ws, nvrId, ch, type, source, clientH265, stream: null }
    entry.stream = this.#streamFor(entry, v.level)
    entry.stream.add(ws)
    v.sockets.add(entry)
    // bytes sent to this viewer, for the uplink budget and the Health page
    const send = ws.send.bind(ws)
    ws.send = (data, ...rest) => {
      v.sentBytes += data?.length ?? data?.byteLength ?? 0
      return send(data, ...rest)
    }
    ws.on?.('close', () => {
      entry.stream.remove(ws)
      v.sockets.delete(entry)
      if (v.sockets.size === 0) this.viewers.delete(viewerKey)
    })
    this.#start()
  }

  #move(v, level, why) {
    const from = LEVELS[v.level].id
    v.level = level
    for (const e of v.sockets) {
      const next = this.#streamFor(e, level)
      if (next === e.stream) continue
      e.stream.remove(e.ws)
      e.stream = next
      next.add(e.ws)
    }
    this.log(`[adaptive] ${v.key.slice(0, 8)}: ${from} -> ${LEVELS[level].id} (${why}; ${v.sockets.size} camera${v.sockets.size === 1 ? '' : 's'})`)
  }

  /** One look at every remote viewer. */
  tick() {
    const now = this.now()
    let total = 0
    for (const v of this.viewers.values()) {
      const dt = v.sentAt ? (now - v.sentAt) / 1000 : 0
      v.bps = dt > 0 ? v.sentBytes / dt : 0
      v.sentBytes = 0
      v.sentAt = now
      total += v.bps
    }
    // over the budget: the one taking most goes down first
    const heaviest = total > this.budgetBps ? [...this.viewers.values()].sort((a, b) => b.bps - a.bps)[0] : null
    for (const v of this.viewers.values()) {
      // overSince: backpressure.mjs gateSend sets it while the socket is over its cap (and clears it
      // once it drains). waitForKey is not used: a move sets it on purpose. A /live-mux channel's own
      // bufferedAmount is only its part of the page's socket: the whole socket's queue
      // (sharedBufferedAmount) is what every tile of the page waits behind.
      const pressure = [...v.sockets].some((e) => (e.ws.sharedBufferedAmount ?? e.ws.bufferedAmount ?? 0) > PRESSURE_BYTES || e.ws.overSince != null)
      const n = nextLevel(v, { pressure, now, overBudget: v === heaviest })
      if (n.level !== v.level) this.#move(v, n.level, n.why)
      // The camera's own stream only where it is H.264: an H.265 one would be black on a laptop
      // without the HEVC codec (#streamFor converts it). A camera found to be H.265 only after its
      // socket was attached (no keyframe seen yet then) moves to its conversion here -- that socket
      // alone. This used to move the whole viewer to 15 fps: every tile of the browser went through
      // a conversion because one full-screen main stream was H.265 (slow starts, 15 fps, the
      // converters swamped: 'full -> 15 (undefined; 66 cameras)' in the log, 2026-09-26).
      else if (v.level === 0) {
        for (const e of v.sockets) {
          const want = this.#streamFor(e, 0)
          if (want === e.stream) continue
          e.stream.remove(e.ws)
          e.stream = want
          want.add(e.ws)
        }
      }
      v.changedAt = n.changedAt
      v.cleanSince = n.cleanSince
    }
    this.lastTotalBps = total
  }

  #start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      try { this.tick() } catch (e) { this.log(`[adaptive] ${e.message}`) }
    }, TICK_MS)
    this.timer.unref?.()
  }

  /** For the Health page: the remote viewers, their levels and what they are sent. */
  summary() {
    const viewers = [...this.viewers.values()].map((v) => ({ level: LEVELS[v.level].id, cameras: v.sockets.size, bps: Math.round(v.bps) }))
    return {
      viewers,
      remoteBps: Math.round(viewers.reduce((a, v) => a + v.bps, 0)),
      budgetBps: this.budgetBps,
      conversions: [...this.streams.values()].filter((s) => !s.closed && !s.passthrough).length,
      conversionCap: this.pool.max
    }
  }
}
