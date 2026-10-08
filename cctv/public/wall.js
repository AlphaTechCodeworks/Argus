// The camera wall: every chosen camera at one moment, on one shared timeline.
//
// Why it exists: "show me 14:00 to 14:10 on every camera". The cameras here are not smart — there is
// no person or vehicle detection — so an investigation is done purely on time. Opening cameras one at
// a time and lining their clocks up by hand is the slow part, and this page removes it.
//
// Everything is server time (pb-sources.js and rec-api.mjs define it). Each NVR's clock differs by
// skewMs (nvr1 runs about 220 s fast), so:
//   - a tile played from the NVR's own playback session is asked for cameraTime(t, skew),
//   - every position it reports comes back through serverTime(ts, skew) before it is compared with
//     the shared clock or shown to anyone.
// A tile played from the server's own recordings (src=auto) is already in server time, skew 0.
// If that were got wrong, two tiles would sit side by side both labelled 14:00 and be nearly four
// minutes apart, which is worse than not having the page — so the conversion lives in one pure
// module (wall-clock.js) and is tested there.
//
// The controls are the playback page's, reused: pb-view.js for the window on the day, pb-transport.js
// for the speed ladder and the shuttle, pb-sources.js for merging and skew, player.js for decoding.
// playback.js itself is deliberately not touched or imported: its state is the single-camera page's.
import { CODEC_H265, VideoPlayer, canDecodeH265 } from './player.js'
import { PLAYBACK_CLOCK } from './playout.js'
import { describeSkew, mergeSources, pbRights, recordedFrom, refusedMessage, wallQualities, wallTileMode } from './pb-sources.js'
import { follow as followView, fmtClock, makeView, spanLabel, ticks, zoomAt } from './pb-view.js'
import { allowedSpeeds, clampSpeed, shuttleLabel, shuttleRate } from './pb-transport.js'
import {
  MAX_TILES,
  WallClock,
  applyChoice,
  cameraTime,
  coverageAt,
  gridLayout,
  laneRows as buildLaneRows,
  loadWarning,
  MAX_LEAD_MS,
  aheadBy,
  aheadWait,
  needsResync,
  openLead,
  normaliseChoice,
  serverTime,
  tileState,
  wallMode
} from './wall-clock.js'
import {
  afterRefusal,
  afterVideo,
  applyViews,
  checkView,
  colsOf,
  exportClipsFor,
  groupCameras,
  laneSet,
  layoutFor,
  normaliseViews,
  openNote,
  openPlan,
  pageOf,
  searchCameras,
  slotsOf
} from './grid-view.js'

const DAY = 86_400_000
const MIN_SPAN = 10_000
const SEEK_STEP = 30_000
const HEADER_SIZE = 16
// A tile is never re-seeked more often than this: a wall of tiles all chasing the clock at once
// would spend its whole time opening sockets and never show a picture.
const RESYNC_EVERY_MS = 3000
const DRIFT_CHECK_MS = 500
// A tile that has been open this long without a picture says so; black reads as "nothing happened".
const NO_PICTURE_MS = 5000

const $ = (id) => document.getElementById(id)
const gridEl = $('grid')
const emptyEl = $('empty')
const loadNote = $('loadNote')
const dateInput = $('date')
const qualitySel = $('quality')
const laneTrack = $('laneTrack')
const laneNamesEl = $('laneNames')
const laneRowsEl = $('laneRows')
const ticksEl = $('ticks')
const playheadEl = $('playhead')
const nowEl = $('tlNow')
const clockEl = $('clock')
const clockInput = $('clockInput')
const spanEl = $('spanLabel')
const dateEl = $('wallDate')
const coverageEl = $('coverage')
const skewEl = $('skewHint')
const speedsEl = $('speeds')
const playBtn = $('play')
const followBtn = $('followBtn')
const shuttleEl = $('shuttle')
const shuttleLabelEl = $('shuttleLabel')
const pickDlg = $('pickDlg')
const pickList = $('pickList')
const pickNote = $('pickNote')
const pickSearch = $('pickSearch')
const layoutSel = $('layout')
const laneModeSel = $('laneMode')
const viewSel = $('viewSel')
const pagerEl = $('pager')
const pageLabel = $('pageLabel')

const state = {
  user: '',
  all: [], // every camera from /api/cameras
  cameras: [], // every camera CHOSEN, which may be more than one page of the grid holds
  tiles: [], // Tile, for the cameras on this page only — the only ones that ever stream
  layout: '2x2',
  page: 0,
  laneMode: 'all',
  focusKey: null, // the tile the toolbar last acted on, for the "this camera" lane
  maximised: null, // the key of the tile filling the grid, if any
  views: [], // this user's saved views, from /api/me/views
  viewsVersion: 0,
  viewId: '', // the saved view on screen, if the cameras still match it
  date: null,
  tz: 0, // the site's time-zone offset (local - UTC): the day shown is the cameras' day, not ours
  quality: 'sd', // 'sd' = the NVR's sub-streams, 'hd' = the server's own recordings
  h265: true,
  speed: 1,
  follow: true,
  view: makeView({ dayStartMs: 0, dayEndMs: DAY, spanMs: DAY, minSpanMs: MIN_SPAN }),
  serverNow: Date.now()
}

const clock = new WallClock({ atMs: Date.now(), now: () => performance.now() })

const pad = (n) => String(n).padStart(2, '0')
const localOf = (ms) => new Date(ms + state.tz)
const fmtDate = (ms) => {
  const d = localOf(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
const dayStartOf = (date) => Date.parse(`${date}T00:00:00Z`) - state.tz

async function api(path) {
  const res = await fetch(path)
  if (res.status === 401) location.href = '/login.html'
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

// ---- which cameras are on the wall ---------------------------------------------------------
//
// Kept per user in this browser. The house pattern for per-user preferences is user-prefs.mjs
// (data/user-prefs.json, versioned so two screens cannot silently overwrite each other), and the
// stored shape here is the same — { cameras, version }, changes applied through applyChoice — so
// the store behind it can move to the server later without this page changing. It is not on the
// server yet because that route is another change; until then a viewer's wall follows the browser
// they chose it in, not their account.

const STORE_KEY = 'cctv.wall.cameras'

function readStore() {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}')
    const mine = all?.[state.user]
    return { cameras: normaliseChoice(mine?.cameras), version: Number.isSafeInteger(mine?.version) ? mine.version : 0 }
  } catch {
    return { cameras: [], version: 0 }
  }
}

function writeStore(cameras) {
  const current = readStore()
  const next = applyChoice(current, { cameras, version: current.version })
  if (!next.saved) return next // another tab saved first: its choice stands, this one is reloaded
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}')
    all[state.user] = { cameras: next.cameras, version: next.version }
    localStorage.setItem(STORE_KEY, JSON.stringify(all))
  } catch {} // a browser refusing storage still shows the wall; it just forgets it
  return next
}

// ---- one tile -------------------------------------------------------------------------------

class Tile {
  /** @param {{ nvr: string, ch: number, name: string, nvrName: string, site: string }} cam */
  constructor(cam) {
    Object.assign(this, cam)
    this.rights ??= pbRights(null) // what this camera may be played from (/api/cameras?for=playback)
    this.key = `${cam.nvr}/${cam.ch}`
    this.skew = 0 // this NVR's clock - the server's (ms), from the timeline: no NVR call
    this.available = false // the server has an index of this camera's recordings
    this.codec = 'h264'
    this.stretches = []
    this.position = null // the moment on screen, in SERVER time (never the NVR's)
    this.lastSeekAt = -Infinity
    this.error = null
    this.refused = null // a 1008 refusal's words: final for this tile (status)
    this.undecodable = false
    this.ws = null
    this.shownKind = null
    this.blankOpens = 0 // sockets opened in a row that produced no picture at all
    this.openLagMs = null // how long this camera's stream takes from being asked for to its first picture (wall-clock.js openLead)
    this.askedAt = null // when the stream now open was asked for, until its first picture
    this.waitingForClock = false // ahead of the shared clock and held still until it arrives (sync)
    // How this camera has been treated by its NVR lately: the refusal count and the moment before
    // which it must not ask again (grid-view.js). Held per tile, so one full NVR does not stop the
    // cameras on a different one from opening.
    this.stream = {}

    this.el = document.createElement('div')
    this.el.className = 'wall-tile'
    this.el.innerHTML = `
      <canvas></canvas>
      <div class="wall-tile-msg" hidden></div>
      <div class="wall-tile-tools" role="group">
        <button type="button" data-act="snapshot" title="Save the picture on screen as a JPEG" aria-label="Snapshot">⤓</button>
        <button type="button" data-act="copy" title="Copy the picture on screen to the clipboard" aria-label="Copy picture">⧉</button>
        <button type="button" data-act="export" title="Export this camera over the stretch on screen" aria-label="Export this camera">⎘</button>
        <button type="button" data-act="max" title="Fill the grid with this camera (the others stop streaming)" aria-label="Maximise">⛶</button>
      </div>
      <div class="wall-tile-label">
        <a class="wall-tile-name" title="Open this camera on the playback page at this moment"></a>
        <span class="wall-tile-time"></span>
      </div>`
    this.el.querySelector('.wall-tile-tools').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act
      if (!act) return
      state.focusKey = this.key
      if (act === 'snapshot') this.snapshot()
      if (act === 'copy') this.copyPicture()
      if (act === 'export') openWallExport([this.key], `Export ${this.name}`)
      if (act === 'max') toggleMaximised(this.key)
      if (act !== 'snapshot' && act !== 'copy') scheduleDraw() // the lane set may have changed
    })
    this.msgEl = this.el.querySelector('.wall-tile-msg')
    this.nameEl = this.el.querySelector('.wall-tile-name')
    this.timeEl = this.el.querySelector('.wall-tile-time')
    this.nameEl.textContent = `${cam.name} · ${cam.nvrName}`

    this.player = new VideoPlayer(this.el.querySelector('canvas'), {
      // the playback page's clock: recordings arrive in bursts, not at frame rate, and after a
      // server stall they arrive late for good (playout.js PLAYBACK_CLOCK)
      clock: PLAYBACK_CLOCK,
      onFrame: (ts) => {
        // ts is in whatever clock this tile's source stamps: the server's own recordings are
        // already server time (skew 0 below), the NVR's playback is the NVR's clock.
        this.position = serverTime(ts, this.sourceSkew())
        this.blankOpens = 0 // pictures are arriving again
        if (this.askedAt !== null) {
          // the first picture of this stream: how long it took, for where the next one is asked for
          const lag = performance.now() - this.askedAt
          this.openLagMs = this.openLagMs === null ? lag : (this.openLagMs + lag) / 2
          this.askedAt = null
        }
        // The NVR found room after all, so the refusal count and its backoff are cleared: they only
        // ever mean anything in a row.
        if (this.stream.refusals) this.stream = afterVideo(this.stream)
        // Opened while the wall is paused: this is the picture of the moment asked for, and the tile
        // stops on it. (Paused before any picture, it never drew one: the server sends a paused
        // playback nothing, so a seek on a paused wall stayed black, and with one tile opening at a
        // time the first tile kept all the others from opening at all.)
        if (!clock.playing) this.setPaused(true)
      },
      onUnsupported: (codecId) => {
        this.undecodable = true
        this.error = codecId === CODEC_H265
          ? 'H.265 — this PC cannot decode it. Set this camera to H.264, or open it on a PC that can.'
          : 'This browser cannot decode this camera.'
        this.close()
      }
    })
  }

  /** Which clock the frames of the source now playing are stamped in. */
  sourceSkew() {
    return this.mode() === 'server' ? 0 : this.skew
  }

  /**
   * Where this tile's pictures come from. Sub-streams (the NVR's SD) are the wall's default because
   * the limit is this PC's decoder, not the server; the server's own recordings are main stream and
   * so only a few fit on screen at once — but they ask nothing of the NVR.
   */
  mode() {
    return wallTileMode({ rights: this.rights, quality: state.quality, available: this.available, codec: this.codec, h265: state.h265 })
  }

  /** The day's recorded stretches for this camera, from the server's index (one request, no NVR). */
  async loadDay(from, token) {
    this.error = null
    // Only another day empties the lane before the answer comes. The minute refresh of today's wall
    // asks for the same day again, and a tile with no stretches has "nothing recorded at this
    // moment": every tile was stopped, blanked and opened again once a minute.
    if (this.dayFrom !== from) this.stretches = []
    this.dayFrom = from
    try {
      const tl = await api(`/api/playback/timeline?nvr=${encodeURIComponent(this.nvr)}&ch=${this.ch}&from=${from}&to=${from + DAY}`)
      if (token !== dayToken) return
      this.available = tl.available === true
      // Playback HD only: the server's recordings or nothing (the NVR's copy is not this viewer's)
      if (!this.available && !this.rights.sd) this.error = 'No recordings of this camera on this server that you may play back.'
      if (!this.available) {
        this.stretches = []
        return
      }
      this.skew = tl.skewMs ?? 0
      this.tzOffsetMs = tl.tzOffsetMs
      this.codec = tl.codec ?? 'h264'
      state.serverNow = Math.max(state.serverNow, tl.now ?? 0)
      // the file being written keeps growing; treat it as recorded up to a second ago, as the
      // playback page does, so today's wall is not one second short on every tile
      const live = Boolean(tl.ranges?.length) && tl.ranges.at(-1)[1] >= tl.now - 2000
      this.stretches = mergeSources(tl.ranges, [], { liveTo: live ? tl.now - 1000 : null })
      // the recorder's own gaps, drawn under the lane with the reason on hover: "nothing here"
      // and "the recorder was down" look the same on a wall unless we say which it was
      this.gaps = (tl.gaps ?? []).map(([s, e, reason]) => ({ s, e, kind: 'gap', reason: reason || 'not recorded' }))
    } catch (e) {
      if (token !== dayToken) return
      this.available = false
      this.stretches = []
      this.error = `Could not load this camera's timeline: ${e.message}`
    }
  }

  /** What this tile should be showing at the shared moment, and whether it can. */
  status(atMs) {
    // a refusal (1008) stands for the tile's life: loadDay clears this.error every minute on today's wall
    if (this.refused) return { kind: 'error', text: this.refused }
    if (this.error) return { kind: 'error', text: this.error }
    return tileState({
      available: this.available || this.mode() === 'nvr', // an NVR leg plays even without a server index
      codec: this.codec,
      h265: state.h265,
      stretches: this.available ? this.stretches : [{ s: -Infinity, e: Infinity }],
      atMs,
      undecodable: this.undecodable
    })
  }

  /**
   * Whether this tile should be holding a stream open at all at this moment.
   *
   * Every "no" here is bandwidth handed straight back to the NVR, which is bandwidth it can spend
   * on recording. A tile on another page of the grid, a tile behind a maximised one, a tile whose
   * camera recorded nothing at this moment, and every tile on a page nobody is even looking at,
   * all answer no — and are stopped at once rather than left running out of sight.
   */
  wantsStream(atMs) {
    if (document.hidden || !pageAwake) return false
    if (state.maximised && state.maximised !== this.key) return false
    return this.status(atMs).kind === 'playing'
  }

  /** Whether the picture has drifted far enough from the shared clock to be worth re-seeking. */
  drifted(atMs) {
    if (!this.ws || this.position === null) return false
    // a paused tile holds the first picture it was sent: asked again, it would be sent the same one
    if (!clock.playing) return false
    // Ahead of the clock: it waits for it (sync), which is quicker than opening it again. Only one
    // further ahead than a stream is ever asked for has lost the clock altogether.
    const ahead = aheadBy(this.position, atMs, clock.speed)
    if (ahead > 0) return ahead > 2 * MAX_LEAD_MS
    // (measured against the speed the wall's clock runs at: wall-clock.js needsResync)
    return needsResync(this.position, atMs, { speed: clock.speed }) && performance.now() - this.lastSeekAt > RESYNC_EVERY_MS
  }

  /**
   * What this tile should be showing, and whether it is paused. It no longer opens anything itself:
   * opening is decided for the grid as a whole by openPlan (pump below), so that nine tiles can
   * never ask nine NVR channels for a stream in the same instant.
   */
  sync(atMs, playing) {
    const st = this.status(atMs)
    this.show(st)
    if (st.kind !== 'playing') {
      this.position = null
      return
    }
    const since = performance.now() - this.lastSeekAt
    // Refused by the NVR and serving out its backoff. Said on the tile, because a viewer looking at
    // a black square concludes the camera is broken and asks for more streams — the last thing an
    // NVR that has just run out of bandwidth needs.
    if (!this.ws && (this.stream.refusals ?? 0) > 0) {
      const waitS = Math.max(0, Math.ceil(((this.stream.blockedUntil ?? 0) - performance.now()) / 1000))
      return this.show({
        kind: 'waiting',
        text: this.stream.why === 'quiet'
          ? `No picture came from this camera. Trying again in ${waitS} s.`
          : `The NVR has no bandwidth left for another playback. Trying again in ${waitS} s — showing fewer cameras, or HD (the server's own recordings, which ask the NVR for nothing), would avoid this.`
      })
    }
    // Opened, or opened and closed again, without a single picture: say so rather than leaving a
    // black square, which reads as "nothing happened here" when it means the pictures are not
    // arriving.
    if (this.position === null && this.ws && (this.blankOpens >= 2 || since > NO_PICTURE_MS)) {
      this.show({ kind: 'waiting', text: 'No picture from this camera. Trying again.' })
    }
    // A tile ahead of the clock (its stream was asked for where the clock would be, open below, and
    // came up sooner) is held on its picture until the clock reaches it.
    this.waitingForClock = playing && this.position !== null && aheadWait(this.position, atMs, { speed: clock.speed, waiting: this.waitingForClock })
    // (a tile with no picture yet runs on until its first one, which pauses it: see onFrame)
    if (this.ws) this.setPaused((!playing && this.position !== null) || this.waitingForClock)
  }

  show(st) {
    this.timeEl.textContent = this.position === null ? '' : fmtClock(this.position, { tzOffsetMs: state.tz })
    if (st.kind === this.shownKind && this.msgEl.textContent === st.text) return
    this.shownKind = st.kind
    this.msgEl.textContent = st.text
    this.msgEl.hidden = st.kind === 'playing'
    this.el.classList.toggle('wall-tile-quiet', st.kind !== 'playing')
    this.el.dataset.kind = st.kind
  }

  /**
   * Opens a playback socket at the shared moment. The NVR's session is asked for the moment in its
   * own clock; the server's is asked in server time. That single line is the whole synchronisation.
   */
  open(atMs) {
    this.close()
    this.lastSeekAt = performance.now()
    this.position = null
    // A refusal or a decoder complaint from the last attempt is cleared here, not when it happened:
    // the message has to stay on screen for the whole backoff, or the tile would go quietly blank
    // and the viewer would never learn why the picture stopped.
    if (!this.undecodable) this.error = null
    const server = this.mode() === 'server'
    // While the wall plays, the stream is asked for where the clock will be when its first picture
    // comes, not where it is now (wall-clock.js openLead). Paused, at the moment itself.
    this.askedAt = performance.now()
    this.waitingForClock = false
    if (clock.playing) atMs += openLead(this.openLagMs, clock.speed, server ? 'server' : 'nvr')
    const target = server ? (recordedFrom(this.stretches, atMs) ?? atMs) : atMs
    const start = Math.round(server ? target : cameraTime(target, this.skew))
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    // stream=1 is the camera's sub-stream (SD); server footage is always the main stream
    // h265: tells the server this browser cannot play H.265, so it converts (NVR sub-streams too)
    // original=1: the recording itself, also for a remote viewer (rec-playback.mjs converts a remote
    // viewer's playback to fit the link while one of its two conversions is free). A wall's first two
    // tiles would take both for as long as it stayed open, refusing a single camera that needs one,
    // and every other tile would get the recording itself anyway.
    const q = `nvr=${encodeURIComponent(this.nvr)}&ch=${this.ch}&stream=${server ? 0 : 1}&start=${start}${server ? '&src=auto&original=1' : ''}&h265=${state.h265 ? 1 : 0}`
    const sock = new WebSocket(`${proto}://${location.host}/playback?${q}`)
    sock.binaryType = 'arraybuffer'
    sock.onopen = () => {
      const speed = clampSpeed(state.speed, server ? 'server' : 'nvr').speed
      if (speed !== 1) sock.send(JSON.stringify({ speed }))
      // (no pause here on a paused wall: the first picture pauses the tile, onFrame)
    }
    sock.onmessage = (e) => {
      if (this.ws !== sock) return
      if (typeof e.data === 'string') return this.onStatus(JSON.parse(e.data))
      this.pushFrame(e.data)
    }
    sock.onclose = (e) => {
      if (this.ws !== sock) return
      this.ws = null
      // refused (the camera's rights, the session): said on the tile, and final -- status() is then
      // 'error', so the tile no longer asks; the refusal would only repeat
      if (e.code === 1008) {
        this.error = refusedMessage(e.code, e.reason) ?? 'The server refused this camera.'
        this.refused = this.error
        return
      }
      if (this.position === null) this.blankOpens++ // it closed without ever showing anything
      // Two openings in a row that produced nothing at all is not a refusal, but asking again
      // straight away is just as wasteful: the same backoff applies, with its own explanation.
      if (e.code !== 1013 && this.position === null && this.blankOpens >= 2) {
        this.stream = afterRefusal({ ...this.stream, why: 'quiet' }, performance.now())
      }
      if (e.code === 1013) {
        this.stream = { ...this.stream, why: 'busy' }
        // One playback session per tile is one per tile on the NVR as well, and an NVR at its
        // bandwidth ceiling refuses rather than queues. Back off hard — doubling, up to five
        // minutes — instead of trying again on the next tick: a grid that retries in a loop spends
        // the bandwidth the NVR needs to record, which is how eleven of nvr-2's cameras came to be
        // recording nothing at all (stream-choice.mjs).
        //
        // The refusal is deliberately NOT recorded as this.error: an error stops the tile wanting a
        // stream at all, and a tile that does not want one is never reopened, so the camera would
        // stay blank for ever after a single busy moment. It stays a tile that wants to play and is
        // made to wait, and the waiting is enforced by openPlan.
        this.stream = afterRefusal(this.stream, performance.now())
      }
    }
    this.player.seekReset()
    this.player.resume()
    this.player.setRate(state.speed > 0 ? state.speed : 1)
    this.paused = false
    this.ws = sock
  }

  onStatus(msg) {
    if (msg.type === 'error') this.error = msg.message
    if (msg.type === 'end') this.close() // the next moment with footage opens it again
  }

  pushFrame(data) {
    const buf = new Uint8Array(data)
    if (buf.length <= HEADER_SIZE) return
    const view = new DataView(buf.buffer, buf.byteOffset)
    this.player.push({
      isKey: (buf[0] & 1) === 1,
      codecId: buf[1],
      timestampUs: Number(view.getBigInt64(8, true)),
      data: buf.subarray(HEADER_SIZE)
    })
  }

  setPaused(paused) {
    if (this.paused === paused) return
    this.paused = paused
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ pause: paused }))
    if (paused) this.player.pause()
    else this.player.resume()
  }

  setSpeed(speed) {
    const allowed = clampSpeed(speed, this.mode()).speed
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ speed: allowed }))
    this.player.setRate(allowed > 0 ? allowed : 1)
  }

  close() {
    if (!this.ws) return
    this.ws.onclose = null
    this.ws.close()
    this.ws = null
  }

  // ---- the tile's own toolbar ----------------------------------------------------------------

  /** The moment this tile is showing, for a file name: its own position, or the shared clock. */
  whenMs() {
    return this.position ?? clock.atMs
  }

  /** The picture on screen, as a canvas, or null when there is nothing to take. */
  picture() {
    const src = this.player.canvas
    if (!src.width || !src.height) return null
    const out = document.createElement('canvas')
    out.width = src.width
    out.height = src.height
    out.getContext('2d').drawImage(src, 0, 0)
    return out
  }

  /** A file name a Windows machine will accept, naming the camera and the moment. */
  fileName(ext) {
    const when = this.whenMs()
    const name = `${this.name} ${this.nvrName} ${fmtDate(when)} ${fmtClock(when, { tzOffsetMs: state.tz }).replaceAll(':', '-')}.${ext}`
    return name.replace(/[\\/:*?"<>|]/g, '-')
  }

  /** The picture on screen saved as a JPEG, the same as the playback page's snapshot button. */
  snapshot() {
    const out = this.picture()
    if (!out) return this.flash('There is no picture to save yet.')
    out.toBlob((blob) => {
      if (!blob) return this.flash('The picture could not be saved.')
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = this.fileName('jpg')
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    }, 'image/jpeg', 0.92)
  }

  /**
   * The picture on screen on the clipboard, so it can go straight into an email or a report. PNG
   * because that is the only image type browsers reliably accept on the clipboard. A browser that
   * refuses (an insecure page, or no permission) is told about plainly rather than silently doing
   * nothing, since a copy that quietly fails is worse than one that was never offered.
   */
  async copyPicture() {
    const out = this.picture()
    if (!out) return this.flash('There is no picture to copy yet.')
    try {
      const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'))
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      this.flash('Picture copied.')
    } catch {
      this.flash('This browser would not let the picture be copied. Use the snapshot button instead.')
    }
  }

  /** A line over the tile for a moment: the toolbar's own answer, without a dialog. */
  flash(text) {
    this.msgEl.textContent = text
    this.msgEl.hidden = false
    this.shownKind = null // so the next sync redraws whatever the tile should really be saying
    clearTimeout(this.flashTimer)
    this.flashTimer = setTimeout(() => syncTiles(), 3000)
  }

  destroy() {
    this.close()
    this.player.close()
    this.el.remove()
  }
}

// ---- the wall -------------------------------------------------------------------------------

let dayToken = 0
/** False while the tab is hidden: every tile stops streaming, because nobody is watching it. */
let pageAwake = true
/** When the last tile was allowed to open, so openPlan can space the next one out. */
let lastOpenAt = -Infinity

/** The cameras chosen, of which only one page is ever built into tiles and streamed. */
function setCameras(keys) {
  state.cameras = normaliseChoice(keys, { known: new Set(state.all.map((c) => `${c.nvr}/${c.ch}`)) })
  state.page = 0
  state.maximised = null
  showPage()
}

/**
 * The Quality menu offers what the chosen cameras' rights allow (pb-sources.js wallQualities); a choice
 * no chosen camera allows any more moves to one that is, and the tiles reopen on it.
 */
function updateQualityChoices() {
  const rights = state.cameras.map((key) => pbRights(state.all.find((c) => `${c.nvr}/${c.ch}` === key)))
  const { options, value } = wallQualities(rights, state.quality)
  const sig = options.map(([v]) => v).join()
  if (qualitySel.dataset.sig !== sig) {
    qualitySel.replaceChildren(...options.map(([v, label]) => new Option(label, v)))
    qualitySel.dataset.sig = sig
  }
  qualitySel.value = value
  if (value !== state.quality) {
    state.quality = value
    for (const t of state.tiles) {
      t.close()
      t.position = null
    }
  }
}

/** Builds the tiles for the cameras on this page (keeping the ones already up and playing). */
function showPage() {
  updateQualityChoices()
  const page = pageOf(state.cameras, state.layout, state.page)
  state.page = page.page
  const wanted = page.keys
  const have = new Map(state.tiles.map((t) => [t.key, t]))
  // A tile leaving the page is destroyed, which closes its stream: the bandwidth goes back to the
  // NVR the instant the camera is off screen, rather than when somebody happens to reload.
  for (const [key, tile] of have) if (!wanted.includes(key)) tile.destroy()
  state.tiles = wanted.map((key) => {
    const existing = have.get(key)
    if (existing) return existing
    const [nvr, ch] = [key.slice(0, key.lastIndexOf('/')), Number(key.slice(key.lastIndexOf('/') + 1))]
    const cam = state.all.find((c) => c.nvr === nvr && c.ch === ch)
    return new Tile({ nvr, ch, name: cam?.name ?? `Channel ${ch + 1}`, nvrName: cam?.nvrName ?? nvr, site: cam?.site ?? '', rights: pbRights(cam) })
  })
  gridEl.replaceChildren(...state.tiles.map((t) => t.el))
  emptyEl.hidden = state.tiles.length > 0
  layoutGrid()
  // again once the browser has laid the grid out: the first call measured a box that had no tiles
  // in it yet, and the column count depends on the shape of the space as much as on the number
  setTimeout(layoutGrid, 0)
  renderLaneNames()
  renderSpeeds()
  renderPager()
  updateLoadNote()
  loadDay()
}

function renderPager() {
  const { page, pages } = pageOf(state.cameras, state.layout, state.page)
  pagerEl.hidden = pages <= 1
  pageLabel.textContent = `Page ${page + 1} of ${pages}`
  viewSel.value = state.viewId
  $('deleteView').hidden = !state.viewId
}

function goPage(delta) {
  const { pages } = pageOf(state.cameras, state.layout, state.page)
  state.page = Math.min(Math.max(0, state.page + delta), pages - 1)
  state.maximised = null
  showPage()
}

/**
 * What this page is asking of this PC and of the NVRs. The load warning counts the tiles actually
 * streaming — a page of four out of twelve cameras costs four streams, not twelve — and the opening
 * note explains a grid that is still coming up or one an NVR has refused.
 */
function updateLoadNote() {
  const refused = state.tiles.filter((t) => (t.stream.refusals ?? 0) > 0 && t.stream.why === 'busy').length
  const waiting = state.tiles.filter((t) => t.wantsStream(clock.atMs) && !t.ws).length
  const opening = openNote({ waiting, refused })
  const load = loadWarning(state.tiles.length, state.quality)
  const off = state.cameras.length - state.tiles.length
  const parts = [
    load.text,
    off > 0 ? `${off} more on other pages, not streaming.` : '',
    opening.text
  ].filter(Boolean)
  loadNote.textContent = parts.join(' ')
  loadNote.dataset.level = opening.level === 'ok' ? load.level : opening.level
  loadNote.hidden = state.tiles.length === 0
}

/** The grid: a fixed 2x2 or 3x3, or the column count that makes each picture biggest. */
function layoutGrid() {
  const cols = state.layout === 'auto'
    ? gridLayout(state.tiles.length, { width: gridEl.clientWidth || 1600, height: gridEl.clientHeight || 900 }).cols
    : colsOf(state.layout, state.tiles.length)
  gridEl.style.setProperty('--wall-cols', String(Math.max(1, cols)))
  // A maximised tile fills the grid; the rest stay in the page (so the lanes and the ordering are
  // unchanged) but are hidden, which is what makes them stop streaming.
  gridEl.classList.toggle('wall-maximised', Boolean(state.maximised))
  for (const t of state.tiles) t.el.classList.toggle('wall-tile-max', state.maximised === t.key)
}

/** One tile fills the grid, or back to all of them. The others stop streaming while it does. */
function toggleMaximised(key) {
  state.maximised = state.maximised === key ? null : key
  layoutGrid()
  syncTiles()
}

/** Loads the day's timeline for every tile: one database request each, never the NVR. */
async function loadDay() {
  const token = ++dayToken
  const from = Math.round(dayStartOf(state.date))
  state.view = makeView({ dayStartMs: from, dayEndMs: from + DAY, spanMs: state.view.spanMs, startMs: state.view.startMs, minSpanMs: MIN_SPAN })
  await Promise.all(state.tiles.map((t) => t.loadDay(from, token)))
  if (token !== dayToken) return
  // the day shown is the cameras' day: if the site is in another time zone, load it again there
  const tz = state.tiles.find((t) => Number.isFinite(t.tzOffsetMs))?.tzOffsetMs
  if (Number.isFinite(tz) && tz !== state.tz) {
    state.tz = tz
    state.date = fmtDate(clock.atMs)
    dateInput.value = state.date
    return loadDay()
  }
  updateSkewHint()
  drawLanes()
  syncTiles() // the tiles now know what this camera has: open, stop or relabel them at once
}

/**
 * The clock hint. The playback page names one NVR's skew; a wall may have several, so it says how
 * far apart the worst of them are — the amount by which the tiles would be out if the page trusted
 * the times printed on the pictures instead of converting them.
 */
function updateSkewHint() {
  const skews = state.tiles.filter((t) => t.available).map((t) => t.skew)
  if (skews.length === 0) return (skewEl.textContent = '')
  const spread = Math.max(...skews) - Math.min(...skews)
  skewEl.textContent = spread > 5000
    ? `Server time. These NVRs' clocks are up to ${Math.round(spread / 1000)} s apart; the times printed on the pictures differ.`
    : describeSkew(skews[0])
}

// ---- drawing --------------------------------------------------------------------------------

let drawQueued = false
/**
 * A lane redraw at the end of the current burst of changes. A short timer rather than an animation
 * frame: a hidden or throttled tab gets no frames, and a timeline that never redraws there is worse
 * than one drawn a few milliseconds late.
 */
function scheduleDraw() {
  if (drawQueued) return
  drawQueued = true
  setTimeout(() => {
    drawQueued = false
    drawLanes()
  }, 16)
}

/**
 * The tiles that get a lane. "All cameras in view" lines the whole page up so a gap on one camera
 * stands out against the others; "this camera only" is the single-camera playback page's lane for
 * the tile being worked on. Only cameras on this page are ever offered a lane: a lane for a camera
 * on another page would be a promise the grid is not keeping.
 */
const lanedTiles = () => laneSet(state.laneMode, state.tiles, state.focusKey)

function renderLaneNames() {
  laneNamesEl.replaceChildren(
    ...lanedTiles().map((t) => {
      const el = document.createElement('div')
      el.className = 'wall-lane-name'
      el.textContent = t.name
      el.title = `${t.name} · ${t.nvrName}`
      return el
    })
  )
}

/** A lane per camera, plus the ticks, the playhead and the clock. */
function drawLanes() {
  const v = state.view
  const laned = lanedTiles()
  renderLaneNames()
  const rows = buildLaneRows(
    v,
    // the gaps are drawn after the recorded stretches so a thin gap sits on top of them
    laned.map((t) => ({ key: t.key, name: t.name, stretches: t.available ? [...t.stretches, ...(t.gaps ?? [])] : [] }))
  )
  laneRowsEl.replaceChildren(
    ...rows.map((row, i) => {
      const lane = document.createElement('div')
      lane.className = 'wall-lane pb-lane'
      const tile = laned[i]
      if (!tile?.available) lane.classList.add('wall-lane-unknown')
      for (const b of row.boxes) {
        const box = document.createElement('div')
        box.style.left = `${b.leftPct}%`
        box.style.width = `${b.widthPct}%`
        box.dataset.kind = b.kind ?? 'server'
        // holes that meet on screen are one box (pb-view.js laneBoxes): the first one's reason, and how many
        if (b.kind === 'gap') box.title = `${tile?.gaps?.find((g) => g.s <= b.from && b.from <= g.e)?.reason ?? 'not recorded'}${b.n > 1 ? ` (${b.n} holes here)` : ''}`
        lane.append(box)
      }
      return lane
    })
  )

  ticksEl.replaceChildren(
    ...ticks(v, state.tz).map(({ ms, label }) => {
      const el = document.createElement('span')
      el.style.left = `${((ms - v.startMs) / v.spanMs) * 100}%`
      el.textContent = label
      return el
    })
  )

  drawPlayhead()
}

/**
 * The parts that move with the clock: the playhead, the clock reading and how many cameras have
 * footage here. Split from drawLanes because this runs every frame, and rebuilding every lane's
 * boxes sixty times a second would cost more than the video does.
 */
function drawPlayhead() {
  const v = state.view
  const at = clock.atMs
  const pct = ((at - v.startMs) / v.spanMs) * 100
  playheadEl.hidden = pct < 0 || pct > 100
  playheadEl.style.left = `${pct}%`
  const nowPct = ((state.serverNow - v.startMs) / v.spanMs) * 100
  nowEl.hidden = nowPct < 0 || nowPct > 100
  nowEl.style.left = `${nowPct}%`

  clockEl.textContent = fmtClock(at, { tzOffsetMs: state.tz })
  dateEl.textContent = fmtDate(at)
  spanEl.textContent = spanLabel(v.spanMs)
  // Counted over the cameras the server has an index of. A camera it has never recorded is not
  // "no footage here" — we simply do not know, and saying so is better than a number that is wrong.
  const indexed = state.tiles.filter((t) => t.available)
  const cover = coverageAt(indexed.map((t) => ({ stretches: t.stretches })), at)
  const unknown = state.tiles.length - indexed.length
  coverageEl.textContent = state.tiles.length === 0
    ? ''
    : `${cover.with} of ${cover.total} cameras have footage here${unknown ? ` (${unknown} not in the server's index)` : ''}`
}

// ---- transport ------------------------------------------------------------------------------

const speedLabel = (s) => `${s < 0 ? '−' : ''}${Math.abs(s)}×`

/**
 * The speed buttons. One tile playing from an NVR session holds the whole wall to 1-8x forward,
 * because the NVR refuses anything else — and a wall where one tile runs at a different speed from
 * the rest is not a wall of one moment any more.
 */
function renderSpeeds() {
  const mode = wallMode(state.tiles.map((t) => ({ mode: t.mode() })))
  if (speedsEl.dataset.kind !== mode) {
    speedsEl.replaceChildren(
      ...allowedSpeeds(mode).map((s) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = speedLabel(s)
        b.dataset.speed = String(s)
        b.addEventListener('click', () => setSpeed(s))
        return b
      })
    )
    speedsEl.dataset.kind = mode
  }
  const { speed } = clampSpeed(state.speed, mode)
  state.speed = speed
  for (const b of speedsEl.children) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === speed))
  if (speedCycleBtn) speedCycleBtn.textContent = speedLabel(speed)
}

// the one speed button on the bar: 1x -> 2x -> 4x -> 8x -> 1x; the full ladder is under More
const speedCycleBtn = $('speedCycle')
speedCycleBtn?.addEventListener('click', () => {
  const mode = wallMode(state.tiles.map((t) => ({ mode: t.mode() })))
  const ladder = allowedSpeeds(mode).filter((x) => x >= 1)
  setSpeed(ladder.find((x) => x > state.speed) ?? 1)
})
$('moreBtn')?.addEventListener('click', () => {
  const m = $('pbMore')
  m.hidden = !m.hidden
  $('moreBtn').setAttribute('aria-expanded', String(!m.hidden))
})

function setSpeed(speed) {
  const mode = wallMode(state.tiles.map((t) => ({ mode: t.mode() })))
  state.speed = clampSpeed(speed, mode).speed
  clock.setSpeed(state.speed)
  for (const t of state.tiles) t.setSpeed(state.speed)
  renderSpeeds()
}

function setPlaying(on) {
  if (on) clock.play()
  else clock.pause()
  playBtn.textContent = on ? '❚❚' : '▶'
  playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play')
  // (a tile still waiting for its first picture is paused by that picture: Tile onFrame; one held
  // ahead of the clock stays held until the clock reaches it: Tile sync)
  for (const t of state.tiles) t.setPaused((!on && t.position !== null) || (on && t.waitingForClock))
}

/** Every tile to one moment. The clock is the only thing that decides where that is. */
function seek(t) {
  clock.seek(t)
  const date = fmtDate(clock.atMs)
  if (date !== state.date) {
    state.date = date
    dateInput.value = date
    loadDay()
  }
  // Every tile has to move, but they are NOT all reopened here. Nine sockets asked for in one tick
  // is the burst an NVR at its bandwidth ceiling refuses, and a viewer dragging along the timeline
  // would send that burst several times a second. The streams are stopped at once (that part costs
  // the NVR nothing and gives bandwidth straight back) and pump() opens them again one at a time.
  for (const tile of state.tiles) {
    tile.close()
    tile.position = null
  }
  lastOpenAt = -Infinity // the first tile of the new moment need not wait out a stagger
  drawPlayhead() // the new moment reads on the clock straight away, not on the next frame
  scheduleDraw()
}

// ---- the loop -------------------------------------------------------------------------------

/**
 * The tiles are put back in step on a timer rather than on animation frames: a background tab, or a
 * PC busy decoding, gets few frames, and that is exactly when tiles drift. The animation frame only
 * moves the playhead, which nobody misses if it is late.
 */
/**
 * The whole grid's stream decisions for this tick, made together rather than tile by tile.
 *
 * This is the single place a stream is ever opened, and it opens at most one per call and no oftener
 * than OPEN_STAGGER_MS. That is deliberately slow: a 3x3 grid takes about six seconds to fill. The
 * alternative — nine requests in one instant against NVRs that share one fixed bandwidth budget with
 * their own recording — is what puts an NVR over its ceiling, and an NVR over its ceiling stops
 * recording cameras rather than merely refusing this page (see stream-choice.mjs). Six seconds of
 * waiting is a nuisance; a day of a camera not recording is gone for good.
 *
 * Stopping is not rate limited and happens first, for the same reason in reverse.
 */
function pump(atMs) {
  const now = performance.now()
  const plan = openPlan(
    state.tiles.map((t) => ({
      key: t.key,
      wants: t.wantsStream(atMs),
      // A tile still waiting for its first picture is "opening": nothing else may open behind it.
      opening: Boolean(t.ws) && t.position === null,
      // A tile that has drifted off the shared clock counts as neither, so it is re-seeked through
      // the same gate as a first opening rather than jumping the queue.
      streaming: Boolean(t.ws) && t.position !== null && !t.drifted(atMs),
      blockedUntil: t.stream.blockedUntil
    })),
    now,
    { lastOpenAt }
  )
  const byKey = new Map(state.tiles.map((t) => [t.key, t]))
  for (const key of plan.close) {
    byKey.get(key)?.close()
    const t = byKey.get(key)
    if (t) t.position = null
  }
  if (plan.open) {
    byKey.get(plan.open)?.open(atMs)
    lastOpenAt = now
  }
}

function syncTiles() {
  clock.tick()
  for (const t of state.tiles) t.sync(clock.atMs, clock.playing)
  pump(clock.atMs)
  updateLoadNote()
  if (state.follow) {
    const next = followView(state.view, clock.atMs)
    if (next !== state.view) {
      state.view = next
      scheduleDraw()
    }
  }
  drawPlayhead() // the clock reading must keep up even where animation frames are scarce
}

function frame() {
  clock.tick()
  drawPlayhead()
  requestAnimationFrame(frame)
}

// ---- the timeline's own pointer handling ------------------------------------------------------

const timeAtX = (clientX) => {
  const r = laneTrack.getBoundingClientRect()
  const frac = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
  return state.view.startMs + frac * state.view.spanMs
}

let drag = null
laneTrack.addEventListener('pointerdown', (e) => {
  // capture so a drag that leaves the track still pans; a pointer that cannot be captured (some
  // synthetic events) must still be able to click, so the failure is not fatal
  try {
    laneTrack.setPointerCapture(e.pointerId)
  } catch {}
  drag = { x: e.clientX, startMs: state.view.startMs, moved: false }
})
laneTrack.addEventListener('pointermove', (e) => {
  if (!drag) return
  const r = laneTrack.getBoundingClientRect()
  const dx = e.clientX - drag.x
  if (Math.abs(dx) > 3) drag.moved = true
  if (!drag.moved) return
  state.follow = false
  followBtn.setAttribute('aria-pressed', 'false')
  state.view = makeView({ ...state.view, startMs: drag.startMs - (dx / Math.max(1, r.width)) * state.view.spanMs })
  scheduleDraw()
})
laneTrack.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) seek(timeAtX(e.clientX))
  drag = null
})
laneTrack.addEventListener('wheel', (e) => {
  e.preventDefault()
  state.view = zoomAt(state.view, e.deltaY > 0 ? 1.25 : 0.8, timeAtX(e.clientX))
  scheduleDraw()
}, { passive: false })

for (const b of document.querySelectorAll('.pb-zoom button')) {
  b.addEventListener('click', () => {
    state.view = makeView({ ...state.view, spanMs: Number(b.dataset.span), startMs: clock.atMs - Number(b.dataset.span) / 2 })
    scheduleDraw()
  })
}

$('followBtn').addEventListener('click', () => {
  state.follow = !state.follow
  followBtn.setAttribute('aria-pressed', String(state.follow))
})

playBtn.addEventListener('click', () => setPlaying(!clock.playing))
$('back').addEventListener('click', () => seek(clock.atMs - SEEK_STEP))
$('fwd').addEventListener('click', () => seek(clock.atMs + SEEK_STEP))
$('dayPrev').addEventListener('click', () => seek(clock.atMs - DAY))
$('dayNext').addEventListener('click', () => seek(clock.atMs + DAY))

dateInput.addEventListener('change', () => {
  if (!dateInput.value) return
  // the same clock time on the chosen day, so a wall set to 14:00 stays at 14:00.
  // state.date is left for seek() to set: it loads the day's recordings when the date it lands on
  // is not the one held, and with the date already set here it never did. The label and the clock
  // moved to the chosen day while every tile kept the old day's recordings ("Nothing recorded at
  // this moment" on a day full of footage); only the day arrows worked.
  const into = clock.atMs - dayStartOf(fmtDate(clock.atMs))
  seek(dayStartOf(dateInput.value) + into)
})

qualitySel.addEventListener('change', () => {
  state.quality = qualitySel.value === 'hd' ? 'hd' : 'sd'
  updateLoadNote()
  renderSpeeds()
  // The source changed, so every stream must be replaced — stopped now, reopened by pump() one at
  // a time, for the same reason a seek does not reopen them all at once.
  for (const t of state.tiles) {
    t.close()
    t.position = null
  }
  lastOpenAt = -Infinity
})

layoutSel.addEventListener('change', () => {
  state.layout = layoutSel.value
  state.page = 0
  state.maximised = null
  showPage()
})

laneModeSel.addEventListener('change', () => {
  state.laneMode = laneModeSel.value === 'one' ? 'one' : 'all'
  drawLanes()
})

$('pagePrev').addEventListener('click', () => goPage(-1))
$('pageNext').addEventListener('click', () => goPage(1))

/**
 * A tab nobody is looking at streams nothing. The browser would go on decoding in the background and
 * the NVRs would go on sending — a grid left open on a forgotten tab is bandwidth spent on nobody,
 * and on a site whose NVR is already near its ceiling that is bandwidth taken from recording.
 */
document.addEventListener('visibilitychange', () => {
  pageAwake = !document.hidden
  if (document.hidden) {
    for (const t of state.tiles) {
      t.close()
      t.position = null
    }
  } else {
    lastOpenAt = -Infinity
  }
  syncTiles()
})

// the shuttle springs back to the middle: the wall plays while it is held away from it
shuttleEl.addEventListener('input', () => {
  const rate = shuttleRate(Number(shuttleEl.value) / 100)
  shuttleLabelEl.textContent = shuttleLabel(rate)
  if (rate === 0) return setPlaying(false)
  setSpeed(rate)
  if (!clock.playing) setPlaying(true)
})
shuttleEl.addEventListener('pointerup', () => {
  shuttleEl.value = '0'
  shuttleLabelEl.textContent = shuttleLabel(0)
  setPlaying(false)
})

// the clock reads as a button until it is clicked, then it is a box to type a time into
clockEl.addEventListener('click', () => {
  clockInput.value = fmtClock(clock.atMs, { tzOffsetMs: state.tz })
  clockEl.hidden = true
  clockInput.hidden = false
  clockInput.focus()
  clockInput.select()
})
clockInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeClockInput()
  if (e.key !== 'Enter') return
  const m = /^(\d{1,2}):?(\d{2})?:?(\d{2})?$/.exec(clockInput.value.trim())
  if (m) {
    const into = (Number(m[1]) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000
    seek(dayStartOf(state.date) + into)
  }
  closeClockInput()
})
clockInput.addEventListener('blur', closeClockInput)
function closeClockInput() {
  clockInput.hidden = true
  clockEl.hidden = false
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  if (e.key === ' ') {
    e.preventDefault()
    setPlaying(!clock.playing)
  }
  if (e.key === 'ArrowLeft') seek(clock.atMs - SEEK_STEP)
  if (e.key === 'ArrowRight') seek(clock.atMs + SEEK_STEP)
})

window.addEventListener('resize', layoutGrid)

// ---- choosing the cameras ---------------------------------------------------------------------

// What is ticked, kept apart from the list on screen: a search redraws the list, and a choice that
// vanished because it no longer matched what someone had typed would be a nasty surprise.
const picked = new Set()

$('pickCameras').addEventListener('click', () => {
  picked.clear()
  for (const k of state.cameras) picked.add(k)
  pickSearch.value = ''
  renderPickList()
  pickDlg.showModal()
  pickSearch.focus()
})

/** The camera list, filtered by what has been typed, grouped by site and NVR. */
function renderPickList() {
  // offline cameras cannot be watched: left out, unless already on the wall (so they can be removed)
  const usable = state.all.filter((c) => c.online || picked.has(`${c.nvr}/${c.ch}`))
  const matches = searchCameras(usable, pickSearch.value)
  const groups = groupCameras(matches)
  pickList.replaceChildren(
    ...groups.flatMap(({ label, cameras }) => {
      const h = document.createElement('h3')
      h.textContent = label
      return [
        h,
        ...cameras.map((c) => {
          const key = `${c.nvr}/${c.ch}`
          const row = document.createElement('label')
          row.className = 'wall-pick-row'
          const box = document.createElement('input')
          box.type = 'checkbox'
          box.value = key
          box.checked = picked.has(key)
          box.addEventListener('change', () => {
            if (box.checked) picked.add(key)
            else picked.delete(key)
            updatePickNote()
          })
          row.append(box, document.createTextNode(` ${c.ch + 1} · ${c.name}${c.online ? '' : ' (offline)'}`))
          return row
        })
      ]
    })
  )
  if (groups.length === 0) {
    const none = document.createElement('p')
    none.className = 'wall-pick-note'
    none.textContent = `No camera matches “${pickSearch.value.trim()}”.`
    pickList.append(none)
  }
  updatePickNote()
}

pickSearch.addEventListener('input', renderPickList)

/** What choosing this many will mean, said before they press the button rather than after. */
function updatePickNote() {
  const n = picked.size
  const slots = slotsOf(state.layout)
  const w = loadWarning(Math.min(n, slots || n), state.quality)
  const paged = slots > 0 && n > slots ? ` Only ${slots} stream at a time; the rest wait on the next page.` : ''
  pickNote.textContent = n > MAX_TILES
    ? `${n} cameras: the wall keeps the first ${MAX_TILES}. ${w.text}${paged}`
    : `${n} chosen. ${w.text}${paged}`
  pickNote.dataset.level = n > MAX_TILES ? 'over' : w.level
}

$('pickSave').addEventListener('click', () => {
  const saved = writeStore(normaliseChoice([...picked]))
  state.viewId = '' // these are not a saved view's cameras any more
  setCameras(saved.cameras)
  pickDlg.close()
})

// ---- saved views -------------------------------------------------------------------------------
//
// Kept with the account (views.mjs), not the browser, so somebody's "Yard and gates" follows them to
// whichever screen they sit at — which is the whole point of naming it. Versioned exactly as the
// live grid's camera order is: a save made on a version that is no longer the latest is refused, and
// the page reloads rather than overwriting what another screen saved.

const viewDlg = $('saveViewDlg')
const viewNameEl = $('viewName')
const viewMsgEl = $('viewMsg')

async function loadViews() {
  try {
    const got = await api('/api/me/views')
    state.views = normaliseViews(got.views).views
    state.viewsVersion = Number.isSafeInteger(got.version) ? got.version : 0
  } catch {
    state.views = [] // a page that cannot read the saved views still shows the wall
  }
  renderViewSel()
}

function renderViewSel() {
  const options = [new Option('(not saved)', '')]
  for (const v of state.views) options.push(new Option(v.name, v.id))
  viewSel.replaceChildren(...options)
  viewSel.value = state.viewId
  $('deleteView').hidden = !state.viewId
}

/** Saves the views as they now are, telling the viewer when another screen got there first. */
async function putViews(views) {
  const next = applyViews({ views: state.views, version: state.viewsVersion }, { views, version: state.viewsVersion })
  if (!next.saved) return { ok: false, error: 'Your views were changed on another screen. Reloading them.' }
  const res = await fetch('/api/me/views', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ views, version: state.viewsVersion })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 409) {
      state.views = normaliseViews(body.views).views
      state.viewsVersion = body.version ?? state.viewsVersion
      renderViewSel()
    }
    return { ok: false, error: body.error ?? `HTTP ${res.status}` }
  }
  state.views = normaliseViews(body.views).views
  state.viewsVersion = body.version
  renderViewSel()
  return { ok: true, error: null }
}

$('saveView').addEventListener('click', () => {
  if (state.cameras.length === 0) return
  viewNameEl.value = state.views.find((v) => v.id === state.viewId)?.name ?? ''
  viewMsgEl.textContent = ''
  viewDlg.showModal()
  viewNameEl.focus()
})

$('viewSave').addEventListener('click', async () => {
  // A view saved under a name that is already in use replaces it, rather than leaving two identical
  // entries in the menu that nobody can tell apart.
  const name = viewNameEl.value
  const existing = state.views.find((v) => v.name.trim().toLowerCase() === name.trim().toLowerCase())
  const candidate = {
    id: existing?.id ?? `v${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name,
    cameras: state.cameras,
    layout: state.layout
  }
  const { ok, error, value } = checkView(candidate)
  if (!ok) return (viewMsgEl.textContent = error)
  const saved = await putViews([...state.views.filter((v) => v.id !== value.id), value])
  if (!saved.ok) return (viewMsgEl.textContent = saved.error)
  state.viewId = value.id
  renderViewSel()
  viewDlg.close()
})

viewSel.addEventListener('change', () => {
  const view = state.views.find((v) => v.id === viewSel.value)
  state.viewId = view?.id ?? ''
  if (!view) return renderPager()
  state.layout = view.layout ?? layoutFor(view.cameras.length)
  layoutSel.value = state.layout
  writeStore(normaliseChoice(view.cameras))
  setCameras(view.cameras)
})

$('deleteView').addEventListener('click', async () => {
  if (!state.viewId) return
  const saved = await putViews(state.views.filter((v) => v.id !== state.viewId))
  if (!saved.ok) return
  state.viewId = ''
  renderViewSel()
})

// ---- exporting a view, or one tile of it -------------------------------------------------------
//
// The same job the single-camera playback page starts: POST /api/exports with one clip per camera
// (export-api.mjs, export-job.mjs). There is one export path in this app and this is it — the only
// thing this page adds is filling in every camera of the view instead of one.

const exDlg = $('wallExportDlg')
const exFrom = $('wallExFrom')
const exTo = $('wallExTo')
const exCamsEl = $('wallExCameras')
const exMsgEl = $('wallExMsg')
const exProgressEl = $('wallExProgress')
const exStartBtn = $('wallExStart')

const exSay = (text, bad = false) => {
  exMsgEl.textContent = text
  exMsgEl.className = `pb-ex-msg${bad ? ' pb-ex-bad' : ''}`
}

/** "hh:mm:ss" on the day shown, back as an absolute moment; null when it is not a time. */
function timeOnDay(text) {
  const m = /^(\d{1,2}):?(\d{2})?:?(\d{2})?$/.exec(String(text).trim())
  if (!m) return null
  return dayStartOf(state.date) + (Number(m[1]) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000
}

/**
 * The export dialog, with `preselect` ticked. A tile's toolbar passes its own camera; the "Export
 * view" button passes every camera in the view — including the ones on other pages, because the view
 * is what somebody named, not the nine of it that happen to be on screen.
 */
function openWallExport(preselect, title = 'Export this view') {
  const chosen = new Set(preselect)
  $('wallExTitle').textContent = title
  // The stretch the timeline is showing, which is what somebody has just been looking at.
  exFrom.value = fmtClock(state.view.startMs, { tzOffsetMs: state.tz })
  exTo.value = fmtClock(Math.min(state.view.endMs, state.view.dayEndMs - 1), { tzOffsetMs: state.tz })
  exCamsEl.replaceChildren(
    ...state.cameras.map((key) => {
      const tile = state.tiles.find((t) => t.key === key)
      const cam = state.all.find((c) => `${c.nvr}/${c.ch}` === key)
      const row = document.createElement('label')
      row.className = 'wall-pick-row'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.value = key
      box.checked = chosen.has(key)
      row.append(box, document.createTextNode(` ${cam?.name ?? tile?.name ?? key} · ${cam?.nvrName ?? ''}`))
      return row
    })
  )
  $('wallExName').value = `${state.date} ${exFrom.value.slice(0, 5)} ${state.views.find((v) => v.id === state.viewId)?.name ?? 'wall'}`
  $('wallExNotes').value = ''
  exProgressEl.hidden = true
  exStartBtn.disabled = false
  exSay('')
  $('wallExSpan').textContent = `on ${state.date}`
  exDlg.showModal()
}

$('exportView').addEventListener('click', () => openWallExport(state.cameras))

exStartBtn.addEventListener('click', async () => {
  const keys = [...exCamsEl.querySelectorAll('input:checked')].map((b) => b.value)
  const from = timeOnDay(exFrom.value)
  const to = timeOnDay(exTo.value)
  const { clips, dropped, error } = exportClipsFor(keys, from, to)
  if (error) return exSay(error, true)

  exStartBtn.disabled = true
  exProgressEl.hidden = false
  exProgressEl.value = 0
  exSay(dropped > 0 ? `Starting… (one job takes at most ${clips.length} cameras, so ${dropped} were left out)` : 'Starting…')
  try {
    const started = await fetch('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clips, format: document.querySelector('input[name="wallExFormat"]:checked')?.value ?? 'pack', name: $('wallExName').value, notes: $('wallExNotes').value })
    }).then(async (r) => {
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      return d
    })
    await followWallExport(started.id)
  } catch (e) {
    exSay(e.message, true)
    exStartBtn.disabled = false
    exProgressEl.hidden = true
  }
})

/** Polls until the export finishes, then offers it — the same loop the playback page uses. */
async function followWallExport(id) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    let job
    try {
      job = await fetch(`/api/exports/${encodeURIComponent(id)}`).then((r) => r.json())
    } catch {
      continue // a blip in polling is not a failed export
    }
    // progress is { step, pct, … } (export-job.mjs), as playback.js reads it
    if (Number.isFinite(job.progress?.pct)) exProgressEl.value = job.progress.pct
    if (job.state === 'done') {
      exSay('Ready.')
      const a = document.createElement('a')
      a.href = `/api/exports/${encodeURIComponent(id)}/download`
      a.download = job.downloadName ?? 'export.zip'
      a.click()
      exStartBtn.disabled = false
      return
    }
    if (job.state === 'failed' || job.state === 'cancelled') {
      exSay(job.error ?? 'The export did not finish.', true)
      exStartBtn.disabled = false
      exProgressEl.hidden = true
      return
    }
  }
}

// ---- start ----------------------------------------------------------------------------------

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.href = '/login.html'
})

const [me, cameras] = await Promise.all([api('/api/me'), api('/api/cameras?for=playback')])
state.user = me.user
state.all = cameras
$('whoami').textContent = me.user
if (me.admin) { const st = $('sitesTab'); if (st) st.hidden = false; const se = $('settingsTab'); if (se) se.hidden = false }
state.h265 = await canDecodeH265()
if (!('VideoDecoder' in window)) {
  loadNote.hidden = false
  loadNote.dataset.level = 'over'
  loadNote.textContent = window.isSecureContext
    ? 'This browser cannot decode video (no WebCodecs). Use a current Chrome, Edge or Safari.'
    : 'Video needs a secure connection. Open this page with https:// (port 8443) instead.'
}

// the browser's own zone until a timeline says where the cameras are
state.tz = -new Date().getTimezoneOffset() * 60_000
state.serverNow = Date.now()
// a few minutes back, so there is something recorded to show rather than the edge of now
clock.seek(state.serverNow - 5 * 60_000)
state.date = fmtDate(clock.atMs)
dateInput.value = state.date
dateInput.max = state.date
state.view = makeView({ dayStartMs: dayStartOf(state.date), dayEndMs: dayStartOf(state.date) + DAY, spanMs: 3_600_000, startMs: clock.atMs - 1_800_000, minSpanMs: MIN_SPAN })

// the cameras this user chose last time, in this browser; ?cameras=nvr/ch,nvr/ch wins (a link from
// the playback page, or a shared "look at this" link), and is not saved over their own choice
const wanted = new URLSearchParams(location.search).get('cameras')
const at = Number(new URLSearchParams(location.search).get('at'))
if (Number.isFinite(at) && at > 0) {
  clock.seek(at)
  state.date = fmtDate(at)
  dateInput.value = state.date
}
layoutSel.value = state.layout
laneModeSel.value = state.laneMode
setCameras(wanted ? wanted.split(',') : readStore().cameras)
// The saved views come after the cameras are up: the wall must not wait on a preferences file to
// show anything, and a view chosen from the menu replaces what is on screen anyway.
loadViews()
setPlaying(false)
drawLanes()
syncTiles()
setInterval(syncTiles, DRIFT_CHECK_MS)
requestAnimationFrame(frame)

// each tile's name links to the single-camera page at the moment on screen, which is where an
// investigator goes next once the wall has told them which camera to look at
setInterval(() => {
  for (const t of state.tiles) {
    t.nameEl.href = `/playback.html?nvr=${encodeURIComponent(t.nvr)}&ch=${t.ch}&t=${Math.round(clock.atMs)}`
    t.nameEl.title = `${t.name} · ${t.nvrName} — open on the playback page (this wall is at ${fmtClock(clock.atMs, { tzOffsetMs: state.tz })} server time)`
  }
}, 1000)

// One camera | Many cameras: back to one camera (the first on the wall), at the wall's moment
document.getElementById('modeOne')?.addEventListener('click', () => {
  const t = state.tiles[0]
  const cam = t ? `nvr=${encodeURIComponent(t.nvr)}&ch=${t.ch}&` : ''
  location.href = `/playback.html?${cam}t=${Math.round(clock.atMs)}`
})

// the day's timelines again every minute, so today's wall sees footage as it is recorded
setInterval(() => {
  if (state.date === fmtDate(Date.now())) loadDay()
}, 60_000)
