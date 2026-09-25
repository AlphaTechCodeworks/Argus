// The alert rules: from a snapshot of facts, decide which alerts open and which clear.
//
// Pure: no I/O, no timers, no imports. alert-checks.mjs builds the snapshot and calls step()
// every 30 s; alert-send.mjs delivers what comes back. Keeping the rules here means they can be
// tested on any machine without the SDK.
//
// An alert opens once its condition has held for raiseMs (immediate kinds open on the first
// sighting) and clears once the condition has been false for clearMs. It never repeats while open.
// Cameras of one NVR are grouped into a single alert, and an alert that would only restate a
// bigger one is suppressed.

/** Every kind, in the order they are shown. */
export const KINDS = Object.freeze([
  'server-restart', 'drive-missing', 'drive-full', 'drive-filling', 'not-recording',
  'camera-offline', 'nvr-offline', 'nvr-disk', 'nvr-refusing', 'nvr-login', 'nvr-clock'
])
// 'drive-filling' is a forecast, and deliberately a different kind from 'drive-full'. A recorder
// that has reached its retention is permanently full and overwriting, which is the healthy steady
// state here, so a forecast only speaks up about a drive that is still filling towards its first
// time round -- see storage-report.mjs driveFullCandidates.

/** Kinds that open on the first sighting rather than after raiseMs. */
const IMMEDIATE = new Set(['server-restart', 'nvr-login', 'nvr-refusing'])

/** Kinds reported once with no clear (nothing to recover from). */
const ONE_SHOT = new Set(['server-restart'])

const HIGH = new Set(['server-restart', 'drive-missing', 'drive-full', 'nvr-offline', 'nvr-login', 'nvr-disk'])

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const names = (list, max = 4) =>
  list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`

/**
 * @param {object} o
 * @param {number} o.raiseMs        how long a condition must hold before it opens
 * @param {number} o.clearMs        how long it must be false before it clears
 * @param {number} o.graceMs        no alerts (except server-restart) for this long after start
 * @param {number} o.notRecordingMs a recording camera with no segment for this long counts as stopped
 * @param {number} o.clockSkewMs    an NVR clock this far out counts as wrong
 * @param {string[]} o.muted        kinds never to open
 */
export function alertEngine({ raiseMs, clearMs, graceMs, notRecordingMs, clockSkewMs, muted = [] }) {
  const mutedSet = new Set(muted)
  /** key -> { alert, firstSeen, lastSeen, openedAt|null, doneOneShot } */
  const state = new Map()

  return {
    step(snap, nowMs) {
      const inGrace = nowMs - snap.startedMs < graceMs
      const found = new Map()
      for (const c of candidates(snap, { notRecordingMs, clockSkewMs, nowMs })) {
        if (mutedSet.has(c.kind)) continue
        // Just after a start everything looks wrong while cameras reconnect, so only the restart
        // notice itself is allowed through the grace window.
        if (inGrace && c.kind !== 'server-restart') continue
        found.set(c.key, c)
      }

      const opened = []
      const cleared = []

      for (const [key, c] of found) {
        const st = state.get(key) ?? { firstSeen: nowMs, openedAt: null, doneOneShot: false }
        st.alert = c
        st.lastSeen = nowMs
        state.set(key, st)
        if (st.openedAt !== null || st.doneOneShot) continue
        const due = IMMEDIATE.has(c.kind) || nowMs - st.firstSeen >= raiseMs
        if (!due) continue
        st.openedAt = nowMs
        const alert = { ...c, since: st.firstSeen, severity: HIGH.has(c.kind) ? 'high' : 'medium' }
        st.alert = alert
        opened.push(alert)
        // A one-shot is never open and never clears, but its entry is kept so the same restart is
        // not reported again on the next step; it is dropped once the fact stops being reported.
        if (ONE_SHOT.has(c.kind)) { st.doneOneShot = true; st.openedAt = null }
      }

      for (const [key, st] of [...state]) {
        if (found.has(key)) continue
        if (st.openedAt === null) { state.delete(key); continue }   // never opened: forget it
        if (nowMs - st.lastSeen < clearMs) continue
        cleared.push({ ...st.alert, clearedAt: nowMs })
        state.delete(key)
      }

      const open = [...state.values()].filter((s) => s.openedAt !== null).map((s) => s.alert)
      return { opened, cleared, open }
    }
  }
}

/** Everything wrong in this snapshot, before the raise/clear timing is applied. */
function candidates(snap, { notRecordingMs, clockSkewMs, nowMs }) {
  const out = []
  // Candidates worked out elsewhere and handed in ready made -- the storage forecast, which needs
  // a history of free-space samples this module has no business keeping. They go through the same
  // raise, clear and mute timing as everything else, so nothing can page the owner instantly by
  // coming in this way.
  for (const c of snap.extra ?? []) if (c?.key && c?.kind && KINDS.includes(c.kind)) out.push(c)
  if (snap.restartReason) {
    out.push({ key: `server-restart/${snap.startedMs}`, kind: 'server-restart', title: 'The server restarted', detail: snap.restartReason })
  }

  for (const l of snap.locations ?? []) {
    if (!l.mounted) out.push({ key: `drive-missing/${l.id}`, kind: 'drive-missing', title: `${l.name} is not mounted`, detail: 'Nothing can be recorded to it.' })
    else if (l.freePct <= l.lowFreePct) out.push({ key: `drive-full/${l.id}`, kind: 'drive-full', title: `${l.name} is nearly full`, detail: `${Math.round(100 - l.freePct)} % used.` })
  }

  const offlineNvrs = new Set()
  for (const n of snap.nvrs ?? []) {
    if (n.loginError) out.push({ key: `nvr-login/${n.id}`, kind: 'nvr-login', title: `${n.id} refused the login`, detail: n.loginError })
    if (!n.online) { offlineNvrs.add(n.id); out.push({ key: `nvr-offline/${n.id}`, kind: 'nvr-offline', title: `${n.id} is offline`, detail: `${n.name}: the server cannot reach it.` }) }
    if (n.refusalsLast10Min >= 3) out.push({ key: `nvr-refusing/${n.id}`, kind: 'nvr-refusing', title: `${n.id} is refusing streams`, detail: `${n.refusalsLast10Min} refused in the last 10 minutes; it may be at its limit.` })
    // The NVR's own disk: roughly 30 days of recordings, and the only copy besides the server's.
    // Only a disk the NVR itself calls broken, or an NVR that reports no disk at all, raises this.
    // An NVR that cannot be asked (offline, or firmware that does not answer the query) reports
    // `available: false` and is silent: a guess is not worth waking somebody for, and the Health
    // page says "not available" instead. An offline NVR is already covered by its own alert.
    const st = n.storage
    if (n.online && st?.available) {
      if (!st.disks?.length) {
        out.push({ key: `nvr-disk/${n.id}`, kind: 'nvr-disk', title: `${n.id} reports no disk`, detail: `${n.name} is not keeping its own copy of the recordings.` })
      } else {
        // A drive the NVR is happily writing to while its own SMART data says it is going. This
        // is the warning that arrives in time to do something about it -- by the time the NVR
        // itself calls the disk bad, the recordings on it are already at risk.
        const ailing = st.disks.filter((d) => d.smart && (d.smart.state === 'warn' || d.smart.state === 'bad') && d.state !== 'bad')
        if (ailing.length) {
          out.push({
            key: `nvr-disk-smart/${n.id}`,
            kind: 'nvr-disk',
            title: `${n.id}: ${plural(ailing.length, 'disk')} reporting poor health`,
            detail: `${names(ailing.map((d) => `${d.name}${d.smart.concerns.length ? ` (${d.smart.concerns[0]})` : ''}`))} — still recording, but ${n.name} may not hold its own copy for much longer.`
          })
        }
        const broken = st.disks.filter((d) => d.state === 'bad')
        if (broken.length) {
          out.push({
            key: `nvr-disk/${n.id}`,
            kind: 'nvr-disk',
            title: `${n.id}: ${plural(broken.length, 'disk')} failed`,
            detail: `${names(broken.map((d) => `${d.name}${d.status ? ` (${d.status})` : ''}`))} — ${n.name} may no longer hold its own copy of the recordings.`
          })
        }
      }
    }

    const skew = Math.abs(n.clockSkewMs ?? 0)
    if (skew >= clockSkewMs) {
      const secs = Math.round(skew / 1000)
      out.push({ key: `nvr-clock/${n.id}`, kind: 'nvr-clock', title: `${n.id} clock is ${secs} s ${n.clockSkewMs > 0 ? 'fast' : 'slow'}`, detail: 'Recordings and exports from this NVR carry the wrong time.' })
    }
  }

  const driveDown = (snap.locations ?? []).some((l) => !l.mounted)
  const offlineBy = new Map()
  const stoppedBy = new Map()
  for (const c of snap.cameras ?? []) {
    if (offlineNvrs.has(c.nvrId)) continue                       // the NVR alert covers it
    if (!c.online) { push(offlineBy, c.nvrId, c.name); continue } // offline covers not-recording
    if (!c.recording || driveDown) continue
    if (nowMs - (c.lastSegmentMs ?? nowMs) >= notRecordingMs) push(stoppedBy, c.nvrId, c.name)
  }
  for (const [nvrId, list] of offlineBy) {
    out.push({ key: `camera-offline/${nvrId}`, kind: 'camera-offline', title: `${nvrId}: ${plural(list.length, 'camera')} offline`, detail: names(list) })
  }
  for (const [nvrId, list] of stoppedBy) {
    out.push({ key: `not-recording/${nvrId}`, kind: 'not-recording', title: `${nvrId}: ${plural(list.length, 'camera')} not recording`, detail: `${names(list)} — online but nothing written.` })
  }
  return out
}

const push = (map, k, v) => { const l = map.get(k); if (l) l.push(v); else map.set(k, [v]) }
