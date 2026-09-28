// Tests for rec-fallback.mjs (NVR fallback legs, phase 3 Task 4) and their use in rec-playback.mjs:
//   nvrCoverage     the NVR's recordings in server time: skew and NVR-local days, the cache (60 s for
//                   today, 10 min for past days, one search for calls at once), offline / degraded /
//                   busy / failing NVRs (no ranges, a reason; failures are not cached)
//   startLeg        an NVR session through a proxy ws: the clock conversion (in a copy), toMs and
//                   floorMs, the messages (started -> started or source, stream, end, error), commands
//                   (speed capped at 8, no reverse, pause), close (the session's close handler; nothing
//                   is forwarded afterwards), the start timeout, the browser's h265 on the session's URL
//   ServerPlayback  with legs: a start in NVR-only time and the switch back to disk at the server's
//                   footage; commands during a leg; failures (the leg fails, the NVR is offline or busy)
//                   fall back to disk with a notice; gaps (10 s jumped without asking the NVR, 90 s
//                   played from the NVR, a 39 s hole inside one file played from the NVR); a seek during
//                   a leg; scrub, reverse and keyframe speeds never start a leg
//   the real playback.mjs PlaybackSession through the proxy (a fake lane: no SDK call runs)
// Temp dirs, a temp index, fake NVR objects and fake WebSockets only: nothing reaches an NVR.
// Run:  node cctv/test/rec-fallback.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rec-fb-'))

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}\n`)
}
const until = async (pred, ms = 5000) => {
  const t = performance.now()
  while (!pred() && performance.now() - t < ms) await sleep(5)
  return pred()
}
const J = (v) => JSON.stringify(v)
const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length

const { SegmentWriter } = await import('../segment-writer.mjs')
const { openRecIndex } = await import('../rec-index.mjs')
const { SegmentReader } = await import('../rec-reader.mjs')
let fb = {}
let rp = {}
try {
  fb = await import('../rec-fallback.mjs')
  rp = await import('../rec-playback.mjs')
} catch (e) {
  check('load ../rec-fallback.mjs and ../rec-playback.mjs', false, e.message)
  console.log('\n1 failed')
  process.exit(1)
}

/** A seeded PRNG (mulberry32): the same numbers on every run. */
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- synthetic H.264 (as in rec-playback.test.mjs) ------------------------------------------------
const POOL = (() => {
  const rnd = prng(7)
  const b = Buffer.allocUnsafe(1 << 20)
  let z = 0
  for (let i = 0; i < b.length; i++) {
    let v = rnd() < 0.2 ? 0 : 1 + Math.floor(rnd() * 255)
    if (z >= 2 && v < 3) v = 3
    b[i] = v
    z = v === 0 ? z + 1 : 0
  }
  return b
})()
function body(rnd, len) {
  const at = Math.floor(rnd() * (POOL.length - len - 1))
  const b = Buffer.from(POOL.subarray(at, at + len))
  if (b[len - 1] === 0) b[len - 1] = 0x80
  return b
}
const SC4 = Buffer.from([0, 0, 0, 1])
const SC3 = Buffer.from([0, 0, 1])
const nal = (first, hdr, rnd, len) => Buffer.concat([first ? SC4 : SC3, Buffer.from(hdr), body(rnd, len)])
const h264 = {
  key: (rnd, len = 3000) => Buffer.concat([nal(true, [0x67, 0x64], rnd, 12), nal(false, [0x68], rnd, 4), nal(false, [0x65, 0x88], rnd, len)]),
  p: (rnd, len = 600) => nal(true, [0x41, 0x9a], rnd, len)
}
/** n frames at 25 fps from t0, a key every `gop`, stamped as the recorder stamps them (bursts). */
function makeFrames(rnd, t0, n, { gop = 50 } = {}) {
  const out = []
  let burst = t0
  for (let i = 0; i < n; i++) {
    const cap = t0 + i * 40
    while (burst < cap) burst += 200 + Math.floor(rnd() * 101)
    const isKey = i % gop === 0
    out.push({ buf: isKey ? h264.key(rnd, 1500 + Math.floor(rnd() * 2000)) : h264.p(rnd, 150 + Math.floor(rnd() * 700)), isKey, ts: burst })
  }
  return out
}

// ---- the recordings: a temp location and a temp index --------------------------------------------------
const ROOT = mkdtempSync(join(tmpdir(), 'rec-fb-loc-'))
const IDX = openRecIndex(join(process.env.DATA_DIR, 'recordings.db'))
const NVR_ID = 'n1'

/** Records groups of frames with a real SegmentWriter (one file or more per group) and indexes them. */
async function recordGroups(ch, groups) {
  const w = new SegmentWriter({ root: ROOT, nvrId: NVR_ID, ch, codec: 'h264' })
  const segs = []
  w.on('segment', (s) => segs.push(s))
  const accepted = []
  for (const g of groups) {
    for (const f of g) {
      if (w.write(f.buf, { isKey: f.isKey, ts: f.ts })) accepted.push(f)
      if (w.queueStatus().queuedBytes > 1 << 20) await w.drained()
    }
    await w.close()
  }
  for (const s of segs) IDX.addSegment({ nvr: NVR_ID, ch, ...s, loc: 'L1' })
  return { segs, accepted }
}
/** Every frame of the segments as the reader gives them back (the times the session sends). */
async function readBack(segs) {
  const out = []
  for (const s of segs) {
    const r = await new SegmentReader({ path: s.path, endMs: s.endMs }).open()
    for (let k = 0; k < r.rows.length; k++) for (const f of await r.gop(k)) out.push({ ...f, us: Math.round(f.ts * 1000), seg: s.path })
    await r.close()
  }
  return out
}
const usMap = (list) => new Map(list.map((f, i) => [f.us, i]))
/** '' when bins are consecutive frames of expect with the same bytes and key flags, else what is wrong. */
function seqCheck(bins, expect, byUs) {
  let prev = -1
  for (let j = 0; j < bins.length; j++) {
    const i = byUs.get(bins[j].us)
    if (i === undefined) return `frame ${j}: unknown time ${bins[j].tsMs}`
    if (!bins[j].buf.equals(expect[i].buf) || bins[j].key !== expect[i].isKey) return `frame ${j}: bytes or key flag differ`
    if (j && i !== prev + 1) return `frame ${j}: #${i} after #${prev}`
    prev = i
  }
  return ''
}
const keyBefore = (list, t) => list.filter((f) => f.isKey && f.ts <= t).at(-1)
const increasing = (bins) => bins.every((b, j) => j === 0 || b.us > bins[j - 1].us)

// ---- fakes -----------------------------------------------------------------------------------------
/** A fake browser WebSocket: texts and binaries recorded with their arrival (performance.now()). */
function fakeWs() {
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, texts: [], bins: [], log: [], closedWith: 0, closeReason: '', handlers: {} }
  ws.send = (m) => {
    const at = performance.now()
    if (typeof m === 'string') {
      const o = JSON.parse(m)
      ws.texts.push(o)
      ws.log.push({ at, text: o })
      return
    }
    const us = Number(m.readBigInt64LE(8))
    const f = { key: (m[0] & 1) === 1, codec: m[1], w: m.readUInt16LE(2), h: m.readUInt16LE(4), us, tsMs: us / 1000, buf: Buffer.from(m.subarray(16)), at }
    ws.bins.push(f)
    ws.log.push({ at, bin: f })
  }
  ws.on = (event, fn) => (ws.handlers[event] = fn)
  ws.close = (code, reason = '') => {
    if (ws.readyState !== 1) return
    ws.readyState = 3
    ws.closedWith = code
    ws.closeReason = reason
    ws.handlers.close?.()
  }
  ws.command = (obj) => ws.handlers.message?.(Buffer.from(J(obj)), false)
  return ws
}

const SKEW = 220_000 // nvr1's clock runs about 3 min 40 s fast
const TZ = -4 * 3_600_000 // the site is UTC-4
/** A frame as an NVR session sends it (sdk.mjs encodeFrame layout): the NVR's size, ts in µs of its clock; n in the body. */
function nvrFrame(n, key, tsMs) {
  const m = Buffer.alloc(16 + 24)
  m.writeUInt8(key ? 1 : 0, 0)
  m.writeUInt8(0, 1)
  m.writeUInt16LE(1920, 2)
  m.writeUInt16LE(1080, 4)
  m.writeBigInt64LE(BigInt(Math.round(tsMs * 1000)), 8)
  m.writeUInt32LE(n, 16)
  m.writeUInt32LE(0xf00d0001, 20)
  return m
}
const isNvr = (b) => b.w === 1920 // disk frames have width 0
const nOf = (b) => b.buf.readUInt32LE(0)
function busyError() {
  const e = new Error('The NVR is busy; try again in a moment')
  e.name = 'NvrBusy'
  e.retryAfterS = 10
  return e
}

/**
 * A fake NVR. cover: its recordings in SERVER time; it answers searches in its own clock (+SKEW) per
 * NVR-local day, as playback.mjs recordings() does. Its playback sessions (connect) send started, then
 * frames stamped in its clock from a keyframe 100 ms before start: stepMs of footage per frame, one
 * frame every everyMs of wall time, a key every `gop` frames, until the ws is closed or paused.
 * mode 'fail': the session answers {type:'error'} and closes, as PlaybackSession does.
 */
function fakeNvr({ cover = [], mode = 'ok', clockKnown = true, stepMs = 200, everyMs = 4, gop = 10 } = {}) {
  const nvr = { id: NVR_ID, name: 'NVR n1', online: true, degraded: false, mode, busy: false, fail: false, connects: [], recCalls: [], clockCalls: 0 }
  const nvrCover = cover.map(([s, e]) => [s + SKEW, e + SKEW])
  let last = clockKnown ? { tzOffsetMs: TZ, skewMs: SKEW, at: Date.now() } : null
  nvr.playback = {
    lastClock: () => (last ? { ...last } : null),
    async clock() {
      nvr.clockCalls++
      if (nvr.busy) throw busyError()
      last = { tzOffsetMs: TZ, skewMs: SKEW, at: Date.now() }
      return { now: Date.now() + SKEW, tzOffsetMs: TZ, skewMs: SKEW }
    },
    async recordings(ch, date) {
      nvr.recCalls.push({ ch, date, at: performance.now() })
      if (nvr.hang) return new Promise(() => {}) // a search that never answers
      if (nvr.busy) throw busyError()
      if (nvr.fail) throw new Error('FindFile failed')
      const dayStart = Date.parse(`${date}T00:00:00Z`) - TZ
      const dayEnd = dayStart + 86_400_000 - 1000
      return { ranges: nvrCover.map(([s, e]) => [Math.max(s, dayStart), Math.min(e, dayEnd)]).filter(([s, e]) => e > s), events: [] }
    },
    connect(ws, url) {
      const c = { ws, url, start: Number(url.searchParams.get('start')), commands: [], sent: [], closed: false, closedAt: 0, paused: false, timer: null, t0: null }
      nvr.connects.push(c)
      ws.on('message', (d, isBinary) => {
        if (isBinary) return
        const cmd = JSON.parse(String(d))
        c.commands.push(cmd)
        if ('pause' in cmd) c.paused = cmd.pause
      })
      ws.on('close', () => {
        c.closed = true
        c.closedAt = performance.now()
        clearTimeout(c.t0)
        clearInterval(c.timer)
      })
      const send = (m) => {
        if (ws.readyState === ws.OPEN) ws.send(m)
      }
      c.t0 = setTimeout(() => {
        if (c.closed) return
        if (nvr.mode === 'fail') {
          send(J({ type: 'error', message: 'No recording at this time' }))
          ws.close(1011, 'playback failed')
          return
        }
        send(J({ type: 'started' }))
        const ts0 = c.start - 100
        let n = 0
        c.timer = setInterval(() => {
          if (c.closed || c.paused) return
          const f = { n, key: n % gop === 0, ts: ts0 + n * stepMs }
          c.sent.push(f)
          n++
          send(nvrFrame(f.n, f.key, f.ts))
        }, everyMs)
      }, 30)
    }
  }
  return nvr
}

const ADMIN = { user: 'admin', admin: true }
const logs = []
/** Opens a /playback?src=auto socket through connectPlayback (legs: rec-fallback's unless given). */
function open(ch, start, { nvr, legs = fb.nvrLegs, defaultLegs = false, opts = {}, extra = '' } = {}) {
  const ws = fakeWs()
  const url = new URL(`ws://x/playback?nvr=${NVR_ID}&ch=${ch}&stream=0&start=${start}&src=auto${extra}`)
  ws.t0 = performance.now()
  const args = { nvr, ws, url, who: ADMIN, index: IDX, opts: { log: (l) => logs.push(l), ...opts } }
  if (!defaultLegs) args.legs = legs
  const session = rp.connectPlayback(args)
  return { ws, session }
}

// ---- footage ---------------------------------------------------------------------------------------
// camera 0: 8 s from S0 (the NVR also has the hour around it)
const S0 = Date.UTC(2026, 8, 24, 10, 0, 0)
const cam0 = await recordGroups(0, [makeFrames(prng(1), S0, 200)])
const exp0 = await readBack(cam0.segs)
const by0 = usMap(exp0)
// camera 1: 4 s, a 10 s gap, 4 s
const S1 = Date.UTC(2026, 8, 24, 11, 0, 5)
const g1a = makeFrames(prng(2), S1, 100)
const cam1 = await recordGroups(1, [g1a, makeFrames(prng(3), g1a.at(-1).ts + 10_000, 100)])
const exp1 = await readBack(cam1.segs)
// camera 2: 4 s, a 90 s gap, 4 s
const S2 = Date.UTC(2026, 8, 24, 12, 0, 5)
const g2a = makeFrames(prng(4), S2, 100)
const cam2 = await recordGroups(2, [g2a, makeFrames(prng(5), g2a.at(-1).ts + 90_000, 100)])
const exp2 = await readBack(cam2.segs)
check('footage: camera 0 one file, cameras 1 and 2 two files each', cam0.segs.length === 1 && cam1.segs.length === 2 && cam2.segs.length === 2, `${cam0.segs.length} ${cam1.segs.length} ${cam2.segs.length}`)
check('exports: nvrCoverage, startLeg, nvrLegs {coverage, start}', typeof fb.nvrCoverage === 'function' && typeof fb.startLeg === 'function' && fb.nvrLegs?.coverage === fb.nvrCoverage && fb.nvrLegs?.start === fb.startLeg)

// ==== nvrCoverage ==========================================================================================
{
  const NOW = Date.UTC(2026, 8, 24, 18, 0, 0) // the NVR's local time: 14:03:40 on 2026-09-24
  let now = NOW
  const cov = (nvr, ch, a, b) => fb.nvrCoverage(nvr, ch, a, b, { now: () => now })
  const A0 = NOW - 3 * 3_600_000
  const A1 = NOW - 2 * 3_600_000
  const nvr = fakeNvr({ cover: [[A0 + 600_000, A0 + 1_800_000]] })
  const r1 = await cov(nvr, 0, A0, A1)
  check('coverage: ranges in server time (the NVR answers in its clock, 220 s fast), one search of its local day', J(r1.ranges) === J([[A0 + 600_000, A0 + 1_800_000]]) && !r1.reason && nvr.recCalls.length === 1 && nvr.recCalls[0].date === '2026-09-24' && nvr.recCalls[0].ch === 0, `${J(r1)} ${J(nvr.recCalls)}`)
  check('coverage: skewMs and tzOffsetMs come with the answer', r1.skewMs === SKEW && r1.tzOffsetMs === TZ, J(r1))
  const r2 = await cov(nvr, 0, A0 + 900_000, A0 + 1_200_000)
  check('coverage: clipped to the window (from the cache)', J(r2.ranges) === J([[A0 + 900_000, A0 + 1_200_000]]) && nvr.recCalls.length === 1, J(r2))
  now = NOW + 30_000
  await cov(nvr, 0, A0, A1)
  check('cache: today, a second call within 60 s makes no new search', nvr.recCalls.length === 1, `${nvr.recCalls.length} searches`)
  now = NOW + 61_000
  await cov(nvr, 0, A0, A1)
  check('cache: today, after 60 s the NVR is searched again', nvr.recCalls.length === 2, `${nvr.recCalls.length} searches`)
  await cov(nvr, 5, A0, A1)
  check('cache: per channel', nvr.recCalls.length === 3 && nvr.recCalls.at(-1).ch === 5)
  // a past day: cached for 10 minutes
  const P0 = NOW - 2 * 86_400_000
  now = NOW
  await cov(nvr, 0, P0, P0 + 3_600_000)
  const n = nvr.recCalls.length
  now = NOW + 9 * 60_000
  await cov(nvr, 0, P0, P0 + 3_600_000)
  check('cache: a past day, a call 9 min later makes no new search', nvr.recCalls.length === n && nvr.recCalls.at(-1).date === '2026-09-22', `${nvr.recCalls.length - n} new, ${nvr.recCalls.at(-1).date}`)
  now = NOW + 11 * 60_000
  await cov(nvr, 0, P0, P0 + 3_600_000)
  check('cache: a past day, 11 min later the NVR is searched again', nvr.recCalls.length === n + 1, `${nvr.recCalls.length - n} new`)
  // calls at the same time share one search
  const two = fakeNvr({ cover: [[A0, A1]] })
  now = NOW
  const [x, y] = await Promise.all([cov(two, 0, A0, A1), cov(two, 0, A0, A1)])
  check('cache: two calls at once share one search', two.recCalls.length === 1 && x.ranges.length === 1 && J(x.ranges) === J(y.ranges), `${two.recCalls.length} searches`)

  // the NVR's local midnight: both days searched, the stretch across it merged
  const M = Date.UTC(2026, 8, 24, 4, 0, 0) - SKEW // 00:00 at the site (UTC-4) on the NVR's clock, in server time
  const mid = fakeNvr({ cover: [[M - 1_800_000, M + 1_800_000]] })
  const rm = await cov(mid, 2, M - 3_600_000, M + 3_600_000)
  check("coverage: a window across the NVR's local midnight searches both days and merges the stretch", J(mid.recCalls.map((c) => c.date)) === J(['2026-09-23', '2026-09-24']) && J(rm.ranges) === J([[M - 1_800_000, M + 1_800_000]]), `${J(mid.recCalls.map((c) => c.date))} ${J(rm.ranges)}`)
  const fut = fakeNvr()
  await cov(fut, 0, NOW - 3_600_000, NOW + 2 * 86_400_000)
  check("coverage: days after the NVR's today are not searched", J(fut.recCalls.map((c) => c.date)) === J(['2026-09-24']), J(fut.recCalls.map((c) => c.date)))

  // NVRs that cannot answer: no ranges, a reason, never a throw
  const off = fakeNvr({ cover: [[A0, A1]] })
  off.online = false
  const ro = await cov(off, 0, A0, A1)
  check('offline NVR: no ranges, reason offline, no call at all', ro.ranges.length === 0 && /offline/.test(ro.reason) && off.recCalls.length === 0 && off.clockCalls === 0, J(ro))
  const deg = fakeNvr({ cover: [[A0, A1]] })
  deg.degraded = true
  const rd = await cov(deg, 0, A0, A1)
  check('degraded NVR (recovering, calls stuck): no ranges, reason busy, no call', rd.ranges.length === 0 && /busy/.test(rd.reason) && deg.recCalls.length === 0, J(rd))
  const busy = fakeNvr({ cover: [[A0, A1]] })
  busy.busy = true
  const rb = await cov(busy, 0, A0, A1)
  check('busy NVR (NvrBusy): no ranges, reason busy', rb.ranges.length === 0 && /busy/.test(rb.reason) && busy.recCalls.length === 1, J(rb))
  busy.busy = false
  const rb2 = await cov(busy, 0, A0, A1)
  check('... a failure is not cached: the next call searches again and gets the ranges', busy.recCalls.length === 2 && rb2.ranges.length === 1 && !rb2.reason, J(rb2))
  const bad = fakeNvr({ cover: [[A0, A1]] })
  bad.fail = true
  const rf = await cov(bad, 0, A0, A1)
  check('failing search: no ranges, a reason naming the error', rf.ranges.length === 0 && /FindFile failed/.test(rf.reason ?? ''), J(rf))
  // no clock read yet: clock() once (online only)
  const nc = fakeNvr({ cover: [[A0, A1]], clockKnown: false })
  const rc = await cov(nc, 0, A0, A1)
  check('no clock read yet: clock() is called once, then the search', nc.clockCalls === 1 && nc.recCalls.length === 1 && rc.ranges.length === 1 && rc.skewMs === SKEW, J(rc))
  const nc2 = fakeNvr({ clockKnown: false })
  nc2.online = false
  await cov(nc2, 0, A0, A1)
  check('... but not while the NVR is offline', nc2.clockCalls === 0 && nc2.recCalls.length === 0)
  const nc3 = fakeNvr({ clockKnown: false })
  nc3.busy = true
  const rc3 = await cov(nc3, 0, A0, A1)
  check('... and a busy clock read gives reason busy, no search', rc3.ranges.length === 0 && /busy/.test(rc3.reason ?? '') && nc3.recCalls.length === 0, J(rc3))
}

// ==== startLeg ==============================================================================================
/** A scripted NVR session: connect() only records the proxy; the test sends through it. */
function scriptedNvr({ throwOnConnect = false } = {}) {
  const s = { id: NVR_ID, name: 'NVR n1', online: true, degraded: false, ws: null, url: null, commands: [], closed: 0 }
  s.playback = {
    connect(ws, url) {
      if (throwOnConnect) throw new Error('connect exploded')
      s.ws = ws
      s.url = url
      ws.on('message', (d, isBinary) => {
        if (!isBinary) s.commands.push(JSON.parse(String(d)))
      })
      ws.on('close', () => s.closed++)
    }
  }
  return s
}
const F = Date.UTC(2026, 8, 24, 9, 0, 0)
const nvrAt = (ms) => ms + SKEW // server time -> the NVR's clock
{
  const nvr = scriptedNvr()
  const real = fakeWs()
  const leg = fb.startLeg({ nvr, ch: 3, fromMs: F, toMs: F + 10_000, stream: 0, speed: 16, paused: true, skewMs: SKEW, real, gen: null, floorMs: F + 500 })
  const p = nvr.url
  check("startLeg: the NVR session gets /playback with nvr, ch, stream and start in the NVR's clock", p?.pathname === '/playback' && p.searchParams.get('nvr') === NVR_ID && p.searchParams.get('ch') === '3' && p.searchParams.get('stream') === '0' && Number(p.searchParams.get('start')) === F + SKEW, String(p))
  check('startLeg: the speed (16x, capped at 8x) and the pause chosen before go to the session', J(nvr.commands) === J([{ speed: 8 }, { pause: true }]), J(nvr.commands))
  // not told otherwise (backfill, a browser that decodes H.265): the recording itself, never converted
  check('startLeg: h265=1 on the URL unless told the browser cannot decode H.265', p?.searchParams.get('h265') === '1', String(p))
  real.bufferedAmount = 12345
  check("proxy: bufferedAmount is the browser socket's; readyState OPEN", nvr.ws.bufferedAmount === 12345 && nvr.ws.readyState === nvr.ws.OPEN)
  nvr.ws.send(J({ type: 'stream', stream: 0 }))
  nvr.ws.send(J({ type: 'started' }))
  check('proxy: stream passes as is; started becomes source nvr {from, to} (a hole between server files)', J(real.texts) === J([{ type: 'stream', stream: 0 }, { type: 'source', src: 'nvr', from: F, to: F + 10_000 }]), J(real.texts))
  nvr.ws.send(nvrFrame(1, true, nvrAt(F + 400))) // at or before floorMs: already shown from the server
  nvr.ws.send(nvrFrame(2, false, nvrAt(F + 600))) // after it, but not a keyframe: not decodable alone
  const k3 = nvrFrame(3, true, nvrAt(F + 700))
  const k3copy = Buffer.from(k3)
  nvr.ws.send(k3)
  nvr.ws.send(nvrFrame(4, false, nvrAt(F + 740.5)))
  check('proxy: frames up to floorMs are dropped, then it starts at a keyframe', J(real.bins.map(nOf)) === J([3, 4]), J(real.bins.map(nOf)))
  check('proxy: ts converted to server time (-220 s), within 1 ms; the rest of the header and the bytes as sent', real.bins.length === 2 && Math.abs(real.bins[0].tsMs - (F + 700)) < 1 && Math.abs(real.bins[1].tsMs - (F + 740.5)) < 1 && real.bins[0].key && real.bins[0].w === 1920 && real.bins[0].buf.equals(k3.subarray(16)), real.bins.map((b) => b.tsMs - F).join(','))
  check("proxy: the time is rewritten in a copy (the session's buffer is unchanged)", k3.equals(k3copy))
  check('leg: announced, frames 2, lastTs the last frame sent', leg.announced === true && leg.frames === 2 && Math.abs(leg.lastTs - (F + 740.5)) < 0.01, `${leg.announced} ${leg.frames} ${leg.lastTs - F}`)
  nvr.ws.send(nvrFrame(5, true, nvrAt(F + 10_000)))
  const r = await leg.done
  check('leg: the first frame at or after toMs ends it and is not sent', r.reason === 'reached' && real.bins.length === 2 && r.frames === 2, J(r))
  check('leg: ending fires the session\'s close handler once (it stops and frees its login)', nvr.closed === 1 && nvr.ws.readyState !== nvr.ws.OPEN)
  nvr.ws.send(nvrFrame(6, true, nvrAt(F + 800)))
  nvr.ws.send(J({ type: 'stream', stream: 0 }))
  leg.command({ speed: 2 })
  leg.close()
  check('leg: after the end nothing is forwarded; commands and close do nothing more', real.bins.length === 2 && real.texts.length === 2 && nvr.commands.length === 2 && nvr.closed === 1)
}
{
  // a start or seek (gen): the generation is announced by the leg
  const nvr = scriptedNvr()
  const real = fakeWs()
  const leg = fb.startLeg({ nvr, ch: 0, fromMs: F, toMs: F + 60_000, stream: 0, speed: 1, paused: false, skewMs: SKEW, real, gen: 3 })
  check('startLeg at 1x, playing: no command sent', nvr.commands.length === 0, J(nvr.commands))
  nvr.ws.send(nvrFrame(1, true, nvrAt(F - 300))) // a frame before its started (and before T: the preroll)
  nvr.ws.send(J({ type: 'started' }))
  check('proxy (start/seek): started gen at T src nvr, once, before the first frame (the preroll before T is sent)', J(real.texts) === J([{ type: 'started', gen: 3, at: F, src: 'nvr' }]) && real.log[0].text && real.log[1]?.bin && Math.abs(real.bins[0].tsMs - (F - 300)) < 1, J(real.texts))
  leg.command({ speed: 32 })
  leg.command({ speed: 4 })
  leg.command({ speed: -4 })
  leg.command({ pause: false })
  leg.command({ speed: 1 })
  check('command: speeds capped at 8, reverse not sent, pause passes', J(nvr.commands) === J([{ speed: 8 }, { speed: 4 }, { pause: false }, { speed: 1 }]), J(nvr.commands))
  nvr.ws.send(J({ type: 'end' }))
  const r = await leg.done
  check('leg: {type:"end"} from the session ends it (not forwarded), the session closed', r.reason === 'end' && !real.texts.some((m) => m.type === 'end') && nvr.closed === 1, J(r))
}
{
  // a browser that cannot decode H.265: the NVR session must convert as the server does, or the leg's
  // raw H.265 reaches a player with no decoder for it and playback dies with "install HEVC"
  const nvr = scriptedNvr()
  const real = fakeWs()
  const leg = fb.startLeg({ nvr, ch: 0, fromMs: F, toMs: F + 60_000, skewMs: SKEW, real, gen: null, h265: false })
  check('startLeg h265: false: h265=0 on the URL (the NVR session converts H.265 to H.264)', nvr.url?.searchParams.get('h265') === '0', String(nvr.url))
  leg.close()
  await leg.done
}
{
  const nvr = scriptedNvr()
  const real = fakeWs()
  const leg = fb.startLeg({ nvr, ch: 0, fromMs: F, toMs: F + 60_000, skewMs: SKEW, real, gen: null })
  nvr.ws.send(J({ type: 'started' }))
  nvr.ws.send(nvrFrame(1, true, nvrAt(F + 100)))
  leg.close()
  const r = await leg.done
  nvr.ws.send(nvrFrame(2, false, nvrAt(F + 140)))
  nvr.ws.send(J({ type: 'stream', stream: 0 }))
  check("close(): fires the session's close handler (it stops and frees its login); done: closed", nvr.closed === 1 && r.reason === 'closed' && nvr.ws.readyState !== nvr.ws.OPEN, J(r))
  check('close(): nothing from the leg is forwarded afterwards', real.bins.length === 1 && real.texts.length === 1, `${real.bins.length} ${real.texts.length}`)
}
{
  const nvr = scriptedNvr()
  const real = fakeWs()
  const leg = fb.startLeg({ nvr, ch: 0, fromMs: F, toMs: F + 60_000, skewMs: SKEW, real, gen: 1 })
  nvr.ws.send(J({ type: 'error', message: 'No recording at this time' }))
  nvr.ws.close(1011, 'playback failed')
  const r = await leg.done
  check('the session fails: done {reason:"error", message}, not announced; nothing reaches the browser', r.reason === 'error' && r.message === 'No recording at this time' && r.announced === false && real.texts.length === 0 && real.closedWith === 0 && nvr.closed === 1, J(r))
}
{
  const nvr = scriptedNvr()
  const real = fakeWs()
  const leg = fb.startLeg({ nvr, ch: 0, fromMs: F, toMs: F + 60_000, skewMs: SKEW, real, gen: null })
  nvr.ws.send(J({ type: 'started' }))
  nvr.ws.close(1011, 'buffer overflow')
  const r = await leg.done
  check('the session closes its socket without a message: done error with its reason; the browser socket stays open', r.reason === 'error' && /buffer overflow/.test(r.message ?? '') && r.announced === true && real.closedWith === 0, J(r))
}
{
  const nvr = scriptedNvr()
  const real = fakeWs()
  const t = performance.now()
  const leg = fb.startLeg({ nvr, ch: 0, fromMs: F, toMs: F + 60_000, skewMs: SKEW, real, gen: 2, startTimeoutMs: 100 })
  const r = await leg.done
  check('no started within startTimeoutMs: done error, the session closed', r.reason === 'error' && /in time/.test(r.message ?? '') && nvr.closed === 1 && performance.now() - t >= 90 && real.texts.length === 0, J(r))
}
{
  const nvr = scriptedNvr({ throwOnConnect: true })
  const real = fakeWs()
  const leg = fb.startLeg({ nvr, ch: 0, fromMs: F, toMs: F + 60_000, skewMs: SKEW, real, gen: 1 })
  const r = await leg.done
  check('connect throws: done error, nothing sent', r.reason === 'error' && /exploded/.test(r.message ?? '') && real.texts.length === 0 && real.bins.length === 0, J(r))
}

// ==== ServerPlayback with legs ===============================================================================
{
  // a start in NVR-only time, then the switch back to disk at the server's first frame
  const nvr = fakeNvr({ cover: [[S0 - 3_600_000, S0 + 3_600_000]] })
  const T = S0 - 60_000
  const before = timers()
  const { ws } = open(0, T, { nvr })
  const ok = await until(() => ws.texts.some((m) => m.type === 'source' && m.src === 'server') && ws.bins.filter((b) => !isNvr(b)).length >= 50, 8000)
  const c = nvr.connects[0]
  check('start in NVR-only time: one NVR session, from T in its clock (T + 220 s)', nvr.connects.length === 1 && c.start === T + SKEW, `${nvr.connects.length} sessions, start ${c ? c.start - T : '-'}`)
  check('... the first message is started gen 0 at T, src nvr (then its frames)', J(ws.texts[0]) === J({ type: 'started', gen: 0, at: T, src: 'nvr' }) && ws.log.findIndex((e) => e.bin) > 0, J(ws.texts))
  const nb = ws.bins.filter(isNvr)
  const conv = nb.every((b) => c.sent[nOf(b)] && Math.abs(b.tsMs - (c.sent[nOf(b)].ts - SKEW)) < 1)
  check('... NVR frames with ts converted to server time (within 1 ms)', nb.length > 100 && conv, `${nb.length} frames, converted ${conv}`)
  const iSrc = ws.log.findIndex((e) => e.text?.type === 'source')
  const src = ws.log[iSrc]?.text
  check('at S: the NVR session is closed, then source server {from: the first frame of S}', ok && c.closed && c.closedAt <= ws.log[iSrc].at && src.src === 'server' && Math.abs(src.from - exp0[0].ts) < 0.001 && src.to === null, J(src))
  const after = ws.log.slice(iSrc + 1).filter((e) => e.bin).map((e) => e.bin)
  check('... followed by disk frames from S: its first keyframe, then every frame in order, byte-equal', after.length >= 50 && after.every((b) => !isNvr(b)) && after[0].us === exp0[0].us && !seqCheck(after, exp0, by0), seqCheck(after, exp0, by0) || `${after.length}`)
  const beforeSrc = ws.log.slice(0, iSrc).filter((e) => e.bin).map((e) => e.bin)
  check('... only NVR frames before the switch, all before S', beforeSrc.every(isNvr) && nb.every((b) => b.tsMs < exp0[0].ts))
  check('across the switch: no frame twice, none out of order (ts strictly increasing)', increasing(ws.bins))
  check('the NVR coverage came from one search; no notice (nothing skipped)', nvr.recCalls.length === 1 && !ws.texts.some((m) => m.type === 'notice'), `${nvr.recCalls.length} searches`)
  ws.close(1000)
  await sleep(100)
  check('close: timers cleared (the session, the leg, the NVR session)', timers() === before, `${before} before, ${timers()} after`)
  check('one log line for the leg', logs.some((l) => /NVR leg .* reached/.test(l)), logs.filter((l) => /NVR leg/.test(l)).join(' | '))
  check('a page that did not say what it decodes: the leg asks for h265=1 (the recording itself)', c?.url.searchParams.get('h265') === '1', String(c?.url))
}
{
  // A browser that cannot decode H.265 (&h265=0): the NVR's own playback in a leg must be converted
  // too, at a start in NVR-only time and at a hole the NVR fills. Before, the leg's URL had no h265,
  // playback.mjs took that as "can decode", and raw H.265 went to a player with no decoder for it.
  const nvr = fakeNvr({ cover: [[S0 - 3_600_000, S0 + 3_600_000]] })
  const { ws } = open(0, S0 - 60_000, { nvr, extra: '&h265=0' })
  await until(() => nvr.connects.length > 0, 3000)
  check('h265=0, a start in NVR-only time: the leg asks the NVR session for h265=0', nvr.connects[0]?.url.searchParams.get('h265') === '0', String(nvr.connects[0]?.url))
  ws.close(1000)
  const gap = fakeNvr({ cover: [[S2 - 3_600_000, S2 + 3_600_000]] })
  const g = open(2, exp2[0].ts, { nvr: gap, extra: '&h265=0' })
  g.ws.command({ speed: 4 })
  await until(() => gap.connects.length > 0, 8000)
  check('h265=0, a 90 s hole the NVR fills: the leg asks the NVR session for h265=0', gap.connects[0]?.url.searchParams.get('h265') === '0', String(gap.connects[0]?.url))
  g.ws.close(1000)
  await sleep(50)
}
{
  // commands during a leg
  const nvr = fakeNvr({ cover: [[S0 - 3_600_000, S0 + 3_600_000]] })
  const { ws } = open(0, S0 - 3_000_000, { nvr })
  await until(() => ws.bins.length >= 5, 3000)
  ws.command({ pause: true })
  ws.command({ pause: false })
  ws.command({ speed: 4 })
  ws.command({ speed: 16 })
  await sleep(50)
  const c = nvr.connects[0]
  check('during a leg: {pause} and {speed:4} reach the NVR session; {speed:16} reaches it as 8', J(c?.commands) === J([{ pause: true }, { pause: false }, { speed: 4 }, { speed: 8 }]), J(c?.commands))
  check('... the leg plays on (not closed, no new generation, no stills mode)', !c.closed && ws.texts.filter((m) => m.type === 'started').length === 1 && !ws.texts.some((m) => m.type === 'mode'), J(ws.texts))
  ws.close(1000)
  await sleep(20)
  check('closing the browser socket closes the NVR session', c.closed)
}
for (const [label, setup, why, sessions, searches] of [
  ['the leg fails ("No recording at this time")', (n) => (n.mode = 'fail'), /the NVR could not play it \(No recording at this time\)/, 1, 1],
  ['the NVR is offline', (n) => (n.online = false), /offline/, 0, 0],
  ['the NVR is busy (NvrBusy)', (n) => (n.busy = true), /busy/, 0, 1]
]) {
  const nvr = fakeNvr({ cover: [[S0 - 3_600_000, S0 + 3_600_000]] })
  setup(nvr)
  const T = S0 - 60_000
  const t0 = performance.now()
  const { ws } = open(0, T, { nvr })
  const ok = await until(() => ws.bins.length >= 20, 4000)
  const iN = ws.log.findIndex((e) => e.text?.type === 'notice')
  const iS = ws.log.findIndex((e) => e.text?.type === 'started')
  const st = ws.log[iS]?.text
  const nt = ws.log[iN]?.text
  check(`${label}: a notice, then started gen 0 src server at S, then disk frames from S (no hang)`, ok && iN >= 0 && iN < iS && st.src === 'server' && st.gen === 0 && Math.abs(st.from - exp0[0].ts) < 0.001 && ws.bins[0].us === exp0[0].us && ws.bins.every((b) => !isNvr(b)) && !seqCheck(ws.bins, exp0, by0) && ws.bins[0].at - t0 < 3000, J(ws.texts.slice(0, 3)))
  check(`${label}: the notice says what was skipped and why`, /^Skipped \d\d:\d\d:\d\d–\d\d:\d\d:\d\d: not recorded on the server; /.test(nt?.message ?? '') && why.test(nt.message), nt?.message)
  check(`${label}: ${sessions} NVR session(s), ${searches} search(es); no error, the socket stays open`, nvr.connects.length === sessions && nvr.recCalls.length === searches && !ws.texts.some((m) => m.type === 'error') && ws.closedWith === 0, `${nvr.connects.length} sessions, ${nvr.recCalls.length} searches, ${J(ws.texts.map((m) => m.type))}`)
  ws.close(1000)
}
{
  // the NVR's footage starts after T (but before S): a notice to it, then the leg from there;
  // connectPlayback's default legs are rec-fallback's
  const nvr = fakeNvr({ cover: [[S0 - 60_000, S0 + 3_600_000]] })
  const T = S0 - 180_000
  const { ws } = open(0, T, { nvr, defaultLegs: true })
  await until(() => nvr.connects.length === 1 && ws.bins.length > 5, 3000)
  const [nt, st] = ws.texts
  check('the NVR has footage only from later than T: a notice T to it, then started src nvr there (default legs)', nt?.type === 'notice' && nt.from === T && nt.to === S0 - 60_000 && / not recorded$/.test(nt.message) && J(st) === J({ type: 'started', gen: 0, at: S0 - 60_000, src: 'nvr' }) && nvr.connects[0]?.start === S0 - 60_000 + SKEW, J(ws.texts.slice(0, 2)))
  ws.close(1000)
}
{
  const nvr = fakeNvr({ cover: [] })
  const { ws } = open(0, S0 - 120_000, { nvr })
  await until(() => ws.bins.length > 0, 3000)
  check('the NVR has nothing either: "not recorded", started src server at S, no NVR session', ws.texts[0]?.type === 'notice' && / not recorded$/.test(ws.texts[0].message) && ws.texts[1]?.type === 'started' && ws.texts[1].src === 'server' && ws.bins[0]?.us === exp0[0].us && nvr.connects.length === 0 && nvr.recCalls.length === 1, J(ws.texts.slice(0, 2)))
  ws.close(1000)
}

// ---- gaps ------------------------------------------------------------------------------------------------
{
  const nvr = fakeNvr({ cover: [[S1 - 3_600_000, S1 + 3_600_000]] })
  const { ws } = open(1, exp1[0].ts, { nvr, opts: { endGraceMs: 300 } })
  ws.command({ speed: 4 })
  await until(() => ws.texts.some((m) => m.type === 'end'), 8000)
  const bad = seqCheck(ws.bins, exp1, usMap(exp1))
  // (a notice says what was jumped: every hole over gapMs gets one)
  check('a 10 s server gap: jumped with a notice, every server frame in order; the NVR is not asked (no search, no session)', !bad && ws.bins.length === exp1.length && nvr.recCalls.length === 0 && nvr.connects.length === 0 && !ws.texts.some((m) => m.type === 'source') && ws.texts.filter((m) => m.type === 'notice').length === 1, bad || `${ws.bins.length}/${exp1.length}, ${nvr.recCalls.length} searches, ${J(ws.texts.map((m) => m.type))}`)
  ws.close(1000)
}
{
  const nvr = fakeNvr({ cover: [[S2 - 3_600_000, S2 + 3_600_000]] })
  const { ws } = open(2, exp2[0].ts, { nvr, opts: { endGraceMs: 300 } })
  ws.command({ speed: 4 })
  await until(() => ws.texts.some((m) => m.type === 'end'), 10_000)
  const c = nvr.connects[0]
  const endA = cam2.segs[0].endMs
  const lastA = exp2.filter((f) => f.seg === cam2.segs[0].path).at(-1)
  const firstB = exp2.find((f) => f.seg === cam2.segs[1].path)
  const disk = ws.bins.filter((b) => !isNvr(b))
  const nb = ws.bins.filter(isNvr)
  const iNvr = ws.log.findIndex((e) => e.text?.type === 'source' && e.text.src === 'nvr')
  const iSrv = ws.log.findIndex((e) => e.text?.type === 'source' && e.text.src === 'server')
  const iLastA = ws.log.findIndex((e) => e.bin?.us === lastA.us)
  const iFirstB = ws.log.findIndex((e) => e.bin?.us === firstB.us)
  const sn = ws.log[iNvr]?.text
  check('a 90 s gap covered by the NVR: one NVR session from the end of the first file (in its clock), at 4x', nvr.connects.length === 1 && Math.abs(c.start - (endA + SKEW)) <= 1 && c.commands.some((m) => m.speed === 4), `${nvr.connects.length} sessions, start ${c ? c.start - SKEW - endA : '-'}, ${J(c?.commands)}`)
  check('... source nvr {from: the end of the first file, to: the next file} after its last frame', iNvr > iLastA && iLastA >= 0 && Math.abs(sn.from - endA) < 1 && Math.abs(sn.to - firstB.ts) < 0.001, J(sn))
  check('... NVR frames only inside the gap, converted (within 1 ms), starting with a keyframe, between the two source messages', nb.length > 100 && nb[0].key && nb.every((b) => b.tsMs > lastA.ts && b.tsMs < firstB.ts && c.sent[nOf(b)] && Math.abs(b.tsMs - (c.sent[nOf(b)].ts - SKEW)) < 1) && ws.log.every((e, j) => !e.bin || !isNvr(e.bin) || (j > iNvr && j < iSrv)), `${nb.length} frames`)
  check('... the NVR session closed, then source server, then the next file from its first frame', c.closed && iSrv > iNvr && c.closedAt <= ws.log[iSrv].at && iFirstB > iSrv && Math.abs(ws.log[iSrv].text.from - firstB.ts) < 0.001, J(ws.log[iSrv]?.text))
  check('... every server frame once, in order, byte-equal; ts strictly increasing across both switches', disk.length === exp2.length && !seqCheck(disk, exp2, usMap(exp2)) && increasing(ws.bins), seqCheck(disk, exp2, usMap(exp2)) || `${disk.length}/${exp2.length}`)
  check('... the NVR was searched before the gap was reached (prefetched), no notice', nvr.recCalls.length >= 1 && nvr.recCalls[0].at < ws.log[iLastA].at && !ws.texts.some((m) => m.type === 'notice'), `${nvr.recCalls.length} searches`)
  check('... then end newest as without legs', ws.texts.at(-1)?.type === 'end' && ws.texts.at(-1).newest === true, J(ws.texts.at(-1)))
  ws.close(1000)
}
{
  // the same gap with the NVR offline: jumped with a notice that says why
  const nvr = fakeNvr({ cover: [[S2 - 3_600_000, S2 + 3_600_000]] })
  nvr.online = false
  const { ws } = open(2, exp2[0].ts, { nvr, opts: { endGraceMs: 300 } })
  ws.command({ speed: 4 })
  await until(() => ws.texts.some((m) => m.type === 'end'), 8000)
  const nt = ws.texts.find((m) => m.type === 'notice')
  check('a 90 s gap with the NVR offline: jumped, every server frame, a notice naming the reason', ws.bins.length === exp2.length && !seqCheck(ws.bins, exp2, usMap(exp2)) && nvr.connects.length === 0 && /not recorded on the server; the NVR is offline$/.test(nt?.message ?? ''), nt?.message)
  ws.close(1000)
}
{
  // a hole inside one file (the NVR stalled and the stream came back within the minute, so the writer carried
  // on in the same file): 6 s, no frames for 39 s, 10 s. The NVR has the stretch: it plays it, as between files.
  const S3 = Date.UTC(2026, 8, 24, 13, 0, 0)
  const rnd = prng(6)
  const steady = (at, n) => Array.from({ length: n }, (_, i) => ({ buf: i % 50 ? h264.p(rnd, 300) : h264.key(rnd, 1500), isKey: i % 50 === 0, ts: at + i * 40 }))
  const cam3 = await recordGroups(3, [[...steady(S3, 150), ...steady(S3 + 45_000, 250)]])
  const exp3 = await readBack(cam3.segs)
  const lastA = S3 + 5960
  const firstB = S3 + 45_000
  const nvr = fakeNvr({ cover: [[S3 - 3_600_000, S3 + 3_600_000]] })
  const { ws } = open(3, S3, { nvr, opts: { endGraceMs: 300 } })
  ws.command({ speed: 4 })
  await until(() => ws.texts.some((m) => m.type === 'end'), 10_000)
  const c = nvr.connects[0]
  const disk = ws.bins.filter((b) => !isNvr(b))
  const nb = ws.bins.filter(isNvr)
  const iNvr = ws.log.findIndex((e) => e.text?.type === 'source' && e.text.src === 'nvr')
  const iSrv = ws.log.findIndex((e) => e.text?.type === 'source' && e.text.src === 'server')
  const iLastA = ws.log.findIndex((e) => e.bin && !isNvr(e.bin) && Math.abs(e.bin.tsMs - lastA) < 1)
  const iFirstB = ws.log.findIndex((e) => e.bin && !isNvr(e.bin) && Math.abs(e.bin.tsMs - firstB) < 1)
  const sn = ws.log[iNvr]?.text
  check('a 39 s hole inside one file covered by the NVR: one file; one NVR session from the last frame before the hole (in its clock)', cam3.segs.length === 1 && nvr.connects.length === 1 && Math.abs(c.start - (lastA + SKEW)) <= 1, `${cam3.segs.length} files, ${nvr.connects.length} sessions, start ${c ? c.start - SKEW - lastA : '-'}`)
  check('... source nvr {from: that frame, to: the keyframe after the hole} after it; NVR frames only inside the hole', iNvr > iLastA && iLastA >= 0 && Math.abs(sn.from - lastA) < 1 && Math.abs(sn.to - firstB) < 1 && nb.length > 50 && nb.every((b) => b.tsMs > lastA && b.tsMs < firstB), `${J(sn)}, ${nb.length} NVR frames`)
  check('... then source server and the rest from disk: every server frame once, in order, each at its time as written', iSrv > iNvr && iFirstB > iSrv && disk.length === exp3.length && !seqCheck(disk, exp3, usMap(exp3)) && exp3.every((f, i) => Math.abs(f.ts - cam3.accepted[i].ts) < 1) && increasing(ws.bins), seqCheck(disk, exp3, usMap(exp3)) || `${disk.length}/${exp3.length}`)
  ws.close(1000)
}

// ---- a seek during a leg ------------------------------------------------------------------------------------
{
  const nvr = fakeNvr({ cover: [[S0 - 3_600_000, S0 + 3_600_000]] })
  const { ws } = open(0, S0 - 3_000_000, { nvr })
  await until(() => ws.bins.length >= 20, 3000)
  const T2 = S0 + 3000
  const k2 = keyBefore(exp0, T2)
  ws.command({ seek: T2, gen: 1 })
  await until(() => ws.bins.some((b) => !isNvr(b)), 2000)
  await sleep(300)
  const c = nvr.connects[0]
  const iSt = ws.log.findIndex((e) => e.text?.type === 'started' && e.text.gen === 1)
  const st = ws.log[iSt]?.text
  const after = ws.log.slice(iSt + 1).filter((e) => e.bin).map((e) => e.bin)
  check('seek during a leg: the leg is closed before started gen 1 (src server, at T2)', iSt > 0 && c.closed && c.closedAt <= ws.log[iSt].at && st.src === 'server' && st.at === T2, J(st))
  check('... nothing from the leg after it: disk frames from the key before T2', after.length > 10 && after.every((b) => !isNvr(b)) && after[0].us === k2.us && !seqCheck(after, exp0, by0), seqCheck(after, exp0, by0) || `${after.length}`)
  check('... one NVR session only', nvr.connects.length === 1)
  ws.close(1000)
}

// ---- scrub, reverse and keyframe speeds never start a leg -------------------------------------------------------
{
  const nvr = fakeNvr({ cover: [[S0 - 3_600_000, S0 + 3_600_000]] })
  {
    const { ws } = open(0, S0 + 2000, { nvr })
    await until(() => ws.bins.length > 0, 2000)
    ws.command({ scrub: S0 - 60_000, gen: 1 })
    await until(() => ws.texts.some((m) => m.type === 'scrub'), 1000)
    check('a scrub over NVR-only time: scrub none, no NVR session', J(ws.texts.find((m) => m.type === 'scrub')) === J({ type: 'scrub', gen: 1, none: true }) && nvr.connects.length === 0, J(ws.texts))
    ws.close(1000)
  }
  {
    const { ws } = open(0, S0 + 5000, { nvr })
    await until(() => ws.bins.length > 0, 2000)
    ws.command({ speed: -4 })
    await until(() => ws.texts.some((m) => m.type === 'end'), 5000)
    check('reverse into NVR-only time: end reverse at the first server frame, no NVR session', J(ws.texts.at(-1)) === J({ type: 'end', reverse: true }) && ws.bins.at(-1)?.us === exp0[0].us && nvr.connects.length === 0, J(ws.texts.at(-1)))
    ws.close(1000)
  }
  {
    const { ws } = open(0, S0 - 60_000, { nvr })
    ws.command({ speed: -4 }) // as the page sends it on open
    await until(() => ws.texts.some((m) => m.type === 'end'), 5000)
    await sleep(100)
    check('reverse from a start in NVR-only time: end reverse, no frame, no NVR session', ws.texts.at(-1)?.type === 'end' && ws.texts.at(-1).reverse === true && ws.bins.length === 0 && nvr.connects.length === 0, J(ws.texts))
    ws.close(1000)
  }
  {
    const { ws } = open(0, S0 - 60_000, { nvr })
    ws.command({ speed: 16 })
    await until(() => ws.bins.length > 0, 3000)
    await sleep(100)
    check('16x (keyframes) never starts a leg: started src server at S, keyframes from disk only', nvr.connects.length === 0 && ws.texts.find((m) => m.type === 'started')?.src === 'server' && ws.bins.length > 0 && ws.bins.every((b) => b.key && !isNvr(b)), J(ws.texts))
    ws.close(1000)
  }
}

// ---- speed changes during a leg, a failed leg at a hole, an NVR that does not answer ------------------------------
const lastA2 = exp2.filter((f) => f.seg === cam2.segs[0].path).at(-1)
const firstB2 = exp2.find((f) => f.seg === cam2.segs[1].path)
{
  // reverse during a leg at a hole: the leg is closed; keyframes back from the server's footage before it
  const nvr = fakeNvr({ cover: [[S2 - 3_600_000, S2 + 3_600_000]] })
  const { ws } = open(2, exp2[0].ts, { nvr })
  ws.command({ speed: 4 })
  await until(() => ws.bins.filter(isNvr).length >= 20, 5000)
  ws.command({ speed: -4 })
  await until(() => ws.texts.some((m) => m.type === 'end'), 5000)
  const c = nvr.connects[0]
  const iMode = ws.log.findIndex((e) => e.text?.type === 'mode' && e.text.stills === true)
  const back = ws.log.slice(iMode + 1).filter((e) => e.bin).map((e) => e.bin)
  const keysA = exp2.filter((f) => f.isKey && f.seg === cam2.segs[0].path)
  check('reverse during a leg: the NVR session closed, mode stills, then keyframes back from the file before the hole, end reverse', iMode > 0 && c.closed && c.closedAt <= ws.log[iMode].at && back.length === keysA.length && back.every((b, j) => !isNvr(b) && b.key && b.us === keysA[keysA.length - 1 - j].us) && J(ws.texts.at(-1)) === J({ type: 'end', reverse: true }), `${back.length}/${keysA.length} keys, ${J(ws.texts.map((m) => m.type))}`)
  check('... no NVR frame after the reverse', ws.log.slice(iMode).every((e) => !e.bin || !isNvr(e.bin)))
  ws.close(1000)
}
{
  // 16x during a leg: the NVR session plays at 8x; after the leg the server's footage goes on in keyframes
  const nvr = fakeNvr({ cover: [[S2 - 3_600_000, S2 + 3_600_000]] })
  const { ws } = open(2, exp2[0].ts, { nvr, opts: { endGraceMs: 300 } })
  ws.command({ speed: 4 })
  await until(() => ws.bins.filter(isNvr).length >= 20, 5000)
  ws.command({ speed: 16 })
  await until(() => ws.texts.some((m) => m.type === 'source' && m.src === 'server'), 5000)
  await until(() => ws.log.slice(ws.log.findIndex((e) => e.text?.src === 'server')).some((e) => e.bin), 3000)
  const c = nvr.connects[0]
  const iSrv = ws.log.findIndex((e) => e.text?.type === 'source' && e.text.src === 'server')
  const first = ws.log.slice(iSrv + 1).find((e) => e.bin)?.bin
  check('16x during a leg: the NVR session gets 8x; the leg plays to the next file', J(c?.commands) === J([{ speed: 4 }, { speed: 8 }]) && iSrv > 0 && c.closed, J(c?.commands))
  check('... then keyframes from the next file (keyframe mode), nothing from the NVR after source server', first?.key && !isNvr(first) && first.us === firstB2.us && ws.log.slice(iSrv).every((e) => !e.bin || !isNvr(e.bin)) && increasing(ws.bins), `${first?.tsMs - firstB2.ts}`)
  ws.close(1000)
}
{
  // the leg at a hole fails: a notice that says why, then the next file (no source message)
  const nvr = fakeNvr({ cover: [[S2 - 3_600_000, S2 + 3_600_000]], mode: 'fail' })
  const { ws } = open(2, exp2[0].ts, { nvr, opts: { endGraceMs: 300 } })
  ws.command({ speed: 4 })
  await until(() => ws.texts.some((m) => m.type === 'end'), 8000)
  const nt = ws.texts.find((m) => m.type === 'notice')
  check('a failed leg at a hole: every server frame, a notice naming the NVR\'s error, no source message', ws.bins.length === exp2.length && !seqCheck(ws.bins, exp2, usMap(exp2)) && nvr.connects.length === 1 && /not recorded on the server; the NVR could not play it \(No recording at this time\)$/.test(nt?.message ?? '') && !ws.texts.some((m) => m.type === 'source'), `${nt?.message} ${J(ws.texts.map((m) => m.type))}`)
  ws.close(1000)
}
{
  // the NVR search never answers: the hole is jumped after legWaitMs with a notice
  const nvr = fakeNvr({ cover: [[S2 - 3_600_000, S2 + 3_600_000]] })
  nvr.hang = true
  const { ws } = open(2, exp2[0].ts, { nvr, opts: { endGraceMs: 300, legWaitMs: 300 } })
  ws.command({ speed: 4 })
  await until(() => ws.texts.some((m) => m.type === 'end'), 8000)
  const nt = ws.texts.find((m) => m.type === 'notice')
  const a = ws.bins.find((b) => b.us === lastA2.us)
  const b = ws.bins.find((x) => x.us === firstB2.us)
  const waited = b && a ? b.at - a.at : -1
  check('the NVR search does not answer: the hole is jumped after legWaitMs (300 ms) with a notice', ws.bins.length === exp2.length && !seqCheck(ws.bins, exp2, usMap(exp2)) && nvr.connects.length === 0 && /the NVR did not answer in time$/.test(nt?.message ?? '') && waited >= 250 && waited < 1500, `${nt?.message}, waited ${waited.toFixed(0)} ms`)
  ws.close(1000)
}
{
  // ... and at a start: after legWaitMs, from the server with a notice
  const nvr = fakeNvr({ cover: [[S0 - 3_600_000, S0 + 3_600_000]] })
  nvr.hang = true
  const t0 = performance.now()
  const { ws } = open(0, S0 - 60_000, { nvr, opts: { legWaitMs: 300 } })
  await until(() => ws.bins.length > 0, 3000)
  const took = ws.bins[0] ? ws.bins[0].at - t0 : -1
  check('a start while the NVR search does not answer: after legWaitMs a notice, then started src server at S', /the NVR did not answer in time$/.test(ws.texts[0]?.message ?? '') && ws.texts[1]?.src === 'server' && ws.bins[0]?.us === exp0[0].us && nvr.connects.length === 0 && took >= 250 && took < 1500, `${J(ws.texts.slice(0, 2))}, ${took.toFixed(0)} ms`)
  ws.close(1000)
}
{
  // the NVR coverage wait must not hold up a newer seek: the search hangs (legWaitMs 5 s), the page
  // seeks into NVR-only time, then 50 ms later back to server footage: gen 2's first frame < 150 ms
  const nvr = fakeNvr({ cover: [[S0 - 3_600_000, S0 + 3_600_000]] })
  nvr.hang = true
  const { ws } = open(0, S0, { nvr, opts: { legWaitMs: 5000 } })
  await until(() => ws.bins.length > 0, 3000)
  ws.command({ seek: S0 - 60_000, gen: 1 }) // NVR-only: waits for the (hanging) coverage
  await sleep(50)
  const tSeek = performance.now()
  ws.command({ seek: S0 + 2000, gen: 2 })
  await until(() => ws.texts.some((m) => m.type === 'started' && m.gen === 2) && ws.log.some((l) => l.bin && l.at > tSeek), 3000)
  const iStart = ws.log.findIndex((l) => l.text?.type === 'started' && l.text.gen === 2)
  const first = iStart >= 0 ? ws.log.slice(iStart).find((l) => l.bin) : null
  const took = first ? first.at - tSeek : -1
  check('a seek while an NVR coverage wait hangs: the newer seek to server footage plays within 150 ms', first && took >= 0 && took < 150 && ws.texts.find((m) => m.type === 'started' && m.gen === 2)?.src === 'server', `${took.toFixed(0)} ms, ${J(ws.texts.map((m) => m.type + (m.gen ?? '')))}`)
  check('... and gen 1 never started', !ws.texts.some((m) => m.type === 'started' && m.gen === 1))
  ws.close(1000)
}

// ---- the real PlaybackSession (playback.mjs) through the proxy ----------------------------------------------------
{
  let pb = null
  let lanes = null
  try {
    pb = await import('../playback.mjs')
    lanes = await import('../lanes.mjs')
  } catch (e) {
    console.log(`SKIP  the real PlaybackSession through the proxy (${e.message})`)
  }
  if (pb) {
    const { PRIORITY } = lanes
    // the lane answers each job without running it, so no SDK call runs (as in playback-busy.test.mjs)
    const answers = [true, 77, true] // GetDeviceTime, PlayBackByTimeEx (a handle), SetPlayDataCallBack
    const nvr = { id: 'fb-real', name: 'NVR fb-real', userId: 7, online: true, degraded: false, jobs: [], logins: 0, releases: 0 }
    nvr.lane = {
      run: (_task, { priority = PRIORITY.NORMAL } = {}) => {
        nvr.jobs.push(priority)
        return Promise.resolve(answers.length ? answers.shift() : true)
      }
    }
    nvr.sessions = {
      acquire: async () => {
        nvr.logins++
        return { userId: 9, release: () => nvr.releases++ }
      }
    }
    nvr.playback = pb.createPlayback(nvr)
    const real = fakeWs()
    const from = Date.now() - 3_600_000
    const leg = fb.startLeg({ nvr, ch: 0, fromMs: from, toMs: from + 600_000, stream: 0, speed: 1, paused: false, skewMs: 0, real, gen: null })
    await until(() => real.texts.length > 0, 2000)
    check('real NVR session through the proxy: it opens (one login) and its started becomes source nvr', J(real.texts[0]) === J({ type: 'source', src: 'nvr', from, to: from + 600_000 }) && nvr.logins === 1 && real.closedWith === 0, J(real.texts))
    const jobs = nvr.jobs.length
    leg.command({ speed: 16 })
    await sleep(50)
    check('... a speed command reaches it (8x): one playback control at HIGH priority', nvr.jobs.length === jobs + 1 && nvr.jobs.at(-1) === PRIORITY.HIGH, nvr.jobs.join())
    leg.close()
    await until(() => nvr.releases === 1, 1000)
    check('... close() stops its NVR playback (a HIGH call) and frees its login', nvr.releases === 1 && nvr.jobs.length === jobs + 2 && nvr.jobs.at(-1) === PRIORITY.HIGH, `${nvr.releases} released, jobs ${nvr.jobs.join()}`)
    const r = await leg.done
    check('... done: closed; nothing more reached the browser', r.reason === 'closed' && real.texts.length === 1 && real.bins.length === 0, J(r))
  }
}

IDX.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
