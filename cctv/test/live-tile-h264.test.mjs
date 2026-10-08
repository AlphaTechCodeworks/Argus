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

const { CONVERTED_MAIN_TITLE, CONVERTED_TITLE, H264_ASKS, H264_FAILED, H264_NO_ROOM, H264_NO_ROOM_MAIN, H264_RETRY_MS, LiveTile, MAIN_STREAM, SUB_STREAM, h265Answer, h265Forced, h265Text, mainNotConvertedTitle } = await import('../public/live-tile.js')
const { FAILED, NO_ROOM, NO_ROOM_MAIN } = await import('../h264-fallback.mjs')
await sleep(5) // the page's check has answered: this browser says it plays H.265

// ---- the pure parts
check('?h265=0 on the address forces "cannot play H.265"', h265Forced('?h265=0') && h265Forced('?stats=1&h265=0'))
check('... a downgrade only: ?h265=1, anything else, or nothing claims nothing', !h265Forced('?h265=1') && !h265Forced('?h265=') && !h265Forced('?h265=00') && !h265Forced('?h265=false') && !h265Forced('') && !h265Forced(undefined) && !h265Forced(null))
check('what a stream is opened with: the check\'s answer, both ways', h265Answer({ device: true }) === true && h265Answer({ device: false }) === false)
check('... not known yet: nothing said (null), which the server does not read as "cannot"', h265Answer({ device: null }) === null && h265Answer({ device: undefined }) === null)
check('... forced, or learnt from a keyframe the decoder refused: "cannot", whatever the check said', h265Answer({ device: true, forced: true }) === false && h265Answer({ device: true, learned: true }) === false && h265Answer({ device: null, learned: true }) === false && h265Answer({ device: null, forced: true }) === false)
check('... never "can" for a browser whose check said no', h265Answer({ device: false, forced: false, learned: false }) === false)
check('the reasons are the server\'s, letter for letter', H264_NO_ROOM === NO_ROOM && H264_FAILED === FAILED && H264_NO_ROOM_MAIN === NO_ROOM_MAIN)
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
  // a main stream asks again for H.264 as a sub-stream does (the server converts it for the full-size view)
  const m = mk(6, MAIN_STREAM)
  n = sockets.length
  m.t.player.onUnsupported(1)
  await sleep(5)
  check('an H.265 main stream the decoder refuses: the tile stays on the main stream and asks again for H.264', m.t.streamType === MAIN_STREAM && m.ws.closed && m.t.h264Asks === 1 && !m.t.closed && sockets.length === n + 1 && /stream=0(&|$)/.test(sockets.at(-1).url) && /[?&]h265=0(&|$)/.test(sockets.at(-1).url), sockets.at(-1).url)
  sockets.at(-1).readyState = 1
  m.t.player.onUnsupported(1)
  await sleep(5)
  sockets.at(-1).readyState = 1
  check(`... ${H264_ASKS} times at most`, sockets.length === n + H264_ASKS && m.t.streamType === MAIN_STREAM)
  const last = sockets.at(-1)
  m.t.player.onUnsupported(1)
  check('... H.265 all the same (a server that does not convert mains): over to the sub-stream, as before', m.t.streamType === SUB_STREAM && last.closed && !m.t.closed)
  clearTimeout(m.t.retry)
  m.t.connect()
  check('... which it asks for as H.264', /stream=1(&|$)/.test(sockets.at(-1).url) && /[?&]h265=0(&|$)/.test(sockets.at(-1).url), sockets.at(-1).url)
  m.t.close()
  // a caller's own handling of a main (viewer.js: the full-size layer) is still the caller's
  let told = null
  const own = mk(7, MAIN_STREAM, { onUnsupported: (c) => (told = c) })
  for (let i = 0; i < H264_ASKS; i++) {
    own.t.player.onUnsupported(1)
    await sleep(5)
    sockets.at(-1).readyState = 1
  }
  check('a caller\'s own handler for a main stream is not called while the tile still asks for H.264', told === null && own.t.streamType === MAIN_STREAM)
  own.t.player.onUnsupported(1)
  check('... and is called when H.265 still comes', told === 1 && own.t.streamType === MAIN_STREAM)
  own.t.close()
  let other = null
  const own2 = mk(7, MAIN_STREAM, { onUnsupported: (c) => (other = c) })
  n = sockets.length
  own2.t.player.onUnsupported(7)
  check('... at once for a codec that is not H.265', other === 7 && sockets.length === n)
  own2.t.close()
}

// the server did not convert a main stream: the full-size view stays on its sub-stream, quietly
{
  check('the mark\'s title for a view left on the sub-stream: no room among the mains, or a failed conversion; both say it tries again', /already converting as many full-quality pictures as it is allowed/.test(mainNotConvertedTitle(H264_NO_ROOM_MAIN)) && /could not convert its full-quality picture/.test(mainNotConvertedTitle(H264_FAILED)) && [H264_NO_ROOM_MAIN, H264_FAILED].every((w) => /standard picture meanwhile/.test(mainNotConvertedTitle(w)) && /again by itself/.test(mainNotConvertedTitle(w))))
  // the caller handles it (viewer.js: the layer goes, the sub-stream under it stays)
  for (const why of [H264_NO_ROOM_MAIN, H264_FAILED]) {
    let said = null
    const v = mk(10, MAIN_STREAM, { onMainNotConverted: (w) => { said = w; return true } })
    n = sockets.length
    const timer = v.t.retry
    v.ws.readyState = 3
    v.ws.onclose({ code: 1013, reason: why })
    check(`a main closed with "${why}": the caller is told why`, said === why)
    check('... no message over the picture, no "server busy", no reconnect of its own', v.t.convMsg === null && v.tileEl.appended.length === 0 && !/H\.265|reconnecting/.test(v.status.textContent) && sockets.length === n && v.t.retry === timer, v.status.textContent)
    v.t.close()
  }
  // nobody handles it (the map, the camera editor): the tile goes over to the sub-stream itself
  const lone = mk(11, MAIN_STREAM)
  n = sockets.length
  lone.ws.readyState = 3
  lone.ws.onclose({ code: 1013, reason: H264_NO_ROOM_MAIN })
  check('nobody to handle it: the tile goes over to the sub-stream at once, asked for as H.264, with no message', lone.t.streamType === SUB_STREAM && sockets.length === n + 1 && /stream=1(&|$)/.test(sockets.at(-1).url) && /[?&]h265=0(&|$)/.test(sockets.at(-1).url) && lone.t.convMsg === null && lone.tileEl.appended.length === 0, sockets.at(-1).url)
  lone.t.close()
  // a handler that declines (viewer.js: the layer is already what is on screen): the same
  const shown = mk(12, MAIN_STREAM, { onMainNotConverted: () => false })
  n = sockets.length
  shown.ws.readyState = 3
  shown.ws.onclose({ code: 1013, reason: H264_FAILED })
  check('a caller that declines: the tile goes over to the sub-stream itself', shown.t.streamType === SUB_STREAM && sockets.length === n + 1 && /stream=1(&|$)/.test(sockets.at(-1).url))
  shown.t.close()
  // a sub-stream tile is as it was: the failed reason is a message there, and the mains' reason means nothing to it
  const s = mk(13)
  s.ws.readyState = 3
  s.ws.onclose({ code: 1013, reason: H264_FAILED })
  check('a sub-stream closed with "conversion failed" still says so on the tile', s.status.textContent === 'H.265 — not converted' && s.t.streamType === SUB_STREAM)
  s.t.close()
  // an ordinary close of a main is an ordinary reconnect
  let asked = 0
  const plain = mk(14, MAIN_STREAM, { onMainNotConverted: () => { asked++; return true } })
  plain.ws.readyState = 3
  plain.ws.onclose({ code: 1011, reason: 'stream ended' })
  check('any other close of a main: reconnecting with the back-off, as before', asked === 0 && plain.status.textContent === 'reconnecting…' && Boolean(plain.t.retry))
  plain.t.close()
  // the converted main carries the mark, with a title of its own
  const made = []
  globalThis.document = { createElement: () => { const e = el(); made.push(e); return e } }
  const conv = mk(15, MAIN_STREAM)
  conv.ws.onmessage({ data: '{"op":"convert","on":true}' })
  const badge = conv.tileEl.parts['.label'].kids?.at(-1)
  check('a converted main stream carries the CONV badge like a converted sub-stream, its title saying it is the full-quality picture at up to 1920 wide', conv.t.converted === true && badge?.textContent === 'CONV' && /\bconv-badge\b/.test(badge.className) && badge.title === CONVERTED_MAIN_TITLE && /1920 pixels wide/.test(CONVERTED_MAIN_TITLE) && CONVERTED_MAIN_TITLE !== CONVERTED_TITLE)
  delete globalThis.document
  conv.t.close()
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
