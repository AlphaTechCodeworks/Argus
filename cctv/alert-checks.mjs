// The check loop: every CHECK_MS it turns live server state into the snapshot alerts.mjs wants,
// steps the engine, sends whatever opened or cleared, writes both to the history, and keeps the
// latest picture for the Health page.
//
// Everything the loop needs is injected (listNvrs, listCameras, locationState, sender, now), so
// the whole cycle can be tested with fake time and without the SDK. server.mjs is the only place
// that knows where those facts really come from.
//
// tick() never throws: a state read that fails (an NVR list that blew up, a drive that vanished
// mid-stat) is logged and skipped, because a monitoring loop that can take the server down is
// worse than no monitoring at all.

import { alertEngine } from './alerts.mjs'
import { appendAlert, pruneAlerts, readAlerts } from './alert-log.mjs'

const CHECK_MS = 30_000
const RAISE_MS = 2 * 60_000
const CLEAR_MS = 60_000
const GRACE_MS = 3 * 60_000
const HISTORY_DAYS = 30
const HISTORY_SHOWN_DAYS = 7
const PRUNE_MS = 6 * 60 * 60_000

/** Errors that mean the NVR rejected who we are, rather than that we could not reach it. */
const LOGIN_ERROR = /password|user ?name|locked|denied|credential/i

/** Live state as the snapshot alerts.mjs expects. */
export function buildSnapshot(deps, nowMs) {
  const s = deps.getSettings()
  const lowFreePct = s.storage?.lowFreePct ?? 15
  return {
    startedMs: deps.startedMs,
    restartReason: deps.restartReason ?? null,
    // lowFreePct rides on each location so the rules stay pure: they compare, they do not read settings.
    locations: deps.locationState().map((l) => ({ ...l, lowFreePct })),
    nvrs: deps.listNvrs().map((n) => ({
      id: n.id,
      name: n.name,
      online: n.status === 'online',
      loginError: n.error && LOGIN_ERROR.test(n.error) ? n.error : null,
      refusalsLast10Min: n.refusalsLast10Min ?? 0,
      clockSkewMs: n.clockSkewMs ?? 0
    })),
    cameras: deps.listCameras().map((c) => ({
      nvrId: c.nvrId,
      ch: c.ch,
      name: c.name,
      online: Boolean(c.online),
      recording: Boolean(c.recording),
      // No segment yet (a camera that has just been switched on) counts as up to date rather than
      // as decades behind, or every new camera would raise not-recording on its first check.
      lastSegmentMs: c.lastSegmentMs ?? nowMs
    }))
  }
}

/**
 * @param {object} deps everything buildSnapshot needs, plus:
 *   dataDir, sender ({ deliver, test, pending }), lastBackup?, now?, log?,
 *   autoStart? (false in tests: tick() is then called by hand)
 */
export function startAlerts(deps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? console.log
  const s0 = deps.getSettings().alerts ?? {}
  const engine = alertEngine({
    raiseMs: RAISE_MS,
    clearMs: CLEAR_MS,
    graceMs: GRACE_MS,
    notRecordingMs: (s0.notRecordingMinutes ?? 5) * 60_000,
    clockSkewMs: (s0.clockSkewSeconds ?? 30) * 1000,
    muted: s0.muted ?? []
  })

  let last = { open: [], snapshot: null }
  let timer = null
  let pruneTimer = null

  const record = (t, event, a) =>
    appendAlert(deps.dataDir, { at: t, event, key: a.key, kind: a.kind, title: a.title, detail: a.detail, severity: a.severity })

  function tick() {
    const t = now()
    let snap
    try {
      snap = buildSnapshot(deps, t)
    } catch (e) {
      log(`[alerts] could not read the state: ${e.message}`)
      return
    }
    try {
      const { opened, cleared, open } = engine.step(snap, t)
      last = { open, snapshot: snap }
      for (const a of opened) record(t, 'opened', a)
      for (const a of cleared) record(t, 'cleared', a)
      // Fire and forget: delivery has its own retries, and a slow mail server must never
      // delay or skip the next check.
      if (opened.length) void deps.sender.deliver(opened, 'opened')
      if (cleared.length) void deps.sender.deliver(cleared, 'cleared')
      for (const a of opened) log(`[alerts] OPEN  ${a.title}`)
      for (const a of cleared) log(`[alerts] OK    ${a.title}`)
    } catch (e) {
      log(`[alerts] check failed: ${e.message}`)
    }
  }

  if (deps.autoStart !== false) {
    timer = setInterval(tick, CHECK_MS)
    timer.unref?.()
    pruneTimer = setInterval(() => {
      try {
        pruneAlerts(deps.dataDir, now() - HISTORY_DAYS * 86_400_000)
      } catch (e) {
        log(`[alerts] could not prune the history: ${e.message}`)
      }
    }, PRUNE_MS)
    pruneTimer.unref?.()
    tick()
  }

  return {
    tick,
    stop() {
      if (timer) clearInterval(timer)
      if (pruneTimer) clearInterval(pruneTimer)
      timer = pruneTimer = null
    },
    snapshot: () => last.snapshot,
    testSend: (method) => deps.sender.test(method),
    /**
     * Everything the Health page shows. Carries no secret: no ntfy topic and no mail password,
     * because the page is served to every signed-in user, not only admins.
     */
    health() {
      const snap = last.snapshot ?? buildSnapshot(deps, now())
      let history = []
      try {
        history = readAlerts(deps.dataDir, now() - HISTORY_SHOWN_DAYS * 86_400_000)
      } catch (e) {
        log(`[alerts] could not read the history: ${e.message}`)
      }
      return {
        now: now(),
        startedMs: deps.startedMs,
        restartReason: deps.restartReason ?? null,
        open: last.open,
        locations: snap.locations,
        nvrs: snap.nvrs,
        cameras: snap.cameras,
        sending: deps.sender.pending(),
        history,
        backup: deps.lastBackup?.() ?? null
      }
    }
  }
}
