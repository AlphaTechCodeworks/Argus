// NVR fallback legs for server playback (phase 3, R7): the stretches the server has no recording of
// are played from the NVR inside the same /playback socket, in server time, so the browser sees one
// stream.
//
// nvrCoverage(): what the NVR has recorded of one camera in a window, in SERVER time. It uses the
//   NVR's own search (playback.mjs recordings(): one NVR-local day per call) and keeps each day's
//   answer: today's for ttlTodayMs, older days' for ttlPastMs; calls at the same time share one
//   search, and a failed search is not kept. The NVR's clock differs from the server's by skewMs
//   (nvr1 runs about 3 min 40 s fast): NVR times are converted with -skewMs. It never throws: an NVR
//   that is offline, recovering (degraded), busy (NvrBusy) or failing gives { ranges: [], reason }.
//   It never calls the NVR's clock when the last clock read is known (playback.mjs lastClock()).
//   Its clock reads and searches are background work (playback.mjs recordings { background }): nobody
//   waits on one, and one that came back late held all playback and searches of that NVR for 60 s.
//
// startLeg(): one NVR playback (playback.mjs PlaybackSession, unchanged: its own pacing, speeds 1-8,
//   flow control and login) run through a proxy WebSocket. The proxy converts what the session sends:
//   - frames: the time (int64 µs at offset 8) is rewritten to server time in a copy and the frame goes
//     straight to the browser's socket. The first frame at or after toMs (where the server's footage
//     starts again) ends the leg and is not sent. With floorMs (a hole between two server files),
//     frames at or before it (already shown from the server) are dropped and the leg starts at the
//     next keyframe.
//   - {type:'started'} becomes {type:'started', gen, at, src:'nvr'} for a start or seek (gen given),
//     else {type:'source', src:'nvr', from, to}; the first frame announces it too if it comes first.
//   - {type:'stream'} passes as is; {type:'end'} and {type:'error'} end the leg (not forwarded).
//   - the proxy's bufferedAmount is the browser socket's, so the session's flow control still works.
//   command() passes {speed} (at most 8, as the session accepts; never reverse) and {pause} to the
//   session. close() fires the proxy's 'close' handler, which is how the session stops its NVR
//   playback and frees its login; nothing from the leg is forwarded after that. Ending for any
//   reason does the same, and `done` resolves once: { reason: 'reached'|'end'|'error'|'closed',
//   message?, frames, lastTs, announced }.
//   h265 (default true) is the browser's answer to "can you decode H.265", passed on as &h265=0|1:
//   with false the session converts the NVR's H.265 to H.264 (transcode.mjs), taking a slot of its own.
//
// This module does not import playback.mjs or sdk.mjs (koffi): NvrBusy is recognised by its name.

const DAY_MS = 86_400_000
const JOIN_MS = 2000 // NVR ranges closer than this are one stretch (a day's search ends 1 s before midnight)
const MAX_DAYS = 8 // days searched for one window at most
const NVR_SPEEDS = [1, 2, 4, 8] // what the NVR session accepts (playback.mjs)
const HEADER_SIZE = 16

/** The fallback legs ServerPlayback uses (rec-playback.mjs `legs`). */
export const nvrLegs = Object.freeze({ coverage: nvrCoverage, start: startLeg })

// ---- coverage ----------------------------------------------------------------------------------------

const caches = new WeakMap() // nvr -> Map(`${ch}/${date}` -> { at, ttl, promise })
const localDate = (ms, tz) => new Date(ms + tz).toISOString().slice(0, 10)
const nextDate = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)
const busyReason = 'the NVR is busy'
const reasonOf = (e, what) => (e?.name === 'NvrBusy' ? busyReason : `${what} (${e?.message ?? e})`)

/**
 * The NVR's recordings of one camera within [fromMs, toMs], in server time (see the top).
 * @param {{ online: boolean, degraded?: boolean, playback: { lastClock: Function, clock: Function, recordings: Function } }} nvr
 * @param {{ now?: (() => number)|number, ttlTodayMs?: number, ttlPastMs?: number }} [opts] now: this server's clock (ms)
 * @returns {Promise<{ ranges: number[][], reason?: string, skewMs?: number, tzOffsetMs?: number }>}
 */
export async function nvrCoverage(nvr, ch, fromMs, toMs, { now = Date.now, ttlTodayMs = 60_000, ttlPastMs = 600_000 } = {}) {
  if (!nvr?.online) return { ranges: [], reason: 'the NVR is offline' }
  if (nvr.degraded) return { ranges: [], reason: busyReason }
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return { ranges: [] }
  let clock
  try {
    clock = nvr.playback.lastClock?.() ?? null
    if (!clock) clock = await nvr.playback.clock({ background: true })
  } catch (e) {
    return { ranges: [], reason: reasonOf(e, 'the NVR clock could not be read') }
  }
  const tz = Number.isFinite(clock?.tzOffsetMs) ? clock.tzOffsetMs : 0
  const skew = Number.isFinite(clock?.skewMs) ? clock.skewMs : 0
  const t = typeof now === 'function' ? now() : Number(now)
  let cache = caches.get(nvr)
  if (!cache) caches.set(nvr, (cache = new Map()))
  for (const [k, v] of cache) if (t - v.at >= v.ttl) cache.delete(k)
  // the NVR-local days the window covers, on the NVR's clock; none after its today
  const today = localDate(t + skew, tz)
  const days = []
  for (let d = localDate(fromMs + skew, tz), last = localDate(toMs + skew, tz); d <= last && d <= today && days.length < MAX_DAYS; d = nextDate(d)) days.push(d)
  let lists
  try {
    lists = await Promise.all(days.map((d) => dayRanges(nvr, cache, ch, d, d === today ? ttlTodayMs : ttlPastMs, t)))
  } catch (e) {
    return { ranges: [], reason: reasonOf(e, 'the NVR search failed'), skewMs: skew, tzOffsetMs: tz }
  }
  const spans = lists
    .flat()
    .map(([s, e]) => [s - skew, e - skew])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [s, e] of spans) {
    const last = merged.at(-1)
    if (last && s <= last[1] + JOIN_MS) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  const ranges = merged.map(([s, e]) => [Math.max(s, fromMs), Math.min(e, toMs)]).filter(([s, e]) => e > s)
  return { ranges, skewMs: skew, tzOffsetMs: tz }
}

/** One NVR-local day's recorded ranges (NVR clock), from the cache or one search shared by all callers. */
function dayRanges(nvr, cache, ch, date, ttl, t) {
  const key = `${Number(ch)}/${date}`
  const hit = cache.get(key)
  if (hit && t - hit.at < hit.ttl) return hit.promise
  const promise = Promise.resolve()
    .then(() => nvr.playback.recordings(ch, date, { background: true }))
    .then((r) => (Array.isArray(r?.ranges) ? r.ranges : []))
  const entry = { at: t, ttl, promise }
  cache.set(key, entry)
  promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key) // a failure is not kept
  })
  return promise
}

// ---- legs --------------------------------------------------------------------------------------------

/**
 * Starts an NVR playback of [fromMs, toMs] (server time) for the browser socket `real` (see the top).
 * @param {{ nvr: object, ch: number, fromMs: number, toMs: number, stream?: number, speed?: number,
 *   paused?: boolean, skewMs?: number, real: object, gen?: number|null, at?: number,
 *   floorMs?: number|null, startTimeoutMs?: number, h265?: boolean, fit?: object|null }} opts
 *   gen: the generation of a start or seek (announced with {type:'started'}); null: a hole between two
 *   server files ({type:'source'}); at: the time the browser shows first (default fromMs);
 *   floorMs: the last frame the browser already has; startTimeoutMs: the session must have started by then;
 *   h265: the browser can decode H.265 (false: the NVR session converts it to H.264, as the server does);
 *   fit: the viewer is remote and the leg is fitted to the link as the server playback around it is
 *   (playback.mjs PlaybackSession's `fit`: { slot } the run's conversion slot, lent; or { kbps } for the
 *   session to decide by itself, which it then says with {type:'fit'}, passed on). null (the local
 *   network, backfill): the NVR's own bytes, as before (1 Oct 2026, the playback hunt's finding F6:
 *   a remote viewer's leg went through the tunnel at 6.3 Mbit/s)
 * @returns {{ command: (obj: object) => void, close: () => void, done: Promise<object>,
 *   announced: boolean, frames: number, lastTs: number|null, fromMs: number, toMs: number }}
 */
export function startLeg({ nvr, ch, fromMs, toMs, stream = 0, speed = 1, paused = false, skewMs = 0, real, gen = null, at = fromMs, floorMs = null, startTimeoutMs = 20_000, h265 = true, fit = null }) {
  const skew = Number.isFinite(skewMs) ? skewMs : 0
  const skewUs = BigInt(Math.round(skew * 1000))
  const handlers = {}
  const state = { announced: false, frames: 0, lastTs: null, finished: false }
  let needKey = true
  let lastError = null
  let resolveDone
  const done = new Promise((resolve) => (resolveDone = resolve))
  let timer = null

  const toReal = (obj) => {
    if (real.readyState === real.OPEN) real.send(JSON.stringify(obj))
  }
  const announce = () => {
    if (state.announced) return
    state.announced = true
    clearTimeout(timer)
    toReal(gen !== null && gen !== undefined ? { type: 'started', gen, at, src: 'nvr' } : { type: 'source', src: 'nvr', from: fromMs, to: toMs })
  }
  /** The session's socket closes: its 'close' handler stops the NVR playback and frees the login. */
  const shut = () => {
    if (proxy.readyState !== proxy.OPEN) return
    proxy.readyState = proxy.CLOSED
    try {
      handlers.close?.(1000, '')
    } catch {}
  }
  const finish = (r) => {
    if (state.finished) return
    state.finished = true
    clearTimeout(timer)
    shut()
    resolveDone({ ...r, frames: state.frames, lastTs: state.lastTs, announced: state.announced })
  }
  const toSession = (obj) => {
    try {
      handlers.message?.(Buffer.from(JSON.stringify(obj)), false)
    } catch {}
  }

  const onText = (text) => {
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    switch (msg?.type) {
      case 'started':
        return announce()
      case 'stream':
      case 'fit': // (a remote viewer's leg that decided for itself: converted, as it is, or none to spare)
        return toReal(msg)
      case 'end':
        return finish({ reason: 'end' })
      case 'error':
        lastError = String(msg.message ?? 'playback failed')
        return finish({ reason: 'error', message: lastError })
    }
  }
  const onFrame = (m) => {
    if (m.length < HEADER_SIZE) return
    const us = m.readBigInt64LE(8) - skewUs
    const ts = Number(us) / 1000
    if (ts >= toMs) return finish({ reason: 'reached' }) // the server's footage starts here
    if (floorMs !== null && floorMs !== undefined && ts <= floorMs) return // the browser has it already
    if (needKey) {
      if ((m[0] & 1) !== 1) return // not decodable without the keyframe before it
      needKey = false
    }
    announce()
    if (real.readyState !== real.OPEN) return
    const out = Buffer.from(m) // a copy: the session's buffer stays as it was
    out.writeBigInt64LE(us, 8)
    real.send(out)
    state.frames++
    state.lastTs = ts
  }

  const proxy = {
    OPEN: 1,
    CLOSED: 3,
    readyState: 1,
    get bufferedAmount() {
      return real.bufferedAmount ?? 0
    },
    on(event, fn) {
      handlers[event] = fn
      return proxy
    },
    send(data) {
      if (state.finished || proxy.readyState !== proxy.OPEN) return
      if (typeof data === 'string') onText(data)
      else onFrame(Buffer.isBuffer(data) ? data : Buffer.from(data))
    },
    /** The session gave up (an error, a full buffer, the NVR reconnecting or removed). */
    close(code, reason) {
      if (proxy.readyState !== proxy.OPEN) return
      finish({ reason: 'error', message: lastError ?? (reason || `closed (${code ?? 1000})`) })
    }
  }

  function command(obj) {
    if (state.finished || !obj || typeof obj !== 'object') return
    if ('speed' in obj) {
      const s = Number(obj.speed)
      if (s > 0) toSession({ speed: NVR_SPEEDS.filter((v) => v <= s).at(-1) ?? 1 })
    }
    if ('pause' in obj) toSession({ pause: Boolean(obj.pause) })
  }

  if (startTimeoutMs > 0) {
    timer = setTimeout(() => {
      if (!state.announced) finish({ reason: 'error', message: 'the NVR did not start playing in time' })
    }, startTimeoutMs)
  }
  // h265 always said, as the page says it: playback.mjs takes a missing one as "can decode", and a leg's
  // raw H.265 sent to a browser without a decoder kills the player ("install HEVC") mid-playback.
  // Only an explicit false converts, so backfill (which stores the NVR's own bytes) never gets H.264.
  const url = new URL(`ws://x/playback?nvr=${encodeURIComponent(nvr.id)}&ch=${Number(ch)}&stream=${Number(stream)}&start=${Math.round(fromMs + skew)}&h265=${h265 === false ? 0 : 1}`)
  try {
    // A leg is part of a server playback, whose viewer holds Playback HD (and Playback SD, or there
    // would be no legs): main pictures are theirs to see. Backfill is this server's own copy.
    nvr.playback.connect(proxy, url, { main: Number(stream) === 0, allowMain: () => true, fit })
  } catch (e) {
    finish({ reason: 'error', message: e?.message ?? String(e) })
  }
  // what the viewer chose before the leg: the session takes commands before it has opened
  if (!state.finished && speed !== 1) command({ speed })
  if (!state.finished && paused) command({ pause: true })

  return {
    command,
    close: () => finish({ reason: 'closed' }),
    done,
    fromMs,
    toMs,
    get announced() {
      return state.announced
    },
    get frames() {
      return state.frames
    },
    get lastTs() {
      return state.lastTs
    }
  }
}
