// Replays live video arrivals through the real player (public/player.js) and its playout clock
// (public/playout.js), in virtual time, and measures what is shown: the share of frames shown,
// freezes, holds, skips, how far the picture stepped back, and the delay. The yardstick for any change
// meant to make live video smoother: run it before and after on the same traces.
//
// Moved into the repo from the 29 Sep stutter investigation's scratch harness (evc-harness.mjs,
// the replays behind the stutter report and its verdicts), unchanged in what it models:
//   - the page: performance.now, the display (present() at 60 Hz), the player's once-a-second
//     timer, all on a virtual clock; the player made as live-tile.js makes it (paintFirst,
//     arrivalClock), unless playerOptions say otherwise;
//   - the decoder: a stand-in for the viewing PC's. Chrome's hardware decoder on the owner's PC
//     hands the page at most `pool` decoded pictures (6 at 2560x1440) and decodes nothing more
//     until the page closes one; each decode takes `decodeMs`. `inFlight` is how many frames the
//     decoder takes in before its decodeQueueSize counts them: 0 in the scratch harness, about 5 in
//     real Chrome on that PC (verify-2: a 20-frame burst read 15).
// What it is fed: a frame trace, as the Live page's D overlay records one (public/frame-trace.js,
// "argus-frame-trace" v1), or arrivals from a model (arrivals(), switchArrivals()). The fixtures,
// test/fixtures/live-replay/*.json, are modelled traces in the recorder's format (FIXTURES below; no
// real trace existed yet on 29 Sep): a real trace can be dropped in beside them and replayed the same
// way. Every frame keeps its capture time; nothing here invents one.
//
// A gain is reported on both decoder models: the default (decoderFor: inFlight 0, the scratch
// harness's, about 3 times too gloomy against real Chrome on the owner's PC, verify-2) and the
// Chrome-like one ({ ...decoderFor(tile), inFlight: 5 }); live-replay.test.mjs pins today's numbers
// on both. One replay at a time: play() and playTile() run on one virtual page, so await each one
// (a Promise.all over a trace's tiles is refused).
//
// From a test:
//   import { readTrace, playTile, fixtureTrace } from './live-replay.mjs'
//   const r = await playTile(fixtureTrace('tunnel-stall').tiles[0], { decoder: { pool: 16, decodeMs: 3 } })
// From the command line, one row per tile (the fixtures when no file is named):
//   node cctv/test/live-replay.mjs [trace.json ...] [--player path/to/player.js] [--pool N]
//     [--decode-ms N] [--in-flight N] [--clock '{"startDelayMs":350}'] [--max-fps 15]
//     [--player-options '{"arrivalClock":false}'] [--remote]
//   --remote: as a page through the tunnel plays it (REMOTE_LIVE; a trace recorded on such a page says
//     page.remote: true); --clock and --player-options go over it
//   node cctv/test/live-replay.mjs --write-fixtures   (makes the fixtures again from FIXTURES)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { REMOTE_CLOCK } from '../public/playout.js'
import { REMOTE_QUEUED_FRAMES } from '../public/player.js'

export const REPO_PLAYER = new URL('../public/player.js', import.meta.url).href
export const FIXTURE_DIR = new URL('./fixtures/live-replay/', import.meta.url)
const TRACE_FORMAT = 'argus-frame-trace' // public/frame-trace.js
/**
 * What a page opened through the tunnel or the tailnet gives its tiles (viewer.js, device.js
 * isLocalHost): the remote playout clock and room for 2 s of decoded frames. Spread into play() or
 * playTile() to replay a trace as such a page plays it; a local page's is the default (nothing).
 */
export const REMOTE_LIVE = Object.freeze({ clock: REMOTE_CLOCK, playerOptions: Object.freeze({ maxQueuedFrames: REMOTE_QUEUED_FRAMES }) })
const TS0 = 1_700_000_000_000 // capture times handed to the player are epoch ms, as the camera's are
const REFRESH_MS = 1000 / 60
const STEP_MS = 0.5

// ---- the page, in virtual time (installed only while play() runs) --------------------------------

let vnow = 0
const intervals = []
const decoders = []
let decoderModel = { pool: Infinity, decodeMs: 4, inFlight: 0 }
let playing = false // play() is running: one replay at a time

class Frame {
  constructor(dec, timestamp) {
    this.dec = dec
    this.timestamp = timestamp
    this.displayWidth = this.codedWidth = 1280
    this.displayHeight = this.codedHeight = 720
    this.visibleRect = { x: 0, y: 0, width: 1280, height: 720 }
    this.closed = false
    dec.open++
  }
  clone() { return new Frame(this.dec, this.timestamp) }
  close() {
    if (this.closed) return
    this.closed = true
    this.dec.open--
  }
}
class FakeDecoder {
  static async isConfigSupported(config) { return { supported: true, config } }
  constructor({ output }) {
    this.output = output
    this.state = 'unconfigured'
    this.pending = []
    this.busy = null // { chunk, doneAt }: the frame being decoded
    this.open = 0 // decoded pictures the page holds (not closed)
    this.fed = 0
    decoders.push(this)
  }
  // what the player sees waiting: all but the first `inFlight` the decoder has taken in
  get decodeQueueSize() { return Math.max(0, this.pending.length + (this.busy ? 1 : 0) - decoderModel.inFlight) }
  configure() { this.state = 'configured' }
  decode(chunk) {
    this.fed++
    this.pending.push(chunk)
  }
  reset() {
    this.pending = []
    this.busy = null
    this.state = 'unconfigured'
  }
  close() {
    this.reset()
    this.state = 'closed'
  }
  /** Decodes on at `now`: one frame at a time, and only into a free picture. */
  pump(now) {
    let progress = true
    while (progress && this.state === 'configured') {
      progress = false
      if (this.busy && now >= this.busy.doneAt) {
        const { chunk } = this.busy
        this.busy = null
        this.output(new Frame(this, chunk.timestamp))
        progress = true
      }
      if (!this.busy && this.pending.length && this.open < decoderModel.pool) {
        this.busy = { chunk: this.pending.shift(), doneAt: now + decoderModel.decodeMs }
        progress = true
      }
    }
  }
}
const STUBS = {
  performance: { now: () => vnow },
  window: { devicePixelRatio: 1 },
  requestAnimationFrame: () => 1, // present() is called by play() at 60 Hz
  ResizeObserver: class { observe() {} disconnect() {} },
  EncodedVideoChunk: class { constructor(init) { Object.assign(this, init) } },
  setInterval: (fn) => intervals.push(fn), // the player's once-a-second timer, run every virtual second
  clearInterval: () => {},
  VideoDecoder: FakeDecoder
}
/** Puts the virtual page in place; the returned function puts back what was there. */
function installPage() {
  const saved = Object.keys(STUBS).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)])
  for (const [k, v] of Object.entries(STUBS)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d)
      else delete globalThis[k]
    }
  }
}
const canvas = () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), getBoundingClientRect: () => ({ width: 1280, height: 720 }) })

// ---- arrival models --------------------------------------------------------------------------------

/** A seeded random number generator (the scratch harness's): the same seed, the same arrivals. */
export function rng(seed) {
  let s = seed >>> 0 || 1
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
}

/**
 * Modelled live arrivals: frame i captured at i*1000/fps, ready to leave the far end `base` ms later
 * (plus up to `jitter`), a keyframe every gopMs; then any of
 *   nvr:    the NVR pauses delivery U(lo,hi) ms about every `every` ms and sends what it held in a burst
 *   burst:  the tunnel releases what it has every U(lo,hi) ms (arrivals clumped into bursts)
 *   hol:    about every `every` ms nothing arrives for U(lo,hi) ms (another tile's big keyframe ahead
 *           on the page's one shared socket, at a few Mbit/s)
 *   stall:  about every `every` ms nothing arrives for `ms` (a tunnel hiccup)
 * Arrivals stay in order (one socket), at least 0.3 ms apart.
 * @returns {{ at: number, ts: number, isKey: boolean }[]} arrival and capture times in ms
 */
export function arrivals({ fps, durMs, gopMs = 2000, base = 50, jitter = 5, nvr = null, burst = null, hol = null, stall = null, seed = 7 }) {
  const r = rng(seed)
  const F = 1000 / fps
  const n = Math.floor(durMs / F)
  const U = (lo, hi) => lo + r() * (hi - lo)
  const blocks = []
  if (hol) for (let t = hol.every * (0.5 + r()); t < durMs + 5000; t += hol.every) blocks.push([t, t + U(hol.lo, hol.hi)])
  if (stall) for (let t = stall.every * (0.3 + 0.7 * r()); t < durMs + 5000; t += stall.every * (0.7 + 0.6 * r())) blocks.push([t, t + stall.ms])
  blocks.sort((a, b) => a[0] - b[0])
  const nvrPauses = []
  if (nvr) for (let t = nvr.every * (0.5 + r()); t < durMs + 5000; t += nvr.every * (0.8 + 0.4 * r())) nvrPauses.push([t, t + U(nvr.lo, nvr.hi)])
  let releases = null
  if (burst) {
    releases = []
    for (let t = 0; t < durMs + 10_000; t += U(burst.lo, burst.hi)) releases.push(t)
  }
  const out = []
  let ri = 0
  let last = -Infinity
  const keyEvery = Math.max(1, Math.round(gopMs / F))
  for (let i = 0; i < n; i++) {
    const cap = i * F
    let t = cap + base + r() * jitter
    for (const [s, e] of nvrPauses) if (cap >= s && cap < e) t = Math.max(t, e + base)
    if (releases) {
      while (ri < releases.length && releases[ri] < t) ri++
      t = releases[ri] ?? t
    }
    for (const [s, e] of blocks) if (t >= s && t < e) t = e
    t = Math.max(t, last + 0.3)
    last = t
    out.push({ at: t, ts: cap, isKey: i % keyEvery === 0 })
  }
  return out
}

/** The networks the stutter investigation modelled (evc-run*.mjs), for arrivals(). */
export const NETS = Object.freeze({
  lan: {},
  tunnel: { burst: { lo: 200, hi: 400 } },
  'tunnel+nvr': { burst: { lo: 200, hi: 400 }, nvr: { every: 3000, lo: 300, hi: 450 } },
  'tunnel+hol': { burst: { lo: 200, hi: 400 }, hol: { every: 2000, lo: 300, hi: 900 } },
  'tunnel+stall': { burst: { lo: 200, hi: 400 }, stall: { every: 20_000, ms: 1200 } }
})

/**
 * A tile whose stream is swapped for another at `switchAt` (an adaptive-live level change): the new
 * stream's first frame is its keyframe, `gapToKeyMs` older than the last frame the old one sent; it
 * arrives `startMs` later with every frame from that keyframe on in one burst (`spacing` ms apart),
 * then live. The stutter report's 2.5 case (evc-run3.mjs).
 */
export function switchArrivals({ fps, switchAt = 30_000, gapToKeyMs, startMs, durMs = 60_000, spacing = 0.5 }) {
  const F = 1000 / fps
  const r = rng(3)
  const arr = []
  const base = 50
  const n = Math.floor(durMs / F)
  let i = 0
  for (; i * F < switchAt; i++) arr.push({ at: i * F + base + r() * 5, ts: i * F, isKey: i % Math.round(2000 / F) === 0 })
  const T = (i - 1) * F
  const K = T - gapToKeyMs
  const burstAt = switchAt + base + startMs
  let t = burstAt
  for (let ts = K; ts <= burstAt - base; ts += F) {
    arr.push({ at: t, ts, isKey: ts === K })
    t += spacing
  }
  const next = Math.floor((burstAt - base) / F) + 1
  for (let j = next; j < n; j++) arr.push({ at: Math.max(j * F + base + r() * 5, (t += 0.5)), ts: j * F, isKey: Math.round(j * F - K) % 2000 === 0 })
  return arr
}

// ---- traces ----------------------------------------------------------------------------------------

/** Reads a frame trace (a file public/frame-trace.js saved, or a fixture) and checks it is one. */
export function readTrace(path) {
  const trace = JSON.parse(readFileSync(path, 'utf8'))
  const bad = traceProblem(trace)
  if (bad) throw new Error(`${path}: not a frame trace (${bad})`)
  return trace
}

/** What is wrong with a trace, or null. */
export function traceProblem(t) {
  if (t?.format !== TRACE_FORMAT) return `format ${t?.format}`
  if (t.version !== 1) return `version ${t.version}`
  if (!Array.isArray(t.tiles)) return 'no tiles'
  for (const tile of t.tiles) {
    if (!Array.isArray(tile.frames) || !Array.isArray(tile.events)) return `tile ${tile.id}: no frames or events`
    for (let i = 0; i < tile.frames.length; i++) {
      const f = tile.frames[i]
      if (!Array.isArray(f) || f.length !== 4 || !f.every(Number.isFinite)) return `tile ${tile.id} frame ${i}: ${JSON.stringify(f)}`
      if (i > 0 && f[0] < tile.frames[i - 1][0]) return `tile ${tile.id} frame ${i}: arrives before the one before it`
    }
  }
  return null
}

/** A tile's frames as arrivals: { at, ts, isKey, bytes } (ms). */
export const tileArrivals = (tile) => tile.frames.map(([at, ts, bytes, key]) => ({ at, ts, isKey: key === 1, bytes }))

/**
 * The stretches a tile's player really played, each from a fresh start: its frames between the
 * connection's (re)opening and its close (the tile resets its player on a close), leaving out the
 * frames that came while it was suspended (hidden under the full-size view: kept, not decoded). A
 * hidden tile stays hidden across a reconnect (live-tile.js keeps `suspended`), and a trace started
 * over one says it is hidden first (frame-trace.js). On resume the tile decodes what it kept from its
 * last keyframe at once (live-tile.js resume): a new stretch that starts with those frames, all
 * arriving at the resume -- unless the trace says it had nothing fresh kept and connected again
 * ('resume', 'reconnect'), when the stretch starts empty and the new connection's frames follow. A
 * stretch starts when its connection opened (or the resume), or with its first frame when the trace
 * began mid-stream.
 * @returns {{ fromMs: number, arr: object[] }[]}
 */
export function segments(tile) {
  const arr = tileArrivals(tile)
  const marks = tile.events.filter((e) => ['connect', 'open', 'close', 'suspend', 'resume', 'end'].includes(e[1]))
  const out = []
  let cur = { fromMs: arr[0]?.at ?? 0, arr: [] }
  let suspended = false
  // the stream since its last keyframe, as the tile keeps it (live-tile.js #keep). Not dropped on a
  // close: the tile keeps it too, and the new connection's first frame, a keyframe, replaces it.
  let gop = null
  let mi = 0
  const cut = () => {
    if (cur.arr.length) out.push(cur)
  }
  const apply = (e) => {
    const [at, what, how] = e
    if ((what === 'connect' || what === 'open') && !suspended && !cur.arr.length) cur.fromMs = at
    else if (what === 'suspend' && !suspended) {
      cut()
      suspended = true
    } else if (what === 'resume' && suspended) {
      suspended = false
      // (a trace from before resume said which way: decoded what it kept, as it then always tried)
      cur = { fromMs: at, arr: how === 'reconnect' ? [] : (gop ?? []).map((f) => ({ ...f, at })) }
    } else if (what === 'close') {
      // the player is reset; a hidden tile stays hidden, and connects again to keep the stream
      if (!suspended) cut()
      cur = { fromMs: at, arr: [] }
    } else if (what === 'end') {
      if (!suspended) cut()
      suspended = false
      gop = null
      cur = { fromMs: at, arr: [] }
    }
  }
  for (const f of arr) {
    while (mi < marks.length && marks[mi][0] <= f.at) apply(marks[mi++])
    if (f.isKey) gop = [f]
    else gop?.push(f)
    if (!suspended) cur.arr.push(f)
  }
  while (mi < marks.length) apply(marks[mi++])
  if (!suspended) cut()
  return out
}

/** The stream's frame rate from its capture times (the median gap), for the measures. */
export function frameRateOf(arr) {
  const gaps = []
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i].ts - arr[i - 1].ts
    if (d > 0) gaps.push(d)
  }
  gaps.sort((a, b) => a - b)
  return gaps.length ? 1000 / gaps[gaps.length >> 1] : 0
}

/**
 * The decoder a tile is replayed with, when the caller names none: the owner's PC (Intel HD 4000):
 * 6 pictures at 2560x1440 and up, 8 ms a frame; otherwise 16 and 3 ms (the scratch harness's grid
 * sub). The size is the tile's last "size" event (a keyframe's header).
 */
export function decoderFor(tile) {
  const size = tile.events.filter((e) => e[1] === 'size').at(-1)
  return size && size[2] >= 2560 ? { pool: 6, decodeMs: 8, inFlight: 0 } : { pool: 16, decodeMs: 3, inFlight: 0 }
}

// ---- the replay ------------------------------------------------------------------------------------

/**
 * Plays arrivals through a VideoPlayer and measures what is shown (after warmMs).
 * @param {{ at: number, ts: number, isKey: boolean }[]} arr
 * @param {{ player?: string, clock?: object, maxFps?: number, playerOptions?: object,
 *   decoder?: { pool?: number, decodeMs?: number, inFlight?: number }, fps?: number, warmMs?: number,
 *   patch?: (player: object) => void }} [o]
 *   player: the URL of the player module (the repo's by default; a prototype copy to compare);
 *   clock: PlayoutClock options, as the Live page passes them (undefined: live's own);
 *   playerOptions: anything else for the VideoPlayer, over live-tile.js's own (paintFirst and
 *   arrivalClock; { arrivalClock: false } replays the clock as it was before 29 Sep, and as playback's
 *   still is); fps: the stream's, for the measures (by
 *   default from the capture times); from: when (in the arrivals' time) the player starts, 0 for a
 *   whole trace, a stretch's start for a stretch of one (playTile)
 * @returns the measures (see rates()), plus notDecoded (frames never handed to the decoder),
 *   dropped / late (the player's own counters, as the D overlay shows them), delayEnd and resyncs
 *   (its clock's), and counts (for adding stretches up)
 */
export async function play(arr, { player = REPO_PLAYER, clock, maxFps, playerOptions = {}, decoder = {}, fps = frameRateOf(arr), warmMs = 3000, patch, from = 0 } = {}) {
  // one virtual page, clock and set of decoders for the whole module: a second replay at the same
  // time would run on the first's, and put the real globals back under it
  if (playing) throw new Error('play() is not re-entrant: await each replay')
  playing = true
  const restore = installPage()
  try {
    const { VideoPlayer } = await import(player)
    vnow = from
    intervals.length = 0
    decoders.length = 0
    decoderModel = { pool: Infinity, decodeMs: 4, inFlight: 0, ...decoder }
    const shown = []
    const p = new VideoPlayer(canvas(), { clock, maxFps, paintFirst: true, arrivalClock: true, ...playerOptions, onFrame: (ts) => shown.push({ at: vnow, ts: ts - TS0 }) })
    patch?.(p)
    const end = (arr.at(-1)?.at ?? from) + 3000
    let k = 0
    let nextRefresh = from + REFRESH_MS
    let nextSecond = from + 1000
    for (vnow = from; vnow <= end; vnow += STEP_MS) {
      while (k < arr.length && arr[k].at <= vnow) {
        const a = arr[k++]
        p.push({ isKey: a.isKey, codecId: 0, timestampUs: Math.round((TS0 + a.ts) * 1000), data: new Uint8Array(8) })
        while (p.configuring) await new Promise((r) => setImmediate(r))
      }
      for (const d of decoders) d.pump(vnow)
      if (vnow >= nextRefresh) {
        nextRefresh += REFRESH_MS
        p.present(vnow)
        for (const d of decoders) d.pump(vnow)
      }
      if (vnow >= nextSecond) {
        nextSecond += 1000
        for (const fn of intervals) fn()
      }
    }
    const fed = decoders.reduce((a, d) => a + d.fed, 0)
    const counts = count(shown, { fps, warmFrom: from + warmMs, arr })
    const res = { ...rates(counts), notDecoded: arr.length - fed, dropped: p.stats.dropped, late: p.stats.late, delayEnd: p.clock.delay, resyncs: p.clock.resyncs, counts }
    p.close()
    return res
  } finally {
    restore()
    playing = false
  }
}

/** What was shown, as counts (from warmFrom on): rates() makes the measures of them, playTile() adds them up. */
function count(shown, { fps, warmFrom, arr }) {
  const F = 1000 / fps
  const s = shown.filter((x) => x.at >= warmFrom)
  const c = { shown: s.length, expected: 0, holds: 0, holdMs: 0, freezes: 0, maxStill: 0, skipEvents: 0, skipped: 0, backwards: 0, maxBack: 0, irregular: 0, steps: 0, spanMs: 0, errs: [], lat: [] }
  if (!s.length) return c
  c.expected = arr.filter((a) => a.ts >= s[0].ts && a.ts <= s.at(-1).ts).length
  c.spanMs = s.length > 1 ? s.at(-1).at - s[0].at : 0
  for (let i = 1; i < s.length; i++) {
    const dA = s[i].at - s[i - 1].at
    const dT = s[i].ts - s[i - 1].ts
    if (dT < 0) {
      c.backwards++
      c.maxBack = Math.max(c.maxBack, -dT)
    }
    // the picture stood still longer than the content says it should, by more than a refresh
    if (dA > Math.max(dT, F) + REFRESH_MS * 1.01) {
      c.holds++
      c.holdMs += dA - Math.max(dT, F)
    }
    if (dA >= 200) c.freezes++ // a still picture of 200 ms or more
    c.maxStill = Math.max(c.maxStill, dA)
    const miss = Math.round(dT / F) - 1
    if (miss > 0) {
      c.skipEvents++
      c.skipped += miss
    }
    const e = Math.abs(dA - dT)
    c.errs.push(e)
    if (e > REFRESH_MS * 1.01) c.irregular++
    c.steps++
  }
  // delay: from capture to on screen, in the trace's own time base. Exact for a modelled trace (its
  // capture and arrival times share one origin). In a recorded one the camera's clock and the
  // viewer's differ by a constant: compare runs on the same trace, not traces with each other.
  c.lat = s.map((x) => x.at - x.ts)
  return c
}

/**
 * The measures, from counts (one stretch, or several added up): shownPct (frames shown of those
 * captured over the time shown), holdsPerMin (the picture still longer than the content says, by
 * more than a refresh), skipEventsPerMin (frames left out), freezesPerMin (a still picture of 200 ms
 * or more), maxStillMs, irregularPct and p99ErrMs (on-screen steps that differ from the capture
 * steps), backwards and maxBackMs (the picture stepping back in time), medLatencyMs (see count()).
 */
function rates(c) {
  const min = c.spanMs > 0 ? c.spanMs / 60_000 : 1
  const errs = [...c.errs].sort((a, b) => a - b)
  const lat = [...c.lat].sort((a, b) => a - b)
  return {
    shownPct: c.expected ? Math.round((1000 * c.shown) / c.expected) / 10 : 0,
    holdsPerMin: +(c.holds / min).toFixed(1),
    skipEventsPerMin: +(c.skipEvents / min).toFixed(1),
    freezesPerMin: +(c.freezes / min).toFixed(1),
    maxStillMs: Math.round(c.maxStill),
    irregularPct: +((100 * c.irregular) / Math.max(1, c.steps)).toFixed(1),
    p99ErrMs: Math.round(errs[Math.floor(errs.length * 0.99)] ?? 0),
    backwards: c.backwards,
    maxBackMs: Math.round(c.maxBack),
    medLatencyMs: Math.round(lat[lat.length >> 1] ?? 0)
  }
}

/**
 * Replays one tile of a trace: each stretch its player really played (segments()), from a fresh
 * player, the measures over all of them. Stretches shorter than minMs are left out (too short to
 * measure past the warm-up).
 */
export async function playTile(tile, { decoder = decoderFor(tile), minMs = 10_000, ...o } = {}) {
  const parts = segments(tile).filter((s) => s.arr.at(-1).at - s.arr[0].at >= minMs)
  const all = { shown: 0, expected: 0, holds: 0, holdMs: 0, freezes: 0, maxStill: 0, skipEvents: 0, skipped: 0, backwards: 0, maxBack: 0, irregular: 0, steps: 0, spanMs: 0, errs: [], lat: [] }
  const extra = { notDecoded: 0, dropped: 0, late: 0, resyncs: 0 }
  for (const s of parts) {
    const r = await play(s.arr, { decoder, ...o, from: Math.floor(Math.min(s.fromMs, s.arr[0].at)) })
    for (const k of Object.keys(all)) {
      if (Array.isArray(all[k])) all[k].push(...r.counts[k])
      else if (k === 'maxStill' || k === 'maxBack') all[k] = Math.max(all[k], r.counts[k])
      else all[k] += r.counts[k]
    }
    for (const k of Object.keys(extra)) extra[k] += r[k]
  }
  return { ...rates(all), ...extra, stretches: parts.length }
}

// ---- the fixtures: modelled traces, in the recorder's format -----------------------------------------

const FIXTURE_MS = 120_000 // as long as a recorded trace (frame-trace.js TRACE_MS)
const CAPTURE0 = Date.UTC(2026, 8, 29, 4, 0, 0) // any camera time: the replay uses differences only
/**
 * The modelled traces: the stutter investigation's networks (NETS), seed 11, 2 minutes each, a 20 fps
 * grid sub-stream (704x480) on each and, on the local network, a 30 fps 2560x1440 main as well (the
 * full-size case whose decoder holds only 6 pictures). switch: a level change at 30 s onto a new
 * conversion whose keyframe is 1.5 s older than the last frame shown, starting 0.9 s later.
 */
export const FIXTURES = Object.freeze({
  lan: [{ net: 'lan', fps: 20, stream: 'sub', size: [704, 480] }, { net: 'lan', fps: 30, stream: 'main', size: [2560, 1440] }],
  'tunnel-nvr': [{ net: 'tunnel+nvr', fps: 20, stream: 'sub', size: [704, 480] }],
  'tunnel-hol': [{ net: 'tunnel+hol', fps: 20, stream: 'sub', size: [704, 480] }],
  'tunnel-stall': [{ net: 'tunnel+stall', fps: 20, stream: 'sub', size: [704, 480] }],
  switch: [{ switch: { fps: 20, gapToKeyMs: 1500, startMs: 900, durMs: 60_000, spacing: 4 }, fps: 20, stream: 'sub', size: [704, 480] }]
})

/** A modelled trace, in the format public/frame-trace.js writes. */
export function modelTrace(name, tiles = FIXTURES[name]) {
  return {
    format: TRACE_FORMAT,
    version: 1,
    startedAt: new Date(CAPTURE0).toISOString(),
    durationMs: Math.max(...tiles.map((t) => t.switch?.durMs ?? FIXTURE_MS)),
    truncated: false,
    page: { modelled: `test/live-replay.mjs FIXTURES['${name}']: arrivals from a model, not recorded; bytes 0 (not modelled)` },
    tiles: tiles.map((t, i) => {
      const arr = t.switch ? switchArrivals(t.switch) : arrivals({ fps: t.fps, durMs: FIXTURE_MS, ...NETS[t.net], seed: 11 })
      return {
        id: i + 1,
        camera: `model/${i + 1}`,
        nvr: 'model',
        ch: i,
        stream: t.stream,
        codec: 'h264',
        capture0: CAPTURE0,
        model: t,
        frames: arr.map((a) => [Math.round(a.at * 10) / 10, Math.round(a.ts * 1000) / 1000, 0, a.isKey ? 1 : 0]),
        events: [[0, 'connect', t.stream], [0, 'open'], [0, 'size', ...t.size]],
        stats: []
      }
    })
  }
}

/** A fixture as it is in the repo. */
export const fixtureTrace = (name) => readTrace(new URL(`${name}.json`, FIXTURE_DIR))

/** The fixture file's text: one frame a line, so a change shows as lines in a diff. */
export function traceText(trace) {
  const tiles = trace.tiles.map(({ frames, ...t }) => {
    const head = JSON.stringify(t)
    return `${head.slice(0, -1)},"frames":[\n${frames.map((f) => JSON.stringify(f)).join(',\n')}\n]}`
  })
  const top = { ...trace }
  delete top.tiles
  return `${JSON.stringify(top).slice(0, -1)},"tiles":[\n${tiles.join(',\n')}\n]}\n`
}

// ---- command line ----------------------------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args.splice(i, 2)[1] : undefined
  }
  if (args.includes('--write-fixtures')) {
    mkdirSync(FIXTURE_DIR, { recursive: true })
    for (const name of Object.keys(FIXTURES)) {
      const text = traceText(modelTrace(name))
      writeFileSync(new URL(`${name}.json`, FIXTURE_DIR), text)
      console.log(`${name}.json: ${(text.length / 1024).toFixed(0)} KB`)
    }
    process.exit(0)
  }
  const player = opt('--player')
  const pool = opt('--pool')
  const decodeMs = opt('--decode-ms')
  const inFlight = opt('--in-flight')
  const clock = opt('--clock')
  const maxFps = opt('--max-fps')
  const playerOptions = opt('--player-options')
  const remote = args.includes('--remote') ? REMOTE_LIVE : { playerOptions: {} }
  const files = args.filter((a) => !a.startsWith('--'))
  const traces = files.length ? files.map((f) => [f, readTrace(f)]) : Object.keys(FIXTURES).map((n) => [`${n} (fixture)`, fixtureTrace(n)])
  const rows = []
  for (const [name, trace] of traces) {
    for (const tile of trace.tiles) {
      if (!tile.frames.length) continue
      const decoder = { ...decoderFor(tile), ...(pool && { pool: Number(pool) }), ...(decodeMs && { decodeMs: Number(decodeMs) }), ...(inFlight && { inFlight: Number(inFlight) }) }
      const r = await playTile(tile, { decoder, player: player && pathToFileURL(player).href, clock: clock ? JSON.parse(clock) : remote.clock, maxFps: maxFps && Number(maxFps), playerOptions: { ...remote.playerOptions, ...(playerOptions && JSON.parse(playerOptions)) } })
      rows.push({ trace: name, tile: `${tile.camera} ${tile.stream}`, fps: +frameRateOf(tileArrivals(tile)).toFixed(1), pool: decoder.pool, ...r })
    }
  }
  const cols = ['trace', 'tile', 'fps', 'pool', 'shownPct', 'freezesPerMin', 'holdsPerMin', 'skipEventsPerMin', 'maxStillMs', 'backwards', 'maxBackMs', 'medLatencyMs', 'dropped', 'resyncs', 'stretches']
  console.log(cols.join('\t'))
  for (const r of rows) console.log(cols.map((c) => r[c]).join('\t'))
}
