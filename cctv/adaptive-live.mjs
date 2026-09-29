// Live video for remote viewers, at the best frame rate their connection and the server's uplink
// can carry.
//
// Who is remote: whoever reaches the server through Tailscale -- the public Funnel link arrives
// from tailscaled on this machine (127.0.0.1), a tailnet device from 100.64.0.0/10. Everyone on the
// local network gets the cameras' own streams, untouched, as before.
//
// Each remote viewer (one browser: its sockets grouped by session) sits on one LEVEL:
//   full   the camera's own stream, as on the local network (H.265 for a browser that cannot play it:
//          converted, every frame kept, at most 1920 wide)
//   15     15 fps, re-encoded lighter (phone-live.mjs PhoneStream)
//   8      8 fps, lighter still
//   4      4 fps, the least that still shows movement
// Every 2 s the controller looks at each viewer's sockets. Video piling up means that viewer's link
// cannot keep up, and it goes down a level: what its page has queued takes more than QUEUE_S to go at
// the rate the socket drains, on two looks in a row, or a tile has been held back over its cap for
// more than HELD_MS. What a page opening or a level change queues by itself (every tile's replay, the
// first keyframes) is let go out first (GRACE_MS). Twenty seconds with nothing piling up and it goes
// back up one, longer after a climb that failed (CLIMB_FAILED_MS); a page whose sockets all closed and
// came back within REMEMBER_MS comes back one level above where it left. On top of that, when all
// remote viewers together send more than the uplink budget (CCTV_WAN_BUDGET_MBPS, 20 by default), the
// viewer taking the most is stepped down first: one person on a good link must not starve everyone else.
//
// Viewers on the same level share one conversion per camera, so the cost follows the number of
// cameras being watched remotely, not the number of people watching. Conversions have their own cap
// (phone-live.mjs maxPhoneStreams); a viewer who cannot get a slot gets the camera's own stream.
//
// A level change moves a tile without a freeze or a jump back (#retarget): it keeps its picture until
// the new stream has one, and goes over at the camera's next keyframe, where the new level's stream
// starts; it is never sent a frame older than one it has had. A sub-stream a level would only pass
// through stays on the camera's own stream (#passes).
import { PhoneStream, RATE_SAMPLES, keepEveryFor, maxPhoneStreams } from './phone-live.mjs'
import { CODEC_H265, PLAYBACK_LIMITS, TranscodePool } from './transcode.mjs'

export const LEVELS = Object.freeze([
  // The camera's own stream; its settings are for an H.265 camera and a browser that cannot play it
  // (#converts). That used to go through level 15's: a 30 fps camera played at 15 fps and 1280 wide
  // in the full-size view on a clean link ('converting a main stream at 30.0 fps to about 15: keeping
  // 1 in 2' while at full, 29 Sep 03:56:59). Now every frame (fps 0), at most 1920 wide and 2.5 Mbit/s,
  // as playback converts for the same PC (transcode.mjs PLAYBACK_LIMITS), at level 15's quality.
  { id: 'full', fps: 0, crf: 25, subKbps: 700, mainKbps: PLAYBACK_LIMITS.maxKbps, maxWidth: PLAYBACK_LIMITS.maxWidth },
  // Quality first, then frame rate: a sharp picture at 15 fps beats a blocky one at 30, and the
  // first rounds (crf 30-34, 100-300 kbit/s) came out grainy and blocky, worst on the first frames.
  { id: '15', fps: 15, crf: 25, subKbps: 700, mainKbps: 2500 },
  { id: '8', fps: 8, crf: 27, subKbps: 450, mainKbps: 1500 },
  { id: '4', fps: 4, crf: 29, subKbps: 280, mainKbps: 900 }
])
/**
 * How every level's conversion runs (stutter report 2.7). They used the phones' defaults: a 4 s encoder
 * buffer, a single-threaded H.265 decoder (low_delay) and a keyframe every 50 pictures. Measured on
 * nvr-2/20 (4K H.265, 20 fps) at level 15's size (1280 wide): keyframes 191/213 KB and 1.64-1.82x real
 * time; with a 1 s buffer and two decoder threads 151/157 KB and 2.94x, the price one picture held
 * back in the decoder (a source frame's time: 50 ms at 20 fps, more on a camera that trickles). A
 * keyframe burst is what backs a tunnel link up, and a conversion behind real time is a picture that
 * falls behind. 50 pictures was 3.3 s at 15 fps, 6.3 s at 8 and 12.5 s at 4 to wait for a picture
 * after a drop (backpressure.mjs); now 2 s of what the stream sends, at every level.
 * And how soon it starts: a new stream learnt its frame rate from 12 frames and sent nothing until
 * then, 15 s on a camera trickling at 0.8 fps (report 2.9). Now 12 frames or 1 s of their capture time,
 * whichever comes first, a sub-stream's own H.264 going out as it comes meanwhile (PhoneStream learnMs).
 * A source under 10 fps is then converted picture by picture (slowFps): the two decoder threads and
 * ffmpeg's parser held two pictures back, 2.7 s each at 0.8 fps, where one thread has time to spare.
 */
export const REMOTE_CONVERSION = Object.freeze({ bufSeconds: PLAYBACK_LIMITS.bufSeconds, lowDelay: false, keySeconds: 2, learnMs: 1000, slowFps: 10 })
export const TICK_MS = 2000
/**
 * A link that is not keeping up: what its page has queued takes longer than QUEUE_S to go at the rate
 * the page's socket drains (live-mux.mjs drainBps), on PRESSURE_LOOKS looks in a row. It was any queue
 * over 256 KB at one look, and on 29 Sep all 12 steps down said "video backing up": a page opening or
 * a level change queues more than that by itself (each tile's replay of up to 1.5 MB, 14-20 new
 * conversions' first keyframes within 90 ms), still going out at the next look 4 s later, so the next
 * step followed, and the one after: full to 4 fps in 10 s, three times (03:55:18-:28, 04:08:08-:17,
 * 04:18:05-:31; stutter report 2.1). And 256 KB is 0.05 s on the local network but 0.4 s through a
 * 5 Mbit/s tunnel: bytes say nothing without the rate they go at.
 */
export const QUEUE_S = 1
export const PRESSURE_LOOKS = 2
/** A plain /live socket has no drain meter (only a page's /live-mux socket has one): this much queued on it is over. */
export const PRESSURE_BYTES = 256 * 1024
/**
 * A tile held back over its cap for longer than this (backpressure.mjs gateSend: nothing more until its
 * next keyframe, a frozen picture) is pressure at once, in a grace too: a queue that saws around the
 * gate may never read over QUEUE_S twice in a row (verify-1).
 */
export const HELD_MS = 2000
/**
 * After a page opening or a level change, what its sockets had queued is its own start-up (the
 * replays, the new streams' first keyframes), not the link's doing: the queue is not read until those
 * bytes have gone, and for at most GRACE_MS. A page opening is what its tiles queue in its first
 * OPENING_MS (they open 15 ms apart, viewer.js: a 26-tile grid within 0.4 s). Only those two: a tile
 * opening or closing later does not start one. Under a real overload a tile with no picture for 8 s
 * reconnects (live-tile.js), and a grace for each would never let the queue be read (verify-1).
 */
export const GRACE_MS = 8000
export const OPENING_MS = 1000
/** Clean for this long before a viewer is tried one level up... */
export const CLIMB_AFTER_MS = 20_000
/**
 * ...twice as long after a climb that failed (a step down within CLIMB_FAILED_MS of it), up to
 * MAX_CLIMB_AFTER_MS, and back to CLIMB_AFTER_MS after CLIMB_RESET_MS with nothing piling up. On 29
 * Sep a climb at 04:07:46 was stepped down again at 04:08:08, and a page on a link just too slow for a
 * level tried it again every 24 s, each try a burst of new streams. Only a climb that failed counts: a
 * page knocked down by one burst must not wait minutes to come back (verify-1).
 */
export const CLIMB_FAILED_MS = 30_000
export const MAX_CLIMB_AFTER_MS = 80_000
export const CLIMB_RESET_MS = 5 * 60_000
/**
 * A viewer whose last socket closed is remembered this long, and one back within it starts one level
 * above where it left, not at full: twice on 29 Sep every socket of the page closed and came back
 * (03:55:42, 04:19:39), and it started again at full on the link that had just taken it down. Longer
 * is a new visit, at full: the owner came back after 7.5 min at 04:15:57, and a page knocked down by
 * one burst must come back whole on a reload (verify-1).
 */
export const REMEMBER_MS = 15_000
/** A level change is given this long to show its effect before another. */
export const SETTLE_MS = 4000
/**
 * A socket moved at a step down stays on its stream for the camera's next keyframe, where its new
 * level's stream starts, at most this long (verify-5: about 2.5 s): the link is backed up, and what it
 * waits on is the heavier stream. Then it goes over and waits on the new one (#switchTo).
 */
export const SWITCH_WAIT_MS = 2500
/**
 * ...and at a climb, or onto the camera's own stream, at most this long: a camera stream with no
 * keyframe for 10 s has stalled (they come every 2-4 s here).
 */
export const SWITCH_MAX_MS = 10_000
/**
 * A socket moved at once (onto a stream that runs already, or when its own stream had to close first
 * for its slot) is sent nothing older than the last frame it had, nothing until a keyframe at or past
 * it (#pass): at most this long, as a camera clock set back would hold it for ever.
 */
export const GUARD_MS = 5000

/** The uplink budget for all remote viewers together, in bytes per second. */
export function wanBudgetBps(env = process.env) {
  const m = Number(env.CCTV_WAN_BUDGET_MBPS)
  return (Number.isFinite(m) && m > 0 ? m : 20) * 1e6 / 8
}

/** A frame's header (sdk.mjs encodeFrame): keyframe or not, codec, capture time in ms; null for anything else. */
function header(buf) {
  if (!(buf instanceof Uint8Array) || buf.length <= 16) return null
  return { isKey: (buf[0] & 1) === 1, codec: buf[1], ts: Number(new DataView(buf.buffer, buf.byteOffset, 16).getBigInt64(8, true)) / 1000 }
}

/** Whether this address is a remote viewer (through Tailscale), not the local network. */
export function isRemoteAddress(addr) {
  const a = String(addr ?? '').replace(/^::ffff:/, '')
  if (a === '127.0.0.1' || a === '::1') return true // the Cloudflare tunnel (cloudflared) forwards from this machine
  const m = /^100\.(\d+)\./.exec(a)
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127) // 100.64.0.0/10, the tailnet
}

/**
 * The level a viewer starts on: the camera's own stream. Starting at 15 meant waiting for a conversion
 * to start before the first picture; the link shows within seconds whether it can carry more, and
 * the controller steps down at once if not. (An H.265 camera still gets its converted H.264 stream:
 * #streamFor.)
 */
export const startLevel = () => 0

/**
 * The next level for one viewer, from what its sockets showed this tick. Pure: the tests drive it.
 * @param {{ level: number, changedAt: number, cleanSince: number, climbAfterMs?: number, climbedAt?: number|null,
 *   pressedAt?: number|null }} v
 *   climbAfterMs: how long clean before its next climb (CLIMB_AFTER_MS, doubled by each that failed);
 *   climbedAt: its last climb, while no step down has come after it; pressedAt: its last look not clean
 * @param {{ pressure: boolean|string|null, now: number, overBudget?: boolean, starved?: boolean }} o
 *   pressure: true, or why (for the log); starved: more than half its tiles are on the camera's own
 *   stream for want of a conversion slot, which a level lower would not find either
 * @returns {{ level: number, changedAt: number, cleanSince: number, climbAfterMs: number, climbedAt: number|null,
 *   pressedAt: number|null, why?: string, stays?: string }} stays: why it would have gone down, when starved kept it
 */
export function nextLevel(v, { pressure, now, overBudget = false, starved = false }) {
  const settled = now - v.changedAt >= SETTLE_MS
  const worst = LEVELS.length - 1
  const trouble = Boolean(pressure) || overBudget
  // five minutes with nothing piling up: the climbs that failed before no longer count
  let climbAfterMs = v.climbAfterMs ?? CLIMB_AFTER_MS
  if (climbAfterMs > CLIMB_AFTER_MS && now - (v.pressedAt ?? -Infinity) >= CLIMB_RESET_MS) climbAfterMs = CLIMB_AFTER_MS
  const n = { level: v.level, changedAt: v.changedAt, cleanSince: v.cleanSince, climbAfterMs, climbedAt: v.climbedAt ?? null, pressedAt: trouble ? now : (v.pressedAt ?? null) }
  if (trouble && settled && v.level < worst) {
    const why = !pressure ? 'the uplink budget is used up' : typeof pressure === 'string' ? pressure : 'video backing up on its link'
    if (starved) return { ...n, cleanSince: pressure ? now : v.cleanSince, stays: why }
    // down within CLIMB_FAILED_MS of a climb: that climb was one too many, and the next waits twice as long
    const failed = n.climbedAt != null && now - n.climbedAt <= CLIMB_FAILED_MS
    return { ...n, level: v.level + 1, changedAt: now, cleanSince: now, climbedAt: null, climbAfterMs: failed ? Math.min(MAX_CLIMB_AFTER_MS, climbAfterMs * 2) : climbAfterMs, why }
  }
  if (pressure) return { ...n, cleanSince: now }
  if (v.level > 0 && settled && now - v.cleanSince >= climbAfterMs && !overBudget) {
    return { ...n, level: v.level - 1, changedAt: now, cleanSince: now, climbedAt: now, why: `clean for ${climbAfterMs / 1000} s` }
  }
  return n
}

/** One remote browser: its sockets and the level they are on. */
class Viewer {
  constructor(key, now, level = startLevel()) {
    this.key = key
    this.level = level
    this.changedAt = now
    this.cleanSince = now
    this.climbAfterMs = CLIMB_AFTER_MS // (nextLevel)
    this.climbedAt = null
    this.pressedAt = null
    this.stayedAt = null // the level it last said it stays at for want of conversion slots (said once a level)
    this.overLooks = 0 // looks in a row with its queue over QUEUE_S
    // its own start-up going out (GRACE_MS): marks, per socket, the bytes its link will have written
    // once what was queued then has gone; opening: taken as its tiles open, for OPENING_MS
    this.grace = { from: now, marks: new Map(), opening: true }
    this.left = new Set() // level streams its closed sockets left with nobody on them (for their 10 s)
    this.sockets = new Set() // { ws, nvrId, ch, type, source, stream, sent, lastTs, switch, ... } (attach)
    this.sentAt = 0
    this.sentBytes = 0
    this.bps = 0
  }
}

export class AdaptiveLive {
  #made = null // the stream #streamFor made last, if it made one

  constructor({ pool = new TranscodePool(maxPhoneStreams()), makeTranscoder, log = (l) => console.log(l), budgetBps = wanBudgetBps(), now = () => Date.now() } = {}) {
    Object.assign(this, { pool, makeTranscoder, log, budgetBps, now })
    this.viewers = new Map() // key -> Viewer
    this.gone = new Map() // key -> { level, at }: viewers whose last socket closed, for REMEMBER_MS
    this.streams = new Map() // `${nvr}/${ch}/${type}@${level}` -> PhoneStream
    this.rates = new Map() // `${nvr}/${ch}/${type}` -> the frame rate last read or learnt of that camera stream (#rateOf)
    this.timer = null
  }

  /**
   * Whether a socket's camera sends H.265: its stream's keyframe says, and until the stream has one,
   * what the NVR saw it send (entry.codec, nvrs.mjs codecSeen). A main started on demand has no
   * keyframe when the socket joins, and its first one, H.265, went out as it was until the next tick
   * moved the socket: a PC cannot decode it, and its full-size view fell back to the sub-stream for 2
   * minutes (viewer.js NO_MAIN_MS; stutter report 2.7). What the stream shows wins over what was seen.
   */
  #h265(entry) {
    const key = entry.source.gop?.[0]
    return key ? key[1] === 1 : entry.codec === 'h265'
  }

  /** Whether a socket's frames go through a conversion on this level. */
  #converts(entry, level) {
    // the camera's own stream where this device can play it: H.264 always; H.265 only for a device
    // that said it can (&h265=1) -- half the data of H.264 for the same picture. Otherwise an H.265
    // camera is converted at full too (every frame kept), never sent raw to a laptop that would show black.
    if (level === 0) return this.#h265(entry) && !entry.clientH265
    return !this.#passes(entry, level)
  }

  /**
   * Whether a sub-stream goes out as it is at this level: at or under its rate, nothing to thin (a
   * level's stream would pass it through: phone-live.mjs). It used to be put on that level's stream all
   * the same, and lost its picture until the camera's next keyframe: 0-2.5 s on the 11 tiles of 26 sent
   * as they were at 04:18:05 on 29 Sep (verify-5). Such a sub stays on the camera's own stream. Decided
   * once a level from the rate its camera stream already knows (#rateOf), so a reading a little either
   * side of the line (22.5 fps at 15) does not move it back and forth; not known yet, the level's stream
   * learns it as before.
   */
  #passes(entry, level) {
    if (entry.type === 0) return false // a main: a level always scales it down
    if (entry.passAt?.level === level) return entry.passAt.passes
    const fps = this.#rateOf(entry)
    if (!(fps > 0)) return false
    entry.passAt = { level, passes: keepEveryFor(fps, LEVELS[level].fps) === 1 }
    return entry.passAt.passes
  }

  /**
   * A camera stream's frame rate: from the GOP it holds, once that is 12 frames or 1 s of them (as a
   * level's stream learns it, phone-live.mjs); else the one read or learnt last (a look just after a
   * keyframe has one frame to go on); 0 when not known yet.
   */
  #rateOf(entry) {
    const key = `${entry.nvrId}/${entry.ch}/${entry.type}`
    const gop = entry.source.gop ?? []
    const first = header(gop[0])
    const last = header(gop.at(-1))
    const span = first && last ? last.ts - first.ts : 0
    if (span > 0 && (gop.length >= RATE_SAMPLES || span >= REMOTE_CONVERSION.learnMs)) this.rates.set(key, ((gop.length - 1) * 1000) / span)
    return this.rates.get(key) ?? 0
  }

  /** A level's shared stream of a socket's camera stream, as this.streams holds it. */
  #keyFor(entry, level) {
    return `${entry.nvrId}/${entry.ch}/${entry.type}@${LEVELS[level].id}`
  }

  /**
   * Where a socket's frames come from at this level: a shared converted stream, or the camera's own.
   * One it had to make is left in #made (null: none), for #retarget.
   */
  #streamFor(entry, level) {
    this.#made = null
    if (!this.#converts(entry, level)) return entry.source
    const L = LEVELS[level]
    const key = this.#keyFor(entry, level)
    let s = this.streams.get(key)
    if (!s || s.closed) {
      const slot = this.pool.acquire()
      if (!slot) return entry.source // no room for another conversion: the camera's own stream
      // level full is only ever for browsers that cannot play H.265 (#converts), so an H.265 stream
      // there is converted even with nothing to thin (h264Only); the other levels are shared with
      // browsers that can. Made for a socket with a picture, it starts at the camera's next keyframe,
      // where that socket switches to it (fromNextKey, #switchTo); the rate it learns is remembered
      // for this camera stream (#passes).
      const onRate = (fps) => this.rates.set(`${entry.nvrId}/${entry.ch}/${entry.type}`, fps)
      s = new PhoneStream({ source: entry.source, type: entry.type, slot, camera: `${entry.nvrId}/${entry.ch + 1}`, makeTranscoder: this.makeTranscoder, log: this.log, fps: L.fps, crf: L.crf, subKbps: L.subKbps, mainKbps: L.mainKbps, ...(L.maxWidth ? { maxWidth: L.maxWidth } : {}), ...REMOTE_CONVERSION, h264Only: level === 0, fromNextKey: entry.lastTs !== null, onRate, onEmpty: () => this.streams.get(key) === s && this.streams.delete(key) })
      this.streams.set(key, s)
      this.#made = s
    }
    return s
  }

  /**
   * Puts a socket on the stream it should have at this level, if it is not on it already (or on its way).
   *
   * Every move used to take the socket off its stream before the new one had a picture, and the new
   * one's first picture was older than what it had: a new conversion started from the keyframe it held,
   * a running stream replayed its GOP. The tile held, then jumped back: 0.8-1.4 s in the stutter
   * investigation's replay, 0-2.4 s by where the keyframe fell (verify-5), at every one of 29 Sep's 15
   * level changes. Now a socket is never sent a frame older than one it has had (#pass), and:
   *  - with nothing on screen yet (no frame it can show), it moves at once;
   *  - onto the camera's own stream (a climb to full, a sub a level passes through, no slot free): it
   *    keeps its stream until the camera's next keyframe and goes over there, nothing replayed (#switchTo);
   *  - onto a level's stream made for it (it starts at the camera's next keyframe, fromNextKey): it keeps
   *    its stream until then too -- at a step down for at most SWITCH_WAIT_MS, the link being backed up;
   *  - no slot free for that stream while its own conversion holds one: that one closes, the new one
   *    takes its slot, and it moves at once (verify-1: a slot given back before it is taken). It then
   *    waits for the new one's first keyframe, the camera's next;
   *  - onto a stream that runs already (another viewer's): at once, and nothing until that stream's next
   *    keyframe at or past what it had.
   * @param {{ down?: boolean }} [o] down: to send less (a step down; a tile that finds a slot at last)
   */
  #retarget(e, level, { down = false } = {}) {
    let want = this.#streamFor(e, level)
    let made = this.#made
    // no slot for its level's stream while its own conversion holds one: that one gives its slot up
    if (want === e.source && e.stream && e.stream !== e.source && this.#converts(e, level)) {
      this.#cancelSwitch(e)
      this.#leaveStream(e)
      want = this.#streamFor(e, level)
      made = this.#made
    }
    if (want === e.stream) return this.#cancelSwitch(e)
    if (e.switch?.to === want) return
    this.#cancelSwitch(e)
    if (!e.stream || e.lastTs === null || (want !== e.source && !made)) {
      this.#leaveStream(e)
      return this.#join(e, want)
    }
    this.#switchTo(e, want, { waitMs: down && want !== e.source ? SWITCH_WAIT_MS : SWITCH_MAX_MS, level })
  }

  /**
   * A socket switches to `to` at its first picture (report 2.5 (a), verify-5), meanwhile on its stream
   * as it was. Onto the camera's own stream: a tap on it watches for its next keyframe at or past what
   * the socket has, and the socket goes over as that keyframe goes out (#swap), nothing replayed. Onto a
   * level's stream made for it (PhoneStream fromNextKey, its converter already running): the socket
   * goes over at the keyframe it starts from, when its own stream reaches it (#pass: on the camera's own
   * stream that keyframe itself; from a conversion the first of its frames at or past it, as the new one
   * starts). Past waitMs it goes over at once, and waits there.
   */
  #switchTo(e, to, { waitMs, level }) {
    const sw = { to, at: this.now(), waitMs, level, tap: null }
    e.switch = sw
    if (to !== e.source) return
    // (what the camera's stream replays to the tap as it joins is the past: only what comes after counts)
    let joining = true
    sw.tap = {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      background: true, // not a viewer: the socket it stands for is one already
      send: (buf) => {
        if (joining || e.switch !== sw) return
        const f = header(buf)
        if (f?.isKey && f.ts >= e.lastTs) this.#swap(e)
        else if (this.now() - sw.at > sw.waitMs) this.#cutOver(e)
      }
    }
    e.source.add(sw.tap)
    joining = false
  }

  /**
   * The camera's keyframe going out now (the tap of #switchTo): the socket leaves its stream and joins
   * the camera's own from this keyframe on. Added as the fan-out goes (HubStream.add replay: false), it is
   * reached by it: this keyframe is its first frame there, sent once. On before the tap and the old
   * conversion's own come off: the camera's stream is never left without a viewer for a moment, which
   * would tell the NVR worker it is background (at a sub-stream limit, one a viewer's may displace).
   */
  #swap(e) {
    const sw = e.switch
    const from = e.stream
    e.switch = null
    e.stream = e.source
    this.#guard(e)
    e.ws.waitForKey = true
    e.source.add(e.ws, { replay: false })
    e.source.remove(sw.tap)
    this.#leaveStream(e, from)
  }

  /** A switch done at the new stream's start (#pass), or given up waiting for it: onto the new stream now. */
  #cutOver(e) {
    const sw = e.switch
    e.switch = null
    if (sw.tap) e.source.remove(sw.tap)
    this.#leaveStream(e)
    // (a stream made for it and closed meanwhile: whatever the level has now)
    this.#join(e, sw.to.closed ? this.#streamFor(e, sw.level) : sw.to)
  }

  /** Onto a stream now, with its replay; nothing older than what it had goes out (#guard). */
  #join(e, to) {
    e.stream = to
    this.#guard(e)
    to.add(e.ws)
  }

  /** From now on nothing older than the last frame the socket had, up to a keyframe at or past it (#pass). */
  #guard(e) {
    if (e.lastTs === null) return
    e.after = e.lastTs
    e.afterAt = this.now()
  }

  /** Off its stream (or `s`); a level's stream left with nobody on it or on the way to it closes there and then (its slot). */
  #leaveStream(e, s = e.stream) {
    if (s === e.stream) e.stream = null
    if (!s) return
    s.remove(e.ws)
    if (s !== e.source && s.clients.size === 0 && !this.#awaited(s)) s.close()
  }

  /** A switch that will not happen (another move, the socket closed): a stream made for it that nobody is on or waits for closes. */
  #cancelSwitch(e) {
    const sw = e.switch
    if (!sw) return
    e.switch = null
    if (sw.tap) e.source.remove(sw.tap)
    if (sw.to !== e.source && sw.to !== e.stream && sw.to.clients.size === 0 && !this.#awaited(sw.to)) sw.to.close()
  }

  /** Whether a socket waits to switch to this stream. */
  #awaited(s) {
    for (const v of this.viewers.values()) for (const e of v.sockets) if (e.switch?.to === s) return true
    return false
  }

  /**
   * Whether a frame goes to a socket (its ws.send). A switch waiting for the new stream's start goes
   * over here when the socket's stream reaches it (#switchTo), the frame not sent: on the camera's own
   * stream (or one sending it as it is) its next keyframe, where the new one starts; from a conversion,
   * its first frame at or past that keyframe. After a move nothing older than the last frame it had
   * goes, up to a keyframe at or past it (#guard): a stream that runs already replays its GOP from
   * before, a conversion that was made at once starts at the camera's next keyframe. For at most
   * GUARD_MS: a camera clock set back would hold it for ever.
   */
  #pass(e, f) {
    const now = this.now()
    const sw = e.switch
    if (sw && !sw.tap) {
      const own = e.stream === e.source || e.stream.passthrough // (the camera's own frames, its keyframes)
      const at = own ? f.isKey && f.ts >= e.lastTs : sw.to.startTs !== null && f.ts >= sw.to.startTs
      if (at || now - sw.at > sw.waitMs) {
        this.#cutOver(e)
        return false
      }
    }
    if (e.after === null) return true
    if (!f.isKey || (f.ts < e.after && now - e.afterAt < GUARD_MS)) return false
    e.after = null
    return true
  }

  /** How many of a viewer's tiles want a conversion at its level and are on the camera's own stream for want of a slot. */
  #raw(v) {
    let n = 0
    for (const e of v.sockets) if (this.#converts(e, v.level) && e.stream === e.source && !e.switch) n++
    return n
  }

  /**
   * Takes a remote viewer's /live socket.
   * @param {string} viewerKey one per browser (the session), so all its tiles move together
   * @param {{ codec?: 'h264'|'h265' }} o codec: what the NVR saw this camera stream send (nvrs.mjs
   *   codecSeen), for as long as the stream itself has no keyframe to say (#h265)
   */
  attach(viewerKey, { ws, nvrId, ch, type, source, clientH265 = false, codec }) {
    const now = this.now()
    let v = this.viewers.get(viewerKey)
    if (!v) this.viewers.set(viewerKey, (v = this.#arrive(viewerKey, now)))
    // lastTs: capture time of the last frame it was sent that its browser can show (#retarget); after /
    // afterAt: nothing older than this goes to it, since then (#guard); switch: a move waiting for the
    // new stream's first picture (#switchTo); passAt: whether its level sends it as it is (#passes)
    const entry = { ws, nvrId, ch, type, source, clientH265, codec, stream: null, sent: 0, lastTs: null, after: null, afterAt: 0, switch: null, passAt: null }
    // Every frame to this socket, the replay as it joins too: a move waiting to switch goes over at the
    // new stream's start, and nothing older than it had goes after one (#pass). Then the bytes, for the
    // uplink budget and the Health page, and for what a plain /live socket has written (#written).
    const send = ws.send.bind(ws)
    ws.send = (data, ...rest) => {
      const f = header(data)
      if (f && !this.#pass(entry, f)) return
      const n = data?.length ?? data?.byteLength ?? 0
      v.sentBytes += n
      entry.sent += n
      if (f && (f.codec !== CODEC_H265 || clientH265)) entry.lastTs = f.ts
      return send(data, ...rest)
    }
    entry.stream = this.#streamFor(entry, v.level)
    entry.stream.add(ws)
    v.sockets.add(entry)
    // a page opening: what its tiles queue as they open (their replays, and a stand-in's before them:
    // live-attach.mjs) is its own start-up
    if (v.grace?.opening && now - v.grace.from < OPENING_MS) v.grace.marks = this.#marks(v)
    ws.on?.('close', () => {
      this.#cancelSwitch(entry)
      const s = entry.stream
      s.remove(ws)
      v.sockets.delete(entry)
      for (const x of v.left) if (x.closed) v.left.delete(x)
      if (s !== source && s.clients.size === 0) v.left.add(s)
      if (v.sockets.size === 0) this.#leave(v)
    })
    this.#start()
  }

  /** A viewer's first socket: a new viewer, at full; or one back within REMEMBER_MS, one level above where it left. */
  #arrive(key, now) {
    const was = this.gone.get(key)
    this.gone.delete(key)
    if (!was || now - was.at > REMEMBER_MS) return new Viewer(key, now)
    const v = new Viewer(key, now, Math.max(0, was.level - 1))
    this.log(`[adaptive] ${key.slice(0, 8)}: back after ${((now - was.at) / 1000).toFixed(1)} s, at ${LEVELS[v.level].id} (it left at ${LEVELS[was.level].id})`)
    return v
  }

  /** Its last socket has closed: remembered for REMEMBER_MS. */
  #leave(v) {
    if (this.viewers.get(v.key) === v) this.viewers.delete(v.key)
    this.gone.set(v.key, { level: v.level, at: this.now() })
    // It comes back one level above, if at all: the streams its sockets left at this level would keep
    // their conversion slots for their 10 s (phone-live.mjs STOP_DELAY_MS), and the level it comes back
    // to needs them. (At full they are its H.265 conversions, the same when it comes back: they stay.)
    if (v.level > 0) for (const s of v.left) if (s.clients.size === 0) s.close()
    v.left.clear()
  }

  #move(v, level, why) {
    const from = LEVELS[v.level].id
    const down = level > v.level
    const link = this.#link(v) // what made it move, before the move changes it
    v.level = level
    // Two passes: every socket off its level stream, each stream left with nobody on it closed there
    // and then, and only then every socket onto the new level. In one pass the new level's streams took
    // their slots before the old level's had given theirs back, and a stream left empty kept its slot
    // for its 10 s (phone-live.mjs STOP_DELAY_MS) anyway: a 16-tile page stepping 15 -> 8 found 4 slots
    // free and left 12 tiles on the camera's own stream, and at 4 all 16 -- more to send, not less, so
    // the next step followed (no conversion started for 16 tiles at 03:55:28, 04:08:13, 04:08:17; verify-1).
    // With them go the streams its closed tiles left at this level, waiting out their 10 s.
    // Not off it: a socket already on this level's stream, and one with a picture, which keeps it until
    // the new one has its first (#retarget). A conversion kept so holds its slot for that while, at most
    // one keyframe interval: so the tiles that need a slot of their own go onto the new level first, and
    // those still on a conversion after them -- one that finds none free gives its own up for the new one
    // (#retarget), as the first pass did. A switch the last move left waiting is dropped first.
    const left = new Set(v.left)
    v.left.clear()
    for (const e of v.sockets) {
      this.#cancelSwitch(e)
      if (e.stream === e.source || e.stream === this.streams.get(this.#keyFor(e, level)) || e.lastTs !== null) continue
      e.stream.remove(e.ws)
      left.add(e.stream)
      e.stream = null
    }
    for (const s of left) if (s.clients.size === 0 && !this.#awaited(s)) s.close()
    const holding = new Set([...v.sockets].filter((e) => e.stream && e.stream !== e.source && !e.stream.passthrough))
    for (const e of v.sockets) if (!holding.has(e)) this.#retarget(e, level, { down })
    for (const e of holding) this.#retarget(e, level, { down })
    // what is queued now, the new streams' first pictures behind what was there, goes out first
    v.grace = { from: this.now(), marks: this.#marks(v), opening: false }
    v.stayedAt = null
    // ...and what the move got: the tiles that wanted a conversion and found no free slot
    this.log(`[adaptive] ${v.key.slice(0, 8)}: ${from} -> ${LEVELS[level].id} (${why}; ${this.#state(v, link)})`)
  }

  /**
   * The end of a level line: its cameras, its link (#link), its tiles on the raw stream for want of a
   * slot, and those that keep their picture until the new stream's first (#switchTo), when there are any.
   */
  #state(v, link) {
    const waiting = [...v.sockets].filter((e) => e.switch).length
    return `${v.sockets.size} camera${v.sockets.size === 1 ? '' : 's'}; ${link}; ${this.#raw(v)} on the raw stream for want of a conversion slot, ${this.pool.max - this.pool.active} of ${this.pool.max} free${waiting ? `; ${waiting} switching at the camera's next keyframe` : ''}`
  }

  /**
   * A viewer's link as a level change sees it, for the log: its page's queue (the largest, as the
   * pressure test reads it), how fast that drains and so how long the queue takes to go (live-mux.mjs
   * drainBps; a plain /live socket has none), and the channels held over their cap. On 29 Sep all 12
   * steps down said only "video backing up on its link", and nobody could tell which were real
   * (verify-1, correction 5).
   */
  #link(v) {
    let top = null
    let queued = -1
    let over = 0
    for (const e of v.sockets) {
      const q = e.ws.sharedBufferedAmount ?? e.ws.bufferedAmount ?? 0
      if (q > queued) [top, queued] = [e, q]
      if (e.ws.overSince != null) over++
    }
    let text = `${(Math.max(0, queued) / 1e6).toFixed(2)} MB queued`
    const bps = top?.ws.drainBps
    // no rate: nothing queued in the window, or a burst queued too lately to measure (not "idle")
    if (bps === null) text += queued > 0 ? ', draining: not measured yet' : ', draining: idle'
    else if (typeof bps === 'number') text += `, draining at ${((bps * 8) / 1e6).toFixed(1)} Mbit/s${bps > 0 ? ` (${(queued / bps).toFixed(1)} s)` : ''}`
    if (over) text += `, ${over} held over ${over === 1 ? 'its' : 'their'} cap`
    return text
  }

  /** What a socket's link has queued: for a /live-mux channel the page's whole socket, which every tile waits behind. */
  #queued(e) {
    return e.ws.sharedBufferedAmount ?? e.ws.bufferedAmount ?? 0
  }

  /**
   * What a socket's link has written, ever: the page socket's meter (live-mux.mjs writtenBytes), or for
   * a plain /live socket what it was handed through here less what still waits (only differences count).
   */
  #written(e) {
    return typeof e.ws.writtenBytes === 'number' ? e.ws.writtenBytes : e.sent - (e.ws.bufferedAmount ?? 0)
  }

  /** Per socket, the bytes its link will have written once what it has queued now has gone out. */
  #marks(v) {
    return new Map([...v.sockets].map((e) => [e, this.#written(e) + this.#queued(e)]))
  }

  /** Whether a socket's queue takes longer than QUEUE_S to go (a plain /live socket: is over PRESSURE_BYTES). */
  #over(e) {
    const q = this.#queued(e)
    if (q <= 0) return false
    if (!('drainBps' in e.ws)) return q > PRESSURE_BYTES
    // null: queued too lately to say how fast it goes (a burst just now); 0: busy and nothing written
    const bps = e.ws.drainBps
    return bps != null && q > bps * QUEUE_S
  }

  /**
   * Whether a viewer's own start-up is still going out (GRACE_MS): what its sockets had queued when its
   * page opened or its level last changed, not all written yet. Counted in bytes written, not read off
   * the queue: behind a burst the queue holds what the cameras sent meanwhile, and on a link near its
   * rate that takes many seconds more to come down than the burst itself does to go.
   */
  #inGrace(v, now) {
    const g = v.grace
    if (!g) return false
    if (g.opening && now - g.from < OPENING_MS) return true
    g.opening = false
    if (now - g.from < GRACE_MS) for (const [e, mark] of g.marks) if (v.sockets.has(e) && this.#written(e) < mark) return true
    v.grace = null
    return false
  }

  /** This look's pressure on a viewer's link: why, or null (QUEUE_S, PRESSURE_LOOKS, HELD_MS, GRACE_MS). */
  #pressure(v, now) {
    let held = 0
    for (const e of v.sockets) if (e.ws.overSince != null && now - e.ws.overSince > HELD_MS) held++
    const over = !this.#inGrace(v, now) && [...v.sockets].some((e) => this.#over(e))
    v.overLooks = over ? v.overLooks + 1 : 0
    if (v.overLooks >= PRESSURE_LOOKS) return 'video backing up on its link'
    if (held) return `${held === 1 ? 'a tile' : `${held} tiles`} held over ${held === 1 ? 'its' : 'their'} cap for more than ${HELD_MS / 1000} s`
    return null
  }

  /** One look at every remote viewer. */
  tick() {
    const now = this.now()
    for (const [key, was] of this.gone) if (now - was.at > REMEMBER_MS) this.gone.delete(key)
    let total = 0
    for (const v of this.viewers.values()) {
      const dt = v.sentAt ? (now - v.sentAt) / 1000 : 0
      v.bps = dt > 0 ? v.sentBytes / dt : 0
      v.sentBytes = 0
      v.sentAt = now
      total += v.bps
    }
    // over the budget: the one taking most goes down first
    const heaviest = total > this.budgetBps ? [...this.viewers.values()].sort((a, b) => b.bps - a.bps)[0] : null
    for (const v of this.viewers.values()) {
      // a switch still waiting past its time (its stream sent nothing to go over on: held over its cap,
      // or the camera stalled): over now (#switchTo)
      for (const e of v.sockets) if (e.switch && now - e.switch.at > e.switch.waitMs) this.#cutOver(e)
      // overSince: backpressure.mjs gateSend sets it while the socket is over its cap (and clears it
      // once it drains). waitForKey is not used: a move sets it on purpose. A /live-mux channel's own
      // bufferedAmount is only its part of the page's socket: the whole socket's queue
      // (sharedBufferedAmount) is what every tile of the page waits behind.
      const pressure = this.#pressure(v, now)
      // more than half its tiles already on the camera's own stream for want of a slot: a level lower
      // would find no more slots than this one and thin none of them (verify-1)
      const n = nextLevel(v, { pressure, now, overBudget: v === heaviest, starved: this.#raw(v) * 2 > v.sockets.size })
      if (n.level !== v.level) this.#move(v, n.level, n.why)
      else {
        // The camera's own stream only where it is H.264: an H.265 one would be black on a laptop
        // without the HEVC codec (#streamFor converts it). A camera found to be H.265 only after its
        // socket was attached (no keyframe then, and no codec the NVR had seen) moves to its conversion
        // here -- that socket alone -- and one whose keyframe shows H.264 after all moves back to its
        // own stream. This used to move the whole viewer to 15 fps: every tile of the browser went through
        // a conversion because one full-screen main stream was H.265 (slow starts, 15 fps, the
        // converters swamped: 'full -> 15 (undefined; 66 cameras)' in the log, 2026-09-26).
        // Below full, a tile left on the camera's own stream for want of a slot tries again: one may
        // have come free since. It stayed raw for as long as the page stayed on that level (verify-1).
        // (Going there is sending less, as a step down: SWITCH_WAIT_MS.)
        for (const e of v.sockets) if (v.level === 0 || e.stream === e.source) this.#retarget(e, v.level, { down: v.level > 0 })
        if (n.stays && v.stayedAt !== v.level) {
          v.stayedAt = v.level
          this.log(`[adaptive] ${v.key.slice(0, 8)}: stays at ${LEVELS[v.level].id}, a level lower would find no conversion slot either (${n.stays}; ${this.#state(v, this.#link(v))})`)
        }
      }
      v.changedAt = n.changedAt
      v.cleanSince = n.cleanSince
      v.climbAfterMs = n.climbAfterMs
      v.climbedAt = n.climbedAt
      v.pressedAt = n.pressedAt
    }
    this.lastTotalBps = total
  }

  #start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      try { this.tick() } catch (e) { this.log(`[adaptive] ${e.message}`) }
    }, TICK_MS)
    this.timer.unref?.()
  }

  /** For the Health page: the remote viewers, their levels and what they are sent. */
  summary() {
    const viewers = [...this.viewers.values()].map((v) => ({ level: LEVELS[v.level].id, cameras: v.sockets.size, bps: Math.round(v.bps) }))
    return {
      viewers,
      remoteBps: Math.round(viewers.reduce((a, v) => a + v.bps, 0)),
      budgetBps: this.budgetBps,
      conversions: [...this.streams.values()].filter((s) => !s.closed && !s.passthrough).length,
      conversionCap: this.pool.max
    }
  }
}
