// Offline replay of 2x and 4x through the real player (public/player.js) and playout clock
// (public/playout.js), in virtual time, with stand-ins for the server's pacer, the link and the
// viewing PC's hardware decoder.
//
// The decoder is the point (smoothness report, cause 5). Chrome's hardware decoder on the viewing PC
// hands the page only a few decoded frames at a time -- 6 at 2560x1440 -- and decodes nothing more
// until the page closes one. The player keeps its buffer as decoded frames, so a buffer holding more
// frames than that stalls the decoder; the frames behind it wait in its decode queue, and past 12 the
// player drops them and waits for the next keyframe (player.js MAX_DECODE_QUEUE): the picture jumps
// 2 s ahead. A speed change used to put the frames already buffered a whole buffer later, which at 2x
// and 4x is more decoded frames than the decoder hands out.
//
// The model: a camera at 2560x1440 (the size of the value4u cameras the report measured) at 15 fps,
// or 25 and 30 where a case says so (the frame rates are assumed; the site has 30 fps cameras), with a
// keyframe every 2 s; the server sends each frame at its media time / speed on a 15 ms tick
// (rec-playback.mjs) and re-anchors its pacer where it is when a speed command reaches it; the link
// delays every frame (in order) and every command; the decoder takes 8 ms a frame, one at a time,
// while the page holds fewer than 6; the display refreshes at 60 Hz; the player's once-a-second
// timer (the clock's adapt) runs every virtual second.
//   node cctv/test/playout-speed.test.mjs
import { PLAYBACK_CLOCK } from '../public/playout.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const POOL = 6 // decoded frames the page may hold (the viewing PC's decoder at 2560x1440)
const DECODE_MS = 8
const REFRESH_MS = 1000 / 60
const PACER_TICK_MS = 15
const TS0 = 1_700_000_000_000 // capture times are the server's clock (epoch ms)

// ---- stand-ins for the page ----------------------------------------------------------------------
let vnow = 0
globalThis.performance = { now: () => vnow }
globalThis.window = { devicePixelRatio: 1 }
globalThis.requestAnimationFrame = () => 1 // the replay calls present() on its own 60 Hz
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.EncodedVideoChunk = class {
  constructor(init) {
    Object.assign(this, init)
  }
}
const timers = [] // the player's once-a-second timer, run on virtual seconds
globalThis.setInterval = (fn) => timers.push(fn)
globalThis.clearInterval = () => {}

let open = 0 // decoded frames the page holds (not closed)
const decodedUs = new Set() // timestamps of every frame the decoder put out
class Frame {
  constructor(timestamp) {
    this.timestamp = timestamp
    this.displayWidth = this.codedWidth = 2560
    this.displayHeight = this.codedHeight = 1440
    this.visibleRect = { x: 0, y: 0, width: 2560, height: 1440 }
    this.closed = false
    open++
  }
  clone() {
    return new Frame(this.timestamp)
  }
  close() {
    if (this.closed) return
    this.closed = true
    open--
  }
}
let decoder = null
globalThis.VideoDecoder = class {
  static async isConfigSupported(config) {
    return { supported: true, config }
  }
  constructor({ output }) {
    this.output = output
    this.state = 'unconfigured'
    this.pending = []
    this.busy = null // { chunk, doneAt }: the frame being decoded
    decoder = this
  }
  get decodeQueueSize() {
    return this.pending.length + (this.busy ? 1 : 0)
  }
  configure() {
    this.state = 'configured'
  }
  decode(chunk) {
    this.pending.push(chunk)
  }
  reset() {
    this.pending = []
    this.busy = null
    this.state = 'unconfigured'
  }
  close() {
    this.reset()
    this.state = 'closed'
  }
  /** Decodes on at `now`: one frame at a time, and only into a free picture buffer. */
  pump(now) {
    let progress = true
    while (progress && this.state === 'configured') {
      progress = false
      if (this.busy && now >= this.busy.doneAt) {
        const { chunk } = this.busy
        this.busy = null
        decodedUs.add(chunk.timestamp)
        this.output(new Frame(chunk.timestamp))
        progress = true
      }
      if (!this.busy && this.pending.length && open < POOL) {
        this.busy = { chunk: this.pending.shift(), doneAt: now + DECODE_MS }
        progress = true
      }
    }
  }
  nextAt() {
    return this.busy ? this.busy.doneAt : Infinity
  }
}
const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), getBoundingClientRect: () => ({ width: 1280, height: 720 }) }
const { VideoPlayer } = await import('../public/player.js')

/** A seeded pseudo-random source, so every run replays the same jitter. */
function random(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
}

/**
 * Plays `plan` ([{ at: ms, speed }], the first at 0) from an `fps` camera until `endMs`, over a link
 * with one-way delay `latencyMs` plus up to `jitterMs`. Returns, per step of the plan, the frames the
 * server sent at that speed and how many of them were decoded and shown; how long the picture stood
 * still at each change; the buffer at the end; and how far ahead each frame arrived (leads).
 */
async function replay({ plan, endMs, latencyMs, jitterMs, clock = PLAYBACK_CLOCK, fps = 15 }) {
  const FRAME_MS = 1000 / fps
  const GOP = 2 * fps // frames: a keyframe every 2 s
  vnow = 0
  open = 0
  decoder = null
  decodedUs.clear()
  timers.length = 0
  const rnd = random(11)
  const shown = [] // { at, ts }
  const leads = [] // { at, lead, delay }: each frame as it arrives, and the buffer then
  const player = new VideoPlayer(canvas, { clock, onFrame: (ts) => shown.push({ at: vnow, ts }) })

  // the server's pacer
  const server = { speed: 1, anchor: null, next: 0, switches: [] } // switches: media time where each speed began
  const frameTs = (i) => TS0 + i * FRAME_MS
  const media = (t) => server.anchor.media + (t - server.anchor.wall) * server.speed
  const inFlight = [] // { at, i }: frames on the link, in order
  const commands = [] // { at, speed }: speed commands on their way to the server
  let lastArrival = 0

  let step = 0 // plan steps applied by the page
  let nextTick = 0
  let nextRefresh = REFRESH_MS
  let nextSecond = 1000
  const drainUntil = endMs + 3000 // the server stops at endMs; what is buffered still plays
  while (vnow <= drainUntil) {
    // the page asks for a new speed: the player at once, the server when the command arrives
    while (step < plan.length && plan[step].at <= vnow) {
      const { speed } = plan[step++]
      if (step > 1) {
        player.setRate(speed)
        commands.push({ at: vnow + latencyMs, speed })
      } else server.switches.push({ speed, media: frameTs(0) })
    }
    while (commands.length && commands[0].at <= vnow) {
      const { speed } = commands.shift()
      const m = media(vnow)
      server.anchor = { wall: vnow, media: m }
      server.speed = speed
      server.switches.push({ speed, media: m })
    }
    if (vnow >= nextTick) {
      nextTick += PACER_TICK_MS
      if (vnow < endMs) {
        server.anchor ??= { wall: vnow, media: frameTs(0) }
        const m = media(vnow)
        while (frameTs(server.next) <= m) {
          lastArrival = Math.max(lastArrival, vnow + latencyMs + rnd() * jitterMs)
          inFlight.push({ at: lastArrival, i: server.next++ })
        }
      }
    }
    while (inFlight.length && inFlight[0].at <= vnow) {
      const { i } = inFlight.shift()
      // how far ahead of its display time each frame arrives (the decoder must hold that much)
      if (player.clock.anchor !== null) leads.push({ at: vnow, lead: player.clock.presentAt(frameTs(i)) - vnow, delay: player.clock.delay })
      player.push({ isKey: i % GOP === 0, codecId: 0, timestampUs: Math.round(frameTs(i) * 1000), data: new Uint8Array(8) })
      while (player.configuring) await new Promise((r) => setImmediate(r))
    }
    decoder?.pump(vnow)
    if (vnow >= nextRefresh) {
      nextRefresh += REFRESH_MS
      player.present(vnow)
      decoder?.pump(vnow)
    }
    if (vnow >= nextSecond) {
      nextSecond += 1000
      for (const fn of timers) fn()
    }
    vnow = Math.min(nextTick, nextRefresh, nextSecond, plan[step]?.at ?? Infinity, commands[0]?.at ?? Infinity, inFlight[0]?.at ?? Infinity, decoder?.nextAt() ?? Infinity)
  }

  // per speed: the frames sent at it (by media time), how many of them were decoded (the rest were
  // dropped by the player's decode-queue guard or skipped waiting for a keyframe) and how many shown
  // (a decoded frame is not shown when a later one is due by the same display refresh: it came late)
  const sent = server.next
  const shownTs = new Set(shown.map((s) => Math.round(s.ts)))
  const steps = server.switches.map((sw, k) => {
    const to = server.switches[k + 1]?.media ?? Infinity
    let frames = 0
    let decoded = 0
    let seen = 0
    for (let i = 0; i < sent; i++) {
      const ts = frameTs(i)
      if (ts < sw.media || ts >= to) continue
      frames++
      if (decodedUs.has(Math.round(ts * 1000))) decoded++
      if (shownTs.has(Math.round(ts))) seen++
    }
    return { speed: sw.speed, frames, decoded, shown: seen }
  })
  // how long the picture stood still across each speed change the page made
  const holds = plan.slice(1).map(({ at }) => {
    const k = shown.findIndex((s) => s.at > at)
    return k > 0 ? Math.round(shown[k].at - shown[k - 1].at) : Infinity
  })
  const result = { steps, holds, delay: player.clock.delay, leads }
  player.close()
  return result
}

const say = (r) => r.steps.map((s) => `${s.speed}x ${s.shown}/${s.frames} shown (${s.decoded} decoded)`).join(', ') + `; held ${r.holds.join('/')} ms at the changes; buffer ${r.delay} ms`
const holdMs = (fps = 15) => 1000 / fps + REFRESH_MS + 1 // at most one 1x frame's time (shown on the next refresh)
const HOLD_MS = holdMs()

const SITE = { name: 'on site', latencyMs: 3, jitterMs: 4 }
const TUNNEL = { name: 'through the tunnel', latencyMs: 60, jitterMs: 40 }
// the playback buffer as it starts (300 ms), and as it is after late frames have grown it
const BUFFERS = [PLAYBACK_CLOCK.startDelayMs, 600]

// ---- 1x, then 2x for 15 s ----------------------------------------------------------------------------
// (before this change: 2x from a 600 ms buffer showed 274-275 of 448-449 frames, and every change
// held the picture 317-650 ms; from 300 ms every frame was shown, after the hold)
for (const link of [SITE, TUNNEL]) {
  for (const buffer of BUFFERS) {
    const r = await replay({ plan: [{ at: 0, speed: 1 }, { at: 6000, speed: 2 }], endMs: 21_000, clock: { ...PLAYBACK_CLOCK, startDelayMs: buffer }, ...link })
    const x2 = r.steps.find((s) => s.speed === 2)
    check(`2x ${link.name}, ${buffer} ms buffer: every frame shown`, x2.frames > 400 && x2.shown === x2.frames, say(r))
    check('  the picture holds no longer than a frame at the change', r.holds.every((h) => h <= HOLD_MS), say(r))
  }
}

// ---- 1x, 2x for 6 s, 4x for 10 s, back to 1x --------------------------------------------------------
// (before: 4x showed 172-252 of 600 frames, and the 1x after it lost a keyframe interval)
// Back at 1x, the frames the server still sends at 4x are played at up to 4x (PlayoutClock.arrived),
// so the buffer keeps the frames it had. At 15 fps 4x is 60 frames a second, a 60 Hz display's every
// refresh, and the picture is brought forward as each frame arrives, on the link's jitter: now and
// then two of them fall due by the same refresh and the display shows the newer. So 4x is counted as
// decoded, with no more than 1% of it skipped by the display; 1x and 2x must show every frame.
for (const link of [SITE, TUNNEL]) {
  for (const buffer of BUFFERS) {
    const plan = [{ at: 0, speed: 1 }, { at: 6000, speed: 2 }, { at: 12_000, speed: 4 }, { at: 22_000, speed: 1 }]
    const r = await replay({ plan, endMs: 28_000, clock: { ...PLAYBACK_CLOCK, startDelayMs: buffer }, ...link })
    const x4 = r.steps.find((s) => s.speed === 4)
    check(`2x, 4x, 1x ${link.name}, ${buffer} ms buffer: every frame decoded (none dropped for the decoder)`, x4.frames > 500 && r.steps.every((s) => s.decoded === s.frames), say(r))
    check('  no hold longer than a frame at a change', r.holds.every((h) => h <= HOLD_MS), say(r))
    if (link === TUNNEL && buffer === PLAYBACK_CLOCK.startDelayMs) {
      // The one case short of every frame. The next frame keeps its time and the buffer then plays 4x
      // as fast, while the frames already on their way were sent at 2x: the command's round trip
      // (about 140 ms here) is longer than the buffer lasts at 4x (75 ms), so the frames right after
      // the change come late and some arrive by the same refresh as the next (the display shows the
      // newer). adapt() grows the buffer after the 1.5 s warm-up and it is even again. The old change
      // held a whole buffer and showed 252 of these 600 frames instead (235 never decoded).
      check('  4x from the smallest buffer through the tunnel: over 90% shown, the rest late, not lost', x4.shown >= 0.9 * x4.frames && r.steps.filter((s) => s !== x4).every((s) => s.shown === s.frames), say(r))
    } else check('  every 1x and 2x frame shown, and 99% of 4x', x4.shown >= 0.99 * x4.frames && r.steps.filter((s) => s !== x4).every((s) => s.shown === s.frames), say(r))
  }
}

// ---- 25 and 30 fps, and a slower tunnel: 2x, 4x, then a long run of 1x --------------------------------
// At 15 fps the decoder's 6 frames and the 12 the player lets wait for it (player.js MAX_DECODE_QUEUE)
// are 1.2 s of video; at 25 fps 720 ms, at 30 fps 600 ms. A slow-down is where that bites. The frames
// the server sends at 4x until the command reaches it keep coming for a round trip, and each is shown
// at 1x: with the next frame keeping its time they arrived 4 x the lead at 4x + 3 x the round trip
// ahead, 656-697 ms at 30 fps through the tunnel. That is more than the decoder holds, but under the
// 780 ms (delay + behindMs) at which the clock re-syncs, and the clock only sees a frame once it is
// decoded, when it is at most 6 frames ahead. So the decoder overflowed, the player dropped to the
// next keyframe, and the next keyframe interval did the same, for good: 1x after 4x showed 342 of 1138
// frames at 30 fps through the tunnel from a 300 ms buffer, and 342 of 947 at 25 fps through a
// 90 ms tunnel from 600 ms. (The old whole-buffer hold landed above 780 ms and re-synced: 1086 of
// 1138 and 831 of 947.)
//
// At 4x (100 and 120 frames a second) a 60 Hz display cannot show every frame, and neither can 2x at
// 30 fps quite, so those count as decoded; every 1x frame, before and after, must be shown.
// Not here: 30 fps from a 600 ms buffer. That is the decoder's whole 600 ms, and through the tunnel it
// loses frames at 1x before any speed change, with or without this; keeping fewer frames decoded
// (report cause 5, fix b) is what fixes it.
const SLOW_TUNNEL = { name: 'through a slower tunnel', latencyMs: 90, jitterMs: 40 }
const DECODER_FRAMES = POOL + 12 // decoded, and waiting to be decoded, before the player drops to a keyframe
for (const [fps, buffers] of [[25, BUFFERS], [30, [PLAYBACK_CLOCK.startDelayMs]]]) {
  for (const link of [SITE, TUNNEL, SLOW_TUNNEL]) {
    for (const buffer of buffers) {
      const plan = [{ at: 0, speed: 1 }, { at: 6000, speed: 2 }, { at: 12_000, speed: 4 }, { at: 22_000, speed: 1 }]
      const r = await replay({ plan, endMs: 60_000, fps, clock: { ...PLAYBACK_CLOCK, startDelayMs: buffer }, ...link })
      const lead = (from) => Math.round(Math.max(...r.leads.filter((l) => l.at > from).map((l) => l.lead)))
      const over = (from) => Math.round(Math.max(...r.leads.filter((l) => l.at > from).map((l) => l.lead - l.delay)))
      const x1 = r.steps.filter((s) => s.speed === 1)
      const tell = `${say(r)}; arriving up to ${lead(22_000)} ms ahead after the slow-down; from 2 s after it up to ${lead(24_000)} ms, ${over(24_000)} ms beyond the buffer`
      check(`${fps} fps, 2x, 4x, then 38 s of 1x ${link.name}, ${buffer} ms buffer: every frame decoded (none dropped for the decoder)`, x1.at(-1).frames > 900 && r.steps.every((s) => s.decoded === s.frames), tell)
      check('  every 1x frame shown, before and after', x1.every((s) => s.shown === s.frames), tell)
      check('  after the slow-down no frame arrives further ahead than the decoder holds', lead(22_000) < (DECODER_FRAMES * 1000) / fps, tell)
      check('  from 2 s after it no frame arrives further ahead than the buffer and the link jitter', over(24_000) <= link.jitterMs + PACER_TICK_MS, tell)
      check('  no hold longer than a frame at a change', r.holds.every((h) => h <= holdMs(fps)), tell)
    }
  }
}

// ---- 1x and 4x in turn, 3 s each ------------------------------------------------------------------
// Through the tunnel the 4x frames come just in time, so a slow-down can find every decoded frame shown
// and nothing buffered. setRate then changed only the rate: the next frame re-synced a whole buffer
// ahead, the catch-up never started, and the 4x frames still coming piled up on top of it. With the
// catch-up alone that dropped 13-311 frames for the decoder in 8 of these 10 runs, with holds of
// 467-800 ms; the clock before either dropped 25-392 in 4 of them. Now the newest decoded frame keeps
// its time.
const TOGGLE = [{ at: 0, speed: 1 }, { at: 6000, speed: 4 }, { at: 9000, speed: 1 }, { at: 12_000, speed: 4 }, { at: 15_000, speed: 1 }]
for (const [fps, buffers] of [[15, BUFFERS], [25, BUFFERS], [30, [PLAYBACK_CLOCK.startDelayMs]]]) {
  for (const link of [TUNNEL, SLOW_TUNNEL]) {
    for (const buffer of buffers) {
      const r = await replay({ plan: TOGGLE, endMs: 35_000, fps, clock: { ...PLAYBACK_CLOCK, startDelayMs: buffer }, ...link })
      const x1 = r.steps.filter((s) => s.speed === 1)
      const sum = (k) => x1.reduce((n, s) => n + s[k], 0)
      const tell = `${say(r)}; 1x ${sum('shown')}/${sum('frames')} shown`
      check(`1x and 4x in turn, ${fps} fps ${link.name}, ${buffer} ms buffer: every frame decoded (none dropped for the decoder)`, r.steps.every((s) => s.decoded === s.frames), tell)
      check('  no hold longer than a frame at a change', r.holds.every((h) => h <= holdMs(fps)), tell)
      // (the 1x frames still coming when the page asks for 4x are shown at 4x, where a 60 Hz display skips some)
      check('  98% of the 1x frames shown', sum('shown') >= 0.98 * sum('frames'), tell)
    }
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
