// One viewer's live video: a /live socket, or one channel of a page's /live-mux socket (live-mux.mjs),
// which behaves as a socket of its own. The rights first, then the NVR, then the channel; then the
// path its frames take: the main stream as a stand-in for a cold sub-stream (sub-bridge.mjs), the
// frame rate a remote viewer's link can carry (adaptive-live.mjs), the shared thinned stream for a
// phone asking for 15 fps (phone-live.mjs), an H.265 sub-stream converted to H.264 for a PC on the
// local network whose browser cannot play it (h264-fallback.mjs), or else the camera's stream itself. A refusal closes it
// with the code a /live socket has always had; on a channel that is an "end" message, and the page's
// other tiles carry on. One that is let in is tracked (access-watch.mjs) for as long as it is open, so
// losing the live right to that camera, the account or the session ends it too.
// Live HD (rights.mjs) decides every main-stream picture here: the main stream asked for directly
// (refused 1008 'hd not allowed' without it), and the main stream standing in for a sub-stream that
// has no picture yet (none without it: the viewer is told why it waits instead, live-wait.mjs).
//
// Out of server.mjs so the tests can drive every refusal and path (importing server.mjs starts the
// NVRs); server.mjs hands in what it owns.
import { createHash } from 'node:crypto'
import { isRemoteAddress } from './adaptive-live.mjs'
import { waitForSub } from './live-wait.mjs'
import { isPhoneRequest } from './phone-live.mjs'
import { HD_NOT_ALLOWED } from './stream-param.mjs'
import { bridgeSub } from './sub-bridge.mjs'
import { CODEC_H265 } from './transcode.mjs'

// Conversions a phone's stand-in leaves free, for full-size views (phone-live.mjs caps them at 16)
export const PHONE_SPARE = 4
// An H.265 main standing in for a browser without H.265 sends nothing and ends at once, and the tile,
// with no picture, asks again every 8-16 s: 14-16 held tiles on value4u were about 2 lines a second
// for as long as the owner's page was open (review of 29 Sep). Its line is said once in this long for
// the same camera and viewer, with how many were left out.
export const H265_QUIET_MS = 10 * 60_000

/** One key per browser, from the upgrade request: a page's /live and /live-mux sockets are one viewer. */
export const viewerOf = (req, currentUser) => createHash('sha1').update(`${currentUser(req) ?? '?'}|${req.headers['user-agent'] ?? ''}|${req.headers.cookie ?? ''}`).digest('hex')

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
 * The stand-in as the access watch sees it (access-watch.mjs): Live HD taken away ends the main
 * stream's pictures on this socket and nothing else; the viewer stays on its own sub-stream and, while
 * that has no picture yet, is told why it waits from then on (wait: live-wait.mjs; the bridge's send
 * passes straight through once it has ended). It leaves the watch when the socket closes.
 */
const standInHandle = (ws, bridge, wait) => ({
  readyState: 1,
  on: (event, fn) => ws.on?.(event, fn),
  close: () => {
    bridge.end('rights')
    wait()
  }
})

/**
 * @param {{ can: Function, currentUser: (req: object) => string|null, isAdmin?: (user: string) => boolean,
 *   adaptiveLive: { attach: Function }, phoneLive: { attach: Function }, h264Fallback?: { enabled: boolean, attach: Function }|null, track?: Function,
 *   waitTimers?: { every?: Function, clear?: Function, now?: () => number },
 *   log?: (line: string) => void, now?: () => number }} o
 *   can: rights.mjs can; currentUser: the request's signed-in user; isAdmin: the account's role now
 *   (without it, the `who` a socket was let in with, for the same user); track: access-watch.mjs's,
 *   which asks the rights again while the socket or channel is open; waitTimers: live-wait.mjs's timers
 *   (tests); log: the stand-ins' lines; now: the clock (tests); h264Fallback: the conversions for local
 *   PCs without H.265 (h264-fallback.mjs), none without it
 * @returns {(ws: object, req: object, o: { nvr: object, who: object, ch: number, streamType: number,
 *   clientH265: boolean, noH265?: boolean, phone15: boolean }) => void} attachLive
 *   clientH265: the page said its browser plays H.265 (h265=1); noH265: it said it does not (h265=0).
 *   Neither: it did not say (an older page, or one that does not know yet), which is not "cannot"
 */
export function liveAttacher({ can, currentUser, isAdmin = null, adaptiveLive, phoneLive, h264Fallback = null, track = () => {}, waitTimers = {}, log = (line) => console.log(line), now = Date.now }) {
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
  return function attachLive(ws, req, { nvr, who, ch, streamType, clientH265, noH265 = false, phone15 }) {
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
    // Live HD: the main stream is full quality -- and so is anything that is not the sub-stream. Its
    // own reason, so the page drops to the sub-stream instead of asking again.
    const hd = () => can(who, 'live-hd', { nvr: nvr.id, ch })
    if (streamType !== 1 && !hd()) return ws.close(1008, HD_NOT_ALLOWED)
    // let in: the same question again for as long as it is open, from the session as it is then.
    // Every path below (sub-bridge, adaptive, phone, the stream itself) ends with this socket or
    // channel closing, which is how it leaves the watch.
    track(ws, req, { actions: streamType === 1 ? ['live'] : ['live', 'live-hd'], nvr: nvr.id, ch })
    const stream = nvr.getStream(ch, streamType)
    const remote = isRemoteAddress(req.socket.remoteAddress)
    const phone = !remote && phone15 && isPhoneRequest(req.headers)
    // held back at the NVR's sub-stream limit (nvrs.mjs subHeld): no picture of its own until there
    // is room. A tile's first request is not in the worker's list yet: with the NVR at its limit, a
    // sub-stream not running yet will be held (subFull)
    const held = streamType === 1 && (nvr.subHeld?.(ch) === true || (!(stream.gop?.length > 0) && nvr.subFull?.() === true))
    // A sub-stream that is not running yet (cold, refused by the NVR, or held at its limit): the
    // camera's main stream meanwhile, until the sub-stream's own first frame (sub-bridge.mjs). Those
    // are main-stream pictures -- a full-resolution keyframe even for two seconds -- so only with
    // Live HD, and watched for it apart from the socket. Without it the main stream is not even asked
    // for (asking starts it), and the tile is told why it waits (live-wait.mjs): held when the NVR
    // holds this sub-stream back (or, for the first notice, is at its limit: the `held` above), counted
    // from now.
    // A stand-in's start and end are logged with the camera and whether the viewer is remote: on 29
    // Sep a remote page's stand-ins could only be guessed from the code (stutter report 2.6, verify-6).
    // The H.265 one that sends nothing, once in H265_QUIET_MS for the camera and viewer. A remote
    // viewer's is the main stream's keyframes only, as its page has room (sub-bridge.mjs).
    const since = (waitTimers.now ?? Date.now)()
    const wait = () => waitForSub(ws, { stream, held: () => nvr.subHeld?.(ch) === true, full: () => nvr.subFull?.() === true, since, ...waitTimers })
    if (streamType === 1 && !(stream.gop?.length > 0)) {
      if (hd()) {
        const main = nvr.getStream(ch, 0)
        const stand = standIn(nvr, ch, main, { phone, held, clientH265, phoneLive })
        const tag = `[sub-bridge] ${nvr.id}/${ch + 1}, ${remote ? 'remote' : 'local'} viewer${held ? ", sub-stream held at the NVR's limit" : ''}${stand !== main ? ', main converted for a phone' : ''}:`
        const say = (line, why) => {
          const text = why === 'h265' ? h265Line(line, `${nvr.id}/${ch}|${viewerOf(req, currentUser)}`) : line
          if (text) log(`${tag} ${text}`)
        }
        const bridge = bridgeSub(ws, { sub: stream, main: stand, clientH265, remote, log: say })
        if (bridge) track(standInHandle(ws, bridge, wait), req, { actions: ['live', 'live-hd'], nvr: nvr.id, ch })
      } else {
        wait()
      }
    }
    // a remote viewer (through Tailscale): the frame rate its link and the uplink can carry, per
    // browser (viewerOf). With the codec the NVR saw on this stream: a main started on demand has no
    // keyframe yet, and its first one, H.265, must not go to a browser that cannot decode it
    // (adaptive-live.mjs #h265). A main is moved between streams there at its level changes (the
    // camera's own, level full's conversion, another viewer's): each move asks Live HD again first
    // (mayMain), from the session and the account's role as they are then, as the access watch asks,
    // never the `who` above (a demoted admin's); not allowed, it answers with the watch's reason
    if (remote) {
      const codec = nvr.codecSeen?.get?.(`${ch}:${streamType}`)?.codec
      const mayMain = streamType !== 0 ? undefined : () => {
        const user = currentUser(req)
        if (!user) return 'signed out'
        const as = { user, admin: isAdmin ? isAdmin(user) === true : user === who.user && who.admin === true }
        if (can(as, 'live', { nvr: nvr.id, ch }) !== true) return 'not allowed'
        return can(as, 'live-hd', { nvr: nvr.id, ch }) === true || HD_NOT_ALLOWED
      }
      adaptiveLive.attach(viewerOf(req, currentUser), { ws, nvrId: nvr.id, ch, type: streamType, source: stream, clientH265, codec, mayMain })
      return
    }
    // a phone asking for 15 fps gets the shared thinned stream (phone-live.mjs), when there is room.
    // Not a held sub-stream: it has nothing to thin until there is room (small then: sent as it is),
    // and a conversion place held open for it is one its stand-in may need -- unless it is H.265,
    // which a phone may not play as it is (a sub tile that cannot decode its stream closes for good)
    const subH265 = nvr.codecSeen?.get?.(`${ch}:1`)?.codec === 'h265'
    if (phone && (!held || subH265) && phoneLive.attach(`${nvr.id}/${ch}/${streamType}`, stream, streamType, ws, { camera: `${nvr.id}/${ch + 1}` })) return
    // A PC on the local network whose page said its browser cannot play H.265 (h265=0: never one that
    // only did not say), on an H.265 sub-stream: the shared H.264 conversion of it (h264-fallback.mjs).
    // Not a remote viewer or a phone, which went their own ways above and keep them; not a main stream
    // (not converted: see that file); not an H.264 camera, ever. The codec is the one on the stream's
    // own last keyframe, or with none yet, what the NVR last saw it send. Not known at all: the
    // camera's own stream, as before, and the tile asks again when an H.265 keyframe reaches it
    // (live-tile.js), by which time that keyframe is here to say. No room, or a conversion that
    // failed: closed with the reason, which the tile shows instead of sitting black on H.265.
    if (noH265 && !phone && streamType === 1 && h264Fallback?.enabled) {
      const key = stream.gop?.[0]
      if (key ? key[1] === CODEC_H265 : subH265) {
        const got = h264Fallback.attach(`${nvr.id}/${ch}/1`, stream, ws, { camera: `${nvr.id}/${ch + 1}` })
        if (got !== true) ws.close(1013, got)
        return
      }
    }
    stream.add(ws)
    ws.on('close', () => stream.remove(ws))
  }
}
