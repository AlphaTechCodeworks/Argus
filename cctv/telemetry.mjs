// What viewers actually got, as their pages measured it (public/telemetry.js): taken in, checked,
// kept, and summed into the experience score (public/qoe.js). The first layer of the streaming
// optimiser (reports/APSI-Design.md); it changes nothing a viewer sees.
//
//   POST /api/telemetry        { v: 1, device, page, samples: [...], events: [...] }  -> { ok, cohort }
//   GET  /api/admin/telemetry  -> { hours, cohorts: { apsi: {...}, holdout: {...} } }   (admins)
//
//   data/telemetry/YYYY-MM-DD.jsonl   one line per batch taken in, with who sent it and their cohort
//
// Bounded on purpose, because the server's disk is small: at most MAX_BYTES in all and KEEP_DAYS of
// days, the oldest day dropped first, and a batch that would not fit is counted and not written.
// Nothing here can fail a request for video: a write that fails is counted, never thrown.
//
// The cohort is the holdout test's: one session in ten (by a hash of the user and the browser, so a
// person stays in theirs) is "holdout" and will keep today's fixed rules when the optimiser starts
// deciding things. Until then both are served alike; the split is kept from the first day so the
// two can be seen to score the same before anything is changed.
//
// The user is always the session's (server.mjs passes it in); nothing a page says about who it is
// is believed. Every number is clamped and every name checked: a page is not trusted.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'
import { attention, mean, score, smoothness, stability, startupScore, switchScore, scrubScore } from './public/qoe.js'

export const TELEMETRY_PATH = '/api/telemetry'
export const TELEMETRY_ADMIN_PATH = '/api/admin/telemetry'
export const TELEMETRY_DIR = join(DATA_DIR, 'telemetry')
export const BODY_LIMIT = 96 * 1024
export const MAX_SAMPLES = 600
export const MAX_EVENTS = 200
export const MAX_BYTES = 100 * 1024 * 1024
export const KEEP_DAYS = 14
export const RELOAD_MAX_BYTES = 32 * 1024 * 1024 // a day's file bigger than this is not read back at start
export const HOLDOUT_OF = 10 // one in this many
export const KINDS = Object.freeze(['first-picture', 'hd', 'reconnect', 'open', 'step', 'page', 'close', 'seek', 'seek-picture', 'quality-drop', 'decoder-reset', 'page-first'])
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const NO_STORE = { 'cache-control': 'no-store' }

/** Which side of the holdout test this user on this browser is on, for good. */
export function cohortOf(user, device) {
  return createHash('sha256').update(`${user}\n${device}`).digest()[0] % HOLDOUT_OF === 0 ? 'holdout' : 'apsi'
}

const num = (x, lo, hi) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : 0)
const cam = (o) => (typeof o?.nvr === 'string' && ID_RE.test(o.nvr) && Number.isInteger(o.ch) && o.ch >= 0 && o.ch <= 255 ? { nvr: o.nvr, ch: o.ch } : null)

/** A batch as a page sent it, made safe to keep: null when it is not one at all. */
export function cleanBatch(b, now = Date.now()) {
  if (!b || typeof b !== 'object' || b.v !== 1 || !Array.isArray(b.samples) || !Array.isArray(b.events)) return null
  const device = typeof b.device === 'string' && /^[a-z0-9]{1,32}$/.test(b.device) ? b.device : 'unknown'
  const page = b.page === 'playback' ? 'playback' : 'live'
  // (a page's clock may be wrong: a time far from the server's is set to the server's)
  const when = (t) => (typeof t === 'number' && Math.abs(t - now) < 15 * 60_000 ? Math.round(t) : now)
  const samples = []
  for (const s of b.samples.slice(-MAX_SAMPLES)) {
    const c = cam(s)
    if (!c) continue
    samples.push({
      t: when(s.t), ...c, stream: s.stream === 0 ? 0 : 1, role: s.role === 'focus' ? 'focus' : 'grid',
      fps: num(s.fps, 0, 120), fpsSrc: num(s.fpsSrc, 0, 120), jitterMs: num(s.jitterMs, 0, 10_000), bufMs: num(s.bufMs, 0, 60_000),
      dropped: num(s.dropped, 0, 1e9), late: num(s.late, 0, 1e9), resync: num(s.resync, 0, 1e9), decQueue: num(s.decQueue, 0, 10_000),
      in: num(s.in, 0, 240), dec: num(s.dec, 0, 240), gapMs: num(s.gapMs, 0, 60_000), decMs: num(s.decMs, 0, 60_000), skip: num(s.skip, 0, 240), over: num(s.over, 0, 240), rafHz: num(s.rafHz, 0, 1000), rafGapMs: num(s.rafGapMs, 0, 60_000),
      kbps: num(s.kbps, 0, 1e6), w: num(s.w, 0, 16_384), h: num(s.h, 0, 16_384), stalled: s.stalled === true, visible: s.visible !== false
    })
  }
  const events = []
  for (const e of b.events.slice(-MAX_EVENTS)) {
    if (!KINDS.includes(e?.kind)) continue
    const out = { t: when(e.t), kind: e.kind, ...(cam(e) ?? {}) }
    if (e.stream === 0 || e.stream === 1) out.stream = e.stream
    if (e.role === 'focus' || e.role === 'grid') out.role = e.role
    if (typeof e.ms === 'number') out.ms = num(e.ms, 0, 600_000)
    if (e.dir === 1 || e.dir === -1) out.dir = e.dir
    events.push(out)
  }
  return { device, page, samples, events }
}

const hourOf = (t) => Math.floor(t / 3_600_000)
const blank = () => ({ smoothness: null, startup: null, scrubbing: null, switching: null, trouble: 0, seconds: 0, batches: 0, sessions: new Set() })

/**
 * The store: batches to disk, and the sums the score is made from, by hour and cohort, in memory.
 * @param {{ dir?: string, now?: () => number, maxBytes?: number, keepDays?: number, keepHours?: number }} [o]
 */
export function makeTelemetry({ dir = TELEMETRY_DIR, now = Date.now, maxBytes = MAX_BYTES, keepDays = KEEP_DAYS, keepHours = 24 * 7 } = {}) {
  const hours = new Map() // hour -> { apsi: sums, holdout: sums }
  // per NVR, since this start (and what was read back): the last RING waits, and its tiles' seconds
  const RING = 400
  const byNvr = new Map()
  const nvrOf = (id) => byNvr.get(id) ?? byNvr.set(id, { first: [], hd: [], seconds: 0, frozen: 0, reconnects: 0, smoothness: null }).get(id)
  const keep = (ring, x) => { ring.push(x); if (ring.length > RING) ring.shift() }
  const counts = { batches: 0, written: 0, notWritten: 0, bytes: null }
  let lastPrune = -Infinity

  /** Old days go, then the oldest until what is kept fits; returns the bytes kept. */
  const prune = () => {
    let files = []
    try {
      files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map((f) => ({ f, size: statSync(join(dir, f)).size }))
    } catch {
      return 0 // (no folder yet)
    }
    const oldest = new Date(now() - keepDays * 86_400_000).toISOString().slice(0, 10)
    let total = files.reduce((a, x) => a + x.size, 0)
    // Down to nine tenths, not to the brim: a store left exactly full would refuse every batch and
    // never drop a day again. (Today's file is never the one dropped: it is the one being written.)
    while (files.length > 1 && (files[0].f.slice(0, 10) < oldest || total > maxBytes * 0.9)) {
      const gone = files.shift()
      try { rmSync(join(dir, gone.f)); total -= gone.size } catch { break }
    }
    return total
  }

  const write = (line) => {
    try {
      const t = now()
      if (t - lastPrune > 10 * 60_000) { counts.bytes = prune(); lastPrune = t }
      if ((counts.bytes ?? 0) + line.length > maxBytes) { counts.notWritten++; return false }
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      appendFileSync(join(dir, `${new Date(t).toISOString().slice(0, 10)}.jsonl`), line, { mode: 0o600 })
      counts.bytes = (counts.bytes ?? 0) + line.length
      counts.written++
      return true
    } catch {
      counts.notWritten++
      return false
    }
  }

  const sumsFor = (t, cohort) => {
    const h = hourOf(t)
    let slot = hours.get(h)
    if (!slot) {
      hours.set(h, (slot = { apsi: blank(), holdout: blank() }))
      for (const k of hours.keys()) if (k < h - keepHours) hours.delete(k)
    }
    return slot[cohort]
  }

  /** One batch into its hour's sums. at: when it was taken in. */
  const tally = (user, batch, cohort, at) => {
      const mine = sumsFor(at, cohort)
      mine.batches++
      mine.sessions.add(`${user}\n${batch.device}`)
      for (const s of batch.samples) {
        const a = attention(s)
        if (!(a > 0)) continue
        mine.smoothness = mean.add(mine.smoothness, smoothness(s), a)
        mine.seconds++
        const n = nvrOf(s.nvr)
        n.seconds++
        if (s.stalled || !(s.fps > 0)) n.frozen++
        n.smoothness = mean.add(n.smoothness, smoothness(s))
      }
      for (const e of batch.events) {
        // (by NVR as well: which recorder is slow to start a stream is the first thing to act on)
        if (e.nvr && e.ms !== undefined && (e.kind === 'first-picture' || e.kind === 'hd')) keep(nvrOf(e.nvr)[e.kind === 'hd' ? 'hd' : 'first'], e.ms)
        if (e.nvr && e.kind === 'reconnect') nvrOf(e.nvr).reconnects++
        if (e.kind === 'first-picture' && e.ms !== undefined) mine.startup = mean.add(mine.startup, startupScore(e.ms))
        else if (e.kind === 'hd' && e.ms !== undefined) mine.switching = mean.add(mine.switching, switchScore(e.ms))
        else if (e.kind === 'seek-picture' && e.ms !== undefined) mine.scrubbing = mean.add(mine.scrubbing, scrubScore(e.ms))
        else if (e.kind === 'reconnect' || e.kind === 'quality-drop' || e.kind === 'decoder-reset') mine.trouble++
      }
  }

  // What was kept before this start goes back into the sums: a restart (every deploy is one) would
  // otherwise empty the score. Only as far back as the sums reach; a line that cannot be read is
  // passed over, and so is a day's file too big to read at once.
  try {
    const since = now() - keepHours * 3_600_000
    for (const f of readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) {
      if (Date.parse(`${f.slice(0, 10)}T23:59:59Z`) < since || statSync(join(dir, f)).size > RELOAD_MAX_BYTES) continue
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line) continue
        try {
          const b = JSON.parse(line)
          if (typeof b.at !== 'number' || b.at < since || typeof b.user !== 'string' || !Array.isArray(b.samples) || !Array.isArray(b.events)) continue
          tally(b.user, b, b.cohort === 'holdout' ? 'holdout' : 'apsi', b.at)
          counts.reloaded = (counts.reloaded ?? 0) + 1
        } catch {}
      }
    }
  } catch {} // (no folder yet)

  return {
    counts,
    /** Takes one cleaned batch in: to disk, and into the hour's sums. */
    add(user, batch) {
      const cohort = cohortOf(user, batch.device)
      counts.batches++
      write(`${JSON.stringify({ at: now(), user, cohort, ...batch })}\n`)
      tally(user, batch, cohort, now())
      return cohort
    },
    /** The score of each cohort over the last `lastHours`, and what it was made from. */
    summary(lastHours = 24) {
      const from = hourOf(now()) - lastHours
      const out = {}
      for (const cohort of ['apsi', 'holdout']) {
        const all = blank()
        for (const [h, slot] of hours) {
          if (h <= from) continue
          const s = slot[cohort]
          for (const p of ['smoothness', 'startup', 'scrubbing', 'switching']) if (s[p]) all[p] = { sum: (all[p]?.sum ?? 0) + s[p].sum, n: (all[p]?.n ?? 0) + s[p].n }
          all.trouble += s.trouble
          all.seconds += s.seconds
          all.batches += s.batches
          for (const k of s.sessions) all.sessions.add(k)
        }
        const parts = {
          smoothness: mean.of(all.smoothness), startup: mean.of(all.startup), scrubbing: mean.of(all.scrubbing), switching: mean.of(all.switching),
          // (tile-seconds over the tiles' minutes: a reconnect a minute on one tile is as bad as it gets)
          stability: stability({ reconnects: all.trouble, minutes: all.seconds / 60 })
        }
        out[cohort] = { ...score(parts), sessions: all.sessions.size, tileSeconds: all.seconds, batches: all.batches, opens: all.startup?.n ?? 0, switches: all.switching?.n ?? 0 }
      }
      // each NVR, slowest to a first picture first: the middle wait and the wait 9 in 10 were inside
      const at = (ring, q) => (ring.length ? [...ring].sort((a, b) => a - b)[Math.min(ring.length - 1, Math.floor(q * ring.length))] : null)
      const nvrs = [...byNvr].map(([nvr, n]) => ({
        nvr, opens: n.first.length, firstMs: at(n.first, 0.5), firstMs90: at(n.first, 0.9), hdMs: at(n.hd, 0.5), hdMs90: at(n.hd, 0.9),
        smoothness: mean.of(n.smoothness), frozenShare: n.seconds ? n.frozen / n.seconds : null, reconnects: n.reconnects, tileSeconds: n.seconds
      })).sort((a, b) => (b.firstMs ?? -1) - (a.firstMs ?? -1))
      return { hours: lastHours, cohorts: out, nvrs, kept: { ...counts } }
    }
  }
}

/** Reads a request's body as JSON, up to BODY_LIMIT: undefined when it is too long or not JSON. */
async function bodyOf(req) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > BODY_LIMIT) return undefined
    chunks.push(c)
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c))).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * The two routes. who: the session's { user, admin }, or null when nobody is signed in.
 * @returns {Promise<[number, object, object]|null>} null: not one of these routes
 */
export async function handleTelemetry(req, pathname, who, store) {
  if (pathname === TELEMETRY_ADMIN_PATH) {
    if (who?.admin !== true) return [403, { error: 'Admins only' }, NO_STORE]
    if (req.method !== 'GET') return [405, { error: 'Method not allowed' }, { ...NO_STORE, allow: 'GET' }]
    return [200, store.summary(), NO_STORE]
  }
  if (pathname !== TELEMETRY_PATH) return null
  if (!who?.user) return [401, { error: 'Sign in' }, NO_STORE]
  if (req.method !== 'POST') return [405, { error: 'Method not allowed' }, { ...NO_STORE, allow: 'POST' }]
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return [415, { error: 'JSON only' }, NO_STORE]
  // a page of this site only: another site's script must not be able to write here with a visitor's session
  const origin = req.headers.origin
  let from = null
  try { from = origin ? new URL(origin).host : null } catch { from = '' } // (not an address at all: refused)
  if (origin && from !== req.headers.host) return [403, { error: 'Wrong origin' }, NO_STORE]
  const batch = cleanBatch(await bodyOf(req))
  if (!batch) return [400, { error: 'Not a telemetry batch' }, NO_STORE]
  return [200, { ok: true, cohort: store.add(who.user, batch) }, NO_STORE]
}
