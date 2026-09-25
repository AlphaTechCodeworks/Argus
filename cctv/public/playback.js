// Recorded playback: day timeline + one player fed by /playback.
// Times are UTC epoch ms (the NVR stamps recordings in UTC). They are shown in
// the NVR's local time, the time printed on the picture, by adding the NVR's
// time-zone offset (state.tz) and formatting with getUTC*().
//
// Two modes, chosen per camera and day (pb-sources.js pickMode, plan R6):
//  - server: the server's own recordings (admins, CCTV_LIVE_WORKER=on, footage that day, a codec
//    this browser decodes). Everything is in the SERVER's clock. The day's timeline comes from the
//    database in one request (/api/playback/timeline). The NVR's /recordings is asked in the
//    background, never waited for, for its events and for stretches only the NVR has (drawn in
//    --tl-nvr, converted to server time with -skewMs); a busy or offline NVR is retried quietly.
//    One socket (src=auto) per camera: seeks and scrubs go over it as {seek|scrub: T, gen}; binary
//    frames count only after {type:'started'|'scrub'} of the newest gen. The preroll (the frames
//    from the keyframe before T) is skipped by the player, its keyframe shown at once as a poster.
//    Speeds -32x..32x: reverse and 8x+ are keyframes, reverse shown as stills. Dragging the
//    playhead scrubs (one scrub in flight, pb-sources.js ScrubThrottle); releasing plays.
//    Today the file being written counts as recorded up to the live edge (pb-sources.js liveEdge:
//    the timeline's now plus the time since, less 1 s); later times are not recorded yet, as in
//    NVR mode, and a scrub stops at the edge.
//  - nvr: the NVR's playback exactly as before (NVR clock, no src parameter, speeds 1-8, SD/HD).
// Switching between them (quality "SD (NVR)", or a camera or day in the other mode) converts the
// position by the NVR's clock skew.
import { CODEC_H265, VideoPlayer, canDecodeH265 } from './player.js'
import {
  NVR_SPEEDS,
  SERVER_SPEEDS,
  ScrubThrottle,
  convertTime,
  describeSkew,
  gapAt,
  liveEdge,
  mergeSources,
  nextStretch,
  pickMode,
  prerollUntil,
  recordedFrom as stretchFrom,
  shift,
  speedFor
} from './pb-sources.js'

// Video is decoded here in the browser, exactly as the camera encoded it; the
// server never converts it. Recordings in H.265 need a browser/PC that can decode H.265.
const H265_HELP =
  'This recording is H.265, which this browser cannot play. Open it on a PC whose graphics card decodes H.265 (most from 2017 on) in Chrome or Edge, or set this camera to record in H.264 on the NVR.'

const HEADER_SIZE = 16
const DAY = 86_400_000
const MIN_SPAN = 5 * 60_000
const SEEK_STEP = 30_000
const START_BACK_MS = 5 * 60_000
// server recordings: the file being written is readable, so playback starts closer to now
const START_BACK_SERVER_MS = 60_000
const PLAYHEAD_GRAB_PX = 8 // pressing this close to the playhead scrubs (server mode) instead of panning
const NOTICE_MS = 5000

const $ = (id) => document.getElementById(id)
const cameraSel = $('camera')
const dateInput = $('date')
const playBtn = $('play')
const speedSel = $('speed')
const qualitySel = $('quality')
const clockEl = $('clock')
const messageEl = $('message')
const noticeEl = $('pbNotice')
const badgeEl = $('srcBadge')
const skewEl = $('skewHint')
const legendServer = $('legendServer')
const hintEl = $('pbHint')
const videoEl = $('video')
const timeline = $('timeline')
const tctx = timeline.getContext('2d')

const pad = (n) => String(n).padStart(2, '0')
const local = (ms) => new Date(ms + state.tz) // NVR local wall time, read with getUTC*()
const fmtTime = (ms) => {
  const d = local(ms)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}
const fmtDate = (ms) => {
  const d = local(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
/** Start of an NVR-local day (YYYY-MM-DD), as UTC ms. */
const dayStartOf = (date) => Date.parse(`${date}T00:00:00Z`) - state.tz

const state = {
  nvr: null, // NVR id
  ch: null,
  date: null,
  ranges: [], // [[start, end]] (server mode: the server's)
  events: [], // [[start, end, type]]
  hits: [], // motion-search results: { start, end, score }
  position: null, // ms of the frame on screen (NVR clock; server mode: server clock)
  requested: null, // ms we last asked to play from
  paused: false,
  speed: 1,
  stream: 1,
  h265: true, // this browser can decode H.265 (checked at start)
  view: { start: 0, span: DAY },
  nvrNow: Date.now(),
  tz: 0, // NVR time-zone offset in ms (local - UTC)
  clockOf: null, // the NVR whose clock (nvrNow, tz) was read
  // ---- playback from the server's recordings ----
  mode: 'nvr', // 'server' | 'nvr' for the camera and day shown
  avail: false, // the server has recordings of this camera (the timeline is available)
  quality: 'server', // with avail: 'server' (HD from the server) or 'sd-nvr' (the viewer chose the NVR's SD)
  skew: 0, // the NVR's clock - the server's (ms)
  firstMs: null, // the camera's oldest server recording
  gaps: [], // server mode: recorder gaps [[start, end, reason]]
  nvrRaw: null, // server mode: the NVR's { ranges, events } for the day, in NVR time
  live: false, // server mode: the last range is the file being written (it grows up to the live edge, edgeNow())
  tlAt: 0, // server mode: performance.now() when the timeline giving nvrNow came (for the live edge)
  stretches: [], // server mode: [{ s, e, src }] the server's ranges and the NVR-only stretches
  src: null // what plays in server mode: 'server' or 'nvr' (a stretch the server lacks)
}

let ws = null
let showStats = false
let scrub = null // { t } while the playhead is dragged (server mode)
let seekAt = null // performance.now() of the last seek, until its first picture (D overlay)
let startMs = null // seek to first picture, ms
let lastEndSkip = -Infinity // the last stretch jumped to at an end (never the same one twice)

const player = new VideoPlayer(videoEl.querySelector('canvas'), {
  clock: { startDelayMs: 300, minDelayMs: 200, maxDelayMs: 1000 },
  onFrame: (ts) => {
    if (!scrub) state.position = ts // (while scrubbing the playhead follows the pointer)
    noteStart()
    hideMessage()
    scheduleDraw()
  },
  onPoster: () => noteStart(),
  onUnsupported: (codecId) => {
    showMessage(codecId === CODEC_H265 ? H265_HELP : 'This browser cannot decode this video.')
    // nothing to show: stop pulling footage from the NVR
    if (ws) {
      ws.onclose = null
      ws.close()
      ws = null
    }
  }
})

/** The first picture after a seek (a poster or a frame): the D overlay's start time. */
function noteStart() {
  if (seekAt === null) return
  startMs = Math.round(performance.now() - seekAt)
  seekAt = null
}

function showMessage(text) {
  messageEl.textContent = text
  messageEl.hidden = false
}
function hideMessage() {
  if (!messageEl.hidden) messageEl.hidden = true
}

/** A short note over the top of the picture that fades (skipped stretches, speed changes). */
let noticeTimer = null
function showNotice(text) {
  noticeEl.textContent = text
  noticeEl.hidden = false
  noticeEl.classList.remove('fading')
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    noticeEl.classList.add('fading')
    noticeTimer = setTimeout(() => (noticeEl.hidden = true), 600)
  }, NOTICE_MS)
}

// ---- data ---------------------------------------------------------------

/** Query-string prefix naming the current NVR. */
const nvrQ = () => `nvr=${encodeURIComponent(state.nvr)}`
const camKey = () => `${state.nvr}/${state.ch}`

async function api(path) {
  const res = await fetch(path)
  if (res.status === 401) location.href = '/login.html'
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(body.error ?? `HTTP ${res.status}`)
    if (body.retryAfterS > 0) e.retryAfterS = body.retryAfterS // the NVR is busy for a moment
    throw e
  }
  return body
}

// While an NVR is busy (recovering, or its calls came back late) the server answers the timeline
// requests at once with 503 and retryAfterS rather than queue more work for it. The page shows
// the message and loads again then; choosing another camera or day meanwhile replaces that retry.
let busyTimer = null
/** true if e says the NVR is busy: shows its message and runs again() after its retryAfterS. */
function retryWhenFree(e, again) {
  if (!e?.retryAfterS) return false
  showMessage(e.message)
  clearTimeout(busyTimer)
  busyTimer = setTimeout(again, e.retryAfterS * 1000)
  return true
}

// The server's timeline of a camera's day: one database request, never the NVR (rec-api.mjs).
// An answer is reused briefly (the start and loadDay ask for the same day); "not available" is
// per camera (flag off, not allowed, no recordings) and reused for any day for a minute.
let tlCache = null // { key, cam, at, body }
const TL_REUSE_MS = 5000
const TL_OFF_REUSE_MS = 60_000

async function fetchTimeline({ fresh = false } = {}) {
  const from = Math.round(dayStartOf(state.date))
  const key = `${camKey()}/${from}`
  const c = tlCache
  if (!fresh && c && c.cam === camKey()) {
    const age = performance.now() - c.at
    if (c.body.available ? c.key === key && age < TL_REUSE_MS : age < TL_OFF_REUSE_MS) return c.body
  }
  let body
  try {
    body = await api(`/api/playback/timeline?${nvrQ()}&ch=${state.ch}&from=${from}&to=${from + DAY}`)
  } catch {
    body = { available: false } // (the page works as before without it)
  }
  body.receivedAt = performance.now() // when body.now was read (a reused answer keeps it: the live edge)
  tlCache = { key, cam: camKey(), at: body.receivedAt, body }
  return body
}

let dayToken = 0 // a newer camera or day replaces what an older load would still do
let lastPick = null // the mode chosen for the day shown, and why (pb-sources.js pickMode)

/**
 * Loads the chosen day, then runs after(). The server's recordings first (one database request):
 * with them (pickMode) the day plays from the server; otherwise exactly as before: the NVR's
 * clock if needed, then its recordings.
 */
async function loadDay(after, tzRetried = false) {
  clearTimeout(busyTimer)
  clearTimeout(nvrSideTimer)
  const token = ++dayToken
  state.ranges = []
  state.events = []
  state.gaps = []
  state.nvrRaw = null
  state.stretches = []
  drawTimeline()
  const tl = await fetchTimeline()
  if (token !== dayToken) return
  state.avail = tl.available === true
  if (state.avail && Number.isFinite(tl.tzOffsetMs) && tl.tzOffsetMs !== state.tz && !tzRetried) {
    // the NVR's time zone differs from the one assumed: the day starts elsewhere
    state.tz = tl.tzOffsetMs
    return loadDay(after, true)
  }
  const pick = pickMode({ timeline: tl, h265: state.h265, quality: state.quality })
  lastPick = pick
  if (pick.mode === 'server') return enterServerDay(tl, token, after)
  leaveServerMode()
  if (state.avail && /H\.265/.test(pick.why)) showNotice(pick.why)
  try {
    // another NVR has its own clock and recording days
    if (state.clockOf !== state.nvr) {
      const busy = await loadNvrInfo()
      if (busy) throw busy
    }
    const { ranges, events } = await api(`/api/playback/recordings?${nvrQ()}&ch=${state.ch}&date=${state.date}`)
    state.ranges = ranges
    state.events = events
    if (ranges.length === 0) showMessage('No recordings for this camera on this day.')
  } catch (e) {
    if (retryWhenFree(e, () => loadDay(after))) {
      // what still plays is another camera or day: stop it, so the message stays up
      if (ws) {
        ws.onclose = null
        ws.close()
        ws = null
      }
      return
    }
    showMessage(`Could not load recordings: ${e.message}`)
  }
  drawTimeline()
  after?.()
}

/** First recorded moment at or after t (or null). */
function recordedFrom(t) {
  for (const [s, e] of state.ranges) {
    if (t < s) return s
    if (t <= e) return t
  }
  return null
}

// ---- server mode: the day -----------------------------------------------------

function enterServerDay(tl, token, after) {
  state.mode = 'server'
  state.clockOf = null // NVR mode reads the NVR's clock again (nvrNow is the server's here)
  if (ws && ws.kind !== 'server') closeSocket()
  state.nvrNow = tl.now
  state.tlAt = tl.receivedAt ?? performance.now()
  if (Number.isFinite(tl.tzOffsetMs)) state.tz = tl.tzOffsetMs
  state.skew = tl.skewMs ?? 0
  state.firstMs = tl.firstMs ?? null
  state.ranges = tl.ranges
  state.live = reachesNow(tl)
  state.gaps = tl.gaps ?? []
  state.speed = speedFor('server', state.speed)
  rebuildStretches()
  dateInput.max = fmtDate(state.nvrNow)
  updateDateMin()
  updateModeUi()
  drawTimeline()
  loadNvrSide(token)
  after?.()
}

/** Back to NVR playback (nothing changes when the page is in NVR mode already). */
function leaveServerMode() {
  if (state.mode === 'server') {
    state.mode = 'nvr'
    if (ws?.kind === 'server') closeSocket()
    throttle.cancel()
    player.setStills(false)
    state.src = null
    state.speed = speedFor('nvr', state.speed)
    player.setRate(state.speed)
  }
  updateModeUi()
}

/**
 * The NVR's ranges and events in server time, and the stretches only the NVR has. The file being
 * written keeps growing after the timeline was read: when the server's last range reaches `now`,
 * it counts as recorded up to the live edge as it is now (edgeNow), never later: a time after the
 * edge is not recorded yet (serverSeek rebuilds the stretches first, so the edge is current).
 */
function rebuildStretches() {
  const raw = state.nvrRaw
  if (state.mode === 'server') state.events = raw ? shift(raw.events, -state.skew) : []
  state.stretches = mergeSources(state.ranges, raw ? shift(raw.ranges, -state.skew) : [], { liveTo: state.live ? edgeNow() : null })
}

/** Whether the timeline's last range is the file being written (it ends at the timeline's now). */
const reachesNow = (tl) => Boolean(tl.ranges?.length) && tl.ranges.at(-1)[1] >= tl.now - 2000

/** Server mode, today: the newest moment the server has on disk (pb-sources.js liveEdge). */
const edgeNow = () => liveEdge(state.nvrNow, state.tlAt, performance.now())

let nvrSideTimer = null
let nvrInfo = null // { nvr, dates } the NVR's recording days (server mode)

/**
 * Server mode, in the background: the NVR's clock (skew, time zone) and recording days, then its
 * recordings of the day (events, NVR-only stretches). Never waited for; a busy or offline NVR is
 * retried quietly (no message over the video).
 */
async function loadNvrSide(token) {
  clearTimeout(nvrSideTimer)
  const stale = () => token !== dayToken || state.mode !== 'server'
  const nvr = state.nvr
  try {
    if (nvrInfo?.nvr !== nvr) {
      const [clock, dates] = await Promise.all([api(`/api/playback/now?${nvrQ()}`), api(`/api/playback/dates?${nvrQ()}`)])
      if (state.nvr !== nvr) return
      nvrInfo = { nvr, dates: Array.isArray(dates) ? dates : [] }
      if (stale()) return
      state.skew = clock.skewMs ?? state.skew
      if (Number.isFinite(clock.tzOffsetMs) && clock.tzOffsetMs !== state.tz) {
        // the day starts elsewhere in this time zone: load it again
        state.tz = clock.tzOffsetMs
        return loadDay(() => {})
      }
      updateDateMin()
      updateModeUi()
    }
    const { ranges, events } = await api(`/api/playback/recordings?${nvrQ()}&ch=${state.ch}&date=${state.date}`)
    if (stale()) return
    state.nvrRaw = { ranges, events }
    rebuildStretches()
    scheduleDraw()
  } catch (e) {
    if (stale()) return
    nvrSideTimer = setTimeout(() => {
      if (!stale()) loadNvrSide(token)
    }, Math.max(5, e?.retryAfterS ?? 30) * 1000)
  }
}

/** The date picker goes back to the older of the server's first recording and the NVR's first day. */
function updateDateMin() {
  const days = [state.firstMs !== null ? fmtDate(state.firstMs) : null, nvrInfo?.nvr === state.nvr ? nvrInfo.dates[0] : null].filter(Boolean).sort()
  dateInput.min = days[0] ?? ''
}

/** Today's timeline in server mode, every minute (the database only). */
async function refreshServer() {
  const token = dayToken
  const tl = await fetchTimeline({ fresh: true })
  if (token !== dayToken || state.mode !== 'server' || !tl.available) return
  state.nvrNow = tl.now
  state.tlAt = tl.receivedAt ?? performance.now()
  state.skew = tl.skewMs ?? state.skew
  state.ranges = tl.ranges
  state.live = reachesNow(tl)
  state.gaps = tl.gaps ?? []
  dateInput.max = fmtDate(state.nvrNow)
  rebuildStretches()
  updateModeUi()
  scheduleDraw()
  if (state.date === fmtDate(state.nvrNow)) loadNvrSide(token) // today's NVR events grow too
}

// ---- controls per mode ----------------------------------------------------------

const speedLabel = (s) => `${s < 0 ? '−' : ''}${Math.abs(s)}×`

function setOptions(sel, list, value) {
  sel.replaceChildren(...list.map(([v, label]) => new Option(label, String(v))))
  sel.value = String(value)
}

/** Speeds, quality choices, legend, skew hint and source badge for the mode shown. */
function updateModeUi() {
  const server = state.mode === 'server'
  const speeds = server ? SERVER_SPEEDS : NVR_SPEEDS
  if (speedSel.dataset.kind !== state.mode) {
    setOptions(speedSel, speeds.map((s) => [s, speedLabel(s)]), state.speed)
    speedSel.dataset.kind = state.mode
  } else speedSel.value = String(state.speed)
  // quality: with server recordings "HD (server)" or "SD (NVR)"; otherwise the NVR's SD or HD as before
  const kind = state.avail && (server || state.quality === 'sd-nvr') ? 'server' : 'nvr'
  if (qualitySel.dataset.kind !== kind) {
    if (kind === 'server') setOptions(qualitySel, [['server', 'HD (server)'], ['sd-nvr', 'SD (NVR)']], server ? 'server' : 'sd-nvr')
    else setOptions(qualitySel, [[1, 'SD (light)'], [0, 'HD']], state.stream)
    qualitySel.dataset.kind = kind
  }
  if (kind === 'server') {
    qualitySel.value = server ? 'server' : 'sd-nvr'
    // a camera the NVR records in HD only plays HD for "SD (NVR)" ({type:'stream'})
    const label = !server && state.stream === 0 ? 'HD (NVR)' : 'SD (NVR)'
    if (qualitySel.options[1].textContent !== label) qualitySel.options[1].textContent = label
  }
  legendServer.hidden = !server
  const hint = server ? describeSkew(state.skew) : ''
  skewEl.textContent = hint
  skewEl.hidden = !hint
  badgeEl.hidden = !(server && state.src === 'nvr')
  hintEl.textContent = server
    ? 'Click the timeline to jump · drag the playhead to scrub · scroll to zoom · drag to pan'
    : 'Click the timeline to jump · scroll to zoom · drag to pan'
}

function setSource(src) {
  state.src = src ?? 'server'
  badgeEl.hidden = !(state.mode === 'server' && state.src === 'nvr')
}

// ---- streaming ------------------------------------------------------------

const rateOf = (speed) => (speed > 0 ? speed : 1) // reverse is shown as stills, not by the clock

function seek(t) {
  if (state.mode === 'server') return serverSeek(t)
  const target = recordedFrom(t)
  if (target === null) {
    showMessage('No recording after this point.')
    return
  }
  state.requested = target
  state.position = target
  state.paused = false
  updatePlayButton()
  seekAt = performance.now()
  startMs = null
  player.reset()
  player.resume()
  player.setRate(state.speed)
  open(target)
  scheduleDraw()
}

function open(start) {
  if (ws) {
    ws.onclose = null
    ws.close()
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const sock = new WebSocket(`${proto}://${location.host}/playback?${nvrQ()}&ch=${state.ch}&stream=${state.stream}&start=${start}`)
  sock.binaryType = 'arraybuffer'
  sock.kind = 'nvr'
  sock.onopen = () => {
    if (state.speed !== 1) sock.send(JSON.stringify({ speed: state.speed }))
  }
  sock.onmessage = (e) => {
    if (typeof e.data === 'string') return onStatus(JSON.parse(e.data))
    pushFrame(e.data)
  }
  sock.onclose = (e) => {
    if (ws !== sock) return
    ws = null
    if (e.code === 1013) showMessage('The NVR is busy with other playbacks. Try again in a moment.')
  }
  ws = sock
}

/** One binary message (the /live wire format) to the player. */
function pushFrame(data) {
  const buf = new Uint8Array(data)
  if (buf.length <= HEADER_SIZE) return
  const view = new DataView(buf.buffer, buf.byteOffset)
  player.push({
    isKey: (buf[0] & 1) === 1,
    codecId: buf[1],
    timestampUs: Number(view.getBigInt64(8, true)),
    data: buf.subarray(HEADER_SIZE)
  })
}

function closeSocket() {
  if (!ws) return
  ws.onclose = null
  ws.close()
  ws = null
}

function onStatus(msg) {
  if (msg.type === 'error') showMessage(msg.message)
  if (msg.type === 'stream') {
    // this camera records HD only; the server switched over
    state.stream = msg.stream
    if (qualitySel.dataset.kind === 'server') return updateModeUi() // ("SD (NVR)" chosen: relabelled)
    const hd = qualitySel.options[1]
    hd.disabled = false
    hd.textContent = 'HD'
    qualitySel.value = '0'
  }
  if (msg.type === 'end') {
    // skip gaps between recordings automatically
    const next = state.ranges.find(([s]) => s > (state.position ?? 0) + 1000)
    if (next) seek(next[0])
    else if (state.nvrNow - (state.position ?? 0) < 3 * 60_000) showMessage('You have reached the newest recording. Use Live for the current picture.')
    else showMessage('End of recordings.')
  }
}

// ---- server mode: the socket ------------------------------------------------------

/**
 * A seek in server mode: over the open socket ({seek, gen}), or a new socket (src=auto) at T. Today
 * a time after the live edge is not recorded yet ("No recording after this point.", as in NVR mode):
 * asked for, the server would announce a future time and the browser would drop every frame.
 */
function serverSeek(t) {
  if (state.live) rebuildStretches() // the live edge as it is now
  const target = stretchFrom(state.stretches, t)
  if (target === null) {
    showMessage('No recording after this point.')
    return
  }
  state.requested = target
  state.position = target
  state.paused = false
  updatePlayButton()
  throttle.cancel()
  seekAt = performance.now()
  startMs = null
  player.seekReset() // the decoder stays set up
  if (state.speed > 0) player.setStills(false)
  player.resume()
  player.setRate(rateOf(state.speed))
  const sock = ws?.kind === 'server' && ws.cam === camKey() && ws.readyState <= WebSocket.OPEN ? ws : null
  if (!sock) openServer(target)
  else {
    const cmd = { seek: Math.round(target), gen: ++sock.gen }
    sock.ackOnFrame = null
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(cmd))
    else sock.pending = cmd // (sent when it opens)
  }
  scheduleDraw()
}

function openServer(start) {
  closeSocket()
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // server footage is the main stream (stream=0); all times are the server's clock
  const sock = new WebSocket(`${proto}://${location.host}/playback?${nvrQ()}&ch=${state.ch}&stream=0&start=${Math.round(start)}&src=auto`)
  sock.binaryType = 'arraybuffer'
  sock.kind = 'server'
  sock.cam = camKey()
  sock.gen = 0 // the generation asked for last (the start is 0)
  sock.okGen = -1 // the generation whose frames are shown (announced by started or scrub)
  sock.pending = null
  sock.ackOnFrame = null // a scrub's reply came: its keyframe frees the throttle
  sock.onopen = () => {
    if (state.speed !== 1) sock.send(JSON.stringify({ speed: state.speed }))
    if (sock.pending) sock.send(JSON.stringify(sock.pending))
    sock.pending = null
  }
  sock.onmessage = (e) => {
    if (ws !== sock) return
    if (typeof e.data === 'string') return onServerStatus(sock, JSON.parse(e.data))
    if (sock.okGen !== sock.gen) return // frames of an older seek or scrub
    pushFrame(e.data)
    if (sock.ackOnFrame !== null) {
      const gen = sock.ackOnFrame
      sock.ackOnFrame = null
      throttle.ack(gen)
    }
  }
  sock.onclose = (e) => {
    if (ws !== sock) return
    ws = null
    if (e.code === 1013) showMessage('The NVR is busy with other playbacks. Try again in a moment.')
  }
  ws = sock
}

function onServerStatus(sock, msg) {
  switch (msg.type) {
    case 'started': {
      if (msg.gen !== sock.gen) return
      sock.okGen = msg.gen
      // a server start at 1x-4x sends the frames from the keyframe before `at` at once (the
      // preroll): decoded, not shown; its keyframe is the poster. Keyframe starts, reverse and
      // NVR legs have none (pb-sources.js prerollUntil)
      const until = prerollUntil(msg)
      if (until !== null) player.skipUntil(until)
      if (!scrub) state.position = msg.at
      setSource(msg.src)
      scheduleDraw()
      return
    }
    case 'scrub':
      if (msg.gen !== sock.gen) return
      sock.okGen = msg.gen
      if (msg.none) throttle.ack(msg.gen) // nothing recorded there: the picture stays
      else sock.ackOnFrame = msg.gen // its keyframe follows
      return
    case 'mode':
      player.setStills(Boolean(msg.stills))
      return
    case 'source':
      setSource(msg.src)
      return
    case 'speed':
      state.speed = msg.speed
      speedSel.value = String(msg.speed)
      player.setRate(rateOf(msg.speed))
      if (msg.reason === 'newest') showNotice('Reached the newest footage: playing at 1×.')
      scheduleDraw()
      return
    case 'notice':
      showNotice(msg.message)
      return
    case 'end':
      return onServerEnd(msg)
    case 'error':
      showMessage(msg.message)
      return
    // 'stream': server footage is the main stream, asked for as such
  }
}

function onServerEnd(msg) {
  if (msg.reverse) {
    showNotice('Reached the first recording of this camera.')
    return
  }
  // a stretch only the NVR has after the server's footage: play it from there
  const pos = state.position ?? 0
  const next = nextStretch(state.stretches, pos + 1000)
  if (next && next.s > lastEndSkip) {
    lastEndSkip = next.s
    return seek(next.s)
  }
  if (state.nvrNow - pos < 3 * 60_000) showMessage('You have reached the newest recording. Use Live for the current picture.')
  else showMessage('End of recordings.')
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

// scrubbing (server mode): one {scrub} in flight, the newest position wins
const throttle = new ScrubThrottle(
  (t) => {
    const sock = ws
    if (sock?.kind !== 'server' || sock.cam !== camKey() || sock.readyState !== WebSocket.OPEN) return null
    const gen = ++sock.gen
    sock.ackOnFrame = null
    sock.send(JSON.stringify({ scrub: Math.round(t), gen }))
    return gen
  },
  { now: () => performance.now() }
)

function togglePause() {
  if (!ws && state.position !== null) return seek(state.position)
  state.paused = !state.paused
  send({ pause: state.paused })
  if (state.paused) player.pause()
  else player.resume()
  updatePlayButton()
}

function updatePlayButton() {
  playBtn.textContent = state.paused ? '▶' : '⏸'
  playBtn.setAttribute('aria-label', state.paused ? 'Play' : 'Pause')
}

function setSpeed(speed) {
  state.speed = speed
  send({ speed })
  player.setRate(rateOf(speed))
  scheduleDraw()
}

function jumpEvent(direction) {
  const pos = state.position ?? state.view.start
  const list = state.events.map(([s]) => s)
  const target = direction > 0 ? list.find((s) => s > pos + 2000) : list.filter((s) => s < pos - 2000).at(-1)
  if (target !== undefined) {
    ensureVisible(target)
    seek(target)
  }
}

// ---- timeline -------------------------------------------------------------

let drawPending = false
function scheduleDraw() {
  if (drawPending) return
  drawPending = true
  requestAnimationFrame(() => {
    drawPending = false
    drawTimeline()
    if (state.position !== null) {
      clockEl.textContent = `${fmtDate(state.position)} ${fmtTime(state.position)}${state.speed !== 1 ? ` · ${speedLabel(state.speed)}` : ''}`
    }
  })
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

function drawTimeline() {
  const dpr = window.devicePixelRatio || 1
  const w = timeline.clientWidth
  const h = timeline.clientHeight
  if (timeline.width !== Math.round(w * dpr) || timeline.height !== Math.round(h * dpr)) {
    timeline.width = Math.round(w * dpr)
    timeline.height = Math.round(h * dpr)
  }
  const c = tctx
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  c.clearRect(0, 0, w, h)
  const { start, span } = state.view
  const x = (t) => ((t - start) / span) * w
  const server = state.mode === 'server'

  // track
  const barY = 18
  const barH = h - barY - 6
  c.fillStyle = css('--tl-track')
  c.fillRect(0, barY, w, barH)
  c.fillStyle = css('--tl-rec')
  for (const [s, e] of state.ranges) {
    if (e < start || s > start + span) continue
    c.fillRect(x(s), barY, Math.max(1, x(e) - x(s)), barH)
  }
  if (server) {
    // stretches only the NVR has (played from it), and the recorder's gaps as a thin strip
    c.fillStyle = css('--tl-nvr')
    for (const { s, e, src } of state.stretches) {
      if (src !== 'nvr' || e < start || s > start + span) continue
      c.fillRect(x(s), barY, Math.max(1, x(e) - x(s)), barH)
    }
    c.fillStyle = css('--tl-gap')
    for (const [s, e] of state.gaps) {
      if (e < start || s > start + span) continue
      c.fillRect(x(s), barY + barH - 3, Math.max(2, x(e) - x(s)), 3)
    }
  }
  c.fillStyle = css('--tl-evt')
  for (const [s, e] of state.events) {
    if (e < start || s > start + span) continue
    c.fillRect(x(s), barY + barH * 0.55, Math.max(2, x(e) - x(s)), barH * 0.45)
  }
  c.fillStyle = css('--tl-hit')
  for (const { start: s, end: e } of state.hits) {
    if (e + 2000 < start || s > start + span) continue
    c.fillRect(x(s) - 1, barY, Math.max(3, x(e + 2000) - x(s)), barH * 0.4)
  }

  // ticks: pick a step giving roughly one label per 90px
  const steps = [60_000, 300_000, 600_000, 1_800_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000]
  const step = steps.find((s) => (s / span) * w >= 90) ?? steps.at(-1)
  c.fillStyle = css('--muted')
  c.strokeStyle = css('--tl-tick')
  c.font = '11px system-ui, sans-serif'
  c.textBaseline = 'top'
  for (let t = Math.ceil((start + state.tz) / step) * step - state.tz; t <= start + span; t += step) {
    const px = Math.round(x(t)) + 0.5
    c.beginPath()
    c.moveTo(px, barY - 4)
    c.lineTo(px, barY)
    c.stroke()
    const d = local(t)
    c.fillText(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`, px + 3, 2)
  }

  // "now" marker for today
  if (state.nvrNow > start && state.nvrNow < start + span) {
    c.fillStyle = css('--muted')
    c.fillRect(Math.round(x(state.nvrNow)), barY, 1, barH)
  }

  // playhead
  if (state.position !== null && state.position >= start && state.position <= start + span) {
    const px = Math.round(x(state.position))
    c.fillStyle = css('--accent')
    c.fillRect(px - 1, 0, 2, h)
    c.beginPath()
    c.moveTo(px - 5, 0)
    c.lineTo(px + 5, 0)
    c.lineTo(px, 6)
    c.fill()
  }

  // hover time (server mode: and why the server did not record there)
  if (hoverX !== null && !scrub) {
    const t = start + (hoverX / w) * span
    c.fillStyle = css('--text')
    c.fillRect(Math.round(hoverX), barY, 1, barH)
    const gap = server ? gapAt(state.gaps, t) : null
    const label = gap ? `${fmtTime(t)} · not recorded: ${gap}` : fmtTime(t)
    const tw = Math.min(w, c.measureText(label).width + 8)
    const lx = Math.min(Math.max(0, hoverX - tw / 2), w - tw)
    c.fillStyle = css('--panel')
    c.fillRect(lx, barY + 2, tw, 15)
    c.fillStyle = css('--text')
    c.fillText(label, lx + 4, barY + 4, tw - 8)
  }
}

function clampView() {
  const dayStart = dayStartOf(state.date)
  state.view.span = Math.min(DAY, Math.max(MIN_SPAN, state.view.span))
  state.view.start = Math.min(dayStart + DAY - state.view.span, Math.max(dayStart, state.view.start))
}

function zoom(factor, anchorT) {
  const { start, span } = state.view
  const t = anchorT ?? state.position ?? start + span / 2
  const newSpan = span * factor
  state.view.start = t - ((t - start) / span) * newSpan
  state.view.span = newSpan
  clampView()
  drawTimeline()
}

function ensureVisible(t) {
  const { start, span } = state.view
  if (t < start || t > start + span) {
    state.view.start = t - span / 2
    clampView()
  }
}

let hoverX = null
let drag = null
const timeAt = (clientX) => {
  const r = timeline.getBoundingClientRect()
  return state.view.start + ((clientX - r.left) / r.width) * state.view.span
}

/** Server mode: whether a press at clientX grabs the playhead (within 8 px of it, or its triangle). */
function onPlayhead(clientX) {
  if (state.mode !== 'server' || state.position === null) return false
  const r = timeline.getBoundingClientRect()
  const px = ((state.position - state.view.start) / state.view.span) * r.width
  return Math.abs(clientX - r.left - px) <= PLAYHEAD_GRAB_PX
}

// ---- scrubbing (server mode, R10): drag the playhead; releasing plays from there ----

function startScrub(e) {
  scrub = { t: state.position }
  throttle.cancel()
  seekAt = null
  player.seekReset()
  player.setStills(true) // each keyframe is shown as soon as it is decoded
  timeline.classList.add('scrubbing')
  scrubTo(e.clientX)
}

function scrubTo(clientX) {
  const day = dayStartOf(state.date)
  // today the playhead stops at the live edge: nothing after it is recorded yet
  const last = state.live ? Math.min(day + DAY, edgeNow()) : day + DAY
  const t = Math.min(last, Math.max(day, timeAt(clientX)))
  scrub.t = t
  state.position = t
  throttle.push(t)
  scheduleDraw()
}

function endScrub() {
  const t = scrub.t
  scrub = null
  throttle.cancel()
  timeline.classList.remove('scrubbing')
  seek(t) // plays from there ({seek}; stills off going forward)
}

timeline.addEventListener('pointerdown', (e) => {
  timeline.setPointerCapture(e.pointerId)
  if (onPlayhead(e.clientX)) return startScrub(e)
  drag = { x: e.clientX, start: state.view.start, moved: false }
})
timeline.addEventListener('pointermove', (e) => {
  const r = timeline.getBoundingClientRect()
  hoverX = e.clientX - r.left
  if (scrub) return scrubTo(e.clientX)
  if (drag) {
    const dx = e.clientX - drag.x
    if (Math.abs(dx) > 3) drag.moved = true
    if (drag.moved) {
      state.view.start = drag.start - (dx / r.width) * state.view.span
      clampView()
    }
  } else timeline.classList.toggle('on-playhead', onPlayhead(e.clientX))
  scheduleDraw()
})
timeline.addEventListener('pointerup', (e) => {
  if (scrub) return endScrub()
  if (drag && !drag.moved) seek(timeAt(e.clientX))
  drag = null
})
timeline.addEventListener('pointercancel', () => {
  if (scrub) endScrub()
  drag = null
})
timeline.addEventListener('pointerleave', () => {
  hoverX = null
  scheduleDraw()
})
timeline.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    zoom(e.deltaY > 0 ? 1.4 : 1 / 1.4, timeAt(e.clientX))
  },
  { passive: false }
)
new ResizeObserver(() => drawTimeline()).observe(timeline)

// ---- controls -------------------------------------------------------------

playBtn.addEventListener('click', togglePause)
$('back').addEventListener('click', () => seek((state.position ?? state.view.start) - SEEK_STEP))
$('fwd').addEventListener('click', () => seek((state.position ?? state.view.start) + SEEK_STEP))
$('prevEvent').addEventListener('click', () => jumpEvent(-1))
$('nextEvent').addEventListener('click', () => jumpEvent(1))
$('zoomIn').addEventListener('click', () => zoom(1 / 2))
$('zoomOut').addEventListener('click', () => zoom(2))
$('zoomDay').addEventListener('click', () => {
  state.view = { start: dayStartOf(state.date), span: DAY }
  drawTimeline()
})
speedSel.addEventListener('change', () => setSpeed(Number(speedSel.value)))
qualitySel.addEventListener('change', () => {
  const v = qualitySel.value
  if (v === 'server' || v === 'sd-nvr') {
    // server recordings (HD) or the NVR's SD: the other mode, at the same moment
    state.quality = v
    if (v === 'sd-nvr') state.stream = 1
    return reloadKeepingPosition().then(() => {
      // HD (server) chosen, but this day plays from the NVR after all (no server footage, H.265)
      if (v === 'server' && state.mode !== 'server' && lastPick) showNotice(lastPick.why)
    })
  }
  state.stream = Number(v)
  if (state.position !== null) seek(state.position)
})

/** Loads the day again (its mode may change) and plays on at the same moment, converted by the skew. */
async function reloadKeepingPosition() {
  const from = { mode: state.mode, skew: state.skew }
  const pos = state.position
  await loadDay(() => {
    const p = convertTime(pos, from.mode, state.mode, { fromSkew: from.skew, toSkew: state.skew })
    if (p !== null) seek(p)
  })
}

cameraSel.addEventListener('change', async () => {
  const [nvr, ch] = cameraSel.value.split('/')
  state.nvr = nvr
  state.ch = Number(ch)
  history.replaceState(null, '', `?${nvrQ()}&ch=${state.ch}`)
  clearSearch(true)
  await reloadKeepingPosition()
})

/**
 * The NVR's clock and recording days. Returns the error if the NVR is busy (then nothing
 * changes); otherwise null, with this computer's clock standing in if the NVR's can't be read.
 */
async function loadNvrInfo() {
  const nvr = state.nvr
  const [now, dates] = await Promise.all([
    api(`/api/playback/now?${nvrQ()}`).catch((e) => e),
    api(`/api/playback/dates?${nvrQ()}`).catch((e) => e)
  ])
  const busy = [now, dates].find((r) => r?.retryAfterS)
  if (busy) return busy
  const clock = now instanceof Error ? { now: Date.now() } : now
  if (!(now instanceof Error)) state.clockOf = nvr
  state.nvrNow = clock.now
  state.tz = clock.tzOffsetMs ?? 0
  state.skew = clock.skewMs ?? state.skew
  dateInput.max = fmtDate(state.nvrNow)
  dateInput.min = (Array.isArray(dates) && dates[0]) || ''
  return null
}

dateInput.addEventListener('change', async () => {
  if (!dateInput.value) return
  state.date = dateInput.value
  state.view = { start: dayStartOf(state.date), span: DAY }
  if (ws?.kind === 'server' && ws.readyState === WebSocket.OPEN) {
    // server mode keeps its socket: paused, and what it still sends is dropped
    ws.gen++
    ws.send(JSON.stringify({ pause: true }))
    throttle.cancel()
    player.seekReset()
  } else {
    if (ws) {
      ws.onclose = null
      ws.close()
      ws = null
    }
    player.reset()
  }
  state.position = null
  clearSearch(false)
  await loadDay(() => {
    if (state.ranges.length) seek(state.ranges[0][0])
  })
})

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  if (e.key === ' ') {
    e.preventDefault()
    togglePause()
  } else if (e.key === 'ArrowLeft') {
    e.shiftKey ? jumpEvent(-1) : seek((state.position ?? 0) - 10_000)
  } else if (e.key === 'ArrowRight') {
    e.shiftKey ? jumpEvent(1) : seek((state.position ?? 0) + 10_000)
  } else if (e.key === 'd' || e.key === 'D') {
    showStats = !showStats
    document.querySelector('.pb-main').classList.toggle('show-stats', showStats)
  }
})

setInterval(() => {
  if (!showStats) return
  const s = player.stats
  const src = state.mode === 'server' ? (state.src ?? 'server') : 'nvr'
  videoEl.querySelector('.stats').textContent = [
    `${s.width}×${s.height} ${s.codec} (${s.hw})`,
    `decoded ${s.coded} · visible ${s.visible} · canvas ${player.canvas.width}×${player.canvas.height}`,
    `${s.fps} fps · jitter ${s.jitterMs} ms`,
    `buffer ${s.delayMs} ms · ${s.kbps} kbps`,
    `dropped ${s.dropped} · late ${s.late}`,
    `src ${src} · start ${startMs ?? '-'} ms`
  ].join('\n')
}, 1000)

// keep today's timeline growing
setInterval(async () => {
  if (state.mode === 'server') return refreshServer().catch(() => {})
  try {
    const clock = await api(`/api/playback/now?${nvrQ()}`)
    state.nvrNow = clock.now
    state.tz = clock.tzOffsetMs ?? state.tz
    if (state.date === fmtDate(state.nvrNow)) {
      const { ranges, events } = await api(`/api/playback/recordings?${nvrQ()}&ch=${state.ch}&date=${state.date}`)
      state.ranges = ranges
      state.events = events
      scheduleDraw()
    }
  } catch {}
}, 60_000)

// ---- motion search in a box ---------------------------------------------------

const searchToggle = $('searchToggle')
const searchPanel = $('searchPanel')
const boxLayer = $('boxLayer')
const boxEl = $('box')
const searchGo = $('searchGo')
const searchStop = $('searchStop')
const searchStatus = $('searchStatus')
const searchProgress = $('searchProgress')
const searchHits = $('searchHits')
let box = null // [x, y, w, h] as fractions of the picture
let searchWs = null

/** Where the picture actually is inside the tile (the canvas letterboxes it). */
function pictureRect() {
  const r = videoEl.querySelector('canvas').getBoundingClientRect()
  const vw = player.videoWidth || 16
  const vh = player.videoHeight || 9
  const scale = Math.min(r.width / vw, r.height / vh)
  const w = vw * scale
  const h = vh * scale
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h }
}

function showBox() {
  if (!box) {
    boxEl.hidden = true
    return
  }
  const pic = pictureRect()
  const tile = videoEl.getBoundingClientRect()
  Object.assign(boxEl.style, {
    left: `${pic.left - tile.left + box[0] * pic.width}px`,
    top: `${pic.top - tile.top + box[1] * pic.height}px`,
    width: `${box[2] * pic.width}px`,
    height: `${box[3] * pic.height}px`
  })
  boxEl.hidden = false
}
new ResizeObserver(showBox).observe(videoEl)

let drawFrom = null
const clamp01 = (v) => Math.min(1, Math.max(0, v))
const toPicture = (e) => {
  const pic = pictureRect()
  return [clamp01((e.clientX - pic.left) / pic.width), clamp01((e.clientY - pic.top) / pic.height)]
}
boxLayer.addEventListener('pointerdown', (e) => {
  drawFrom = toPicture(e)
  try {
    boxLayer.setPointerCapture(e.pointerId) // keep the drag going outside the layer
  } catch {}
})
boxLayer.addEventListener('pointermove', (e) => {
  if (!drawFrom) return
  const [x, y] = toPicture(e)
  box = [Math.min(x, drawFrom[0]), Math.min(y, drawFrom[1]), Math.abs(x - drawFrom[0]), Math.abs(y - drawFrom[1])]
  showBox()
})
boxLayer.addEventListener('pointerup', () => {
  drawFrom = null
  if (box && (box[2] < 0.02 || box[3] < 0.02)) box = null // a click, not a drag
  showBox()
  searchGo.disabled = !box || Boolean(searchWs)
  $('searchHelp').textContent = box ? 'Drag again to redraw the box.' : 'Drag a box on the picture around the area to watch.'
})

searchToggle.addEventListener('click', () => {
  const open = searchPanel.hidden
  searchPanel.hidden = !open
  boxLayer.hidden = !open
  searchToggle.setAttribute('aria-pressed', String(open))
  if (open) {
    // freeze the picture while drawing so the box lines up with what you see
    if (!state.paused) togglePause()
  } else {
    stopSearch()
  }
  showBox()
})

function searchWindow() {
  const pos = state.position ?? state.view.start + state.view.span / 2
  const mode = $('searchRange').value
  let from
  let to
  if (mode === 'hour') [from, to] = [pos - 3_600_000, pos]
  else if (mode === 'day') [from, to] = [dayStartOf(state.date), dayStartOf(state.date) + DAY]
  else [from, to] = [state.view.start, state.view.start + state.view.span]
  const dayStart = dayStartOf(state.date)
  from = Math.max(from, dayStart)
  to = Math.min(to, dayStart + DAY, state.nvrNow - 60_000)
  return [Math.round(from), Math.round(to)]
}

function renderHits() {
  const items = [...state.hits]
    .sort((a, b) => a.start - b.start)
    .map((hit) => {
      const li = document.createElement('li')
      const btn = document.createElement('button')
      btn.type = 'button'
      const when = document.createElement('b')
      when.textContent = fmtTime(hit.start)
      const secs = Math.round((hit.end - hit.start) / 1000)
      const len = document.createElement('span')
      len.textContent = secs > 2 ? `${secs}s` : 'moment'
      btn.append(when, len)
      btn.addEventListener('click', () => {
        ensureVisible(hit.start)
        seek(hit.start - 3000)
      })
      li.append(btn)
      return li
    })
  searchHits.replaceChildren(...items)
}

function startSearch() {
  if (!box || searchWs) return
  const [from, to] = searchWindow()
  if (to <= from) {
    searchStatus.textContent = 'Nothing recorded in that range yet.'
    return
  }
  state.hits = []
  renderHits()
  scheduleDraw()
  // free this page's own playback while searching: the NVR only handles about two
  // playbacks at once well, and the search wants both (Play or a result resumes it).
  // Server playback does not use the NVR: its socket stays, paused.
  if (ws && ws.kind !== 'server') {
    ws.onclose = null
    ws.close()
    ws = null
  }
  if (!state.paused) {
    state.paused = true
    send({ pause: true })
    player.pause()
    updatePlayButton()
  }
  // the search runs on the NVR's recordings, in its clock: server-mode times are converted
  const off = state.mode === 'server' ? state.skew : 0
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const params = new URLSearchParams({
    ch: state.ch,
    from: from + off,
    to: to + off,
    box: box.map((v) => v.toFixed(4)).join(','),
    sens: $('searchSens').value
  })
  const sock = new WebSocket(`${proto}://${location.host}/motion?${nvrQ()}&${params}`)
  searchWs = sock
  let total = 1
  const started = Date.now()
  searchGo.disabled = true
  searchStop.hidden = false
  searchProgress.hidden = false
  searchProgress.firstElementChild.style.width = '0%'
  searchStatus.textContent = `Searching ${fmtTime(from)} – ${fmtTime(to)}…`
  sock.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'plan') {
      total = Math.max(1, msg.total)
      const mins = Math.max(1, Math.round(msg.total / 60_000))
      searchStatus.textContent = msg.basedOnEvents
        ? `Checking ${mins} min of footage where the NVR saw motion…`
        : `Checking ${mins} min of footage…`
    } else if (msg.type === 'progress') {
      searchProgress.firstElementChild.style.width = `${Math.min(100, (msg.done / total) * 100)}%`
    } else if (msg.type === 'hit') {
      state.hits.push(off ? { ...msg, start: msg.start - off, end: msg.end - off } : msg)
      renderHits()
      scheduleDraw()
    } else if (msg.type === 'done') {
      const secs = Math.round((Date.now() - started) / 1000)
      const plural = msg.hits === 1 ? '' : 's'
      searchStatus.textContent = msg.hits
        ? `Found ${msg.hits} moment${plural} with movement in the box (${secs}s). Click one to watch it.`
        : `No movement in the box (${secs}s). Try a higher sensitivity or a bigger box.`
    } else if (msg.type === 'error') {
      searchStatus.textContent = msg.message
    }
  }
  sock.onclose = () => {
    if (searchWs !== sock) return
    searchWs = null
    searchGo.disabled = !box
    searchStop.hidden = true
    searchProgress.hidden = true
  }
}

function stopSearch() {
  if (!searchWs) return
  const ws = searchWs
  searchWs = null
  ws.close()
  searchGo.disabled = !box
  searchStop.hidden = true
  searchProgress.hidden = true
  searchStatus.textContent = 'Search stopped.'
}

/** Clears results; with dropBox also forgets the box (another camera). */
function clearSearch(dropBox) {
  stopSearch()
  state.hits = []
  renderHits()
  searchStatus.textContent = ''
  if (dropBox) {
    box = null
    showBox()
    searchGo.disabled = true
  }
  scheduleDraw()
}

searchGo.addEventListener('click', startSearch)
searchStop.addEventListener('click', stopSearch)
$('searchClear').addEventListener('click', () => clearSearch(true))

// ---- start ----------------------------------------------------------------

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.href = '/login.html'
})

if (!('VideoDecoder' in window)) {
  showMessage(
    window.isSecureContext
      ? 'This browser cannot decode video (no WebCodecs). Use a current Chrome, Edge or Safari.'
      : 'Video needs a secure connection. Open this page with https:// (port 8443) instead.'
  )
}

updateModeUi()
const [me, cameras] = await Promise.all([api('/api/me'), api('/api/cameras')])
$('whoami').textContent = me.user
if (me.admin) $('sitesTab').hidden = $('settingsTab').hidden = false
state.h265 = await canDecodeH265()

// camera list grouped by site and NVR
const groups = Map.groupBy(cameras, (c) => `${c.site} · ${c.nvrName}`)
for (const [label, list] of groups) {
  const group = document.createElement('optgroup')
  group.label = label
  for (const cam of list) group.append(new Option(`${cam.ch + 1} · ${cam.name}${cam.online ? '' : ' (offline)'}`, `${cam.nvr}/${cam.ch}`))
  cameraSel.append(group)
}
// ?nvr=ID&ch=N from the Live view; otherwise the first online camera
const params = new URLSearchParams(location.search)
const wanted = cameras.find((c) => c.nvr === params.get('nvr') && String(c.ch) === params.get('ch'))
const first = wanted ?? cameras.find((c) => c.online) ?? cameras[0]
if (!first) {
  showMessage('No cameras yet. Add an NVR with: docker exec -it tvt-cctv node cctv/nvr.mjs add')
  throw new Error('no cameras')
}
state.nvr = first.nvr
state.ch = first.ch
cameraSel.value = `${first.nvr}/${first.ch}`

/**
 * Today, playing from shortly before now. From the server's recordings when it has this camera's
 * (the NVR is not waited for: a minute back, the file being written is readable); otherwise from
 * the NVR as before (a few minutes back; while the NVR is busy: again when it is free).
 */
async function start() {
  if (state.clockOf === null) {
    // (until the timeline or the NVR says: this computer's clock and time zone)
    state.tz = -new Date().getTimezoneOffset() * 60_000
    state.nvrNow = Date.now()
  }
  state.date = fmtDate(state.nvrNow)
  const tl = await fetchTimeline()
  if (pickMode({ timeline: tl, h265: state.h265, quality: state.quality }).mode === 'server') {
    if (Number.isFinite(tl.tzOffsetMs)) state.tz = tl.tzOffsetMs
    state.nvrNow = tl.now
    state.date = fmtDate(state.nvrNow)
    dateInput.value = state.date
    state.view = { start: dayStartOf(state.date), span: DAY }
    return loadDay(() => {
      if (state.mode !== 'server') return startNvrDay()
      // a minute back (the file being written is readable), the last hour in view
      state.view = { start: state.nvrNow - 60 * 60_000, span: 2 * 60 * 60_000 }
      clampView()
      const last = state.ranges.at(-1)
      if (last) seek(Math.min(state.nvrNow - START_BACK_SERVER_MS, last[1] - START_BACK_SERVER_MS))
    })
  }
  const busy = await loadNvrInfo()
  // (while busy: today by this computer's clock, so the page works meanwhile)
  state.date = fmtDate(state.nvrNow)
  dateInput.value = state.date
  state.view = { start: dayStartOf(state.date), span: DAY }
  if (busy) {
    drawTimeline()
    retryWhenFree(busy, start)
    return
  }
  await loadDay(startNvrDay)
}

/** NVR playback of today: 5 minutes back (the newest minute or so is still being written by the NVR), last hour in view. */
function startNvrDay() {
  state.view = { start: state.nvrNow - 60 * 60_000, span: 2 * 60 * 60_000 }
  clampView()
  if (state.ranges.length) seek(Math.min(state.nvrNow - START_BACK_MS, state.ranges.at(-1)[1] - START_BACK_MS))
}
await start()
updatePlayButton()
