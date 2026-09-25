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
import { describeSkew, mergeSources, recordedFrom } from './pb-sources.js'
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
  needsResync,
  normaliseChoice,
  serverTime,
  tileState,
  wallMode
} from './wall-clock.js'

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

const state = {
  user: '',
  all: [], // every camera from /api/cameras
  tiles: [], // Tile, in the chosen order
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
    this.key = `${cam.nvr}/${cam.ch}`
    this.skew = 0 // this NVR's clock - the server's (ms), from the timeline: no NVR call
    this.available = false // the server has an index of this camera's recordings
    this.codec = 'h264'
    this.stretches = []
    this.position = null // the moment on screen, in SERVER time (never the NVR's)
    this.lastSeekAt = -Infinity
    this.error = null
    this.undecodable = false
    this.ws = null
    this.shownKind = null
    this.blankOpens = 0 // sockets opened in a row that produced no picture at all

    this.el = document.createElement('div')
    this.el.className = 'wall-tile'
    this.el.innerHTML = `
      <canvas></canvas>
      <div class="wall-tile-msg" hidden></div>
      <div class="wall-tile-label">
        <a class="wall-tile-name" title="Open this camera on the playback page at this moment"></a>
        <span class="wall-tile-time"></span>
      </div>`
    this.msgEl = this.el.querySelector('.wall-tile-msg')
    this.nameEl = this.el.querySelector('.wall-tile-name')
    this.timeEl = this.el.querySelector('.wall-tile-time')
    this.nameEl.textContent = `${cam.name} · ${cam.nvrName}`

    this.player = new VideoPlayer(this.el.querySelector('canvas'), {
      // the same buffer the playback page uses: recordings arrive in bursts, not at frame rate
      clock: { startDelayMs: 300, minDelayMs: 200, maxDelayMs: 1000 },
      onFrame: (ts) => {
        // ts is in whatever clock this tile's source stamps: the server's own recordings are
        // already server time (skew 0 below), the NVR's playback is the NVR's clock.
        this.position = serverTime(ts, this.sourceSkew())
        this.blankOpens = 0 // pictures are arriving again
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
    if (state.quality === 'hd' && this.available && !(this.codec === 'h265' && !state.h265)) return 'server'
    return 'nvr'
  }

  /** The day's recorded stretches for this camera, from the server's index (one request, no NVR). */
  async loadDay(from, token) {
    this.error = null
    this.stretches = []
    try {
      const tl = await api(`/api/playback/timeline?nvr=${encodeURIComponent(this.nvr)}&ch=${this.ch}&from=${from}&to=${from + DAY}`)
      if (token !== dayToken) return
      this.available = tl.available === true
      if (!this.available) return
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
      this.error = `Could not load this camera's timeline: ${e.message}`
    }
  }

  /** What this tile should be showing at the shared moment, and whether it can. */
  status(atMs) {
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

  /** Puts the tile where the shared clock says, opening, re-seeking or stopping it as needed. */
  sync(atMs, playing) {
    const st = this.status(atMs)
    this.show(st)
    if (st.kind !== 'playing') {
      this.close()
      this.position = null
      return
    }
    const since = performance.now() - this.lastSeekAt
    // Opened, or opened and closed again, without a single picture: say so rather than leaving a
    // black square, which reads as "nothing happened here" when it means the pictures are not
    // arriving — and stop reopening as fast as the loop runs, which would only make it worse.
    if (this.position === null && (this.blankOpens >= 2 || since > NO_PICTURE_MS)) {
      this.show({ kind: 'waiting', text: 'No picture from this camera. Trying again.' })
    }
    if (!this.ws) {
      if (this.blankOpens >= 2 && since < NO_PICTURE_MS) return
      return this.open(atMs)
    }
    if (needsResync(this.position, atMs) && since > RESYNC_EVERY_MS) return this.open(atMs)
    this.setPaused(!playing)
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
    const server = this.mode() === 'server'
    const target = server ? (recordedFrom(this.stretches, atMs) ?? atMs) : atMs
    const start = Math.round(server ? target : cameraTime(target, this.skew))
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    // stream=1 is the camera's sub-stream (SD); server footage is always the main stream
    const q = `nvr=${encodeURIComponent(this.nvr)}&ch=${this.ch}&stream=${server ? 0 : 1}&start=${start}${server ? '&src=auto' : ''}`
    const sock = new WebSocket(`${proto}://${location.host}/playback?${q}`)
    sock.binaryType = 'arraybuffer'
    sock.onopen = () => {
      const speed = clampSpeed(state.speed, server ? 'server' : 'nvr').speed
      if (speed !== 1) sock.send(JSON.stringify({ speed }))
      if (!clock.playing) sock.send(JSON.stringify({ pause: true }))
    }
    sock.onmessage = (e) => {
      if (this.ws !== sock) return
      if (typeof e.data === 'string') return this.onStatus(JSON.parse(e.data))
      this.pushFrame(e.data)
    }
    sock.onclose = (e) => {
      if (this.ws !== sock) return
      this.ws = null
      if (this.position === null) this.blankOpens++ // it closed without ever showing anything
      if (e.code === 1013) {
        // one playback session per tile is one per tile on the NVR as well
        this.error = 'The NVR is busy with other playbacks. Fewer cameras, or HD (server recordings), would avoid this.'
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

  destroy() {
    this.close()
    this.player.close()
    this.el.remove()
  }
}

// ---- the wall -------------------------------------------------------------------------------

let dayToken = 0

/** Builds the tiles for the chosen cameras (keeping the ones already up and playing). */
function setCameras(keys) {
  const wanted = normaliseChoice(keys, { known: new Set(state.all.map((c) => `${c.nvr}/${c.ch}`)) })
  const have = new Map(state.tiles.map((t) => [t.key, t]))
  for (const [key, tile] of have) if (!wanted.includes(key)) tile.destroy()
  state.tiles = wanted.map((key) => {
    const existing = have.get(key)
    if (existing) return existing
    const [nvr, ch] = [key.slice(0, key.lastIndexOf('/')), Number(key.slice(key.lastIndexOf('/') + 1))]
    const cam = state.all.find((c) => c.nvr === nvr && c.ch === ch)
    return new Tile({ nvr, ch, name: cam?.name ?? `Channel ${ch + 1}`, nvrName: cam?.nvrName ?? nvr, site: cam?.site ?? '' })
  })
  gridEl.replaceChildren(...state.tiles.map((t) => t.el))
  emptyEl.hidden = state.tiles.length > 0
  layoutGrid()
  // again once the browser has laid the grid out: the first call measured a box that had no tiles
  // in it yet, and the column count depends on the shape of the space as much as on the number
  setTimeout(layoutGrid, 0)
  renderLaneNames()
  renderSpeeds()
  updateLoadNote()
  loadDay()
}

function updateLoadNote() {
  const w = loadWarning(state.tiles.length, state.quality)
  loadNote.textContent = w.text
  loadNote.dataset.level = w.level
  loadNote.hidden = state.tiles.length === 0
}

/** The grid: the column count that makes each picture biggest in the space there is. */
function layoutGrid() {
  const { cols } = gridLayout(state.tiles.length, { width: gridEl.clientWidth || 1600, height: gridEl.clientHeight || 900 })
  gridEl.style.setProperty('--wall-cols', String(Math.max(1, cols)))
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

function renderLaneNames() {
  laneNamesEl.replaceChildren(
    ...state.tiles.map((t) => {
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
  const rows = buildLaneRows(
    v,
    // the gaps are drawn after the recorded stretches so a thin gap sits on top of them
    state.tiles.map((t) => ({ key: t.key, name: t.name, stretches: t.available ? [...t.stretches, ...(t.gaps ?? [])] : [] }))
  )
  laneRowsEl.replaceChildren(
    ...rows.map((row, i) => {
      const lane = document.createElement('div')
      lane.className = 'wall-lane pb-lane'
      const tile = state.tiles[i]
      if (!tile?.available) lane.classList.add('wall-lane-unknown')
      for (const b of row.boxes) {
        const box = document.createElement('div')
        box.style.left = `${b.leftPct}%`
        box.style.width = `${b.widthPct}%`
        box.dataset.kind = b.kind ?? 'server'
        if (b.kind === 'gap') box.title = tile?.gaps?.find((g) => g.s <= b.from && b.from <= g.e)?.reason ?? 'not recorded'
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
}

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
  for (const t of state.tiles) t.setPaused(!on)
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
  for (const tile of state.tiles) tile.open(clock.atMs)
  drawPlayhead() // the new moment reads on the clock straight away, not on the next frame
  scheduleDraw()
}

// ---- the loop -------------------------------------------------------------------------------

/**
 * The tiles are put back in step on a timer rather than on animation frames: a background tab, or a
 * PC busy decoding, gets few frames, and that is exactly when tiles drift. The animation frame only
 * moves the playhead, which nobody misses if it is late.
 */
function syncTiles() {
  clock.tick()
  for (const t of state.tiles) t.sync(clock.atMs, clock.playing)
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
  state.date = dateInput.value
  // the same clock time on the chosen day, so a wall set to 14:00 stays at 14:00
  const into = clock.atMs - dayStartOf(fmtDate(clock.atMs))
  seek(dayStartOf(state.date) + into)
})

qualitySel.addEventListener('change', () => {
  state.quality = qualitySel.value === 'hd' ? 'hd' : 'sd'
  updateLoadNote()
  renderSpeeds()
  for (const t of state.tiles) t.open(clock.atMs) // the source changed: reopen in the new one
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

$('pickCameras').addEventListener('click', () => {
  const chosen = new Set(state.tiles.map((t) => t.key))
  const groups = Map.groupBy(state.all, (c) => `${c.site} · ${c.nvrName}`)
  pickList.replaceChildren(
    ...[...groups].flatMap(([label, list]) => {
      const h = document.createElement('h3')
      h.textContent = label
      return [
        h,
        ...list.map((c) => {
          const key = `${c.nvr}/${c.ch}`
          const row = document.createElement('label')
          row.className = 'wall-pick-row'
          const box = document.createElement('input')
          box.type = 'checkbox'
          box.value = key
          box.checked = chosen.has(key)
          box.addEventListener('change', updatePickNote)
          row.append(box, document.createTextNode(` ${c.ch + 1} · ${c.name}${c.online ? '' : ' (offline)'}`))
          return row
        })
      ]
    })
  )
  updatePickNote()
  pickDlg.showModal()
})

/** What choosing this many will mean, said before they press the button rather than after. */
function updatePickNote() {
  const n = pickList.querySelectorAll('input:checked').length
  const w = loadWarning(n, state.quality)
  pickNote.textContent = n > MAX_TILES
    ? `${n} cameras: the wall shows the first ${MAX_TILES}. ${w.text}`
    : w.text
  pickNote.dataset.level = n > MAX_TILES ? 'over' : w.level
}

$('pickSave').addEventListener('click', () => {
  const keys = [...pickList.querySelectorAll('input:checked')].map((b) => b.value)
  const saved = writeStore(normaliseChoice(keys))
  setCameras(saved.cameras)
  pickDlg.close()
})

// ---- start ----------------------------------------------------------------------------------

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.href = '/login.html'
})

const [me, cameras] = await Promise.all([api('/api/me'), api('/api/cameras')])
state.user = me.user
state.all = cameras
$('whoami').textContent = me.user
if (me.admin) $('sitesTab').hidden = $('settingsTab').hidden = false
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
setCameras(wanted ? wanted.split(',') : readStore().cameras)
setPlaying(false)
drawLanes()
syncTiles()
setInterval(syncTiles, DRIFT_CHECK_MS)
requestAnimationFrame(frame)

// each tile's name links to the single-camera page at the moment on screen, which is where an
// investigator goes next once the wall has told them which camera to look at
setInterval(() => {
  for (const t of state.tiles) {
    t.nameEl.href = `/playback.html?nvr=${encodeURIComponent(t.nvr)}&ch=${t.ch}`
    // the playback page opens the camera; the moment is shown here in case it is wanted by hand
    t.nameEl.title = `${t.name} · ${t.nvrName} — open on the playback page (this wall is at ${fmtClock(clock.atMs, { tzOffsetMs: state.tz })} server time)`
  }
}, 1000)

// the day's timelines again every minute, so today's wall sees footage as it is recorded
setInterval(() => {
  if (state.date === fmtDate(Date.now())) loadDay()
}, 60_000)
