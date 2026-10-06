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
// Slow to clear, on purpose: an NVR that dips, recovers for a minute, then dips again (a P2P control
// login that keeps getting "NVR busy") stays ONE open alert instead of clearing and re-notifying each
// cycle. The raise is still 2 min, so the alert is just as quick to appear.
const CLEAR_MS = 5 * 60_000
const GRACE_MS = 3 * 60_000
const HISTORY_DAYS = 30
const HISTORY_SHOWN_DAYS = 7
const PRUNE_MS = 6 * 60 * 60_000
// health() shows the newest snapshot, whoever built it (the check above or an earlier poll), while it
// is younger than this. Building one reads every camera's last recording from the index on the main
// thread, which also paces every playback; the banner on every page polls every 30 s and the Health
// page every 2 s, and a snapshot per poll was the main-thread time that froze playback. The Health
// page still moves within seconds.
const SNAPSHOT_REUSE_MS = 5000

/** Errors that mean the NVR rejected who we are, rather than that we could not reach it. */
const LOGIN_ERROR = /password|user ?name|locked|denied|credential/i

/** Live state as the snapshot alerts.mjs expects. */
export function buildSnapshot(deps, nowMs) {
  const s = deps.getSettings()
  const lowFreePct = s.storage?.lowFreePct ?? 15
  return {
    startedMs: deps.startedMs,
    restartReason: deps.restartReason ?? null,
    // The storage forecast, worked out where the free-space history lives. It never throws here:
    // a forecast that cannot be made is no alert, which is the right answer, and a broken forecast
    // must not be able to stop every other alert being checked.
    extra: (() => {
      try {
        return deps.extraCandidates?.() ?? []
      } catch (e) {
        console.warn(`[alerts] the storage forecast could not be read: ${e.message}`)
        return []
      }
    })(),
    // lowFreePct rides on each location so the rules stay pure: they compare, they do not read settings.
    // A location's own low mark wins (storage.mjs, since 2026-09-29: the NAS's near 7 %).
    locations: deps.locationState().map((l) => ({ ...l, lowFreePct: Number.isInteger(l.lowFreePct) ? l.lowFreePct : lowFreePct })),
    nvrs: deps.listNvrs().map((n) => ({
      id: n.id,
      name: n.name,
      online: n.status === 'online',
      // The word the NVR list uses, so the page can say "connecting" rather than a bare "offline".
      status: n.status ?? (n.online ? 'online' : 'offline'),
      error: n.error || '',
      loginError: n.error && LOGIN_ERROR.test(n.error) ? n.error : null,
      // null, not 0, when nothing counted them: the page prints "not measured" rather than a
      // reassuring zero, and the nvr-refusing rule (>= 3) simply does not fire.
      refusalsLast10Min: n.refusalsLast10Min ?? null,
      clockSkewMs: n.clockSkewMs ?? 0,
      // What the NVR is, and how it is doing, for the per-NVR panel. All optional: an NVR that has
      // never logged in has no model or serial, and any of these may be null.
      model: n.model ?? null,
      serial: n.serial ?? null,
      host: n.host ?? null,
      via: n.via ?? null,
      streams: Number.isFinite(n.streams) ? n.streams : null,
      cooling: Boolean(n.cooling),
      // settings go out on the worker's login: the NVR refuses the main process a second one
      borrowing: Boolean(n.borrowing),
      lastContactMs: Number.isFinite(n.lastContactMs) ? n.lastContactMs : null,
      // Read in the background, at most every 10 minutes (nvr-disks.mjs); null until the first
      // read has happened. The alert rules read `storage` and nothing else here.
      storage: deps.nvrStorage?.get(n.id) ?? null
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
 *   dataDir, sender ({ deliver, test, pending }), lastBackup?, sysinfo? ({ sample }), now?, log?,
 *   nvrStorage? ({ get, refresh }: nvr-disks.mjs, what each NVR says about its own disks),
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
  const fresh = { snap: null, snapAt: 0, history: null, historyAt: 0 } // health(): the newest snapshot (the check's or a poll's) and history
  let timer = null
  let pruneTimer = null

  const record = (t, event, a) =>
    appendAlert(deps.dataDir, { at: t, event, key: a.key, kind: a.kind, title: a.title, detail: a.detail, severity: a.severity })

  function tick() {
    const t = now()
    // Fire and forget, and deliberately before the snapshot is built: asking the NVRs about their
    // disks takes seconds and happens at most every 10 minutes, so this check uses whatever the
    // last round left behind and the next check picks up the answer. The health poll must never
    // wait on an NVR.
    try {
      void deps.nvrStorage?.refresh()
    } catch (e) {
      log(`[alerts] could not ask the NVRs about their disks: ${e.message}`)
    }
    let snap
    try {
      snap = buildSnapshot(deps, t)
    } catch (e) {
      log(`[alerts] could not read the state: ${e.message}`)
      return
    }
    // the Health page and the banners are shown this one until it is SNAPSHOT_REUSE_MS old
    fresh.snap = snap
    fresh.snapAt = t
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
     * because the page is served to every signed-in user, not only admins. For anyone but an admin
     * server.mjs cuts it down further to the cameras they may see (health-view.mjs).
     */
    health() {
      // Health updates live (every 2 s), but the state is only rebuilt once the newest snapshot (the
      // alert check's or an earlier poll's) is SNAPSHOT_REUSE_MS old, rather than waiting for the next
      // alert check or rebuilding for every poll. The history file is re-read at most every 30 s.
      if (!fresh.snap || now() - fresh.snapAt >= SNAPSHOT_REUSE_MS) {
        fresh.snap = buildSnapshot(deps, now())
        fresh.snapAt = now()
      }
      const snap = fresh.snap
      let system = null
      try {
        system = deps.sysinfo?.sample() ?? null
      } catch (e) {
        // sample() promises not to throw, but the Health page must not die if that promise breaks.
        log(`[alerts] could not read the system figures: ${e.message}`)
      }
      let history = fresh.history ?? []
      if (!fresh.history || now() - fresh.historyAt > 30_000) {
        try {
          history = readAlerts(deps.dataDir, now() - HISTORY_SHOWN_DAYS * 86_400_000)
          fresh.history = history
          fresh.historyAt = now()
        } catch (e) {
          log(`[alerts] could not read the history: ${e.message}`)
        }
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
        backup: deps.lastBackup?.() ?? null,
        // Injected like every other collaborator so health() stays testable without a /proc.
        // Null when no sampler was given (tests, and any host that is not Linux).
        system
      }
    }
  }
}
