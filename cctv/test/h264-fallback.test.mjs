// Tests H.265 sub-streams converted to H.264 for local PCs whose browsers cannot play them
// (h264-fallback.mjs): the encoder ladder, the change of step at a keyframe, the shared conversion
// and its budget. Fake converters and a fake ffmpeg process: nothing here needs ffmpeg or the SDK.
//   node cctv/test/h264-fallback.test.mjs
import { EventEmitter } from 'node:events'
import {
  BUF_SECONDS, DEFAULT_CORES, DEFAULT_MAX, ENCODER_THREADS, FAILED, FAILED_QUIET_MS, H264Fallback, HANDOVER_MS, KEY_SECONDS, LADDER, NO_ROOM,
  STEP_UP_SPARE, SteppedTranscoder, budgetUnits, capacity, maxFallbacks, stepFor
} from '../h264-fallback.mjs'
import { PhoneLive, encodeFrame, parseFrame } from '../phone-live.mjs'
import { StreamHub } from '../stream-hub.mjs'
import { CODEC_H264, CODEC_H265, CRF, PRESET, PRESETS, TranscodePool, Transcoder, ffmpegArgs } from '../transcode.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// (a short linger on the camera's own streams: the hub's timers would keep this process alive for minutes)
const mkHub = () => new StreamHub('n1', () => {}, { stopDelayMs: { 0: 5, 1: 5 } })

// ---- the budget, from the environment ----
check('the budget is 2 cores and 24 conversions unless said otherwise', DEFAULT_CORES === 2 && DEFAULT_MAX === 24 && budgetUnits({}) === 200 && maxFallbacks({}) === 24)
check('CCTV_H264_FALLBACK_CORES: cores, fractions too, in units of 1 % of a core', budgetUnits({ CCTV_H264_FALLBACK_CORES: '1.5' }) === 150 && budgetUnits({ CCTV_H264_FALLBACK_CORES: '4' }) === 400)
check('... 0 turns it off', budgetUnits({ CCTV_H264_FALLBACK_CORES: '0' }) === 0 && capacity({ units: 0 }) === 0)
check('... negative, silly, empty or not a number: the default', ['-1', '99', '', '  ', 'lots', 'NaN', 'Infinity'].every((v) => budgetUnits({ CCTV_H264_FALLBACK_CORES: v }) === 200))
check('CCTV_H264_FALLBACK_MAX: a whole number of conversions', maxFallbacks({ CCTV_H264_FALLBACK_MAX: '8' }) === 8 && maxFallbacks({ CCTV_H264_FALLBACK_MAX: '0' }) === 0)
check('... negative, fractional, silly or empty: the default', ['-1', '2.5', '100', '', 'many'].every((v) => maxFallbacks({ CCTV_H264_FALLBACK_MAX: v }) === 24))
check('how many fit: the count, or what the budget holds at the last step, whichever is less', capacity({ units: 200, max: 24 }) === 24 && capacity({ units: 200, max: 64 }) === 25 && capacity({ units: 100, max: 24 }) === 12 && capacity({ units: 200, max: 3 }) === 3 && capacity({ units: 7, max: 24 }) === 0)

// ---- the ladder ----
{
  check('the ladder: veryfast, then superfast, then ultrafast, each cheaper than the last', LADDER.map((l) => l.preset).join() === 'veryfast,superfast,ultrafast' && LADDER.every((l, i) => i === 0 || l.cost < LADDER[i - 1].cost))
  check('... every preset one ffmpeg is allowed to be given', LADDER.every((l) => PRESETS.includes(l.preset)))
  check('... near-lossless for a 480p picture at every step (crf 20-21), never worse further down', LADDER.every((l) => l.crf >= 20 && l.crf <= 21) && LADDER.at(-1).crf <= LADDER[0].crf)
  check('... ultrafast, the weaker encoder, has the most bitrate headroom', LADDER.every((l, i) => i === 0 || l.maxKbps > LADDER[i - 1].maxKbps))
  check('... each cost is no less than what was measured on the server (15.1, 11.8, 6.6 % of a core)', LADDER[0].cost >= 15.1 && LADDER[1].cost >= 11.8 && LADDER[2].cost >= 6.6)
  const steps = []
  for (let n = 0; n <= 30; n++) steps.push(stepFor(n, { units: 200 }))
  check('2 cores: veryfast up to 12 running, superfast to 15, ultrafast to 25', steps.slice(0, 13).every((s) => s === 0) && steps.slice(13, 16).every((s) => s === 1) && steps.slice(16, 26).every((s) => s === 2), steps.join(''))
  check('... past what fits, still the last step (the caller refuses)', steps.slice(26).every((s) => s === 2))
  let ok = true
  let mono = true
  for (let units = 0; units <= 800; units += 7) {
    const cap = capacity({ units, max: 64 })
    let last = 0
    for (let n = 0; n <= 70; n++) {
      const s = stepFor(n, { units })
      if (n >= 1 && n <= cap && n * LADDER[s].cost > units) ok = false
      if (s < last) mono = false
      last = s
      // with a step to keep: never over the budget either, and never a better step than the plain one
      for (let cur = 0; cur < LADDER.length; cur++) {
        const h = stepFor(n, { units, current: cur })
        if (n >= 1 && n <= cap && n * LADDER[h].cost > units) ok = false
        if (h < s) ok = false
      }
    }
  }
  check('whatever the budget: n running at the step for n is never over it, for every n that fits', ok)
  check('... and more running never means a better preset', mono)
  check('going down is at once', stepFor(13, { units: 200, current: 0 }) === 1 && stepFor(16, { units: 200, current: 1 }) === 2 && stepFor(16, { units: 200, current: 0 }) === 2)
  check(`back up only with room for ${STEP_UP_SPARE} more at the better step`, stepFor(12, { units: 200, current: 1 }) === 1 && stepFor(11, { units: 200, current: 1 }) === 1 && stepFor(10, { units: 200, current: 1 }) === 0)
  check('... from ultrafast: to superfast at 13, straight to veryfast at 10', stepFor(15, { units: 200, current: 2 }) === 2 && stepFor(14, { units: 200, current: 2 }) === 2 && stepFor(13, { units: 200, current: 2 }) === 1 && stepFor(10, { units: 200, current: 2 }) === 0)
  check('... nothing running: the best step', stepFor(0, { units: 200, current: 2 }) === 0)
  check('a step that is not one (a bad `current`) is ignored', stepFor(13, { units: 200, current: 7 }) === 1 && stepFor(13, { units: 200, current: -1 }) === 1 && stepFor(13, { units: 200, current: 1.5 }) === 1)

  // what ffmpeg is given at each step
  for (const L of LADDER) {
    const a = ffmpegArgs({ encoder: 'libx264', inCodec: CODEC_H265, crf: L.crf, maxKbps: L.maxKbps, bufSeconds: BUF_SECONDS, preset: L.preset, encThreads: ENCODER_THREADS, gop: 30 }).join(' ')
    check(`ffmpeg at ${L.id}: its preset and crf, one encoder thread, zerolatency, no B-frames, no lookahead`, a.includes(`-c:v libx264 -preset ${L.preset} -threads 1 -crf ${L.crf} -tune zerolatency -bf 0 -g 30 `) && !/lookahead|rc-lookahead|-bf [1-9]/.test(a), a)
    check('... the ceiling with its buffer, every frame kept at its own time, nothing scaled', a.includes(`-maxrate ${L.maxKbps}k -bufsize ${L.maxKbps * BUF_SECONDS}k`) && a.includes('-fps_mode passthrough') && !a.includes('-vf') && a.includes('-flags low_delay'), a)
  }
  // everyone else's ffmpeg is what it was: the preset and the encoder's threads are new options
  const plain = ffmpegArgs({ encoder: 'libx264' }).join(' ')
  check('a conversion that asks for neither is unchanged: veryfast, the encoder\'s own threads', plain.includes(`-c:v libx264 -preset ${PRESET} -crf ${CRF} -tune zerolatency -bf 0 -g 50 -pix_fmt yuv420p`) && PRESET === 'veryfast', plain)
  check('... a preset that is not one is the default, never passed to ffmpeg', ['slow; rm -rf', 'placebo', '', null, 5].every((p) => ffmpegArgs({ preset: p }).join(' ').includes('-preset veryfast -crf')))
  check('... encoder threads only as a whole number above 0', [0, -1, 1.5, '1', null].every((t) => !/libx264 -preset \S+ -threads/.test(ffmpegArgs({ encThreads: t }).join(' '))))
  check('... on the GPU neither applies', !/preset|-threads 1/.test(ffmpegArgs({ encoder: 'h264_vaapi', preset: 'ultrafast', encThreads: 1 }).join(' ')))
}

// ---- a converter that follows the ladder (SteppedTranscoder) ----
// a converter that hands back only when told: what is in it is what was pushed and not handed back
function slowMaker() {
  const made = []
  const make = (o) => {
    const x = { o, pushed: [], out: 0, closed: false, ended: 0, resets: 0,
      get pending() { return this.pushed.length - this.out },
      push(ts, k) { this.pushed.push([ts, k]) },
      give(n = 1) { for (let i = 0; i < n && this.out < this.pushed.length; i++) { const [ts, k] = this.pushed[this.out++]; if (!this.closed) o.onFrame(ts, k, Buffer.from([made.indexOf(this)])) } },
      endPicture() { this.ended++ }, reset() { this.resets++; this.pushed = []; this.out = 0 }, close() { this.closed = true } }
    made.push(x)
    return x
  }
  return { made, make }
}
{
  const { made, make } = slowMaker()
  let step = 0
  const out = []
  const timers = []
  const moved = []
  let closedTold = 0
  const base = { inCodec: CODEC_H265, keepEvery: 1, gop: 30, crf: 25, maxKbps: 700, onFrame: (ts, k, b) => out.push([ts, k, b[0]]) }
  const x = new SteppedTranscoder(base, { step: () => step, make, onStep: (i) => moved.push(i), onClose: () => closedTold++, setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t }, clearTimer: (t) => { if (t) t.cleared = true } })
  check('made with the step\'s settings, not the caller\'s crf and ceiling: veryfast crf 21, one encoder thread', made.length === 1 && made[0].o.preset === 'veryfast' && made[0].o.crf === 21 && made[0].o.maxKbps === 3000 && made[0].o.encThreads === 1)
  check('... the rest as asked (codec in, every frame, the keyframe interval)', made[0].o.inCodec === CODEC_H265 && made[0].o.keepEvery === 1 && made[0].o.gop === 30)
  x.push(0, true); x.push(67, false); x.push(133, false)
  made[0].give(1)
  check('pictures go straight out', out.length === 1 && out[0][0] === 0 && x.pending === 2)
  step = 1
  x.push(200, false)
  check('the step changed: nothing moves between keyframes', made.length === 1 && made[0].pushed.length === 4)
  made[0].give(1) // 67 out; 133 and 200 still in it
  x.push(267, true)
  check('at the camera\'s next keyframe a new converter starts on the new step, from that keyframe', made.length === 2 && made[1].o.preset === 'superfast' && made[1].o.crf === 21 && made[1].pushed.length === 1 && made[1].pushed[0][0] === 267 && made[0].pushed.length === 4 && moved.join() === '1')
  check('... the old one is told its last picture is whole, and is not killed yet', made[0].ended === 1 && !made[0].closed && timers.length === 1 && timers[0].ms > 0)
  x.push(333, false)
  made[1].give(2)
  check('... the new one\'s pictures wait while the old one hands back', out.length === 2 && out.at(-1)[0] === 67)
  made[0].give(1) // 133: all but its last picture
  check('... then go out in order, after the old one\'s: 0 67 133 | 267 333', out.map((o) => o[0]).join() === '0,67,133,267,333' && out[3][1] === true && out[3][2] === 1, out.map((o) => o[0]).join())
  check('... and the old ffmpeg is killed, its timer cleared', made[0].closed && timers[0].cleared)
  x.push(400, false)
  made[1].give(1)
  check('... from there straight out again', out.at(-1)[0] === 400)
  // an old converter that never hands back: the timer ends the wait
  step = 2
  x.push(467, false); x.push(533, false) // two pictures in it that it never hands back
  x.push(600, true)
  made[2].give(1)
  check('an old converter that hands nothing back: the new pictures wait', made.length === 3 && !made[1].closed && out.at(-1)[0] === 400)
  timers.at(-1).fn()
  check('... for HANDOVER_MS, no longer: the old one is killed and they go out', made[1].closed && out.at(-1)[0] === 600 && out.at(-1)[2] === 2)
  // no second move while one is going on
  step = 0
  x.push(667, false); x.push(733, false)
  x.push(800, true)
  check('a step back up moves at the next keyframe too', made.length === 4 && made[3].o.preset === 'veryfast' && !made[2].closed)
  step = 1
  x.push(867, true)
  check('... but never a second move while the last one is still handing over', made.length === 4 && made[3].pushed.length === 2)
  x.reset()
  check('reset (fell behind): the old one is killed, the held pictures dropped, the new one reset', made[2].closed && made[3].resets === 1 && !made[3].closed)
  step = 2
  x.push(933, false); x.push(1000, false)
  x.push(1067, true)
  check('(a move after it, the old one still handing over)', made.length === 5 && !made[3].closed && !made[4].closed)
  x.close()
  check('close kills both, the one being left and the new one', made[3].closed && made[4].closed && x.closed && closedTold === 1)
  const n = out.length
  made[4].give(1)
  x.push(700, true)
  x.close()
  check('... and nothing comes out, starts or is told again', out.length === n && made.length === 5 && closedTold === 1)
}
{
  // a converter with nothing in it yet is simply made again; one that reports no backlog is not waited for
  const { made, make } = slowMaker()
  let step = 0
  const x = new SteppedTranscoder({ onFrame() {} }, { step: () => step, make })
  step = 2
  x.push(0, true)
  check('a step change before its first frame: made again on the new step, nothing to hand over', made.length === 2 && made[0].closed && made[0].ended === 0 && made[1].o.preset === 'ultrafast')
  made[1].give(1)
  step = 1
  x.push(67, true)
  check('one picture or none in the old one: killed at once (its last picture is the one left out)', made.length === 3 && made[1].closed && made[1].ended === 1)
  x.close()
  check('a step out of range is the last step', new SteppedTranscoder({ onFrame() {} }, { step: () => 9, make }).index === LADDER.length - 1)
}

// ---- the real Transcoder under it: every ffmpeg killed on every way out ----
class FakeProc extends EventEmitter {
  constructor() {
    super()
    this.pid = 4242
    this.killed = []
    this.written = []
    this.stdin = Object.assign(new EventEmitter(), { write: (b) => this.written.push(b), end: () => (this.ended = true) })
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
  }
  kill(sig) { this.killed.push(sig) }
}
const nal = (type, ...rest) => Buffer.from([0, 0, 0, 1, type, ...rest])
const IDR = nal(0x65, 0x88, 0x84)
const P = nal(0x41, 0x9a, 0x10)
const procs = []
const realMaker = (o) => new Transcoder({ ...o, platform: 'linux', hasNice: true, hasIonice: true, log: () => {}, spawn: (bin, args) => { const p = new FakeProc(); p.bin = bin; p.args = args; procs.push(p); return p } })
const killed = (p) => p.killed.includes('SIGKILL')
const h265 = (isKey, ts) => encodeFrame(Buffer.from([0, 0, 0, 1, isKey ? 0x26 : 0x02, 1, 2, 3]), isKey, CODEC_H265, ts)
const h264 = (isKey, ts) => encodeFrame(Buffer.from([0, 0, 0, 1, isKey ? 0x65 : 0x41, 1, 2, 3]), isKey, CODEC_H264, ts)
const sock = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], notes: [], handlers: {}, closedWith: null,
  send(b) { if (typeof b === 'string') this.notes.push(JSON.parse(b)); else this.got.push(b) },
  on(e, f) { (this.handlers[e] ??= []).push(f) },
  close(code, reason) { if (this.readyState === 3) return; this.readyState = 3; this.closedWith = { code, reason }; for (const f of this.handlers.close ?? []) f() } })
const channel = () => ({ ...sock(), notice(o) { this.notes.push(o) } })
/** 15 fps of a camera, a keyframe every 30 frames, from frame `from` for `n` frames. */
const feed = (stream, from, n, make = h265) => { for (let i = from; i < from + n; i++) stream.onFrame(make(i % 30 === 0, i * 66.7), i % 30 === 0) }

{
  procs.length = 0
  const logs = []
  const hub = mkHub()
  const src = hub.getStream(4, 1)
  const fb = new H264Fallback({ units: 200, max: 24, makeTranscoder: realMaker, log: (l) => logs.push(l), stopDelayMs: 15 })
  const a = channel()
  check('a viewer is attached to the conversion of its camera', fb.attach('n1/4/1', src, a, { camera: 'n1/5' }) === true && fb.summary().running === 1)
  check('... which is one more viewer of the camera\'s own stream, in the foreground', src.clients.size === 1 && src.fg === true)
  feed(src, 0, 20)
  check('one ffmpeg for it, niced below the workers (ionice idle, nice 10)', procs.length === 1 && procs[0].bin === 'ionice' && procs[0].args.slice(0, 5).join(' ') === '-c 3 nice -n 10', procs[0]?.args.slice(0, 6).join(' '))
  const args = procs[0].args.join(' ')
  check('... H.265 in, libx264 veryfast crf 21 out, one encoder thread, zerolatency, no B-frames', args.includes('-f hevc -i pipe:0') && args.includes('-c:v libx264 -preset veryfast -threads 1 -crf 21 -tune zerolatency -bf 0'), args)
  check(`... a keyframe every ${KEY_SECONDS} s of the camera's own rate (15 fps: 30 pictures), nothing dropped or scaled`, / -g 30 /.test(args) && !args.includes('select=') && !args.includes('scale='), args)
  // (after each, the 7 bytes that end its picture: ffmpeg lets it go without waiting for the next)
  check('... every frame of the camera goes in, each ended as it goes: out without waiting for the next', procs[0].written.length === 40 && procs[0].written.every((b, i) => (i % 2 ? b.length === 7 && b[4] === 0x46 : b.length === 8)) && args.includes('-flags low_delay'))
  check('... its log lines say what it is, with the camera', logs.some((l) => l === '[h264-fallback] n1/5: converting a sub stream at 15.0 fps to H.264, every frame kept, each picture out as it comes'), logs.join(' | '))
  procs[0].stdout.emit('data', Buffer.concat([IDR, P, P]))
  check('converted pictures reach the viewer as H.264, with the camera\'s own capture times', a.got.length === 2 && parseFrame(a.got[0]).codec === CODEC_H264 && parseFrame(a.got[0]).isKey && Math.abs(parseFrame(a.got[0]).ts - 0) < 0.01 && Math.abs(parseFrame(a.got[1]).ts - 66.7) < 0.01)
  check('... and its tile is told it is converted, once, with the first of them', JSON.stringify(a.notes) === '[{"op":"convert","on":true}]', JSON.stringify(a.notes))
  // a second viewer of the same camera
  const b = sock()
  check('a second viewer of the camera shares it: no second ffmpeg, no second place', fb.attach('n1/4/1', src, b, { camera: 'n1/5' }) === true && procs.length === 1 && fb.summary().running === 1 && fb.summary().viewers === 2)
  check('... and has a picture at once: the conversion\'s pictures since its last keyframe', b.got.length === 2 && parseFrame(b.got[0]).isKey)
  check('... told at once too (a /live socket: as a text message)', JSON.stringify(b.notes) === '[{"op":"convert","on":true}]')
  // a viewer who plays H.265, on the camera's own stream
  const raw = sock()
  src.add(raw)
  const before = raw.got.length
  feed(src, 20, 5)
  check('a viewer who plays H.265 on the same camera gets the camera\'s own frames, byte for byte', raw.got.length === before + 5 && parseFrame(raw.got.at(-1)).codec === CODEC_H265 && raw.got.at(-1).equals(h265(false, 24 * 66.7)))
  src.remove(raw)
  // the last viewer leaves
  a.close()
  check('one viewer gone: still running for the other', !killed(procs[0]) && fb.summary().running === 1)
  b.close()
  check('the last one gone: runs on for its linger', !killed(procs[0]) && fb.summary().running === 1 && fb.summary().viewers === 0)
  const c = sock()
  fb.attach('n1/4/1', src, c, { camera: 'n1/5' })
  await sleep(40)
  check('a viewer back within the linger keeps it', !killed(procs[0]) && fb.summary().running === 1)
  c.close()
  await sleep(40)
  check('the linger over: ffmpeg killed, its place free, off the camera\'s stream', killed(procs[0]) && procs[0].ended === true && fb.summary().running === 0 && fb.streams.size === 0 && src.clients.size === 0 && fb.xcodes.size === 0)
}
{
  // the ladder with real conversions: 3 fit at veryfast, 4 (the count) only at ultrafast
  procs.length = 0
  const logs = []
  const hub = mkHub()
  const fb = new H264Fallback({ units: 48, max: 4, makeTranscoder: realMaker, log: (l) => logs.push(l), stopDelayMs: 15 })
  check('a budget of 0.48 cores and at most 4: room for 4', fb.pool.max === 4 && fb.enabled)
  const socks = []
  const open = (ch) => { const w = sock(); socks[ch] = w; const r = fb.attach(`n1/${ch}/1`, hub.getStream(ch, 1), w, { camera: `n1/${ch + 1}` }); feed(hub.getStream(ch, 1), 0, 20); return r }
  open(0); open(1); open(2)
  check('three running: all at veryfast, the whole budget', procs.length === 3 && procs.every((p) => p.args.includes('veryfast')) && fb.summary().step === 'veryfast' && fb.summary().units === 48)
  open(3)
  check('a fourth: it starts at ultrafast (4 x 8 fits, 4 x 13 does not)', procs.length === 4 && procs[3].args.includes('ultrafast') && procs[3].args.join(' ').includes('-crf 20') && fb.summary().step === 'ultrafast')
  check('... said in the log, with the cores it comes to', logs.some((l) => /^\[h264-fallback\] 4 of 4 conversions running: ultrafast crf 20 \(was veryfast\), each from its camera's next keyframe; about 0\.32 of 0\.48 cores/.test(l)), logs.filter((l) => l.includes('conversions running')).join(' | '))
  check('... those already running stay as they are until their next keyframe', procs.length === 4 && !procs.slice(0, 3).some(killed))
  feed(hub.getStream(0, 1), 20, 11) // frames 20-30: a keyframe at 30
  check('... where each starts again at ultrafast, the old ffmpeg given a moment to hand back', procs.length === 5 && procs[4].args.includes('ultrafast') && !killed(procs[0]) && procs[0].written.at(-1).length === 7 && procs[4].written.length === 2 && procs[4].written[0][4] === 0x26)
  await sleep(HANDOVER_MS + 60)
  check('... and then killed', killed(procs[0]) && !killed(procs[1]) && !killed(procs[4]))
  check('... the CPU counted follows: ultrafast + veryfast + veryfast + ultrafast', fb.summary().units === 8 + 16 + 16 + 8, String(fb.summary().units))
  const full = sock()
  const said = logs.length
  check('the budget full: a fifth camera is refused with the reason', fb.attach('n1/9/1', hub.getStream(9, 1), full, { camera: 'n1/10' }) === NO_ROOM && procs.length === 5 && fb.summary().refused === 1 && full.closedWith === null)
  check('... the camera\'s own stream is not asked for on its account', hub.getStream(9, 1).clients.size === 0 && hub.getStream(9, 1).wanted === false)
  check('... said in the log once, with how to raise it', logs.length === said + 1 && /no room to convert n1\/10: 4 of 4 conversions running/.test(logs.at(-1)) && logs.at(-1).includes('CCTV_H264_FALLBACK_CORES'), logs.at(-1))
  fb.attach('n1/9/1', hub.getStream(9, 1), sock(), { camera: 'n1/10' })
  check('... not again within the minute', logs.length === said + 1 && fb.summary().refused === 2)
  const joiner = sock()
  check('... a viewer of a camera already converted still joins (it costs nothing)', fb.attach('n1/3/1', hub.getStream(3, 1), joiner) === true)
  joiner.close()
  // a conversion nobody watches gives its place to a camera somebody does
  socks[1].close()
  const taker = sock()
  const idleProc = procs[1]
  check('one nobody watches any more (its linger running) gives its place up at once', fb.attach('n1/9/1', hub.getStream(9, 1), taker, { camera: 'n1/10' }) === true && killed(idleProc) && fb.summary().running === 4 && !fb.streams.has('n1/1/1'))
  // down again
  for (const w of [socks[2], socks[3], taker]) w.close()
  await sleep(40)
  check('down to one: the step goes back up (with room to spare), for its next keyframe', fb.summary().running === 1 && fb.summary().step === 'veryfast')
  const n = procs.length
  feed(hub.getStream(0, 1), 31, 30) // a keyframe at 60
  await sleep(HANDOVER_MS + 60)
  check('... where it starts again at veryfast', procs.length === n + 1 && procs.at(-1).args.includes('veryfast') && killed(procs[4]))
  socks[0].close()
  await sleep(40)
  check('everyone gone: every ffmpeg ever started is killed', procs.every(killed) && fb.summary().running === 0 && fb.xcodes.size === 0, procs.map((p) => (killed(p) ? 'k' : '-')).join(''))
}
{
  // an H.264 camera is never converted, even when the server thought it H.265
  procs.length = 0
  const logs = []
  const hub = mkHub()
  const src = hub.getStream(2, 1)
  const fb = new H264Fallback({ units: 200, max: 24, makeTranscoder: realMaker, log: (l) => logs.push(l), stopDelayMs: 15 })
  const a = sock()
  fb.attach('n1/2/1', src, a, { camera: 'n1/3' })
  feed(src, 0, 40, h264)
  check('an H.264 camera after all: no ffmpeg, its own frames sent as they are', procs.length === 0 && a.got.length > 0 && parseFrame(a.got.at(-1)).codec === CODEC_H264 && a.got.at(-1).equals(h264(false, 39 * 66.7)))
  check('... its place given back, and its tile not marked as converted', fb.summary().running === 0 && a.notes.length === 0)
  a.close()
  await sleep(40)
  check('... and gone after its linger', fb.streams.size === 0 && src.clients.size === 0)
}
{
  // a conversion that fails outright: said, not black
  procs.length = 0
  const logs = []
  let now = 1_000_000
  const hub = mkHub()
  const src = hub.getStream(6, 1)
  const fb = new H264Fallback({ units: 200, max: 24, makeTranscoder: realMaker, log: (l) => logs.push(l), stopDelayMs: 15, now: () => now })
  const a = sock()
  fb.attach('n1/6/1', src, a, { camera: 'n1/7' })
  feed(src, 0, 20)
  procs[0].emit('error', new Error('spawn ffmpeg ENOENT'))
  check('ffmpeg that never ran: the viewer is dropped (its tile asks again), the place freed, off the camera', a.closedWith?.code === 1011 && fb.summary().running === 0 && fb.streams.size === 0 && src.clients.size === 0)
  check('... said in the log with the camera', logs.some((l) => l.includes('[h264-fallback] n1/7: conversion failed: spawn ffmpeg ENOENT')), logs.join(' | '))
  const again = sock()
  check('... asking again is refused with the reason, and starts nothing', fb.attach('n1/6/1', src, again, { camera: 'n1/7' }) === FAILED && procs.length === 1 && src.clients.size === 0)
  check('... another camera is not affected', fb.attach('n1/7/1', hub.getStream(7, 1), sock()) === true)
  now += FAILED_QUIET_MS
  check('... after a minute it is tried again', fb.attach('n1/6/1', src, again, { camera: 'n1/7' }) === true && fb.summary().running === 2)
  // one that had been working and exits is started again at the next keyframe (transcode.mjs), not failed
  feed(src, 0, 20)
  const p = procs.at(-1)
  p.stdout.emit('data', Buffer.concat([IDR, P, P]))
  p.emit('close', 1)
  feed(src, 30, 5)
  check('an ffmpeg that had been working and exits: a new one at the camera\'s next keyframe, the viewer kept', procs.at(-1) !== p && again.closedWith === null && !fb.failed.has('n1/6/1'))
  for (const s of [...fb.streams.values()]) s.close()
  check('closing the streams kills what runs', procs.filter((x) => x !== procs[0] && x !== p).every(killed))
}
{
  // the camera's stream made again under the same id (its NVR edited), and one that has ended
  procs.length = 0
  const hub = mkHub()
  const fb = new H264Fallback({ units: 200, max: 24, makeTranscoder: realMaker, log: () => {}, stopDelayMs: 15 })
  const a = sock()
  fb.attach('n1/1/1', hub.getStream(1, 1), a)
  feed(hub.getStream(1, 1), 0, 20)
  const first = fb.streams.get('n1/1/1')
  const hub2 = mkHub()
  const b = sock()
  fb.attach('n1/1/1', hub2.getStream(1, 1), b)
  check('the camera\'s stream made again: the old conversion is closed (its ffmpeg killed, its viewer reconnects), a new one on the new stream', first.closed && killed(procs[0]) && a.closedWith?.code === 1011 && fb.streams.get('n1/1/1') !== first && fb.streams.get('n1/1/1').source === hub2.getStream(1, 1) && fb.summary().running === 1)
  hub2.getStream(1, 1).close()
  const c = sock()
  fb.attach('n1/1/1', hub2.getStream(1, 1), c)
  check('one whose stream has ended is made again too, not joined', fb.streams.get('n1/1/1').clients.has(c) && fb.summary().running === 1)
  for (const s of [...fb.streams.values()]) s.close()
}
{
  // off, and apart from the phones' pool
  const off = new H264Fallback({ units: 0, makeTranscoder: realMaker, log: () => {} })
  check('a budget of nothing: off', off.enabled === false && off.pool.max === 0 && new H264Fallback({ max: 0, log: () => {} }).enabled === false)
  const phones = new TranscodePool(16)
  const phoneLive = new PhoneLive({ pool: phones, makeTranscoder: () => ({ push() {}, close() {} }), log: () => {} })
  const hub = mkHub()
  const fb = new H264Fallback({ units: 16, max: 1, makeTranscoder: () => ({ push() {}, close() {} }), log: () => {} })
  fb.attach('n1/0/1', hub.getStream(0, 1), sock())
  check('a conversion here takes nothing from the pool phones and remote viewers share', phones.active === 0 && fb.summary().running === 1)
  phoneLive.attach('n1/0/1', hub.getStream(0, 1), 1, sock(), { camera: 'n1/1' })
  check('... and theirs nothing from this budget: full here, a phone still gets its stream', fb.attach('n1/1/1', hub.getStream(1, 1), sock()) === NO_ROOM && phones.active === 1 && fb.summary().running === 1)
  const s = fb.summary()
  check('the summary for Health: running, cap, step, units of budget', s.running === 1 && s.cap === 1 && s.step === 'veryfast' && s.crf === 21 && s.units === 0 && s.budgetUnits === 16 && s.viewers === 1 && s.refused === 1, JSON.stringify(s))
  for (const x of [...fb.streams.values(), ...phoneLive.streams.values()]) x.close()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
