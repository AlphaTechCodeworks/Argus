// A converted playback's start, from the server's pacer to the screen (the playback hunt of 1 Oct 2026,
// finding F3). The real ServerPlayback (rec-playback.mjs) plays temp files through a converter stand-in
// that keeps ffmpeg's time, and what it sends is replayed, arrival for arrival, through the real player
// (public/player.js and playout.js, made as playback.js makes it) on a virtual page (live-replay.mjs).
//
// What it guards. The pacer used to go on at 1x from the start point while ffmpeg started, so what it
// had handed in came out in a rush: frames a second on the socket 14, 30, 31, 20 (traced on 1 Oct),
// each frame further ahead of the clock the player had set on the first, 0.9 s in all. A decoder with
// room re-synced and skipped (16 frames in 2 re-syncs); one that hands out few pictures filled its
// queue and dropped everything to the next keyframe (21 frames and a 300 ms still at 4.1 s on the site
// PC's decoder; 44 frames and a 1.2 s still with 6 pictures). Now the pacer waits where a converter
// starts until it has caught up: 20 a second from the first frame shown, every frame decoded and shown.
//
// The stand-in is the traced ffmpeg: its first picture 490 ms after its first frame (860 ms for the
// second trace), then at most 31 (27) pictures a second; a picture comes out only once two more have
// gone in (its parser and its second decoder thread), and reaches the socket when the next one's bytes
// follow it or 150 ms have passed (the Transcoder). No ffmpeg runs, nothing reaches an NVR or a share.
//   node cctv/test/pb-start-replay.test.mjs [path/to/another/rec-playback.mjs]
// (with a path: that server instead of the repo's, to compare, e.g. the one of a checkout before the fix)
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pb-start-'))
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ a: { hash: 'x', role: 'admin' } }))
const { SegmentWriter } = await import('../segment-writer.mjs')
const { openRecIndex } = await import('../rec-index.mjs')
const { ServerPlayback } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : '../rec-playback.mjs')
const { TS0, play } = await import('./live-replay.mjs')
const { PLAYBACK_CLOCK } = await import('../public/playout.js')

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}

// ---- footage: 30 s at 20 fps, a keyframe every 2.5 s, frames exactly 50 ms apart -----------------------
const FPS = 20
const STEP = 1000 / FPS
const GOP = 50
const T0 = Date.UTC(2026, 8, 30, 19, 54, 5)
const SC4 = Buffer.from([0, 0, 0, 1])
const SC3 = Buffer.from([0, 0, 1])
const body = (n, seed) => {
  const b = Buffer.alloc(n, 0x55)
  b[0] = 0x80 | (seed & 0x7f)
  return b
}
const key = (i) => Buffer.concat([SC4, Buffer.from([0x67, 0x64]), body(12, i), SC3, Buffer.from([0x68]), body(4, i), SC3, Buffer.from([0x65, 0x88]), body(2000, i)])
const delta = (i) => Buffer.concat([SC4, Buffer.from([0x41, 0x9a]), body(400, i)])
const ROOT = mkdtempSync(join(tmpdir(), 'pb-start-loc-'))
const IDX = openRecIndex(join(process.env.DATA_DIR, 'recordings.db'))
{
  const w = new SegmentWriter({ root: ROOT, nvrId: 'n1', ch: 0, codec: 'h264' })
  const segs = []
  w.on('segment', (s) => segs.push(s))
  for (let i = 0; i < 30 * FPS; i++) w.write(i % GOP === 0 ? key(i) : delta(i), { isKey: i % GOP === 0, ts: T0 + i * STEP })
  await w.close()
  for (const s of segs) IDX.addSegment({ nvr: 'n1', ch: 0, ...s, loc: 'L1' })
  check('footage: 30 s recorded in one file', segs.length === 1, `${segs.length} files`)
}

/** The traced ffmpeg and the Transcoder around it, as a stand-in (see the top). */
const tracedFfmpeg = ({ startMs, perS }) => (o) => {
  const x = { q: [], next: 0, lastOut: -Infinity, timer: null, closed: false, held: null, idle: null }
  const send = (f) => o.onFrame(f.ts, f.n % GOP === 0, Buffer.from([0, 0, 0, 1, f.n % GOP === 0 ? 0x65 : 0x41, 0x88]))
  // the Transcoder: a picture is whole when the next one's bytes come, or 150 ms have passed
  const out = (f) => {
    if (x.held) send(x.held)
    x.held = f
    clearTimeout(x.idle)
    x.idle = setTimeout(() => {
      if (x.held) send(x.held)
      x.held = null
    }, 150)
  }
  // ffmpeg: a picture comes out once two more have gone in, the first startMs after the first frame
  // went in, the rest at most perS a second
  const pump = () => {
    x.timer = null
    while (!x.closed && x.next + 2 < x.q.length) {
      const due = x.next === 0 ? Math.max(x.q[0].at + startMs, x.q[2].at) : Math.max(x.q[x.next + 2].at, x.lastOut + 1000 / perS)
      const wait = due - performance.now()
      if (wait > 0) {
        x.timer = setTimeout(pump, wait)
        return
      }
      x.lastOut = due
      out(x.q[x.next++])
    }
  }
  const forget = () => {
    clearTimeout(x.timer)
    clearTimeout(x.idle)
    Object.assign(x, { q: [], next: 0, lastOut: -Infinity, timer: null, held: null })
  }
  return {
    inCodec: o.inCodec,
    push(ts) {
      x.q.push({ ts, at: performance.now(), n: x.q.length })
      if (!x.timer) pump()
    },
    endPicture() {},
    reset: forget,
    close() {
      x.closed = true
      forget()
    }
  }
}

/** One start at `start`, converted, watched for `ms`: what the socket was sent, as play() takes it. */
async function capture(start, converter, ms) {
  const t0 = performance.now()
  const arr = []
  let started = null
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    handlers: {},
    on(e, f) { this.handlers[e] = f },
    send(m) {
      if (typeof m === 'string') {
        const o = JSON.parse(m)
        if (o.type === 'started') started = o
        return
      }
      arr.push({ at: performance.now() - t0 + 1, tsMs: Number(m.readBigInt64LE(8)) / 1000, isKey: (m[0] & 1) === 1 }) // (a millisecond of local network)
    },
    close() {
      this.readyState = 3
      this.handlers.close?.()
    }
  }
  const s = new ServerPlayback({
    ws, nvr: { id: 'n1', online: true, playback: { lastClock: () => ({ tzOffsetMs: 0, skewMs: 0 }) } }, ch: 0, start, index: IDX,
    remote: true, fitAboveKbps: 0, pool: { active: 0, max: 2, acquire: () => ({ release() {} }) }, makeTranscoder: converter, log: () => {}
  })
  await sleep(ms)
  s.close()
  // capture times from the keyframe the preroll starts at (the replay's time base); arrivals in order
  let last = -Infinity
  for (const a of arr) {
    a.ts = a.tsMs - started.from
    a.at = last = Math.max(a.at, last + 0.2)
  }
  return { arr, at: started.at - started.from, preroll: started.from < started.at }
}

/** Frames a second on the socket, from the start (as the 1 Oct trace counted them). */
const perSecond = (arr, n) => Array.from({ length: n }, (_, k) => arr.filter((a) => a.at >= k * 1000 && a.at < (k + 1) * 1000).length).join(' ')

const DECODERS = [
  // measured on the site PC on 1 Oct (Chromium 152, 1920x1080 H.264, hardware): 10 pictures handed out,
  // 4 frames taken in before decodeQueueSize counts them, 1-2 ms a frame
  ['the site PC\'s decoder (10 pictures)', { pool: 10, decodeMs: 2, inFlight: 4 }],
  // the figure the repo's notes give for camera streams at 2560x1440
  ['a decoder handing out 6 pictures', { pool: 6, decodeMs: 8, inFlight: 0 }],
  ['a software decoder (no limit on pictures)', { pool: Infinity, decodeMs: 15, inFlight: 0 }]
]
const CASES = [
  ['a start 1 s into a GOP (a preroll of 20), ffmpeg\'s first picture after 490 ms, then 31 a second', T0 + 5000 + 1000, { startMs: 490, perS: 31 }],
  ['a start one frame past a keyframe, a slower ffmpeg: first picture after 860 ms, then 27 a second', T0 + 10_000 + STEP, { startMs: 860, perS: 27 }],
  ['a start on a keyframe (no preroll)', T0 + 15_000, { startMs: 490, perS: 31 }]
]
// (the server runs in real time; the replays, on the virtual page, come after all of them)
const traces = []
for (const [, start, conv] of CASES) traces.push(await capture(start, tracedFfmpeg(conv), 9000))
IDX.close()

for (const [i, [label]] of CASES.entries()) {
  const { arr, at, preroll } = traces[i]
  const shown = arr.filter((a) => a.ts >= at)
  const first = shown[0]
  // how far ahead of its media time a frame came, with the first frame to show as the clock
  const lead = first ? Math.max(0, ...shown.map((a) => a.ts - first.ts - (a.at - first.at))) : Infinity
  const rate = first ? Array.from({ length: 6 }, (_, k) => shown.filter((a) => a.at >= first.at + k * 1000 && a.at < first.at + (k + 1) * 1000).length) : []
  console.log(`\n== ${label}: ${perSecond(arr, 6)} frames a second on the socket; the first frame to show after ${Math.round(first?.at)} ms`)
  check('the server: from the first frame to show, 20 frames in every second (+-2), none more than 150 ms ahead of its media time', rate.length === 6 && rate.every((n) => Math.abs(n - FPS) <= 2) && lead <= 150, `${rate.join(' ')}; ${Math.round(lead)} ms ahead at most`)
  check('the server: every frame from the keyframe, in order', arr.length > 150 && arr[0].ts === 0 && arr[0].isKey && arr.every((a, j) => Math.abs(a.ts - j * STEP) < 0.01), `${arr.length} frames`)
  for (const [dn, decoder] of DECODERS) {
    const r = await play(arr, {
      clock: PLAYBACK_CLOCK,
      playerOptions: { arrivalClock: false, paintFirst: false }, // playback.js gives its player the clock and nothing else
      decoder,
      fps: FPS,
      warmMs: 0,
      // playback.js serverSeek(), then {type:'started'}: the frames before `at` are decoded, not shown
      patch: (p) => {
        p.seekReset()
        p.setStills(false)
        p.resume()
        p.setRate(1)
        if (preroll) p.skipUntil(TS0 + at)
      }
    })
    const c = r.counts
    check(`${dn}: every frame is decoded, none skipped, no still picture of 200 ms`, r.notDecoded === 0 && c.skipped === 0 && c.freezes === 0 && r.shownPct >= 99.5, `${r.notDecoded} never decoded, ${c.skipped} skipped in ${r.resyncs} re-syncs, ${c.freezes} stills (longest ${r.maxStillMs} ms), ${r.shownPct}% shown`)
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
