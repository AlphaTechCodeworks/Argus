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
import { follow as followView, fmtClock, laneBoxes, makeView, panBy, spanLabel, ticks, zoomAt } from './pb-view.js'
import { bookmarkMarkers, canEdit, checkBookmark, filterBookmarks, sortBookmarks, spanText } from './bookmarks-view.js'
import { allowedSpeeds, clampSpeed, frameStep, shuttleLabel, shuttleRate } from './pb-transport.js'
import { DEFAULT_OSD, drawOsd, osdFont, osdIsOff, osdLayout } from './osd-overlay.js'

// Video is decoded here in the browser, exactly as the camera encoded it; the
// server never converts it. Recordings in H.265 need a browser/PC that can decode H.265.
const H265_HELP =
  // The old wording blamed the graphics card and told people to find another PC. That is usually
  // wrong and sends them off to solve the wrong problem: on Windows the commonest cause by far is
  // that the machine has no H.265 decoder installed at all, whatever its graphics card can do.
  // Windows does not ship one, because the codec is licensed -- a brand new laptop with a good GPU
  // fails exactly like an old one until the extension is added, and then works immediately.
  'This recording is H.265, which this browser cannot play.\n\n' +
  'On Windows this is usually a missing codec rather than a slow machine: Chrome and Edge need the "HEVC Video Extensions" from the Microsoft Store, which Windows does not include. Installing it normally fixes this straight away, whatever graphics card you have.\n\n' +
  'Otherwise: open it in Chrome or Edge on a machine that has H.265 (Safari on a Mac plays it without anything extra), or set this camera to record in H.264 on the NVR.'

const HEADER_SIZE = 16
const DAY = 86_400_000
// The timeline is drawn from ordinary elements rather than a canvas, so every box can carry its own
// title and click. That only stays cheap because nothing outside the view is drawn (laneBoxes clips)
// and each lane is capped: a day of one-second motion events would otherwise be tens of thousands.
const MIN_SPAN = 10_000
const MAX_BOXES = 400
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
const qualitySel = $('quality')
const clockEl = $('clock')
const clockInput = $('clockInput')
const messageEl = $('message')
const noticeEl = $('pbNotice')
const badgeEl = $('srcBadge')
const skewEl = $('skewHint')
const legendServer = $('legendServer')
const hintEl = $('pbHint')
const videoEl = $('video')
const spinnerEl = $('spinner')
const timeline = $('timeline')
const laneRec = $('laneRec')
const laneMotion = $('laneMotion')
const ticksEl = $('ticks')
const playheadEl = $('playhead')
const nowEl = $('tlNow')
const hoverLine = $('hoverLine')
const hoverLabel = $('hoverLabel')
const overview = $('overview')
const ovBoxes = $('ovBoxes')
const ovWindow = $('ovWindow')
const ovNow = $('ovNow')
const speedsEl = $('speeds')
const spanEl = $('spanLabel')
const dateEl = $('pbDate')
const followBtn = $('followBtn')
const shuttleEl = $('shuttle')
const shuttleLabelEl = $('shuttleLabel')
const shortcutsDlg = $('shortcuts')
const zoomBtns = [...document.querySelectorAll('.pb-zoom button')]

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
  // the window on the day (pb-view.js): absolute ms, always valid, always replaced rather than edited
  view: makeView({ dayStartMs: 0, dayEndMs: DAY, spanMs: DAY, minSpanMs: MIN_SPAN }),
  follow: true, // keep the playhead on screen while it plays; panning switches it off
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
let hoverX = null // where the pointer is over the timeline, in px from its left edge
let drag = null // { x, startMs, moved } while the timeline is being panned

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
  spinnerEl.hidden = true // the first picture is here: whatever we were waiting for has arrived
  if (seekAt === null) return
  startMs = Math.round(performance.now() - seekAt)
  seekAt = null
}

/** The spinner while there is nothing to show yet: seeking, another camera, another quality. */
function showSpinner() {
  spinnerEl.hidden = false
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
  if (pick.mode === 'server') {
    // Said once per day loaded: the picture is a conversion, not the recording itself, and a viewer
    // comparing it with the original later deserves to know that.
    if (pick.transcode) showNotice(pick.why)
    return enterServerDay(tl, token, after)
  }
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

/**
 * The speed buttons for the mode shown (pb-transport allowedSpeeds: the server's whole ladder, the
 * NVR's 1-8 forward). Rebuilt only when the mode changes; otherwise just the pressed one moves.
 */
function renderSpeeds() {
  if (speedsEl.dataset.kind !== state.mode) {
    speedsEl.replaceChildren(
      ...allowedSpeeds(state.mode).map((s) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = speedLabel(s)
        b.dataset.speed = String(s)
        b.addEventListener('click', () => setSpeed(s))
        return b
      })
    )
    speedsEl.dataset.kind = state.mode
  }
  for (const b of speedsEl.children) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === state.speed))
}

/** Speeds, quality choices, legend, skew hint and source badge for the mode shown. */
function updateModeUi() {
  const server = state.mode === 'server'
  renderSpeeds()
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
  showSpinner()
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
  showSpinner()
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
  // h265 tells the server what this browser can decode. It is the only thing that lets the server
  // convert an H.265 recording to H.264 (transcode.mjs), so a browser that can decode H.265 always
  // gets the recording exactly as the camera made it.
  const sock = new WebSocket(`${proto}://${location.host}/playback?${nvrQ()}&ch=${state.ch}&stream=0&start=${Math.round(start)}&src=auto&h265=${state.h265 ? 1 : 0}`)
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
      renderSpeeds()
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

// The mode we have already explained a clamp for: an NVR leg refuses reverse and anything above 8x,
// and saying so on every button press would be nagging, so it is said once per mode.
let clampedFor = null

/**
 * Play at `speed`, or at the nearest speed this source will actually accept. Every speed bound for a
 * session goes through clampSpeed, so an NVR leg is never sent one it would refuse and drop.
 */
function setSpeed(speed) {
  const { speed: allowed, changed } = clampSpeed(speed, state.mode)
  if (changed && clampedFor !== state.mode) {
    clampedFor = state.mode
    showNotice(`This camera's NVR cannot play at ${speedLabel(speed)}: playing at ${speedLabel(allowed)}.`)
  }
  state.speed = allowed
  send({ speed: allowed })
  player.setRate(rateOf(allowed))
  renderSpeeds()
  scheduleDraw()
  return allowed
}

/** One frame back or on (pb-transport frameStep), paused where it lands. */
function stepFrame(direction) {
  if (state.position === null) return
  const fps = Number(player.stats?.fps) > 0 ? Number(player.stats.fps) : 25
  const target = frameStep(state.position / 1000, direction, fps) * 1000
  seek(target)
  if (!state.paused) togglePause()
}

function jumpEvent(direction) {
  const pos = state.position ?? state.view.startMs
  const list = state.events.map(([s]) => s)
  const target = direction > 0 ? list.find((s) => s > pos + 2000) : list.filter((s) => s < pos - 2000).at(-1)
  if (target !== undefined) {
    ensureVisible(target)
    seek(target)
  }
}

// ---- timeline -------------------------------------------------------------
//
// The timeline is built from ordinary elements, not a canvas: each recorded stretch, gap and motion
// block is its own div, so it can carry a title the browser shows on hover and be clicked directly.
// The maths all comes from pb-view.js, which knows nothing about the DOM; this half only positions
// things as percentages of the track, so a resize needs no redraw.

/**
 * Replace the view. Every change goes through here, so the day's limits (and the minimum span) are
 * written down in exactly one place and no caller can leave the window off the end of the day.
 */
function setView(v) {
  const dayStart = dayStartOf(state.date)
  state.view = makeView({ ...v, minSpanMs: MIN_SPAN, maxSpanMs: DAY, dayStartMs: dayStart, dayEndMs: dayStart + DAY })
  scheduleDraw()
}

/** The whole day on screen. */
const viewWholeDay = () => setView({ startMs: dayStartOf(state.date), spanMs: DAY })

let drawPending = false
function scheduleDraw() {
  if (drawPending) return
  drawPending = true
  requestAnimationFrame(() => {
    drawPending = false
    // follow mode keeps the playhead in sight; pb-view returns the same object when nothing must move
    if (state.follow && state.position !== null && !scrub && !drag) {
      const next = followView(state.view, state.position)
      if (next !== state.view) {
        const dayStart = dayStartOf(state.date)
        state.view = makeView({ ...next, minSpanMs: MIN_SPAN, maxSpanMs: DAY, dayStartMs: dayStart, dayEndMs: dayStart + DAY })
      }
    }
    drawTimeline()
    drawClock()
  })
}

/** The big clock and the date beside it. Milliseconds only under a two-minute span, where they mean something. */
function drawClock() {
  dateEl.textContent = state.date ?? ''
  if (!clockInput.hidden) return // the viewer is typing a time: leave the field alone
  clockEl.textContent = state.position === null
    ? '--:--:--'
    : fmtClock(state.position, { ms: state.view.spanMs < 120_000, tzOffsetMs: state.tz })
}

/**
 * The stretches for the top lane. In server mode they are split by source — the server's own
 * footage and the stretches only the NVR has — with the recorder's gaps on top, so a hover says why
 * nothing was recorded. In NVR mode there is only one source, so it all reads as plain recorded.
 */
function recRanges() {
  if (state.mode !== 'server') return state.ranges.map(([s, e]) => ({ s, e, kind: 'rec' }))
  const out = state.stretches.map(({ s, e, src }) => ({ s, e, kind: src }))
  for (const [s, e] of state.gaps) out.push({ s, e, kind: 'gap' })
  return out
}

/**
 * Fill a lane with positioned divs. Only boxes laneBoxes kept (those inside the view) are made, and
 * at most MAX_BOXES of them: a busy day of motion events would otherwise be tens of thousands of
 * elements, which is the price of leaving the canvas behind.
 */
function fillLane(el, boxes, decorate) {
  const nodes = boxes.slice(0, MAX_BOXES).map((b) => {
    const d = document.createElement('div')
    d.style.left = `${b.leftPct}%`
    d.style.width = `${b.widthPct}%`
    d.dataset.kind = b.kind ?? 'rec'
    decorate?.(d, b)
    return d
  })
  el.replaceChildren(...nodes)
}

function drawTimeline() {
  const v = state.view
  const pct = (t) => ((t - v.startMs) / v.spanMs) * 100
  const inView = (t) => Number.isFinite(t) && t >= v.startMs && t <= v.endMs

  fillLane(laneRec, laneBoxes(v, recRanges()), (d, b) => {
    if (b.kind === 'gap') d.title = `Not recorded: ${gapAt(state.gaps, b.from) ?? 'no reason given'}`
    else d.title = `${fmtTime(b.from)} – ${fmtTime(b.to)}${b.kind === 'nvr' ? ' · from the NVR' : ''}`
  })

  // the motion lane, with the search's own hits drawn over it; clicking a block plays from it
  const events = state.events.map(([s, e]) => ({ s, e, kind: 'event' }))
  const hits = state.hits.map((h) => ({ s: h.start, e: h.end + 2000, kind: 'hit' }))
  fillLane(laneMotion, [...laneBoxes(v, events), ...laneBoxes(v, hits)], (d, b) => {
    d.title = `${b.kind === 'hit' ? 'Movement in your box' : 'Motion'} at ${fmtTime(b.from)}`
    // the seek happens in the timeline's own pointerup, so a click does not both jump and pan
    d.dataset.ms = String(Math.round(b.from))
  })

  playheadEl.hidden = state.position === null || !inView(state.position)
  if (!playheadEl.hidden) playheadEl.style.left = `${pct(state.position)}%`
  nowEl.hidden = !inView(state.nvrNow)
  if (!nowEl.hidden) nowEl.style.left = `${pct(state.nvrNow)}%`

  ticksEl.replaceChildren(
    ...ticks(v, state.tz).map((t) => {
      const s = document.createElement('span')
      s.style.left = `${pct(t.ms)}%`
      s.textContent = t.label
      return s
    })
  )
  spanEl.textContent = spanLabel(v.spanMs)
  for (const b of zoomBtns) b.setAttribute('aria-pressed', String(Number(b.dataset.span) === Math.round(v.spanMs)))
  followBtn.setAttribute('aria-pressed', String(state.follow))
  drawClip()
  drawBookmarks()
  drawOverview()
  drawHover()
}

/** The whole day, with the zoomed part marked. Its own view is the day itself, so laneBoxes clips to it. */
function drawOverview() {
  const dayStart = dayStartOf(state.date)
  const day = makeView({ dayStartMs: dayStart, dayEndMs: dayStart + DAY, spanMs: DAY })
  fillLane(ovBoxes, laneBoxes(day, recRanges().filter((r) => r.kind !== 'gap')))
  ovWindow.style.left = `${((state.view.startMs - dayStart) / DAY) * 100}%`
  ovWindow.style.width = `${(state.view.spanMs / DAY) * 100}%`
  ovNow.hidden = state.nvrNow < dayStart || state.nvrNow > dayStart + DAY
  if (!ovNow.hidden) ovNow.style.left = `${((state.nvrNow - dayStart) / DAY) * 100}%`
}

/** The line and label under the pointer: the time there, and in server mode why nothing was recorded. */
function drawHover() {
  if (hoverX === null || scrub) {
    hoverLine.hidden = true
    hoverLabel.hidden = true
    return
  }
  const w = timeline.clientWidth || 1
  const t = state.view.startMs + (hoverX / w) * state.view.spanMs
  const gap = state.mode === 'server' ? gapAt(state.gaps, t) : null
  hoverLine.hidden = false
  hoverLabel.hidden = false
  hoverLine.style.left = `${hoverX}px`
  hoverLabel.textContent = gap ? `${fmtTime(t)} · not recorded: ${gap}` : fmtTime(t)
  hoverLabel.style.left = `${Math.min(Math.max(0, hoverX - hoverLabel.offsetWidth / 2), Math.max(0, w - hoverLabel.offsetWidth))}px`
}

function zoom(factor, anchorMs) {
  setView(zoomAt(state.view, factor, anchorMs ?? state.position ?? state.view.startMs + state.view.spanMs / 2))
}

function ensureVisible(t) {
  if (t < state.view.startMs || t > state.view.endMs) setView({ ...state.view, startMs: t - state.view.spanMs / 2 })
}

/** Panning is a deliberate look elsewhere, so it drops follow mode; the button puts it back. */
function setFollow(on) {
  state.follow = on
  followBtn.setAttribute('aria-pressed', String(on))
  scheduleDraw()
}

const timeAt = (clientX) => {
  const r = timeline.getBoundingClientRect()
  return state.view.startMs + ((clientX - r.left) / r.width) * state.view.spanMs
}

/** Server mode: whether a press at clientX grabs the playhead (within 8 px of it). */
function onPlayhead(clientX) {
  if (state.mode !== 'server' || state.position === null) return false
  const r = timeline.getBoundingClientRect()
  const px = ((state.position - state.view.startMs) / state.view.spanMs) * r.width
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

// Pinch zoom: two pointers on the track zoom about the point between them. The view they started
// from is kept, so the zoom follows the fingers exactly instead of compounding on every move.
const pointers = new Map()
let pinch = null

const pinchSpread = () => {
  const [a, b] = [...pointers.values()]
  return { gap: Math.abs(a.x - b.x), mid: (a.x + b.x) / 2 }
}

timeline.addEventListener('pointerdown', (e) => {
  timeline.setPointerCapture(e.pointerId)
  pointers.set(e.pointerId, { x: e.clientX })
  if (pointers.size === 2) {
    if (scrub) endScrub()
    drag = null
    const { gap, mid } = pinchSpread()
    pinch = { gap: Math.max(1, gap), view: state.view, atMs: timeAt(mid) }
    return
  }
  if (pointers.size > 2) return
  if (onPlayhead(e.clientX)) return startScrub(e)
  drag = { x: e.clientX, startMs: state.view.startMs, moved: false }
})

timeline.addEventListener('pointermove', (e) => {
  const r = timeline.getBoundingClientRect()
  hoverX = e.clientX - r.left
  if (pointers.has(e.pointerId)) pointers.get(e.pointerId).x = e.clientX
  if (pinch && pointers.size === 2) {
    const { gap } = pinchSpread()
    setView(zoomAt(pinch.view, pinch.gap / Math.max(1, gap), pinch.atMs))
    return
  }
  if (scrub) return scrubTo(e.clientX)
  if (drag) {
    const dx = e.clientX - drag.x
    if (Math.abs(dx) > 3) drag.moved = true
    if (drag.moved) {
      if (state.follow) setFollow(false)
      setView({ ...state.view, startMs: drag.startMs - (dx / r.width) * state.view.spanMs })
      return
    }
  }
  if (!drag) timeline.classList.toggle('on-playhead', onPlayhead(e.clientX))
  scheduleDraw()
})

timeline.addEventListener('pointerup', (e) => {
  pointers.delete(e.pointerId)
  if (pointers.size < 2) pinch = null
  if (scrub) return endScrub()
  if (drag && !drag.moved) {
    // a motion block under the pointer says where it starts; elsewhere the time under the pointer
    const ms = Number(e.target?.dataset?.ms)
    seek(Number.isFinite(ms) ? ms : timeAt(e.clientX))
  }
  drag = null
})

timeline.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId)
  if (pointers.size < 2) pinch = null
  if (scrub) endScrub()
  drag = null
})

timeline.addEventListener('dblclick', (e) => seek(timeAt(e.clientX)))

timeline.addEventListener('pointerleave', () => {
  hoverX = null
  scheduleDraw()
})

timeline.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    // a trackpad pinch arrives as a wheel with ctrlKey; both zoom about the pointer
    zoom(e.deltaY > 0 ? 1.4 : 1 / 1.4, timeAt(e.clientX))
  },
  { passive: false }
)

// ---- the overview strip: drag the window, or click to put it somewhere ----

let ovDrag = null
const ovTimeAt = (clientX) => {
  const r = overview.getBoundingClientRect()
  return dayStartOf(state.date) + ((clientX - r.left) / r.width) * DAY
}

overview.addEventListener('pointerdown', (e) => {
  overview.setPointerCapture(e.pointerId)
  setFollow(false) // choosing where to look is the same deliberate act as panning
  const t = ovTimeAt(e.clientX)
  const inside = t >= state.view.startMs && t <= state.view.endMs
  // grabbing the window keeps the point you took hold of under the pointer; elsewhere it centres there
  ovDrag = { offset: inside ? t - state.view.startMs : state.view.spanMs / 2 }
  setView({ ...state.view, startMs: t - ovDrag.offset })
})
overview.addEventListener('pointermove', (e) => {
  if (!ovDrag) return
  setView({ ...state.view, startMs: ovTimeAt(e.clientX) - ovDrag.offset })
})
const endOvDrag = () => (ovDrag = null)
overview.addEventListener('pointerup', endOvDrag)
overview.addEventListener('pointercancel', endOvDrag)

new ResizeObserver(() => drawTimeline()).observe(timeline)

// ---- controls -------------------------------------------------------------

playBtn.addEventListener('click', togglePause)
$('back').addEventListener('click', () => seek((state.position ?? state.view.startMs) - SEEK_STEP))
$('fwd').addEventListener('click', () => seek((state.position ?? state.view.startMs) + SEEK_STEP))
$('prevEvent').addEventListener('click', () => jumpEvent(-1))
$('nextEvent').addEventListener('click', () => jumpEvent(1))
$('framePrev').addEventListener('click', () => stepFrame(-1))
$('frameNext').addEventListener('click', () => stepFrame(1))

// zoom presets: the span stays centred on the playhead, or on the middle of the view without one
for (const b of zoomBtns) {
  b.addEventListener('click', () => {
    const at = state.position ?? state.view.startMs + state.view.spanMs / 2
    setView({ ...state.view, spanMs: Number(b.dataset.span), startMs: at - Number(b.dataset.span) / 2 })
  })
}
followBtn.addEventListener('click', () => setFollow(!state.follow))

// the day arrows move the date picker, so the existing change handler does the loading
const shiftDay = (days) => {
  const d = new Date(`${state.date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  dateInput.value = d.toISOString().slice(0, 10)
  dateInput.dispatchEvent(new Event('change'))
}
$('dayPrev').addEventListener('click', () => shiftDay(-1))
$('dayNext').addEventListener('click', () => shiftDay(1))

// ---- the clock you can type into -------------------------------------------

/** Turn the clock into a field holding the time on screen; Enter goes there, Escape puts it back. */
function openClockInput() {
  clockInput.value = state.position === null ? '' : fmtClock(state.position, { ms: state.view.spanMs < 120_000, tzOffsetMs: state.tz })
  clockEl.hidden = true
  clockInput.hidden = false
  clockInput.focus()
  clockInput.select()
}
function closeClockInput() {
  clockInput.hidden = true
  clockEl.hidden = false
  scheduleDraw()
}
/** "9:34", "09:34:48" or "09:34:48.199" as ms into the day, or null when it reads as nothing. */
function parseClock(text) {
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?\s*$/.exec(text ?? '')
  if (!m) return null
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
  if (h > 23 || min > 59 || s > 59) return null
  const ms = Number((m[4] ?? '0').padEnd(3, '0'))
  return ((h * 60 + min) * 60 + s) * 1000 + ms
}
clockEl.addEventListener('click', openClockInput)
clockInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeClockInput()
  if (e.key !== 'Enter') return
  const into = parseClock(clockInput.value)
  if (into === null) {
    showNotice('That is not a time. Type it as hh:mm:ss.')
    return
  }
  const t = dayStartOf(state.date) + into
  closeClockInput()
  ensureVisible(t)
  seek(t)
})
clockInput.addEventListener('blur', closeClockInput)

// ---- the shuttle: spring-loaded, back to ordinary play when let go -----------
//
// Letting go returns to 1x forward rather than pausing: scrubbing is how you get to the moment
// you want, and what you want next is almost always to watch it. Pausing instead meant pressing
// play again every single time.

function applyShuttle() {
  const rate = shuttleRate(Number(shuttleEl.value) / 100)
  if (rate === 0) {
    // the middle of the travel is a hold, not a pause: nothing moves while the finger rests there
    shuttleLabelEl.textContent = shuttleLabel(0)
    if (!state.paused) togglePause()
    return
  }
  if (state.paused) togglePause()
  // the label shows what is actually playing, not what was asked for, when the source clamped it
  shuttleLabelEl.textContent = shuttleLabel(setSpeed(rate))
}
shuttleEl.addEventListener('input', applyShuttle)

const springBack = () => {
  shuttleEl.value = '0'
  const { speed } = clampSpeed(1, state.mode)
  setSpeed(speed)
  if (state.paused) togglePause()
  shuttleLabelEl.textContent = shuttleLabel(speed)
}
shuttleEl.addEventListener('pointerup', springBack)
shuttleEl.addEventListener('pointercancel', springBack)
shuttleEl.addEventListener('keyup', springBack)

// ---- snapshot ----------------------------------------------------------------

/** The picture on screen as a JPEG named after the camera and the moment it shows. */
function snapshot() {
  const src = player.canvas
  if (!src.width || !src.height) return showNotice('There is no picture to save yet.')
  const out = document.createElement('canvas')
  out.width = src.width
  out.height = src.height
  out.getContext('2d').drawImage(src, 0, 0)
  // The overlay goes into the saved still too. A picture taken off this page is often the thing
  // that ends up in a report, and a still with no time on it is worth a great deal less than one
  // with the time on it -- the same time the timeline and the clock box are showing.
  drawOsd(out.getContext('2d'), osdLayoutNow(src.width, src.height, out.getContext('2d')))
  const when = state.position ?? state.nvrNow
  // colons are not allowed in a Windows file name, so the time is written with dashes
  const name = `${cameraSel.selectedOptions[0]?.textContent ?? camKey()} ${fmtDate(when)} ${fmtTime(when).replaceAll(':', '-')}.jpg`
  out.toBlob((blob) => {
    if (!blob) return showNotice('The picture could not be saved.')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name.replace(/[\\/:*?"<>|]/g, '-')
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }, 'image/jpeg', 0.92)
}
$('snapshot').addEventListener('click', snapshot)

// ---- choosing a clip to export -----------------------------------------------
//
// Two marks on the timeline with draggable handles. The times are kept as absolute milliseconds,
// not as fractions of the view, so zooming and panning never move the clip you chose — which is
// the whole point of being able to zoom in to pick a moment precisely.
//
// Bookmarks sit on the same timeline (see further down): the clip is a stretch you are about to
// export, a bookmark is a stretch someone wants kept and findable.

const clip = { on: false, from: null, to: null }
const clipSelEl = $('clipSel')
const clipFromEl = $('clipFrom')
const clipToEl = $('clipTo')
const selectClipBtn = $('selectClip')
const exportBtn = $('exportClip')

/** Keeps `from` before `to` and both inside the day, whichever handle was moved. */
function setClip(from, to) {
  const dayStart = dayStartOf(state.date)
  const lo = dayStart
  const hi = dayStart + DAY
  clip.from = Math.min(Math.max(from, lo), hi)
  clip.to = Math.min(Math.max(to, lo), hi)
  if (clip.to < clip.from) [clip.from, clip.to] = [clip.to, clip.from]
  scheduleDraw()
}

function clipOn(on) {
  clip.on = on
  selectClipBtn.setAttribute('aria-pressed', String(on))
  selectClipBtn.classList.toggle('pb-on', on)
  exportBtn.disabled = !on
  if (on && clip.from === null) {
    // Start with a stretch you can actually see and grab. A fixed minute looked sensible until you
    // try it on a two-hour view, where it is under one percent of the width: the two handles land
    // on top of each other and read as a single mark. So the first clip is a fifth of whatever is
    // on screen, which keeps the two ends clearly apart at any zoom, within sane bounds.
    const at = state.position ?? state.view.startMs + state.view.spanMs / 2
    const half = Math.min(30 * 60_000, Math.max(5000, state.view.spanMs / 10))
    setClip(at - half, at + half)
  }
  scheduleDraw()
}

const selectClipStart = () => { if (!clip.on) clipOn(true); setClip(state.position ?? clip.from, clip.to ?? (state.position ?? 0) + 60_000) }
const selectClipEnd = () => { if (!clip.on) clipOn(true); setClip(clip.from ?? (state.position ?? 0) - 60_000, state.position ?? clip.to) }

selectClipBtn.addEventListener('click', () => clipOn(!clip.on))

/** Draws the chosen stretch and its two handles; called from drawTimeline. */
function drawClip() {
  const show = clip.on && clip.from !== null && clip.to !== null
  clipSelEl.hidden = !show
  clipFromEl.hidden = !show
  clipToEl.hidden = !show
  if (!show) return
  const v = state.view
  const pct = (t) => ((t - v.startMs) / v.spanMs) * 100
  clipSelEl.style.left = `${pct(clip.from)}%`
  clipSelEl.style.width = `${Math.max(0, pct(clip.to) - pct(clip.from))}%`
  clipFromEl.style.left = `${pct(clip.from)}%`
  clipToEl.style.left = `${pct(clip.to)}%`
  const secs = Math.round((clip.to - clip.from) / 1000)
  clipSelEl.title = `${fmtTime(clip.from)} – ${fmtTime(clip.to)} (${Math.floor(secs / 60)} min ${secs % 60} s)`
}

/** Dragging a handle. The times come from the timeline's own scale, so zooming keeps them true. */
function grabHandle(el, which) {
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation() // the timeline's own pointerdown would pan instead
    el.setPointerCapture(e.pointerId)
    const move = (ev) => {
      const t = timeAt(ev.clientX)
      if (which === 'from') setClip(t, clip.to)
      else setClip(clip.from, t)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true })
    el.addEventListener('pointercancel', () => el.removeEventListener('pointermove', move), { once: true })
  })
}
grabHandle(clipFromEl, 'from')
grabHandle(clipToEl, 'to')

// ---- bookmarks ---------------------------------------------------------------
//
// A bookmark is a stretch someone marked as mattering ("van reverses into the gate"). It is drawn
// as a diamond on the timeline, listed beside the picture, and — the part that is not about the
// screen at all — it stops housekeeping deleting that footage later.
//
// The rules about what a bookmark may contain live in bookmarks-view.js, which the server loads
// too, so the form here refuses exactly what the server would refuse. The page still sends the bad
// one nowhere: the check is only so the person hears about it at once, and the server checks again
// because a page is not a permission.
//
// Times are the same absolute milliseconds as everything else here. In server mode that is the
// server's clock and in NVR mode the NVR's, which is the clock a bookmark is stored in — a bookmark
// made while watching an NVR whose clock is out is therefore marked in that NVR's time, the same
// time printed on the picture, which is what the person marking it saw.

const bmPanel = $('bookmarkPanel')
const bmBtn = $('bookmark')
const bmList = $('bookmarkList')
const bmMarks = $('bookmarkMarks')
const bmFind = $('bookmarkFind')
const bmThisCamera = $('bookmarkThisCamera')
const bmStatus = $('bookmarkStatus')
const bmDlg = $('bmDlg')
const bmHeading = $('bmTitleHeading')
const bmTitle = $('bmTitle')
const bmFrom = $('bmFrom')
const bmTo = $('bmTo')
const bmDay = $('bmDay')
const bmCameras = $('bmCameras')
const bmNotes = $('bmNotes')
const bmMsg = $('bmMsg')
const bmSave = $('bmSave')

/** Who is signed in, for deciding which Edit and Delete buttons to draw. Filled in at start-up. */
let viewer = { user: null, admin: false }
/** Every bookmark the server answered with, whatever camera; the list and the marks filter it. */
let bookmarks = []
/** The bookmark being edited, or null while adding a new one. */
let editing = null

const bmSay = (text, bad = false) => {
  bmMsg.textContent = text
  bmMsg.className = `pb-ex-msg${bad ? ' pb-ex-bad' : ''}`
}
/** The camera on screen as a key, or null before one is chosen. */
const thisCamera = () => (state.nvr === null || state.nvr === undefined ? null : camKey())

async function bmApi(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  if (res.status === 401) location.href = '/login.html'
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

/** The bookmarks the panel and the timeline show: this camera's unless the tick box says otherwise. */
function shownBookmarks() {
  return sortBookmarks(filterBookmarks(bookmarks, { text: bmFind.value, camera: bmThisCamera.checked ? thisCamera() : null }))
}

/**
 * Reads every bookmark once and keeps them here. They are few and they change rarely, so filtering
 * in the browser keeps typing in the Find box instant and saves a request per keystroke.
 */
async function loadBookmarks() {
  try {
    const { bookmarks: list, user, admin } = await bmApi('GET', '/api/bookmarks')
    bookmarks = list ?? []
    viewer = { user: user ?? viewer.user, admin: admin === true }
    bmStatus.textContent = ''
  } catch (e) {
    // The picture still plays without them, so this is a note rather than a takeover of the page.
    bmStatus.textContent = `Bookmarks are not available: ${e.message}`
  }
  drawBookmarkList()
  scheduleDraw()
}

/** The diamonds and their faint bands. Called from drawTimeline, so zooming and panning move them. */
function drawBookmarks() {
  const marks = bookmarkMarkers(state.view, shownBookmarks())
  bmMarks.replaceChildren(
    ...marks.flatMap((m) => {
      const nodes = []
      if (m.widthPct > 0) {
        const band = document.createElement('div')
        band.className = 'pb-bm-band'
        band.style.left = `${m.leftPct}%`
        band.style.width = `${m.widthPct}%`
        nodes.push(band)
      }
      const d = document.createElement('button')
      d.type = 'button'
      d.className = 'pb-bm-mark'
      d.style.left = `${m.leftPct}%`
      d.title = `${m.title} · ${fmtTime(m.ms)}${m.user ? ` · ${m.user}` : ''}`
      d.setAttribute('aria-label', d.title)
      // the true start, not the diamond's position: a mark clamped to the edge of the window stands
      // for a bookmark that begins off-screen
      d.addEventListener('click', (e) => {
        e.stopPropagation() // the timeline's own pointer handling would pan or seek instead
        ensureVisible(m.ms)
        seek(m.ms)
      })
      nodes.push(d)
      return nodes
    })
  )
}

/** The list beside the picture. Edit and Delete appear only for the bookmarks this person may change. */
function drawBookmarkList() {
  const list = shownBookmarks()
  if (!list.length) {
    bmList.replaceChildren()
    if (!bmStatus.textContent) bmStatus.textContent = bookmarks.length ? 'Nothing matches.' : 'No bookmarks yet.'
    return
  }
  if (bmStatus.textContent === 'Nothing matches.' || bmStatus.textContent === 'No bookmarks yet.') bmStatus.textContent = ''
  bmList.replaceChildren(
    ...list.map((b) => {
      const li = document.createElement('li')
      const go = document.createElement('button')
      go.type = 'button'
      go.className = 'pb-bm-go'
      go.append(b.title)
      const when = document.createElement('span')
      when.className = 'pb-bm-when'
      // The day is shown as well as the clock: the list is not limited to the day on screen, and a
      // bookmark from last week reading only "09:14" would look like this morning.
      when.textContent = `${fmtDate(b.startMs)} ${fmtTime(b.startMs)} · ${spanText(b.startMs, b.endMs)} · ${b.user ?? 'not available'}`
      go.append(when)
      go.addEventListener('click', () => openBookmark(b))
      li.append(go)
      if (b.description) {
        const p = document.createElement('p')
        p.className = 'pb-bm-note'
        p.textContent = b.description
        li.append(p)
      }
      if (canEdit(b, viewer)) {
        const actions = document.createElement('div')
        actions.className = 'pb-bm-actions'
        const edit = document.createElement('button')
        edit.type = 'button'
        edit.textContent = 'Edit'
        edit.addEventListener('click', () => openBookmarkDialog(b))
        const del = document.createElement('button')
        del.type = 'button'
        del.textContent = 'Delete'
        del.addEventListener('click', () => removeBookmark(b))
        actions.append(edit, del)
        li.append(actions)
      }
      return li
    })
  )
}

/**
 * Clicking a bookmark: show the camera and moment it marks, switching camera and day if need be.
 * The day and the camera are set before a single reload rather than each firing its own change
 * handler, because two reloads in flight at once land wherever the slower one finishes.
 */
async function openBookmark(b) {
  const key = b.cameras?.[0]
  const known = Boolean(key) && [...cameraSel.options].some((o) => o.value === key)
  const day = fmtDate(b.startMs)
  if (day !== state.date) {
    state.date = day
    dateInput.value = day
    viewWholeDay()
  }
  state.position = b.startMs
  if (known && key !== thisCamera()) {
    const [nvr, ch] = key.split('/')
    await goToCamera(nvr, Number(ch), b.startMs)
  } else {
    await reloadKeepingPosition()
  }
  ensureVisible(b.startMs)
  seek(b.startMs)
}

/**
 * The add/edit dialog. Adding starts from the clip if one is marked — the usual way of working is
 * to mark the stretch first and then say what it is — and otherwise from the moment on screen, as a
 * bookmark of that instant.
 */
async function openBookmarkDialog(existing = null) {
  editing = existing
  bmHeading.textContent = existing ? 'Edit bookmark' : 'Add a bookmark'
  const from = existing ? existing.startMs : clip.on && clip.from !== null ? clip.from : state.position
  const to = existing ? existing.endMs : clip.on && clip.to !== null ? clip.to : state.position
  if (from === null || to === null) return showNotice('Nothing is playing yet, so there is no moment to bookmark.')
  bmTitle.value = existing?.title ?? ''
  bmNotes.value = existing?.description ?? ''
  bmFrom.value = fmtTime(from)
  bmTo.value = fmtTime(to)
  bmDay.textContent = `On ${fmtDate(from)}, in the time shown on the picture.`
  bmSay('')

  const wanted = new Set(existing?.cameras ?? [thisCamera()].filter(Boolean))
  const cams = await fetch('/api/cameras').then((r) => (r.ok ? r.json() : [])).catch(() => [])
  bmCameras.replaceChildren(
    ...cams.map((c) => {
      const o = document.createElement('option')
      o.value = `${c.nvr}/${c.ch}`
      o.textContent = `${c.name} · ${c.nvrName}`
      o.selected = wanted.has(o.value)
      return o
    })
  )
  bmDlg.showModal()
  bmTitle.focus()
}

/** B, and the Add button. */
function addBookmark() {
  if (bmPanel.hidden) showBookmarkPanel(true)
  openBookmarkDialog(null)
}

/**
 * The typed times back into absolute ms. They are read against the day the bookmark is on rather
 * than the day on screen, so editing an old bookmark from today's view does not move it to today.
 */
function timesFromDialog(dayMs) {
  const dayStart = dayStartOf(fmtDate(dayMs))
  const from = parseClock(bmFrom.value)
  const to = parseClock(bmTo.value)
  if (from === null || to === null) return null
  // A bookmark that runs over midnight is typed with the end earlier than the start; treating that
  // as the next day is the only reading that is not simply a mistake.
  return { startMs: dayStart + from, endMs: dayStart + to + (to < from ? DAY : 0) }
}

bmSave.addEventListener('click', async () => {
  const cameras = [...bmCameras.selectedOptions].map((o) => o.value)
  const base = editing ? editing.startMs : (clip.on && clip.from !== null ? clip.from : state.position) ?? Date.now()
  const times = timesFromDialog(base)
  if (!times) return bmSay('Type the times as hh:mm:ss.', true)
  const wanted = { cameras, ...times, title: bmTitle.value, description: bmNotes.value }
  const checked = checkBookmark(wanted)
  if (!checked.ok) return bmSay(checked.error, true)

  bmSave.disabled = true
  try {
    if (editing) await bmApi('PATCH', `/api/bookmarks/${editing.id}`, checked.value)
    else await bmApi('POST', '/api/bookmarks', checked.value)
    bmDlg.close()
    await loadBookmarks()
    showNotice(editing ? 'Bookmark saved.' : 'Bookmark added.')
  } catch (e) {
    bmSay(e.message, true)
  } finally {
    bmSave.disabled = false
  }
})

async function removeBookmark(b) {
  if (!confirm(`Delete the bookmark "${b.title}"?`)) return
  try {
    await bmApi('DELETE', `/api/bookmarks/${b.id}`)
    await loadBookmarks()
  } catch (e) {
    bmStatus.textContent = e.message
  }
}

function showBookmarkPanel(on) {
  bmPanel.hidden = !on
  bmBtn.setAttribute('aria-pressed', String(on))
  bmBtn.classList.toggle('pb-on', on)
  if (on) loadBookmarks()
}

bmBtn.addEventListener('click', () => showBookmarkPanel(bmPanel.hidden))
$('bookmarkAdd').addEventListener('click', () => openBookmarkDialog(null))
bmFind.addEventListener('input', () => {
  drawBookmarkList()
  scheduleDraw()
})
bmThisCamera.addEventListener('change', () => {
  drawBookmarkList()
  scheduleDraw()
})

$('shortcutsBtn').addEventListener('click', () => shortcutsDlg.showModal())
$('shortcutsClose').addEventListener('click', () => shortcutsDlg.close())

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
  viewWholeDay()
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
  // a textarea counts too: B in the bookmark notes used to open a second bookmark dialog
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return
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
  } else if (e.key === ',') {
    stepFrame(-1)
  } else if (e.key === '.') {
    stepFrame(1)
  } else if (e.key === '+' || e.key === '=') {
    zoom(1 / 2)
  } else if (e.key === '-' || e.key === '_') {
    zoom(2)
  } else if (e.key === '0') {
    viewWholeDay()
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault()
    openClockInput()
  } else if (e.key === '[') {
    selectClipStart()
  } else if (e.key === ']') {
    selectClipEnd()
  } else if (e.key === 'b' || e.key === 'B') {
    addBookmark()
  } else if (e.key === 'f' || e.key === 'F') {
    toggleFullscreen()
  } else if (e.key === '?') {
    shortcutsDlg.showModal()
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
  const pos = state.position ?? state.view.startMs + state.view.spanMs / 2
  const mode = $('searchRange').value
  let from
  let to
  if (mode === 'hour') [from, to] = [pos - 3_600_000, pos]
  else if (mode === 'day') [from, to] = [dayStartOf(state.date), dayStartOf(state.date) + DAY]
  else [from, to] = [state.view.startMs, state.view.endMs]
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
if (me.admin) { const st = $('sitesTab'); if (st) st.hidden = false; const se = $('settingsTab'); if (se) se.hidden = false }
// who this is, for deciding which bookmarks offer Edit and Delete (the server decides again itself)
viewer = { user: me.user, admin: me.admin === true }
state.h265 = await canDecodeH265()

// camera list grouped by site and NVR: online cameras only, so the list holds nothing that cannot
// be used. The camera being watched stays even if it goes offline (marked so), rather than vanishing
// from under the viewer. Re-read every 30 s, so a camera that comes back appears by itself.
let cameraListSig = ''
function fillCameraList(list, keep) {
  const shown = list.filter((c) => c.online || `${c.nvr}/${c.ch}` === keep)
  const sig = JSON.stringify(shown.map((c) => [c.nvr, c.ch, c.name, c.online]))
  if (sig === cameraListSig) return
  cameraListSig = sig
  const groups = Map.groupBy(shown, (c) => `${c.site} · ${c.nvrName}`)
  cameraSel.replaceChildren(...[...groups].map(([label, cams]) => {
    const group = document.createElement('optgroup')
    group.label = label
    for (const cam of cams) group.append(new Option(`${cam.ch + 1} · ${cam.name}${cam.online ? '' : ' (offline)'}`, `${cam.nvr}/${cam.ch}`))
    return group
  }))
  if (keep) cameraSel.value = keep
}
// ?nvr=ID&ch=N from the Live view; otherwise the first online camera
const params = new URLSearchParams(location.search)
const wanted = cameras.find((c) => c.nvr === params.get('nvr') && String(c.ch) === params.get('ch'))
const first = wanted ?? cameras.find((c) => c.online) ?? cameras[0]
if (first) fillCameraList(cameras, `${first.nvr}/${first.ch}`)
setInterval(async () => {
  const list = await fetch('/api/cameras').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  if (Array.isArray(list)) fillCameraList(list, cameraSel.value || null)
}, 30_000)
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
    viewWholeDay()
    return loadDay(() => {
      if (state.mode !== 'server') return startNvrDay()
      // a minute back (the file being written is readable), the last hour in view
      setView({ startMs: state.nvrNow - 60 * 60_000, spanMs: 2 * 60 * 60_000 })
      const last = state.ranges.at(-1)
      if (last) seek(Math.min(state.nvrNow - START_BACK_SERVER_MS, last[1] - START_BACK_SERVER_MS))
    })
  }
  const busy = await loadNvrInfo()
  // (while busy: today by this computer's clock, so the page works meanwhile)
  state.date = fmtDate(state.nvrNow)
  dateInput.value = state.date
  viewWholeDay()
  if (busy) {
    drawTimeline()
    retryWhenFree(busy, start)
    return
  }
  await loadDay(startNvrDay)
}

/** NVR playback of today: 5 minutes back (the newest minute or so is still being written by the NVR), last hour in view. */
function startNvrDay() {
  setView({ startMs: state.nvrNow - 60 * 60_000, spanMs: 2 * 60 * 60_000 })
  if (state.ranges.length) seek(Math.min(state.nvrNow - START_BACK_MS, state.ranges.at(-1)[1] - START_BACK_MS))
}
await start()
updatePlayButton()

// ---- digital zoom on the picture ---------------------------------------------
//
// Magnifies what is already on screen, for reading a face, a number plate or a till display.
// It is only a transform of the canvas: no extra video is fetched and no detail is invented, so
// zooming in past what the camera recorded simply shows bigger pixels.
//
// The motion-search box sits over the same picture and needs raw pointer coordinates, so zooming
// is disabled while that box is open rather than trying to map coordinates through the transform.

const MAX_ZOOM = 8
const zoomCanvas = videoEl.querySelector('canvas')
const zoomState = { z: 1, x: 0, y: 0 } // x and y are pixel offsets of the scaled picture

const zoomBusy = () => !boxLayer.hidden

/** Keeps the picture covering the tile: you can never pan to an empty edge. */
function clampZoom() {
  const { width: w, height: h } = zoomCanvas.getBoundingClientRect()
  const maxX = (zoomState.z - 1) * w
  const maxY = (zoomState.z - 1) * h
  zoomState.x = Math.min(0, Math.max(-maxX, zoomState.x))
  zoomState.y = Math.min(0, Math.max(-maxY, zoomState.y))
}

function applyZoom() {
  clampZoom()
  const { z, x, y } = zoomState
  zoomCanvas.style.transformOrigin = '0 0'
  zoomCanvas.style.transform = z === 1 ? '' : `translate(${x}px, ${y}px) scale(${z})`
  videoEl.classList.toggle('zoomed', z > 1)
  const badge = $('zoomBadge')
  if (badge) {
    badge.hidden = z === 1
    badge.textContent = `${z.toFixed(1)}×`
  }
}

/** Zooms about a point, so whatever is under the pointer stays under it. */
function zoomVideoAt(factor, clientX, clientY) {
  const r = zoomCanvas.getBoundingClientRect()
  const next = Math.min(MAX_ZOOM, Math.max(1, zoomState.z * factor))
  if (next === zoomState.z) return
  // the picture coordinate under the pointer, before and after
  const px = (clientX - r.left - zoomState.x) / zoomState.z
  const py = (clientY - r.top - zoomState.y) / zoomState.z
  zoomState.z = next
  zoomState.x = clientX - r.left - px * next
  zoomState.y = clientY - r.top - py * next
  if (next === 1) { zoomState.x = 0; zoomState.y = 0 }
  applyZoom()
}

const resetZoom = () => { zoomState.z = 1; zoomState.x = 0; zoomState.y = 0; applyZoom() }

videoEl.addEventListener('wheel', (e) => {
  if (zoomBusy()) return
  e.preventDefault()
  zoomVideoAt(e.deltaY > 0 ? 1 / 1.25 : 1.25, e.clientX, e.clientY)
}, { passive: false })

let zoomDrag = null
videoEl.addEventListener('pointerdown', (e) => {
  if (zoomBusy() || zoomState.z === 1) return
  zoomDrag = { x: e.clientX, y: e.clientY, ox: zoomState.x, oy: zoomState.y }
  videoEl.setPointerCapture(e.pointerId)
})
videoEl.addEventListener('pointermove', (e) => {
  if (!zoomDrag) return
  zoomState.x = zoomDrag.ox + (e.clientX - zoomDrag.x)
  zoomState.y = zoomDrag.oy + (e.clientY - zoomDrag.y)
  applyZoom()
})
const endZoomDrag = () => { zoomDrag = null }
videoEl.addEventListener('pointerup', endZoomDrag)
videoEl.addEventListener('pointercancel', endZoomDrag)
videoEl.addEventListener('dblclick', (e) => { if (!zoomBusy()) { e.preventDefault(); resetZoom() } })

// a zoomed picture must not follow you to another camera or another moment
$('camera').addEventListener('change', resetZoom)
new ResizeObserver(applyZoom).observe(videoEl)

// ---- full screen -------------------------------------------------------------
//
// The video and its controls go full screen together, not the picture alone: reviewing footage
// means scrubbing, and a timeline you cannot reach is worse than a slightly smaller picture.

const fullBtn = $('fullscreen')
const fullTarget = document.body

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  else fullTarget.requestFullscreen?.().catch(() => {})
}

fullBtn?.addEventListener('click', toggleFullscreen)
document.addEventListener('fullscreenchange', () => {
  const on = Boolean(document.fullscreenElement)
  document.body.classList.toggle('is-fullscreen', on)
  if (fullBtn) {
    fullBtn.setAttribute('aria-pressed', String(on))
    fullBtn.textContent = on ? 'Exit full screen' : 'Full screen'
  }
  applyZoom() // the picture changed size, so the pan limits did too
})
if (!document.fullscreenEnabled && fullBtn) fullBtn.hidden = true

// ---- the export dialog -------------------------------------------------------
//
// Talks to /api/exports (export-api.mjs). The clip's times come from the two handles on the
// timeline; the server trims to the nearest keyframes and records in the manifest what it
// actually produced, which will differ by a second or two from what was asked for.

const exportDlg = $('exportDlg')
const exPeriod = $('exPeriod')
const exClockWarn = $('exClockWarn')
const exCameras = $('exCameras')
const exName = $('exName')
const exNotes = $('exNotes')
// no password field yet: the export API does not accept one
const exMsg = $('exMsg')
const exProgress = $('exProgress')
const exStart = $('exStart')

const exSay = (text, bad = false) => {
  exMsg.textContent = text
  exMsg.className = `pb-ex-msg${bad ? ' pb-ex-bad' : ''}`
}

async function openExport() {
  if (clip.from === null || clip.to === null) return
  const secs = Math.round((clip.to - clip.from) / 1000)
  exPeriod.textContent = `${state.date} · ${fmtTime(clip.from)} – ${fmtTime(clip.to)} (${Math.floor(secs / 60)} min ${secs % 60} s)`

  // A wrong NVR clock is the sort of thing that gets evidence thrown out, so say it here rather
  // than only burying it in the manifest.
  const skew = Math.round((state.skew ?? 0) / 1000)
  exClockWarn.hidden = Math.abs(skew) < 30
  exClockWarn.textContent = exClockWarn.hidden
    ? ''
    : `This NVR's clock is ${Math.abs(skew)} s ${skew > 0 ? 'fast' : 'slow'}. The export records both times and the difference, so the real time can be shown.`

  // every camera, with the one on screen already chosen
  const cams = await fetch('/api/cameras').then((r) => (r.ok ? r.json() : [])).catch(() => [])
  exCameras.replaceChildren(
    ...cams.map((c) => {
      const o = document.createElement('option')
      o.value = `${c.nvr}/${c.ch}`
      o.textContent = `${c.name} · ${c.nvrName}`
      o.selected = c.nvr === state.nvr && c.ch === state.ch
      return o
    })
  )

  exName.value = `${state.date} ${fmtTime(clip.from).slice(0, 5)} ${cameraSel.selectedOptions[0]?.textContent ?? 'export'}`
  exNotes.value = ''
  exProgress.hidden = true
  exStart.disabled = false
  exSay('')
  exportDlg.showModal()
}
exportBtn.addEventListener('click', openExport)

exStart.addEventListener('click', async () => {
  const cameras = [...exCameras.selectedOptions].map((o) => {
    const [nvr, ch] = o.value.split('/')
    return { nvr, ch: Number(ch) }
  })
  if (!cameras.length) return exSay('Choose at least one camera.', true)
  const format = document.querySelector('input[name="exFormat"]:checked')?.value ?? 'pack'

  exStart.disabled = true
  exProgress.hidden = false
  exProgress.value = 0
  exSay('Starting…')
  try {
    const started = await fetch('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // one clip per camera: the server takes each camera's own range, so a future version can
      // export different moments per camera without changing the shape
      body: JSON.stringify({
        clips: cameras.map((c) => ({ nvr: c.nvr, ch: c.ch, fromMs: Math.round(clip.from), toMs: Math.round(clip.to) })),
        format,
        name: exName.value,
        notes: exNotes.value
      })
    }).then(async (r) => {
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      return d
    })
    await followExport(started.id)
  } catch (e) {
    exSay(e.message, true)
    exStart.disabled = false
    exProgress.hidden = true
  }
})

/** Polls until the export finishes, then offers it. */
async function followExport(id) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    let job
    try {
      job = await fetch(`/api/exports/${encodeURIComponent(id)}`).then((r) => r.json())
    } catch {
      continue // a blip in polling is not a failed export
    }
    if (Number.isFinite(job.progress?.pct)) exProgress.value = job.progress.pct
    if (job.state === 'done') {
      exProgress.hidden = true
      exSay('Ready.')
      const a = document.createElement('a')
      a.href = `/api/exports/${encodeURIComponent(id)}/download`
      a.textContent = 'Download the export'
      a.className = 'pb-ex-download'
      exMsg.append(' ', a)
      exStart.disabled = false
      return
    }
    if (job.state === 'failed' || job.state === 'cancelled') {
      exProgress.hidden = true
      exSay(job.error ?? 'The export did not finish.', true)
      exStart.disabled = false
      return
    }
    exSay(job.progress?.message ?? job.progress?.step ?? 'Working…')
  }
}

// ---- following someone from camera to camera ---------------------------------
//
// The cameras here are not smart: nothing detects a person and hands them over. What makes a
// follow quick is simply knowing which camera adjoins which (camera-links.mjs, drawn on the site
// map) and keeping the moment when you switch — which reloadKeepingPosition already does.
//
// Following is trial and error: you guess a direction, find nothing, and go back. So the back
// step matters as much as the forward one, and it must return you to the moment you left, not to
// wherever the other camera has since played on to.

const followEl = $('follow')
const followListEl = $('followList')
const followBackEl = $('followBack')

let cameraLinks = {} // "<nvr>/<ch>" -> [{ to, label }]
let followSuggestions = [] // guesses from the map, never stored
const followTrail = [] // where we came from: { nvr, ch, atMs }

// the existing camKey() is for the camera on screen; this one names any camera
const keyOf = (nvr, ch) => `${nvr}/${ch}`

/** Whoever is in the camera list, by key, for names. */
const cameraNameOf = (key) => {
  for (const o of cameraSel.options) if (o.value === key) return o.textContent
  return key
}

async function loadCameraLinks() {
  try {
    const d = await api('/api/camera-links')
    cameraLinks = d.links ?? {}
    followSuggestions = d.suggestions ?? []
  } catch {
    cameraLinks = {} // without links the strip simply does not appear
    followSuggestions = []
  }
  drawFollow()
}

function drawFollow() {
  const key = keyOf(state.nvr, state.ch)
  const links = cameraLinks[key] ?? []
  // suggestions are guesses from the map: offered only when nothing has been drawn for this
  // camera, and always labelled as guesses so nobody mistakes one for a known route
  const guesses = links.length ? [] : followSuggestions.filter((s) => s.from === key)
  const show = links.length > 0 || guesses.length > 0 || followTrail.length > 0
  followEl.hidden = !show
  followBackEl.hidden = followTrail.length === 0
  if (!show) return

  const button = (to, label, guess) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `pb-follow-cam${guess ? ' pb-follow-guess' : ''}`
    b.innerHTML = ''
    const name = document.createElement('span')
    name.className = 'pb-follow-name'
    name.textContent = cameraNameOf(to)
    const where = document.createElement('span')
    where.className = 'pb-follow-where'
    where.textContent = guess ? 'nearby on the map — not confirmed' : label || 'leads here'
    b.append(name, where)
    b.title = guess
      ? `${cameraNameOf(to)} is close by on the map. Nobody has confirmed this route.`
      : `Go to ${cameraNameOf(to)} at this moment${label ? ` — ${label}` : ''}`
    b.addEventListener('click', () => followTo(to))
    return b
  }

  followListEl.replaceChildren(
    ...links.map((l) => button(l.to, l.label, false)),
    ...guesses.map((s) => button(s.to, '', true))
  )
}

/** Switch to a neighbouring camera, staying at the moment on screen. */
async function followTo(key) {
  const [nvr, ch] = key.split('/')
  followTrail.push({ nvr: state.nvr, ch: state.ch, atMs: state.position })
  await goToCamera(nvr, Number(ch), state.position)
}

followBackEl.addEventListener('click', async () => {
  const back = followTrail.pop()
  if (back) await goToCamera(back.nvr, back.ch, back.atMs)
  drawFollow()
})

/** The camera switch the select does, but driven from code and with a moment to land on. */
async function goToCamera(nvr, ch, atMs) {
  state.nvr = nvr
  state.ch = ch
  cameraSel.value = keyOf(nvr, ch)
  history.replaceState(null, '', `?${nvrQ()}&ch=${ch}`)
  clearSearch(true)
  resetZoom()
  if (Number.isFinite(atMs)) state.position = atMs
  await reloadKeepingPosition()
  drawFollow()
}

cameraSel.addEventListener('change', () => {
  // choosing from the list is a fresh start, not a step in a follow
  followTrail.length = 0
  drawFollow()
})

await loadCameraLinks()

// The diamonds belong on the timeline whether or not the list beside the picture is open.
await loadBookmarks()

// ---- the on-screen display this app draws (osd-overlay.js) ---------------------------------------
//
// Drawn on a second canvas laid over the video canvas, not on the video canvas itself, because the
// player owns that one and redraws it on every frame. It is drawn from this page rather than from
// the shared render loop (player.js) on purpose: the streaming path stays exactly as it is and
// knows nothing about overlays.
//
// The moment shown is state.position, written with state.tz — deliberately the very same arithmetic
// the timeline, the clock box and the snapshot's file name use, so that everything on this page
// agrees. In server mode that position is already the server's clock. In NVR mode it is the NVR's,
// which is the clock that matches the footage being played; the settings panel says plainly which
// clock the overlay follows so nobody reads it as the camera's own burnt-in stamp.

const osdCanvas = videoEl.querySelector('canvas.osd')
let osdSettings = { default: DEFAULT_OSD, cameras: {} }
let osdSig = ''

async function loadOsd() {
  try {
    const data = await api('/api/osd')
    if (data?.default) osdSettings = { default: data.default, cameras: data.cameras ?? {} }
  } catch {
    // Not being able to read the overlay settings must never stop playback: the page simply draws
    // the built-in default, which is the least surprising thing it can do.
  }
}

/** This camera's overlay settings: its own where it has them, otherwise the site-wide default. */
const osdSettingsNow = () => osdSettings.cameras[camKey()] ?? osdSettings.default

/**
 * The layout for the picture at its current size. `ctx` is used only to measure text, so the same
 * layout can be produced for the canvas on screen and for a snapshot being saved.
 */
function osdLayoutNow(width, height, ctx) {
  return osdLayout({
    settings: osdSettingsNow(),
    // The camera's own name as the picker shows it. A camera with no name draws no name line.
    camera: { name: cameraSel.selectedOptions[0]?.textContent ?? '' },
    atMs: state.position ?? null,
    width,
    height,
    tzMs: state.tz,
    measure: ctx
      ? (text, fontPx) => {
          ctx.font = osdFont(fontPx)
          return ctx.measureText(text).width
        }
      : undefined
  })
}

/** Paints the overlay, once a second, which is the resolution of the clock it shows. */
function drawOverlay() {
  if (!osdCanvas) return
  const w = player.canvas.width
  const h = player.canvas.height
  if (osdIsOff(osdSettingsNow()) || !player.videoWidth || w < 2 || h < 2) {
    if (osdSig !== '') {
      osdCanvas.width = 0 // a zero-sized canvas draws nothing and costs nothing
      osdSig = ''
    }
    return
  }
  const ctx = osdCanvas.getContext('2d')
  if (!ctx) return
  const layout = osdLayoutNow(w, h, ctx)
  const sig = `${w}x${h}|${layout.lines.map((l) => `${l.text}@${Math.round(l.x)},${Math.round(l.y)}`).join('|')}`
  if (sig === osdSig && osdCanvas.width === w) return
  osdSig = sig
  if (osdCanvas.width !== w || osdCanvas.height !== h) {
    osdCanvas.width = w
    osdCanvas.height = h
  } else ctx.clearRect(0, 0, w, h)
  drawOsd(ctx, layout)
}

await loadOsd()
setInterval(drawOverlay, 1000)
