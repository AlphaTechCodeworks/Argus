// Tests for rec-reader.mjs: segment files back to frames (access units, key flags from the .idx,
// smoothed times kept inside each file's span, consecutive files with bursty arrival, keyframe-only
// reads, files still being written, holes inside a file where the NVR stalled). Temp dirs only; no NVR.
// Uses a real clip when present: ../set/nvr1-13.bin (the lab) or CCTV_TEST_CLIP.
// Run:  node cctv/test/rec-reader.test.mjs
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SegmentWriter } from '../segment-writer.mjs'
import { CODEC, SegmentReader, codecOfPath, fileKeyTimes, keyAtOrAfter, keyAtOrBefore, smoothKeyTimes, splitUnits } from '../rec-reader.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const tick = () => new Promise((r) => setImmediate(r))
const J = (v) => JSON.stringify(v)

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

// ---- synthetic Annex B -------------------------------------------------------------------------
// A pool of NAL payload bytes like real video (many zeros) that never contains 00 00 00/01/02
// (emulation prevention); any slice of it is valid, and a payload never ends with a zero byte.
const POOL = (() => {
  const rnd = prng(7)
  const b = Buffer.allocUnsafe(2 << 20)
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
/** One NAL: start code (4 bytes for an access unit's first NAL), header bytes, payload. */
const nal = (first, hdr, rnd, len) => Buffer.concat([first ? SC4 : SC3, Buffer.from(hdr), body(rnd, len)])

// H.264 (1-byte header; the byte after a slice header's first byte: top bit set = first_mb_in_slice 0)
const h264 = {
  key: (rnd, len = 3000) => Buffer.concat([nal(true, [0x67, 0x64], rnd, 12), nal(false, [0x68], rnd, 4), nal(false, [0x65, 0x88], rnd, len)]),
  p: (rnd, len = 600, { slices = 1, sei = false, aud = false } = {}) => {
    const parts = []
    if (aud) parts.push(nal(true, [0x09, 0xf0], rnd, 0 + 1))
    if (sei) parts.push(nal(!aud, [0x06, 0x05], rnd, 20))
    parts.push(nal(!aud && !sei, [0x41, 0x9a], rnd, len))
    for (let s = 1; s < slices; s++) parts.push(nal(false, [0x41, 0x21], rnd, len)) // first_mb != 0
    return Buffer.concat(parts)
  }
}
// H.265 (2-byte header: type << 1, then tid 1; the next byte's top bit = first_slice_segment_in_pic_flag)
const h265 = {
  key: (rnd, len = 3000, type = 19) =>
    Buffer.concat([
      nal(true, [32 << 1, 1], rnd, 20), // VPS
      nal(false, [33 << 1, 1], rnd, 30), // SPS
      nal(false, [34 << 1, 1], rnd, 6), // PPS
      nal(false, [39 << 1, 1], rnd, 12), // prefix SEI
      nal(false, [type << 1, 1, 0xac], rnd, len) // IDR_W_RADL (19) / CRA (21)
    ]),
  p: (rnd, len = 600, { slices = 1, prefixSei = false, suffixSei = false } = {}) => {
    const parts = []
    if (prefixSei) parts.push(nal(true, [39 << 1, 1], rnd, 12))
    parts.push(nal(!prefixSei, [1 << 1, 1, 0xac], rnd, len)) // TRAIL_R, first slice segment
    for (let s = 1; s < slices; s++) parts.push(nal(false, [1 << 1, 1, 0x2c], rnd, len)) // not the first
    if (suffixSei) parts.push(nal(false, [40 << 1, 1], rnd, 10))
    return Buffer.concat(parts)
  }
}
const offsetsOf = (bufs) => { const o = []; let at = 0; for (const b of bufs) { o.push(at); at += b.length } return o }
function sameUnits(units, bufs, base = 0) {
  const offs = offsetsOf(bufs)
  if (units.length !== bufs.length) return `${units.length} units for ${bufs.length} frames`
  for (let i = 0; i < bufs.length; i++) if (units[i].start !== offs[i] + base || units[i].end !== offs[i] + base + bufs[i].length) return `unit ${i}: ${units[i].start}-${units[i].end}, want ${offs[i] + base}-${offs[i] + base + bufs[i].length}`
  return ''
}

// ---- codecOfPath -------------------------------------------------------------------------------
check('codecOfPath: .h264 -> 0, .h265 -> 1 (also a -2 suffix file)', codecOfPath('/r/n/1/2026-09-24/10/10-00.h264') === CODEC.h264 && codecOfPath('/r/n/1/2026-09-24/10/10-00-2.h265') === CODEC.h265 && CODEC.h264 === 0 && CODEC.h265 === 1)

// ---- splitUnits: H.264 ----------------------------------------------------------------------------
{
  const rnd = prng(1)
  const aus = [h264.key(rnd), h264.p(rnd, 500, { slices: 2 }), h264.p(rnd, 400, { sei: true }), h264.p(rnd, 300, { aud: true }), h264.p(rnd, 200)]
  const buf = Buffer.concat(aus)
  const { units, used } = splitUnits(buf, CODEC.h264)
  const bad = sameUnits(units, aus)
  check('H.264: SPS+PPS+IDR is one unit, a 2-slice P picture is one unit, SEI and AUD start a unit', !bad, bad)
  check('H.264: keyframe by NAL type (5) without .idx offsets', units.map((u) => u.isKey).join() === 'true,false,false,false,false', units.map((u) => u.isKey).join())
  check('H.264: final split uses the whole buffer', used === buf.length)
  const offs = offsetsOf(aus)
  const held = splitUnits(buf, CODEC.h264, { final: false })
  check('H.264: final:false holds back the last unit (used = its start)', held.units.length === 4 && held.used === offs[4], `${held.units.length} units, used ${held.used}`)
  const cut = splitUnits(buf.subarray(0, offs[4] + 3), CODEC.h264, { final: false })
  check('H.264: a start code cut at the end: the unit before it is held back too', cut.units.length === 3 && cut.used === offs[3], `${cut.units.length} units, used ${cut.used}`)
  // key flags from .idx offsets (base = the file offset of buf[0]); NAL types then do not count
  const base = 1_000_000
  const ko = splitUnits(buf, CODEC.h264, { keyOffsets: new Set([base + offs[2], base + offs[4]]), base })
  check('H.264: with keyOffsets, exactly the units starting at an offset are keys', ko.units.map((u) => u.isKey).join() === 'false,false,true,false,true', ko.units.map((u) => u.isKey).join())
  // a frame ending in a trailing zero byte, then a keyframe with a 3-byte start code
  const a = Buffer.concat([h264.p(rnd, 100), Buffer.from([0])])
  const k = Buffer.concat([SC3, h264.key(rnd).subarray(4)])
  const tz = splitUnits(Buffer.concat([a, k]), CODEC.h264, { keyOffsets: new Set([a.length]) })
  check('H.264: a keyframe after a trailing zero byte starts exactly at its .idx offset', tz.units.length === 2 && tz.units[1].start === a.length && tz.units[1].isKey && tz.units[0].end === a.length, JSON.stringify(tz.units))
  check('H.264: no start code -> no units', splitUnits(Buffer.from([1, 2, 3, 4, 5]), CODEC.h264).units.length === 0 && splitUnits(Buffer.from([0, 0, 0]), CODEC.h264, { final: false }).used === 0)
}

// ---- splitUnits: H.265 ----------------------------------------------------------------------------
{
  const rnd = prng(2)
  const aus = [h265.key(rnd), h265.p(rnd, 500, { slices: 2, suffixSei: true }), h265.p(rnd, 400), h265.p(rnd, 300, { prefixSei: true, suffixSei: true }), h265.key(rnd, 2000, 21)]
  const buf = Buffer.concat(aus)
  const { units } = splitUnits(buf, CODEC.h265)
  const bad = sameUnits(units, aus)
  check('H.265: VPS/SPS/PPS/prefix SEI/IDR one unit; suffix SEI stays; TRAIL with first-slice flag starts a unit', !bad, bad)
  check('H.265: keyframes by NAL type (IDR 19, CRA 21)', units.map((u) => u.isKey).join() === 'true,false,false,false,true', units.map((u) => u.isKey).join())
  const as264 = splitUnits(buf, CODEC.h264)
  check('H.265 bytes split as H.264 give a different answer (the codec matters)', sameUnits(as264.units, aus) !== '')
}

// ---- keyAtOrBefore / keyAtOrAfter --------------------------------------------------------------------
{
  const rows = [{ offset: 0, tsMs: 1000 }, { offset: 10, tsMs: 2000 }, { offset: 20, tsMs: 3000 }]
  const b = [500, 1000, 1500, 2000, 2999, 3000, 9000].map((t) => keyAtOrBefore(rows, t)).join()
  const a = [500, 1000, 1500, 2000, 2999, 3000, 3001].map((t) => keyAtOrAfter(rows, t)).join()
  check('keyAtOrBefore: before first -1, exact hits, between rows, after last', b === '-1,0,0,1,1,2,2', b)
  check('keyAtOrAfter: before first 0, exact hits, between rows, after last -1', a === '0,0,1,1,2,2,-1', a)
  check('keyAtOrBefore/After also take plain times (reader.times) and empty lists', keyAtOrBefore([1000, 2000], 1999) === 0 && keyAtOrAfter([1000, 2000], 1999) === 1 && keyAtOrBefore([], 5) === -1 && keyAtOrAfter([], 5) === -1)
}

// ---- smoothKeyTimes -------------------------------------------------------------------------------
{
  const rnd = prng(3)
  const t0 = Date.UTC(2026, 8, 24, 10, 0, 0)
  const jit = () => (rnd() * 2 - 1) * 300
  // a long run: the line fit is then within 40 ms of the truth everywhere
  const truth = Array.from({ length: 1000 }, (_, k) => t0 + 2000 * k)
  const out = smoothKeyTimes(truth.map((t) => ({ tsMs: Math.round(t + jit()) })))
  const worst = Math.max(...out.map((v, k) => Math.abs(v - truth[k])))
  check('smooth: keys every 2000 ms with +-300 ms jitter -> within 40 ms of the truth', worst < 40, `worst ${worst.toFixed(1)} ms`)
  // a 1-minute file (30 keys): the fitted steps are steady (playback does not speed up and slow down)
  const t30 = truth.slice(0, 30)
  const raw30 = t30.map((t) => Math.round(t + jit()))
  const o30 = smoothKeyTimes(raw30.map((tsMs) => ({ tsMs })))
  const steps = o30.slice(1).map((v, k) => v - o30[k])
  const rawSteps = raw30.slice(1).map((v, k) => v - raw30[k])
  check('smooth: a 1-minute file (30 keys) gets steady steps', Math.max(...steps.map((s) => Math.abs(s - 2000))) < 20 && Math.max(...rawSteps.map((s) => Math.abs(s - 2000))) > 200, `step error ${Math.max(...steps.map((s) => Math.abs(s - 2000))).toFixed(1)} ms (raw ${Math.max(...rawSteps.map((s) => Math.abs(s - 2000)))})`)
  check('smooth: a 1-minute file stays near the truth', Math.max(...o30.map((v, k) => Math.abs(v - t30[k]))) < 200, `${Math.max(...o30.map((v, k) => Math.abs(v - t30[k]))).toFixed(1)} ms`)
  // a 60 s gap splits the run: both sides fitted on their own, nothing pulled across the gap
  const tg = [...Array.from({ length: 1000 }, (_, k) => t0 + 2000 * k), ...Array.from({ length: 1000 }, (_, k) => t0 + 2000 * 999 + 60_000 + 2000 * k)]
  const og = smoothKeyTimes(tg.map((t) => Math.round(t + jit())))
  const wg = Math.max(...og.map((v, k) => Math.abs(v - tg[k])))
  const edge = [998, 999, 1000, 1001].map((k) => Math.abs(og[k] - tg[k]).toFixed(0)).join('/')
  check('smooth: a 60 s gap splits the run; times on either side are not pulled', wg < 40, `worst ${wg.toFixed(1)} ms, at the gap ${edge}`)
  // a smaller step change (3.5 s where 2 s is normal) also splits: exact times stay exact
  const tc = [...Array.from({ length: 10 }, (_, k) => t0 + 2000 * k), ...Array.from({ length: 10 }, (_, k) => t0 + 18_000 + 3500 + 2000 * k)]
  const oc = smoothKeyTimes(tc.map((tsMs) => ({ tsMs })))
  check('smooth: a 1.75x step splits the run (exact times stay exact)', oc.every((v, k) => Math.abs(v - tc[k]) < 0.01), oc.map((v, k) => (v - tc[k]).toFixed(0)).join(','))
  // the 500 ms rule: one key 700 ms late keeps its raw time (residual ~630 ms); 400 ms late is fitted
  const t10 = Array.from({ length: 10 }, (_, k) => t0 + 2000 * k)
  const late = (ms) => smoothKeyTimes(t10.map((t, k) => (k === 5 ? t + ms : t)))
  const o700 = late(700)
  const o400 = late(400)
  // (its 2700 ms step is more than 600 ms off the median: it also ends the run, so the others are not pulled at all)
  check('smooth: a key 700 ms off keeps the raw time, the others stay within 100 ms', o700[5] === t10[5] + 700 && o700.every((v, k) => k === 5 || Math.abs(v - t10[k]) < 100),o700.map((v, k) => (v - t10[k]).toFixed(0)).join(','))
  check('smooth: a residual under 500 ms is fitted', o400[5] !== t10[5] + 400 && Math.abs(o400[5] - t10[5]) < 100, o400.map((v, k) => (v - t10[k]).toFixed(0)).join(','))
  // variable GOP (random 2-10 s, no jitter): large residuals keep the raw times
  const tv = [t0]
  for (let k = 1; k < 30; k++) tv.push(tv[k - 1] + 2000 + Math.round(rnd() * 8000))
  const ov = smoothKeyTimes(tv.map((tsMs) => ({ tsMs })))
  const kept = ov.filter((v, k) => v === tv[k]).length
  check('smooth: variable GOP: every time within 500 ms of raw, most kept raw', ov.every((v, k) => Math.abs(v - tv[k]) < 500) && kept >= 15, `${kept}/30 kept raw`)
  check('smooth: always strictly increasing (also for duplicate raw times)', [ov, og, o30].every((a) => a.every((v, k) => k === 0 || v > a[k - 1])) && smoothKeyTimes([5, 5, 5]).every((v, k, a) => k === 0 || v > a[k - 1]))
  check('smooth: fewer than 4 rows keep their raw times', smoothKeyTimes([{ tsMs: 1000 }, { tsMs: 3100 }, { tsMs: 4900 }]).join() === '1000,3100,4900')
}

// ---- fileKeyTimes: smoothed, but inside the file's own arrival span ---------------------------------
{
  const t0 = Date.UTC(2026, 8, 24, 10, 30, 0)
  const truth = Array.from({ length: 10 }, (_, k) => t0 + 2000 * k)
  // the first key arrived 400 ms late and the last 400 ms early; the file's last frame at endMs
  const raw = truth.map((t, k) => (k === 0 ? t + 400 : k === 9 ? t - 400 : t))
  const endMs = raw[9] + 100
  const sm = smoothKeyTimes(raw)
  const ft = fileKeyTimes(raw.map((tsMs) => ({ tsMs })), { endMs })
  check('fileKeyTimes: row 0 keeps its raw time (the segment\'s startMs), where the fit moves it', ft[0] === raw[0] && sm[0] !== raw[0], `${ft[0] - raw[0]} / fit ${(sm[0] - raw[0]).toFixed(0)}`)
  check('fileKeyTimes: a fitted key after endMs is held before endMs', sm[9] > endMs && ft.every((v) => v < endMs) && ft[9] > ft[8], `last ${(ft[9] - endMs).toFixed(3)} ms from endMs (fit ${(sm[9] - endMs).toFixed(0)})`)
  check('fileKeyTimes: the other keys keep their fitted times', ft.every((v, k) => k === 0 || k === 9 || v === sm[k]))
  const nf = fileKeyTimes(raw.map((tsMs) => ({ tsMs })))
  check('fileKeyTimes: without endMs (a growing file) only row 0 changes', nf[0] === raw[0] && nf.every((v, k) => k === 0 || v === sm[k]))
  // keys every 300 ms, the first four late (480, 330, 180, 30 ms; one run: no step under 150 ms):
  // key 1's fitted time is before row 0's raw time
  const late0 = [480, 330, 180, 30]
  const early = Array.from({ length: 40 }, (_, k) => t0 + 300 * k + (late0[k] ?? 0))
  const se = smoothKeyTimes(early)
  const fe = fileKeyTimes(early, { endMs: early[39] + 300 })
  check('fileKeyTimes: a fitted key before row 0\'s raw time comes after it; strictly increasing', se[1] < early[0] && fe[0] === early[0] && fe[1] > early[0] && fe.every((v, k) => k === 0 || v > fe[k - 1]), `fit of key 1 ${(se[1] - early[0]).toFixed(0)} ms from row 0, now ${(fe[1] - early[0]).toFixed(0)}`)
  check('fileKeyTimes: raw ties stay strictly increasing and within endMs', fileKeyTimes([5, 5, 5, 5, 5], { endMs: 100 }).every((v, k, a) => k === 0 || (v > a[k - 1] && v <= 100)))
  check('fileKeyTimes: no rows -> []', fileKeyTimes([], { endMs: 5 }).length === 0)
}

// ---- round trip, synthetic: 3 minutes at 25 fps, key every 50, through the real SegmentWriter -----------
/** Writes frames with a SegmentWriter; returns { segs, accepted } (accepted: the frames it kept). */
async function record(root, frames, codec) {
  const w = new SegmentWriter({ root, nvrId: 'n1', ch: 1, codec })
  const segs = []
  w.on('segment', (s) => segs.push(s))
  const accepted = []
  for (const f of frames) {
    if (w.write(f.buf, { isKey: f.isKey, ts: f.ts })) accepted.push(f)
    if (w.queueStatus().queuedBytes > 1 << 20) await w.drained()
  }
  await w.close()
  return { segs, accepted }
}
/** Every frame of every segment, in order, via gop(k); also checks keyframe(k) against the GOP's first frame. */
async function readAll(segs, stats) {
  const out = []
  let keyOk = true
  for (const s of segs) {
    const r = new SegmentReader({ path: s.path, endMs: s.endMs })
    await r.open()
    if (r.rows.length !== s.keyframes) keyOk = false
    for (let k = 0; k < r.rows.length; k++) {
      const g = await r.gop(k)
      const kf = await r.keyframe(k)
      if (!kf || !g[0] || !kf.buf.equals(g[0].buf) || kf.ts !== g[0].ts || kf.ts !== r.times[k] || !g[0].isKey) keyOk = false
      out.push(...g)
    }
    await r.close()
  }
  if (stats) stats.keyOk = keyOk
  return out
}
function compare(got, want) {
  if (got.length !== want.length) return `${got.length} frames read, ${want.length} written`
  for (let i = 0; i < want.length; i++) {
    if (!got[i].buf.equals(want[i].buf)) return `frame ${i}: bytes differ (${got[i].buf.length} vs ${want[i].buf.length})`
    if (got[i].isKey !== want[i].isKey) return `frame ${i}: isKey ${got[i].isKey}, want ${want[i].isKey}`
  }
  return ''
}
{
  const rnd = prng(4)
  const t0 = Date.UTC(2026, 8, 24, 10, 0, 20)
  const frames = []
  for (let i = 0; i < 25 * 180; i++) {
    const isKey = i % 50 === 0
    const r = rnd()
    const buf = isKey ? h264.key(rnd, 2000 + Math.floor(r * 3000)) : h264.p(rnd, 200 + Math.floor(r * 1000), { slices: r < 0.2 ? 2 : 1, sei: r > 0.9, aud: r > 0.5 && r < 0.6 })
    frames.push({ buf, isKey, ts: t0 + i * 40 + Math.round((rnd() * 2 - 1) * 10) }) // arrival: +-10 ms
  }
  const root = mkdtempSync(join(tmpdir(), 'recr-'))
  const { segs, accepted } = await record(root, frames, 'h264')
  const st = {}
  const got = await readAll(segs, st)
  const bad = compare(got, accepted)
  check('round trip (synthetic H.264, 3 min): the same buffers, key flags and frame count', !bad && segs.length === 4 && accepted.length === frames.length, bad || `${segs.length} segments, ${got.length} frames`)
  check('round trip: one row per keyframe; keyframe(k) is the GOP\'s first frame, with its time', st.keyOk)
  let inc = true
  let worst = 0
  for (let i = 0; i < got.length; i++) {
    if (i && !(got[i].ts > got[i - 1].ts)) inc = false
    worst = Math.max(worst, Math.abs(got[i].ts - accepted[i].ts))
  }
  check('frame times increase strictly within and across GOPs and files', inc)
  check('every frame time is within one frame interval (40 ms) of the time written', worst < 40, `worst ${worst.toFixed(1)} ms`)
}
{
  const rnd = prng(5)
  const t0 = Date.UTC(2026, 8, 24, 11, 0, 45)
  const frames = []
  for (let i = 0; i < 25 * 40; i++) {
    const isKey = i % 50 === 0
    const r = rnd()
    const buf = isKey ? h265.key(rnd, 2500, r < 0.5 ? 19 : 21) : h265.p(rnd, 300 + Math.floor(r * 700), { slices: r < 0.2 ? 2 : 1, prefixSei: r > 0.8, suffixSei: r > 0.6 })
    frames.push({ buf, isKey, ts: t0 + i * 40 })
  }
  const { segs, accepted } = await record(mkdtempSync(join(tmpdir(), 'recr-')), frames, 'h265')
  const got = await readAll(segs)
  const bad = compare(got, accepted)
  check('round trip (synthetic H.265, 40 s over a minute boundary): the same buffers and key flags', !bad && segs.length === 2 && segs.every((s) => s.path.endsWith('.h265')), bad || `${segs.length} segments`)
  check('round trip H.265: exact arrival times come back exactly', got.every((f, i) => Math.abs(f.ts - accepted[i].ts) < 0.01))
}

// ---- round trip, real clip ------------------------------------------------------------------------
{
  const clip = process.env.CCTV_TEST_CLIP || ['../set/nvr1-13.bin', '../../set/nvr1-13.bin'].find((p) => existsSync(p))
  if (!clip || !existsSync(clip)) console.log('SKIP  real clip (set/nvr1-13.bin not found)')
  else {
    const data = readFileSync(clip)
    const clipFrames = refSplit(data)
    const keys = clipFrames.filter((f) => f.isKey).length
    check('real clip: split into frames with keyframes', clipFrames.length > 10 && keys >= 1, `${clipFrames.length} frames, ${keys} keys, ${clipFrames.codec}`)
    const t0 = Date.UTC(2026, 8, 24, 12, 0, 40)
    const frames = []
    let ts = t0
    while (ts < t0 + 140_000) for (const f of clipFrames) { frames.push({ buf: f.buf, isKey: f.isKey, ts }); ts += 400 }
    const { segs, accepted } = await record(mkdtempSync(join(tmpdir(), 'recr-real-')), frames, clipFrames.codec)
    const st = {}
    const got = await readAll(segs, st)
    const bad = compare(got, accepted)
    check('real clip: SegmentReader returns the same buffers and key flags', !bad && segs.length >= 3, bad || `${segs.length} segments, ${got.length} frames`)
    check('real clip: keyframe(k) is each GOP\'s first frame', st.keyOk)
  }
}

// ---- keyframe(k): a 900 KB keyframe needs several 256 KB reads -----------------------------------------
/** node:fs/promises with counters: opens, open handles, reads, read sizes, reads in flight. */
function countingFs(stats) {
  Object.assign(stats, { opens: 0, open: 0, reads: 0, maxLen: 0, inFlight: 0, maxInFlight: 0 })
  return {
    async open(p, flags) {
      const fh = await fsp.open(p, flags)
      stats.opens++
      stats.open++
      let closed = false
      return {
        async read(buf, off, len, pos) {
          stats.reads++
          stats.maxLen = Math.max(stats.maxLen, len)
          stats.maxInFlight = Math.max(stats.maxInFlight, ++stats.inFlight)
          try { return await fh.read(buf, off, len, pos) } finally { stats.inFlight-- }
        },
        stat: () => fh.stat(),
        async close() { if (!closed) { closed = true; stats.open-- } return fh.close() }
      }
    }
  }
}
{
  const rnd = prng(6)
  const t0 = Date.UTC(2026, 8, 24, 13, 0, 1)
  const bufs = [h264.key(rnd, 3000), ...Array.from({ length: 10 }, () => h264.p(rnd, 800)), h264.key(rnd, 900 * 1024), ...Array.from({ length: 10 }, () => h264.p(rnd, 800)), h264.key(rnd, 5000), h264.p(rnd), h264.key(rnd, 4000)]
  const frames = bufs.map((buf, i) => ({ buf, isKey: buf[4] === 0x67, ts: t0 + i * 40 }))
  const { segs } = await record(mkdtempSync(join(tmpdir(), 'recr-big-')), frames, 'h264')
  const stats = {}
  const r = new SegmentReader({ path: segs[0].path, endMs: segs[0].endMs, fs: countingFs(stats) })
  await r.open()
  const before = stats.reads
  stats.maxLen = 0 // (open() may have counted GOPs: reads of whole GOPs)
  const kf = await r.keyframe(1)
  const reads = stats.reads - before
  check('keyframe(k): exactly the 900 KB keyframe unit', r.rows.length === 4 && kf && kf.buf.equals(frames[11].buf), `${kf?.buf.length} bytes, want ${frames[11].buf.length}`)
  check('keyframe(k): read in 256 KB chunks until the next unit starts', reads === 4 && stats.maxLen <= 256 * 1024, `${reads} reads, largest ${stats.maxLen}`)
  const k2 = await r.keyframe(2)
  const k3 = await r.keyframe(3)
  check('keyframe(k): a small keyframe, and the last one at the end of the file', k2?.buf.equals(frames[22].buf) && k3?.buf.equals(frames[24].buf) && k3.ts === r.times[3])
  const g3 = await r.gop(3)
  check('gop(last) of one frame: that frame at the key time', g3.length === 1 && g3[0].isKey && g3[0].ts === r.times[3])
  check('keyframe/gop out of range: null / []', (await r.keyframe(9)) === null && (await r.gop(-1)).length === 0)
  check('reads: never more than one in flight', stats.maxInFlight === 1)
  await r.close()
  check('close(): no handle left open', stats.open === 0, `${stats.open} open`)
}

// ---- hand-made files: partial .idx row, rows past the data, missing files ---------------------------------
/** Writes <dir>/<name> and its .idx from frames; returns { path, offsets }. extraIdx: bytes appended to the .idx. */
function writeSeg(dir, name, frames, { extraIdx = Buffer.alloc(0), rows = null } = {}) {
  const path = join(dir, name)
  const offsets = offsetsOf(frames.map((f) => f.buf))
  writeFileSync(path, Buffer.concat(frames.map((f) => f.buf)))
  const list = rows ?? frames.map((f, i) => (f.isKey ? { offset: offsets[i], tsMs: f.ts } : null)).filter(Boolean)
  const idx = Buffer.alloc(list.length * 16)
  list.forEach((r, i) => { idx.writeBigUInt64LE(BigInt(r.offset), i * 16); idx.writeBigInt64LE(BigInt(r.tsMs), i * 16 + 8) })
  writeFileSync(`${path}.idx`, Buffer.concat([idx, extraIdx]))
  return { path, offsets }
}
const gopFrames = (rnd, t0, keys, perGop, step = 40) => Array.from({ length: keys * perGop }, (_, i) => ({ buf: i % perGop ? h264.p(rnd, 300) : h264.key(rnd, 1500), isKey: i % perGop === 0, ts: t0 + i * step }))
{
  const rnd = prng(8)
  const dir = mkdtempSync(join(tmpdir(), 'recr-hand-'))
  const t0 = Date.UTC(2026, 8, 24, 14, 0, 0)
  const frames = gopFrames(rnd, t0, 2, 25)
  const { path } = writeSeg(dir, '14-00.h264', frames, { extraIdx: Buffer.alloc(8, 7) })
  const r = await new SegmentReader({ path, endMs: frames.at(-1).ts }).open()
  check('a partial last .idx row is ignored', r.rows.length === 2 && r.codec === CODEC.h264, `${r.rows.length} rows`)
  const all = [...(await r.gop(0)), ...(await r.gop(1))]
  check('closed file: every frame, the last GOP ending at endMs', !compare(all, frames) && Math.abs(all.at(-1).ts - frames.at(-1).ts) < 0.01)
  await r.close()
  // rows whose data is not written yet: offset == size and beyond
  const g0 = frames.slice(0, 25)
  const size = g0.reduce((n, f) => n + f.buf.length, 0)
  const p2 = writeSeg(dir, '14-01.h264', g0, { rows: [{ offset: 0, tsMs: t0 }, { offset: size, tsMs: t0 + 1000 }, { offset: size + 100, tsMs: t0 + 2000 }] }).path
  const closed = await new SegmentReader({ path: p2, endMs: g0.at(-1).ts }).open()
  const growing = await new SegmentReader({ path: p2, growing: true }).open()
  const gc = await closed.gop(0)
  const gg = await growing.gop(0)
  check('.idx rows whose data is not on disk yet are not used', closed.rows.length === 1 && growing.rows.length === 1)
  check('growing file: the last (possibly incomplete) frame is held back', gc.length === 25 && gg.length === 24 && !compare(gg, g0.slice(0, 24)), `${gc.length} / ${gg.length}`)
  check('growing file, last GOP: frames 40 ms apart when there is no previous GOP', gg.every((f, i) => Math.abs(f.ts - (t0 + 40 * i)) < 0.01))
  await closed.close()
  await growing.close()
  // the last GOP of a closed file whose endMs is off: the previous GOP's step is used
  const f3 = gopFrames(rnd, t0, 3, 25)
  const p3 = writeSeg(dir, '14-02.h264', f3).path
  const r3 = await new SegmentReader({ path: p3, endMs: f3.at(-1).ts + 30_000 }).open()
  const last = await r3.gop(2)
  check('closed file, endMs far off: the last GOP keeps the previous GOP\'s step', Math.abs(last[1].ts - last[0].ts - 40) < 0.01 && Math.abs(last.at(-1).ts - f3.at(-1).ts) < 0.01, `${(last[1].ts - last[0].ts).toFixed(2)} ms`)
  await r3.close()
  // the last GOP arrived in a burst (endMs 300 ms after its key, not 960): its frames keep the camera's
  // 40 ms step (they were captured 40 ms apart), not squeezed into the 300 ms before endMs
  const endC = f3[50].ts + 300
  const rc = await new SegmentReader({ path: p3, endMs: endC }).open()
  const lc = await rc.gop(2)
  const stepsC = lc.slice(1).map((f, i) => f.ts - lc[i].ts)
  check('closed file, last GOP in a burst: its frames keep the 40 ms step (never squeezed before endMs)', lc.length === 25 && stepsC.every((s) => Math.abs(s - 40) < 0.01) && rc.holeAfter(2) === null, J(stepsC.map((s) => +s.toFixed(2))))
  await rc.close()
  // missing files
  let code = null
  try { await new SegmentReader({ path: join(dir, 'nope.h264') }).open() } catch (e) { code = e.code }
  check('a missing file throws with code ENOENT', code === 'ENOENT', code)
  writeFileSync(join(dir, 'noidx.h264'), frames[0].buf)
  const st = {}
  code = null
  try { await new SegmentReader({ path: join(dir, 'noidx.h264'), fs: countingFs(st) }).open() } catch (e) { code = e.code }
  check('a missing .idx throws ENOENT and leaves no handle open', code === 'ENOENT' && st.open === 0 && st.opens === 1, `${code}, ${st.open} open`)
}

// ---- a growing file: a writer keeps writing (frames cut anywhere) while the reader follows --------------------
/** Appends frames like SegmentWriter (the .idx row before the frame's bytes), each cut into pieces. */
async function slowWriter(path, frames, rnd) {
  const dfh = await fsp.open(path, 'wx')
  const ifh = await fsp.open(`${path}.idx`, 'w')
  let size = 0
  for (const f of frames) {
    if (f.isKey) {
      const row = Buffer.alloc(16)
      row.writeBigUInt64LE(BigInt(size), 0)
      row.writeBigInt64LE(BigInt(f.rowTs ?? f.ts), 8)
      await ifh.write(row)
      await tick()
    }
    const cuts = [0, Math.floor(rnd() * f.buf.length), Math.floor(rnd() * f.buf.length), Math.min(3, f.buf.length), f.buf.length].sort((a, b) => a - b)
    for (let c = 1; c < cuts.length; c++) {
      if (cuts[c] === cuts[c - 1]) continue
      await dfh.write(f.buf.subarray(cuts[c - 1], cuts[c]))
      size += cuts[c] - cuts[c - 1]
      await tick()
    }
  }
  await dfh.close()
  await ifh.close()
}
async function followGrowing(label, frames, rnd, { truthMs = 40 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'recr-grow-'))
  const path = join(dir, '15-00.h264')
  let done = false
  const writer = slowWriter(path, frames, rnd).then(() => (done = true))
  while (!existsSync(`${path}.idx`)) await tick()
  const r = await new SegmentReader({ path, growing: true }).open()
  const got = []
  let k = 0
  let i = 0
  const drain = async () => {
    while (k < r.rows.length) {
      const g = await r.gop(k)
      for (const f of g.slice(i)) got.push(f)
      i = Math.max(i, g.length)
      if (k < r.rows.length - 1) (k++, (i = 0))
      else break
    }
  }
  let refreshes = 0
  let news = 0
  let midFrame = 0 // refreshes that saw the file end inside a frame
  let rowAhead = 0 // refreshes that saw an .idx row before its bytes
  const bounds = new Set(offsetsOf(frames.map((f) => f.buf)))
  while (!done) {
    refreshes++
    if (await r.refresh()) news++
    if (!bounds.has(r.size)) midFrame++
    if (r.allRows.length > r.rows.length) rowAhead++
    await drain()
    await tick()
  }
  await writer
  await r.refresh()
  await drain()
  const quiet = (await r.refresh()) === false
  const before = got.length
  await r.markClosed(frames.at(-1).ts)
  await drain()
  await r.close()
  const bad = compare(got, frames)
  check(`${label}: refresh() sees new rows and bytes; nothing new -> false`, news > 5 && quiet, `${news}/${refreshes} refreshes with news`)
  check(`${label}: never a partial frame, every frame once, in order`, !bad && midFrame > 0 && rowAhead > 0, bad || `the file ended mid-frame at ${midFrame} refreshes, a row was ahead of its bytes at ${rowAhead}`)
  check(`${label}: the last frame comes only once the file is closed`, before === frames.length - 1, `${before} before close`)
  const inc = got.every((f, j) => j === 0 || f.ts > got[j - 1].ts)
  const worst = Math.max(...got.map((f, j) => Math.abs(f.ts - frames[j].ts)))
  check(`${label}: times increase strictly while following`, inc)
  check(`${label}: times within ${truthMs} ms of the truth`, worst < truthMs, `worst ${worst.toFixed(1)} ms`)
}
{
  const rnd = prng(9)
  const t0 = Date.UTC(2026, 8, 24, 15, 0, 0)
  await followGrowing('growing file', gopFrames(rnd, t0, 12, 25), rnd)
  // key arrival times jitter by up to 0.3 s: the times handed out never go back
  const jf = gopFrames(rnd, t0, 12, 25).map((f) => (f.isKey ? { ...f, rowTs: Math.round(f.ts + (rnd() * 2 - 1) * 300) } : f))
  await followGrowing('growing file, jittery key times', jf, rnd, { truthMs: 1000 })
}

// ---- consecutive files, bursty arrival: every file's times stay inside its own arrival span -------------
// The recorder stamps each frame on arrival, and the NVR sends in bursts: here a frame's stamp is the first
// burst instant at or after its capture time (delays of 0 up to the burst spacing, never going back). The
// first key of a file then arrived no earlier than the previous file's last frame (often in the same burst,
// with the same stamp), so times inside each file's [startMs, endMs] carry on across files without going back.
async function burstyFiles(label, seed, { gop, burstMin, burstMax, minutes }) {
  const rnd = prng(seed)
  const t0 = Date.UTC(2026, 8, 24, 16, 0, 20)
  const frames = []
  let burst = t0
  for (let i = 0; i < minutes * 60 * 25; i++) {
    const cap = t0 + i * 40
    while (burst < cap) burst += burstMin + Math.floor(rnd() * (burstMax - burstMin + 1))
    const isKey = i % gop === 0
    frames.push({ buf: isKey ? h264.key(rnd, 300) : h264.p(rnd, 40), isKey, ts: burst })
  }
  const { segs, accepted } = await record(mkdtempSync(join(tmpdir(), 'recr-burst-')), frames, 'h264')
  const got = []
  let startBad = 0
  let spanBad = 0
  let inFile = true
  let back = 0
  let ties = 0
  let worst = Infinity
  let prevLast = null
  let stepBad = 0
  for (const [j, s] of segs.entries()) {
    // as playback opens them: with the next file's start (the join) and the previous file's end
    const r = await new SegmentReader({ path: s.path, endMs: s.endMs, nextStartMs: segs[j + 1]?.startMs ?? null, prevEndMs: segs[j - 1]?.endMs ?? null }).open()
    if (r.times[0] !== s.startMs) startBad++
    const fs = []
    for (let k = 0; k < r.rows.length; k++) fs.push(...(await r.gop(k)))
    await r.close()
    if (!fs.every((f, j) => j === 0 || f.ts > fs[j - 1].ts)) inFile = false
    if (fs.some((f, i) => i > 0 && f.ts - fs[i - 1].ts < 0.75 * 40)) stepBad++
    const nextStart = segs[j + 1]?.startMs ?? Infinity
    if (fs.some((f) => f.ts < s.startMs || f.ts >= nextStart)) spanBad++
    if (prevLast !== null) {
      const d = fs[0].ts - prevLast
      if (d < 0) back++
      else if (d === 0) ties++
      worst = Math.min(worst, d)
    }
    prevLast = fs.at(-1).ts
    got.push(...fs)
  }
  const bad = compare(got, accepted)
  const nb = segs.length - 1
  const us = got.map((f) => Math.round(f.ts * 1000)) // the wire's µs timestamps
  const usInc = us.every((v, j) => j === 0 || v > us[j - 1])
  check(`${label}: every frame read back once, in order`, !bad && segs.length >= minutes, bad || `${segs.length} files`)
  check(`${label}: times[0] === the segment's startMs in every file`, startBad === 0, `${startBad}/${segs.length} files differ`)
  check(`${label}: every frame time from its file's startMs to before the next file's`, spanBad === 0, `${spanBad}/${segs.length} files have times outside`)
  check(`${label}: no frame step under 0.75x the camera's 40 ms (no squeeze at joins or bursts)`, stepBad === 0, `${stepBad}/${segs.length} files`)
  const sameMs = segs.filter((s, j) => j > 0 && s.startMs === segs[j - 1].endMs).length // a file's first frame in the same ms as the last one before it
  check(`${label}: times increase strictly within files and across all ${nb} file boundaries (also in µs)`, inFile && back === 0 && ties === 0 && usInc, `${back} back, ${ties} equal, worst step across a boundary ${worst.toFixed(3)} ms, ${sameMs} boundaries with the same stamp on both sides${usInc ? '' : ', not increasing in µs'}`)
}
await burstyFiles('bursty 300-450 ms, 2 s GOP', 11, { gop: 50, burstMin: 300, burstMax: 450, minutes: 12 })
await burstyFiles('bursty 300-450 ms, 1 s GOP', 12, { gop: 25, burstMin: 300, burstMax: 450, minutes: 12 })
await burstyFiles('bursty 100-200 ms, 2 s GOP', 13, { gop: 50, burstMin: 100, burstMax: 200, minutes: 12 })

// ---- holes inside one file: the NVR stalled and came back within the minute ------------------------------------
// The writer carries on in the same file when frames come back (it closes a file only at rollover, a codec change
// or an overflow), so the span from one keyframe to the next can include a silence. The frames of that GOP keep the
// frame step of the GOPs around it, from its keyframe; the rest of the span is a hole, which holeAfter(k) reports.
// A long GOP, keyframes-only footage and a change of frame rate are footage, not holes.
/** Frames at exact times, in runs: [{ at, n, gop, step }], each run starting with a keyframe (a restarted stream). */
const runFrames = (rnd, list) => list.flatMap(({ at, n, gop = 50, step = 40 }) => Array.from({ length: n }, (_, i) => ({ buf: i % gop ? h264.p(rnd, 200) : h264.key(rnd, 1200), isKey: i % gop === 0, ts: at + i * step })))
async function holeCase(label, seed, list, wantHoles) {
  const t0 = Date.UTC(2026, 8, 24, 17, 0, 0)
  const frames = runFrames(prng(seed), list.map((r) => ({ ...r, at: t0 + r.at })))
  const { segs, accepted } = await record(mkdtempSync(join(tmpdir(), 'recr-hole-')), frames, 'h264')
  const r = await new SegmentReader({ path: segs[0].path, endMs: segs[0].endMs }).open()
  const got = []
  const holes = []
  for (let k = 0; k < r.rows.length; k++) got.push(...(await r.gop(k)))
  const api = typeof r.holeAfter === 'function'
  for (let k = 0; api && k < r.rows.length; k++) {
    const h = r.holeAfter(k)
    if (h) holes.push([h.fromMs - t0, h.toMs - t0])
  }
  await r.close()
  const bad = compare(got, accepted)
  let worst = 0
  let at = 0
  got.forEach((f, i) => {
    const d = Math.abs(f.ts - accepted[i].ts)
    if (d > worst) (worst = d), (at = accepted[i].ts - t0)
  })
  check(`${label}: one file, every frame back`, segs.length === 1 && !bad, bad || `${segs.length} files`)
  check(`${label}: every frame at its time as written (within 1 ms)`, worst < 1, `worst ${worst.toFixed(1)} ms, at +${at} ms`)
  const same = api && holes.length === wantHoles.length && holes.every(([a, b], j) => Math.abs(a - wantHoles[j][0]) < 1 && Math.abs(b - wantHoles[j][1]) < 1)
  check(`${label}: holeAfter(k) ${wantHoles.length ? `reports ${wantHoles.map(([a, b]) => `+${a}..+${b} ms`).join(' and ')}` : 'reports no hole'}`, same, api ? J(holes.map(([a, b]) => [+a.toFixed(1), +b.toFixed(1)])) : 'no holeAfter()')
}
// 10 s at 25 fps (a key every 2 s), no frames from +10 s to +40 s, then 20 s more (the stream restarted: a key first)
await holeCase('a 30 s hole inside a file', 14, [{ at: 0, n: 250 }, { at: 40_000, n: 500 }], [[9960, 40_000]])
// two stalls in a row: 11 frames then 20 s of silence, 11 frames then 15 s of silence
await holeCase('two holes in consecutive GOPs', 15, [{ at: 0, n: 150 }, { at: 6000, n: 11 }, { at: 26_000, n: 11 }, { at: 41_000, n: 400 }], [[6400, 26_000], [26_400, 41_000]])
// a hole in the first GOP of a file
await holeCase('a hole in the first GOP', 16, [{ at: 0, n: 30 }, { at: 20_000, n: 500 }], [[1160, 20_000]])
// keyframes only (a frame every 4 s) with a 30 s hole: every frame at its time; only the hole is one
await holeCase('keyframes-only footage with a 30 s hole', 17, [{ at: 0, n: 5, gop: 1, step: 4000 }, { at: 46_000, n: 3, gop: 1, step: 4000 }], [[16_000, 46_000]])
// a 10 s GOP between 2 s ones (the same 25 fps): not a hole
await holeCase('a long GOP (250 frames) between 2 s GOPs', 18, [{ at: 0, n: 100 }, { at: 4000, n: 250, gop: 250 }, { at: 14_000, n: 500 }], [])
// the frame rate halves and comes back (12.5 fps, GOPs of 50 frames = 4 s): not a hole
await holeCase('a frame rate change (25 -> 12.5 -> 25 fps)', 19, [{ at: 0, n: 250 }, { at: 10_000, n: 250, step: 80 }, { at: 30_000, n: 500 }], [])

// the NVR stalls inside a file's last GOP: 10 frames, 50 s of silence, one more frame, then the file is closed.
// The GOP keeps the frame step of the GOP before it and the rest of the span up to endMs is a hole (holeAfter),
// so playback jumps it with a notice instead of freezing on one picture for 50 s (18-22.h264: a 53.9 s freeze).
{
  const t0 = Date.UTC(2026, 8, 24, 17, 30, 0)
  const rnd = prng(31)
  const frames = [...runFrames(rnd, [{ at: t0, n: 260 }]), { buf: h264.p(rnd, 200), isKey: false, ts: t0 + 60_000 }]
  const { segs } = await record(mkdtempSync(join(tmpdir(), 'recr-lastgop-')), frames, 'h264')
  const r = await new SegmentReader({ path: segs[0].path, endMs: segs[0].endMs }).open()
  const k = r.rows.length - 1
  const got = await r.gop(k)
  const h = r.holeAfter(k)
  await r.close()
  const steps = got.slice(1).map((f, i) => f.ts - got[i].ts)
  check('a stall in the last GOP: its frames keep the 40 ms step', segs.length === 1 && got.length === 11 && steps.every((s) => Math.abs(s - 40) < 1), J(steps.map((s) => +s.toFixed(1))))
  check('a stall in the last GOP: holeAfter reports the rest of the span up to endMs', h && Math.abs(h.fromMs - got.at(-1).ts) < 1 && Math.abs(h.toMs - segs[0].endMs) < 1 && h.toMs - h.fromMs > 49_000, J(h))
}

// GOPs of 2 to 10 s at the same frame rate, read in order: the hole check reads nothing more (one read per GOP)
{
  const t0 = Date.UTC(2026, 8, 24, 17, 20, 0)
  const list = []
  let at = t0
  for (const n of [50, 250, 50, 100, 250, 50, 150, 50, 250, 50]) (list.push({ at, n, gop: n }), (at += n * 40))
  const frames = runFrames(prng(21), list)
  const { segs, accepted } = await record(mkdtempSync(join(tmpdir(), 'recr-vgop-')), frames, 'h264')
  const stats = {}
  const r = await new SegmentReader({ path: segs[0].path, endMs: segs[0].endMs, fs: countingFs(stats) }).open()
  const before = stats.reads
  const got = []
  for (let k = 0; k < r.rows.length; k++) got.push(...(await r.gop(k)))
  const reads = stats.reads - before
  const holes = r.rows.map((_, k) => r.holeAfter?.(k)).filter(Boolean)
  await r.close()
  const worst = Math.max(...got.map((f, i) => Math.abs(f.ts - accepted[i].ts)))
  // (short GOPs are counted at open to rule out a burst, and a few GOPs to measure the frame step: some extra reads)
  check('GOPs of 2 to 10 s (25 fps), read in order: at most 2 reads per GOP, no hole, times within 500 ms (the key time fit)', segs.length === 1 && !compare(got, accepted) && reads <= 2 * r.rows.length && holes.length === 0 && worst < 500, `${reads} reads for ${r.rows.length} GOPs, ${holes.length} holes, worst ${worst.toFixed(0)} ms`)
}

// ---- a hole in a growing file: the newest GOP stalls while its frames are being handed out ----------------------------
{
  const rnd = prng(20)
  const dir = mkdtempSync(join(tmpdir(), 'recr-grow-hole-'))
  const t0 = Date.UTC(2026, 8, 24, 17, 10, 0)
  const all = runFrames(rnd, [{ at: t0, n: 250 }, { at: t0 + 40_000, n: 100 }])
  const path = join(dir, '17-10.h264')
  const rowOf = (offset, tsMs) => {
    const b = Buffer.alloc(16)
    b.writeBigUInt64LE(BigInt(offset), 0)
    b.writeBigInt64LE(BigInt(tsMs), 8)
    return b
  }
  // what the writer has written by the stall: every frame of the first 10 s
  const offs = offsetsOf(all.map((f) => f.buf))
  writeFileSync(path, Buffer.concat(all.slice(0, 250).map((f) => f.buf)))
  writeFileSync(`${path}.idx`, Buffer.concat(all.slice(0, 250).flatMap((f, i) => (f.isKey ? [rowOf(offs[i], f.ts)] : []))))
  const r = await new SegmentReader({ path, growing: true }).open()
  const got = []
  for (let k = 0; k < r.rows.length; k++) got.push(...(await r.gop(k))) // the last GOP: all but its last frame
  const handed = got.length
  // 30 s later the stream is back: a keyframe and more frames
  await fsp.appendFile(`${path}.idx`, Buffer.concat(all.slice(250).flatMap((f, i) => (f.isKey ? [rowOf(offs[250 + i], f.ts)] : []))))
  await fsp.appendFile(path, Buffer.concat(all.slice(250).map((f) => f.buf)))
  await r.refresh()
  const g4 = await r.gop(4)
  got.push(...g4.slice(49), ...(await r.gop(5)))
  const hole = typeof r.holeAfter === 'function' ? r.holeAfter(4) : undefined
  await r.markClosed(all.at(-1).ts)
  got.push(...(await r.gop(6)))
  await r.close()
  const worst = Math.max(...got.map((f, i) => Math.abs(f.ts - all[i].ts)))
  check('growing file, a stall in its newest GOP: 249 frames handed out before, then the rest in order', handed === 249 && !compare(got, all), compare(got, all) || `${handed} handed out`)
  check('growing file, a stall in its newest GOP: the frame held back keeps the step (not half-way into the silence)', worst < 1, `worst ${worst.toFixed(1)} ms`)
  check('growing file, a stall in its newest GOP: holeAfter(4) from its last frame to the next keyframe', hole && Math.abs(hole.fromMs - all[249].ts) < 1 && Math.abs(hole.toMs - all[250].ts) < 1, J(hole))
}

// ---- GOP collapse after catch-up bursts (files recorded with arrival-time .idx rows) ----------------------------
// After a stall the NVR sends what it buffered in a burst, so a GOP's keyframe row can arrive milliseconds before the
// next one. Every GOP must still last at least its frames x the camera's frame step: the time comes out of the hole
// before it (the burst's frames were captured before they arrived), never by squeezing frames into a few ms.
/** A hand-made file: GOPs of counts[k] frames, keyframe rows at rowTs[k]; returns its frames read back and the reader. */
async function burstFile(name, counts, rowTs, { endMs, nextStartMs = null, prevEndMs = null, seed = 40, dir = mkdtempSync(join(tmpdir(), 'recr-collapse-')) } = {}) {
  const rnd = prng(seed)
  const frames = counts.flatMap((n, k) => Array.from({ length: n }, (_, i) => ({ buf: i ? h264.p(rnd, 200) : h264.key(rnd, 1200), isKey: i === 0, ts: rowTs[k] })))
  const offs = offsetsOf(frames.map((f) => f.buf))
  const rows = []
  let at = 0
  counts.forEach((n, k) => (rows.push({ offset: offs[at], tsMs: rowTs[k] }), (at += n)))
  const { path } = writeSeg(dir, name, frames, { rows })
  const r = await new SegmentReader({ path, endMs, nextStartMs, prevEndMs }).open()
  const got = []
  const perGop = []
  for (let k = 0; k < r.rows.length; k++) {
    const g = await r.gop(k)
    perGop.push(g)
    got.push(...g)
  }
  await r.close()
  return { r, got, perGop, frames }
}
/** The smallest frame step in each GOP (the step to the next GOP's keyframe included). */
const minSteps = (perGop) => perGop.map((g, k) => {
  const ts = [...g.map((f) => f.ts), ...(perGop[k + 1]?.[0] ? [perGop[k + 1][0].ts] : [])]
  return Math.min(...ts.slice(1).map((t, i) => t - ts[i]))
})
{
  // Drive Way 20-31.h264: 20 fps, 40-frame GOPs; a 2.2 s stall, then GOP 12's 40 frames arrived in 418 ms
  const t0 = Date.UTC(2026, 8, 24, 20, 31, 0)
  const d = [0]
  for (let k = 1; k < 30; k++) d.push(d[k - 1] + (k === 12 ? 4182 : k === 13 ? 418 : k === 14 ? 1443 : 2000))
  const rowTs = d.map((v) => t0 + v)
  const counts = rowTs.map(() => 40)
  const { got, perGop, frames } = await burstFile('20-31.h264', counts, rowTs, { endMs: rowTs.at(-1) + 39 * 50 })
  const ms = minSteps(perGop)
  const worst = Math.min(...ms)
  check('Drive Way burst (arrival .idx): every frame read back', got.length === frames.length && !compare(got, frames))
  // (the key time fit may smear up to ~1% over the steady run after the burst: the measured step is then 49.7 ms)
  check('Drive Way burst: no GOP squeezed: every frame step within 2% of the camera\'s 50 ms or more', worst >= 49,`smallest ${worst.toFixed(2)} ms in GOP ${ms.indexOf(worst)}; GOP 12 ${ms[12].toFixed(2)} ms`)
  check('Drive Way burst: GOP 12 lasts its 40 frames x ~50 ms (2 s), taken from the stall before it', perGop[13][0].ts - perGop[12][0].ts >= 1960 && Math.abs(perGop[14][0].ts - rowTs[14]) < 300, `${(perGop[13][0].ts - perGop[12][0].ts).toFixed(1)} ms`)
  check('Drive Way burst: times strictly increasing', got.every((f, i) => i === 0 || f.ts > got[i - 1].ts))
}
{
  // Cashier Front 17-58.h264: 30 fps, GOPs of 60/30/14 frames; GOPs 7 and 8 (120 frames) arrived 1 ms apart after a stall
  const t0 = Date.UTC(2026, 8, 24, 17, 58, 0)
  const counts = [60, 60, 60, 60, 30, 30, 14, 60, 60, 60, 60, 60, 60]
  const step = 1000 / 30
  const cap = [0]
  for (let k = 1; k < counts.length; k++) cap.push(cap[k - 1] + counts[k - 1] * step)
  const rowTs = cap.map((c) => Math.round(t0 + c))
  rowTs[7] = rowTs[9] - 3 // both burst GOPs' keyframes arrive just before GOP 9's
  rowTs[8] = rowTs[9] - 2
  const { got, perGop, frames } = await burstFile('17-58.h264', counts, rowTs, { endMs: rowTs.at(-1) + 59 * step })
  const ms = minSteps(perGop)
  const worst = Math.min(...ms)
  check('Cashier Front burst (GOPs of 60/30/14): every frame read back', got.length === frames.length && !compare(got, frames))
  check('Cashier Front burst: no GOP squeezed: every frame step >= the camera\'s 33.3 ms', worst >= step - 0.01, `smallest ${worst.toFixed(2)} ms in GOP ${ms.indexOf(worst)}: ${J(ms.map((v) => +v.toFixed(1)))}`)
  check('Cashier Front burst: the 14-frame GOP keeps 30 fps', Math.abs(perGop[6][1].ts - perGop[6][0].ts - step) < 0.5, `${(perGop[6][1].ts - perGop[6][0].ts).toFixed(2)} ms`)
}
{
  // a restarted stream: the NVR replays its prebuffer, 73 frames arrive in 86 ms at the start of the file
  const t0 = Date.UTC(2026, 8, 24, 21, 37, 30)
  const counts = [73, 60, 60, 60, 60, 60]
  const step = 1000 / 30
  const rowTs = [t0, t0 + 86, t0 + 86 + 2000, t0 + 86 + 4000, t0 + 86 + 6000, t0 + 86 + 8000]
  const prevEndMs = t0 - 20_000
  const { r, got, perGop } = await burstFile('21-37-2.h264', counts, rowTs, { endMs: rowTs.at(-1) + 59 * step, prevEndMs })
  const worst = Math.min(...minSteps(perGop))
  check('prebuffer burst at a file\'s start: no frame step under 33.3 ms', worst >= step - 0.01, `smallest ${worst.toFixed(2)} ms`)
  check('prebuffer burst at a file\'s start: its frames go before the burst (after the previous file\'s end); the rest keep their times', r.times[0] < t0 && r.times[0] > prevEndMs && Math.abs(r.times[1] - rowTs[1]) < 1 && got.length === 373, `times[0] ${(r.times[0] - t0).toFixed(0)} ms`)
}

{
  // Cashier Front 21-37-2.h264: a restart file of only the replayed prebuffer, 60 + 13 frames arriving in 85 ms,
  // 177 ms after the file before ended; the camera's step comes from the file before (same folder)
  const dir = mkdtempSync(join(tmpdir(), 'recr-restart-'))
  const t0 = Date.UTC(2026, 8, 24, 21, 37, 1)
  const step = 1000 / 30
  const before = Array.from({ length: 25 }, (_, k) => t0 + Math.round(k * 60 * step))
  await burstFile('21-37.h264', before.map(() => 60), before, { endMs: before.at(-1) + 59 * step, dir })
  const s0 = before.at(-1) + 60 * step + 177
  const { got, perGop } = await burstFile('21-37-2.h264', [60, 13], [s0, s0 + 71], { endMs: s0 + 85, prevEndMs: s0 - 177, dir })
  const worst = Math.min(...minSteps(perGop))
  check('a short restart file (prebuffer only, 2 GOPs in 85 ms): no frame step under the camera\'s 33.3 ms', got.length === 73 && worst >= step - 0.01, `smallest ${worst.toFixed(2)} ms`)
}

// ---- minute joins: the last GOP keeps the camera's step and runs up to the next file's first keyframe ------------------
// The keyframes are large and arrive ~250 ms after capture, P-frames ~10 ms: endMs (the last P-frame's arrival) is
// ~240 ms before the next file's keyframe. Squeezing the last GOP to end at endMs gave a 1.15-1.25x speed-up and then
// a still at every minute; a shared ms stamp lost a frame.
{
  const t0 = Date.UTC(2026, 8, 24, 23, 52, 0)
  const step = 50
  const capA = Array.from({ length: 30 }, (_, k) => t0 + k * 2000)
  const lastCap = capA.at(-1) + 39 * step
  const nextStartMs = lastCap + step + 250 // the next file's first keyframe: captured one step later, arrived 250 ms after
  const a = await burstFile('23-52.h264', capA.map(() => 40), capA.map((c) => c + 250), { endMs: lastCap + 10, nextStartMs })
  const last = a.perGop.at(-1)
  const steps = last.slice(1).map((f, i) => f.ts - last[i].ts)
  const join = nextStartMs - last.at(-1).ts
  check('minute join: the last GOP keeps the 50 ms step (no speed-up to reach endMs)', steps.every((s) => Math.abs(s - step) < 0.5), J(steps.map((s) => +s.toFixed(2))))
  check('minute join: the next file\'s first frame comes one step after the last (no still, no shared stamp)', Math.abs(join - step) < 0.5, `${join.toFixed(2)} ms`)
  check('minute join: no hole reported at the end of the file', a.r.holeAfter(29) === null)
  // the next file's keyframe arrived 120 ms early relative to this file's keys: the last GOP runs a little fast to meet it
  const b = await burstFile('23-53.h264', capA.map(() => 40), capA.map((c) => c + 250), { endMs: lastCap + 10, nextStartMs: nextStartMs - 120 })
  const lb = b.perGop.at(-1)
  const sb = lb.slice(1).map((f, i) => f.ts - lb[i].ts)
  const jb = nextStartMs - 120 - lb.at(-1).ts
  check('minute join, next key 120 ms early: evenly spaced into it (step within 7%)', sb.every((s) => Math.abs(s - sb[0]) < 0.01) && Math.abs(jb - sb[0]) < 0.01 && sb[0] > 0.9 * step, `step ${sb[0].toFixed(2)}, join ${jb.toFixed(2)}`)
  // a real gap after the file (the next one starts 10 s later): the camera's step, then the hole
  const c = await burstFile('23-54.h264', capA.map(() => 40), capA.map((c) => c + 250), { endMs: lastCap + 10, nextStartMs: nextStartMs + 10_000 })
  const lc = c.perGop.at(-1)
  check('minute join, next file 10 s later: the last GOP keeps the 50 ms step', lc.slice(1).every((f, i) => Math.abs(f.ts - lc[i].ts - step) < 0.5))
}

// ---- speed: splitting a 30 MB segment ---------------------------------------------------------------------
{
  const rnd = prng(10)
  const bufs = []
  let total = 0
  for (let i = 0; total < 30 << 20; i++) {
    const b = i % 25 === 0 ? h264.key(rnd, 400_000) : h264.p(rnd, 60_000 + Math.floor(rnd() * 80_000), { slices: i % 3 === 0 ? 2 : 1 })
    bufs.push(b)
    total += b.length
  }
  const buf = Buffer.concat(bufs)
  const offs = offsetsOf(bufs)
  const keyOffsets = new Set(offs.filter((o, i) => i % 25 === 0))
  splitUnits(buf.subarray(0, 1 << 20), CODEC.h264) // warm up
  const t = performance.now()
  const { units } = splitUnits(buf, CODEC.h264, { keyOffsets })
  const ms = performance.now() - t
  console.log(`      splitting ${(buf.length / 1048576).toFixed(1)} MB (${units.length} frames) took ${ms.toFixed(1)} ms`)
  check('speed: splitting a 30 MB segment takes under 300 ms', ms < 300 && !sameUnits(units, bufs), `${ms.toFixed(1)} ms`)
}

/**
 * The reference splitter for the real clip, written apart from rec-reader.mjs: all start codes
 * first, then NAL types grouped into frames by the same rules (a new frame at the first "starts
 * a frame" NAL or first slice after a picture's slice). isKey from the NAL types.
 */
function refSplit(buf) {
  const nals = []
  for (let i = 2; i < buf.length; i++) {
    if (buf[i] !== 1 || buf[i - 1] !== 0 || buf[i - 2] !== 0) continue
    const lo = nals.length ? nals.at(-1).hdr + 1 : 0
    const s = i - 3 >= lo && buf[i - 3] === 0 ? i - 3 : i - 2
    if (i + 3 >= buf.length) break
    nals.push({ s, hdr: i + 1 })
  }
  const h0 = buf[nals[0].hdr]
  const hevc = [32, 33, 34, 35, 39].includes((h0 >> 1) & 0x3f) && (h0 & 0x81) === 0
  const frames = []
  let cur = null
  let pic = false
  for (let n = 0; n < nals.length; n++) {
    const h = nals[n].hdr
    let t, vcl, key, starts, first
    if (hevc) {
      t = (buf[h] >> 1) & 0x3f
      vcl = t < 32
      key = t >= 16 && t <= 21
      starts = (t >= 32 && t <= 35) || t === 39 || (t >= 41 && t <= 44) || (t >= 48 && t <= 55)
      first = vcl && buf[h + 2] >= 0x80
    } else {
      t = buf[h] & 0x1f
      vcl = t >= 1 && t <= 5
      key = t === 5
      starts = (t >= 6 && t <= 9) || (t >= 14 && t <= 18)
      first = vcl && buf[h + 1] >= 0x80
    }
    if (!cur || (pic && (starts || first))) {
      cur = { s: nals[n].s, isKey: false }
      frames.push(cur)
      pic = false
    }
    if (key) cur.isKey = true
    if (vcl) pic = true
  }
  const out = frames.map((f, j) => ({ buf: buf.subarray(f.s, j + 1 < frames.length ? frames[j + 1].s : buf.length), isKey: f.isKey }))
  out.codec = hevc ? 'h265' : 'h264'
  return out
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
