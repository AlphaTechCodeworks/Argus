// Who is signed in and what they are watching, for admins (Health: "Who is watching"). presence.mjs
// keeps it; this is how the server learns what a socket has open, and the route that answers.
//
// Every live, playback and motion socket (and each /live-mux channel) is handed to the access watch
// when it is let in (access-watch.mjs track), with the request that opened it and the rights it
// needs, and leaves it by closing. That one call is where presence is told as well (noteOpen, hooked
// in server.mjs), so nothing here reaches into how a stream is attached: what is open is read off the
// path of the request and the rights asked, and what a live stream is being sent is worked out from
// what the request said (liveKind) -- which is what it qualifies for, not a report from the
// conversion itself. Where that cannot be told it says 'unknown'.
//
// Pure (no SDK, no server, no sockets of its own): tested in test/viewers.test.mjs.

const NO_STORE = { 'cache-control': 'no-store' }
export const VIEWERS_PATH = '/api/admin/viewers'

/**
 * What a live stream is being sent, as far as the request says:
 *  'remote'  a viewer over the internet: the rate its link carries, converted where needed (adaptive-live.mjs)
 *  'phone'   a phone that asked for 15 fps: the thinned stream phones share, where there is room (phone-live.mjs)
 *  'h264'    a PC that said its browser cannot play H.265, on an H.265 sub-stream: the server's H.264
 *            conversion (h264-fallback.mjs; a conversion refused closes the stream, so one still open has it)
 *  'own'     the camera's own stream
 *  'unknown' a PC without H.265 on a sub-stream whose codec the NVR has not been seen to send yet
 * In live-attach.mjs's order: remote first, then the phone, then the PC without H.265.
 * @param {{ remote?: boolean, phone?: boolean, noH265?: boolean, stream?: 'sub'|'main', codec?: string|null, h264On?: boolean }} o
 */
export function liveKind({ remote = false, phone = false, noH265 = false, stream = 'sub', codec = null, h264On = false } = {}) {
  if (remote) return 'remote'
  if (phone) return 'phone'
  if (noH265 && stream === 'sub' && h264On) return codec === 'h265' ? 'h264' : codec ? 'own' : 'unknown'
  return 'own'
}

/**
 * What a tracked socket or channel is, from the path of the request that opened it and the rights it
 * was let in with (access-watch.mjs's `actions`): null for anything that is not somebody watching.
 *  /live, /live-mux: Live HD among its needs is the main stream, without it the sub-stream
 *  /playback: 'playback-server' among them is the server's own recordings (also when their gaps are
 *    filled from the NVR, which needs both); only 'playback-nvr', the NVR's
 *  /motion: a motion search on the NVR
 * @param {string} pathname
 * @param {Array<string|string[]>} actions
 * @returns {{ type: 'live', stream: 'sub'|'main' }|{ type: 'playback', source: 'nvr'|'server'|'unknown' }|{ type: 'motion' }|null}
 */
export function openOf(pathname, actions) {
  const needs = Array.isArray(actions) ? actions : []
  if (pathname === '/live' || pathname === '/live-mux') return { type: 'live', stream: needs.includes('live-hd') ? 'main' : 'sub' }
  if (pathname === '/playback') return { type: 'playback', source: needs.includes('playback-server') ? 'server' : needs.includes('playback-nvr') ? 'nvr' : 'unknown' }
  if (pathname === '/motion') return { type: 'motion' }
  return null
}

/**
 * GET /api/admin/viewers: { now, viewers: [{ user, address, remote, since, live, playback, other,
 * counts }], total, people } (presence.mjs list and summary). Admins only, as every /api/admin
 * route; never cached: it is who is watching at this moment. Nothing of anyone's session is in it.
 * @param {string} method
 * @param {string} pathname
 * @param {{ user: string, admin: boolean }|null} who
 * @param {{ list: Function, summary: Function }} presence
 * @param {{ now?: () => number, nameOf?: Function }} [o] nameOf: presence.mjs list's
 * @returns {[number, object, object]|null} null: not this route
 */
export function handleViewers(method, pathname, who, presence, { now = Date.now, nameOf } = {}) {
  if (pathname !== VIEWERS_PATH) return null
  if (who?.admin !== true) return [403, { error: 'Admins only' }, NO_STORE]
  if (method !== 'GET') return [405, { error: 'Method not allowed' }, { ...NO_STORE, allow: 'GET' }]
  const { viewers, total } = presence.list({ nameOf })
  return [200, { now: now(), viewers, total, people: presence.summary() }, NO_STORE]
}

/**
 * The access watch's track, telling presence on the way what the socket or channel has open.
 * @param {{ track: Function, presence: { open: Function }, keyOf: (req: object) => string,
 *   describe: (handle: object, req: object, open: object, nvr: string, ch: number) => object }} o
 *   keyOf: the viewer's key (viewerOf); describe: what to add to a live stream's entry (its kind)
 * @returns {(ws: object, req: object, what: { actions: Array, nvr: string, ch: number }) => Function} track
 */
export function trackingOpen({ track, presence, keyOf, describe = () => ({}) }) {
  return (ws, req, what) => {
    try {
      // Only a real socket or mux channel (it sends): the handle that stands for a sub-stream's
      // stand-in (live-attach.mjs standInHandle) is the same tile again, already noted as its sub.
      // And only one still open, as the watch itself takes it: one closed already has had its
      // 'close', and would be listed until the page went.
      const isOpen = ws.readyState === undefined || ws.readyState === 1
      const open = typeof ws.send === 'function' && isOpen ? openOf(new URL(req.url ?? '/', 'http://localhost').pathname, what.actions) : null
      if (open) {
        const more = open.type === 'live' ? describe(ws, req, open, what.nvr, what.ch) : {}
        ws.on('close', presence.open(keyOf(req), ws, { ...open, ...more, nvr: what.nvr, ch: what.ch }))
      }
    } catch {} // the list is a convenience: it must never stop a stream being watched for its rights
    return track(ws, req, what)
  }
}
