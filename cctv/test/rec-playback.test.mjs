// Tests for rec-playback.mjs (playback from server recordings, phase 3 Task 3):
//   connectPlayback  server or NVR per socket (src=auto), unchanged NVR path, R15 refusal
//   ServerPlayback   preroll burst, server-side pacing, 1/2/4x all frames, 8-32x keyframes (at most
//                    8 per second), reverse, long GOPs and keyframes-only footage paced at their media
//                    time (only holes are jumped: between files, and inside a file where the NVR stalled),
//                    pause, seek and scrub with gen numbers, segment crossing, gaps, the open (growing) file
//                    (its row looked up by path once closed), unreadable files, flow control, close
// Temp dirs, a temp index, fake NVR objects and a fake WebSocket only: nothing reaches an NVR.
// Run:  node cctv/test/rec-playback.test.mjs
import { mkdtempSync, unlinkSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rec-pb-'))

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

const { SegmentWriter } = await import('../segment-writer.mjs')
const { openRecIndex } = await import('../rec-index.mjs')
const { SegmentReader } = await import('../rec-reader.mjs')
let rp = {}
try {
  rp = await import('../rec-playback.mjs')
} catch (e) {
  check('load ../rec-playback.mjs', false, e.message)
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

// ---- synthetic H.264 (as in rec-reader.test.mjs) -------------------------------------------------
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
// H.265 the same way (2-byte NAL headers): VPS, SPS, PPS, then an IDR slice; a TRAIL_R slice. The byte
// after a slice's header has its top bit set: first_slice_segment_in_pic_flag, a new picture.
const h265 = {
  key: (rnd, len = 3000) => Buffer.concat([nal(true, [0x40, 0x01], rnd, 12), nal(false, [0x42, 0x01], rnd, 12), nal(false, [0x44, 0x01], rnd, 4), nal(false, [0x26, 0x01, 0x80], rnd, len)]),
  p: (rnd, len = 600) => nal(true, [0x02, 0x01, 0x80], rnd, len)
}

/**
 * n frames at 25 fps from t0, a key every `gop`. Arrival stamps as the recorder makes them: the NVR
 * sends in bursts (every 200-300 ms), so a frame's stamp is the first burst at or after its capture
 * time: key times jitter by up to 300 ms and never go back.
 */
function makeFrames(rnd, t0, n, { gop = 50, codec = h264 } = {}) {
  const out = []
  let burst = t0
  for (let i = 0; i < n; i++) {
    const cap = t0 + i * 40
    while (burst < cap) burst += 200 + Math.floor(rnd() * 101)
    const isKey = i % gop === 0
    out.push({ buf: isKey ? codec.key(rnd, 1500 + Math.floor(rnd() * 2000)) : codec.p(rnd, 150 + Math.floor(rnd() * 700)), isKey, ts: burst })
  }
  return out
}

// ---- the recordings: a temp location and a temp index ------------------------------------------------
const ROOT = mkdtempSync(join(tmpdir(), 'rec-pb-loc-'))
const IDX = openRecIndex(join(process.env.DATA_DIR, 'recordings.db'))
const NVR_ID = 'n1'

/** Records groups of frames with a real SegmentWriter (one file or more per group) and indexes them. */
async function recordGroups(ch, groups, codec = 'h264') {
  const w = new SegmentWriter({ root: ROOT, nvrId: NVR_ID, ch, codec })
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
    // with the neighbours from the index, as the session opens it (the last GOP runs up to the next file's first key)
    const row = IDX.byPath(s.path)
    const nextStartMs = row ? (IDX.next(row.nvr, row.ch, row.startMs)?.startMs ?? null) : null
    const prevEndMs = row ? (IDX.prev(row.nvr, row.ch, row.startMs)?.endMs ?? null) : null
    const r = await new SegmentReader({ path: s.path, endMs: s.endMs, nextStartMs, prevEndMs }).open()
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
/** The media time shown at wall time w: the last frame delivered by then. */
const tsAt = (bins, w) => {
  let v = null
  for (const b of bins) {
    if (b.at > w) break
    v = b.tsMs
  }
  return v
}

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
/** A fake NVR: its playback records NVR sessions; clock()/recordings() must never be called. */
function fakeNvr(id = NVR_ID) {
  const nvr = { id, name: `NVR ${id}`, online: true, degraded: false, connects: [], calls: 0 }
  nvr.playback = {
    connect: (ws, url) => nvr.connects.push({ ws, url }),
    lastClock: () => ({ tzOffsetMs: 0, skewMs: 0, at: Date.now() }),
    clock: async () => {
      nvr.calls++
      throw new Error('the NVR must not be called')
    },
    recordings: async () => {
      nvr.calls++
      throw new Error('the NVR must not be called')
    }
  }
  return nvr
}
/** node:fs/promises with counters: opens, open handles, reads, reads in flight. */
function countingFs(stats) {
  Object.assign(stats, { opens: 0, open: 0, reads: 0, inFlight: 0, maxInFlight: 0 })
  return {
    async open(p, flags) {
      const fh = await fsp.open(p, flags)
      stats.opens++
      stats.open++
      let closed = false
      return {
        async read(buf, off, len, pos) {
          stats.reads++
          stats.maxInFlight = Math.max(stats.maxInFlight, ++stats.inFlight)
          try {
            return await fh.read(buf, off, len, pos)
          } finally {
            stats.inFlight--
          }
        },
        stat: () => fh.stat(),
        async close() {
          if (!closed) {
            closed = true
            stats.open--
          }
          return fh.close()
        }
      }
    }
  }
}

const ADMIN = { user: 'admin', admin: true }
const logs = []
const N = fakeNvr()
/** Opens a /playback socket through connectPlayback. */
function open(ch, start, { nvr = N, index = IDX, who = ADMIN, src = 'auto', stream = 0, legs = null, allowed, opts = {}, chParam, extra = '', remote } = {}) {
  const ws = fakeWs()
  const url = new URL(`ws://x/playback?nvr=${nvr.id}&ch=${chParam ?? ch}&stream=${stream}&start=${start}${src ? `&src=${src}` : ''}${extra}`)
  ws.t0 = performance.now()
  const args = { nvr, ws, url, who, index, legs, opts: { log: (l) => logs.push(l), ...opts } }
  if (allowed) args.allowed = allowed
  if (remote !== undefined) args.remote = remote // (server.mjs: isRemoteAddress of the socket)
  const session = rp.connectPlayback(args)
  return { ws, url, session }
}
const started = (ws, gen) => ws.texts.find((m) => m.type === 'started' && (gen === undefined || m.gen === gen))

// ---- footage ---------------------------------------------------------------------------------------
const T0 = Date.UTC(2026, 8, 24, 10, 0, 0)
// camera 0: 4 minutes at 25 fps, a key every 50 frames (2 s), key times jittering by up to 300 ms
const cam0 = await recordGroups(0, [makeFrames(prng(1), T0, 25 * 240)])
const exp0 = await readBack(cam0.segs)
const by0 = usMap(exp0)
check('footage: 4 minutes recorded in 4 one-minute files, read back whole', cam0.segs.length === 4 && exp0.length === cam0.accepted.length && exp0.every((f, i) => f.buf.equals(cam0.accepted[i].buf)), `${cam0.segs.length} files, ${exp0.length}/${cam0.accepted.length} frames`)
const keyBefore = (list, t) => list.filter((f) => f.isKey && f.ts <= t).at(-1)
// camera 1: 4 s, a 10 s gap, 4 s, a 60 s gap, 4 s
const T1 = Date.UTC(2026, 8, 24, 11, 0, 5)
const g1a = makeFrames(prng(2), T1, 100)
const g1b = makeFrames(prng(3), g1a.at(-1).ts + 10_000, 100)
const g1c = makeFrames(prng(4), g1b.at(-1).ts + 60_000, 100)
const cam1 = await recordGroups(1, [g1a, g1b, g1c])
const exp1 = await readBack(cam1.segs)
// camera 3: three contiguous 4 s files; camera 4 the same (one of them is deleted while playing)
const contiguous = (seed, t0) => {
  const all = makeFrames(prng(seed), t0, 300)
  return [all.slice(0, 100), all.slice(100, 200), all.slice(200)]
}
const cam3 = await recordGroups(3, contiguous(5, Date.UTC(2026, 8, 24, 12, 0, 10)))
const exp3 = await readBack(cam3.segs)
const cam4 = await recordGroups(4, contiguous(6, Date.UTC(2026, 8, 24, 13, 0, 10)))
const exp4 = await readBack(cam4.segs)
check('footage: cameras 1, 3 and 4 have 3 files each', cam1.segs.length === 3 && cam3.segs.length === 3 && cam4.segs.length === 3, `${cam1.segs.length} ${cam3.segs.length} ${cam4.segs.length}`)

// ---- encodeDiskFrame: the /live wire format, width and height 0 --------------------------------------
{
  const buf = h264.key(prng(9), 500)
  const ts = T0 + 1234.567
  const m = rp.encodeDiskFrame(buf, true, 1, ts)
  const ok = m.length === 16 + buf.length && m[0] === 1 && m[1] === 1 && m.readUInt16LE(2) === 0 && m.readUInt16LE(4) === 0 && m.readUInt16LE(6) === 0 && m.readBigInt64LE(8) === BigInt(Math.round(ts * 1000)) && m.subarray(16).equals(buf)
  check('encodeDiskFrame: flags, codec, w = h = 0, ts in µs, the bytes as stored', ok)
  check('encodeDiskFrame: a delta frame has flags 0', rp.encodeDiskFrame(buf, false, 0, ts)[0] === 0)
  try {
    const { encodeFrame } = await import('../sdk.mjs')
    const same = encodeFrame({ keyFrame: 1, width: 0, height: 0, time: BigInt(Math.round(ts * 1000)), length: buf.length }, buf, 1)
    check('encodeDiskFrame: byte for byte the same as sdk.mjs encodeFrame', same.equals(m))
  } catch (e) {
    console.log(`SKIP  comparison with sdk.mjs encodeFrame (${e.message})`)
  }
}

// ---- no src=auto: today's NVR playback, unchanged ------------------------------------------------------
{
  const cases = [
    ['an admin, an index, recordings', IDX, ADMIN],
    ['no index (flag off)', null, ADMIN],
    ['a non-admin', IDX, { user: 'v', admin: false }]
  ]
  for (const [label, index, who] of cases) {
    const nvr = fakeNvr()
    const { ws, url } = open(0, T0 + 1000, { nvr, index, who, src: null })
    await sleep(30)
    check(`no src=auto (${label}): the NVR session gets the same ws and url; nothing else is sent`, nvr.connects.length === 1 && nvr.connects[0].ws === ws && nvr.connects[0].url === url && ws.texts.length === 0 && ws.bins.length === 0 && ws.closedWith === 0)
  }
  const off = fakeNvr()
  off.online = false
  const { ws } = open(0, T0 + 1000, { nvr: off, src: null })
  check('no src=auto, NVR offline: closed 1013 "NVR offline" as server.mjs did; no NVR session', ws.closedWith === 1013 && ws.closeReason === 'NVR offline' && off.connects.length === 0, `${ws.closedWith} ${ws.closeReason}`)
}

// ---- src=auto but not eligible (R15): an error and 1011, never a silent NVR session ------------------------
{
  const MSG = 'Server recordings are not available here; reload the page.'
  const cases = [
    ['no index (flag off)', { index: null }],
    ['a non-admin', { who: { user: 'v', admin: false } }],
    ['a camera without recordings', { ch: 9 }],
    ['refused by the access hook', { allowed: () => false }]
  ]
  for (const [label, o] of cases) {
    const nvr = fakeNvr()
    const { ws } = open(o.ch ?? 0, T0 + 1000, { nvr, ...o })
    await sleep(30)
    check(`src=auto, ${label}: error + close 1011, no NVR session`, ws.texts.length === 1 && ws.texts[0].type === 'error' && ws.texts[0].message === MSG && ws.closedWith === 1011 && nvr.connects.length === 0 && ws.bins.length === 0, J(ws.texts) + ` ${ws.closedWith}`)
  }
  const bad = open(0, T0, { chParam: 'x' })
  check('src=auto, bad parameters: closed 1008', bad.ws.closedWith === 1008, `${bad.ws.closedWith}`)
  // R14: server playback works while the NVR is offline
  const off = fakeNvr()
  off.online = false
  const { ws } = open(0, T0 + 1000, { nvr: off })
  const ok = await until(() => ws.bins.length > 0, 2000)
  check('src=auto with the NVR offline: server playback runs (R14), no NVR call', ok && started(ws)?.src === 'server' && off.calls === 0 && off.connects.length === 0)
  ws.close(1000)
  // SD asked for: server footage is HD only (R17)
  const sd = open(0, T0 + 1000, { stream: 1 })
  await until(() => sd.ws.bins.length > 0, 2000)
  check('src=auto with stream=1: {type:"stream", stream:0} first (server footage is HD only)', sd.ws.texts[0]?.type === 'stream' && sd.ws.texts[0].stream === 0, J(sd.ws.texts[0]))
  sd.ws.close(1000)
}

// ---- start at T mid-GOP, 1x: preroll burst, then paced ---------------------------------------------------
const T = T0 + 75_000 + 900
const kT = keyBefore(exp0, T)
{
  const { ws } = open(0, T)
  await until(() => ws.bins.length > 0, 2000)
  const st = ws.texts[0]
  check('start: the first text is started gen 0, at T, from <= T (the key before T), src server', st?.type === 'started' && st.gen === 0 && st.at === T && st.from <= T && Math.abs(st.from - kT.ts) < 0.001 && st.src === 'server', J(st))
  const b0 = ws.bins[0]
  check('start: the first binary is the keyframe at from; codec byte 0, w = h = 0', b0?.key && b0.us === kT.us && b0.codec === 0 && b0.w === 0 && b0.h === 0)
  const firstMs = b0.at - ws.t0
  check('start: connect to first binary under 150 ms', firstMs < 150, `${firstMs.toFixed(1)} ms`)
  check('start: started comes before the first binary', ws.log.findIndex((e) => e.text?.type === 'started') < ws.log.findIndex((e) => e.bin))
  await sleep(1600)
  const pre = ws.bins.filter((b) => b.tsMs < T)
  const want = exp0.filter((f) => f.ts >= kT.ts && f.ts < T).length
  check('start: every frame before T (the preroll) arrives within 50 ms of the first', pre.length === want && pre.at(-1).at - b0.at < 50, `${pre.length}/${want} in ${(pre.at(-1).at - b0.at).toFixed(1)} ms`)
  const bad = seqCheck(ws.bins, exp0, by0)
  check('frames byte-equal to the originals, key flags right, consecutive, ts increasing', !bad && ws.bins.every((b, j) => j === 0 || b.us > ws.bins[j - 1].us), bad)
  const w1 = pre.at(-1).at + 300
  const adv = tsAt(ws.bins, w1 + 1000) - tsAt(ws.bins, w1)
  check('pacing 1x: 1.0 s of wall time sends 1.0 s +- 15% of footage', Math.abs(adv - 1000) <= 150, `${adv.toFixed(0)} ms`)
  ws.close(1000)
}

// ---- 2x and 4x: every frame, footage x2 / x4 --------------------------------------------------------------
for (const speed of [2, 4]) {
  const { ws } = open(0, T)
  ws.command({ speed }) // as the page does on open
  await until(() => ws.bins.length > 0, 2000)
  await sleep(1500)
  const b0 = ws.bins[0]
  const pre = ws.bins.filter((b) => b.tsMs < T)
  const w1 = (pre.at(-1) ?? b0).at + 200
  const adv = tsAt(ws.bins, w1 + 1000) - tsAt(ws.bins, w1)
  const bad = seqCheck(ws.bins, exp0, by0)
  check(`${speed}x: one started (gen 0), every frame (none skipped), byte-equal`, ws.texts.filter((m) => m.type === 'started').length === 1 && !bad && b0.us === kT.us, bad)
  check(`${speed}x: footage advances x${speed} +- 15%`, Math.abs(adv - 1000 * speed) <= 150 * speed, `${adv.toFixed(0)} ms in 1 s`)
  ws.close(1000)
}

// ---- 8x, 16x, 32x: keyframes only, at most 8 per wall second ------------------------------------------------
{
  const keys0 = exp0.filter((f) => f.isKey)
  const keyByUs = usMap(keys0)
  for (const speed of [8, 16, 32]) {
    const { ws } = open(0, T)
    ws.command({ speed })
    await until(() => ws.bins.length > 0, 2000)
    await sleep(2000)
    const bins = ws.bins
    const onlyKeys = bins.every((b) => b.key && keyByUs.has(b.us) && b.buf.equals(keys0[keyByUs.get(b.us)].buf))
    const inc = bins.every((b, j) => j === 0 || b.us > bins[j - 1].us)
    const span = (bins.at(-1).at - bins[0].at) / 1000
    const rate = (bins.length - 1) / span
    let worstWin = 0
    for (let j = 0; j < bins.length; j++) worstWin = Math.max(worstWin, bins.filter((b) => b.at >= bins[j].at && b.at < bins[j].at + 1000).length)
    const steps = bins.slice(1).map((b, j) => b.tsMs - bins[j].tsMs)
    const idx = bins.map((b) => keyByUs.get(b.us))
    const stride = idx.slice(1).map((v, j) => v - idx[j])
    check(`${speed}x: only keyframes (byte-equal), ts increasing, the first is the key before T`, onlyKeys && inc && bins[0].us === kT.us)
    check(`${speed}x: at most 8 keyframes in any second of wall time`, worstWin <= 8, `${worstWin} in the busiest second, ${rate.toFixed(1)}/s over ${span.toFixed(1)} s`)
    if (speed === 32) check('32x: every 2nd key of a 2 s GOP (4 s of footage apart), 6-8 per second', stride.every((s) => s === 2) && rate >= 6, `strides ${[...new Set(stride)].join(',')}, ${rate.toFixed(1)}/s`)
    else check(`${speed}x: every key (none skipped), ${speed / 2} per second`, stride.every((s) => s === 1) && Math.abs(rate - speed / 2) <= speed / 8, `strides ${[...new Set(stride)].join(',')}, ${rate.toFixed(1)}/s, steps ${Math.min(...steps).toFixed(0)}-${Math.max(...steps).toFixed(0)} ms`)
    check(`${speed}x: no stills mode for forward keyframes`, !ws.texts.some((m) => m.type === 'mode' && m.stills))
    ws.close(1000)
  }
}

// ---- reverse --------------------------------------------------------------------------------------------
{
  const Tr = T0 + 12_345
  const { ws } = open(0, Tr)
  ws.command({ speed: -4 })
  await until(() => ws.texts.some((m) => m.type === 'end'), 6000)
  const types = ws.texts.map((m) => m.type)
  const bins = ws.bins
  const keysBefore = exp0.filter((f) => f.isKey && f.ts <= Tr)
  const dec = bins.every((b, j) => j === 0 || b.us < bins[j - 1].us)
  const gaps = bins.slice(1).map((b, j) => b.at - bins[j].at)
  check('-4x: mode stills:true first, then started', types[0] === 'mode' && ws.texts[0].stills === true && types[1] === 'started', types.join(','))
  check('-4x: keyframes only, ts decreasing, every key back to the first', bins.every((b) => b.key) && dec && bins.length === keysBefore.length && bins.at(-1).us === exp0[0].us, `${bins.length}/${keysBefore.length} keys`)
  check('-4x: paced (2 s of footage per key = 500 ms of wall time)', gaps.every((g) => g >= 400 && g <= 700), gaps.map((g) => g.toFixed(0)).join(','))
  const endAt = ws.log.findIndex((e) => e.text?.type === 'end')
  check('-4x: at the first segment: end reverse, after the last key', ws.texts.at(-1)?.type === 'end' && ws.texts.at(-1).reverse === true && endAt > ws.log.findIndex((e) => e.bin?.us === exp0[0].us), J(ws.texts.at(-1)))
  ws.close(1000)
}
{
  const Tr = T0 + 70_000
  const { ws } = open(0, Tr)
  ws.command({ speed: -32 })
  await until(() => ws.texts.some((m) => m.type === 'end'), 6000)
  const bins = ws.bins
  const segOf = new Map(exp0.map((f) => [f.us, f.seg]))
  const segs = new Set(bins.map((b) => segOf.get(b.us)))
  check('-32x: keyframes across a segment boundary, ts decreasing, to the first frame, then end reverse', bins.length >= 14 && segs.size === 2 && bins.every((b, j) => b.key && (j === 0 || b.us < bins[j - 1].us)) && bins.at(-1).us === exp0[0].us && ws.texts.at(-1)?.reverse === true, `${bins.length} keys in ${segs.size} files`)
  ws.close(1000)
}

// ---- long GOPs, keyframes-only footage, holes in keyframe mode ----------------------------------------------
// The spacing between keyframes is footage, not a gap: they go out at their media time. Only a hole
// between two files (over gapMs) is jumped. A clock 10x faster than the wall (now is injectable) keeps
// these short: 4 s of footage at 1x is 400 ms here; intervals are given in that clock.
{
  const K = 10
  const fast = { now: () => performance.now() * K }
  const vms = (bins) => bins.slice(1).map((b, j) => (b.at - bins[j].at) * K)
  const list = (a) => a.map((v) => v.toFixed(0)).join(',')
  const T5 = Date.UTC(2026, 8, 24, 14, 0, 0)
  const T6 = Date.UTC(2026, 8, 24, 15, 0, 0)
  const cam5 = await recordGroups(5, [makeFrames(prng(21), T5, 25 * 120, { gop: 100 })]) // a key every 4 s
  const cam6 = await recordGroups(6, [makeFrames(prng(22), T6, 25 * 150, { gop: 200 })]) // a key every 8 s
  for (const [label, ch, rec, start, speed, gopMs] of [
    ['-1x, 4 s GOP', 5, cam5, T5 + 70_000, -1, 4000],
    ['-2x, 8 s GOP', 6, cam6, T6 + 100_000, -2, 8000]
  ]) {
    const exp = await readBack(rec.segs)
    const keys = exp.filter((f) => f.isKey)
    const byUs = usMap(keys)
    const segOf = new Map(exp.map((f) => [f.us, f.seg]))
    const { ws } = open(ch, start, { opts: fast })
    ws.command({ speed })
    await until(() => ws.bins.length >= 8, 8000)
    const bins = ws.bins.slice(0, 8)
    const idx = bins.map((b) => byUs.get(b.us))
    const iv = vms(bins)
    const each = gopMs / Math.abs(speed) // ms of the clock per key
    const want = (Math.abs(speed) * 1000) / gopMs // keys per second
    const rate = bins.length > 1 ? (bins.length - 1) / (((bins.at(-1).at - bins[0].at) * K) / 1000) : 0
    check(`${label}: every key back from the key before the start (none skipped), across a file boundary`, bins.length === 8 && bins[0].us === keyBefore(exp, start).us && idx.every((v, j) => v !== undefined && (j === 0 || v === idx[j - 1] - 1)) && new Set(bins.map((b) => segOf.get(b.us))).size === 2, `${bins.length} keys, strides ${idx.slice(1).map((v, j) => idx[j] - v).join(',')}`)
    check(`${label}: paced at the media time, one key per ${each} ms (${want} per second), not jumped as gaps`, bins.length === 8 && iv.every((v) => Math.abs(v - each) <= each * 0.25) && Math.abs(rate - want) <= want * 0.15, `intervals ${list(iv)} ms, ${rate.toFixed(2)}/s`)
    ws.close(1000)
  }

  // keyframes-only footage (a time-lapse: a frame every 4 s) at 1x, all frames: paced, not jumped
  const T7 = Date.UTC(2026, 8, 24, 16, 0, 0)
  const rnd7 = prng(23)
  const cam7 = await recordGroups(7, [Array.from({ length: 30 }, (_, i) => ({ buf: h264.key(rnd7, 1500), isKey: true, ts: T7 + i * 4000 + Math.floor(rnd7() * 100) }))])
  const exp7 = await readBack(cam7.segs)
  {
    const { ws } = open(7, T7 + 4100, { opts: fast })
    await until(() => ws.bins.length >= 6, 8000)
    const bins = ws.bins.slice(0, 6)
    const iv = vms(bins)
    const bad = seqCheck(bins, exp7, usMap(exp7))
    check('keyframes-only footage (a frame every 4 s), 1x: every frame in order, from the one before the start', cam7.segs.length === 2 && bins.length === 6 && bins[0].us === exp7[1].us && !bad, bad || `${bins.length} frames`)
    check('keyframes-only footage, 1x: one frame per 4 s of the clock (not jumped as gaps)', bins.length === 6 && iv.every((v) => v >= 3000 && v <= 5000), `intervals ${list(iv)} ms`)
    ws.close(1000)
  }

  // holes between files in keyframe mode (camera 1: 4 s, a 10 s hole, 4 s, a 60 s hole, 4 s)
  const keys1 = exp1.filter((f) => f.isKey)
  const segOf1 = new Map(exp1.map((f) => [f.us, f.seg]))
  const sameFile = (bins) => bins.slice(1).map((b, j) => segOf1.get(b.us) === segOf1.get(bins[j].us))
  {
    const { ws } = open(1, exp1.at(-1).ts, { opts: fast })
    ws.command({ speed: -1 })
    await until(() => ws.texts.some((m) => m.type === 'end'), 8000)
    const bins = ws.bins
    const iv = vms(bins)
    const same = sameFile(bins)
    check('-1x over two holes: every key back to the first, then end reverse', bins.length === keys1.length && bins.every((b, j) => b.us === keys1[keys1.length - 1 - j].us) && ws.texts.at(-1)?.reverse === true, `${bins.length}/${keys1.length} keys`)
    check('-1x over two holes: 2 s of the clock per key inside a file; each hole jumped (under 1 s, not 10 s or 60 s)', same.filter((s) => !s).length === 2 && iv.every((v, j) => (same[j] ? Math.abs(v - 2000) <= 600 : v < 1000)), `intervals ${list(iv)} ms, same file ${same.join(',')}`)
    ws.close(1000)
  }
  {
    const { ws } = open(1, exp1[0].ts, { opts: { endGraceMs: 300 } })
    ws.command({ speed: 8 })
    await until(() => ws.texts.some((m) => m.type === 'end'), 8000)
    // the newest footage reached faster than 1x drops to 1x (speed newest): the keys before that
    const iSp = ws.log.findIndex((e) => e.text?.type === 'speed')
    const bins = ws.log.slice(0, iSp < 0 ? ws.log.length : iSp).filter((e) => e.bin).map((e) => e.bin)
    const iv = bins.slice(1).map((b, j) => b.at - bins[j].at)
    const same = sameFile(bins)
    const notices = ws.log.slice(0, iSp).filter((e) => e.text?.type === 'notice')
    check('8x over two holes: every key, in order, a notice for each hole (10 s and 60 s), then speed 1 newest', iSp > 0 && bins.length === keys1.length && bins.every((b, j) => b.us === keys1[j].us) && notices.length === 2 && ws.texts.at(-1)?.newest === true, `${bins.length}/${keys1.length} keys; ${J(ws.texts.map((m) => m.type))}`)
    check('8x over two holes: 250 ms per key inside a file; each hole jumped (under 400 ms, not 1.5 s)', same.filter((s) => !s).length === 2 && iv.every((v, j) => (same[j] ? v >= 170 && v <= 360 : v < 400)), `intervals ${list(iv)} ms, same file ${same.join(',')}`)
    ws.close(1000)
  }
}

// ---- speed changes keep the position -----------------------------------------------------------------------
{
  const { ws } = open(0, T0 + 100_000)
  await until(() => ws.bins.length > 0, 2000)
  await sleep(700)
  const shown = ws.bins.at(-1)
  ws.command({ speed: -4 })
  await sleep(1300)
  const iRev = ws.log.findIndex((e) => e.text?.type === 'mode' && e.text.stills === true)
  const rev = ws.log.slice(iRev + 1).filter((e) => e.bin).map((e) => e.bin)
  check('1x -> -4x: mode stills:true, then keyframes back from the position (the key at or before it first)', iRev > 0 && rev.length >= 2 && rev.every((b, j) => b.key && (j === 0 || b.us < rev[j - 1].us)) && rev[0].us === keyBefore(exp0, shown.tsMs + 50).us, `${rev.length} keys, first ${rev[0]?.tsMs - shown.tsMs} ms from the frame shown`)
  const lastKey = ws.bins.at(-1)
  ws.command({ speed: 1 })
  await sleep(700)
  const iFwd = ws.log.findIndex((e) => e.text?.type === 'mode' && e.text.stills === false)
  const fwd = ws.log.slice(iFwd + 1).filter((e) => e.bin).map((e) => e.bin)
  check('-4x -> 1x: mode stills:false, then every frame from the keyframe at or after the position', iFwd > iRev && fwd.length > 10 && fwd[0].key && fwd[0].us >= lastKey.us && fwd[0].us - lastKey.us < 2_500_000 && !seqCheck(fwd, exp0, by0), `${fwd.length} frames; ${seqCheck(fwd, exp0, by0)}`)
  check('speed changes: no new generation (one started)', ws.texts.filter((m) => m.type === 'started').length === 1)
  ws.close(1000)
}

// ---- pause ---------------------------------------------------------------------------------------------
{
  const { ws } = open(0, T)
  await until(() => ws.bins.length > 0, 2000)
  await sleep(500)
  ws.command({ pause: true })
  const n = ws.bins.length
  await sleep(300)
  check('pause: no binary for 300 ms', ws.bins.length === n, `${ws.bins.length - n} sent`)
  ws.command({ pause: false })
  await sleep(500)
  const bad = seqCheck(ws.bins, exp0, by0)
  check('resume: continues from the next frame, no gap in the sequence', ws.bins.length > n + 5 && !bad, bad || `${ws.bins.length - n} after resume`)
  ws.close(1000)
}

// ---- seek on the open socket -----------------------------------------------------------------------------
{
  const { ws } = open(0, T)
  await until(() => ws.bins.length > 0, 2000)
  await sleep(400)
  const T2 = T0 + 150_000 + 1234
  const k2 = keyBefore(exp0, T2)
  ws.command({ seek: T2, gen: 1 })
  await sleep(800)
  const at = ws.log.findIndex((e) => e.text?.type === 'started' && e.text.gen === 1)
  const st = ws.log[at]?.text
  const after = ws.log.slice(at + 1).filter((e) => e.bin).map((e) => e.bin)
  check('seek: started gen 1, at T2, from the key before T2', st && st.at === T2 && Math.abs(st.from - k2.ts) < 0.001, J(st))
  check('seek: every frame after it is from the new position (ts >= from), starting with that key', after.length > 10 && after[0].us === k2.us && after[0].key && after.every((b) => b.us >= k2.us), `${after.length} frames, first ${after[0]?.tsMs}`)
  check('seek: the new position\'s frames are consecutive and byte-equal', !seqCheck(after, exp0, by0), seqCheck(after, exp0, by0))
  ws.close(1000)
}

// ---- scrub: the latest wins, one read at a time ---------------------------------------------------------
{
  const stats = {}
  const { ws } = open(0, T, { opts: { fs: countingFs(stats) } })
  await until(() => ws.bins.length > 0, 2000)
  await sleep(300)
  const times = Array.from({ length: 10 }, (_, j) => T0 + 20_000 + j * 21_111)
  for (let j = 0; j < 10; j++) {
    ws.command({ scrub: times[j], gen: 2 + j })
    await sleep(3)
  }
  await sleep(500)
  const k11 = keyBefore(exp0, times[9])
  const iLast = ws.log.findLastIndex((e) => e.text?.type === 'scrub' && e.text.gen === 11)
  const tail = ws.log.slice(iLast + 1)
  const replies = ws.texts.filter((m) => m.type === 'scrub')
  const lastText = ws.texts.at(-1)
  check('scrub: mode stills:true on the first scrub', ws.texts.some((m) => m.type === 'mode' && m.stills === true))
  check('scrub: the last message is scrub gen 11 at the key before T', lastText?.type === 'scrub' && lastText.gen === 11 && Math.abs(lastText.at - k11.ts) < 0.001, J(lastText))
  check('scrub: followed by exactly one frame, that keyframe', tail.length === 1 && tail[0].bin?.key && tail[0].bin.us === k11.us && tail[0].bin.buf.equals(k11.buf), `${tail.length} messages after it`)
  check('scrub: no reply with an older gen after gen 11\'s; gens only increase', replies.at(-1).gen === 11 && replies.every((m, j) => j === 0 || m.gen > replies[j - 1].gen), replies.map((m) => m.gen).join(','))
  check('scrub: never more than one read in flight', stats.maxInFlight === 1, `${stats.maxInFlight}`)
  const n = ws.bins.length
  await sleep(200)
  check('scrub: paused afterwards (nothing more is sent)', ws.bins.length === n)
  ws.command({ scrub: T0 - 60_000, gen: 12 })
  await until(() => ws.texts.some((m) => m.type === 'scrub' && m.gen === 12), 1000)
  await sleep(50)
  check('scrub over a time without server footage: scrub gen 12 none:true, no frame', J(ws.texts.at(-1)) === J({ type: 'scrub', gen: 12, none: true }) && ws.bins.length === n, J(ws.texts.at(-1)))
  // releasing the playhead: a seek plays from there, stills off
  ws.command({ seek: times[3], gen: 13 })
  await sleep(400)
  const k3 = keyBefore(exp0, times[3])
  const iSeek = ws.log.findIndex((e) => e.text?.type === 'started' && e.text.gen === 13)
  const modeOff = ws.log.findIndex((e) => e.text?.type === 'mode' && e.text.stills === false)
  const after = ws.log.slice(iSeek + 1).filter((e) => e.bin).map((e) => e.bin)
  check('seek after a scrub: mode stills:false, started gen 13, plays from the key before T', modeOff >= 0 && modeOff < iSeek && after.length > 5 && after[0].us === k3.us && !seqCheck(after, exp0, by0), `${after.length} frames`)
  ws.close(1000)
}

// ---- crossing segments ----------------------------------------------------------------------------------
{
  const { ws } = open(3, exp3[0].ts)
  ws.command({ speed: 4 })
  await until(() => ws.bins.length >= exp3.length, 8000)
  await sleep(100)
  const bad = seqCheck(ws.bins, exp3, usMap(exp3))
  check('3 contiguous segments at 4x: every original frame once, in order, byte-equal', ws.bins.length === exp3.length && !bad && ws.bins.every((b, j) => b.buf.equals(cam3.accepted[j].buf)), bad || `${ws.bins.length}/${exp3.length}`)
  const lastBin = ws.log.findLastIndex((e) => e.bin)
  const during = ws.log.slice(0, lastBin).filter((e) => e.text).map((e) => e.text.type)
  check('... without a message at the file boundaries', during.join() === 'started', during.join())
  ws.close(1000)
}

// ---- gaps: 10 s jumped by the pacer; 60 s jumped with a notice (no NVR legs); end of footage -----------------
{
  const { ws } = open(1, exp1[0].ts, { legs: null, opts: { endGraceMs: 300 } })
  ws.command({ speed: 4 })
  await until(() => ws.texts.some((m) => m.type === 'end'), 8000)
  const bins = ws.bins
  const segOf = new Map(exp1.map((f) => [f.us, f.seg]))
  const cross = (j) => bins.findIndex((b) => segOf.get(b.us) === cam1.segs[j].path)
  const iB = cross(1)
  const iC = cross(2)
  const wallAB = bins[iB].at - bins[iB - 1].at
  const wallBC = bins[iC].at - bins[iC - 1].at
  const notices = ws.log.map((e, j) => (e.text?.type === 'notice' ? j : -1)).filter((j) => j >= 0)
  const lastB = ws.log.indexOf(ws.log.find((e) => e.bin === bins[iC - 1]))
  const firstC = ws.log.indexOf(ws.log.find((e) => e.bin === bins[iC]))
  check('gaps: every frame of the 3 files, in order', !seqCheck(bins, exp1, usMap(exp1)) && bins.length === exp1.length, seqCheck(bins, exp1, usMap(exp1)) || `${bins.length}/${exp1.length}`)
  const lastA = ws.log.indexOf(ws.log.find((e) => e.bin === bins[iB - 1]))
  const firstB = ws.log.indexOf(ws.log.find((e) => e.bin === bins[iB]))
  // every hole over gapMs gets a notice: silent 3-30 s jumps looked like missing frames
  check('gaps: a 10 s gap is jumped (not 2.5 s of waiting at 4x), with a notice', wallAB < 400 && notices.length === 2 && notices[0] > lastA && notices[0] < firstB, `${wallAB.toFixed(0)} ms, notices at ${notices.join(',')} between ${lastA} and ${firstB}`)
  check('gaps: a 60 s gap is jumped with a notice (legs: null)', wallBC < 400 && notices.length === 2 && notices[1] > lastB && notices[1] < firstC, `${wallBC.toFixed(0)} ms, notices at ${notices.join(',')} between ${lastB} and ${firstC}`)
  const nt = ws.log[notices[1]]?.text
  check('gaps: the notice says what was skipped', /^Skipped \d\d:\d\d:\d\d–\d\d:\d\d:\d\d: not recorded$/.test(nt?.message ?? '') && nt.to > nt.from, J(nt))
  check('end of the footage: end newest', J(ws.texts.at(-1)) === J({ type: 'end', newest: true }), J(ws.texts.at(-1)))
  ws.close(1000)
}
{
  // a start with no footage at T: jumped to the next file with a notice; nothing at all: end
  const { ws } = open(1, exp1[0].ts - 30_000)
  await until(() => ws.bins.length > 0, 2000)
  const st = started(ws)
  check('start before the footage: a notice, then started at the first key, which comes first', ws.texts[0]?.type === 'notice' && st && Math.abs(st.from - exp1[0].ts) < 0.001 && st.at === st.from && ws.bins[0].us === exp1[0].us, J(ws.texts.slice(0, 2)))
  ws.close(1000)
  const none = open(1, exp1.at(-1).ts + 3_600_000)
  await sleep(200)
  check('start after all the footage (none open): end newest, no frames', J(none.ws.texts) === J([{ type: 'end', newest: true }]) && none.ws.bins.length === 0, J(none.ws.texts))
  none.ws.close(1000)
}

// ---- holes inside one file: the NVR stalled and came back within the minute -----------------------------------
// The writer carries on in the same file, so one file holds 10 s, no frames for 30 s, 8 s, no frames for 8 s, 4 s.
// At 1x the frames before each hole keep their 40 ms step (they are not spread over the silence) and each hole is
// jumped as between files: each with a notice. A clock 10x faster than the wall keeps
// it short (intervals are given in that clock).
{
  const K = 10
  const T8 = Date.UTC(2026, 8, 24, 17, 0, 0)
  const rnd8 = prng(24)
  const steady = (at, n) => Array.from({ length: n }, (_, i) => ({ buf: i % 50 ? h264.p(rnd8, 300) : h264.key(rnd8, 1500), isKey: i % 50 === 0, ts: at + i * 40 }))
  const cam8 = await recordGroups(8, [[...steady(T8, 250), ...steady(T8 + 40_000, 200), ...steady(T8 + 56_000, 100)]])
  const w8 = cam8.accepted
  const { ws } = open(8, T8 + 5000, { opts: { now: () => performance.now() * K } })
  await until(() => ws.bins.some((b) => b.tsMs >= T8 + 58_000), 8000)
  const bins = ws.bins
  const i0 = bins.length ? w8.findIndex((f) => f.buf.equals(bins[0].buf)) : -1
  const wrong = bins.findIndex((b, j) => !w8[i0 + j] || !b.buf.equals(w8[i0 + j].buf) || Math.abs(b.tsMs - w8[i0 + j].ts) >= 1)
  check('holes inside a file, 1x: one file; every frame in order from the key before the start, each at its time as written (within 1 ms)', cam8.segs.length === 1 && i0 === 100 && wrong < 0 && bins.length >= 400, wrong >= 0 ? `frame ${wrong}: ${(bins[wrong].tsMs - T8).toFixed(1)} ms, written ${w8[i0 + wrong] ? w8[i0 + wrong].ts - T8 : '-'} ms` : `${cam8.segs.length} files, ${bins.length} frames from #${i0}`)
  const sentAt = (t) => bins.find((b) => Math.abs(b.tsMs - t) < 1)?.at ?? NaN
  const gop = (sentAt(T8 + 9960) - sentAt(T8 + 8000)) * K
  const cross30 = (sentAt(T8 + 40_000) - sentAt(T8 + 9960)) * K
  const cross8 = (sentAt(T8 + 56_000) - sentAt(T8 + 47_960)) * K
  check('holes inside a file, 1x: the GOP before the 30 s hole takes 1.96 s of the clock (not 32 s of slow motion)', Math.abs(gop - 1960) <= 400, `${gop.toFixed(0)} ms`)
  check('holes inside a file, 1x: the 30 s and the 8 s holes are jumped (under 1 s of the clock each)', cross30 < 1000 && cross8 < 1000, `${cross30.toFixed(0)} / ${cross8.toFixed(0)} ms`)
  const iOf = (t) => ws.log.findIndex((e) => e.bin && Math.abs(e.bin.tsMs - t) < 1)
  const notices = ws.log.map((e, j) => (e.text?.type === 'notice' ? j : -1)).filter((j) => j >= 0)
  const nt = ws.log[notices[0]]?.text
  const nt2 = ws.log[notices[1]]?.text
  check('holes inside a file: a notice for the 8 s hole too, between its last frame and the first after it', notices.length === 2 && notices[1] > iOf(T8 + 47_960) && notices[1] < iOf(T8 + 56_000) && Math.abs(nt2.from - (T8 + 47_960)) < 1 && Math.abs(nt2.to - (T8 + 56_000)) < 1, J(ws.texts.filter((m) => m.type === 'notice')))
  check('holes inside a file: a notice between the last frame before the 30 s hole and the first after it, for that hole', notices.length === 2 && notices[0] > iOf(T8 + 9960) && notices[0] < iOf(T8 + 40_000) && Math.abs(nt.from - (T8 + 9960)) < 1 && Math.abs(nt.to - (T8 + 40_000)) < 1 && /^Skipped \d\d:\d\d:\d\d–\d\d:\d\d:\d\d: not recorded$/.test(nt.message), J(ws.texts.filter((m) => m.type === 'notice')))
  ws.close(1000)
}

// ---- the open (growing) file ------------------------------------------------------------------------------
{
  const gw = new SegmentWriter({ root: ROOT, nvrId: NVR_ID, ch: 2, codec: 'h264' })
  gw.on('open', (o) => IDX.noteOpen({ nvr: NVR_ID, ch: 2, ...o, loc: 'L1' }))
  gw.on('segment', (s) => {
    IDX.addSegment({ nvr: NVR_ID, ch: 2, ...s, loc: 'L1' })
    IDX.noteClosed(s.path)
  })
  const rnd = prng(12)
  const written = []
  let n = 0
  const writer = setInterval(() => {
    const isKey = n++ % 25 === 0
    const buf = isKey ? h264.key(rnd, 1500) : h264.p(rnd, 300)
    if (gw.write(buf, { isKey, ts: Date.now() })) written.push({ buf, isKey })
  }, 40)
  const at = (buf) => written.findIndex((f) => f.buf === buf || f.buf.equals(buf))
  const consecutive = (bins) => {
    const i0 = at(bins[0].buf)
    if (i0 < 0) return 'first frame not found'
    for (let j = 0; j < bins.length; j++) if (!written[i0 + j] || !bins[j].buf.equals(written[i0 + j].buf)) return `frame ${j} differs from the one written`
    return ''
  }
  await sleep(3000)
  const openSeg = IDX.openOf(NVR_ID, 2)
  check('growing: the writer\'s open file is announced', Boolean(openSeg?.path) && IDX.first(NVR_ID, 2) !== null)
  // 4x from the start of the open file: reaches the newest frame, drops to 1x and follows
  {
    const { ws } = open(2, openSeg.startMs)
    ws.command({ speed: 4 })
    const got = await until(() => ws.texts.some((m) => m.type === 'speed'), 4000)
    const sp = ws.texts.find((m) => m.type === 'speed')
    const iSp = ws.log.findIndex((e) => e.text?.type === 'speed')
    await sleep(1500)
    const after = ws.log.slice(iSp + 1).filter((e) => e.bin).map((e) => e.bin)
    check('growing, 4x: reaching the newest frame sends {type:"speed", speed:1, reason:"newest"}', got && J(sp) === J({ type: 'speed', speed: 1, reason: 'newest' }), J(sp))
    check('growing, 4x: ... and carries on at 1x with the new frames', after.length >= 20 && !consecutive(ws.bins) && Date.now() - after.at(-1).tsMs < 1500, `${after.length} frames after it; ${consecutive(ws.bins)}; newest ${Date.now() - (after.at(-1)?.tsMs ?? 0)} ms old`)
    ws.close(1000)
  }
  // 16x (keyframes): reaching the newest keyframe drops to 1x and every frame follows again
  {
    const { ws } = open(2, openSeg.startMs)
    ws.command({ speed: 16 })
    const got = await until(() => ws.texts.some((m) => m.type === 'speed'), 4000)
    const iSp = ws.log.findIndex((e) => e.text?.type === 'speed')
    await sleep(1500)
    const before = ws.log.slice(0, iSp).filter((e) => e.bin).map((e) => e.bin)
    const after = ws.log.slice(iSp + 1).filter((e) => e.bin).map((e) => e.bin)
    check('growing, 16x: keyframes, then speed 1 newest at the newest keyframe', got && before.length >= 2 && before.every((b) => b.key) && J(ws.texts.find((m) => m.type === 'speed')) === J({ type: 'speed', speed: 1, reason: 'newest' }))
    check('growing, 16x: ... then every frame again (delta frames too), as written', after.length >= 20 && after.some((b) => !b.key) && !consecutive(after) && after[0].us >= before.at(-1).us, `${after.length} frames after it; ${consecutive(after)}`)
    ws.close(1000)
  }
  // a scrub and a seek into the open file see its newest keyframes (a kept reader is refreshed)
  {
    const { ws } = open(2, openSeg.startMs)
    await until(() => ws.bins.length > 0, 2000)
    ws.command({ scrub: openSeg.startMs + 100, gen: 1 })
    await until(() => ws.texts.some((m) => m.type === 'scrub'), 1000)
    await sleep(2200) // two more keyframes are written
    const t = Date.now() - 100
    ws.command({ scrub: t, gen: 2 })
    await until(() => ws.texts.some((m) => m.type === 'scrub' && m.gen === 2), 1000)
    const r2 = ws.texts.find((m) => m.type === 'scrub' && m.gen === 2)
    check('growing: a scrub near now gets a keyframe from the last 1.5 s (1 s GOP), not the one known before', r2?.at > t - 1500 && r2.at <= t, `${(t - (r2?.at ?? 0)).toFixed(0)} ms before T`)
    ws.close(1000)
  }
  // 1x a little back from now: keeps receiving frames as they are written, also across a new file
  {
    const t = written.length
    // the closed file's row is looked up by its path (the primary key), not by a time range (no scan of the camera's history)
    let rangeCalls = 0
    let pathCalls = 0
    const index = { ...IDX, segments: (...a) => (rangeCalls++, IDX.segments(...a)), byPath: (p) => (pathCalls++, IDX.byPath(p)) }
    const { ws } = open(2, Date.now() - 600, { index })
    await sleep(1200)
    const n1 = ws.bins.length
    await gw.close() // the writer starts a new file at its next keyframe (a restart in the same minute: -2)
    await sleep(2500)
    const newer = IDX.openOf(NVR_ID, 2)
    check('growing: the writer moved on to a new file', newer && newer.path !== openSeg.path, newer?.path)
    check('growing, 1x: keeps receiving new frames as they are written, across the new file', n1 > 10 && ws.bins.length > n1 + 30 && Date.now() - ws.bins.at(-1).tsMs < 1500, `${n1} then ${ws.bins.length}, ${written.length - t} written`)
    check('growing, 1x: never a partial or repeated frame: the frames as written, in order', !consecutive(ws.bins), consecutive(ws.bins))
    check('growing, 1x: the file closed while playing is looked up by its path (byPath), not by a time range', pathCalls >= 1 && rangeCalls === 0, `${pathCalls} byPath, ${rangeCalls} segments()`)
    ws.close(1000)
  }
  clearInterval(writer)
  await gw.close()
}

// ---- a file deleted after it was looked up: skipped ----------------------------------------------------------
{
  const doomed = cam4.segs[1]
  let removed = false
  let seen = 0
  const index = {
    ...IDX,
    next(nvr, ch, t) {
      const r = IDX.next(nvr, ch, t)
      // the 1st lookup is the file before's reader asking for its neighbour (the join); the 2nd is moving on to it
      if (r?.path === doomed.path && !removed && ++seen === 2) {
        removed = true
        unlinkSync(r.path)
        unlinkSync(`${r.path}.idx`)
        IDX.remove(r.path)
      }
      return r
    }
  }
  const before = logs.length
  const { ws } = open(4, exp4[0].ts, { index, opts: { endGraceMs: 300 } })
  ws.command({ speed: 4 })
  await until(() => ws.texts.some((m) => m.type === 'end'), 8000)
  const kept = exp4.filter((f) => f.seg !== doomed.path)
  const bad = seqCheck(ws.bins.slice(0, 100), exp4, usMap(exp4)) || seqCheck(ws.bins.slice(100), exp4, usMap(exp4))
  check('deleted file: skipped, no crash; the files before and after play whole', removed && ws.bins.length === kept.length && !bad && ws.bins.every((b, j) => b.us === kept[j].us), bad || `${ws.bins.length}/${kept.length}`)
  check('deleted file: no error, the socket stays open, end newest at the end', !ws.texts.some((m) => m.type === 'error') && ws.closedWith === 0 && ws.texts.at(-1)?.newest === true, J(ws.texts))
  const skipLogs = logs.slice(before).filter((l) => l.includes('ENOENT'))
  check('deleted file: logged once', skipLogs.length === 1, skipLogs.join(' | '))
  ws.close(1000)
}

// ---- an empty file: played as a hole, not waited out on a black picture --------------------------------------
// 343 zero-byte segments were indexed as recorded. A seek into one, or playback running into one, used to
// wait out its whole span in real time on a black picture (median 27 s, up to 5 min).
{
  const T10 = Date.UTC(2026, 8, 24, 15, 0, 10)
  const all = makeFrames(prng(31), T10, 600) // 3 contiguous files of 8 s
  const cam10 = await recordGroups(10, [all.slice(0, 200), all.slice(200, 400), all.slice(400)])
  const exp10 = await readBack(cam10.segs)
  const empty = cam10.segs[1]
  await fsp.writeFile(empty.path, '') // what the share left behind: the row, and no bytes
  await fsp.writeFile(`${empty.path}.idx`, '')
  const kept = exp10.filter((f) => f.seg !== empty.path)
  const firstOf = (seg) => exp10.find((f) => f.seg === seg.path)
  check('empty file: 3 files of 8 s, the middle one emptied but still indexed', cam10.segs.length === 3 && IDX.byPath(empty.path)?.endMs > IDX.byPath(empty.path)?.startMs && (await fsp.stat(empty.path)).size === 0)

  {
    // playing into it at 4x: 8 s of nothing would be a 2 s wait
    const { ws } = open(10, exp10[0].ts, { opts: { endGraceMs: 300 } })
    ws.command({ speed: 4 })
    await until(() => ws.texts.some((m) => m.type === 'end'), 10_000)
    const bad = seqCheck(ws.bins, kept, usMap(kept))
    check('empty file, played into: the files either side play whole, in order', ws.bins.length === kept.length && !bad, bad || `${ws.bins.length}/${kept.length}`)
    const i3 = ws.bins.findIndex((b) => b.us === firstOf(cam10.segs[2]).us)
    const wall = i3 > 0 ? ws.bins[i3].at - ws.bins[i3 - 1].at : Infinity
    check('  it is jumped at once, not waited out', wall < 400, `${wall.toFixed(0)} ms from the last frame before it to the first after`)
    const nt = ws.texts.find((m) => m.type === 'notice')
    check('  with the usual "not recorded" notice, covering its span', /^Skipped \d\d:\d\d:\d\d–\d\d:\d\d:\d\d: not recorded$/.test(nt?.message ?? '') && nt.from <= empty.startMs + 1000 && nt.to >= empty.endMs - 1000, J(nt))
    check('  no error, and end newest at the end', !ws.texts.some((m) => m.type === 'error') && ws.closedWith === 0 && ws.texts.at(-1)?.newest === true, J(ws.texts))
    ws.close(1000)
  }
  {
    // a seek into it: the next file, with the notice, straight away
    const T = empty.startMs + 3000
    const { ws } = open(10, T)
    await until(() => ws.bins.length > 0, 3000)
    const st = started(ws)
    const first3 = firstOf(cam10.segs[2])
    check('empty file, started in: a notice, then started at the next file\'s first key', ws.texts[0]?.type === 'notice' && Math.abs(ws.texts[0].from - T) < 1 && st && Math.abs(st.from - first3.ts) < 0.001 && st.at === st.from, J(ws.texts.slice(0, 2)))
    check('  and its first frame comes at once, not after the rest of the empty span', ws.bins[0]?.us === first3.us && ws.bins[0].at - ws.t0 < 1000, `${(ws.bins[0]?.at - ws.t0).toFixed(0)} ms`)
    ws.close(1000)
  }
  {
    // reverse, across it: from the last file's keyframes to the first file's without a wait for the empty one
    const { ws } = open(10, firstOf(cam10.segs[2]).ts + 4000)
    ws.command({ speed: -4 })
    await until(() => ws.texts.some((m) => m.type === 'end' && m.reverse), 10_000)
    const seg1 = new Set(exp10.filter((f) => f.seg === cam10.segs[0].path).map((f) => f.us))
    const i1 = ws.bins.findIndex((b) => seg1.has(b.us))
    const wall = i1 > 0 ? ws.bins[i1].at - ws.bins[i1 - 1].at : Infinity
    check('empty file, in reverse: jumped too', i1 > 0 && wall < 1000, `${wall.toFixed(0)} ms`)
    ws.close(1000)
  }
}

// ---- the store failing (the NAS share down): a plain-English error, never "EIO: i/o error, read" --------------
{
  const failing = (code, where) => ({
    async open(p, flags) {
      if (where === 'open') throw Object.assign(new Error(`${code}: i/o error, open '${p}'`), { code })
      const fh = await fsp.open(p, flags)
      return {
        read: async () => {
          throw Object.assign(new Error(`${code}: i/o error, read`), { code })
        },
        stat: () => fh.stat(),
        close: () => fh.close()
      }
    }
  })
  for (const [code, where] of [['EIO', 'read'], ['EIO', 'open'], ['ETIMEDOUT', 'read'], ['EHOSTDOWN', 'open']]) {
    const lines = []
    const { ws } = open(3, exp3[0].ts, { opts: { fs: failing(code, where), log: (l) => lines.push(l) } })
    await until(() => ws.closedWith !== 0, 3000)
    const err = ws.texts.find((m) => m.type === 'error')
    check(`${code} on ${where}: "the recording store could not be read", in words`, err?.message === 'Playback failed: The recording store could not be read (network storage problem)', err?.message)
    check('  the socket closes as a failed playback (the page then plays the NVR\'s copy)', ws.closedWith === 1011 && ws.closeReason === 'playback failed', `${ws.closedWith} ${ws.closeReason}`)
    // EIO is not a file that went away: skipping it would say "not recorded" and try the next file, and the next
    check('  it is not skipped as a missing file: no "not recorded" notice, nothing started', !ws.texts.some((m) => m.type === 'notice' || m.type === 'started'), J(ws.texts))
    check('  the log keeps what the system said', lines.some((l) => l.includes('failed') && l.includes(code)), lines.join(' | '))
  }
  {
    // anything else is reported as it was
    const odd = { open: async () => { throw new Error('something else went wrong') } }
    const { ws } = open(3, exp3[0].ts, { opts: { fs: odd } })
    await until(() => ws.closedWith !== 0, 3000)
    check('another failure keeps its own message', ws.texts.find((m) => m.type === 'error')?.message === 'Playback failed: something else went wrong', J(ws.texts))
  }
}

// ---- flow control: a backed-up socket stops the reader ------------------------------------------------------
{
  const stats = {}
  const { ws } = open(0, T0 + 30_000, { opts: { fs: countingFs(stats), readAheadMs: 600_000 } })
  // the socket backs up as soon as the first frame has gone out (the reader would read ahead for minutes)
  let backedUp = true
  const send = ws.send
  ws.send = (m) => {
    send(m)
    if (backedUp && typeof m !== 'string') ws.bufferedAmount = 9 * 1024 * 1024
  }
  await until(() => ws.bins.length > 0, 2000)
  await sleep(150)
  const r1 = stats.reads
  await sleep(400)
  check('flow control: bufferedAmount 9 MB: the reader stops (reads stay flat)', stats.reads === r1, `${r1} -> ${stats.reads}`)
  backedUp = false
  ws.bufferedAmount = 4 * 1024 * 1024
  await sleep(300)
  check('flow control: 4 MB (between the limits): still stopped', stats.reads === r1, `${r1} -> ${stats.reads}`)
  ws.bufferedAmount = 512 * 1024
  await sleep(300)
  check('flow control: 0.5 MB: the reader resumes', stats.reads > r1 + 3, `${r1} -> ${stats.reads}`)
  ws.close(1000)
}

// ---- close: timers cleared, handles closed, one log line -----------------------------------------------------
{
  await sleep(200) // the sessions above are gone
  const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length
  const before = timers()
  const stats = {}
  const lines = []
  const { ws } = open(0, T, { opts: { fs: countingFs(stats), log: (l) => lines.push(l) } })
  await until(() => ws.bins.length > 20, 2000)
  const during = timers()
  const openDuring = stats.open
  ws.close(1000)
  await sleep(150)
  const n = ws.bins.length
  await sleep(100)
  check('close: the timers are cleared', during > before && timers() === before, `${before} before, ${during} while playing, ${timers()} after`)
  check('close: every file handle is closed', openDuring > 0 && stats.open === 0, `${openDuring} while playing, ${stats.open} after`)
  check('close: nothing is sent afterwards', ws.bins.length === n)
  check('close: one log line with the start timings', lines.length === 1 && /^\[n1\] server playback ch1 from 2026-09-24T10:01:15\.900Z: index \d+ ms, idx \d+ ms, first frame \d+ ms$/.test(lines[0]), lines.join(' | '))
}

// ---- H.265 -> H.264 for a browser that cannot decode H.265 (transcode.mjs) ----------------------
// The conversion's own logic is tested offline in transcode.test.mjs; what is checked here is the
// wiring: which clients get converted frames, that nobody else can, and that the conversion is
// stopped at a seek and at close. A stand-in for the Transcoder is injected, so no ffmpeg runs.
{
  // camera 9: 4 s recorded as .h265 (the codec is the file's extension; the bytes do not matter,
  // because the stand-in never decodes anything). They are the same synthetic H.264 NALs the rest
  // of this file uses, so the reader's H.265 parsing finds fewer frames in them than a real
  // recording would: how many frames come out is not what is being checked here, which codec they
  // carry is.
  const T9 = Date.UTC(2026, 8, 24, 14, 0, 10)
  const cam9 = await recordGroups(9, [makeFrames(prng(11), T9, 100)], 'h265')
  check('h265 footage: recorded as .h265', cam9.segs.length > 0 && /\.h265$/.test(cam9.segs[0].path), cam9.segs[0]?.path)

  /** A Transcoder stand-in: records what it was given and hands each frame straight back as H.264. */
  const fakeXcode = (rec) => (o) => {
    const x = {
      opts: o, // what the session asked of the conversion
      pushed: [],
      calls: [], // 'push' and 'end' in the order they came
      resets: 0,
      closes: 0,
      low: [], // lowDelay as the session answers it at each push (the real one asks when ffmpeg starts)
      perS: [], // picturesPerS likewise
      inCodec: o.inCodec, // what the real one reads when its ffmpeg starts (the session may change it)
      codecs: [], // inCodec at each push
      push: (ts, isKey, buf) => {
        x.pushed.push(ts)
        x.calls.push('push')
        x.codecs.push(x.inCodec)
        x.low.push(typeof o.lowDelay === 'function' ? o.lowDelay() : o.lowDelay)
        x.perS.push(typeof o.picturesPerS === 'function' ? o.picturesPerS() : o.picturesPerS)
        o.onFrame(ts, isKey, Buffer.concat([Buffer.from([0xaa]), buf.subarray(0, 4)]))
      },
      endPicture: () => x.calls.push('end'),
      reset: () => x.resets++,
      close: () => x.closes++
    }
    rec.push(x)
    return x
  }

  {
    const xs = []
    const released = []
    const pool = { active: 0, acquire: () => ({ release: () => released.push(1) }) }
    const { ws, session } = open(9, T9 + 500, { extra: '&h265=0', opts: { pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => ws.bins.length >= 2, 2000)
    check('a browser that cannot decode H.265 is sent H.264', ws.bins.length >= 2 && ws.bins.every((b) => b.codec === 0), `${ws.bins.length} frames, codecs ${[...new Set(ws.bins.map((b) => b.codec))].join()}`)
    check('  every frame keeps the time it was recorded at', ws.bins.every((b, i) => Math.abs(b.tsMs - xs[0].pushed[i]) < 0.001), )
    check('  exactly one conversion was started, holding one slot under the cap', xs.length === 1 && released.length === 0)
    // smoothness report, cause 2b: at full size a 4K conversion ran slower than real time and made
    // ~9 Mbit/s; capped, it keeps ahead and fits a tunnel
    const o = xs[0].opts
    check('  it converts at most 1920 wide and 2.5 Mbit/s, with a 1 s buffer (transcode.mjs PLAYBACK_LIMITS)', o.maxWidth === 1920 && o.maxKbps === 2500 && o.bufSeconds === 1, J({ maxWidth: o.maxWidth, maxKbps: o.maxKbps, bufSeconds: o.bufSeconds }))
    const n = xs[0].resets
    session.close()
    await sleep(20)
    check('kill on close: the conversion is closed and its slot given back', xs[0].closes === 1 && released.length === 1)
    check('  (close is not a seek)', xs[0].resets === n)
  }
  {
    const xs = []
    const pool = { active: 0, acquire: () => ({ release: () => {} }) }
    const { ws, session } = open(9, T9 + 500, { extra: '&h265=0', opts: { pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => ws.bins.length >= 2, 2000)
    ws.handlers.message(JSON.stringify({ seek: T9 + 2500, gen: 1 }), false)
    check('kill on seek: the conversion is reset, so no ffmpeg keeps chewing on the old position', xs[0].resets === 1)
    await until(() => ws.texts.some((t) => t.type === 'started' && t.gen === 1), 2000)
    check('  and playback carries on converted after the seek', ws.bins.every((b) => b.codec === 0))
    session.close()
  }
  {
    // A scrub sends one keyframe and then nothing: ffmpeg's parser would hold that picture until the
    // next one starts, so the picture is ended at once (Transcoder.endPicture). Playing frames are
    // never ended one by one: the next frame ends each of them anyway.
    const xs = []
    const pool = { active: 0, acquire: () => ({ release: () => {} }) }
    const { ws, session } = open(9, T9 + 500, { extra: '&h265=0', opts: { pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => ws.bins.length >= 2, 2000)
    check('playing converted: no picture is ended by hand', xs[0].calls.length >= 2 && !xs[0].calls.includes('end'), xs[0].calls.join())
    const before = xs[0].calls.length
    ws.handlers.message(JSON.stringify({ scrub: T9 + 2500, gen: 1 }), false)
    await until(() => ws.texts.some((t) => t.type === 'scrub' && t.gen === 1) && xs[0].calls.length > before, 2000)
    await sleep(50)
    const sc = ws.texts.find((t) => t.type === 'scrub' && t.gen === 1)
    check('a converted scrub: its keyframe is pushed, then the picture is ended, once', J(xs[0].calls.slice(before)) === J(['push', 'end']) && xs[0].pushed.at(-1) === sc?.at, `${xs[0].calls.slice(before).join()} at ${sc?.at}`)
    // smoothness report, cause 2a: low_delay turns the decoder's frame threads off (one thread,
    // slower than real time at 4K); frame threads hold pictures back until more arrive, which a scrub never sends
    check('  low_delay: not while playing forward at 1x, but for the scrub', xs[0].low.length >= 3 && xs[0].low.slice(0, -1).every((v) => v === false) && xs[0].low.at(-1) === true, J(xs[0].low))
    // x264 spends its rate cap per picture by the input's timestamps: playing forward those are the
    // camera's own; one picture at a time they say maxKeysPerS a second (below, at 2x)
    check('  picturesPerS: 0 (the stream\'s own rate) at 1x, maxKeysPerS for the scrub', xs[0].perS.length >= 3 && xs[0].perS.slice(0, -1).every((v) => v === 0) && xs[0].perS.at(-1) === session.maxKeysPerS && session.maxKeysPerS === 8, J(xs[0].perS))
    session.close()
  }
  {
    // a browser that never said it cannot decode H.265 must never be sent anything but the recording
    const xs = []
    const pool = { active: 0, acquire: () => ({ release: () => {} }) }
    const { ws, session } = open(9, T9 + 500, { opts: { pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => ws.bins.length >= 2, 2000)
    check('a browser that did not ask is sent the H.265 recording, untouched', ws.bins.length >= 2 && ws.bins.every((b) => b.codec === 1) && xs.length === 0)
    session.close()
    const h1 = open(9, T9 + 500, { extra: '&h265=1', opts: { pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => h1.ws.bins.length >= 2, 2000)
    check('  and so is one that says it can decode it', h1.ws.bins.every((b) => b.codec === 1) && xs.length === 0)
    h1.session.close()
  }
  {
    // over the cap: the honest message and the end of the session, never a queue nobody gets out of
    const xs = []
    const pool = { active: 2, acquire: () => null }
    const { ws } = open(9, T9 + 500, { extra: '&h265=0', opts: { pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => ws.texts.some((t) => t.type === 'error'), 2000)
    const err = ws.texts.find((t) => t.type === 'error')
    check('over the cap: an honest message, no frames and no ffmpeg', Boolean(err) && /already converting/.test(err.message) && ws.bins.length === 0 && xs.length === 0, err?.message)
    check('  the socket is closed, and not with the code that means "the NVR is busy"', ws.closedWith === 1011, String(ws.closedWith))
  }

  // ---- 2x and 4x while converting: keyframes only (smoothness report, cause 2c) ----
  // The conversion keeps up with 1x and not much more, so at 2x and 4x every frame meant half of
  // them or fewer arriving, in stutters. Keyframes only is a steady slideshow instead, and each one
  // is ended at once: nothing follows it for up to a second, and ffmpeg would hold it until then.
  // camera 10: 8 s of H.265 at 25 fps, a keyframe every second; camera 11: 4 s of H.264, then 4 s of H.265
  const T10 = Date.UTC(2026, 8, 24, 15, 0, 10)
  const cam10 = await recordGroups(10, [makeFrames(prng(12), T10, 200, { gop: 25, codec: h265 })], 'h265')
  const exp10 = await readBack(cam10.segs)
  const keys10 = exp10.filter((f) => f.isKey)
  check('h265 footage (camera 10): 200 H.265 pictures read back, a keyframe every 25', exp10.length === 200 && keys10.length === 8, `${exp10.length} frames, ${keys10.length} keys`)
  const T11 = Date.UTC(2026, 8, 24, 16, 0, 10)
  const all11 = makeFrames(prng(13), T11, 200, { gop: 25 })
  const cam11a = await recordGroups(11, [all11.slice(0, 100)], 'h264')
  const cam11b = await recordGroups(11, [all11.slice(100).map((f) => ({ ...f, buf: f.isKey ? h265.key(prng(f.ts)) : h265.p(prng(f.ts)) }))], 'h265')
  const exp11a = await readBack(cam11a.segs)
  const exp11b = await readBack(cam11b.segs)
  check('mixed footage (camera 11): an H.264 file, then an H.265 one straight after it', exp11a.length === 100 && exp11b.length === 100 && /\.h264$/.test(cam11a.segs[0].path) && /\.h265$/.test(cam11b.segs[0].path), `${exp11a.length} ${exp11b.length}`)

  const converted = (b) => b.codec === 0 && b.buf[0] === 0xaa // (the stand-in marks what it converted)
  const freePool = () => ({ active: 0, acquire: () => ({ release: () => {} }) })
  /** '' when bins are consecutive keyframes of keys (the list the footage has), else what is wrong. */
  const keySeq = (bins, keys) => {
    const at = keys.findIndex((k) => Math.abs(k.ts - bins[0]?.tsMs) < 0.001)
    if (at < 0) return `the first frame (${bins[0]?.tsMs}) is not a keyframe of the footage`
    for (let j = 0; j < bins.length; j++) if (Math.abs(bins[j].tsMs - keys[at + j]?.ts) >= 0.001) return `frame ${j} is not keyframe ${at + j}`
    return ''
  }
  const medianGap = (bins) => {
    const g = bins.slice(1).map((b, i) => b.at - bins[i].at).sort((a, b) => a - b)
    return g[g.length >> 1] ?? 0
  }
  {
    // the page sends its speed as soon as the socket opens: at 2x from the first frame on
    const xs = []
    const { ws, session } = open(10, T10 + 100, { extra: '&h265=0', opts: { pool: freePool(), makeTranscoder: fakeXcode(xs) } })
    ws.command({ speed: 2 })
    await until(() => ws.bins.length >= 4, 4000)
    const bins = ws.bins.slice()
    check('converting at 2x from the start: keyframes only, every one converted', bins.length >= 4 && bins.every((b) => b.key && converted(b)), `${bins.length} frames, ${bins.filter((b) => !b.key).length} not keys`)
    check('  consecutive keyframes of the footage, none skipped', keySeq(bins, keys10) === '', keySeq(bins, keys10))
    const gap = medianGap(bins)
    check('  at their media time (a keyframe a second at 2x: one every ~500 ms), not in a burst', gap > 350 && gap < 700, `${Math.round(gap)} ms`)
    check('  each keyframe is pushed and then ended at once', xs.length === 1 && J(xs[0].calls.slice(0, 6)) === J(['push', 'end', 'push', 'end', 'push', 'end']), xs[0]?.calls.join())
    check('  with low_delay (frame threads would hold keyframes back until more arrive)', xs[0].low.length >= 4 && xs[0].low.every((v) => v === true), J(xs[0].low))
    // The rate cap is spent per picture by the input's timestamps, one camera frame apart: a keyframe
    // got a 1x picture's share (15.6 KB at 20 fps and 2.5 Mbit/s) while 2-8 went out a second, and
    // came out blocky. Stamped maxKeysPerS a second, the most the pacer sends, each gets that many's
    // share and the cap still holds per second of wall clock.
    check('  stamped maxKeysPerS (8) a second for the encoder, so the rate cap is shared by the pictures that really go', xs[0].perS.length >= 4 && xs[0].perS.every((v) => v === 8), J(xs[0].perS))
    check('  (the cap itself is unchanged: PLAYBACK_LIMITS)', xs[0].opts.maxKbps === 2500 && xs[0].opts.bufSeconds === 1)
    session.close()
  }
  {
    // 1x plays every frame; 2x switches to keyframes (the conversion reset); 4x too; back at 1x, every frame again
    const xs = []
    const { ws, session } = open(10, T10 + 100, { extra: '&h265=0', opts: { pool: freePool(), makeTranscoder: fakeXcode(xs) } })
    await until(() => ws.bins.filter((b) => !b.key).length >= 3, 3000)
    check('converting at 1x: every frame (no change there)', ws.bins.some((b) => !b.key) && ws.bins.every(converted) && !xs[0].calls.includes('end'), `${ws.bins.length} frames`)
    const r0 = xs[0].resets
    ws.command({ speed: 2 })
    const n2 = ws.bins.length
    await until(() => ws.bins.length >= n2 + 3, 3000)
    const at2 = ws.bins.slice(n2)
    check('  1x to 2x: the conversion is reset once, then keyframes only', xs[0].resets === r0 + 1 && at2.length >= 3 && at2.every((b) => b.key && converted(b)) && keySeq(at2, keys10) === '', `${xs[0].resets - r0} resets, ${at2.length} frames: ${keySeq(at2, keys10)}`)
    ws.command({ speed: 4 })
    const n4 = ws.bins.length
    await until(() => ws.bins.length >= n4 + 2, 3000)
    const at4 = ws.bins.slice(n4)
    check('  4x: keyframes only', at4.length >= 2 && at4.every((b) => b.key && converted(b)), `${at4.length} frames`)
    ws.command({ speed: 1 })
    const n1 = ws.bins.length
    await until(() => ws.bins.slice(n1).filter((b) => !b.key).length >= 3, 3000)
    check('  back at 1x: every frame again', ws.bins.slice(n1).filter((b) => !b.key).length >= 3)
    const modes = xs[0].perS.filter((v, i, a) => i === 0 || v !== a[i - 1]) // each run of one value, once
    check('  picturesPerS by mode: 0 at 1x, 8 at 2x and 4x, 0 again back at 1x', J(modes) === J([0, 8, 0]), J(modes))
    session.close()
  }
  {
    // nobody converting: 2x is every frame, as before
    const xs = []
    const h = open(10, T10 + 100, { extra: '&h265=1', opts: { pool: freePool(), makeTranscoder: fakeXcode(xs) } })
    h.ws.command({ speed: 2 })
    await until(() => h.ws.bins.filter((b) => !b.key).length >= 5, 3000)
    check('2x on H.265 for a browser that decodes it: every frame, untouched (unchanged)', h.ws.bins.filter((b) => !b.key).length >= 5 && h.ws.bins.every((b) => b.codec === 1) && xs.length === 0)
    h.session.close()
    const c = open(0, T0 + 1000, { extra: '&h265=0', opts: { pool: freePool(), makeTranscoder: fakeXcode(xs) } })
    c.ws.command({ speed: 2 })
    await until(() => c.ws.bins.filter((b) => !b.key).length >= 5, 3000)
    check('  and 2x on an H.264 recording for a browser that cannot decode H.265: every frame (nothing to convert)', c.ws.bins.filter((b) => !b.key).length >= 5 && c.ws.bins.every((b) => b.codec === 0 && !converted(b)) && xs.length === 0)
    c.session.close()
  }
  {
    // an H.265 file after H.264 ones, at 2x: the H.264 frames already read play out at their time,
    // every one of them; from the H.265 file on, keyframes only
    const xs = []
    const { ws, session } = open(11, T11 + 100, { extra: '&h265=0', opts: { pool: freePool(), makeTranscoder: fakeXcode(xs) } })
    ws.command({ speed: 2 })
    const bStart = exp11b[0].ts
    await until(() => ws.bins.filter((b) => b.tsMs >= bStart).length >= 3, 6000)
    const a = ws.bins.filter((b) => b.tsMs < bStart)
    const b = ws.bins.filter((b) => b.tsMs >= bStart)
    const aExp = exp11a.filter((f) => f.ts >= a[0]?.tsMs)
    check('H.264 then H.265 at 2x: the H.264 frames go out untouched, every one', a.length > 0 && a.every((f) => !converted(f)) && a.length === aExp.length && seqCheck(a, aExp, usMap(aExp)) === '', `${a.length}/${aExp.length} ${seqCheck(a, aExp, usMap(aExp))}`)
    check('  at their media time, not held to the keyframe rate', a.length < 2 || a.at(-1).at - a[0].at < (a.at(-1).tsMs - a[0].tsMs) / 2 + 500, `${Math.round(a.at(-1)?.at - a[0]?.at)} ms for ${Math.round(a.at(-1)?.tsMs - a[0]?.tsMs)} ms of footage`)
    check('  then the H.265 file: keyframes only, converted, from its first one', b.length >= 3 && b.every((f) => f.key && converted(f)) && keySeq(b, exp11b.filter((f) => f.isKey)) === '' && Math.abs(b[0].tsMs - bStart) < 0.001, keySeq(b, exp11b.filter((f) => f.isKey)))
    check('  time never goes back', ws.bins.every((f, i) => i === 0 || f.tsMs > ws.bins[i - 1].tsMs))
    session.close()
  }

  // ---- a remote viewer: the capped conversion, whatever the codec (smoothness report, cause 3) ----
  // One tunnel connection carried 3.5-6.5 Mbit/s, and a 4.2 Mbit/s main stream through it froze 22
  // times a minute. A viewer who is remote by live view's own rule (adaptive-live.mjs
  // isRemoteAddress: the Cloudflare tunnel arrives from 127.0.0.1, the tailnet from 100.64.0.0/10;
  // server.mjs passes it as `remote`) plays through the conversion within PLAYBACK_LIMITS (1920 wide,
  // 2.5 Mbit/s) while one of its slots is free, and gets the recording itself when both are taken.
  // The viewer can ask for the recording itself (&original=1). The local network is unchanged.
  // Only a recording over the cap is converted (fitAboveKbps, PLAYBACK_LIMITS.maxKbps by default):
  // the synthetic footage here records at about 0.1 Mbit/s, so the tests of the conversion itself
  // set fitAboveKbps: 0 (every recording over it).
  const { TranscodePool } = await import('../transcode.mjs')
  const fitMsgs = (ws) => ws.texts.filter((t) => t.type === 'fit')
  /** The binary frames sent after {type:'started', gen}. */
  const binsAfterStart = (ws, gen) => {
    const i = ws.log.findIndex((e) => e.text?.type === 'started' && e.text.gen === gen)
    return i < 0 ? [] : ws.log.slice(i + 1).filter((e) => e.bin).map((e) => e.bin)
  }
  {
    const xs = []
    const pool = new TranscodePool(2)
    const { ws, session } = open(0, T0 + 1000, { remote: true, opts: { fitAboveKbps: 0, pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => ws.bins.filter((b) => !b.key).length >= 5, 3000)
    check('remote: an H.264 recording goes through the conversion, every frame of it', ws.bins.filter((b) => !b.key).length >= 5 && ws.bins.every(converted), `${ws.bins.length} frames, ${ws.bins.filter((b) => !converted(b)).length} not converted`)
    const o = xs[0]?.opts ?? {}
    check('  one conversion, within PLAYBACK_LIMITS (1920 wide, 2.5 Mbit/s, a 1 s buffer)', xs.length === 1 && o.maxWidth === 1920 && o.maxKbps === 2500 && o.bufSeconds === 1, J({ n: xs.length, maxWidth: o.maxWidth, maxKbps: o.maxKbps, bufSeconds: o.bufSeconds }))
    check('  the converter is told the recording is H.264', o.inCodec === 0 && xs[0].codecs.length > 0 && xs[0].codecs.every((c) => c === 0), `${o.inCodec} ${J([...new Set(xs[0]?.codecs)])}`)
    check('  every frame keeps the time it was recorded at', xs.length === 1 && ws.bins.every((b, i) => Math.abs(b.tsMs - xs[0].pushed[i]) < 0.001))
    check('  it holds one slot of the pool', pool.active === 1, String(pool.active))
    check('  the page is told, before the first frame: {type:"fit", on:true}', J(fitMsgs(ws)) === J([{ type: 'fit', on: true }]) && ws.log.findIndex((e) => e.text?.type === 'fit') < ws.log.findIndex((e) => e.bin), J(fitMsgs(ws)))
    session.close()
    check('  close gives the slot back', pool.active === 0 && xs[0]?.closes === 1, `${pool.active} ${xs[0]?.closes}`)
  }
  {
    // A recording already within the cap is sent as it is: converted, a 2.2 Mbit/s camera came out at
    // 2.15 Mbit/s with a busier second than before (3.74 against 3.35 Mbit), for a slot and 0.74 of a
    // core; half the H.264 cameras record under 0.75 Mbit/s. The rate is the index's: the file's bytes
    // over its span, in kbit/s.
    const seg = IDX.at(NVR_ID, 0, T0 + 1000)
    const kbps = (seg.bytes * 8) / (seg.endMs - seg.startMs)
    const xs = []
    const pool = new TranscodePool(2)
    const a = open(0, T0 + 1000, { remote: true, opts: { pool, makeTranscoder: fakeXcode(xs) } })
    const b = open(0, T0 + 1000, { remote: true, opts: { fitAboveKbps: Math.ceil(kbps), pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => [a, b].every((l) => l.ws.bins.filter((f) => !f.key).length >= 5), 3000)
    check(`remote, a recording within the cap (camera 0 records ${Math.round(kbps)} kbit/s): sent as it is, no slot taken`, kbps > 50 && kbps < 2500 && [a, b].every((l) => l.ws.bins.filter((f) => !f.key).length >= 5 && !l.ws.bins.some(converted)) && xs.length === 0 && pool.active === 0, `${xs.length} conversions, pool ${pool.active}`)
    check('  the page is told: {type:"fit", on:false, fits:true}', [a, b].every((l) => J(fitMsgs(l.ws)) === J([{ type: 'fit', on: false, fits: true }])), J(fitMsgs(a.ws)))
    a.session.close()
    b.session.close()
    const c = open(0, T0 + 1000, { remote: true, opts: { fitAboveKbps: Math.floor(kbps) - 1, pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => c.ws.bins.filter((f) => !f.key).length >= 5, 3000)
    check('  just over the threshold: converted', c.ws.bins.filter((f) => !f.key).length >= 5 && c.ws.bins.every(converted) && xs.length === 1, `${c.ws.bins.filter(converted).length}/${c.ws.bins.length}`)
    c.session.close()

    // The speed counts: at 2x-4x every frame goes at 2-4 times the rate, and reverse and 8x-32x send
    // up to maxKeysPerS keyframes a second, which a 1x rate says nothing about.
    const xs2 = []
    const d = open(0, T0 + 1000, { remote: true, opts: { fitAboveKbps: Math.ceil(kbps * 1.5), pool, makeTranscoder: fakeXcode(xs2) } })
    await until(() => d.ws.bins.filter((f) => !f.key).length >= 5, 3000)
    check('  within the cap at 1x: sent as it is', fitMsgs(d.ws).length === 1 && fitMsgs(d.ws)[0].fits === true && !d.ws.bins.some(converted), J(fitMsgs(d.ws)))
    d.ws.command({ speed: 2 })
    const n = d.ws.bins.length
    await until(() => d.ws.bins.length >= n + 2 && d.ws.bins.slice(n).some(converted), 4000)
    await sleep(100)
    const later = d.ws.bins.slice(n).filter((f) => f.tsMs > (d.ws.bins[n - 1]?.tsMs ?? 0))
    const firstConv = later.findIndex(converted)
    check('  2x takes it over the cap: it restarts at the position, converted (keyframes only, 2x while converting)', J(fitMsgs(d.ws).at(-1)) === J({ type: 'fit', on: true }) && firstConv >= 0 && later.slice(firstConv).every((f) => f.key && converted(f)) && xs2.length === 1, `${J(fitMsgs(d.ws))} ${later.map((f) => (converted(f) ? 'C' : 'r') + (f.key ? 'K' : '')).join(' ')}`)
    check('  time never goes back', d.ws.bins.every((f, i) => i === 0 || f.tsMs > d.ws.bins[i - 1].tsMs))
    d.session.close()
    const e = open(0, T0 + 1000, { remote: true, opts: { fitAboveKbps: Math.ceil(kbps * 5), pool, makeTranscoder: fakeXcode(xs2) } })
    await until(() => e.ws.bins.filter((f) => !f.key).length >= 3, 3000)
    e.ws.command({ speed: 4 })
    const m = e.ws.bins.length
    await until(() => e.ws.bins.slice(m).filter((f) => !f.key).length >= 5, 3000)
    check('  4x still within it: every frame, as it is, no restart', e.ws.bins.slice(m).filter((f) => !f.key).length >= 5 && !e.ws.bins.some(converted) && fitMsgs(e.ws).length === 1 && xs2.length === 1)
    e.session.close()
    const f = open(0, T0 + 60_000, { remote: true, opts: { pool, makeTranscoder: fakeXcode(xs2) } })
    f.ws.command({ speed: -1 })
    await until(() => f.ws.bins.length >= 2, 6000)
    check('  reverse (keyframes, up to 8 a second): converted, whatever the 1x rate', f.ws.bins.length >= 2 && f.ws.bins.every((b) => b.key && converted(b)) && J(fitMsgs(f.ws).at(-1)) === J({ type: 'fit', on: true }), `${J(fitMsgs(f.ws))} ${f.ws.bins.length}`)
    f.session.close()
  }
  {
    // The slot is taken at the first file, before any frame reaches a converter: a session closed in
    // between (the viewer moved on at once) must still give it back, or the pool shrinks for good.
    const xs = []
    const pool = new TranscodePool(2)
    const { ws, session } = open(0, T0 + 1000, { remote: true, opts: { fitAboveKbps: 0, pool, makeTranscoder: fakeXcode(xs) } })
    const send = ws.send
    ws.send = (m) => {
      send(m)
      if (typeof m === 'string' && JSON.parse(m).type === 'fit') session.close()
    }
    await until(() => session.closed, 2000)
    await sleep(50)
    check('remote, closed after taking its slot and before any frame was converted: the slot is given back', session.closed && fitMsgs(ws).length === 1 && xs.length === 0 && pool.active === 0, `closed ${session.closed}, ${xs.length} conversions, pool ${pool.active}`)
  }
  {
    // Closed while its first file is still being opened (a camera, a day or a quality switched at
    // once, the tab closed; the .idx takes longer while the NAS is slow): close() has run with no
    // slot to give back and never runs again, so the file that finishes opening after it must not
    // take one. Two such leaks emptied the process-wide pool until a restart: every H.265
    // conversion refused from then on, here and in NVR playback.
    const xs = []
    const pool = new TranscodePool(2)
    const opts = { fitAboveKbps: 0, pool, makeTranscoder: fakeXcode(xs) }
    const gone = []
    for (let i = 0; i < 3; i++) {
      const l = open(0, T0 + 1000, { remote: true, opts })
      l.session.close() // at once: the first file is still opening
      gone.push(l)
    }
    const s = open(0, T0 + 1000, { remote: true, opts })
    s.ws.close(1001) // the socket's own close event, as the tab going away
    gone.push(s)
    await sleep(200)
    check('remote, closed while its first file was still opening: no slot taken after the close', pool.active === 0 && xs.length === 0, `pool ${pool.active}, ${xs.length} conversions`)
    check('  and nothing decided for a closed session (no {type:"fit"})', gone.every((l) => fitMsgs(l.ws).length === 0), J(gone.map((l) => fitMsgs(l.ws))))
    // the pool still has both slots: two viewers after it convert
    const live = [open(0, T0 + 1000, { remote: true, opts }), open(10, T10 + 100, { extra: '&h265=0', opts })]
    await until(() => live.every((l) => l.ws.bins.filter((b) => !b.key).length >= 3), 3000)
    check('  the pool is whole: a remote viewer and an H.265 conversion after it both play converted', live.every((l) => l.ws.bins.filter((b) => !b.key).length >= 3 && l.ws.bins.every(converted)) && pool.active === 2, `pool ${pool.active}`)
    for (const l of live) l.session.close()
  }
  {
    // A remote viewer's conversion is optional (the recording itself still plays, if not as smoothly);
    // H.265 for a browser without it has nothing else to play, here or in NVR playback (playback.mjs),
    // and both come out of the same process-wide pool. So a remote viewer never takes the last free
    // slot: two remote viewers over the cap must not turn the site PC's H.265 playback into a refusal.
    const xs = []
    const pool = new TranscodePool(2)
    const opts = { fitAboveKbps: 0, pool, makeTranscoder: fakeXcode(xs) }
    const r1 = open(0, T0 + 1000, { remote: true, opts })
    await until(() => fitMsgs(r1.ws).length > 0, 2000)
    const r2 = open(0, T0 + 1000, { remote: true, opts })
    await until(() => fitMsgs(r2.ws).length > 0, 2000)
    const site = open(10, T10 + 100, { extra: '&h265=0', opts })
    const plays = (l) => l.ws.bins.filter((b) => !b.key).length >= 5
    await until(() => [r1, r2, site].every(plays) || site.ws.texts.some((t) => t.type === 'error'), 3000)
    check('two remote viewers over the cap, then a browser without H.265 on an H.265 recording: all three play', [r1, r2, site].every(plays) && [r1, r2, site].every((l) => l.ws.readyState === 1 && !l.ws.texts.some((t) => t.type === 'error')), J(site.ws.texts.filter((t) => t.type === 'error')))
    check('  the first remote viewer is converted', J(fitMsgs(r1.ws)) === J([{ type: 'fit', on: true }]) && r1.ws.bins.every(converted), J(fitMsgs(r1.ws)))
    check('  the second is left the recording itself: the last slot is not for a conversion that has an alternative', J(fitMsgs(r2.ws)) === J([{ type: 'fit', on: false, busy: true }]) && !r2.ws.bins.some(converted), J(fitMsgs(r2.ws)))
    check('  the H.265 one takes that slot: converted', site.ws.bins.every(converted) && pool.active === 2, `pool ${pool.active}`)
    for (const l of [r1, r2, site]) l.session.close()
    check('  every slot given back', pool.active === 0, String(pool.active))

    // a remote viewer who needs the conversion anyway (H.265, a browser without it) may take the last one
    const held = pool.acquire()
    const h = open(10, T10 + 100, { remote: true, extra: '&h265=0', opts })
    await until(() => plays(h), 3000)
    check('  a remote viewer on H.265 its browser cannot decode may take the last slot: converted, "on"', plays(h) && h.ws.bins.every(converted) && J(fitMsgs(h.ws)) === J([{ type: 'fit', on: true }]) && pool.active === 2, `${J(fitMsgs(h.ws))}, pool ${pool.active}`)
    h.session.close()
    held.release()
  }
  {
    // A remote viewer on H.265 it cannot decode, no slot at the start: the recording itself where it
    // can play it. A slot the H.265 then takes serves the whole session from the next jump, and the
    // page is told when that happens.
    const xs = []
    const pool = new TranscodePool(2)
    const held = [pool.acquire(), pool.acquire()]
    const { ws, session } = open(11, T11 + 100, { remote: true, extra: '&h265=0', opts: { fitAboveKbps: 0, pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => ws.bins.length >= 5, 3000)
    held[0].release() // free before the H.265 file comes
    const bStart = exp11b[0].ts
    await until(() => ws.bins.filter((b) => b.tsMs >= bStart).length >= 3, 8000)
    const a = ws.bins.filter((b) => b.tsMs < bStart)
    const b = ws.bins.filter((b) => b.tsMs >= bStart)
    check('remote, no slot at the start, H.264 then H.265 for a browser without it: the H.264 file untouched, the H.265 one converted', a.length >= 5 && !a.some(converted) && b.length >= 3 && b.every(converted), `${a.filter(converted).length}/${a.length} ${b.filter(converted).length}/${b.length}`)
    check('  (still "busy" for the page: this run does not switch the H.264 over)', J(fitMsgs(ws)) === J([{ type: 'fit', on: false, busy: true }]), J(fitMsgs(ws)))
    ws.command({ seek: T11 + 500, gen: 1 })
    await until(() => binsAfterStart(ws, 1).length >= 5, 3000)
    const after = binsAfterStart(ws, 1)
    check('  the next jump: the slot it holds converts everything, and the page is told', after.length >= 5 && after.every(converted) && J(fitMsgs(ws).at(-1)) === J({ type: 'fit', on: true }) && pool.active === 2, `${after.filter(converted).length}/${after.length}, ${J(fitMsgs(ws))}, pool ${pool.active}`)
    session.close()
    held[1].release()
    check('  close gives its slot back', pool.active === 0, String(pool.active))
  }
  {
    // converting, 2x and 4x are keyframes only (cause 2c): at 2x the cap would be spent on twice the
    // footage a second, and every frame of it would be twice the tunnel's share
    const xs = []
    const { ws, session } = open(0, T0 + 1000, { remote: true, opts: { fitAboveKbps: 0, pool: new TranscodePool(2), makeTranscoder: fakeXcode(xs) } })
    ws.command({ speed: 2 })
    await until(() => ws.bins.length >= 3, 6000)
    check('remote at 2x: keyframes only, converted, one at a time', ws.bins.length >= 3 && ws.bins.every((b) => b.key && converted(b)) && xs.length === 1 && J(xs[0].calls.slice(0, 4)) === J(['push', 'end', 'push', 'end']), `${ws.bins.length} frames, ${xs[0]?.calls.slice(0, 6).join()}`)
    session.close()
  }
  {
    // a browser that decodes H.265 is sent H.264 all the same: the conversion is what caps the rate
    const xs = []
    const pool = new TranscodePool(2)
    const { ws, session } = open(10, T10 + 100, { remote: true, extra: '&h265=1', opts: { fitAboveKbps: 0, pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => ws.bins.filter((b) => !b.key).length >= 5, 3000)
    check('remote: an H.265 recording for a browser that decodes H.265 is converted too', ws.bins.filter((b) => !b.key).length >= 5 && ws.bins.every(converted) && xs.length === 1 && xs[0].opts.inCodec === 1, `${ws.bins.length} frames, inCodec ${xs[0]?.opts.inCodec}`)
    session.close()
  }
  {
    const xs = []
    const pool = new TranscodePool(2)
    const lan = [
      open(0, T0 + 1000, { remote: false, opts: { pool, makeTranscoder: fakeXcode(xs) } }),
      open(10, T10 + 100, { remote: false, extra: '&h265=1', opts: { pool, makeTranscoder: fakeXcode(xs) } }),
      open(0, T0 + 1000, { opts: { pool, makeTranscoder: fakeXcode(xs) } }) // (not said: the local network)
    ]
    await until(() => lan.every((l) => l.ws.bins.filter((b) => !b.key).length >= 5), 3000)
    check('the local network: the recording itself, untouched, H.264 and H.265 alike', lan.every((l) => l.ws.bins.filter((b) => !b.key).length >= 5 && !l.ws.bins.some(converted)) && lan[0].ws.bins.every((b) => b.codec === 0) && lan[1].ws.bins.every((b) => b.codec === 1))
    check('  no conversion, no slot taken, no {type:"fit"}', xs.length === 0 && pool.active === 0 && lan.every((l) => fitMsgs(l.ws).length === 0), `${xs.length} ${pool.active}`)
    for (const l of lan) l.session.close()
  }
  {
    // both slots taken (two other conversions running): the recording itself rather than a refusal
    const xs = []
    const lines = []
    const pool = new TranscodePool(2)
    const held = [pool.acquire(), pool.acquire()]
    const { ws, session } = open(0, T0 + 1000, { remote: true, opts: { fitAboveKbps: 0, pool, makeTranscoder: fakeXcode(xs), log: (l) => lines.push(l) } })
    await until(() => ws.bins.filter((b) => !b.key).length >= 5, 3000)
    check('remote, both slots busy: the recording itself, untouched, and playback goes on', ws.bins.filter((b) => !b.key).length >= 5 && !ws.bins.some(converted) && ws.bins.every((b) => b.codec === 0) && xs.length === 0 && ws.readyState === 1 && !ws.texts.some((t) => t.type === 'error'), `${ws.bins.length} frames, ${xs.length} conversions`)
    check('  the page is told: {type:"fit", on:false, busy:true}', J(fitMsgs(ws)) === J([{ type: 'fit', on: false, busy: true }]), J(fitMsgs(ws)))
    check('  and it is logged', lines.some((l) => /remote viewer/.test(l) && /original/.test(l)), lines.join(' | '))
    // a slot comes free while it plays: no switch in the middle of a run (the converter would start
    // on the next keyframe and drop the frames before it)
    held[0].release()
    const n = ws.bins.length
    await until(() => ws.bins.length >= n + 10, 3000)
    check('  a slot freed while it plays: it stays on the recording itself until the next jump', ws.bins.length >= n + 10 && !ws.bins.some(converted) && xs.length === 0 && pool.active === 1)
    // that slot is the last free one, kept for a conversion with no alternative (H.265 for a browser
    // without it): the next seek still sends the recording itself
    ws.command({ seek: T0 + 30_000, gen: 1 })
    await until(() => binsAfterStart(ws, 1).filter((b) => !b.key).length >= 5, 3000)
    const kept = binsAfterStart(ws, 1)
    check('  the next seek, one slot free: the last one is left alone, still the recording itself', kept.filter((b) => !b.key).length >= 5 && !kept.some(converted) && xs.length === 0 && pool.active === 1 && J(fitMsgs(ws).at(-1)) === J({ type: 'fit', on: false, busy: true }), `${kept.filter(converted).length}/${kept.length} converted, pool ${pool.active}, ${J(fitMsgs(ws))}`)
    held[1].release()
    ws.command({ seek: T0 + 40_000, gen: 2 })
    await until(() => binsAfterStart(ws, 2).filter((b) => !b.key).length >= 5, 3000)
    const after = binsAfterStart(ws, 2)
    check('  both free: the next seek takes one, converted from there', after.filter((b) => !b.key).length >= 5 && after.every(converted) && xs.length === 1 && pool.active === 1, `${after.length} frames, ${after.filter((b) => !converted(b)).length} not converted, pool ${pool.active}`)
    check('  and the page is told so', J(fitMsgs(ws).at(-1)) === J({ type: 'fit', on: true }), J(fitMsgs(ws)))
    const other = pool.acquire()
    session.close()
    check('  close gives back only its own slot', pool.active === 1, String(pool.active))
    other.release()
  }
  {
    // H.265 for a browser that cannot decode it has no recording-itself to fall back to: refused as before
    const xs = []
    const pool = new TranscodePool(2)
    const held = [pool.acquire(), pool.acquire()]
    const { ws } = open(10, T10 + 100, { remote: true, extra: '&h265=0', opts: { fitAboveKbps: 0, pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => ws.texts.some((t) => t.type === 'error'), 2000)
    const err = ws.texts.find((t) => t.type === 'error')
    check('remote, busy, H.265 the browser cannot decode: the converter-full refusal, as for the local network', Boolean(err) && /already converting/.test(err.message) && ws.bins.length === 0 && xs.length === 0 && ws.closedWith === 1011, err?.message)
    for (const h of held) h.release()
  }
  {
    // the viewer chose the recording itself ("Original (server)" on the page: &original=1)
    const xs = []
    const pool = new TranscodePool(2)
    const acquire = pool.acquire.bind(pool)
    let asked = 0
    pool.acquire = () => (asked++, acquire())
    const a = open(0, T0 + 1000, { remote: true, extra: '&original=1', opts: { fitAboveKbps: 0, pool, makeTranscoder: fakeXcode(xs) } })
    const b = open(10, T10 + 100, { remote: true, extra: '&h265=1&original=1', opts: { fitAboveKbps: 0, pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => [a, b].every((l) => l.ws.bins.filter((f) => !f.key).length >= 5), 3000)
    check('remote, the original chosen (&original=1): the recording itself, untouched, H.264 and H.265 alike', [a, b].every((l) => l.ws.bins.filter((f) => !f.key).length >= 5 && !l.ws.bins.some(converted)) && a.ws.bins.every((f) => f.codec === 0) && b.ws.bins.every((f) => f.codec === 1))
    check('  no conversion, and the pool is not even asked', xs.length === 0 && asked === 0 && pool.active === 0, `${xs.length} ${asked}`)
    check('  the page is told: {type:"fit", on:false, original:true}', [a, b].every((l) => J(fitMsgs(l.ws)) === J([{ type: 'fit', on: false, original: true }])), J(fitMsgs(a.ws)))
    a.session.close()
    b.session.close()
    // a browser that cannot decode H.265 cannot be sent the original of an H.265 recording
    const c = open(10, T10 + 100, { remote: true, extra: '&h265=0&original=1', opts: { fitAboveKbps: 0, pool, makeTranscoder: fakeXcode(xs) } })
    await until(() => c.ws.bins.length >= 3, 3000)
    check('  (an H.265 recording for a browser that cannot decode it is still converted)', c.ws.bins.length >= 3 && c.ws.bins.every(converted) && xs.length === 1)
    c.session.close()
  }
  {
    // an H.264 file, then an H.265 one straight after it: one converter, switched at the file boundary
    const xs = []
    const { ws, session } = open(11, T11 + 100, { remote: true, extra: '&h265=1', opts: { fitAboveKbps: 0, pool: new TranscodePool(2), makeTranscoder: fakeXcode(xs) } })
    const bStart = exp11b[0].ts
    await until(() => ws.bins.filter((b) => b.tsMs >= bStart && !b.key).length >= 5, 8000)
    const x = xs[0]
    const firstB = x ? x.pushed.findIndex((ts) => ts >= bStart) : -1
    check('remote, H.264 then H.265: every frame of both files converted, by one converter', xs.length === 1 && ws.bins.every(converted) && ws.bins.some((b) => b.tsMs < bStart) && ws.bins.filter((b) => b.tsMs >= bStart && !b.key).length >= 5, `${xs.length} conversions, ${ws.bins.length} frames`)
    check('  told H.264 for the first file and H.265 from the second file\'s first frame, restarted once there', firstB > 0 && x.codecs.slice(0, firstB).every((c) => c === 0) && x.codecs.slice(firstB).every((c) => c === 1) && x.resets === 1, `switch at push ${firstB}, ${x?.resets} resets`)
    check('  time never goes back', ws.bins.every((f, i) => i === 0 || f.tsMs > ws.bins[i - 1].tsMs))
    session.close()
  }
}

// server.mjs decides who is remote exactly as live view does (live-attach.mjs): by the socket's own
// address, where the Cloudflare tunnel (cloudflared on this machine) arrives from 127.0.0.1
{
  const { isRemoteAddress } = await import('../adaptive-live.mjs')
  check('isRemoteAddress: the tunnel (127.0.0.1, ::1, ::ffff:127.0.0.1) and the tailnet are remote, the LAN is not', isRemoteAddress('127.0.0.1') && isRemoteAddress('::1') && isRemoteAddress('::ffff:127.0.0.1') && isRemoteAddress('100.101.2.3') && !isRemoteAddress('192.168.1.50') && !isRemoteAddress('::ffff:192.168.1.50'))
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check('server.mjs: /playback is given remote from the socket\'s address, by live view\'s rule', /connectPlayback\(\{[^}]*remote: isRemoteAddress\(req\.socket\.remoteAddress\)[^}]*\}\)/.test(src) && /import \{[^}]*isRemoteAddress[^}]*\} from '\.\/adaptive-live\.mjs'/.test(src))
}

check('the NVR was never called', N.calls === 0 && N.connects.length === 0)
IDX.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
