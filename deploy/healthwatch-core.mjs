// The watcher's decisions, apart from anything that touches the machine, so they can be tested on
// any PC. Two things are decided here: when a failure is real enough to open an incident, and how
// to say in one line what the evidence shows.

/** Failed probes in a row before an incident opens: one slow answer is not an outage. */
export const FAILS_TO_OPEN = 2
/** An alert is not repeated sooner than this, however the server flaps. */
export const REALERT_MS = 15 * 60_000

/**
 * The next state after one probe.
 * @returns {{ state: object, action: 'open'|'close'|null, downMs?: number }}
 */
export function decide(state, ok, nowMs) {
  const s = { fails: 0, open: null, lastAlertAt: 0, ...state }
  if (ok) {
    if (s.open !== null) return { state: { ...s, fails: 0, open: null }, action: 'close', downMs: nowMs - s.open }
    return { state: { ...s, fails: 0 }, action: null }
  }
  const fails = s.fails + 1
  if (s.open === null && fails >= FAILS_TO_OPEN && nowMs - s.lastAlertAt >= REALERT_MS) {
    return { state: { ...s, fails, open: nowMs, lastAlertAt: nowMs }, action: 'open' }
  }
  return { state: { ...s, fails }, action: null }
}

/**
 * One sentence a person can act on, from the evidence gathered. The cases are the ones seen for
 * real: a process frozen in a network-share call with the NAS refusing sessions (2026-09-26), the
 * service not running at all, or running and simply not answering.
 */
export function summarise(ev = {}) {
  const stuckOnShare = /cifs|smb|nfs/i.test(`${ev.blockedIn ?? ''} ${(ev.kernelStack ?? []).join(' ')}`)
  const nasRefusing = (ev.kernelStorageMessages ?? []).some((l) => /SessSetup|not responded|cifs_mount failed/i.test(l))
  const nas = (ev.nas ?? [])[0]
  if (ev.service && ev.service !== 'active') return `The CCTV service is ${ev.service}, not running.`
  if (stuckOnShare) {
    const where = nas ? ` The NAS at ${nas.host} ${nas.ping === 'answers' ? 'answers ping' : 'does not answer ping'} and its SMB port is ${nas.smb445}.` : ''
    const why = nasRefusing ? ' The kernel log shows it refusing or not answering file-sharing sessions: restart file sharing on the NAS, then restart the CCTV service.' : ''
    return `The server is frozen waiting on the network share.${where}${why}`
  }
  if (/^D/.test(ev.processState ?? '')) return `The server process is stuck waiting on the disk (state ${ev.processState}, in ${ev.blockedIn || 'unknown'}).`
  return 'The server is running but not answering its health check.'
}
