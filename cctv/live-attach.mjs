// One viewer's live video: a /live socket, or one channel of a page's /live-mux socket (live-mux.mjs),
// which behaves as a socket of its own. The rights first, then the NVR, then the channel; then the
// path its frames take: the main stream as a stand-in for a cold sub-stream (sub-bridge.mjs), the
// frame rate a remote viewer's link can carry (adaptive-live.mjs), the shared thinned stream for a
// phone asking for 15 fps (phone-live.mjs), or else the camera's stream itself. A refusal closes it
// with the code a /live socket has always had; on a channel that is an "end" message, and the page's
// other tiles carry on. One that is let in is tracked (access-watch.mjs) for as long as it is open, so
// losing the live right to that camera, the account or the session ends it too.
//
// Out of server.mjs so the tests can drive every refusal and path (importing server.mjs starts the
// NVRs); server.mjs hands in what it owns.
import { createHash } from 'node:crypto'
import { isRemoteAddress } from './adaptive-live.mjs'
import { isPhoneRequest } from './phone-live.mjs'
import { bridgeSub } from './sub-bridge.mjs'

// Conversions a phone's stand-in leaves free, for full-size views (phone-live.mjs caps them at 16)
export const PHONE_SPARE = 4
// An H.265 main standing in for a browser without H.265 sends nothing and ends at once, and the tile,
// with no picture, asks again every 8-16 s: 14-16 held tiles on value4u were about 2 lines a second
// for as long as the owner's page was open (review of 29 Sep). Its line is said once in this long for
// the same camera and viewer, with how many were left out.
export const H265_QUIET_MS = 10 * 60_000

/** One key per browser, from the upgrade request: a page's /live and /live-mux sockets are one viewer. */
const viewerOf = (req, currentUser) => createHash('sha1').update(`${currentUser(req) ?? '?'}|${req.headers['user-agent'] ?? ''}|${req.headers.cookie ?? ''}`).digest('hex')

/**
 * What stands in for a sub-stream that is not running (sub-bridge.mjs): the camera's main stream,
 * or, for a phone that cannot play the H.265 it is, that main as converted for phones (the tile
 * would get nothing: 09-27, value4u's tiles held at its sub-stream limit stayed dark on a phone
 * while full screen, the same main converted, played). Only for a sub-stream held at the NVR's
 * limit, which may wait minutes: a cold one comes in about 2 s, less than a conversion takes to
 * start, and a phone scrolling a list would start one per tile. Only onto a main that already
 * plays, and only while the conversions leave PHONE_SPARE free. Its conversion is its own, and asks
 * for the main in the background, as the plain stand-in does: the NVR worker joins a main that
 * plays for it and never starts or keeps one for it (nvr-worker.mjs bridgeOnly). (A full-size
 * phone view of the same camera has the foreground one: two conversions in that rare case.)
 */
function standIn(nvr, ch, main, { phone, held, clientH265, phoneLive }) {
  const h265 = nvr.codecSeen?.get?.(`${ch}:0`)?.codec === 'h265'
  if (!phone || !held || clientH265 || !h265 || !nvr.mainPlaying?.(ch)) return main
  const key = `${nvr.id}/${ch}/0/standin`
  if (!phoneLive.has?.(key) && !(phoneLive.room?.() >= PHONE_SPARE)) return main
  return { gop: main.gop, add: (tap) => phoneLive.attach(key, main, 0, tap, { background: true, camera: `${nvr.id}/${ch + 1}` }), remove: (tap) => phoneLive.detach(key, tap) }
}

/**
 * @param {{ can: Function, currentUser: (req: object) => string|null,
 *   adaptiveLive: { attach: Function }, phoneLive: { attach: Function }, track?: Function,
 *   log?: (line: string) => void, now?: () => number }} o
 *   can: rights.mjs can; currentUser: the request's signed-in user; track: access-watch.mjs's, which
 *   asks the live right again while the socket or channel is open; log: the stand-ins' lines; now:
 *   the clock (tests)
 * @returns {(ws: object, req: object, o: { nvr: object, who: object, ch: number, streamType: number,
 *   clientH265: boolean, phone15: boolean }) => void} attachLive
 */
export function liveAttacher({ can, currentUser, adaptiveLive, phoneLive, track = () => {}, log = (line) => console.log(line), now = Date.now }) {
  const quiet = new Map() // camera and viewer -> { at, left }: its H.265 stand-in line last said, and those left out since
  /** The H.265 stand-in line for a camera and viewer, or null when it was said less than H265_QUIET_MS ago. */
  const h265Line = (line, key) => {
    const t = now()
    const q = quiet.get(key)
    if (q && t - q.at < H265_QUIET_MS) {
      q.left++
      return null
    }
    for (const [k, v] of quiet) if (t - v.at >= H265_QUIET_MS) quiet.delete(k) // (past their quiet: of no more use)
    quiet.set(key, { at: t, left: 0 })
    return `${line}; said once in ${H265_QUIET_MS / 60_000} min for this camera and viewer${q?.left ? `, ${q.left} left out since the last` : ''}`
  }
  return function attachLive(ws, req, { nvr, who, ch, streamType, clientH265, phone15 }) {
    if (!can(who, 'live', { nvr: nvr.id, ch })) return ws.close(1008, 'not allowed')
    // live video: with a live worker, the worker's own login decides (it polls the camera list)
    if (!nvr.liveOnline) {
      ws.close(1013, 'NVR offline')
      return
    }
    if (!Number.isInteger(ch) || ch < 0 || ![0, 1].includes(streamType)) {
      ws.close(1008, 'bad channel or stream')
      return
    }
    // let in: the same question again for as long as it is open, from the session as it is then.
    // Every path below (sub-bridge, adaptive, phone, the stream itself) ends with this socket or
    // channel closing, which is how it leaves the watch.
    track(ws, req, { actions: ['live'], nvr: nvr.id, ch })
    const stream = nvr.getStream(ch, streamType)
    const remote = isRemoteAddress(req.socket.remoteAddress)
    const phone = !remote && phone15 && isPhoneRequest(req.headers)
    // held back at the NVR's sub-stream limit (nvrs.mjs subHeld): no picture of its own until there
    // is room. A tile's first request is not in the worker's list yet: with the NVR at its limit, a
    // sub-stream not running yet will be held (subFull)
    const held = streamType === 1 && (nvr.subHeld?.(ch) === true || (!(stream.gop?.length > 0) && nvr.subFull?.() === true))
    // a sub-stream that is not running yet (cold, refused by the NVR, or held at its limit): the
    // camera's main stream meanwhile, until the sub-stream's own first frame (sub-bridge.mjs). Its
    // start and end are logged with the camera and whether the viewer is remote: on 29 Sep a remote
    // page's stand-ins could only be guessed from the code (stutter report 2.6, verify-6). The H.265
    // one that sends nothing, once in H265_QUIET_MS for the camera and viewer.
    if (streamType === 1 && !(stream.gop?.length > 0)) {
      const main = nvr.getStream(ch, 0)
      const stand = standIn(nvr, ch, main, { phone, held, clientH265, phoneLive })
      const tag = `[sub-bridge] ${nvr.id}/${ch + 1}, ${remote ? 'remote' : 'local'} viewer${held ? ", sub-stream held at the NVR's limit" : ''}${stand !== main ? ', main converted for a phone' : ''}:`
      const say = (line, why) => {
        const text = why === 'h265' ? h265Line(line, `${nvr.id}/${ch}|${viewerOf(req, currentUser)}`) : line
        if (text) log(`${tag} ${text}`)
      }
      bridgeSub(ws, { sub: stream, main: stand, clientH265, log: say })
    }
    // a remote viewer (through Tailscale): the frame rate its link and the uplink can carry, per
    // browser (viewerOf). With the codec the NVR saw on this stream: a main started on demand has no
    // keyframe yet, and its first one, H.265, must not go to a browser that cannot decode it
    // (adaptive-live.mjs #h265)
    if (remote) {
      const codec = nvr.codecSeen?.get?.(`${ch}:${streamType}`)?.codec
      adaptiveLive.attach(viewerOf(req, currentUser), { ws, nvrId: nvr.id, ch, type: streamType, source: stream, clientH265, codec })
      return
    }
    // a phone asking for 15 fps gets the shared thinned stream (phone-live.mjs), when there is room.
    // Not a held sub-stream: it has nothing to thin until there is room (small then: sent as it is),
    // and a conversion place held open for it is one its stand-in may need -- unless it is H.265,
    // which a phone may not play as it is (a sub tile that cannot decode its stream closes for good)
    const subH265 = nvr.codecSeen?.get?.(`${ch}:1`)?.codec === 'h265'
    if (phone && (!held || subH265) && phoneLive.attach(`${nvr.id}/${ch}/${streamType}`, stream, streamType, ws, { camera: `${nvr.id}/${ch + 1}` })) return
    stream.add(ws)
    ws.on('close', () => stream.remove(ws))
  }
}
