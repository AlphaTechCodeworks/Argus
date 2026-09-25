// Putting an NVR's clock right.
//
// Why this matters more than it looks: footage is only evidence if its time is believable. On
// 2026-09-25 these four NVRs disagreed by up to 27 minutes, three of them were set to "manually"
// so nothing ever corrected them, and one was on a different timezone from its neighbours
// (EST5EDT against AST4) which would have put that site an hour out every November. Two cameras
// whose clocks differ tell a story that did not happen.
//
// The route is editTimeCfg over TransparentConfig, not NET_SDK_ChangTime. It is exactly what the
// NVR's own web client sends, it travels the path this app already uses for picture and stream
// changes, and it needs no new C struct binding -- getting one of those wrong corrupts memory in
// this SDK, which is not a risk worth taking to set a clock.
//
// Safety, following the sub-stream codec change (substreams.mjs), which has proved reliable:
//   - the current settings are read again immediately before writing
//   - every field is sent back exactly as read except the ones being changed: these NVRs replace
//     the whole block, so a partial write silently wipes what it does not mention
//   - one NVR at a time under the shared change lock, so a clock write cannot collide with a
//     picture, stream or lens change
//   - the result is read back and compared, rather than assumed
//   - before and after are appended to data/clock-changes.log
//
//   GET  /api/admin/nvr-clocks              read every NVR's clock (nvr-probe.mjs)
//   POST /api/admin/nvrs/:id/clock          { timeZone?, daylight?, ntp?, ntpServer?, confirm: true }

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'
import { HttpError, XML_HEADER, transparent, withNvrLock } from './nvr-xml.mjs'
// the clock arithmetic and document building live apart so they can be tested without the SDK
import { buildTimeCfg, checkWanted, parseNvrTime, readClock, zoneOffsetMs } from './clock-time.mjs'

const LOG_FILE = join(DATA_DIR, 'clock-changes.log')
const READ_BACK_MS = 2000 // the NVR takes a moment to apply before it will report the new values

/**
 * Reads, writes and reads back one NVR's clock.
 * @returns {Promise<{before:object, sent:object, after:object, applied:boolean, warning?:string}>}
 */
export async function setClock(nvr, want, user) {
  const wanted = checkWanted(want)
  return withNvrLock(nvr, 'clock', async () => {
    const beforeXml = String((await transparent(nvr, 'queryTimeCfg', `${XML_HEADER}<request version="1.0" systemType="NVMS-9000" clientType="WEB"></request>`, 'clock before', { outBytes: 16 * 1024 })) ?? '')
    const before = readClock(beforeXml)
    if (!before.timeZone) throw new HttpError(502, 'the NVR did not report its clock settings; nothing was changed')

    const doc = buildTimeCfg(before, wanted)
    const reply = String((await transparent(nvr, 'editTimeCfg', doc, 'clock write', { outBytes: 16 * 1024 })) ?? '')
    if (!/<status>\s*success/i.test(reply)) {
      const code = /<errorCode>\s*(\d+)/.exec(reply)?.[1]
      throw new HttpError(502, `the NVR refused the change${code ? ` (code ${code})` : ''}; nothing was changed`)
    }

    await new Promise((r) => setTimeout(r, READ_BACK_MS))
    const afterXml = String((await transparent(nvr, 'queryTimeCfg', `${XML_HEADER}<request version="1.0" systemType="NVMS-9000" clientType="WEB"></request>`, 'clock after', { outBytes: 16 * 1024 })) ?? '')
    const after = readClock(afterXml)

    // Did it actually take? The NVR can answer "success" and keep its old settings.
    // timeMs and offsetMs are not settings the NVR reports back, so they are not compared here;
    // whether the clock actually moved is judged by the next drift check, not by this reply
    const applied = Object.entries(wanted).every(([k, v]) => {
      if (k === 'timeMs' || k === 'offsetMs') return true
      if (k === 'ntp') return after.sync === (v ? 'NTP' : 'manually')
      if (k === 'ntpServer') return after.ntpServer === v
      return after[k] === v
    })

    try {
      appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), nvr: nvr.id, by: user ?? '?', wanted, before, after, applied })}\n`, { mode: 0o600 })
    } catch { /* the change is done; failing to log it must not undo it */ }

    return {
      before,
      sent: wanted,
      after,
      applied,
      // NTP takes a few minutes to pull the clock in; saying so avoids "it did not work" a minute later
      warning: applied && wanted.ntp ? 'The clock itself may take a few minutes to come right once NTP is on.' : applied ? undefined : 'The NVR accepted the change but still reports its old settings.'
    }
  })
}

/**
 * POST /api/admin/nvrs/:id/clock
 * @returns {Promise<[number, object] | null>} null when this is not that route
 */
export async function handleClockWrite(method, pathname, readJson, nvrs, user) {
  const m = /^\/api\/admin\/nvrs\/([^/]+)\/clock$/.exec(pathname)
  if (!m) return null
  if (method !== 'POST') return [405, { error: 'Method not allowed' }]
  const nvr = nvrs.get(decodeURIComponent(m[1]))
  if (!nvr) return [404, { error: 'Unknown NVR' }]
  if (!nvr.online) return [409, { error: `${nvr.name} is offline` }]
  const body = await readJson()
  // A clock change alters how every recording from here on is stamped, so it is never a stray
  // request: the caller has to mean it.
  if (body?.confirm !== true) return [400, { error: 'confirm must be true: this changes how recordings are timestamped' }]
  try {
    return [200, await setClock(nvr, body, user)]
  } catch (e) {
    if (e instanceof HttpError) return [e.status, { error: e.message }]
    return [502, { error: e.message }]
  }
}

// ---- the server as master clock ----------------------------------------------
//
// The server keeps its own time by NTP and every server recording is stamped with it, so the
// server's clock is the one that matters. Rather than hope each NVR reaches a time server of its
// own, the server pushes its time out to them.
//
// This is better than NTP on the NVRs for three reasons:
//   - a remote site with no way out to the internet can still be kept right
//   - every NVR agrees with the server, which is what actually matters when footage from two
//     sites has to line up
//   - one clock to trust instead of five, and one place to see when one has drifted
//
// It corrects only when a clock has drifted past a threshold, so a healthy NVR is left alone.

const DRIFT_MS = 10_000 // leave a clock alone until it is this far out
const SYNC_EVERY_MS = 60 * 60_000 // check every hour
/**
 * Puts one NVR's clock to the server's, if it has drifted far enough to be worth writing.
 * @returns {Promise<{nvr:string, drift:number|null, changed:boolean, why:string}>} never throws
 */
export async function syncOne(nvr, { now = Date.now, driftMs = DRIFT_MS, user = 'clock sync' } = {}) {
  try {
    const xml = String((await transparent(nvr, 'queryTimeCfg', `${XML_HEADER}<request version="1.0" systemType="NVMS-9000" clientType="WEB"></request>`, 'clock check', { outBytes: 16 * 1024 })) ?? '')
    const cur = readClock(xml)
    if (cur.sync === 'NTP') return { nvr: nvr.id, drift: null, changed: false, why: 'it takes its time from NTP itself' }

    const offsetMs = zoneOffsetMs(cur.timeZone, cur.daylight)
    if (offsetMs === null) return { nvr: nvr.id, drift: null, changed: false, why: `its timezone (${cur.timeZone ?? 'unknown'}) is not one this can work out` }

    // what the NVR says its clock reads, read back as a moment
    const said = parseNvrTime(cur.currentTime, cur)
    const drift = said === null ? null : said - (now() + offsetMs)
    if (drift !== null && Math.abs(drift) < driftMs) {
      return { nvr: nvr.id, drift, changed: false, why: 'close enough to leave alone' }
    }

    const r = await setClock(nvr, { timeMs: now(), offsetMs, confirm: true }, user)
    return { nvr: nvr.id, drift, changed: true, why: r.applied ? 'put right' : 'the NVR accepted it but still reports the old time' }
  } catch (e) {
    return { nvr: nvr.id, drift: null, changed: false, why: `could not be checked: ${e.message.slice(0, 80)}` }
  }
}

/**
 * Checks every NVR every hour and corrects any that have drifted.
 * @returns {{ stop: () => void, runNow: () => Promise<object[]> }}
 */
export function startClockSync(nvrs, { everyMs = SYNC_EVERY_MS, startMs = 3 * 60_000, log = console.log, enabled = () => true } = {}) {
  const runNow = async () => {
    if (!enabled()) return []
    const out = []
    // one at a time: a clock write takes the NVR's change lock, and nothing here is urgent
    for (const nvr of nvrs.values()) {
      if (!nvr.online) continue
      const r = await syncOne(nvr)
      out.push(r)
      if (r.changed) log(`[clock] ${r.nvr}: ${r.why}${r.drift === null ? '' : ` (was ${Math.round(r.drift / 1000)} s out)`}`)
    }
    return out
  }
  const timer = setInterval(() => { runNow().catch(() => {}) }, everyMs)
  timer.unref?.()
  // A first pass shortly after start, not an hour later: a clock that is wrong is wrong now, and
  // waiting an hour to notice defeats the point. The delay lets the NVRs finish logging in first.
  const first = setTimeout(() => { runNow().catch(() => {}) }, startMs)
  first.unref?.()
  return { stop: () => { clearInterval(timer); clearTimeout(first) }, runNow }
}
