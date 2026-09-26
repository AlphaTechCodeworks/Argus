// Tests for the outside watcher's decisions (deploy/healthwatch-core.mjs).
//   node cctv/test/healthwatch.test.mjs
// The case it exists for, 2026-09-26: the server frozen for 40 minutes in a network-share call
// while the NAS refused SMB sessions, with nothing logged and nobody told.
import { FAILS_TO_OPEN, MAX_RECOVERIES, REALERT_MS, decide, recoveryPlan, summarise } from '../../deploy/healthwatch-core.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const T = 1_790_000_000_000

// ---- when an incident opens and closes ----
{
  let s = {}
  let d = decide(s, false, T)
  check('one failed probe is not an outage', d.action === null && d.state.fails === 1)
  d = decide(d.state, false, T + 30_000)
  check(`${FAILS_TO_OPEN} in a row opens an incident`, d.action === 'open' && d.state.open === T + 30_000)
  const opened = d.state
  d = decide(opened, false, T + 60_000)
  check('an open incident is not opened again', d.action === null)
  d = decide(d.state, true, T + 300_000)
  check('an answer closes it, and says how long it was down', d.action === 'close' && d.downMs === 270_000)
  check('and the count starts again', d.state.fails === 0 && d.state.open === null)
}
{
  // a flapping server must not page somebody every minute
  let s = { fails: 0, open: null, lastAlertAt: T }
  let d = decide(s, false, T + 60_000)
  d = decide(d.state, false, T + 90_000)
  check('no second alert inside the quiet period', d.action === null)
  d = decide({ ...d.state }, false, T + REALERT_MS + 1)
  check('but a real outage after it is alerted again', d.action === 'open')
}
check('a healthy server stays quiet', decide({}, true, T).action === null)

// ---- the one-line summary ----
{
  // the real evidence from 2026-09-26
  const ev = {
    service: 'active', processState: 'Dsl', blockedIn: 'wait_for_response',
    kernelStack: ['[<0>] wait_for_response+0xa5/0xf0 [cifs]', '[<0>] smb2_query_path_info+0x181/0x510 [cifs]'],
    nas: [{ host: '192.168.0.121', ping: 'answers', smb445: 'open' }],
    kernelStorageMessages: ['CIFS: VFS: \\\\192.168.0.121 Send error in SessSetup = -11']
  }
  const s = summarise(ev)
  check('names the network share as the cause', /frozen waiting on the network share/.test(s), s)
  check('says the NAS answers ping but its port is open, so it is the service', /answers ping/.test(s) && /port is open/.test(s), s)
  check('says what to do about it', /restart file sharing on the NAS/.test(s), s)
}
check('a stopped service says so', /not running/.test(summarise({ service: 'failed' })))
check('stuck on a local disk is told apart from the share', /stuck waiting on the disk/.test(summarise({ service: 'active', processState: 'D', blockedIn: 'io_schedule', kernelStack: ['ext4'] })))
check('with nothing to go on it does not invent a cause', summarise({ service: 'active', processState: 'S' }) === 'The server is running but not answering its health check.')
check('no evidence at all is not a crash', typeof summarise() === 'string')

// ---- when the watcher may fix it itself ----
{
  const stale = {
    blockedIn: 'wait_for_response', kernelStack: ['[<0>] SMB2_open+0x368/0x600 [cifs]'],
    nas: [{ host: '192.168.0.121', ping: 'answers', smb445: 'open' }],
    networkMounts: ['//192.168.0.121/backups /srv/cctv-net/backups cifs rw,soft 0 0']
  }
  const p = recoveryPlan(stale, [], T)
  check('stuck on a stale share with the NAS up: remount and restart', p.recover && p.mounts[0] === '/srv/cctv-net/backups', JSON.stringify(p))
  check('not when the NAS is off (a remount would hang too)', !recoveryPlan({ ...stale, nas: [{ host: 'x', ping: 'no answer', smb445: 'closed' }] }, [], T).recover)
  check('not when stuck on something else', !recoveryPlan({ ...stale, blockedIn: 'futex', kernelStack: [] }, [], T).recover)
  const many = Array.from({ length: MAX_RECOVERIES }, (_, i) => T - i * 60_000)
  check('not a fourth time in an hour: then it needs a person', !recoveryPlan(stale, many, T).recover)
  check('but again once the hour has passed', recoveryPlan(stale, many, T + 2 * 3_600_000).recover)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
