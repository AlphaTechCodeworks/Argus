// The playback page's pure logic (no DOM), for playback from the server's recordings (phase 3):
// the server's and the NVR's recordings merged into one list of stretches, lookups on it, the
// choice between server and NVR playback for a day, going over to the NVR when the server cannot
// read its recordings, the scrub throttle, the clock-skew hint and the conversions between the two
// time bases. Tested offline: test/pb-sources.test.mjs.
//
// Time bases: server footage is stamped with the server's clock, NVR footage with the NVR's, and
// the NVR's clock differs by skewMs (NVR clock - server clock; nvr1 runs about 3 min 40 s fast).
// In server mode the page works in server time only: NVR times are converted with -skewMs.

/** Speeds of server playback (reverse and 8x+ send keyframes only) and of NVR playback. */
export const SERVER_SPEEDS = Object.freeze([-32, -16, -8, -4, -2, -1, 1, 2, 4, 8, 16, 32])
export const NVR_SPEEDS = Object.freeze([1, 2, 4, 8])

/** Ranges [[s, e, ...rest]] moved by ms (a copy; extra fields such as an event type are kept). */
export function shift(ranges, ms) {
  return (ranges ?? []).map(([s, e, ...rest]) => [s + ms, e + ms, ...rest])
}

/** Sorted copy of [[s, e]] with overlapping or touching ranges joined. */
function joined(ranges) {
  const out = []
  for (const [s, e] of [...(ranges ?? [])].filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1)
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** How far behind the server's clock its newest footage on disk is taken to be (frames still on their way). */
export const LIVE_MARGIN_MS = 1000

/**
 * The live edge: the newest moment the server has recorded while the file being written grows,
 * estimated from the timeline's `now` (the server's clock when it answered, received at page time
 * receivedAt, performance.now()) plus the page time since (perfNow), less LIVE_MARGIN_MS.
 */
export function liveEdge(tlNow, receivedAt, perfNow, marginMs = LIVE_MARGIN_MS) {
  return tlNow + Math.max(0, perfNow - receivedAt) - marginMs
}

/**
 * The day as stretches [{ s, e, src: 'server'|'nvr' }] in time order: the server's ranges, and the
 * NVR's ranges minus the server's (the stretches only the NVR has). NVR pieces under minMs are
 * dropped: at the edges of server footage they are clock jitter, not footage worth a leg.
 * Both inputs in the same time base (shift the NVR's by -skewMs first).
 * liveTo (today, when the server's last range is the file being written): that range ends at liveTo,
 * the live edge (liveEdge), and nothing after liveTo counts: the NVR's footage beyond it is being
 * recorded by the server too, and later times are not recorded yet.
 */
export function mergeSources(server, nvr, { minMs = 2000, liveTo = null } = {}) {
  const S = joined(server)
  const live = liveTo !== null && S.length > 0
  if (live) S[S.length - 1][1] = Math.max(S[S.length - 1][0], liveTo)
  const N = live ? joined(nvr).map(([s, e]) => [s, Math.min(e, liveTo)]).filter(([s, e]) => e > s) : joined(nvr)
  const out = S.map(([s, e]) => ({ s, e, src: 'server' }))
  for (const [ns, ne] of N) {
    let from = ns
    for (const [s, e] of S) {
      if (e <= from) continue
      if (s >= ne) break
      if (s > from && s - from >= minMs) out.push({ s: from, e: s, src: 'nvr' })
      from = Math.max(from, e)
      if (from >= ne) break
    }
    if (ne - from >= minMs && from < ne) out.push({ s: from, e: ne, src: 'nvr' })
  }
  return out.sort((a, b) => a.s - b.s || a.e - b.e)
}

/** The stretch at t: the one with s <= t < e, else one ending exactly at t; null in a hole. */
export function stretchAt(list, t) {
  let end = null
  for (const x of list ?? []) {
    if (x.s <= t && t < x.e) return x
    if (x.e === t) end = x
  }
  return end
}

/** The first recorded moment at or after t (t itself when recorded), or null. */
export function recordedFrom(list, t) {
  for (const x of list ?? []) {
    if (t < x.s) return x.s
    if (t <= x.e) return t
  }
  return null
}

/** The first stretch that starts after t, or null. */
export function nextStretch(list, t) {
  return (list ?? []).find((x) => x.s > t) ?? null
}

/**
 * The time the player skips to after {type:'started'} (player.skipUntil), or null. Only a start from
 * the server's files at 1x-4x has a preroll (from < at): the frames from the keyframe before `at`,
 * sent at once. Keyframe speeds and reverse start at the keyframe (at === from), and an NVR leg
 * (src 'nvr') is paced by the NVR: skipping there would hold the poster for up to a keyframe interval.
 */
export function prerollUntil(msg) {
  if (msg?.src !== 'server' || !Number.isFinite(msg.at) || !Number.isFinite(msg.from)) return null
  return msg.from < msg.at ? msg.at : null
}

/** Why the server did not record at t (a recorder gap [s, e, reason]), or null outside every gap. */
export function gapAt(gaps, t) {
  const g = (gaps ?? []).find(([s, e]) => s <= t && t <= e)
  return g ? (g[2] || 'not recorded') : null
}

// ---- what this viewer may play of a camera (stream rights) -------------------------------------------
// /api/cameras?for=playback sends, per camera, sd (the NVR's copy: Playback SD), hd (the server's
// recordings: Playback HD), nvrHd (the NVR's main stream: Playback SD with Live HD or Playback HD) and
// legs (the server's gaps from the NVR). The page offers only what the server will play; the server
// decides again every time.

/** Everything, as before these flags: a camera from a server that sends none (an older release). */
export const ALL_RIGHTS = Object.freeze({ sd: true, hd: true, nvrHd: true, legs: true })

/** A camera's playback rights from its /api/cameras?for=playback entry. */
export function pbRights(cam) {
  if (!cam || typeof cam.sd !== 'boolean' || typeof cam.hd !== 'boolean') return ALL_RIGHTS
  return { sd: cam.sd, hd: cam.hd, nvrHd: cam.sd && cam.nvrHd === true, legs: cam.sd && cam.hd && cam.legs === true }
}

/** NVR mode's quality menu: SD, and HD only for someone who may see the NVR's main stream. */
export function nvrQualityOptions({ nvrHd }) {
  return nvrHd ? [[1, 'SD (light)'], [0, 'HD']] : [[1, 'SD (light)']]
}

/**
 * The camera wall's Quality menu from the chosen cameras' rights: "SD (NVR sub-streams)" when one of
 * them may play the NVR's copy, "HD (server recordings)" when one may play the server's. The value is
 * the current choice while it is offered, else the first offered (HD for a wall of HD-only cameras).
 * With no camera chosen yet, both, as before.
 * @param {Array<{ sd: boolean, hd: boolean }>} rights
 * @param {'sd'|'hd'} current
 * @returns {{ options: Array<[string, string]>, value: 'sd'|'hd' }}
 */
export function wallQualities(rights, current) {
  const any = (k) => rights.length === 0 || rights.some((r) => r[k])
  const options = [...(any('sd') ? [['sd', 'SD (NVR sub-streams)']] : []), ...(any('hd') ? [['hd', 'HD (server recordings)']] : [])]
  const value = options.some(([v]) => v === current) ? current : (options[0]?.[0] ?? current)
  return { options, value }
}

/**
 * Where one wall tile's pictures come from. Playback HD only: always the server's recordings (the
 * tile says so when there are none); Playback SD only: always the NVR's sub-stream; both: the wall's
 * Quality, the server's only when it has this camera's recordings in a codec this browser plays.
 * @returns {'server'|'nvr'}
 */
export function wallTileMode({ rights, quality, available, codec, h265 }) {
  if (!rights.sd) return 'server'
  if (quality === 'hd' && rights.hd && available && !(codec === 'h265' && !h265)) return 'server'
  return 'nvr'
}

/**
 * Server or NVR playback for a day (plan R6): server when the timeline is available, the day has
 * server footage, the browser can decode its codec and the viewer has not chosen "SD (NVR)".
 * @param {{ timeline: object|null, h265: boolean, quality?: 'server'|'original'|'sd-nvr', rights?: object }} o
 *   quality 'original': a remote viewer's "Original (server)" (serverQualityOptions); rights: pbRights
 *   of the camera (default: everything)
 * @returns {{ mode: 'server'|'nvr'|'none', transcode?: boolean, original?: boolean, why: string }} why:
 *   a sentence for the viewer; transcode: the server will convert the H.265 recording to H.264 because
 *   this browser cannot decode it; original: ask the server for the recording itself (&original=1);
 *   'none': no Playback SD and nothing on the server (never NVR mode without Playback SD)
 */
export function pickMode({ timeline, h265, quality, rights = ALL_RIGHTS }) {
  const original = quality === 'original'
  // without Playback SD the NVR's copy is not this viewer's: a day without the server's footage has none
  const none = (why) => ({ mode: 'none', why })
  if (!timeline?.available) return rights.sd ? { mode: 'nvr', why: 'Server recordings are not available for this camera.' } : none('This camera has no recordings on this server that you may play back.')
  if (quality === 'sd-nvr' && rights.sd) return { mode: 'nvr', why: 'SD (NVR) chosen.' }
  if (!timeline.ranges?.length) return rights.sd ? { mode: 'nvr', why: 'The server has no recordings of this camera on this day.' } : none('The server has no recordings of this camera on this day.')
  if (timeline.codec === 'h265' && !h265) {
    // This browser has no H.265 decoder (on Windows that is the normal state of affairs, because
    // Chrome and Edge need a codec from the Microsoft Store that Windows does not ship). The server
    // converts the recording to H.264 as it plays it, which keeps the full recorded resolution;
    // falling back to the NVR's SD stream instead would throw the detail away. The socket says
    // &h265=0 and the server does the rest (transcode.mjs); if it is too busy to convert, it says
    // so and the viewer can still pick "SD (NVR)" by hand.
    return { mode: 'server', transcode: true, original, why: 'This recording is H.265, which this browser cannot decode: the server is converting it to H.264 as it plays.' }
  }
  return { mode: 'server', transcode: false, original, why: 'Server recordings.' }
}

// ---- a remote viewer: the recording converted to fit the link, or the recording itself -------------------
// Through the Cloudflare tunnel one connection carried 3.5-6.5 Mbit/s, and a 4.2 Mbit/s main stream
// froze 22 times a minute (smoothness report, cause 3). The server converts a remote viewer's
// playback to at most 1920 wide and 2.5 Mbit/s while it has a conversion free, and tells the page
// ({type:'fit'}, rec-playback.mjs); who is remote is the server's call (the socket's address), so
// the page learns it from that message.

/**
 * The quality menu with the server's recordings. On the local network "HD (server)" is the recording
 * itself, as before. A remote viewer gets the copy converted to fit the link by default, "HD
 * (server, light)", and can still choose the recording itself, "Original (server)".
 * @param {{ remote: boolean, nvrLabel?: string, sd?: boolean }} o nvrLabel: "SD (NVR)", or "HD (NVR)"
 *   for a camera the NVR records in HD only; sd: the viewer may play the NVR's copy (Playback SD);
 *   without it "SD (NVR)" is not offered
 * @returns {Array<[string, string]>} [value, label]
 */
export function serverQualityOptions({ remote, nvrLabel = 'SD (NVR)', sd = true }) {
  const options = remote
    ? [['server', 'HD (server, light)'], ['original', 'Original (server)'], ['sd-nvr', nvrLabel]]
    : [['server', 'HD (server)'], ['sd-nvr', nvrLabel]]
  return sd ? options : options.filter(([v]) => v !== 'sd-nvr')
}

/** The server socket's own parameters: what this browser decodes, and whether the recording itself was chosen. */
export function serverSocketQuery({ h265, original = false }) {
  return `h265=${h265 ? 1 : 0}${original ? '&original=1' : ''}`
}

/**
 * The page's note of a {type:'fit'} message: 'on' (converted to fit the link), 'busy' (no
 * conversion free: the recording itself, until the next jump), 'fits' (the recording is within the
 * cap already: sent as it is) or 'original' (the viewer chose it); and what to tell the viewer, only
 * when that changes (the server says it again at every seek).
 * @param {'on'|'busy'|'fits'|'original'|null} prev
 * @param {{ on?: boolean, busy?: boolean, fits?: boolean }} msg
 * @returns {{ fit: 'on'|'busy'|'fits'|'original', notice: string|null }}
 */
export function fitChange(prev, msg) {
  const fit = msg?.on ? 'on' : msg?.busy ? 'busy' : msg?.fits ? 'fits' : 'original'
  let notice = null
  if (fit === 'on' && prev !== 'on') notice = 'Playing a lighter copy made to fit a remote connection. Choose "Original (server)" for the recording itself.'
  if (fit === 'busy' && prev !== 'busy') notice = 'The server is converting as many playbacks as it can, so this plays the original recording, which may stutter on a slow connection.'
  return { fit, notice }
}

/**
 * fitChange for the NVR's own recordings (NVR playback in HD, playback.mjs #fitDecide): the same
 * notes, in words for that menu, which has no "Original (server)". Each seek there is a new socket
 * that says it again, so it is told only when it changes.
 * @param {'on'|'busy'|'fits'|'original'|null} prev
 * @param {{ on?: boolean, busy?: boolean, fits?: boolean }} msg
 * @returns {{ fit: 'on'|'busy'|'fits'|'original', notice: string|null }}
 */
export function nvrFitChange(prev, msg) {
  const { fit } = fitChange(prev, msg)
  let notice = null
  if (fit === 'on' && prev !== 'on') notice = 'Playing a lighter copy of the NVR\u2019s HD recording, made to fit a remote connection.'
  if (fit === 'busy' && prev !== 'busy') notice = 'The server is converting as many playbacks as it can, so this plays the NVR\u2019s HD recording itself, which may stutter on a slow connection.'
  return { fit, notice }
}

// ---- the NVR refusing a search: backing off --------------------------------------------------------
// dc9e296: loadNvrSide's background recordings() throws on a refused FindFile or a broken file walk,
// and the route answers 502 with no retryAfterS. That is not "busy for a moment" (503, retryAfterS):
// it will not clear itself soon, and a page left open on a camera the NVR always refuses (an offline
// channel with older server recordings, say) used to run a foreground FindFile on it every 30 s.

/** First backoff after a search refusal (no retryAfterS): 5 minutes. */
export const NVR_REFUSAL_RETRY_MS = 5 * 60_000
/** The backoff never grows past this: 30 minutes. */
export const NVR_REFUSAL_MAX_MS = 30 * 60_000

/**
 * loadNvrSide's retry after error `e`: `{ delayMs, refusalMs }`. An answer WITH retryAfterS (busy, try
 * again shortly) is retried after that, at least 5 s, exactly as before, and leaves the refusal backoff
 * (prevRefusalMs) alone, so a busy answer between two refusals does not reset it. One with no
 * retryAfterS is a refusal: retried after refusalMs, NVR_REFUSAL_RETRY_MS the first time and doubling
 * (capped at NVR_REFUSAL_MAX_MS) each further one. Feed the refusalMs this returns back in as
 * prevRefusalMs next time; start over (null) on a new camera or day, or once a search succeeds.
 * @param {{ retryAfterS?: number }|null|undefined} e
 * @param {number|null} prevRefusalMs
 * @returns {{ delayMs: number, refusalMs: number|null }}
 */
export function nvrRetryDelay(e, prevRefusalMs) {
  if (e?.retryAfterS > 0) return { delayMs: Math.max(5, e.retryAfterS) * 1000, refusalMs: prevRefusalMs }
  const refusalMs = prevRefusalMs ? Math.min(prevRefusalMs * 2, NVR_REFUSAL_MAX_MS) : NVR_REFUSAL_RETRY_MS
  return { delayMs: refusalMs, refusalMs }
}

// ---- the share failing: the NVR's copy instead ----------------------------------------------------
// The server's recordings live on one NAS share, mounted soft: when it is down a read fails after a
// few minutes (EIO) or hangs until then. The server ends the session as a failed playback
// (rec-playback.mjs #fail), and the page plays the NVR's own recording from the same moment instead.

/** How long a start or seek into the server's footage may go without {type:'started'} before that. */
export const SERVER_START_TIMEOUT_MS = 8000

/**
 * Whether a server socket's close says its playback failed (1011 'playback failed'). Not a busy NVR
 * (1013), a normal close, a full converter ('transcode busy': its message says what to do) or no
 * server recordings: the NVR's copy is no answer to those, or the page already knows.
 */
export function serverFailed(code, reason) {
  return code === 1011 && reason === 'playback failed'
}

/**
 * What to tell the viewer when the server closes a playback socket 1008: the camera was taken away
 * from them or their session was signed out while it played (access-watch.mjs), or it was refused at
 * the start. Neither is helped by the NVR's copy or by trying again. null for any other close.
 */
export function refusedMessage(code, reason) {
  if (code !== 1008) return null
  if (reason === 'signed out') return 'You have been signed out. Sign in again to carry on.'
  if (reason === 'not allowed') return 'You are not allowed to play back this camera. An admin can give you access.'
  // (the main stream asked for without the right, or no SD recording came: the server's own words say
  // which, but its error and the close can arrive in either order, so this one covers both)
  if (reason === 'hd not allowed') return 'Playing this from the NVR needs its HD stream here, which needs Playback HD or Live HD on this camera. An admin can give you either.'
  return null
}

/**
 * Whether a start or seek at t is watched for SERVER_START_TIMEOUT_MS: yes when it reads the server's
 * files. A stretch only the NVR has (src 'nvr') is played by the NVR's own session, whose start can
 * take 10 s on a good day and has its own failure path (rec-playback.mjs #legDone); it is not the share.
 */
export function watchesStart(list, t) {
  return stretchAt(list, t)?.src !== 'nvr'
}

/**
 * Once per camera: the first failure of a camera's server playback goes over to the NVR, any later one
 * (the viewer chose "HD (server)" again) is shown as it is. So a camera whose NVR copy fails too can
 * never go round in a loop between the two.
 */
export class NvrFallback {
  constructor() {
    this.used = new Set()
  }

  /** true the first time for `cam` (and remembered), false after. */
  take(cam) {
    if (this.used.has(cam)) return false
    this.used.add(cam)
    return true
  }

  /** cam no longer plays from the NVR by default: the viewer chose a quality for it themselves. */
  clear(cam) {
    this.used.delete(cam)
  }
}

/**
 * 9fb29b8: fallBackToNvr used to set the viewer's quality choice itself to 'sd-nvr', page-wide, so
 * every camera opened afterwards played from the NVR too, and stayed there once the NAS was back. The
 * fix keeps the override per camera: 'sd-nvr' for a camera in `fellBack` (an NvrFallback's `used`, or
 * any Set of camKey()s), the viewer's own choice for every other one.
 * @param {string} cam camKey() of the camera being shown
 * @param {'server'|'sd-nvr'|undefined} quality the viewer's own choice (state.quality)
 * @param {Set<string>|null|undefined} fellBack
 * @returns {'server'|'sd-nvr'|undefined}
 */
export function qualityForCam(cam, quality, fellBack) {
  return fellBack?.has(cam) ? 'sd-nvr' : quality
}

/** How long a scrub waits for its reply before the next position is sent all the same (ScrubThrottle). */
export const SCRUB_TIMEOUT_MS = 300
/**
 * The same when the server converts H.265 for this browser (transcode.mjs): every scrub starts an
 * ffmpeg and converts one whole keyframe, about 600-830 ms for a 4K picture, and the next scrub kills
 * that ffmpeg. Sent every 300 ms, not one converted scrub would ever get its picture out.
 */
export const CONVERTED_SCRUB_TIMEOUT_MS = 1500

/**
 * The scrub timeout for this browser: 1500 ms when it cannot decode H.265 (its H.265 scrubs are
 * converted), else 300 ms. Keyed on the browser, not on the day's codec (the newest file's): a
 * camera switched away from H.265 during the day still has converted footage before the switch. An
 * H.264 scrub is answered by its frame within milliseconds whatever this is, so it stays fast.
 * fitted: the server converts every frame for this remote viewer ({type:'fit', on:true}), so every
 * scrub is an ffmpeg start and a whole keyframe: 1500 ms too.
 */
export function scrubTimeoutMs(h265, fitted = false) {
  return h265 === false || fitted ? CONVERTED_SCRUB_TIMEOUT_MS : SCRUB_TIMEOUT_MS
}

/**
 * One scrub in flight: while dragging the playhead, a position is sent only when the reply to the
 * previous one ({type:'scrub', gen}) has come (ack), so the server never works on a backlog; the
 * newest position wins. A reply that never comes frees the slot after timeoutMs: a number, or a
 * function asked at each send (the page learns what it can decode after the throttle is made).
 * send(t) sends {scrub: t, gen} and returns gen, or null when it could not send (the position is
 * kept for the next push).
 */
export class ScrubThrottle {
  constructor(send, { timeoutMs = SCRUB_TIMEOUT_MS, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
    Object.assign(this, { send, timeoutMs, now, setTimer })
    this.pending = null // the newest position not sent yet
    this.inflight = null // { gen, at, ms } of the scrub sent and not answered (ms: its timeout)
  }

  push(t) {
    this.pending = t
    this.#pump()
  }

  /** The reply to scrub `gen` came: the slot is free (a reply to an older scrub frees nothing). */
  ack(gen) {
    if (!this.inflight || !(gen >= this.inflight.gen)) return
    this.inflight = null
    this.#pump()
  }

  /** Forgets the waiting position and the scrub in flight (the drag ended). */
  cancel() {
    this.pending = null
    this.inflight = null
  }

  #pump() {
    if (this.pending === null) return
    if (this.inflight && this.now() - this.inflight.at < this.inflight.ms) return
    this.inflight = null
    const gen = this.send(this.pending)
    if (gen === null || gen === undefined) return
    this.pending = null
    const ms = typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs
    const rec = { gen, at: this.now(), ms }
    this.inflight = rec
    this.setTimer(() => {
      if (this.inflight !== rec) return
      this.inflight = null
      this.#pump()
    }, ms)
  }
}

/** "3 min 40 s" */
function duration(ms) {
  let s = Math.round(Math.abs(ms) / 1000)
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  return [h && `${h} h`, m && `${m} min`, s && `${s} s`].filter(Boolean).join(' ')
}

/**
 * The hint shown in server mode when the NVR's clock is more than 10 s off; '' otherwise. Below that
 * the picture's printed time and the timeline differ by too little to matter, and the clock sync
 * (nvr-clock.mjs, anything over 4 s) puts it right within a quarter of an hour.
 */
export function describeSkew(skewMs) {
  if (!Number.isFinite(skewMs) || Math.abs(skewMs) <= 10_000) return ''
  return `Server time. This NVR's clock is ${duration(skewMs)} ${skewMs > 0 ? 'fast' : 'slow'}; the time printed on the picture differs.`
}

/**
 * A time from one mode's time base to another's: server -> nvr adds the NVR's skew, nvr -> server
 * subtracts it. Between two NVR-mode cameras the time is kept as it is (as the page always did).
 */
export function convertTime(t, from, to, { fromSkew = 0, toSkew = 0 } = {}) {
  if (t === null || t === undefined || from === to) return t
  return from === 'server' ? t + toSkew : t - fromSkew
}

/** The speed to use in a mode: NVR playback runs 1-8x forward only. */
export function speedFor(mode, speed) {
  if (mode === 'nvr') {
    if (speed > 8) return 8
    return NVR_SPEEDS.includes(speed) ? speed : 1
  }
  return SERVER_SPEEDS.includes(speed) ? speed : 1
}
