// Tests for applyP2pOnline (nvrs.mjs): over the cloud GetDeviceIPCInfo's online flag is unreliable
// (the read even comes back empty), so the NVR's own queryOnlineChlList is the authority when we have
// it -- a configured camera is online iff the NVR lists it online, or it is delivering video now.
// Without a list, it falls back to the as-read flag plus video. An empty slot is never online. No SDK.
//   Run:  node cctv/test/p2p-online.test.mjs
import { applyP2pOnline } from '../nvrs.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}
const cam = (ch, online, configured = true) => ({ ch, name: `Camera ${ch}`, online, configured })
const noVideo = () => false

// ---- with the NVR's online list (the normal case) ----
{
  const onlineSet = new Set([2, 4, 8]) // the NVR says these channels are online
  const list = [cam(2, false), cam(4, false), cam(0, true), cam(3, false)]
  applyP2pOnline(list, { hasVideo: noVideo, onlineSet })
  check('a camera the NVR lists online is online', list[0].online === true && list[1].online === true)
  check('a camera the NVR does NOT list is offline, whatever its read flag said', list[2].online === false && list[3].online === false)
}

// a camera not in the list but delivering video right now is still online
{
  const onlineSet = new Set([2])
  const list = [cam(5, false)]
  applyP2pOnline(list, { hasVideo: (ch) => ch === 5, onlineSet })
  check('a streaming camera is online even if the NVR did not list it', list[0].online === true)
}

// an empty (unconfigured) slot is never online, even if somehow in the set
{
  const onlineSet = new Set([1])
  const list = [cam(1, true, false)]
  applyP2pOnline(list, { hasVideo: noVideo, onlineSet })
  check('an empty slot stays offline', list[0].online === false)
}

// ---- no online list yet (first read of a fresh process, or the query failed) ----
{
  const list = [cam(0, true), cam(3, false)]
  applyP2pOnline(list, { hasVideo: noVideo, onlineSet: null })
  check('without a list, the as-read flag is trusted (online stays online)', list[0].online === true)
  check('without a list, a read-offline camera stays offline', list[1].online === false)
  const streaming = [cam(6, false)]
  applyP2pOnline(streaming, { hasVideo: (ch) => ch === 6, onlineSet: null })
  check('without a list, video still forces a camera online', streaming[0].online === true)
}

// the g-port case: 16 slots, the NVR lists 8 online, 2 slots empty -> exactly those 8 online
{
  const online = new Set([2, 4, 8, 9, 12, 13, 14, 15]) // queryOnlineChlList, 0-based
  const empty = new Set([1, 11])
  const list = []
  for (let ch = 0; ch < 16; ch++) list.push(cam(ch, false, !empty.has(ch)))
  applyP2pOnline(list, { hasVideo: noVideo, onlineSet: online })
  const onlineNow = list.filter((c) => c.online).map((c) => c.ch)
  check('g-port: exactly the 8 the NVR lists are online', onlineNow.length === 8 && [...online].every((ch) => list[ch].online), onlineNow.join(','))
  check('g-port: the 6 the NVR does not list are offline', [0, 3, 5, 6, 7, 10].every((ch) => list[ch].online === false))
  check('g-port: empty slots stay offline', list[1].online === false && list[11].online === false)
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
