// Live tile stall watchdog (public/live-tile.js): the badge says 'no video' after ~5 s without
// frames (not a stale "N fps" with the live dot), and the tile reconnects by itself after about 8 s
// without frames on a socket that is still open. Stand-ins for the page and WebSocket; no server.
// Run:  node cctv/test/live-tile.test.mjs
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// ---- stand-ins
globalThis.window = { devicePixelRatio: 1 }
globalThis.requestAnimationFrame = () => 1
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.location = { protocol: 'http:', host: 'x' }
const sockets = []
globalThis.WebSocket = class {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.closed = false
    sockets.push(this)
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.onclose?.()
  }
}
WebSocket.OPEN = 1
const el = () => ({ textContent: '', classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c) }, contains(c) { return this.set.has(c) } }, append() {} })
const canvas = { width: 0, height: 0, getContext: () => ({}) }
const dotEl = { className: '', title: '' }
const parts = { '.status': el(), '.stats': el(), '.name': el(), '.dot': dotEl, canvas }
const tileEl = { dataset: {}, classList: el().classList, style: {}, querySelector: (s) => parts[s], append() {} }

const { LiveTile, MAIN_STREAM, NO_VIDEO_MS, STALL_RECONNECT_MS, SUB_STREAM, TILE_HTML, tileDot, waitText } = await import('../public/live-tile.js')

// ---- the tile state dot (pure: no DOM needed)
{
  const live = tileDot({ hasVideo: true, recording: false })
  check('video arriving, not recorded: green dot', /\bdot-live\b/.test(live.className) && /video is arriving/i.test(live.title), `${live.className} / ${live.title}`)
  const rec = tileDot({ hasVideo: true, recording: true })
  check('video arriving and recorded: red dot, title says so', /\bdot-rec\b/.test(rec.className) && /record/i.test(rec.title), `${rec.className} / ${rec.title}`)
  const off = tileDot({ hasVideo: false })
  check('no video: grey dot, title says nothing is arriving', /\bdot-off\b/.test(off.className) && /nothing is arriving/i.test(off.title), `${off.className} / ${off.title}`)
  const stale = tileDot({ hasVideo: true, stale: true })
  check('stale (frames stopped): grey, not green', /\bdot-off\b/.test(stale.className) && !/dot-live/.test(stale.className), stale.className)
  const unknown = tileDot({ hasVideo: true })
  check('recording unknown: green, never red', /\bdot-live\b/.test(unknown.className), unknown.className)
  check('every dot state carries a title, so colour is not the only clue', [live, rec, off, stale, unknown].every((d) => typeof d.title === 'string' && d.title.length > 0))
  check('the tile markup holds a dot', /class="dot /.test(TILE_HTML), TILE_HTML)
}

check('no video after ~5 s, reconnect after ~8 s', NO_VIDEO_MS >= 4000 && NO_VIDEO_MS <= 6000 && STALL_RECONNECT_MS > NO_VIDEO_MS && STALL_RECONNECT_MS <= 10_000, `${NO_VIDEO_MS} ${STALL_RECONNECT_MS}`)

let now = 1_000_000
const t = new LiveTile(tileEl, { nvr: 'n1', ch: 2 }, 1, 0, { now: () => now })
clearInterval(t.statusTimer) // driven by hand below
clearTimeout(t.retry)
// the player times each frame as it arrives, and a long decode queue is not a slow decoder unless it is
// really behind (player.js arrivalClock; test/player-burst.test.mjs)
check('a live tile\'s player times frames as they arrive (arrivalClock)', t.player.arrivalClock === true)
// a page through the tunnel (viewer.js) keeps up to 2 s of decoded frames for its bigger buffer
// (playout.js REMOTE_CLOCK, player.js REMOTE_QUEUED_FRAMES); a local page the player's usual 45
{
  const { REMOTE_QUEUED_FRAMES } = await import('../public/player.js')
  const { REMOTE_CLOCK } = await import('../public/playout.js')
  const { REMOTE_NO_REWIND_MS } = await import('../public/player.js')
  const far = new LiveTile(tileEl, { nvr: 'n1', ch: 3 }, 1, 0, { now: () => now, clock: REMOTE_CLOCK, maxQueuedFrames: REMOTE_QUEUED_FRAMES, noRewindMs: REMOTE_NO_REWIND_MS })
  check('a tile given the remote profile passes its clock and its decoded-frame limit to its player', far.player.clock.opts.stretchLate === true && far.player.maxQueued === REMOTE_QUEUED_FRAMES && REMOTE_QUEUED_FRAMES === 75, `${far.player.maxQueued}`)
  check('... and its window for never showing an older frame (stutter report 2.5)', far.player.noRewindMs === REMOTE_NO_REWIND_MS, `${far.player.noRewindMs}`)
  check('... a tile without it keeps the player\'s own (45, every frame shown in its turn)', t.player.maxQueued === 45 && t.player.clock.opts.stretchLate === false && t.player.noRewindMs === 0)
  clearInterval(far.statusTimer)
  clearTimeout(far.retry)
  far.close()
}
t.player.push = () => {} // no decoding here
t.connect()
const ws = sockets.at(-1)
ws.readyState = 1
const frame = (key) => {
  const b = new Uint8Array(40)
  b[0] = key ? 1 : 0
  ws.onmessage({ data: b.buffer })
}
frame(true)
t.player.stats.fps = 25 // as the player measures while frames arrive
now += 1000
t.updateStatus()
const status = parts['.status']
check('frames arriving: "LIVE" with the live dot', status.textContent === 'LIVE' && status.classList.contains('live'), status.textContent)
check('... and the tile dot is green', /\bdot-live\b/.test(dotEl.className), dotEl.className)
// frames stop; the player's last fps figure stays
now += 3000
t.updateStatus()
check('3 s without frames: still the fps badge', status.textContent === 'LIVE')
now += 3000
t.updateStatus()
check('6 s without decoded frames: explicit no-video state, live dot off', status.textContent === 'No video received' && !status.classList.contains('live'), status.textContent)
check('... and the tile dot has gone grey', /\bdot-off\b/.test(dotEl.className), dotEl.className)
check('... and the socket is still the same one', sockets.length === 1 && !ws.closed)
now += 12_000 // 18 s without frames
t.updateStatus()
check('~18 s without frames on an open socket: the tile reconnects by itself', ws.closed, `closed ${ws.closed}`)
check('... reconnect shows as reconnecting', /reconnecting/.test(status.textContent), status.textContent)
// suspended tiles (hidden under the full-size view) are left alone
{
  now += 1000
  const t2 = new LiveTile(tileEl, { nvr: 'n1', ch: 3 }, 1, 0, { now: () => now })
  clearInterval(t2.statusTimer)
  clearTimeout(t2.retry)
  t2.connect()
  const w2 = sockets.at(-1)
  w2.readyState = 1
  t2.suspend()
  now += 60_000
  t2.updateStatus()
  check('a suspended tile is not reconnected by the watchdog', !w2.closed)
  t2.close()
}
// a released tile (the grid freed under a full-size view): its socket is closed so the server stops
// sending it; the watchdog leaves it alone; resume reconnects it
{
  now += 1000
  const t2b = new LiveTile(tileEl, { nvr: 'n1', ch: 8 }, 1, 0, { now: () => now })
  clearInterval(t2b.statusTimer)
  clearTimeout(t2b.retry)
  t2b.connect()
  const w2b = sockets.at(-1)
  w2b.readyState = 1
  const n2b = sockets.length
  t2b.release()
  check('release closes the socket and marks the tile released', w2b.closed && t2b.suspended && t2b.released && t2b.ws === null, `${w2b.closed} ${t2b.suspended} ${t2b.released}`)
  now += 60_000
  t2b.updateStatus()
  check('a released tile is not reconnected by the watchdog', sockets.length === n2b)
  t2b.resume()
  check('resume reconnects a released tile (a fresh socket), no longer released', sockets.length === n2b + 1 && !t2b.released && !t2b.suspended)
  t2b.close()
}
// a socket still connecting: given a few seconds, then dropped and tried again (the browser's own
// timeout never came: a full-size view waited 10+ minutes for its main stream, 2026-09-27)
{
  const t3 = new LiveTile(tileEl, { nvr: 'n1', ch: 4 }, 1, 0, { now: () => now })
  clearInterval(t3.statusTimer)
  clearTimeout(t3.retry)
  t3.connect()
  const w3 = sockets.at(-1)
  now += 3000
  t3.updateStatus()
  check('socket still connecting after 3 s: badge stays "connecting…"', /connecting/.test(parts['.status'].textContent) && !w3.closed, parts['.status'].textContent)
  now += 5500
  t3.updateStatus()
  check('... never opened after 8 s, nothing else opening: dropped, and a retry is scheduled', w3.closed && Boolean(t3.retry) && /reconnecting/.test(parts['.status'].textContent), `${w3.closed} ${parts['.status'].textContent}`)
  t3.close()
}
// a big grid: the browser opens its sockets one at a time, so a socket waiting its turn is queued,
// not stuck. Dropping those sent them to the back of the queue again and an 8x8 never loaded.
{
  const mk = (ch) => {
    const x = new LiveTile(tileEl, { nvr: 'n1', ch }, 1, 0, { now: () => now })
    clearInterval(x.statusTimer)
    clearTimeout(x.retry)
    x.connect()
    return [x, sockets.at(-1)]
  }
  const [a, wa] = mk(10)
  now += 100
  const [b, wb] = mk(11)
  now += 100
  const [c, wc] = mk(12)
  // the queue moves: one opens 9 s later
  now += 9000
  wa.readyState = 1
  wa.onopen()
  b.updateStatus()
  c.updateStatus()
  check('sockets waiting while others keep opening are left in the queue', !wb.closed && !wc.closed)
  // then nothing opens for 8 s: only the oldest waiting one (the one holding the queue) is dropped
  now += 8500
  c.updateStatus()
  check('... a younger waiting socket is not the stuck one', !wc.closed)
  b.updateStatus()
  check('... the oldest waiting one is, once nothing has opened for 8 s', wb.closed)
  for (const x of [a, b, c]) x.close()
}
// back from the full-size view: the stream kept since its last keyframe is shown at once, on the
// same socket (a reconnect through the internet link was 1.7-4.5 s, 2026-09-26)
{
  const t4 = new LiveTile(tileEl, { nvr: 'n1', ch: 5 }, 1, 0, { now: () => now })
  clearTimeout(t4.retry)
  const pushed = []
  t4.player.push = (f) => pushed.push(f.isKey ? 'K' : 'd')
  t4.player.reset = () => pushed.push('reset')
  t4.connect()
  const w4 = sockets.at(-1)
  w4.readyState = 1
  const send = (key) => {
    const b = new Uint8Array(40)
    b[0] = key ? 1 : 0
    w4.onmessage({ data: b.buffer })
  }
  send(true)
  t4.suspend()
  send(false)
  send(true)
  send(false)
  send(false)
  check('suspended: frames are not decoded', pushed.join('') === 'K', pushed.join(''))
  const socketsBefore = sockets.length
  t4.resume()
  check('resume: no new socket', sockets.length === socketsBefore && !w4.closed)
  check('resume: the kept keyframe and the frames after it are decoded at once', pushed.slice(1).join(',') === 'reset,K,d,d', pushed.join(','))
  send(false)
  check('resume: and the stream carries on', pushed.at(-1) === 'd')
  // hidden for less than a keyframe interval: the stretch from before still counts (it was a
  // reconnect of 0.9-2.4 s for a third of the tiles)
  t4.suspend()
  send(false)
  pushed.length = 0
  t4.resume()
  check('short hide: resumes from the keyframe before it, no reconnect', !w4.closed && pushed.join(',') === 'reset,K,d,d,d,d', pushed.join(','))
  t4.close()
}
// never had a keyframe (nothing kept): back from the full-size view reconnects, as before
{
  const t5 = new LiveTile(tileEl, { nvr: 'n1', ch: 6 }, 1, 0, { now: () => now })
  clearTimeout(t5.retry)
  t5.player.push = () => {}
  t5.connect()
  const w5 = sockets.at(-1)
  w5.readyState = 1
  const b = new Uint8Array(40)
  w5.onmessage({ data: b.buffer })
  t5.suspend()
  const before = sockets.length
  t5.resume()
  check('nothing kept: reconnects', w5.closed && sockets.length === before + 1)
  t5.close()
}
// the full-size view borrows the grid tile's stream of the same camera: no second connection
{
  const grid = new LiveTile(tileEl, { nvr: 'n1', ch: 7 }, 1, 0, { now: () => now })
  clearTimeout(grid.retry)
  grid.player.push = () => {}
  grid.connect()
  const wg = sockets.at(-1)
  wg.readyState = 1
  const sendG = (key) => {
    const b = new Uint8Array(40)
    b[0] = key ? 1 : 0
    wg.onmessage({ data: b.buffer })
  }
  sendG(true)
  sendG(false)
  grid.suspend() // hidden under the full-size view
  const before = sockets.length
  const got = []
  const overlayEl = { dataset: {}, querySelector: (s) => ({ ...parts, '.status': el() })[s], append() {} }
  const full = new LiveTile(overlayEl, { nvr: 'n1', ch: 7 }, 1, 0, { now: () => now, borrowFrom: grid })
  full.player.push = (f) => got.push(f.isKey ? 'K' : 'd')
  check('borrow: no new socket for the full-size view', sockets.length === before && full.source === grid)
  sendG(false)
  check('borrow: new frames reach the full-size view', got.at(-1) === 'd', got.join(','))
  const other = new LiveTile(overlayEl, { nvr: 'n1', ch: 8 }, 1, 0, { now: () => now, borrowFrom: grid })
  clearTimeout(other.retry)
  check('borrow: never from a different camera', other.source === null)
  other.close()
  // the grid tile goes away: the full-size view connects by itself
  grid.close()
  full.updateStatus()
  check('source closed: the full-size view opens its own connection', full.source === null && sockets.length === before + 1, `sockets ${sockets.length - before}`)
  full.close()
}
// ---- stream rights: the server's wait notes, and the main stream refused for want of Live HD ----------
{
  const nameEl = { textContent: 'Gate', append(s) { this.textContent += s } }
  const st = el()
  const tileHd = { dataset: {}, querySelector: (s) => (s === '.name' ? nameEl : s === '.status' ? st : parts[s]), append() {} }
  const tw = new LiveTile(tileHd, { nvr: 'n1', ch: 7 }, SUB_STREAM, 0, { now: () => now })
  clearTimeout(tw.retry)
  tw.player.push = () => {}
  tw.connect()
  const ww = sockets.at(-1)
  ww.readyState = 1
  ww.onmessage({ data: '{"op":"wait","why":"held"}' })
  check('a wait note: the tile says why it waits', st.textContent === 'Waiting for room at the NVR (SD streams)', st.textContent)
  check('waitText for each reason', waitText('starting') === 'Starting…' && /not available/.test(waitText('unavailable')) && waitText('held') === st.textContent && waitText('anything') === 'Starting…')
  for (let i = 0; i < 5; i++) {
    now += 4000
    ww.onmessage({ data: '{"op":"wait","why":"held"}' })
    tw.updateStatus()
  }
  check('... notes every 4 s count as activity: 20 s on, no "no video" and no reconnect', !ww.closed && st.textContent === 'Waiting for room at the NVR (SD streams)', st.textContent)
  ww.onmessage({ data: 'not json' })
  ww.onmessage({ data: '{"op":"other"}' })
  check('... other text is ignored', !ww.closed && st.textContent === 'Waiting for room at the NVR (SD streams)')
  tw.close()

  const tm = new LiveTile(tileHd, { nvr: 'n1', ch: 8 }, MAIN_STREAM, 0, { now: () => now })
  clearTimeout(tm.retry)
  tm.player.push = () => {}
  tm.connect()
  const wm = sockets.at(-1)
  const before = sockets.length
  wm.readyState = 3
  wm.onclose({ code: 1008, reason: 'hd not allowed' })
  const w2 = sockets.at(-1)
  check('main refused "hd not allowed": the sub-stream at once, on a new socket', sockets.length === before + 1 && tm.streamType === SUB_STREAM && /stream=1/.test(w2.url), w2?.url)
  check('... and the name says so', /SD: full quality needs Live HD/.test(nameEl.textContent), nameEl.textContent)
  w2.readyState = 3
  w2.onclose({ code: 1008, reason: 'hd not allowed' })
  check('... the same close on the sub-stream is an ordinary close: a retry later, not another fallback', tm.streamType === SUB_STREAM && sockets.length === before + 1 && Boolean(tm.retry))
  tm.close()
  let handled = 0
  const tl = new LiveTile(tileHd, { nvr: 'n1', ch: 9 }, MAIN_STREAM, 0, { now: () => now, onHdRefused: () => { handled++; return true } })
  clearTimeout(tl.retry)
  tl.connect()
  const wl = sockets.at(-1)
  const n = sockets.length
  wl.onclose({ code: 1008, reason: 'hd not allowed' })
  check('onHdRefused handling it (viewer.js drops a layer not shown yet): no new socket, no fallback', handled === 1 && sockets.length === n && tl.streamType === MAIN_STREAM)
  tl.close()
}
// the debug frame trace (frame-trace.js, behind the D overlay): while one runs, every frame that
// arrives on the tile's socket, its connection events and the D overlay's counters; nothing else
{
  const { activeTrace, startTrace, stopTrace } = await import('../public/frame-trace.js')
  const us = (b, v) => new DataView(b.buffer).setBigInt64(8, BigInt(v), true)
  const mk = () => {
    const x = new LiveTile(tileEl, { nvr: 'n1', ch: 9 }, 1, 0, { now: () => now })
    clearTimeout(x.retry)
    x.player.push = () => {}
    return x
  }
  const quiet = mk()
  quiet.connect()
  const wq = sockets.at(-1)
  wq.readyState = 1
  wq.onmessage({ data: new Uint8Array(40).buffer })
  check('trace: none runs unless the viewer starts one', activeTrace() === null)
  quiet.close()

  let clock = 0
  startTrace({ now: () => clock, later: () => 1, cancel: () => {} })
  const t6 = mk()
  t6.connect()
  const w6 = sockets.at(-1)
  clock = 5
  w6.readyState = 1
  w6.onopen()
  const send6 = (key, v, size = 40) => {
    const b = new Uint8Array(size)
    b[0] = key ? 1 : 0
    us(b, v)
    w6.onmessage({ data: b.buffer })
  }
  clock = 10
  send6(true, 1_000_000, 900)
  clock = 60.25
  send6(false, 1_050_000)
  t6.player.stats = { ...t6.player.stats, fps: 20, dropped: 3, late: 2, resyncs: 1, delayMs: 350 }
  clock = 1000
  t6.updateStatus()
  const full = new LiveTile({ dataset: {}, querySelector: (s) => ({ ...parts, '.status': el() })[s], append() {} }, { nvr: 'n1', ch: 9 }, 1, 0, { now: () => now, borrowFrom: t6 })
  full.player.push = () => {}
  clock = 1100
  t6.suspend()
  send6(false, 1_100_000)
  t6.resume()
  clock = 1200
  w6.close() // the socket drops: the tile reconnects later
  clearTimeout(t6.retry)
  t6.close()
  full.close()
  const x = stopTrace()
  const [a, b] = x.tiles
  check('trace: the tile\'s frames as its socket delivered them (arrival, capture, bytes, key)', JSON.stringify(a.frames) === '[[10,0,900,1],[60.3,50,40,0],[1100,100,40,0]]', JSON.stringify(a.frames))
  check('... its connection and display events', JSON.stringify(a.events.map((e) => e[1])) === '["connect","open","suspend","resume","close","end"]' && a.events[0][2] === 'sub', JSON.stringify(a.events))
  check('... the D overlay\'s counters once a second', JSON.stringify(a.stats) === '[[1000,20,3,2,1,350]]', JSON.stringify(a.stats))
  check('... a tile borrowing it records the borrow, and no frames of its own', b.camera === 'n1/10' && JSON.stringify(b.events.map((e) => e.slice(1))) === '[["borrow",1],["end"]]' && b.frames.length === 0, JSON.stringify(b))
}
// a trace started while the full-size view is open, and the two ways back from it: the trace must say
// which tiles were already hidden or borrowing, and whether a resume decoded what the tile kept or
// connected again, or its replay (test/live-replay.mjs) plays what the viewer never saw
{
  const { startTrace, stopTrace } = await import('../public/frame-trace.js')
  const mk = (ch, o = {}) => {
    const x = new LiveTile({ dataset: {}, querySelector: (s) => ({ ...parts, '.status': el() })[s], append() {} }, { nvr: 'n1', ch }, 1, 0, { now: () => now, ...o })
    clearTimeout(x.retry)
    x.player.push = () => {}
    return x
  }
  const open = (x) => {
    x.connect()
    const w = sockets.at(-1)
    w.readyState = 1
    w.onopen()
    return (key) => {
      const b = new Uint8Array(40)
      b[0] = key ? 1 : 0
      w.onmessage({ data: b.buffer })
    }
  }
  const grid = mk(11)
  const sendGrid = open(grid)
  sendGrid(true)
  grid.suspend() // under the full-size view, before the trace starts
  const lender = mk(12)
  const sendLender = open(lender)
  sendLender(true)
  lender.suspend()
  const view = mk(12, { borrowFrom: lender }) // the full-size view, borrowing its grid tile
  const quiet = mk(13)
  const sendQuiet = open(quiet)
  sendQuiet(true)
  quiet.suspend()
  let clock = 0
  const tr = startTrace({ now: () => clock, later: () => 1, cancel: () => {} })
  clock = 20
  sendGrid(false)
  clock = 30
  view.updateStatus()
  grid.resume() // still connected, frames in the last 3 s: decodes what it kept
  now += 4000 // nothing from the quiet one for 4 s: not lendable
  clock = 40
  quiet.resume() // connects again
  stopTrace()
  for (const x of [grid, lender, view, quiet]) x.close()
  const events = (tile) => JSON.stringify(tr.records.get(tile)?.events.map((e) => e.slice(1)))
  check('trace started over a hidden tile: "suspend" comes first, then its frames', events(grid) === '[["suspend"],["resume","kept"]]' && tr.records.get(grid).frames.length === 1 && tr.records.get(grid).events[0][0] === 20, events(grid))
  check('... over a full-size view borrowing: "borrow" first, naming its lender, itself hidden', events(view) === '[["borrow",3]]' && tr.records.get(lender)?.id === 3 && events(lender) === '[["suspend"]]', `${events(view)} ${events(lender)}`)
  check('... a resume with nothing fresh kept says it connected again, before its new connect', events(quiet) === '[["suspend"],["resume","reconnect"],["connect","sub"]]', events(quiet))
}
{
  const frozen = new LiveTile(tileEl, { nvr: 'n1', ch: 20 }, SUB_STREAM, 0, { now: () => now })
  const healthy = new LiveTile(tileEl, { nvr: 'n1', ch: 21 }, SUB_STREAM, 0, { now: () => now })
  for (const x of [frozen, healthy]) {
    clearTimeout(x.retry)
    x.player.push = () => {}
    x.connect()
    x.ws.readyState = 1
    x.ws.onopen()
    x.player.onFrame()
  }
  const deadSocket = frozen.ws
  const goodSocket = healthy.ws
  frozen.attempts = 3
  now += 13000
  deadSocket.onmessage({ data: new Uint8Array(40).buffer })
  check('undecoded packets do not reset retry backoff', frozen.attempts === 3)
  // a healthy camera is one whose packets still arrive and decode: without the packet its socket has
  // been silent for 13 s, which is the stall the tile is right to reconnect (STALL_RECONNECT_MS)
  goodSocket.onmessage({ data: new Uint8Array(40).buffer })
  healthy.player.onFrame()
  frozen.updateStatus()
  healthy.updateStatus()
  check('frozen decoder recovers even while packets arrive', deadSocket.closed)
  check('recovery leaves the healthy camera connected', !goodSocket.closed)
  for (const x of [frozen, healthy]) x.close()
}
t.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
