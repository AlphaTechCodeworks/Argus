// What the viewer actually got, measured in the page and sent to the server (telemetry.mjs): the
// first layer of the streaming optimiser (reports/APSI-Design.md). It changes nothing a viewer sees.
//
// Once a second each tile that is playing gives one sample (frames shown, unevenness, buffer, what
// was dropped), and a few things are timed as they happen: how long a camera took to show its first
// picture, how long a camera stepped to took to reach full quality, each reconnect. Every 10 s they
// go to the server in one small request; when the page is left, what is waiting goes with it.
//
// No picture is ever looked at or sent: only counts and times, and which camera they were for.
//
// createCollector is pure (a clock and a send function are handed in: test/telemetry-client.test.mjs);
// startTelemetry is the page's own, with timers and fetch.

export const SAMPLE_MS = 1000
export const WATCH_MS = 200 // how closely a first picture is timed
export const FLUSH_MS = 10_000
export const PAGE_SAMPLES = 20 // samples a second a page sends at most: 100 tiles are each sampled every 5 s
export const MAX_SAMPLES = 600 // a minute of a 3 x 3 with room to spare; older ones go first
export const MAX_EVENTS = 200
const round = (x, p = 1) => (Number.isFinite(x) ? Math.round(x * p) / p : 0)

/**
 * @param {{ now: () => number, send: (batch: object) => void, device: string, page: string }} o
 * @returns {{ watch: Function, sample: Function, event: Function, flush: Function, pending: Function }}
 */
export function createCollector({ now, send, device, page }) {
  let samples = []
  let events = []
  const seen = new Map() // tile key -> { since, shown: boolean, fpsMax, reconnects }
  const keyOf = (t) => `${t.nvr}/${t.ch}/${t.stream}/${t.role}`
  const event = (kind, more = {}) => {
    events.push({ t: now(), kind, ...more })
    if (events.length > MAX_EVENTS) events.shift()
  }
  /**
   * The tiles on the page now, looked at often (WATCH_MS): times each one's first picture, and
   * forgets the ones that have gone. tiles: [{ nvr, ch, stream: 0|1, role: 'focus'|'grid', fps, attempts }]
   */
  const watch = (tiles) => {
    const t = now()
    const here = new Set()
    for (const tile of tiles) {
      const k = keyOf(tile)
      here.add(k)
      let s = seen.get(k)
      if (!s) seen.set(k, (s = { since: t, shown: false, fpsMax: 0, attempts: tile.attempts ?? 0, resets: tile.decoderErrors ?? 0 }))
      if (!s.shown && tile.playing) {
        s.shown = true
        // (the main stream of the one camera open: how long until full quality; anything else: a first picture)
        event(tile.stream === 0 && tile.role === 'focus' ? 'hd' : 'first-picture', { nvr: tile.nvr, ch: tile.ch, stream: tile.stream, role: tile.role, ms: t - s.since })
      }
      if ((tile.attempts ?? 0) > s.attempts) event('reconnect', { nvr: tile.nvr, ch: tile.ch, stream: tile.stream })
      s.attempts = tile.attempts ?? 0
      // (the player counts each time its decoder failed and had to be set up again: player.js)
      if ((tile.decoderErrors ?? 0) > s.resets) event('decoder-reset', { nvr: tile.nvr, ch: tile.ch, stream: tile.stream })
      s.resets = tile.decoderErrors ?? 0
    }
    for (const k of seen.keys()) if (!here.has(k)) seen.delete(k)
  }
  /**
   * One sample per playing tile (SAMPLE_MS). tiles as for watch, with the player's counters. A page
   * of many tiles is sampled less often, all of its tiles at once: a batch from a 6 x 6 was already
   * past what the server reads (telemetry.mjs BODY_LIMIT) and was refused whole, so the big layouts,
   * the ones in question, were the ones never measured.
   */
  let turn = 0
  const sample = (tiles) => {
    if (turn++ % Math.max(1, Math.ceil(tiles.length / PAGE_SAMPLES)) !== 0) return
    const t = now()
    for (const tile of tiles) {
      const s = seen.get(keyOf(tile))
      if (!s?.shown) continue // not started yet: its wait is timed by watch, not scored as a freeze
      s.fpsMax = Math.max(s.fpsMax * 0.98, tile.fps ?? 0) // the camera's rate: the most seen lately
      samples.push({
        t, nvr: tile.nvr, ch: tile.ch, stream: tile.stream, role: tile.role,
        fps: round(tile.fps), fpsSrc: round(s.fpsMax), jitterMs: round(tile.jitterMs, 10), bufMs: round(tile.bufMs),
        dropped: round(tile.dropped), late: round(tile.late), resync: round(tile.resync), decQueue: round(tile.decQueue),
        // frames that came in, came out of the decoder, the longest wait between arrivals, and the page's redraws
        in: round(tile.arrived), dec: round(tile.decoded), gapMs: round(tile.gapMs), decMs: round(tile.decMs), skip: round(tile.skip), over: round(tile.over), rafHz: round(tile.rafHz), rafGapMs: round(tile.rafGapMs),
        kbps: round(tile.kbps), w: round(tile.w), h: round(tile.h), stalled: tile.stalled === true, visible: tile.visible !== false
      })
    }
    if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES)
  }
  /** Sends what has been gathered, if anything. */
  const flush = () => {
    if (!samples.length && !events.length) return false
    const batch = { v: 1, device, page, samples, events }
    samples = []
    events = []
    send(batch)
    return true
  }
  return { watch, sample, event, flush, pending: () => ({ samples: samples.length, events: events.length }) }
}

/** This browser's own name for itself: random, kept here, says nothing about the person or the PC. */
export function deviceId(storage = globalThis.localStorage) {
  try {
    let id = storage.getItem('argus.device')
    if (!/^[a-z0-9]{12,32}$/.test(id ?? '')) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('')
      storage.setItem('argus.device', id)
    }
    return id
  } catch {
    return 'unknown'
  }
}

export const TELEMETRY_URL = '/api/telemetry'

/**
 * Starts measuring a page. tiles(): what is on it now, read from its LiveTiles (viewer.js liveStats).
 * Never throws into the page: measuring must not be able to break what it measures.
 * @returns {{ event: (kind: string, more?: object) => void }}
 */
export function startTelemetry({ page, tiles }) {
  const post = (batch) => {
    const body = JSON.stringify(batch)
    // (keepalive: the last batch still goes when the page is being left)
    fetch(TELEMETRY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: body.length < 60_000 }).catch(() => {})
  }
  const c = createCollector({ now: () => Date.now(), send: post, device: deviceId(), page })
  const safe = (fn) => { try { return fn() } catch { return undefined } }
  // page opened -> its first camera picture, once (not for a page opened in a tab nobody was looking at)
  let pageFirst = document.hidden
  setInterval(() => safe(() => {
    const now = tiles()
    c.watch(now)
    if (!pageFirst && now.some((t) => t.playing)) {
      pageFirst = true
      c.event('page-first', { ms: Math.round(performance.now()) })
    }
  }), WATCH_MS)
  setInterval(() => safe(() => { if (!document.hidden) c.sample(tiles()) }), SAMPLE_MS)
  setInterval(() => safe(() => c.flush()), FLUSH_MS)
  addEventListener('pagehide', () => safe(() => c.flush()))
  return { event: (kind, more) => safe(() => c.event(kind, more)) }
}
