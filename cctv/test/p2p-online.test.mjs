// Tests for applyP2pOnline (nvrs.mjs): over the cloud a P2P NVR's per-camera "online" flag only
// reflects channels with an active media session, so a configured camera is trusted online (down
// cameras are caught by the not-recording/stalled alerts instead). An empty slot stays offline; a
// channel delivering video is online even if a flaky read blanks its configured flag. No SDK, no NVR.
//   Run:  node cctv/test/p2p-online.test.mjs
import { applyP2pOnline } from '../nvrs.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}
const cam = (ch, online, configured = true) => ({ ch, name: `Camera ${ch}`, online, configured })
const noVideo = () => false

// a configured camera read offline is trusted online (the cloud status flag is unreliable)
{
  const list = [cam(3, false)]
  applyP2pOnline(list, { hasVideo: noVideo })
  check('configured camera read offline is online', list[0].online === true)
}

// a configured camera read online stays online
{
  const list = [cam(0, true)]
  applyP2pOnline(list, { hasVideo: noVideo })
  check('configured camera read online stays online', list[0].online === true)
}

// an empty (unconfigured) slot stays offline, even if the status flag reads online
{
  const list = [cam(1, true, false)]
  applyP2pOnline(list, { hasVideo: noVideo })
  check('empty slot stays offline', list[0].online === false)
}

// a channel delivering video is online even if a flaky read blanked its configured flag
{
  const list = [cam(5, false, false)]
  applyP2pOnline(list, { hasVideo: (ch) => ch === 5 })
  check('streaming channel is online despite a blanked configured flag', list[0].online === true)
}

// the g-port case: 16 slots, 14 configured cameras, 2 empty -> all 14 online, 2 empty offline,
// regardless of which read online/offline or which happen to be streaming
{
  const empty = new Set([1, 11])
  const online = new Set([2, 4, 8, 9, 12, 13, 14, 15]) // the 8 the cloud happened to confirm
  const streaming = new Set([5, 10])
  const list = []
  for (let ch = 0; ch < 16; ch++) list.push(cam(ch, online.has(ch), !empty.has(ch)))
  applyP2pOnline(list, { hasVideo: (ch) => streaming.has(ch) })
  const onlineNow = list.filter((c) => c.online).map((c) => c.ch)
  check('g-port: all 14 configured cameras online', onlineNow.length === 14, onlineNow.join(','))
  check('g-port: the cameras the cloud read offline are now online', [0, 3, 6, 7].every((ch) => list[ch].online === true))
  check('g-port: empty slots stay offline', list[1].online === false && list[11].online === false)
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
