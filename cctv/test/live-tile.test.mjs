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
const tileEl = { querySelector: (s) => parts[s], append() {} }

const { LiveTile, NO_VIDEO_MS, STALL_RECONNECT_MS, TILE_HTML, tileDot } = await import('../public/live-tile.js')

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
check('6 s without frames: "no video", live dot off', status.textContent === 'no video' && !status.classList.contains('live'), status.textContent)
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
// a socket still connecting (never opened) is left to the browser's own timeout
{
  const t3 = new LiveTile(tileEl, { nvr: 'n1', ch: 4 }, 1, 0, { now: () => now })
  clearInterval(t3.statusTimer)
  clearTimeout(t3.retry)
  t3.connect()
  const w3 = sockets.at(-1)
  now += 6000
  t3.updateStatus()
  check('socket still connecting: badge stays "connecting…"', /connecting/.test(parts['.status'].textContent) && !w3.closed, parts['.status'].textContent)
  t3.close()
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
  send(false) // (no keyframe seen yet while suspended: nothing to keep)
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
  // nothing kept (no keyframe while suspended): reconnects, as before
  t4.suspend()
  send(false)
  t4.resume()
  check('nothing kept: reconnects', w4.closed && sockets.length === socketsBefore + 1)
  t4.close()
}
t.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
