// Tests for applyP2pOnline (nvrs.mjs): a P2P NVR's per-camera "offline" flag is unreliable over the
// cloud, so a camera is taken online while it delivers video, and "offline" is believed only once it
// has held that way for the grace period with no video. No SDK, no NVR, no network.
//   Run:  node cctv/test/p2p-online.test.mjs
import { applyP2pOnline } from '../nvrs.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}
const cam = (ch, online, configured = true) => ({ ch, name: `Camera ${ch}`, online, configured })
const noVideo = () => false
const GRACE = 1000

// a camera read online stays online and holds no grace entry
{
  const off = new Map()
  const list = [cam(0, true)]
  applyP2pOnline(list, { hasVideo: noVideo, offlineSince: off, now: 100, graceMs: GRACE })
  check('online camera stays online', list[0].online === true && off.size === 0)
}

// a camera read offline but delivering video is online, no grace entry
{
  const off = new Map()
  const list = [cam(5, false)]
  applyP2pOnline(list, { hasVideo: (ch) => ch === 5, offlineSince: off, now: 100, graceMs: GRACE })
  check('streaming camera overrides the offline flag', list[0].online === true && off.size === 0)
}

// offline + no video: online through the grace, then believed offline
{
  const off = new Map()
  let list = [cam(3, false)]
  applyP2pOnline(list, { hasVideo: noVideo, offlineSince: off, now: 100, graceMs: GRACE })
  check('first offline read is held online (grace)', list[0].online === true && off.get(3) === 100)
  list = [cam(3, false)]
  applyP2pOnline(list, { hasVideo: noVideo, offlineSince: off, now: 500, graceMs: GRACE })
  check('still online within the grace', list[0].online === true)
  list = [cam(3, false)]
  applyP2pOnline(list, { hasVideo: noVideo, offlineSince: off, now: 1200, graceMs: GRACE })
  check('believed offline after the grace', list[0].online === false, 'now-since >= grace')
}

// a camera that recovers (reads online again) clears its grace
{
  const off = new Map([[7, 100]])
  const list = [cam(7, true)]
  applyP2pOnline(list, { hasVideo: noVideo, offlineSince: off, now: 400, graceMs: GRACE })
  check('recovered camera is online and grace cleared', list[0].online === true && off.size === 0)
}

// a camera that starts streaming clears its grace
{
  const off = new Map([[9, 100]])
  const list = [cam(9, false)]
  applyP2pOnline(list, { hasVideo: (ch) => ch === 9, offlineSince: off, now: 400, graceMs: GRACE })
  check('camera that begins streaming is online and grace cleared', list[0].online === true && off.size === 0)
}

// an empty (unconfigured) slot keeps its as-read offline and never holds a grace entry
{
  const off = new Map([[1, 100]])
  const list = [cam(1, false, false)]
  applyP2pOnline(list, { hasVideo: noVideo, offlineSince: off, now: 400, graceMs: GRACE })
  check('empty slot stays offline, grace cleared', list[0].online === false && off.size === 0)
}

// a camera that drops out of the list has its grace forgotten
{
  const off = new Map([[2, 100], [4, 100]])
  const list = [cam(2, false)] // ch4 is gone this read
  applyP2pOnline(list, { hasVideo: noVideo, offlineSince: off, now: 400, graceMs: GRACE })
  check('grace of a camera no longer in the list is forgotten', off.has(2) && !off.has(4))
}

// the exact g-port case: 8 online, 6 configured-offline, 2 empty; ch5 & ch10 stream -> they are online
{
  const off = new Map()
  const online = new Set([2, 4, 8, 9, 12, 13, 14, 15])
  const streaming = new Set([5, 10])
  const empty = new Set([1, 11])
  const list = []
  for (let ch = 0; ch < 16; ch++) list.push(cam(ch, online.has(ch), !empty.has(ch)))
  applyP2pOnline(list, { hasVideo: (ch) => streaming.has(ch), offlineSince: off, now: 100, graceMs: GRACE })
  const onlineNow = list.filter((c) => c.online).map((c) => c.ch)
  check('g-port: streaming ch5 & ch10 become online', list[5].online === true && list[10].online === true)
  check('g-port: the non-streaming unconfirmed ones held online in grace', [0, 3, 6, 7].every((ch) => list[ch].online === true), onlineNow.join(','))
  check('g-port: empty slots stay offline', list[1].online === false && list[11].online === false)
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
