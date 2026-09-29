// Offline tests for the playout clock (public/playout.js): replays network arrival patterns seen on
// real cameras through the real PlayoutClock, with a stand-in for the player's display loop
// (60 Hz refresh, newest due frame shown, older due frames skipped, at most 45 frames queued).
//   node cctv/test/playout.test.mjs
import { PLAYBACK_CLOCK, PLAYOUT_DEFAULTS, PlayoutClock, REMOTE_CLOCK } from '../public/playout.js'

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
 * late when decoded), the longest run of skipped frames, per-second stats, and the delay after each
 * adapt(). maxQueued: the player's decoded-frame limit (the remote profile's is bigger).
 */
function replay(arrivals, options, maxQueued = MAX_QUEUED) {
  const clock = new PlayoutClock(options)
  const queue = []
  const shown = [] // { now, ts }
  let skipped = 0
  let run = 0
  let maxRun = 0
  let immediate = 0
  const immediateAt = [] // wall times of frames that were already due when decoded
  const delays = [] // [now, delay] after each adapt()
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
      while (queue.length > maxQueued) {
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
      delays.push([now, clock.delay])
      nextAdapt += 1000
    }
  }
  return { clock, shown, skipped, maxRun, immediate, immediateAt, delays, total: arrivals.length }
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
  // no clock yet: only the rate changes (the first frame anchors the clock)
  const e = new PlayoutClock(PLAYBACK_CLOCK)
  e.setRate(2, undefined, 500)
  check('setRate with no clock yet: just the rate', e.rate === 2 && e.anchor === null)
  // nothing buffered, every decoded frame shown (at 4x through the tunnel the frames come just in time):
  // the newest decoded frame keeps its time and the next follows at the new rate. It used to change only
  // the rate, so the next frame's display time made no sense and it re-synced a whole buffer ahead
  const t = now + 215 // frame 99, the newest scheduled, was shown 10 ms ago
  const last = c.presentAt(99 * 40)
  c.setRate(2, undefined, t)
  const next = c.schedule(100 * 40, t + 5)
  check('setRate with nothing buffered: the newest decoded frame keeps its time, the next follows at the new rate', c.rate === 2 && Math.abs(c.presentAt(99 * 40) - last) < 1e-6 && Math.abs(next - last - 20) < 1e-6 && c.resyncs === 0, `${(t - last).toFixed(0)} ms after it was shown; the next ${(next - last).toFixed(1)} ms after it; resyncs ${c.resyncs}`)
  c.setRate(1, undefined, t + 30)
  // (from 4x: the 4x of 250 ms ago may still be coming too)
  check('  a slow-down with nothing buffered looks for the frames still coming at the old speed too', c.catchUp !== null && c.catchUp.from === 4)
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

// ---- playback: after a slow-down the frames still coming at the old speed don't pile up --------------
// (review of cause 5 fix a.) From 4x back to 1x the server sends 4x until the command reaches it: for a
// round trip, 40 ms of video every 10 ms. Shown at 1x each of those came 30 ms further ahead than the
// one before, and the lead stayed there: more decoded frames than the viewing PC's decoder holds at 25
// and 30 fps (playout-speed.test.mjs replays that). player.push now passes each frame to arrived() as it
// comes in, and after a slow-down the clock plays those at up to the old speed instead.
{
  const STEP = 40 // 25 fps
  /**
   * 4x with the newest frame shown lead4 ms from now, then the speed to (1x or 2x): 14 frames still at 4x
   * (a 140 ms round trip), then 50 at the new speed. Each frame goes to arrived() (unless feed is false:
   * the clock as it was) and schedule(). Returns every frame's lead as it arrives and the anchor moves.
   */
  const slowDown = ({ lead4 = 50, to = 1, feed = true, extra } = {}) => {
    const c = new PlayoutClock(PLAYBACK_CLOCK)
    c.setRate(4) // (no frame yet: just the rate)
    let ts = 0
    let now = 1000
    for (let i = 0; i < 100; i++, ts += STEP, now += 10) c.schedule(ts, now)
    ts -= STEP
    now -= 10
    c.anchorAt(ts, now, lead4) // the newest frame due lead4 from now, the ones before it 10 ms apart
    const next = ts - Math.floor(lead4 / 10) * STEP // the oldest frame still waiting to be shown
    c.setRate(to, next, now)
    const armed = c.catchUp !== null
    const frames = []
    let target = null // the lead the catch-up keeps (set by the first frame after the change)
    const add = (n, gap) => {
      for (let i = 0; i < n; i++) {
        ts += STEP
        now += gap
        extra?.(c, frames.length, ts, now)
        const before = c.anchor
        if (feed) c.arrived(ts, now)
        if (frames.length === 0) target = c.catchUp?.target ?? null
        frames.push({ gap, lead: c.presentAt(ts) - now, moved: before - c.anchor })
        c.schedule(ts, now)
      }
    }
    add(14, 10) // still 4x
    add(50, STEP / to) // the new speed
    return { c, armed, target, frames, first: frames[0].lead, max: Math.max(...frames.map((f) => f.lead)), last: frames.at(-1).lead }
  }
  const ms = (x) => `${Math.round(x)} ms`
  const was = slowDown({ feed: false })
  const now = slowDown()
  check('4x to 1x: the frames still coming at 4x do not pile up: each arrives as far ahead as the first after the change', now.armed && now.frames.every((f) => Math.abs(f.lead - now.first) < 1e-6), `first ${ms(now.first)}, most ${ms(now.max)}, last ${ms(now.last)}`)
  check('  where they used to come 30 ms further ahead each, and stay there', Math.abs(was.max - (was.first + 13 * 30)) < 1e-6 && Math.abs(was.last - was.max) < 1e-6, `the clock as it was: first ${ms(was.first)}, then up to ${ms(was.max)}, last ${ms(was.last)}`)
  check('  the picture runs at most at 4x: each frame brings it forward no more than 3x the time since the one before', now.frames.every((f) => f.moved <= 3 * f.gap + 1e-9) && now.frames.slice(0, 14).some((f) => f.moved > 0), now.frames.slice(0, 15).map((f) => f.moved.toFixed(0)).join(' '))
  check('  and once the 1x frames come, not at all', now.frames.slice(14).every((f) => f.moved === 0))
  // the lead it keeps: the one the buffer had, within the playback buffer's limits
  const small = slowDown({ lead4: 20 }) // (4x through a slow link: the frames came just in time)
  const big = slowDown({ lead4: 150 }) // 600 ms at 1x, over the 300 ms delay
  check('  a buffer smaller than minDelayMs is let grow back to it from the 4x frames (200 ms at 1x), no further', Math.abs(small.target - 200) < 1e-6 && small.first < 200 && Math.abs(small.max - 200) < 1e-6 && Math.abs(small.last - 200) < 1e-6, `target ${ms(small.target)}, first ${ms(small.first)}`)
  check('  one bigger than the delay comes back to it (300 ms), at up to 4x', Math.abs(big.target - 300) < 1e-6 && Math.abs(big.last - 300) < 1e-6 && big.frames.every((f) => f.moved <= 3 * f.gap + 1e-9), `target ${ms(big.target)}, first ${ms(big.first)}, last ${ms(big.last)}`)
  const half = slowDown({ lead4: 150, to: 2 })
  check('  4x to 2x: the delay makes 150 ms at 2x, and the picture runs at most twice as fast', Math.abs(half.target - 150) < 1e-6 && Math.abs(half.last - 150) < 1e-6 && half.frames.every((f) => f.moved <= f.gap + 1e-9), `target ${ms(half.target)}, last ${ms(half.last)}`)
  // a growth adapt() decided that schedule() has not passed on yet goes first: the buffer is big enough
  let grow = null
  slowDown({
    extra: (c, n) => {
      if (n === 3) c.growLeft = 20
      if (n === 4) grow = c.growLeft
    }
  })
  check('  a growth still to come is dropped first', grow === 0, `growth left ${grow}`)
  // only for catchUpMs after the change (these runs last 2.1 s), and a hole in the footage ends it
  check('  it looks at the frames for catchUpMs (2 s) after the change, then stops', PLAYOUT_DEFAULTS.catchUpMs === 2000 && PLAYBACK_CLOCK.catchUpMs === undefined && now.c.catchUp === null)
  let holed = null
  slowDown({
    extra: (c, n, ts, t) => {
      if (n !== 5) return
      const a = c.anchor
      c.arrived(ts + 13_000, t) // the first frame after a 13 s hole, sent at once
      holed = { moved: a - c.anchor, over: c.catchUp === null }
    }
  })
  check('  a hole in the footage is not a lead to take out: it ends there', holed?.moved === 0 && holed.over, JSON.stringify(holed))
  // not on a speed-up; a re-anchor (resume, re-sync) or a seek (reset) ends it
  const up = new PlayoutClock(PLAYBACK_CLOCK)
  for (let i = 0; i < 50; i++) up.schedule(i * STEP, 1000 + i * STEP)
  up.setRate(4, 45 * STEP, 1000 + 49 * STEP)
  const a0 = up.anchor
  for (let i = 50; i < 60; i++) up.arrived(i * STEP, 1000 + 49 * STEP + (i - 49) * 10)
  check('  a speed-up leaves arrived() doing nothing', up.catchUp === null && up.anchor === a0)
  const r1 = slowDown({ extra: (c, n, ts, t) => n === 2 && c.anchorAt(ts - STEP, t, 300) })
  const r2 = slowDown({ extra: (c, n) => n === 2 && c.reset() })
  check('  a re-anchor or a reset ends it', r1.c.catchUp === null && r2.c.catchUp === null)
  const { readFileSync } = await import('node:fs')
  const player = readFileSync(new URL('../public/player.js', import.meta.url), 'utf8')
  check('  player.push passes every frame to it, except while paused (resume re-anchors)', /\n {4}if \(!this\.paused\) this\.clock\.arrived\(chunk\.timestampUs \/ 1000, performance\.now\(\)\)\r?\n {4}if \(this\.configuring\) return this\.#hold\(chunk\)/.test(player) && player.split('.arrived(').length === 2)
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

// ---- arrival patterns (sorted by `at`), for the pins and the remote profile below ----------------------
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

  /**
   * Every display time and every adapt() result, hashed (12 hex digits). arrive: each frame goes to
   * arrived() first, as player.push now does for live too (live never changes speed: it must change nothing).
   */
  const trace = (arrivals, options, arrive = false) => {
    const c = new PlayoutClock(options)
    const out = []
    let nextAdapt = 1000
    for (const { at, ts } of arrivals) {
      while (nextAdapt <= at) {
        c.adapt(nextAdapt)
        out.push(`d${c.delay} a${c.anchor?.toFixed(3)}`)
        nextAdapt += 1000
      }
      if (arrive) c.arrived(ts, at)
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
    const fed = [trace(arr, undefined, true), trace(arr, SMOOTH, true)]
    check(`live clock unchanged: ${name}, default and Smooth, with and without arrived()`, [got[name], fed].every((g) => g[0] === PINNED[name][0] && g[1] === PINNED[name][1]), `${got[name].join(' ')}, fed ${fed.join(' ')}`)
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

// ---- remote pages: a buffer that grows with the tunnel (REMOTE_CLOCK) ---------------------------------
// (stutter report 2.4, with verify-4's corrections, 29 Sep.) Through the Cloudflare tunnel the page's
// one socket stalls now and then for longer than live's 350-800 ms buffer (a keyframe of another tile
// ahead of it, a lost packet): the picture froze for the stall and then jumped ahead. The remote profile
// starts as live does and grows the buffer by each late frame's lateness at once (the picture is
// standing still anyway, so nothing visible moves), up to 2 s; not in the warm-up after a (re)start,
// where lateness is the start-up replay, not the link. It comes down again towards the largest
// lateness of the last minute, 10 ms a second, instead of live's 10 ms every 10 s.
const REMOTE_QUEUED = Math.ceil((REMOTE_CLOCK.maxDelayMs / 1000) * 30) + 15 // (player.js: 2 s at 30 fps)
const stillsOf = (r, ms = 200) => r.shown.slice(1).map((s, i) => [r.shown[i].now, s.now - r.shown[i].now]).filter(([, g]) => g >= ms)
/** 30 fps, even (a few ms of jitter), except that nothing arrives for stallMs at each of `stalls` (wall ms): then all at once. */
const stalled = ({ durMs = 120_000, stalls = [], stallMs = 1200 } = {}) => {
  const arr = []
  for (let i = 0; i * FRAME_MS < durMs; i++) {
    let at = 1000 + i * FRAME_MS + (i % 7) * 3
    for (const s of stalls) if (at >= s && at < s + stallMs) at = s + stallMs
    arr.push({ at: Math.max(at, (arr.at(-1)?.at ?? 0) + 0.5), ts: 40_000 + i * FRAME_MS })
  }
  return arr
}
{
  check('remote profile: starts as live (350 ms), may come down to 150 and grow to 2 s, stretching on late frames and shrinking over a minute\'s window', REMOTE_CLOCK.startDelayMs === 350 && REMOTE_CLOCK.minDelayMs === 150 && REMOTE_CLOCK.maxDelayMs === 2000 && REMOTE_CLOCK.stretchLate === true && REMOTE_CLOCK.shrinkWindowMs === 60_000, JSON.stringify(REMOTE_CLOCK))
  check('  live\'s own clock does neither (local pages keep it exactly)', PLAYOUT_DEFAULTS.stretchLate === false && PLAYOUT_DEFAULTS.shrinkWindowMs === 0 && PLAYOUT_DEFAULTS.maxDelayMs === 800)
  check('  and it keeps live\'s re-sync grace and its growth at once (no lateForMs, no growSlew)', !('lateForMs' in REMOTE_CLOCK) && !('growSlew' in REMOTE_CLOCK))
}
{
  // the stretch: 3 s on time (past the 1.5 s warm-up), then a frame 150 ms after its display time
  const c = new PlayoutClock(REMOTE_CLOCK)
  let i = 0
  for (; i < 90; i++) c.schedule(i * FRAME_MS, 1000 + i * FRAME_MS)
  const due = c.presentAt(i * FRAME_MS)
  const at = c.schedule(i * FRAME_MS, due + 150)
  check('stretch: a frame 150 ms late grows the buffer by that and 30 ms at once, and is shown 30 ms after it came', c.delay === 350 + 180 && Math.abs(at - (due + 180)) < 1e-6 && c.stretches === 1, `delay ${c.delay}, shown ${(at - due - 150).toFixed(1)} ms after it came`)
  check('  it is not counted late (it was not shown late), nothing re-synced', c.lateTotal === 0 && c.resyncs === 0)
  const next = c.schedule((i + 1) * FRAME_MS, due + 151)
  check('  the frames after it keep the camera\'s cadence: the next one a frame later, not at once', Math.abs(next - at - FRAME_MS) < 1e-6, `${(next - at).toFixed(1)} ms`)
  // a link falling behind, each frame 100 ms later than the one before (one frame 3 s late at once
  // would be an outage: a re-sync)
  const way = new PlayoutClock(REMOTE_CLOCK)
  let k = 0
  for (; k < 90; k++) way.schedule(k * FRAME_MS, 1000 + k * FRAME_MS)
  for (; way.lateTotal === 0 && k < 200; k++) way.schedule(k * FRAME_MS, 1000 + k * FRAME_MS + (k - 89) * 100)
  check('  no further than 2 s: past it a frame is late, and counted', way.delay === 2000 && way.lateTotal === 1 && way.resyncs === 0, `delay ${way.delay}, late ${way.lateTotal} at ${(k - 90) * 100} ms behind`)
  const warm = new PlayoutClock(REMOTE_CLOCK)
  warm.schedule(0, 1000)
  warm.schedule(FRAME_MS, 1000 + FRAME_MS + 600) // 0.6 s into the warm-up: the start-up replay, not the link
  check('  not in the warm-up after a (re)start', warm.delay === 350 && warm.stretches === 0, `delay ${warm.delay}`)
  const plain = new PlayoutClock()
  for (let k = 0; k < 90; k++) plain.schedule(k * FRAME_MS, 1000 + k * FRAME_MS)
  plain.schedule(90 * FRAME_MS, plain.presentAt(90 * FRAME_MS) + 150)
  check('  live\'s own clock does not stretch', plain.delay === 350 && plain.lateTotal === 1 && plain.stretches === 0)
}
{
  // 30 fps with a 1.2 s stall about every 20 s (report 2.4): live's buffer freezes at every stall and
  // then skips what came late; the remote profile freezes at the first only and shows every frame
  const arr = stalled({ stalls: [11_000, 31_000, 52_000, 71_000, 90_000, 111_000] })
  const remote = replay(arr, REMOTE_CLOCK, REMOTE_QUEUED)
  const live = replay(arr)
  const rs = stillsOf(remote)
  const ls = stillsOf(live)
  check('1.2 s stalls every ~20 s, remote: every frame shown, nothing re-synced', remote.skipped === 0 && remote.clock.resyncs === 0, `skipped ${remote.skipped}, resyncs ${remote.clock.resyncs}`)
  check('  one freeze (the first stall), none after it', rs.length === 1 && rs[0][0] < 13_000, rs.map(([t, g]) => `${Math.round(g)} ms at ${Math.round(t)}`).join(', '))
  check('  the buffer as big as the stalls need, under 2 s', remote.clock.delay >= 1200 && remote.clock.delay <= 1300, `delay ${remote.clock.delay}`)
  check('  where live\'s clock froze at every stall and skipped frames', ls.length >= 6 && live.skipped > 0, `${ls.length} freezes, skipped ${live.skipped}`)
  // 1.8 s stalls: a buffer of 1.8 s is 55 frames at 30 fps, more than the 45 decoded frames a player
  // keeps on the local network (verify-4: 2.8 frames a minute thrown away on a software-decoded tile)
  const long = stalled({ stalls: [11_000, 31_000, 52_000, 71_000, 90_000, 111_000], stallMs: 1800 })
  const kept = replay(long, REMOTE_CLOCK, REMOTE_QUEUED)
  const cut = replay(long, REMOTE_CLOCK)
  check('1.8 s stalls: every frame shown with 2 s of decoded frames kept, frames thrown away with 45', kept.skipped === 0 && kept.clock.delay > 1800 && cut.skipped > 0, `skipped ${kept.skipped} vs ${cut.skipped}, delay ${kept.clock.delay}`)
}
{
  // one 1.2 s stall at 11 s, then an even link: the buffer stays grown for a minute (the stall is in
  // the window), then comes down 10 ms a second to what the window's frames needed (the minimum here)
  const arr = stalled({ durMs: 220_000, stalls: [11_000] })
  const r = replay(arr, REMOTE_CLOCK, REMOTE_QUEUED)
  const at = (t) => r.delays.find(([n]) => n >= t)?.[1]
  const grown = at(14_000)
  const steps = r.delays.slice(1).map(([, d], k) => d - r.delays[k][1])
  check('one stall, then even: the buffer holds for the minute the stall is in the window', grown >= 1200 && at(72_000) === grown, `${grown} at 14 s, ${at(72_000)} at 72 s`)
  check('  then comes down, at most 10 ms a second', at(80_000) < grown && steps.every((s) => s >= -10), `${at(80_000)} at 80 s`)
  check('  to the minimum on an even link (150 ms), by about 3 minutes', at(200_000) === 150 && r.clock.delay === 150, `${at(200_000)} at 200 s`)
  check('  and the picture never skips a frame on the way down', r.skipped === 0 && stillsOf(r).length === 1, `skipped ${r.skipped}, ${stillsOf(r).length} stills of 200 ms+`)
}
{
  // Where it comes down to: the NVR pauses 600 ms every 3 s (the frames held then come at once), and
  // at 10 s the link stalls 1.5 s. The stall grows the buffer past 1.5 s; a minute later it comes down
  // to what the pauses need, 600 ms and the margin, and stays there: the pauses never show
  const arr = []
  for (let i = 0; i * FRAME_MS < 240_000; i++) {
    const t = i * FRAME_MS
    let at = 1000 + t
    if (t >= 10_000 && t < 11_500) at = 1000 + 11_500
    else if (t % 3000 >= 2000 && t % 3000 < 2600) at = 1000 + t - (t % 3000) + 2600
    arr.push({ at: Math.max(at, (arr.at(-1)?.at ?? 0) + 0.5), ts: i * FRAME_MS })
  }
  const r = replay(arr, REMOTE_CLOCK, REMOTE_QUEUED)
  const at = (s) => r.delays.find(([n]) => n >= s)?.[1]
  const stills = stillsOf(r).filter(([t]) => t > 15_000)
  // (630 ms, give or take the replay's 60 Hz steps: a frame is taken in at the refresh after it came)
  const near = (d) => Math.abs(d - 630) <= 1000 / 60
  check('shrinks to the largest lateness of the last minute and 30 ms (NVR pauses of 600 ms: 630 ms), not below', at(20_000) > 1500 && near(at(200_000)) && near(r.clock.delay), `${at(20_000)} at 20 s, ${at(100_000)} at 100 s, ${at(200_000)} at 200 s, ${r.clock.delay} at the end`)
  check('  the pauses never show once it has grown, nothing skipped', stills.length === 0 && r.skipped === 0, `${stills.length} stills after 15 s, skipped ${r.skipped}`)
}
{
  // the link cannot carry the stream (85% of it from 20 s on): no buffer hides that, and past 2 s the
  // clock re-syncs on the late frames as live does. It starts again from 350 ms then, not 2 s: a
  // re-sync on the grown buffer held the picture 2 s each time (verify-4's overload case)
  const arr = []
  for (let i = 0, at = 0; i * FRAME_MS < 120_000; i++) {
    const cap = i * FRAME_MS
    at = cap < 20_000 ? 1000 + cap : Math.max(1000 + cap, at + FRAME_MS / 0.85)
    arr.push({ at, ts: cap })
  }
  const remote = replay(arr, REMOTE_CLOCK, REMOTE_QUEUED)
  const live = replay(arr)
  const most = (r) => Math.max(...stillsOf(r, 0).map(([, g]) => g))
  check('overload: the remote profile re-syncs when 2 s is not enough', remote.clock.resyncs >= 1, `resyncs ${remote.clock.resyncs}`)
  check('  from its start delay again: no still picture longer than live\'s', most(remote) <= most(live) && most(remote) < 600, `longest still ${Math.round(most(remote))} ms, live ${Math.round(most(live))} ms`)
  check('  and fewer re-syncs than live', remote.clock.resyncs < live.clock.resyncs, `${remote.clock.resyncs} vs ${live.clock.resyncs}`)
}
{
  // the patterns live is pinned on, with the remote profile, against live's clock with the same number
  // of decoded frames kept: nothing more skipped, an outage or a clock step re-synced as live does, and
  // a link that falls 1.9 s behind and stays there ridden out by the stretch where live re-syncs
  // (skipping what it had), paced as before either way
  const cases = { steady, bursts, outage, stepBack, lag, driftFast: drift(0.0049), driftSlow: drift(-0.0049), jittery }
  const resyncs = { outage: 1, stepBack: 1 }
  for (const [name, make] of Object.entries(cases)) {
    const arr = make()
    const r = replay(arr, REMOTE_CLOCK, REMOTE_QUEUED)
    const live = replay(arr, undefined, REMOTE_QUEUED)
    const paced = r.immediateAt.filter((t) => t > arr.at(-1).at - 15_000).length === 0
    check(`remote profile, ${name}: no more skipped than live, re-synced only at an outage or a clock step, paced at the end, within 150-2000 ms`, r.skipped <= live.skipped && r.clock.resyncs === (resyncs[name] ?? 0) && paced && r.clock.delay >= 150 && r.clock.delay <= 2000, `skipped ${r.skipped} (live ${live.skipped}), resyncs ${r.clock.resyncs} (live ${live.clock.resyncs}), delay ${r.clock.delay}`)
  }
}
{
  // The Live page chooses: viewer.js's own lines, from SMOOTH_CLOCK to clockOptions, run for a page on
  // a local address and one through the tunnel (device.js isLocalHost), with Smooth off and on
  const { readFileSync } = await import('node:fs')
  const { isLocalHost } = await import('../public/device.js')
  const viewer = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8')
  const lines = viewer.match(/\nconst SMOOTH_CLOCK = [\s\S]*?\nconst clockOptions = [^\n]*\n/)?.[0] ?? ''
  const choose = (host, smooth) => {
    try {
      return new Function('isLocalHost', 'smoothBox', 'REMOTE_CLOCK', `${lines}\nreturn clockOptions()`)(() => isLocalHost(host), { checked: smooth }, REMOTE_CLOCK)
    } catch (e) {
      return e.message
    }
  }
  check('Live page on a local address: live\'s own clock, or Smooth, as before', choose('192.168.1.232', false) === undefined && JSON.stringify(choose('192.168.1.232', true)) === '{"startDelayMs":400,"minDelayMs":300,"maxDelayMs":1200}', `${JSON.stringify(choose('192.168.1.232', false))} ${JSON.stringify(choose('192.168.1.232', true))}`)
  const far = choose('cctv.jfl.gripe', false)
  const farSmooth = choose('cctv.jfl.gripe', true)
  check('... through the tunnel: the remote clock', far === REMOTE_CLOCK, JSON.stringify(far))
  check('... with Smooth: the remote clock, starting and staying at least as big as Smooth (400, 300)', farSmooth?.stretchLate === true && farSmooth.maxDelayMs === 2000 && farSmooth.shrinkWindowMs === REMOTE_CLOCK.shrinkWindowMs && farSmooth.startDelayMs === 400 && farSmooth.minDelayMs === 300, JSON.stringify(farSmooth))
  const tileOptions = viewer.match(/\nconst tileOptions = \(cam\) => \(\{[\s\S]*?\n\}\)\n/)?.[0] ?? ''
  check('... and its tiles keep up to 2 s of decoded frames (player.js REMOTE_QUEUED_FRAMES); a local page\'s the player\'s own', /\n {2}clock: clockOptions\(\),\n/.test(tileOptions) && /\n {2}maxQueuedFrames: REMOTE_PAGE \? REMOTE_QUEUED_FRAMES : undefined,?\n/.test(tileOptions) && /\nconst REMOTE_PAGE = !isLocalHost\(\)\n/.test(viewer))
  check('... what viewer.js uses for it is imported from where it is made', /import \{[^}]*\bisLocalHost\b[^}]*\} from '\.\/device\.js'/.test(viewer) && /import \{[^}]*\bREMOTE_CLOCK\b[^}]*\} from '\.\/playout\.js'/.test(viewer) && /import \{[^}]*\bREMOTE_QUEUED_FRAMES\b[^}]*\} from '\.\/player\.js'/.test(viewer))
}

console.log(failures ?`\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
