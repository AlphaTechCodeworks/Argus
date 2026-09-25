// Live tile stall watchdog (public/live-tile.js): the badge says 'no video' after ~5 s without
// frames (not a stale "N fps" with the live dot), and the tile reconnects by itself after 15-20 s
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
const parts = { '.status': el(), '.stats': el(), '.name': el(), canvas }
const tileEl = { querySelector: (s) => parts[s], append() {} }

const { LiveTile, NO_VIDEO_MS, STALL_RECONNECT_MS } = await import('../public/live-tile.js')
check('no video after ~5 s, reconnect after 15-20 s', NO_VIDEO_MS >= 4000 && NO_VIDEO_MS <= 6000 && STALL_RECONNECT_MS >= 15_000 && STALL_RECONNECT_MS <= 20_000, `${NO_VIDEO_MS} ${STALL_RECONNECT_MS}`)

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
check('frames arriving: "25 fps" with the live dot', status.textContent === '25 fps' && status.classList.contains('live'), status.textContent)
// frames stop; the player's last fps figure stays
now += 3000
t.updateStatus()
check('3 s without frames: still the fps badge', status.textContent === '25 fps')
now += 3000
t.updateStatus()
check('6 s without frames: "no video", live dot off', status.textContent === 'no video' && !status.classList.contains('live'), status.textContent)
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
t.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
