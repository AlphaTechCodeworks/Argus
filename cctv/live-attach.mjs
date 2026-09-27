// One viewer's live video: a /live socket, or one channel of a page's /live-mux socket (live-mux.mjs),
// which behaves as a socket of its own. The rights first, then the NVR, then the channel; then the
// path its frames take: the main stream as a stand-in for a cold sub-stream (sub-bridge.mjs), the
// frame rate a remote viewer's link can carry (adaptive-live.mjs), the shared thinned stream for a
// phone asking for 15 fps (phone-live.mjs), or else the camera's stream itself. A refusal closes it
// with the code a /live socket has always had; on a channel that is an "end" message, and the page's
// other tiles carry on.
//
// Out of server.mjs so the tests can drive every refusal and path (importing server.mjs starts the
// NVRs); server.mjs hands in what it owns.
import { createHash } from 'node:crypto'
import { isRemoteAddress } from './adaptive-live.mjs'
import { isPhoneRequest } from './phone-live.mjs'
import { bridgeSub } from './sub-bridge.mjs'

// Conversions a phone's stand-in leaves free, for full-size views (phone-live.mjs caps them at 16)
export const PHONE_SPARE = 4

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
  return { gop: main.gop, add: (tap) => phoneLive.attach(key, main, 0, tap, { background: true }), remove: (tap) => phoneLive.detach(key, tap) }
}

/**
 * @param {{ can: Function, currentUser: (req: object) => string|null,
 *   adaptiveLive: { attach: Function }, phoneLive: { attach: Function } }} o
 *   can: rights.mjs can; currentUser: the request's signed-in user
 * @returns {(ws: object, req: object, o: { nvr: object, who: object, ch: number, streamType: number,
 *   clientH265: boolean, phone15: boolean }) => void} attachLive
 */
export function liveAttacher({ can, currentUser, adaptiveLive, phoneLive }) {
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
    const stream = nvr.getStream(ch, streamType)
    const remote = isRemoteAddress(req.socket.remoteAddress)
    const phone = !remote && phone15 && isPhoneRequest(req.headers)
    // held back at the NVR's sub-stream limit (nvrs.mjs subHeld): no picture of its own until there
    // is room. A tile's first request is not in the worker's list yet: with the NVR at its limit, a
    // sub-stream not running yet will be held (subFull)
    const held = streamType === 1 && (nvr.subHeld?.(ch) === true || (!(stream.gop?.length > 0) && nvr.subFull?.() === true))
    // a sub-stream that is not running yet (cold, refused by the NVR, or held at its limit): the
    // camera's main stream meanwhile, until the sub-stream's own first frame (sub-bridge.mjs)
    if (streamType === 1 && !(stream.gop?.length > 0)) {
      const main = nvr.getStream(ch, 0)
      const log = held ? (line) => console.log(`[${nvr.id}/${ch + 1}] sub-stream held at the NVR's limit: ${line}`) : undefined
      bridgeSub(ws, { sub: stream, main: standIn(nvr, ch, main, { phone, held, clientH265, phoneLive }), clientH265, log })
    }
    // a remote viewer (through Tailscale): the frame rate its link and the uplink can carry. One key
    // per browser, from the upgrade request: a page's /live and /live-mux sockets are one viewer.
    if (remote) {
      const viewer = `${currentUser(req) ?? '?'}|${req.headers['user-agent'] ?? ''}|${req.headers.cookie ?? ''}`
      adaptiveLive.attach(createHash('sha1').update(viewer).digest('hex'), { ws, nvrId: nvr.id, ch, type: streamType, source: stream, clientH265 })
      return
    }
    // a phone asking for 15 fps gets the shared thinned stream (phone-live.mjs), when there is room.
    // Not a held sub-stream: it has nothing to thin until there is room (small then: sent as it is),
    // and a conversion place held open for it is one its stand-in may need -- unless it is H.265,
    // which a phone may not play as it is (a sub tile that cannot decode its stream closes for good)
    const subH265 = nvr.codecSeen?.get?.(`${ch}:1`)?.codec === 'h265'
    if (phone && (!held || subH265) && phoneLive.attach(`${nvr.id}/${ch}/${streamType}`, stream, streamType, ws)) return
    stream.add(ws)
    ws.on('close', () => stream.remove(ws))
  }
}
