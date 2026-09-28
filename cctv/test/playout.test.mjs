// Offline tests for the playout clock (public/playout.js): replays network arrival patterns seen on
// real cameras through the real PlayoutClock, with a stand-in for the player's display loop
// (60 Hz refresh, newest due frame shown, older due frames skipped, at most 45 frames queued).
//   node cctv/test/playout.test.mjs
import { PLAYBACK_CLOCK, PLAYOUT_DEFAULTS, PlayoutClock } from '../public/playout.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const FRAME_MS = 1000 / 30
const MAX_QUEUED = 45

/**
 * Plays arrivals [{ at: wall ms, ts: capture ms }] (sorted by at) through a PlayoutClock.
 * Returns what a viewer would see: frames shown and skipped, frames shown with no wait (already
 * late when decoded), the longest run of skipped frames, per-second stats.
 */
function replay(arrivals, options) {
  const clock = new PlayoutClock(options)
  const queue = []
  const shown = [] // { now, ts }
  let skipped = 0
  let run = 0
  let maxRun = 0
  let immediate = 0
  const immediateAt = [] // wall times of frames that were already due when decoded
  const end = arrivals.at(-1).at + 2000
  let next = 0
  let nextAdapt = 1000
  for (let now = 0; now <= end; now += 1000 / 60) {
    while (next < arrivals.length && arrivals[next].at <= now) {
      const { ts } = arrivals[next++]
      const at = clock.schedule(ts, now)
      if (at <= now) {
        immediate++
        immediateAt.push(now)
      }
      queue.push({ ts })
      while (queue.length > MAX_QUEUED) {
        queue.shift()
        skipped++
        maxRun = Math.max(maxRun, ++run)
      }
    }
    let due = -1
    for (let i = 0; i < queue.length && clock.presentAt(queue[i].ts) <= now; i++) due = i
    if (due >= 0) {
      skipped += due
      run = due ? run + due : 0
      maxRun = Math.max(maxRun, run)
      shown.push({ now, ts: queue[due].ts })
      queue.splice(0, due + 1)
    }
    if (now >= nextAdapt) {
      clock.adapt(now)
      nextAdapt += 1000
    }
  }
  return { clock, shown, skipped, maxRun, immediate, immediateAt, total: arrivals.length }
}

// ---- defaults -----------------------------------------------------------------------------------
check('start delay 350 ms, min 150, max 800', PLAYOUT_DEFAULTS.startDelayMs === 350 && PLAYOUT_DEFAULTS.minDelayMs === 150 && PLAYOUT_DEFAULTS.maxDelayMs === 800)

// ---- steady 30 fps (sanity) ---------------------------------------------------------------------
{
  const arr = []
  for (let i = 0; i < 30 * 60; i++) arr.push({ at: 1000 + i * FRAME_MS + (i % 7) * 3, ts: 50_000 + i * FRAME_MS })
  const r = replay(arr)
  check('steady 30 fps with small jitter: nothing skipped, no re-sync', r.skipped === 0 && r.clock.resyncs === 0, `skipped ${r.skipped}, resyncs ${r.clock.resyncs}`)
}

// ---- 30 fps with a 320-450 ms delivery pause every 3 s, then a burst ----------------------------
{
  const arr = []
  const pauses = [320, 450, 400, 380, 440, 350]
  let held = [] // frames withheld during a pause
  let pauseEnd = -1
  for (let i = 0; i < 30 * 120; i++) {
    const cap = i * FRAME_MS // wall time the frame would normally arrive
    const cycle = Math.floor(cap / 3000)
    const inCycle = cap - cycle * 3000
    const pause = pauses[cycle % pauses.length]
    if (inCycle >= 2500 && inCycle < 2500 + pause) {
      pauseEnd = cycle * 3000 + 2500 + pause
      held.push(i)
      continue
    }
    // the burst: withheld frames arrive together (9-13 of them) a few ms apart
    held.forEach((j, k) => arr.push({ at: 1000 + pauseEnd + k * 2, ts: 7000 + j * FRAME_MS }))
    held = []
    // (in order: a frame never overtakes the burst ahead of it)
    arr.push({ at: Math.max(1000 + cap + 5, (arr.at(-1)?.at ?? 0) + 1), ts: 7000 + i * FRAME_MS })
  }
  const r = replay(arr)
  const pct = (100 * r.skipped) / r.total
  check('400 ms pauses + bursts: under 1% of frames skipped', pct < 1, `${r.skipped}/${r.total} skipped, delay ${r.clock.delay} ms`)
  check('400 ms pauses + bursts: no skip runs (picture never jumps)', r.maxRun <= 2, `longest run ${r.maxRun}`)
  check('400 ms pauses + bursts: no re-syncs', r.clock.resyncs === 0, `resyncs ${r.clock.resyncs}`)
  check('400 ms pauses + bursts: delay stays within the limits', r.clock.delay >= 150 && r.clock.delay <= 800, `delay ${r.clock.delay}`)
  // the old 150 ms start delay froze/jumped here: compare
  const old = replay(arr, { startDelayMs: 150, minDelayMs: 80, maxDelayMs: 600 })
  check('400 ms pauses + bursts: fewer late frames than with the old 150 ms buffer', r.clock.lateTotal < old.clock.lateTotal, `late ${r.clock.lateTotal} vs ${old.clock.lateTotal}`)
}

// ---- an 11 s outage; the camera's timestamps froze meanwhile ------------------------------------
{
  const arr = []
  let ts = 90_000
  let at = 1000
  for (let i = 0; i < 30 * 20; i++, ts += FRAME_MS, at += FRAME_MS) arr.push({ at, ts })
  at += 11_000 // nothing arrives for 11 s; the camera clock did not advance
  for (let i = 0; i < 30 * 30; i++, ts += FRAME_MS, at += FRAME_MS) arr.push({ at, ts })
  const r = replay(arr)
  const outageEnd = 1000 + 20 * 1000 + 11_000
  const afterwards = r.immediateAt.filter((t) => t > outageEnd + 1500).length
  check('11 s outage (frozen timestamps): re-anchored to the new frames', r.clock.resyncs >= 1, `resyncs ${r.clock.resyncs}`)
  check('11 s outage: no permanent "show immediately" mode afterwards', afterwards === 0, `${afterwards} frames shown with no wait after the first 1.5 s`)
  // paced again: the frames after the outage are shown about a frame apart, not all at once
  const post = r.shown.filter((s) => s.now > outageEnd + 2000)
  const gaps = post.slice(1).map((s, i) => s.now - post[i].now)
  const even = gaps.filter((g) => g > 20 && g < 50).length / gaps.length
  check('11 s outage: frames paced evenly again afterwards', even > 0.95, `${Math.round(even * 100)}% of gaps 20-50 ms`)
  check('11 s outage: no frames skipped after recovery', r.skipped <= 3, `skipped ${r.skipped}`)
}

// ---- consistently late frames (camera clock stepped back 5 s; frames keep coming) ----------------
{
  const arr = []
  let ts = 10_000
  let at = 1000
  for (let i = 0; i < 30 * 10; i++, ts += FRAME_MS, at += FRAME_MS) arr.push({ at, ts })
  ts -= 5000
  for (let i = 0; i < 30 * 20; i++, ts += FRAME_MS, at += FRAME_MS) arr.push({ at, ts })
  const r = replay(arr)
  const late = r.immediateAt.filter((t) => t > 11_000 + 2000).length
  check('timestamps stepped back 5 s: re-anchored, paced again', r.clock.resyncs >= 1 && late === 0, `resyncs ${r.clock.resyncs}, ${late} immediate after 2 s`)
}

// ---- persistent lateness without a timestamp jump (delivery 1.5 s behind, steady) ----------------
{
  const arr = []
  let ts = 0
  let at = 1000
  for (let i = 0; i < 30 * 5; i++, ts += FRAME_MS, at += FRAME_MS) arr.push({ at, ts })
  // the link slows: over 1.9 s the delivery falls 1.9 s behind (under the 2 s jump threshold)...
  for (let i = 0; i < 57; i++, ts += FRAME_MS, at += 2 * FRAME_MS) arr.push({ at, ts })
  // ... then keeps that lag
  for (let i = 0; i < 30 * 20; i++, ts += FRAME_MS, at += FRAME_MS) arr.push({ at, ts })
  const r = replay(arr)
  const late = r.immediateAt.filter((t) => t > at - 15_000).length
  check('lag beyond delay + 500 ms for 1 s: re-anchored instead of showing frames instantly', r.clock.resyncs >= 1 && late === 0, `resyncs ${r.clock.resyncs}, ${late} immediate in the last 15 s`)
}

// ---- camera clock drift +0.49% (and -0.49%) over 5 minutes --------------------------------------
for (const drift of [0.0049, -0.0049]) {
  const arr = []
  const step = FRAME_MS * (1 + drift) // camera timestamps advance faster (or slower) than wall time
  for (let i = 0; i < 30 * 300; i++) arr.push({ at: 1000 + i * FRAME_MS + (i % 5) * 4, ts: 1000 + i * step })
  const r = replay(arr)
  const sign = drift > 0 ? '+' : '-'
  check(`drift ${sign}0.49% over 5 min: no hard re-sync`, r.clock.resyncs === 0, `resyncs ${r.clock.resyncs}`)
  check(`drift ${sign}0.49% over 5 min: no big skip`, r.maxRun <= 1, `longest skip run ${r.maxRun}, skipped ${r.skipped}`)
  check(`drift ${sign}0.49% over 5 min: under 0.7% of frames skipped (the drift itself)`, r.skipped / r.total < 0.007, `skipped ${r.skipped}/${r.total}`)
  // the buffer stays near its size instead of creeping toward the limits
  const lastWait = r.shown.at(-1)
  check(`drift ${sign}0.49%: buffer stays within limits`, r.clock.delay >= 150 && r.clock.delay <= 800, `delay ${r.clock.delay}, last shown at ${Math.round(lastWait.now)}`)
}

// ---- rate change (playback 2x) still works; pause/resume re-anchors ------------------------------
{
  const c = new PlayoutClock()
  c.schedule(0, 0)
  c.setRate(2, 1000, 100)
  const at = c.schedule(2000, 600)
  check('rate 2: a frame 1 s of video later is due 0.5 s later', Math.abs(at - (100 + c.delay + 500)) < 1, `at ${at}`)
  c.anchorAt(5000, 60_000)
  const at2 = c.schedule(5000 + FRAME_MS * 2, 60_000 + 40)
  check('after anchorAt (resume after a long pause): no outage re-sync', c.resyncs === 0 && at2 > 60_000, `resyncs ${c.resyncs}`)
}

// ---- server: an 11 s outage is not restarted as a stall (live.mjs; the live worker uses the same) --
{
  const { readFileSync } = await import('node:fs')
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  const m = src('live.mjs').match(/export const STALL_MS = (?:.*\|\| )?([\d_]+)$/m) // (a test-only override may come first)
  const stall = m ? Number(m[1].replace(/_/g, '')) : 0
  check('live.mjs STALL_MS is 15 s (an 11 s outage recovers by itself)', stall === 15_000, `STALL_MS ${stall}`)
  check('live worker runs nvrs.mjs, whose streams are live.mjs LiveStream', /import\('\.\/nvrs\.mjs'\)/.test(src('nvr-worker.mjs')) && /import \{ LiveStream \} from '\.\/live\.mjs'/.test(src('nvrs.mjs')))
  check('no other stall timeout for live streams', !/STALL_MS\s*=/.test(src('stream-hub.mjs') + src('nvrs.mjs') + src('nvr-worker.mjs')))
}

// ---- a hole in recorded footage: frames buffered before it are all shown ----
// The server sends playback ahead of the clock, so when the frame after a 13 s hole is decoded,
// frames before the hole are still queued. Re-anchoring on it used to put it before them: the
// display loop then showed it and skipped the queued ones (7-14 frames lost at each hole).
{
  const c = new PlayoutClock()
  const ats = []
  for (let i = 0; i < 9; i++) ats.push(c.schedule(i * 40, i)) // a burst: 9 frames (360 ms) decoded in 9 ms
  const lastBefore = Math.max(...ats)
  const after = c.schedule(8 * 40 + 13_000, 10) // the first frame after the hole
  const next = c.schedule(8 * 40 + 13_040, 11)
  check('hole: the frame after it is shown after every frame queued before it', after > lastBefore, `after ${after.toFixed(0)} vs last queued ${lastBefore.toFixed(0)}`)
  check('hole: frames after it keep their spacing', Math.abs(next - after - 40) < 1, `${(next - after).toFixed(1)} ms`)
}

// ---- playback: the server stalls for 1.7 s and then carries on 1.7 s behind -----------------------
// (smoothness report, cause 1.) Nothing is lost: the server's pacer resumes where it was, so every
// later frame arrives 1.7 s late. The live clock waits a second of such frames before re-anchoring:
// the stall, a second shown as each frame lands, then a second freeze of a buffer's length. The
// playback clock re-anchors on the first of them: one freeze, then even again.
{
  const STALL_MS = 1700
  const arr = []
  for (let i = 0; i < 30 * 30; i++) {
    const cap = i * FRAME_MS
    const late = cap >= 10_000 ? STALL_MS : 0 // the stall starts 10 s in
    arr.push({ at: 1000 + cap + late + (i % 5) * 3, ts: 40_000 + cap })
  }
  const freezes = (r) => {
    const after = r.shown.filter((s) => s.now > 1000 + 9000)
    return after.slice(1).map((s, i) => s.now - after[i].now).filter((g) => g > 100)
  }
  const pb = replay(arr, PLAYBACK_CLOCK)
  const live = replay(arr, { ...PLAYBACK_CLOCK, lateForMs: PLAYOUT_DEFAULTS.lateForMs }) // what playback had before
  const f = freezes(pb)
  check('playback clock: a 1.7 s server stall freezes the picture once, not twice', f.length === 1, `freezes ${f.map(Math.round).join(', ')} ms`)
  check('... where the old setting froze twice', freezes(live).length === 2, `freezes ${freezes(live).map(Math.round).join(', ')} ms`)
  check('playback clock: nothing skipped, and paced again after the stall', pb.skipped === 0 && pb.immediateAt.filter((t) => t > 1000 + 10_000 + STALL_MS + 100).length === 0, `skipped ${pb.skipped}, ${pb.immediateAt.length} shown with no wait`)
  const post = pb.shown.filter((s) => s.now > 1000 + 10_000 + STALL_MS + 1000)
  const gaps = post.slice(1).map((s, i) => s.now - post[i].now)
  check('playback clock: even frame spacing after the stall', gaps.filter((g) => g > 20 && g < 50).length / gaps.length > 0.95)
}
{
  // Only playback re-anchors at once: live keeps its second's grace (a live stream's bursts are the
  // NVR's, and the live pages never pass these options).
  const { readFileSync } = await import('node:fs')
  const page = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')
  check('the playback clock re-anchors at once, with the buffer playback had', PLAYBACK_CLOCK.lateForMs === 0 && PLAYBACK_CLOCK.startDelayMs === 300 && PLAYBACK_CLOCK.minDelayMs === 200 && PLAYBACK_CLOCK.maxDelayMs === 1000)
  check('live keeps a second before it re-anchors', PLAYOUT_DEFAULTS.lateForMs === 1000)
  check('the playback page and the camera wall use the playback clock', /clock: PLAYBACK_CLOCK/.test(page('playback.js')) && /clock: PLAYBACK_CLOCK/.test(page('wall.js')))
  check('no live page uses it or sets lateForMs', ['viewer.js', 'live-tile.js', 'player.js'].every((f) => !/PLAYBACK_CLOCK|lateForMs/.test(page(f))))
}

console.log(failures ?`\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
