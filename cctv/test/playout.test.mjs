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

// ---- rate change (playback 2x) keeps the buffered frames' display times; pause/resume re-anchors ----
// (smoothness report cause 5, fix a.) A speed change used to put the next buffered frame a whole
// buffer later: the picture held for the buffer's length at every change, and at 2x and 4x the
// buffer then held two or four times the decoded frames, more than a hardware decoder hands out
// (playout-speed.test.mjs replays what that did).
{
  const c = new PlayoutClock()
  c.schedule(0, 0)
  const next = c.schedule(FRAME_MS, FRAME_MS) // still buffered when the speed changes
  c.setRate(2, FRAME_MS, 100)
  check('rate 2: the next buffered frame keeps its display time', Math.abs(c.presentAt(FRAME_MS) - next) < 1e-6, `${c.presentAt(FRAME_MS).toFixed(1)} vs ${next.toFixed(1)}`)
  const at = c.schedule(FRAME_MS + 1000, 600)
  check('rate 2: a frame 1 s of video after it is due 0.5 s after it', Math.abs(at - (next + 500)) < 1e-6, `at ${at.toFixed(1)}, next ${next.toFixed(1)}`)
  c.anchorAt(5000, 60_000)
  const at2 = c.schedule(5000 + FRAME_MS * 2, 60_000 + 40)
  check('after anchorAt (resume after a long pause): no outage re-sync', c.resyncs === 0 && at2 > 60_000, `resyncs ${c.resyncs}`)
}
{
  // 25 fps with the playback buffer: 1x, then 4x, then back to 1x. Each change keeps the next frame
  // where it was and plays the rest at the new speed from it, with no pause and nothing re-synced
  const c = new PlayoutClock(PLAYBACK_CLOCK)
  for (let i = 0; i < 100; i++) c.schedule(i * 40, 1000 + i * 40) // 4 s at 1x: frame i due at 1300 + 40i
  const now = 1000 + 99 * 40 + 5 // frames 93-99 are buffered, 93 is next
  const before = [93, 94, 99].map((i) => c.presentAt(i * 40))
  c.setRate(4, 93 * 40, now)
  const after = [93, 94, 99].map((i) => c.presentAt(i * 40))
  check('1x to 4x: the next frame keeps its time, the ones after it come 4x as fast', Math.abs(after[0] - before[0]) < 1e-6 && Math.abs(after[1] - after[0] - 10) < 1e-6 && Math.abs(after[2] - after[0] - 60) < 1e-6, `${after.map((a) => (a - now).toFixed(1)).join(', ')} ms from now`)
  c.setRate(1, 96 * 40, now + 30)
  check('4x back to 1x: the same the other way', Math.abs(c.presentAt(96 * 40) - after[0] - 30) < 1e-6 && Math.abs(c.presentAt(97 * 40) - c.presentAt(96 * 40) - 40) < 1e-6)
  const due = c.presentAt(96 * 40) - (now + 30)
  check('  no re-sync, and the next frame is due in 55 ms as it was (the old change put it 300 ms away)', c.resyncs === 0 && Math.abs(due - 55) < 1e-6, `next due in ${due.toFixed(1)} ms`)
  // nothing buffered, or no clock yet: only the rate changes (the next frame anchors as before)
  const e = new PlayoutClock(PLAYBACK_CLOCK)
  e.setRate(2, undefined, 500)
  check('setRate with no clock yet: just the rate', e.rate === 2 && e.anchor === null)
  const a = c.anchor
  c.setRate(2, undefined, now + 100)
  check('setRate with nothing buffered: just the rate', c.rate === 2 && c.anchor === a)
}

// ---- playback: a bigger buffer reaches the picture a few ms a frame, not 40 ms at once ---------------
// (smoothness report, minor items.) adapt() grows the buffer by growMs after late frames. Live moves the
// anchor all at once: every frame waits 40 ms longer from that moment, a hitch of a frame. Playback
// spreads it: each frame scheduled moves the anchor by growSlew of its own spacing (10%: 4 ms at
// 25 fps), so the picture runs 10% slow for 0.4 s instead.
{
  // 25 fps, on time, except that at 4 s the link holds frame 75 for 420 ms and the ones behind it come
  // in a burst after it: frames 75 and 76 are late (and 77 with the smaller playback buffer). The adapt()
  // at 5 s grows the buffer
  const run = (options) => {
    const c = new PlayoutClock(options)
    const ts = (i) => i * 40
    const at = (i) => (i >= 75 && i < 84 ? Math.max(1000 + 75 * 40 + 420, 1000 + i * 40) + (i - 75) * 0.1 : 1000 + i * 40)
    let nextAdapt = 1000
    for (let i = 0; i < 100; i++) {
      for (; nextAdapt <= at(i); nextAdapt += 1000) c.adapt(nextAdapt)
      c.schedule(ts(i), at(i))
    }
    const probe = ts(130) // a frame further on: where it will be shown
    const was = c.presentAt(probe)
    const delay0 = c.delay
    c.adapt(nextAdapt) // 5 s
    const jump = c.presentAt(probe) - was
    const moves = []
    for (let i = 100; i < 115; i++) {
      const p = c.presentAt(probe)
      c.schedule(ts(i), at(i))
      moves.push(c.presentAt(probe) - p)
    }
    return { grew: c.delay - delay0, jump, moves, total: c.presentAt(probe) - was, late: c.lateTotal }
  }
  const pb = run(PLAYBACK_CLOCK)
  const live = run()
  check('the late frames grow the playback buffer by 40 ms', pb.grew === 40, `grew ${pb.grew}, late ${pb.late}`)
  check('  playback: the picture does not move when it grows', pb.jump === 0, `moved ${pb.jump} ms at once`)
  check('  playback: it moves 4 ms a frame (10% of 40 ms), and all 40 ms within 10 frames', pb.moves.every((m) => m <= 4 + 1e-9) && Math.abs(pb.moves.slice(0, 10).reduce((a, b) => a + b, 0) - 40) < 1e-6 && Math.abs(pb.total - 40) < 1e-6, pb.moves.map((m) => m.toFixed(1)).join(' '))
  check('  live: 40 ms at once, as before', live.grew === 40 && live.jump === 40 && live.moves.every((m) => m === 0), `jump ${live.jump}, then ${live.moves.join(' ')}`)
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
  // the speed changes: setRate is playback's alone, and so is the gradual growth
  const livePages = ['viewer.js', 'live-tile.js', 'map.js', 'motion-tune.js']
  check('the playback clock grows its buffer gradually; live grows it at once, as before', PLAYBACK_CLOCK.growSlew === 0.1 && PLAYOUT_DEFAULTS.growSlew === 0)
  check('no live page sets growSlew or changes the rate (setRate)', [...livePages, 'player.js'].every((f) => !/growSlew/.test(page(f))) && livePages.every((f) => !/setRate\(/.test(page(f))))
}

// ---- live: the clock's behaviour, pinned -------------------------------------------------------------
// Live view shares this clock with playback, and playback changes must not move live by a frame. Every
// display time schedule() returns and every buffer size and anchor adapt() leaves, for arrival patterns
// that exercise all of it (bursts, outages, clock steps, lag, drift, a jittery link that grows and
// shrinks the buffer), is hashed with the live options: the default and the viewer's "Smooth". The
// hashes were taken from the clock as it was before the playback speed changes (c95b4fb).
{
  const { createHash } = await import('node:crypto')
  const { readFileSync } = await import('node:fs')
  const viewer = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8')
  const m = viewer.match(/const SMOOTH_CLOCK = \{ startDelayMs: (\d+), minDelayMs: (\d+), maxDelayMs: (\d+) \}/)
  const SMOOTH = m && { startDelayMs: Number(m[1]), minDelayMs: Number(m[2]), maxDelayMs: Number(m[3]) }
  check('the viewer\'s Smooth clock is the one pinned here', JSON.stringify(SMOOTH) === '{"startDelayMs":400,"minDelayMs":300,"maxDelayMs":1200}', JSON.stringify(SMOOTH))

  // arrival patterns (sorted by `at`)
  const steady = () => Array.from({ length: 30 * 60 }, (_, i) => ({ at: 1000 + i * FRAME_MS + (i % 7) * 3, ts: 50_000 + i * FRAME_MS }))
  const bursts = () => {
    const arr = []
    const pauses = [320, 450, 400, 380, 440, 350]
    let held = []
    let pauseEnd = -1
    for (let i = 0; i < 30 * 120; i++) {
      const cap = i * FRAME_MS
      const cycle = Math.floor(cap / 3000)
      const inCycle = cap - cycle * 3000
      const pause = pauses[cycle % pauses.length]
      if (inCycle >= 2500 && inCycle < 2500 + pause) {
        pauseEnd = cycle * 3000 + 2500 + pause
        held.push(i)
        continue
      }
      held.forEach((j, k) => arr.push({ at: 1000 + pauseEnd + k * 2, ts: 7000 + j * FRAME_MS }))
      held = []
      arr.push({ at: Math.max(1000 + cap + 5, (arr.at(-1)?.at ?? 0) + 1), ts: 7000 + i * FRAME_MS })
    }
    return arr
  }
  const outage = () => {
    const arr = []
    let ts = 90_000
    let at = 1000
    for (let i = 0; i < 30 * 20; i++, ts += FRAME_MS, at += FRAME_MS) arr.push({ at, ts })
    at += 11_000
    for (let i = 0; i < 30 * 30; i++, ts += FRAME_MS, at += FRAME_MS) arr.push({ at, ts })
    return arr
  }
  const stepBack = () => {
    const arr = []
    let ts = 10_000
    let at = 1000
    for (let i = 0; i < 30 * 10; i++, ts += FRAME_MS, at += FRAME_MS) arr.push({ at, ts })
    ts -= 5000
    for (let i = 0; i < 30 * 20; i++, ts += FRAME_MS, at += FRAME_MS) arr.push({ at, ts })
    return arr
  }
  const lag = () => {
    const arr = []
    let ts = 0
    let at = 1000
    for (let i = 0; i < 30 * 5; i++, ts += FRAME_MS, at += FRAME_MS) arr.push({ at, ts })
    for (let i = 0; i < 57; i++, ts += FRAME_MS, at += 2 * FRAME_MS) arr.push({ at, ts })
    for (let i = 0; i < 30 * 20; i++, ts += FRAME_MS, at += FRAME_MS) arr.push({ at, ts })
    return arr
  }
  const drift = (d) => () => Array.from({ length: 30 * 300 }, (_, i) => ({ at: 1000 + i * FRAME_MS + (i % 5) * 4, ts: 1000 + i * FRAME_MS * (1 + d) }))
  // a jittery link: 0-60 ms of jitter with a 250-700 ms delivery spike now and then (seeded, so the
  // same every run), for 3 minutes then quiet for 1: the buffer grows, then shrinks
  const jittery = () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const arr = []
    let last = 0
    for (let i = 0; i < 30 * 240; i++) {
      const cap = i * FRAME_MS
      const rough = cap < 180_000
      const spike = rough && rnd() < 0.01 ? 250 + rnd() * 450 : 0
      const at = Math.max(last + 0.5, 1000 + cap + (rough ? rnd() * 60 : 2) + spike)
      last = at
      arr.push({ at, ts: 20_000 + cap })
    }
    return arr
  }
  /** Every display time and every adapt() result, hashed (12 hex digits). */
  const trace = (arrivals, options) => {
    const c = new PlayoutClock(options)
    const out = []
    let nextAdapt = 1000
    for (const { at, ts } of arrivals) {
      while (nextAdapt <= at) {
        c.adapt(nextAdapt)
        out.push(`d${c.delay} a${c.anchor?.toFixed(3)}`)
        nextAdapt += 1000
      }
      out.push(c.schedule(ts, at).toFixed(3))
    }
    out.push(`r${c.resyncs} l${c.lateTotal} d${c.delay}`)
    return createHash('sha256').update(out.join('\n')).digest('hex').slice(0, 12)
  }
  const scenarios = { steady, bursts, outage, stepBack, lag, driftFast: drift(0.0049), driftSlow: drift(-0.0049), jittery }
  // [default, Smooth] per scenario, from c95b4fb
  const PINNED = {
    steady: ['d654544fdf94', '4c2ad1864645'],
    bursts: ['3cccf927b827', 'f9096bdc3a5f'],
    outage: ['a03a35c7bc6d', 'ada818b16704'],
    stepBack: ['906285f0f8ab', 'f399e9de443e'],
    lag: ['9f53e966a70d', '681c692d4428'],
    driftFast: ['f5e68c301271', '6a28cc11f4f8'],
    driftSlow: ['196eac23cb85', '853263b47be5'],
    jittery: ['ad060aca6c28', '250dbb82dd8e']
  }
  const got = {}
  for (const [name, make] of Object.entries(scenarios)) {
    const arr = make()
    got[name] = [trace(arr), trace(arr, SMOOTH)]
    check(`live clock unchanged: ${name}, default and Smooth`, got[name][0] === PINNED[name][0] && got[name][1] === PINNED[name][1], `${got[name].join(' ')}`)
  }
  if (process.env.PRINT_PINNED) console.log(JSON.stringify(got))
  // the jittery link does exercise growing and shrinking (else it would pin nothing about them)
  const j = new PlayoutClock()
  let grew = 0
  let shrank = 0
  let na = 1000
  for (const { at, ts } of jittery()) {
    while (na <= at) {
      const before = j.delay
      j.adapt(na)
      if (j.delay > before) grew++
      if (j.delay < before) shrank++
      na += 1000
    }
    j.schedule(ts, at)
  }
  check('  (the jittery link grows the live buffer and shrinks it again)', grew > 0 && shrank > 0, `grew ${grew}x, shrank ${shrank}x`)
}

console.log(failures ?`\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
