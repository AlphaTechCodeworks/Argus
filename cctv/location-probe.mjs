// Checks one network-share location in a process of its own, so the server never waits on it.
//
// On 2026-09-26 the server froze twice, each time inside one file call to the NAS whose SMB
// session had gone stale: the kernel never returns such a call, and a process stuck in it cannot
// even be killed. Anything that touches a share can be the call that never returns. So the server
// does not touch a share to learn whether it is healthy; it runs this, gives it a few seconds, and
// if no answer comes it calls the share down. If this process hangs, only this process hangs.
//
//   node cctv/location-probe.mjs '<location json>' <floorFreePct> [speed]
//   prints one line: the health object (see storage.mjs), or exits non-zero
import { healthOf, probeWriteSpeed } from './location-health.mjs'

const [locJson, floor, speed] = process.argv.slice(2)
const loc = JSON.parse(locJson)
const h = healthOf(loc, Number(floor))
if (h.ok && speed === 'speed') {
  try {
    h.writeMBps = await probeWriteSpeed(loc.path)
  } catch (e) {
    h.speedError = e.message
  }
}
process.stdout.write(`${JSON.stringify(h)}\n`)
