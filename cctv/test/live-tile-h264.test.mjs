// Live tile and H.265 it cannot play (public/live-tile.js): the page tells the server both ways
// whether its browser plays H.265; a tile that finds out late, on a real H.265 keyframe, connects
// again asking for H.264 and remembers it for every later tile; it shows the message only when the
// server then says it cannot convert the camera. Stand-ins for the page and WebSocket; no server.
// Run:  node cctv/test/live-tile-h264.test.mjs
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- stand-ins: a browser whose check says it plays H.265 (and whose decoder then refuses it)
globalThis.window = { devicePixelRatio: 1, VideoDecoder: true }
globalThis.VideoDecoder = { isConfigSupported: async () => ({ supported: true }) }
globalThis.requestAnimationFrame = () => 1
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.location = { protocol: 'http:', host: 'x', search: '' }
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
const el = () => ({ textContent: '', className: '', title: '', removed: false, classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c) }, contains(c) { return this.set.has(c) } }, append(...k) { (this.kids ??= []).push(...k) }, remove() { this.removed = true } })
const mkTileEl = () => {
  const parts = { '.status': el(), '.stats': el(), '.name': el(), '.label': el(), '.dot': { className: '', title: '' }, canvas: { width: 0, height: 0, getContext: () => ({}) } }
  return { parts, appended: [], dataset: {}, classList: { contains: () => false }, querySelector(s) { return parts[s] }, append(...k) { this.appended.push(...k) } }
}

const { CONVERTED_TITLE, H264_ASKS, H264_FAILED, H264_NO_ROOM, H264_RETRY_MS, LiveTile, MAIN_STREAM, SUB_STREAM, h265Answer, h265Forced, h265Text } = await import('../public/live-tile.js')
const { FAILED, NO_ROOM } = await import('../h264-fallback.mjs')
await sleep(5) // the page's check has answered: this browser says it plays H.265

// ---- the pure parts
check('?h265=0 on the address forces "cannot play H.265"', h265Forced('?h265=0') && h265Forced('?stats=1&h265=0'))
check('... a downgrade only: ?h265=1, anything else, or nothing claims nothing', !h265Forced('?h265=1') && !h265Forced('?h265=') && !h265Forced('?h265=00') && !h265Forced('?h265=false') && !h265Forced('') && !h265Forced(undefined) && !h265Forced(null))
check('what a stream is opened with: the check\'s answer, both ways', h265Answer({ device: true }) === true && h265Answer({ device: false }) === false)
check('... not known yet: nothing said (null), which the server does not read as "cannot"', h265Answer({ device: null }) === null && h265Answer({ device: undefined }) === null)
check('... forced, or learnt from a keyframe the decoder refused: "cannot", whatever the check said', h265Answer({ device: true, forced: true }) === false && h265Answer({ device: true, learned: true }) === false && h265Answer({ device: null, learned: true }) === false && h265Answer({ device: null, forced: true }) === false)
check('... never "can" for a browser whose check said no', h265Answer({ device: false, forced: false, learned: false }) === false)
check('the reasons are the server\'s, letter for letter', H264_NO_ROOM === NO_ROOM && H264_FAILED === FAILED)
{
  const plain = h265Text()
  const room = h265Text(H264_NO_ROOM)
  const failed = h265Text(H264_FAILED)
  check('no room: the tile says plainly that the server has no room to convert another H.265 camera right now', /no room to convert another H\.265 camera right now/.test(room.text) && /try again by itself/.test(room.text) && room.status === 'H.265 — server busy', room.text)
  check('... a failed conversion says that instead', /could not convert it/.test(failed.text) && failed.status !== room.status)
  check('... both keep the existing advice (the HEVC extension, or H.264 on the NVR)', [plain, room, failed].every((t) => t.text.includes('HEVC Video Extensions') && t.text.includes('sub-stream to H.264 on the NVR')))
  check('... and the plain message is the one tiles have always shown', plain.status === 'H.265 — set sub-stream to H.264' && plain.text === 'This camera sends H.265, which this browser cannot play. On Windows, Chrome and Edge need the "HEVC Video Extensions" from the Microsoft Store — installing it usually fixes this. Otherwise set the camera’s sub-stream to H.264 on the NVR.')
  check('the converted mark\'s title says what it is and how to be rid of it', /converting it to H\.264/.test(CONVERTED_TITLE) && /sub-stream to H\.264 on the NVR removes the need/.test(CONVERTED_TITLE))
}

// ---- a tile
let now = 1_000_000
const mk = (ch, type = SUB_STREAM, opts = {}) => {
  const tileEl = mkTileEl()
  const t = new LiveTile(tileEl, { nvr: 'n1', ch }, type, 0, { now: () => now, ...opts })
  clearTimeout(t.retry)
  t.player.push = () => {} // no decoding here
  t.connect()
  const ws = sockets.at(-1)
  ws.readyState = 1
  return { t, tileEl, ws, status: tileEl.parts['.status'] }
}
const frame = (ws) => { const b = new Uint8Array(40); b[0] = 1; ws.onmessage({ data: b.buffer }) }

const a = mk(1)
check('a browser whose check says yes tells the server so: h265=1', /[?&]h265=1(&|$)/.test(a.ws.url), a.ws.url)
frame(a.ws)
// the decoder refuses a real H.265 keyframe (what player.js calls when no config is supported)
let n = sockets.length
a.t.player.onUnsupported(1)
check('the decoder refuses an H.265 keyframe on a sub-stream: no message, the tile stays', !a.t.closed && a.tileEl.appended.length === 0 && !/H\.265/.test(a.status.textContent), a.status.textContent)
check('... its socket is dropped at once', a.ws.closed && sockets.length === n)
await sleep(5)
const a2 = sockets.at(-1)
check('... and it connects again asking for H.264: h265=0', sockets.length === n + 1 && /[?&]h265=0(&|$)/.test(a2.url) && a.t.ws === a2, a2.url)
check('... without a back-off (no "reconnecting…")', /connecting/.test(a.status.textContent) && !/reconnecting/.test(a.status.textContent), a.status.textContent)
const b = mk(2)
check('remembered for the page: a later tile asks for H.264 the first time', /[?&]h265=0(&|$)/.test(b.ws.url), b.ws.url)

// the server's note: this camera is converted
a2.readyState = 1
check('not marked as converted until the server says so', a.t.converted === false)
a2.onmessage({ data: '{"op":"convert","on":true}' })
check('the server says it is converted: the tile is marked', a.t.converted === true)
frame(a2)
a.t.player.onFrame(1) // a picture on screen
check('... and plays', a.t.h264Asks === 0 && !a.t.closed)
// with a page: the mark is a small badge beside the name, like the SD badge
{
  const made = []
  globalThis.document = { createElement: () => { const e = el(); made.push(e); return e } }
  a2.onmessage({ data: '{"op":"convert","on":false}' })
  a2.onmessage({ data: '{"op":"convert","on":true}' })
  const badge = a.tileEl.parts['.label'].kids?.at(-1)
  check('the mark: a badge in the tile\'s label, in the SD badge\'s style, with its title', made.length === 1 && badge === made[0] && /\bsd-badge\b/.test(badge.className) && /\bconv-badge\b/.test(badge.className) && badge.textContent === 'CONV' && badge.title === CONVERTED_TITLE, JSON.stringify(badge && { c: badge.className, t: badge.textContent }))
  a2.onmessage({ data: '{"op":"convert","on":true}' })
  check('... once, however often it is said', made.length === 1)
  a2.onmessage({ data: '{"op":"convert","on":false}' })
  check('... taken away when it is no longer converted', badge.removed === true && a.t.converted === false)
  delete globalThis.document
}
a2.onmessage({ data: '{"op":"convert","on":true}' })
n = sockets.length
a2.onclose({ code: 1006, reason: '' }) // the connection drops
clearTimeout(a.t.retry)
a.t.connect()
check('a new connection starts unmarked (the server says it again if it still converts)', a.t.converted === false && sockets.length === n + 1 && /[?&]h265=0(&|$)/.test(sockets.at(-1).url))

// the server cannot convert it: no room
{
  const ws = sockets.at(-1)
  ws.readyState = 1
  n = sockets.length
  ws.readyState = 3
  ws.onclose({ code: 1013, reason: H264_NO_ROOM })
  check('closed for want of room: the tile says so, plainly, and stays', a.status.textContent === 'H.265 — server busy' && /no room to convert another H\.265 camera right now/.test(a.t.convMsg?.textContent ?? '') && !a.t.closed, `${a.status.textContent} / ${a.t.convMsg?.textContent}`)
  check('... not "reconnecting…", and no socket opened at once', sockets.length === n && Boolean(a.t.retry))
  check('... it asks again by itself, about every 30 s', H264_RETRY_MS === 30_000)
  clearTimeout(a.t.retry)
  now += 20_000
  a.t.updateStatus()
  check('... the watchdog leaves it alone meanwhile', sockets.length === n && a.status.textContent === 'H.265 — server busy')
  a.t.connect() // (what its timer does)
  const again = sockets.at(-1)
  again.readyState = 1
  again.onmessage({ data: '{"op":"convert","on":true}' })
  frame(again)
  a.t.player.onFrame(2)
  check('... and when a picture comes the message goes', a.t.convMsg === null && a.t.converted === true && sockets.length === n + 1)
  again.readyState = 3
  again.onclose({ code: 1013, reason: H264_FAILED })
  check('closed because the conversion failed: said too', a.status.textContent === 'H.265 — not converted' && /could not convert it/.test(a.t.convMsg?.textContent ?? ''))
  clearTimeout(a.t.retry)
  // hidden under the full-size view meanwhile: its timer must not connect it
  a.t.release()
  check('released while it waits: no timer left to connect it behind the full-size view', a.t.retry === null && a.t.released)
  a.t.resume()
  check('... resume connects it again', sockets.length === n + 2 && /[?&]h265=0(&|$)/.test(sockets.at(-1).url))
}

// H.265 comes all the same (a server that does not convert): the message, as before
{
  const c = mk(3)
  n = sockets.length
  for (let i = 0; i < H264_ASKS; i++) {
    c.t.player.onUnsupported(1)
    await sleep(5)
    sockets.at(-1).readyState = 1
  }
  check(`asked ${H264_ASKS} times in a row (once for a server that had not seen the camera's codec yet)`, sockets.length === n + H264_ASKS && !c.t.closed && c.tileEl.appended.length === 0)
  globalThis.document = { createElement: () => el() }
  c.t.player.onUnsupported(1)
  delete globalThis.document
  await sleep(5)
  check('... H.265 again: the tile gives up and shows the message it always showed, for good', c.t.closed && c.status.textContent === 'H.265 — set sub-stream to H.264' && c.tileEl.appended.length === 1 && c.tileEl.appended[0].textContent === h265Text().text && sockets.length === n + H264_ASKS && sockets.at(-1).closed)
  // a picture in between starts the count again
  const d = mk(4)
  d.t.player.onUnsupported(1)
  await sleep(5)
  d.t.player.onUnsupported(1)
  await sleep(5)
  d.t.player.onFrame(5)
  n = sockets.length
  d.t.player.onUnsupported(1)
  await sleep(5)
  check('a picture shown in between starts the count again (a camera switched to H.265 hours later)', !d.t.closed && sockets.length === n + 1)
  d.t.close()
}

// other codecs and the main stream: as before
{
  const e = mk(5)
  globalThis.document = { createElement: () => el() }
  n = sockets.length
  e.t.player.onUnsupported(7)
  delete globalThis.document
  check('a codec that is not H.265 at all: the old message at once, nothing asked again', e.t.closed && e.status.textContent === 'unsupported codec' && e.tileEl.appended[0]?.textContent === 'This browser cannot play this camera’s video format.' && sockets.length === n)
  const m = mk(6, MAIN_STREAM)
  n = sockets.length
  m.t.player.onUnsupported(1)
  check('an H.265 main stream: the tile goes over to the sub-stream, as before (mains are not converted)', m.t.streamType === SUB_STREAM && m.ws.closed && m.t.h264Asks === 0 && !m.t.closed)
  clearTimeout(m.t.retry)
  m.t.connect()
  check('... which it asks for as H.264', /stream=1(&|$)/.test(sockets.at(-1).url) && /[?&]h265=0(&|$)/.test(sockets.at(-1).url), sockets.at(-1).url)
  m.t.close()
  // a caller's own handling of a main (viewer.js: the full-size layer) is still the caller's
  let told = null
  const own = mk(7, MAIN_STREAM, { onUnsupported: (c) => (told = c) })
  own.t.player.onUnsupported(1)
  check('a caller\'s own handler for a main stream is still called', told === 1 && own.t.streamType === MAIN_STREAM)
  own.t.close()
}

// a tile borrowing another tile's stream takes its mark with it
{
  const src = mk(8)
  src.ws.onopen?.()
  src.ws.onmessage({ data: '{"op":"convert","on":true}' })
  frame(src.ws)
  const tileEl = mkTileEl()
  n = sockets.length
  const view = new LiveTile(tileEl, { nvr: 'n1', ch: 8 }, SUB_STREAM, 0, { now: () => now, borrowFrom: src.t })
  check('the full-size view borrowing a converted tile\'s stream is marked as converted too', view.source === src.t && view.converted === true && sockets.length === n)
  view.close()
  src.t.close()
}
a.t.close()
b.t.close()

// ---- forced from the address: a fresh copy of the module on a page opened with ?h265=0
{
  globalThis.location = { protocol: 'http:', host: 'x', search: '?h265=0' }
  const forced = await import('../public/live-tile.js?forced')
  await sleep(5)
  const tileEl = mkTileEl()
  const t = new forced.LiveTile(tileEl, { nvr: 'n1', ch: 9 }, SUB_STREAM, 0, { now: () => now })
  clearTimeout(t.retry)
  t.connect()
  check('?h265=0 on the page: a browser that plays H.265 asks for H.264 all the same', /[?&]h265=0(&|$)/.test(sockets.at(-1).url), sockets.at(-1).url)
  t.close()
  globalThis.location = { protocol: 'http:', host: 'x', search: '?h265=1' }
  check('?h265=1 forces nothing', forced.h265Forced(location.search) === false)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
