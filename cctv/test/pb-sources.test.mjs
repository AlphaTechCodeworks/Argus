// Offline tests for the playback page's pure logic (public/pb-sources.js): the server's and the NVR's
// recordings merged into one list of stretches, lookups on it, the choice between server and NVR
// playback for a day (plan R6), going over to the NVR when the share fails, the scrub throttle (one
// scrub in flight, the newest position wins), the clock-skew hint and the conversions between the
// two time bases.
//   node cctv/test/pb-sources.test.mjs
import { readFileSync } from 'node:fs'
import {
  CONVERTED_SCRUB_TIMEOUT_MS,
  LIVE_MARGIN_MS,
  NVR_SPEEDS,
  NvrFallback,
  SCRUB_TIMEOUT_MS,
  SERVER_SPEEDS,
  SERVER_START_TIMEOUT_MS,
  ScrubThrottle,
  convertTime,
  describeSkew,
  gapAt,
  liveEdge,
  mergeSources,
  nextStretch,
  pickMode,
  prerollUntil,
  recordedFrom,
  scrubTimeoutMs,
  serverFailed,
  shift,
  speedFor,
  stretchAt,
  watchesStart
} from '../public/pb-sources.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const text = (list) => list.map((x) => `${x.src} ${x.s}-${x.e}`).join(', ')

// ---- merging --------------------------------------------------------------------------------------
{
  const m = mergeSources([[10, 20], [30, 40]], [[0, 50]], { minMs: 0 })
  check('merge: NVR ranges minus server ranges, in time order', text(m) === 'nvr 0-10, server 10-20, nvr 20-30, server 30-40, nvr 40-50', text(m))
  const s = 1000
  const m2 = mergeSources([[10 * s, 20 * s], [30 * s, 40 * s]], [[0, 50 * s]])
  check('  the same in seconds with the default 2 s sliver limit', text(m2) === 'nvr 0-10000, server 10000-20000, nvr 20000-30000, server 30000-40000, nvr 40000-50000', text(m2))
  const m3 = mergeSources([[1000, 20_000]], [[0, 21_000]])
  check('  NVR slivers under 2 s (clock jitter at the edges) are dropped', text(m3) === 'server 1000-20000', text(m3))
  const m4 = mergeSources([[0, 10_000]], [[10_000, 12_000]])
  check('  a stretch of exactly 2 s is kept', text(m4) === 'server 0-10000, nvr 10000-12000', text(m4))
  const m5 = mergeSources([[30, 40], [10, 20], [18, 25]], [], { minMs: 0 })
  check('  server ranges out of order or overlapping are sorted and joined; no NVR: server only', text(m5) === 'server 10-25, server 30-40', text(m5))
  const m6 = mergeSources([], [[5000, 9000], [0, 6000]])
  check('  no server footage: the NVR ranges, joined', text(m6) === 'nvr 0-9000', text(m6))
  const m7 = mergeSources([[100, 200]], [[0, 50_000]], { minMs: 0 })
  check('  a short server range is never dropped', text(m7) === 'nvr 0-100, server 100-200, nvr 200-50000', text(m7))
}

// ---- skew shift -------------------------------------------------------------------------------------
{
  const nvr = [[1_000_000, 1_060_000], [2_000_000, 2_100_000, 5]]
  const out = shift(nvr, -220_000)
  check('shift: every range moved by ms (NVR clock -> server clock with -skewMs)', JSON.stringify(out) === JSON.stringify([[780_000, 840_000], [1_780_000, 1_880_000, 5]]), JSON.stringify(out))
  check('  extra fields (an event type) are kept, the input is not changed', nvr[1][2] === 5 && nvr[0][0] === 1_000_000)
  check('  shift by 0 and of nothing', JSON.stringify(shift(nvr, 0)) === JSON.stringify(nvr) && shift([], 5).length === 0 && shift(null, 5).length === 0)
  // server footage 10:00-10:30 (server clock); the NVR (220 s fast) has 09:00-11:00 on its clock
  const H = 3_600_000
  const merged = mergeSources([[10 * H, 10.5 * H]], shift([[9 * H, 11 * H]], -220_000))
  check('  merged after the shift: the NVR-only stretches are in server time', text(merged) === `nvr ${9 * H - 220_000}-${10 * H}, server ${10 * H}-${10.5 * H}, nvr ${10.5 * H}-${11 * H - 220_000}`, text(merged))
}

// ---- lookups at the boundaries ------------------------------------------------------------------------
{
  const list = mergeSources([[10, 20], [30, 40]], [[0, 50]], { minMs: 0 })
  const at = (t) => {
    const x = stretchAt(list, t)
    return x ? `${x.src} ${x.s}-${x.e}` : 'none'
  }
  check('stretchAt: inside, at a start (the stretch starting there), at the last end, outside', at(5) === 'nvr 0-10' && at(10) === 'server 10-20' && at(20) === 'nvr 20-30' && at(0) === 'nvr 0-10' && at(50) === 'nvr 40-50' && at(51) === 'none' && at(-1) === 'none', [5, 10, 20, 0, 50, 51, -1].map(at).join(' | '))
  const gappy = mergeSources([[10, 20], [30, 40]], [], { minMs: 0 })
  const g = (t) => {
    const x = stretchAt(gappy, t)
    return x ? `${x.s}-${x.e}` : 'none'
  }
  check('  an end with nothing after it still counts; a hole does not', g(20) === '10-20' && g(25) === 'none' && g(30) === '30-40', [20, 25, 30].map(g).join(' | '))
  check('recordedFrom: t itself when recorded, else the next start, else null', recordedFrom(gappy, 5) === 10 && recordedFrom(gappy, 10) === 10 && recordedFrom(gappy, 15) === 15 && recordedFrom(gappy, 20) === 20 && recordedFrom(gappy, 25) === 30 && recordedFrom(gappy, 40) === 40 && recordedFrom(gappy, 41) === null && recordedFrom([], 5) === null)
  const n = (t) => nextStretch(list, t)?.s ?? 'none'
  check('nextStretch: the first stretch starting after t', n(-1) === 0 && n(0) === 10 && n(10) === 20 && n(15) === 20 && n(40) === 'none' && n(45) === 'none', [-1, 0, 10, 15, 40, 45].map(n).join(' | '))
  const gaps = [[100, 200, 'disk too slow'], [300, 400, null]]
  check('gapAt: the reason of the recorder gap at t ("not recorded" without one), null outside', gapAt(gaps, 100) === 'disk too slow' && gapAt(gaps, 200) === 'disk too slow' && gapAt(gaps, 350) === 'not recorded' && gapAt(gaps, 250) === null && gapAt([], 5) === null && gapAt(undefined, 5) === null)
}

// ---- the file being written: the live edge -------------------------------------------------------------------
{
  const H = 3_600_000
  const now = 12 * H // the timeline's now (server clock)
  check('liveEdge: the timeline\'s now plus the time since it came, less 1 s', LIVE_MARGIN_MS === 1000 && liveEdge(now, 500, 500) === now - 1000 && liveEdge(now, 500, 30_500) === now + 29_000, `${liveEdge(now, 500, 500) - now} ${liveEdge(now, 500, 30_500) - now}`)
  check('  a page clock read before the answer came counts as no time since', liveEdge(now, 500, 400) === now - 1000)
  // today: the server has 10:00-11:00 (closed) and 11:30-now (the file being written); the NVR has
  // 09:00 up to its own now, read a little later than the timeline
  const server = [[10 * H, 11 * H], [11.5 * H, now]]
  const nvr = [[9 * H, now + 20_000]]
  const edge = now + 5000
  const m = mergeSources(server, nvr, { liveTo: edge })
  check('mergeSources liveTo: the last server range reaches the live edge; nothing after the edge counts', text(m) === `nvr ${9 * H}-${10 * H}, server ${10 * H}-${11 * H}, nvr ${11 * H}-${11.5 * H}, server ${11.5 * H}-${edge}`, text(m))
  check('  recordedFrom: up to the edge; after it nothing (never a time in the future)', recordedFrom(m, edge - 1) === edge - 1 && recordedFrom(m, edge) === edge && recordedFrom(m, edge + 1) === null && recordedFrom(m, now + 4 * H) === null, [edge - 1, edge, edge + 1, now + 4 * H].map((t) => recordedFrom(m, t) - now).join(' | '))
  const early = mergeSources(server, [], { liveTo: now - 1000 })
  check('  an edge before the timeline\'s end cuts the live range there (the newest second may not be on disk)', early.at(-1).e === now - 1000 && recordedFrom(early, now - 500) === null, text(early))
  check('  without liveTo: as before (the NVR\'s newest stretch after the server\'s end)', text(mergeSources(server, nvr)) === `nvr ${9 * H}-${10 * H}, server ${10 * H}-${11 * H}, nvr ${11 * H}-${11.5 * H}, server ${11.5 * H}-${now}, nvr ${now}-${now + 20_000}`)
  check('  liveTo without server ranges changes nothing', text(mergeSources([], nvr, { liveTo: edge })) === text(mergeSources([], nvr)))
  check('  the inputs are not changed', server[1][1] === now && nvr[0][1] === now + 20_000)
}

// ---- {type:'started'}: the preroll to skip ----------------------------------------------------------------------
{
  check('prerollUntil: a server start with a preroll (from < at) -> at', prerollUntil({ type: 'started', gen: 1, at: 5000, from: 3000, src: 'server' }) === 5000)
  check('  at its keyframe (keyframe speeds, reverse, a jump to the next file) -> null', prerollUntil({ type: 'started', gen: 1, at: 3000, from: 3000, src: 'server' }) === null)
  check('  an NVR leg start (paced by the NVR, sent as it plays) -> null', prerollUntil({ type: 'started', gen: 1, at: 5000, src: 'nvr' }) === null && prerollUntil({ type: 'started', gen: 1, at: 5000, from: 3000, src: 'nvr' }) === null)
  check('  no source or no times -> null', prerollUntil({ type: 'started', gen: 1, at: 5000, from: 3000 }) === null && prerollUntil({ type: 'started', src: 'server' }) === null && prerollUntil(null) === null)
}

// ---- mode per day (R6) ---------------------------------------------------------------------------------
{
  const tl = (o = {}) => ({ available: true, now: 5, tzOffsetMs: 0, skewMs: 0, firstMs: 1, codec: 'h264', ranges: [[1, 2]], gaps: [], ...o })
  const m = (timeline, o = {}) => pickMode({ timeline, h265: true, quality: 'server', ...o })
  check('pickMode: available:false -> nvr', m({ available: false }).mode === 'nvr' && m(null).mode === 'nvr' && m(undefined).mode === 'nvr')
  check('  an empty day -> nvr', m(tl({ ranges: [] })).mode === 'nvr' && typeof m(tl({ ranges: [] })).why === 'string')
  const h = m(tl({ codec: 'h265' }), { h265: false })
  check('  H.265 on a browser without H.265 -> server with conversion, and a reason naming H.265', h.mode === 'server' && h.transcode === true && /H\.265/.test(h.why), h.why)
  check('  H.265 on a browser with H.265 -> server, no conversion', m(tl({ codec: 'h265' }), { h265: true }).mode === 'server' && m(tl({ codec: 'h265' }), { h265: true }).transcode === false)
  check('  quality sd-nvr -> nvr', m(tl(), { quality: 'sd-nvr' }).mode === 'nvr')
  check('  otherwise -> server', m(tl()).mode === 'server' && m(tl(), { quality: undefined }).mode === 'server')
}

// ---- scrub throttle ------------------------------------------------------------------------------------
function fakeTimers() {
  const t = { now: 0, timers: [] }
  t.setTimer = (fn, ms) => {
    const rec = { fn, at: t.now + ms }
    t.timers.push(rec)
    return rec
  }
  t.advance = (ms) => {
    t.now += ms
    for (;;) {
      const due = t.timers.filter((x) => x.at <= t.now).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      t.timers.splice(t.timers.indexOf(due), 1)
      due.fn()
    }
  }
  return t
}
{
  const ft = fakeTimers()
  const sent = []
  let gen = 0
  const th = new ScrubThrottle((t) => (sent.push({ t, gen: ++gen }), gen), { now: () => ft.now, setTimer: ft.setTimer })
  for (let i = 0; i < 20; i++) {
    th.push(1000 + i)
    ft.advance(5)
  }
  check('ScrubThrottle: 20 pushes with no ack -> 1 send (the first position)', sent.length === 1 && sent[0].t === 1000, JSON.stringify(sent))
  th.ack(1)
  check('  an ack -> the newest position is sent next', sent.length === 2 && sent[1].t === 1019, JSON.stringify(sent))
  th.ack(1)
  check('  a second ack of an older scrub frees nothing', sent.length === 2)
  th.push(2000)
  check('  one in flight: the next position waits', sent.length === 2)
  ft.advance(299)
  check('  ... still waiting at 299 ms', sent.length === 2)
  ft.advance(1)
  check('  no ack for 300 ms -> the slot is freed (the waiting position goes)', sent.length === 3 && sent[2].t === 2000, JSON.stringify(sent))
  ft.advance(300)
  th.push(2100)
  check('  after another 300 ms without an ack the next push goes at once', sent.length === 4 && sent[3].t === 2100)
  th.ack(4)
  th.push(2200)
  th.push(2300)
  th.cancel()
  th.ack(5)
  ft.advance(1000)
  check('  cancel: the waiting position is dropped, a late ack sends nothing', sent.length === 5 && sent[4].t === 2200, JSON.stringify(sent.map((s) => s.t)))
  th.push(2400)
  check('  after cancel the slot is free', sent.length === 6 && sent[5].t === 2400)
}
{
  const ft = fakeTimers()
  const sent = []
  let open = false
  let gen = 10
  const th = new ScrubThrottle((t) => (open ? (sent.push(t), ++gen) : null), { now: () => ft.now, setTimer: ft.setTimer })
  th.push(1)
  th.push(2)
  check('ScrubThrottle: nothing sent while the socket cannot send (send returns null)', sent.length === 0)
  open = true
  th.push(3)
  check('  the newest position goes once it can', sent.join() === '3')
  th.ack(11)
  check('  (an ack with nothing waiting sends nothing)', sent.join() === '3')
}
{
  // A browser without HEVC: the server converts each H.265 scrub (a fresh ffmpeg and one whole
  // keyframe, ~600-830 ms at 4K) and the next scrub kills it, so at 300 ms none would ever show.
  check('scrubTimeoutMs: 300 ms for a browser that decodes H.265', scrubTimeoutMs(true) === 300 && SCRUB_TIMEOUT_MS === 300)
  check('  1500 ms for one that cannot (its H.265 scrubs are converted)', scrubTimeoutMs(false) === 1500 && CONVERTED_SCRUB_TIMEOUT_MS === 1500)
  const ft = fakeTimers()
  const sent = []
  let gen = 0
  let h265 = false
  const th = new ScrubThrottle((t) => (sent.push(t), ++gen), { now: () => ft.now, setTimer: ft.setTimer, timeoutMs: () => scrubTimeoutMs(h265) })
  th.push(1)
  th.push(2)
  ft.advance(1499)
  check('ScrubThrottle, timeoutMs asked at each send: converted, still waiting at 1499 ms', sent.join() === '1', sent.join())
  ft.advance(1)
  check('  the waiting position goes at 1500 ms', sent.join() === '1,2', sent.join())
  h265 = true // (the page found out it can decode H.265)
  th.ack(2)
  th.push(3)
  th.push(4)
  ft.advance(300)
  check('  the next send takes the new answer: 300 ms', sent.join() === '1,2,3,4', sent.join())
  const plain = new ScrubThrottle(() => 1, { now: () => ft.now, setTimer: ft.setTimer })
  check('  the default is still 300 ms', plain.timeoutMs === SCRUB_TIMEOUT_MS)
}

// ---- clock-skew hint, time bases, speeds ------------------------------------------------------------------
check('describeSkew: nothing up to 10 s (the clock sync puts that right)', describeSkew(0) === '' && describeSkew(5000) === '' && describeSkew(-10_000) === '' && describeSkew(undefined) === '')
check("  nvr1's 3 min 40 s fast", describeSkew(220_000) === "Server time. This NVR's clock is 3 min 40 s fast; the time printed on the picture differs.", describeSkew(220_000))
check('  slow, seconds only, and hours', /12 s slow/.test(describeSkew(-12_000)) && /1 h 2 min fast/.test(describeSkew(3_720_000)) && /1 min fast/.test(describeSkew(60_400)), `${describeSkew(-12_000)} | ${describeSkew(3_720_000)} | ${describeSkew(60_400)}`)
check('convertTime: server -> nvr adds the skew, nvr -> server subtracts it', convertTime(1000, 'server', 'nvr', { toSkew: 220 }) === 1220 && convertTime(1220, 'nvr', 'server', { fromSkew: 220 }) === 1000)
check('  the same mode: unchanged (nvr -> nvr as today, whatever the NVRs); null stays null', convertTime(1000, 'nvr', 'nvr', { fromSkew: 5, toSkew: 9 }) === 1000 && convertTime(1000, 'server', 'server') === 1000 && convertTime(null, 'server', 'nvr', { toSkew: 5 }) === null)
check('speeds: server -32..32 without 0, NVR 1..8', SERVER_SPEEDS.join() === '-32,-16,-8,-4,-2,-1,1,2,4,8,16,32' && NVR_SPEEDS.join() === '1,2,4,8')
check('speedFor: NVR mode takes 1-8 (reverse -> 1, 16/32 -> 8); server keeps any server speed', speedFor('nvr', -4) === 1 && speedFor('nvr', 16) === 8 && speedFor('nvr', 4) === 4 && speedFor('server', -4) === -4 && speedFor('server', 32) === 32 && speedFor('server', 3) === 1)

// ---- the share failing: the NVR's copy instead, once per camera --------------------------------------------
// 09-26 13:00-13:56 the NAS was down: server playback ended with "Playback failed: EIO: i/o error, read"
// or a spinner for minutes, and the viewer had to find "SD (NVR)" by hand.
{
  check('the start watch is 8 s', SERVER_START_TIMEOUT_MS === 8000)
  check('serverFailed: a failed server playback (1011 "playback failed", rec-playback.mjs #fail)', serverFailed(1011, 'playback failed'))
  check('  not the NVR being busy, nor a viewer or the page closing it', !serverFailed(1013, 'NVR offline') && !serverFailed(1000, '') && !serverFailed(1001, '') && !serverFailed(1005, ''))
  check('  nor the refusals the viewer can do nothing about by switching (a converter full, no recordings)', !serverFailed(1011, 'transcode busy') && !serverFailed(1011, 'server recordings not available'))
  const list = [{ s: 0, e: 100, src: 'server' }, { s: 100, e: 200, src: 'nvr' }, { s: 200, e: 300, src: 'server' }]
  check('watchesStart: a start in the server\'s own footage is watched (its files are read)', watchesStart(list, 50) && watchesStart(list, 250))
  check('  one in a stretch only the NVR has is not: that is the NVR\'s own start, sometimes 10 s slow', !watchesStart(list, 150))
  check('  one between stretches, or with none known yet, is watched (the server reads the next file)', watchesStart(list, 400) && watchesStart([], 50) && watchesStart(null, 50))
  const fb = new NvrFallback()
  check('NvrFallback: the first failure of a camera goes over to the NVR', fb.take('nvr1/4') === true)
  check('  the second of the same camera does not (its failure is shown: never a loop)', fb.take('nvr1/4') === false && fb.take('nvr1/4') === false)
  check('  another camera still gets its one', fb.take('solus/5') === true && fb.take('solus/5') === false)

  // the page: which of these it uses and where (it has no DOM-free half to run here). Its line
  // endings are whatever the checkout left (CRLF on a Windows working copy), so they are evened out.
  const page = readFileSync(new URL('../public/playback.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const fn = (name) => page.slice(page.indexOf(`function ${name}(`), page.indexOf('\n}\n', page.indexOf(`function ${name}(`)))
  check('page: one NvrFallback for the page, keyed by the socket\'s camera', /const nvrFallback = new NvrFallback\(\)/.test(page) && /nvrFallback\.take\(sock\.cam\)/.test(page))
  check('  a server socket that closes as a failed playback goes over', /serverFailed\(e\.code, e\.reason\)/.test(fn('openServer')) && /fallBackToNvr\(sock/.test(fn('openServer')))
  check('  a start is watched when the socket opens, and a seek on the open socket too', /watchStart\(sock, 0, /.test(fn('openServer')) && /watchStart\(sock, cmd\.gen, /.test(fn('serverSeek')))
  check('  the watch waits SERVER_START_TIMEOUT_MS, only where watchesStart says so, and stands down once that generation is answered', /SERVER_START_TIMEOUT_MS/.test(fn('watchStart')) && /watchesStart\(state\.stretches, /.test(fn('watchStart')) && /okGen >= gen/.test(fn('watchStart')))
  check('  "started" and "end" end the watch; closing the socket does too', /case 'started': \{[^}]*settleStart\(sock\)/.test(page) && /case 'end':\s*settleStart\(sock\)/.test(page) && /settleStart\(ws\)/.test(fn('closeSocket')))
  check('  going over plays the NVR at the same moment (SD (NVR), the position kept) and says so', /state\.quality = 'sd-nvr'/.test(fn('fallBackToNvr')) && /reloadKeepingPosition\(\)/.test(fn('fallBackToNvr')) && /showNotice\(/.test(fn('fallBackToNvr')))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
