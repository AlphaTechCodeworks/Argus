// A fake TVT SDK for tests: importing this replaces every NET_SDK function (the same way
// cooling.test.mjs does), so nothing can reach a real NVR. Logins to *.invalid hosts succeed,
// GetDeviceIPCInfo answers with no cameras, and each LivePlay handle gets a fake video stream
// (25 frames/s, a keyframe every 25 frames) delivered through liveFrames like the real callback.
// Every call is logged in globalThis.__fakeSdk.log ({ fn, args, at }).
import { NET_SDK, liveFrames, FRAME_TYPE_VIDEO } from '../sdk.mjs'

const log = []
const feeds = new Map() // handle -> { fn, timer, n }
let nextUser = 7
let nextHandle = 100
const FRAME_MS = 40
const GOP = 25
// tests: the first stream stops delivering after this many frames while its handle stays open
// (an NVR stream that stalls inside the SDK); streams started later are not affected
const STALL_AFTER = Number(process.env.CCTV_FAKE_STALL_AFTER_FRAMES || 0)
let stallUsed = false
// tests: an NVR that plays at most this many sub-streams at once, like value4u (15): a sub-stream
// LivePlay beyond it fails at once and GetLastError says 8, "cannot connect" (sub-cap.mjs)
const MAX_SUBS = Number(process.env.CCTV_FAKE_MAX_SUBS || 0)
const subHandles = new Set()
let lastErr = 0

const answers = {
  Login: (host) => (/\.invalid$/.test(String(host)) ? nextUser++ : -1),
  LoginEx: () => -1,
  GetLastError: () => lastErr,
  LivePlay: (_user, info) => {
    if (MAX_SUBS && info?.streamType === 1 && subHandles.size >= MAX_SUBS) {
      lastErr = 8
      return -1
    }
    const h = nextHandle++
    if (info?.streamType === 1) subHandles.add(h)
    return h
  },
  StopLivePlay: (h) => {
    stopFeed(h)
    subHandles.delete(h)
    return true
  }
}

for (const name of Object.keys(NET_SDK)) {
  const answer = answers[name] ?? (() => true)
  NET_SDK[name] = {
    fake: true,
    cName: `NET_SDK_${name}`, // (sdk.mjs names the call like the real one: time limits, live calls in flight)
    async(...args) {
      const cb = args.at(-1)
      // (CCTV_FAKE_LOG_CALLS=1: a worker's live calls and logouts, for tests that read its output)
      if (process.env.CCTV_FAKE_LOG_CALLS === '1' && /LivePlay|Logout/.test(name)) console.log(`[fake-sdk] ${name}${name === 'LivePlay' ? ` ${args[1]?.lChannel}:${args[1]?.streamType}` : ''}`)
      // (CCTV_FAKE_NET_DOWN_CH=n: a LivePlay of channel n makes the SDK say the NVR dropped a link, as
      // the real one prints it; the supervisor watches for it, worker-supervisor.mjs)
      if (name === 'LivePlay' && process.env.CCTV_FAKE_NET_DOWN_CH !== undefined && String(args[1]?.lChannel) === process.env.CCTV_FAKE_NET_DOWN_CH) console.log('Net Disconnected...... m_deviceID = 1')
      log.push({ fn: name, args: args.slice(0, -1).map((a) => (typeof a === 'object' ? null : a)), at: Date.now() })
      setTimeout(() => cb(null, answer(...args.slice(0, -1))), 5)
    }
  }
}
if (!Object.values(NET_SDK).every((f) => f.fake)) throw new Error('the SDK is not fully faked: not running')

function stopFeed(h) {
  const f = feeds.get(h)
  if (f) clearInterval(f.timer)
  feeds.delete(h)
}

// frames reach the stream the way the real SDK callback's routing does: through claim()
const realClaim = liveFrames.claim.bind(liveFrames)
const realRelease = liveFrames.release.bind(liveFrames)
liveFrames.claim = (handle, fn) => {
  realClaim(handle, fn)
  stopFeed(handle)
  const f = { fn, n: 0, timer: null, stallAt: 0 }
  if (STALL_AFTER && !stallUsed) {
    stallUsed = true
    f.stallAt = STALL_AFTER
  }
  f.timer = setInterval(() => {
    if (f.stallAt && f.n >= f.stallAt) return
    const key = f.n % GOP === 0
    const data = Buffer.alloc(key ? 64 : 16, f.n & 0xff)
    f.fn({ frameType: FRAME_TYPE_VIDEO, length: data.length, keyFrame: key ? 1 : 0, width: 640, height: 360, time: Date.now() * 1000 }, data)
    f.n++
  }, FRAME_MS)
  f.timer.unref?.()
  feeds.set(handle, f)
}
liveFrames.release = (handle) => {
  stopFeed(handle)
  realRelease(handle)
}

globalThis.__fakeSdk = { log, calls: (fn) => log.filter((c) => c.fn === fn) }
