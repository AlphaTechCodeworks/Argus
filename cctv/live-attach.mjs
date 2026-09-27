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
    // a sub-stream that is not running yet (cold, or refused by the NVR): the camera's main stream
    // meanwhile, until the sub-stream's own first frame (sub-bridge.mjs)
    if (streamType === 1 && !(stream.gop?.length > 0)) {
      bridgeSub(ws, { sub: stream, main: nvr.getStream(ch, 0), clientH265 })
    }
    // a remote viewer (through Tailscale): the frame rate its link and the uplink can carry. One key
    // per browser, from the upgrade request: a page's /live and /live-mux sockets are one viewer.
    if (isRemoteAddress(req.socket.remoteAddress)) {
      const viewer = `${currentUser(req) ?? '?'}|${req.headers['user-agent'] ?? ''}|${req.headers.cookie ?? ''}`
      adaptiveLive.attach(createHash('sha1').update(viewer).digest('hex'), { ws, nvrId: nvr.id, ch, type: streamType, source: stream, clientH265 })
      return
    }
    // a phone asking for 15 fps gets the shared thinned stream (phone-live.mjs), when there is room
    if (phone15 && isPhoneRequest(req.headers) && phoneLive.attach(`${nvr.id}/${ch}/${streamType}`, stream, streamType, ws)) return
    stream.add(ws)
    ws.on('close', () => stream.remove(ws))
  }
}
