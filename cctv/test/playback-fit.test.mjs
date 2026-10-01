// A remote viewer's NVR main stream is fitted to the tunnel (playback.mjs PlaybackSession #fitDecide; the
// playback hunt of 1 Oct 2026, finding F6: the NVR's main stream went through the tunnel as it was, 6.3
// Mbit/s measured, 3-50 frames a second with 3 gaps over 1 s). Here: the session's converter has
// PLAYBACK_LIMITS (1920 wide, 2.5 Mbit/s) and the decoder's frame threads; H.264 goes through it too; a
// camera known to record within the cap is sent as it is; with no conversion to spare the viewer is told
// and gets the NVR's stream; a leg converts in the slot its server playback lends it; the sub-stream and
// the local network are untouched; and a converter's start is not followed by a rush.
// Fake NVRs whose lane answers each SDK job without running it (as playback-hd-switch.test.mjs): nothing
// reaches an NVR, but playback.mjs loads koffi, so this runs on the server copy. No ffmpeg: a stand-in.
//   node cctv/test/playback-fit.test.mjs        (on the server copy)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pb-fit-'))
const pb = await import('../playback.mjs')
const { TranscodePool, PLAYBACK_LIMITS, CODEC_H264, CODEC_H265 } = await import('../transcode.mjs')
const { playFrames } = await import('../sdk.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const J = JSON.stringify

const routes = new Map()
const realClaim = playFrames.claim.bind(playFrames)
playFrames.claim = (h, fn) => {
  routes.set(h, fn)
  realClaim(h, fn)
}
// Annex B openings sdk.mjs sniffCodec knows: an H.264 SPS, an H.265 VPS; a delta frame has neither
const KEY264 = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x28]), Buffer.alloc(40, 7)])
const KEY265 = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x40, 0x01, 0x0c, 0x01]), Buffer.alloc(40, 7)])
const DELTA = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x41, 0x9a]), Buffer.alloc(40, 9)])
/** Hands the session with handle h one frame as the NVR would (the SDK's playback route). */
const frame = (h, tsMs, key, buf = key ? KEY264 : DELTA) => routes.get(h)({ frameType: 1, length: buf.length, keyFrame: key ? 1 : 0, width: 3840, height: 2160, time: Math.round(tsMs * 1000) }, buf)
/** n frames 50 ms apart from t0, a keyframe every `gop`, all at once (the NVR sends faster than they play). */
const burst = (h, t0, n, { gop = 20, key = KEY264, from = 0 } = {}) => {
  for (let i = from; i < from + n; i++) frame(h, t0 + i * 50, i % gop === 0, i % gop === 0 ? key : DELTA)
}

let handles = 500
/** A fake NVR whose lane answers each job without running it: the clock, PlayBackByTimeEx (the handle), then true. */
const fakeNvr = (id, opts) => {
  const handle = ++handles
  const answers = [true, handle]
  let n = 0
  const nvr = { id, name: `NVR ${id}`, userId: 7, online: true, degraded: false, handle, controls: 0 }
  nvr.lane = {
    run: async () => {
      const k = n++
      if (k >= 3) nvr.controls++
      return k < answers.length ? answers[k] : true
    }
  }
  nvr.sessions = { acquire: async () => ({ userId: 9, release() {} }) }
  nvr.playback = pb.createPlayback(nvr, opts)
  return nvr
}
/** A fake browser WebSocket: the JSON and the frames it is sent (with their arrival). */
const fakeWs = () => {
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, texts: [], bins: [], closedWith: null, handlers: {} }
  ws.send = (m) => {
    if (typeof m === 'string') return ws.texts.push(JSON.parse(m))
    ws.bins.push({ at: performance.now(), key: (m[0] & 1) === 1, codec: m[1], w: m.readUInt16LE(2), ts: Number(m.readBigInt64LE(8)) / 1000, body: Buffer.from(m.subarray(16)) })
  }
  ws.on = (event, fn) => (ws.handlers[event] = fn)
  ws.close = (code, reason) => {
    if (ws.readyState !== 1) return
    ws.readyState = 3
    ws.closedWith = { code, reason }
    ws.handlers.close?.()
  }
  ws.command = (obj) => ws.handlers.message(Buffer.from(J(obj)), false)
  return ws
}
/**
 * A stand-in for the conversion: what it was asked, what it was handed. Each picture comes back at once
 * marked 0xaa, unless firstMs: then the first picture takes that long, `keeps` pictures stay inside (as
 * ffmpeg's parser and second decoder thread keep them), and the rest are worked off at 1.5x real time.
 */
const fakeXcode = (rec, { firstMs = 0, keeps = 2 } = {}) => (o) => {
  const x = { opts: o, inCodec: o.inCodec, pushed: [], keys: [], low: [], perS: [], ends: 0, resets: 0, closes: 0, codecs: [] }
  let inside = []
  let readyAt = 0
  let timer = null
  const pump = () => {
    timer = null
    while (inside.length > keeps && performance.now() >= readyAt) {
      const f = inside.shift()
      readyAt = Math.max(readyAt, performance.now() - 200) + 50 / 1.5
      o.onFrame(f.ts, f.isKey, Buffer.from([0xaa]))
    }
    if (inside.length > keeps) timer = setTimeout(pump, 5)
  }
  x.push = (ts, isKey) => {
    if (x.pushed.length === x.startAt) readyAt = performance.now() + firstMs
    x.pushed.push(ts)
    x.keys.push(isKey)
    x.codecs.push(x.inCodec)
    x.low.push(typeof o.lowDelay === 'function' ? o.lowDelay() : o.lowDelay)
    x.perS.push(typeof o.picturesPerS === 'function' ? o.picturesPerS() : o.picturesPerS)
    if (!firstMs) return o.onFrame(ts, isKey, Buffer.from([0xaa]))
    inside.push({ ts, isKey })
    if (!timer) timer = setTimeout(pump, 5)
  }
  x.startAt = 0
  x.endPicture = () => x.ends++
  x.reset = () => {
    x.resets++
    inside = []
    x.startAt = x.pushed.length
  }
  x.close = () => {
    x.closes++
    inside = []
    clearTimeout(timer)
  }
  rec.push(x)
  return x
}
const until = async (pred, ms) => {
  const t = Date.now()
  while (!pred() && Date.now() - t < ms) await sleep(10)
  return pred()
}
const START = Date.now() - 3_600_000
/** Opens a session and waits for it to have started. */
const open = async (id, { opts, fit, main = true, q = '' } = {}) => {
  const xs = []
  const logs = []
  const pool = opts?.pool ?? new TranscodePool(2)
  const nvr = fakeNvr(id, { makeTranscoder: fakeXcode(xs, opts?.xcode), pool, log: (l) => logs.push(l) })
  const ws = fakeWs()
  const conn = { main, allowMain: () => true }
  if (fit !== undefined) conn.fit = fit
  nvr.playback.connect(ws, new URL(`ws://x/playback?nvr=${id}&ch=0&start=${START}${q}`), conn)
  await until(() => ws.texts.some((m) => m.type === 'started'), 3000)
  return { nvr, ws, xs, logs, pool, h: nvr.handle }
}
const fits = (ws) => ws.texts.filter((m) => m.type === 'fit')

// ---- a remote viewer, the main stream, H.264, the camera's rate not known: converted -----------------
{
  const { ws, xs, pool, h, logs } = await open('fit-remote', { fit: {} })
  burst(h, START, 30)
  await sleep(400)
  const o = xs[0]?.opts ?? {}
  check('remote, main: the session starts a Transcoder with maxKbps 2500, maxWidth 1920 and a 1 s buffer (PLAYBACK_LIMITS)', xs.length === 1 && o.maxKbps === 2500 && o.maxWidth === 1920 && o.bufSeconds === PLAYBACK_LIMITS.bufSeconds, `${xs.length} transcoders; ${J({ maxKbps: o.maxKbps, maxWidth: o.maxWidth, bufSeconds: o.bufSeconds })}`)
  check('... reading H.264 (the NVR\'s H.264 goes through it too), with the decoder\'s frame threads (lowDelay false) and the stream\'s own times', xs[0]?.inCodec === CODEC_H264 && xs[0].low.length > 0 && xs[0].low.every((v) => v === false) && xs[0].perS.every((v) => v === 0), J({ c: xs[0]?.inCodec, low: xs[0]?.low.slice(0, 3), perS: xs[0]?.perS.slice(0, 3) }))
  check('... the viewer is told: {type:"fit", on:true}, once', J(fits(ws)) === J([{ type: 'fit', on: true }]), J(fits(ws)))
  check('... a slot of the playback pool is held', pool.active === 1, String(pool.active))
  check('... nothing of the NVR\'s own stream reaches the socket: converted pictures only, H.264, no size in the header', ws.bins.length > 0 && ws.bins.every((b) => b.body.length === 1 && b.body[0] === 0xaa && b.codec === CODEC_H264 && b.w === 0), `${ws.bins.length} frames, ${ws.bins.filter((b) => b.body[0] !== 0xaa).length} unconverted`)
  check('... each with the capture time of the frame it was made from, in order, starting on the keyframe', ws.bins[0]?.key && ws.bins.every((b, i) => Math.abs(b.ts - (START + i * 50)) < 0.01), ws.bins.slice(0, 4).map((b) => b.ts - START).join())
  check('... logged', logs.some((l) => /remote viewer/.test(l) && /2500 kbit/.test(l)), logs.join(' | '))
  ws.close(1000)
  check('... closed: the converter is closed and the slot given back', xs[0]?.closes === 1 && pool.active === 0, `${xs[0]?.closes} ${pool.active}`)
}

// ---- the local network: exactly as before ------------------------------------------------------------
{
  const { ws, xs, pool, h } = await open('fit-local', {})
  burst(h, START, 30)
  await sleep(400)
  check('local, main: no Transcoder (no maxKbps anywhere), no slot, no {type:"fit"}', xs.length === 0 && pool.active === 0 && fits(ws).length === 0, `${xs.length} ${pool.active} ${J(fits(ws))}`)
  check('... the NVR\'s frames as they came: its bytes, its size in the header', ws.bins.length > 0 && ws.bins.every((b) => b.w === 3840 && b.body.length > 1) && ws.bins[0].body.equals(KEY264), `${ws.bins.length} frames`)
  ws.close(1000)
}
{
  // a browser without H.265 on the local network: converted as before, with no cap
  const { ws, xs, pool, h } = await open('fit-local-265', { q: '&h265=0' })
  burst(h, START, 10, { key: KEY265 })
  await sleep(300)
  check('local, H.265 for a browser without it: converted as before (no maxKbps, no maxWidth, lowDelay not asked)', xs.length === 1 && xs[0].opts.maxKbps === undefined && xs[0].opts.maxWidth === undefined && xs[0].opts.lowDelay === undefined && xs[0].inCodec === CODEC_H265 && pool.active === 1 && fits(ws).length === 0, J({ n: xs.length, k: xs[0]?.opts.maxKbps, w: xs[0]?.opts.maxWidth }))
  ws.close(1000)
}

// ---- the sub-stream is never fitted ------------------------------------------------------------------
{
  const { ws, xs, pool, h } = await open('fit-sub', { fit: {}, main: false })
  burst(h, START, 20)
  await sleep(300)
  check('remote, the sub-stream: not converted, nothing said', xs.length === 0 && pool.active === 0 && fits(ws).length === 0 && ws.bins.length > 0 && ws.bins[0].w === 3840, `${xs.length} ${J(fits(ws))}`)
  ws.close(1000)
}

// ---- a camera known to record within the cap: sent as it is, until a faster speed takes it over -------
{
  const { ws, xs, pool, h } = await open('fit-fits', { fit: { kbps: 1200 } })
  burst(h, START, 20)
  await sleep(300)
  check('remote, a camera recording 1200 kbit/s: sent as it is, {type:"fit", on:false, fits:true}, no slot', xs.length === 0 && pool.active === 0 && J(fits(ws)) === J([{ type: 'fit', on: false, fits: true }]) && ws.bins.length > 0 && ws.bins[0].w === 3840, `${xs.length} ${J(fits(ws))}`)
  ws.command({ speed: 4 }) // 4800 kbit/s of link
  await sleep(50)
  const before = ws.bins.length
  burst(h, START, 60, { from: 20 })
  await until(() => xs.length === 1 && xs[0].pushed.length >= 2, 3000)
  check('... at 4x (4.8 Mbit/s of link): converted from the next keyframe, and said', xs.length === 1 && pool.active === 1 && J(fits(ws).at(-1)) === J({ type: 'fit', on: true }), `${xs.length} ${J(fits(ws))}`)
  check('... keyframes only, one picture at a time (low_delay, ended each), stamped 8 a second', xs[0]?.keys.every((k) => k === true) && xs[0].low.every((v) => v === true) && xs[0].perS.every((v) => v === 8) && xs[0].ends === xs[0].pushed.length, J({ keys: xs[0]?.keys, low: xs[0]?.low, perS: xs[0]?.perS, ends: xs[0]?.ends }))
  check('... and nothing unconverted after it', ws.bins.slice(before).filter((b) => b.w === 3840).every((b) => b.ts < (xs[0]?.pushed[0] ?? -1)), '')
  ws.close(1000)
  check('... the slot given back on close', pool.active === 0)
}

// ---- no conversion to spare: said, and the NVR's stream as it is -------------------------------------
{
  const pool = new TranscodePool(2)
  const other = pool.acquire() // another viewer's conversion
  const { ws, xs, h, logs } = await open('fit-busy', { fit: {}, opts: { pool } })
  burst(h, START, 20)
  await sleep(300)
  check('pool busy (1 of 2 running: the last is kept for H.265 a browser cannot decode): {type:"fit", on:false, busy:true}', J(fits(ws)) === J([{ type: 'fit', on: false, busy: true }]), J(fits(ws)))
  check('... the NVR\'s stream goes as it is; no Transcoder, the last slot still free, the socket open', xs.length === 0 && pool.active === 1 && ws.closedWith === null && ws.bins.length > 0 && ws.bins.every((b) => b.w === 3840), `${xs.length} ${pool.active} ${ws.bins.length}`)
  check('... logged', logs.some((l) => /no conversion to spare/.test(l)), logs.join(' | '))
  ws.close(1000)
  // H.265 for a browser that cannot decode it needs the slot anyway: it takes the last one, capped
  const b = await open('fit-busy-265', { fit: {}, opts: { pool }, q: '&h265=0' })
  burst(b.h, START, 20, { key: KEY265 })
  await sleep(300)
  check('... H.265 for a remote browser without it takes the last slot, and is capped too', b.xs.length === 1 && b.xs[0].opts.maxKbps === 2500 && b.xs[0].inCodec === CODEC_H265 && pool.active === 2 && J(fits(b.ws)) === J([{ type: 'fit', on: true }]), `${b.xs.length} ${pool.active} ${J(fits(b.ws))}`)
  b.ws.close(1000)
  other.release()
  check('... slots all given back', pool.active === 0, String(pool.active))
}

// ---- a leg: the slot its server playback lends -------------------------------------------------------
{
  const pool = new TranscodePool(2)
  const lent = pool.acquire() // the server playback's, held for its session
  const { ws, xs, h } = await open('fit-lent', { fit: { slot: lent }, opts: { pool } })
  burst(h, START, 20)
  await sleep(300)
  check('a lent slot: converted within the cap, no slot of its own taken, nothing said (the server playback said it)', xs.length === 1 && xs[0].opts.maxKbps === 2500 && pool.active === 1 && fits(ws).length === 0 && ws.bins.every((b) => b.body[0] === 0xaa), `${xs.length} ${pool.active} ${J(fits(ws))}`)
  ws.close(1000)
  check('... closed: its converter closed, the lender\'s slot not given back by the leg', xs[0]?.closes === 1 && pool.active === 1, `${xs[0]?.closes} ${pool.active}`)
  lent.release()
}

// ---- a converter's start is not followed by a rush ---------------------------------------------------
{
  const { ws, xs, h } = await open('fit-start', { fit: {}, opts: { xcode: { firstMs: 800 } } })
  burst(h, START, 120) // 6 s of footage, handed over at once as the NVR does
  await sleep(4000)
  const first = ws.bins[0]
  const ahead = ws.bins.map((b) => b.ts - first.ts - (b.at - first.at))
  const worst = Math.max(...ahead)
  check('a converter whose first picture takes 800 ms: from the first picture on, no frame more than 150 ms ahead of its time', ws.bins.length > 40 && worst <= 150, `${ws.bins.length} frames, worst ${worst.toFixed(0)} ms ahead`)
  const sec = [0, 1, 2].map((s) => ws.bins.filter((b) => b.at - first.at >= s * 1000 && b.at - first.at < (s + 1) * 1000).length)
  check('... 20 frames a second from the first (18-23 counted)', sec.every((n) => n >= 18 && n <= 23), sec.join())
  check('... no frame invented or lost: every frame handed in comes out once, in order', ws.bins.every((b, i) => Math.abs(b.ts - (START + i * 50)) < 0.01) && xs[0].pushed.length >= ws.bins.length, '')
  ws.close(1000)
}

// ---- fitted, a change of speed: another converter from the next keyframe -----------------------------
{
  const { ws, xs, h, pool } = await open('fit-speed', { fit: {} })
  burst(h, START, 20)
  await sleep(300)
  ws.command({ speed: 2 })
  await sleep(50)
  burst(h, START, 100, { from: 20 })
  await until(() => xs[0]?.resets === 1 && xs[0].pushed.length - xs[0].startAt >= 2, 4000)
  const after = xs[0].keys.slice(xs[0].startAt)
  check('fitted, to 2x: the converter starts again on the next keyframe; keyframes only from there, low_delay, 8 a second', xs.length === 1 && xs[0].resets === 1 && after.length > 0 && after.every((k) => k) && xs[0].low.at(-1) === true && xs[0].perS.at(-1) === 8 && pool.active === 1, J({ resets: xs[0].resets, after, low: xs[0].low.at(-1) }))
  ws.close(1000)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
