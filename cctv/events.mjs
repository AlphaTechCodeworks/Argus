// Event intake: finding out what the NVRs saw, and writing it into the recordings database.
//
// ---------------------------------------------------------------------------------------------
// WHAT IS CONFIRMED AND WHAT IS NOT — read this before trusting anything in this file
// ---------------------------------------------------------------------------------------------
//
// CONFIRMED, and what the running code uses:
//   The NVR's own recorded-file search already tells us why it recorded. playback.mjs asks
//   NET_SDK_FindFile for a channel and a day and gets back one entry per file with a `dwRecType`
//   bitmask; it has been doing this since phase 2 to draw the timeline, and motion.mjs uses the
//   same answer to decide where to look for movement. The bits are documented by the vendor in
//   docs/include/dvrdvstypedef.h (DD_RECORD_TYPE): motion is 0x4, sensor 0x8, occlusion 0x20,
//   tripwire 0x400, area intrusion 0x800, face 0x1000, POS 0x2000, and so on. So "the NVR recorded
//   this stretch because of motion" is a fact we can already read, from a call this app makes
//   hundreds of times a day. That is the intake this module runs.
//
//   Camera offline is confirmed too, and comes from this server rather than from any NVR: the
//   channel list already says whether a camera is online, and a camera that was online and now is
//   not is an event by anybody's definition.
//
// NOT CONFIRMED, and therefore not built on:
//   A live event subscription — the NVR telling us the moment something happens, with the class of
//   object it thinks it saw. These NVRs advertise supportFaceMatch, supportPlateMatch and
//   supportPOS, and the SDK library's own strings contain a set of likely command names (listed in
//   EVENT_PROBES below) together with C entry points NET_SDK_SetupAlarmChan, NET_SDK_SmartSubscrib
//   and NET_SDK_FindEvent. That is evidence the capability exists. It is NOT evidence that any
//   particular command name works on these boxes, in what shape, or what it answers with.
//
//   So: nothing here calls those names in anger. probeEvents() tries them once, read-only, and
//   reports what came back, exactly the way the disk-health command was found (nvr-disks.mjs
//   probeSmart: twelve names tried, one answered with XML instead of a bare failure). Until a run
//   against the real NVRs says which name answers, "person" and "vehicle" report as NOT AVAILABLE.
//   A page that invents a person walking past a camera is worse than no page at all.
//
//   Run it with:  GET /api/admin/nvrs/<id>/event-probe        (admin, read-only, one NVR)
//
//
// WIRING (the one thing still to do by hand). This phase adds no line to server.mjs, so the routes
// below are not reachable until somebody adds two lines to it, beside the existing handleClocks
// call. They return [status, body] (optionally headers) or null, exactly like handleClocks, so:
//
//   import { handleEvents } from './events.mjs'
//   import { handleAlarms } from './alarms.mjs'
//   ...inside handleRequest, beside the other handlers:
//   const ev = await handleEvents(req.method, pathname + url.search, () => readJsonObject(req, 4096),
//     { nvrs, user, admin: AUTH_OFF || auth.isAdmin(user), intake: null })
//   if (ev) return sendJson(res, ...ev)
//   const al = await handleAlarms(req.method, pathname + url.search, () => readJsonObject(req, 8192),
//     { user, admin: AUTH_OFF || auth.isAdmin(user), cameras: allCameras })
//   if (al) return sendJson(res, ...al)
//
// Event intake, the notifier and the window feed are already started by nvrs.mjs startNvrs().
// ---------------------------------------------------------------------------------------------
// BEING GENTLE WITH THESE PARTICULAR NVRs
// ---------------------------------------------------------------------------------------------
// nvr-2 is at its bandwidth ceiling and actively refuses streams; rigginglot took 37 seconds over a
// routine SDK call on a link that pings in 10 ms. Nothing in this phase is urgent — an event that
// arrives two minutes late is still useful — so the poller:
//   - asks one camera at a time, never a burst, and rests between cameras
//   - skips an NVR that is offline, degraded, refusing streams, or already busy with a search
//   - runs one pass at a time, and asks nobody while any SDK call in this process is overdue: the
//     SDK runs one call at a time for every NVR, so a question to another NVR only queues behind
//     the stuck call (on 09-27 six such questions turned one stuck FindRecDate into a restart)
//   - backs off exponentially on every failure and does not come back for a while
//   - runs at the lane's LOW priority through the playback search the timeline already uses, so it
//     queues behind live video rather than in front of it
//   - asks only for the stretch since the newest event it already holds, not the whole month
import { XML_HEADER, kid, kids, parseXml } from './xml.mjs'
import { typesFromRecordBits } from './event-rules.mjs'
import { addEvent, lastEventMs } from './events-db.mjs'

const OUT_BYTES = 64 * 1024

/** A plain query: this dialect wants the whole <request> document even with nothing to say. */
export const emptyRequest = () => `${XML_HEADER}</request>`

/**
 * The real send. nvr-xml.mjs is imported only when a query is actually made, because it loads the
 * native SDK (a Linux .so) and the offline tests import this module on a Windows PC.
 */
export const sdkQuery = async (nvr, url, xml, tag) => {
  const { transparent } = await import('./nvr-xml.mjs')
  return transparent(nvr, url, xml, tag, { outBytes: OUT_BYTES })
}

// ---- the hunt for an event command --------------------------------------------------------------

/**
 * The candidate command names, with why each one is a candidate.
 *
 * Every name here was read out of the SDK library's own string table
 * (bin/linux/libdvrnetsdk.so), not invented: these are names the vendor's code knows about. That
 * makes them worth trying. It does not make any of them the right one, and none of them is used by
 * the running code until a probe against a real NVR shows it answering.
 *
 * The test that matters, and the one that found queryDiskSmartInfo: a command the firmware does not
 * have comes back as a bare failure with no document at all, while a command it does have answers
 * with XML — even when that XML is a complaint about the request we sent it. An errorCode is a
 * result. Nothing is a dead end.
 */
export const EVENT_PROBES = Object.freeze([
  { cmd: 'queryLog', why: 'the NVR’s own event log — the strings LOG_ALARM_MOTION, LOG_ALARM_INTELLIGENT, LOG_ALARM_FACE_MATCH and LOG_ALARM_VEHICLE_PLATE_MATCH sit beside it, so it may list exactly the events we want, with times' },
  { cmd: 'queryEventNotifyParam', why: 'event notification settings; would say which events this NVR is configured to report at all' },
  { cmd: 'queryAlarmStatus', why: 'what is in alarm right now (the state, not the history)' },
  { cmd: 'queryAlarmIn', why: 'the alarm inputs and what each one is wired to' },
  { cmd: 'searchSmartTarget', why: 'the only candidate that could carry the class of object — person or vehicle. If this answers, ai-person and ai-vehicle become possible; if it does not, they stay unavailable' },
  { cmd: 'queryChSnapFaceImageList', why: 'faces the NVR snapped, with times (supportFaceMatch is advertised true)' },
  { cmd: 'queryFaceMatchAlarm', why: 'face-match alarm settings and, possibly, matches' },
  { cmd: 'queryVfd', why: 'face detection configuration per camera' },
  { cmd: 'queryMotion', why: 'motion zones and sensitivity per camera (also what the motion tuning view reads)' },
  { cmd: 'queryChlVideoLossStatus', why: 'which cameras have lost their picture' },
  { cmd: 'queryVideoLossTrigger', why: 'what a video loss is set to trigger' },
  { cmd: 'queryRecStatus', why: 'which channels are recording right now, and possibly why' },
  { cmd: 'queryRecordScheduleList', why: 'the NVR’s own event-recording schedule per channel' }
])

/** Just the names, for a caller that wants to probe a subset. */
export const EVENT_PROBE_NAMES = Object.freeze(EVENT_PROBES.map((p) => p.cmd))

/**
 * Request shapes to try for a command that wants to be told something. Several of these NVRs'
 * commands refuse a bodyless request and answer only when given a condition, which is exactly how
 * queryDiskSmartInfo behaved. `fromMs`/`toMs` bound a log search to something small.
 */
export function probeShapes({ fromMs, toMs } = {}) {
  const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
  const shapes = [['no body', emptyRequest()]]
  if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
    shapes.push(
      ['condition/startEndTime', `${XML_HEADER}<condition><startTime>${stamp(fromMs)}</startTime><endTime>${stamp(toMs)}</endTime></condition></request>`],
      ['condition + requireField', `${XML_HEADER}<condition><startTime>${stamp(fromMs)}</startTime><endTime>${stamp(toMs)}</endTime></condition><requireField><logType/><time/><chl/><content/></requireField></request>`],
      ['condition with pageIndex', `${XML_HEADER}<condition><startTime>${stamp(fromMs)}</startTime><endTime>${stamp(toMs)}</endTime><pageIndex>0</pageIndex><pageSize>20</pageSize></condition></request>`]
    )
  }
  shapes.push(['requireField only', `${XML_HEADER}<requireField><name/><time/><chl/></requireField></request>`])
  return shapes
}

const answerOf = (xml) => {
  const response = kid(parseXml(xml), 'response')
  if (!response) throw new Error('no <response> element')
  return {
    status: kid(response, 'status')?.text.trim() ?? '',
    errorCode: kid(response, 'errorCode')?.text.trim() ?? ''
  }
}

/**
 * Tries each candidate command once and hands back exactly what came back, raw.
 *
 * Read-only: every name in EVENT_PROBES is a query, nothing is written, and this is safe to run
 * against a live site. Never throws — a command that fails is a result, and the next is still
 * tried. It rests between commands so a probe cannot itself become the load that tips nvr-2 over.
 *
 * @param {object} nvr
 * @param {(nvr, url, xml, tag) => Promise<string>} query   sdkQuery, or a fake in the tests
 * @param {{candidates?: object[], fromMs?: number, toMs?: number, restMs?: number, sleep?: Function}} [opts]
 * @returns {Promise<{nvr: string, ranAt: number, results: object[]}>}
 */
export async function probeEvents(nvr, query, { candidates = EVENT_PROBES, fromMs = null, toMs = null, restMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const to = Number.isFinite(toMs) ? toMs : Date.now()
  const from = Number.isFinite(fromMs) ? fromMs : to - 6 * 3_600_000
  const results = []
  for (const c of candidates) {
    const tried = []
    for (const [shape, doc] of probeShapes({ fromMs: from, toMs: to })) {
      const t0 = Date.now()
      try {
        const xml = String((await query(nvr, c.cmd, doc, `event probe ${c.cmd}`)) ?? '')
        let status = ''
        let errorCode = ''
        try {
          const a = answerOf(xml)
          status = a.status
          errorCode = a.errorCode
        } catch (e) {
          status = `unparsable: ${e.message}`
        }
        // The distinction that matters: XML of any kind means the firmware knows this command.
        tried.push({ shape, ms: Date.now() - t0, answeredXml: /<response/i.test(xml), ok: status === 'success', status, errorCode, sent: doc, xml: xml.replace(/>\s+</g, '><').slice(0, 4000) })
        if (status === 'success') break
      } catch (e) {
        tried.push({ shape, ms: Date.now() - t0, answeredXml: false, ok: false, status: 'failed', error: e?.message ?? String(e), sent: doc })
      }
      await sleep(restMs)
    }
    results.push({
      cmd: c.cmd,
      why: c.why,
      // "known" is the finding to act on: the firmware has this command, whatever it made of our
      // request. "supported" means one of the shapes was actually accepted.
      known: tried.some((t) => t.answeredXml),
      supported: tried.some((t) => t.ok),
      tried
    })
    await sleep(restMs)
  }
  return { nvr: nvr?.id ?? null, ranAt: Date.now(), results }
}

/**
 * A plain-English reading of a probe run, so the answer can be acted on without reading XML.
 * It states what is still not available rather than guessing at what might be.
 */
export function summariseProbe(run) {
  const results = run?.results ?? []
  const known = results.filter((r) => r.known).map((r) => r.cmd)
  const working = results.filter((r) => r.supported).map((r) => r.cmd)
  return {
    known,
    working,
    // The one question this probe exists to answer.
    objectClassAvailable: working.includes('searchSmartTarget'),
    verdict: working.length
      ? `${working.join(', ')} answered successfully. Read the XML before anything is built on it.`
      : known.length
        ? `No command was accepted, but ${known.join(', ')} exist on this firmware (they answered with XML). The request shape is wrong, not the name.`
        : 'No candidate command answered with XML. Live event subscription is not available on this NVR through these names; intake stays on the recorded-event index.'
  }
}

// ---- the intake that actually runs --------------------------------------------------------------

/** How a stored event says where it came from. */
export const SOURCE_RECORDINGS = 'nvr-recordings'
export const SOURCE_SERVER = 'server'

/**
 * The events in one camera-day's recorded-file list.
 *
 * `recs` is exactly what playback.mjs's recordings() answers: { ranges, events } where each event
 * is [startMs, endMs, typeBits]. One recorded file can carry several reasons at once (motion AND
 * tripwire), and each becomes its own row, because "what happened" and "how long it lasted" are
 * different questions and the page needs both.
 *
 * Pure, so the mapping is tested without an NVR.
 * @returns {object[]} rows ready for addEvent
 */
export function eventsFromRecordings(nvrId, ch, recs) {
  const out = []
  for (const [start, end, bits] of recs?.events ?? []) {
    if (!Number.isFinite(start)) continue
    for (const { type, subtype } of typesFromRecordBits(bits)) {
      out.push({
        nvr: nvrId,
        ch: Number(ch),
        type,
        subtype,
        startMs: Math.round(start),
        endMs: Number.isFinite(end) ? Math.round(end) : null,
        source: SOURCE_RECORDINGS,
        detail: `the NVR recorded this stretch (type 0x${Number(bits).toString(16)})`
      })
    }
  }
  return out
}

/**
 * Cameras that have just gone offline or come back, by comparing the last seen state with this one.
 * Pure. The caller keeps `prev` (a Map of camera key -> online) between calls.
 * @returns {{ events: object[], state: Map<string, boolean> }}
 */
export function offlineEvents(prev, cameras, nowMs) {
  const state = new Map()
  const events = []
  for (const c of cameras ?? []) {
    const key = `${c.nvr ?? c.nvrId}/${c.ch}`
    const online = c.online !== false
    state.set(key, online)
    const was = prev?.get(key)
    // Only a real change counts. A camera that has been offline since before the server started is
    // not news every 30 seconds, and the Health page already says so.
    if (was === true && !online) {
      events.push({
        nvr: c.nvr ?? c.nvrId,
        ch: Number(c.ch),
        type: 'camera-offline',
        subtype: '',
        startMs: Math.round(nowMs),
        endMs: null,
        source: SOURCE_SERVER,
        detail: `${c.name ?? `camera ${Number(c.ch) + 1}`} stopped being online`
      })
    }
  }
  return { events, state }
}

// ---- the poller ----------------------------------------------------------------------------------

/** Never ask one NVR more often than this, however many cameras it has. */
export const MIN_POLL_MS = 60_000
/** Rest between cameras, so a pass is a trickle rather than a burst. */
export const CAMERA_REST_MS = 3000
/** Backoff after a failure: doubles each time, from a minute up to an hour. */
export const BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000]
/** How far back a first-ever poll of a camera looks. Not a month: that would be a very long search. */
export const FIRST_LOOK_MS = 6 * 3_600_000

/** The delay after `fails` consecutive failures. */
export const backoffFor = (fails) => BACKOFF_MS[Math.min(Math.max(0, fails - 1), BACKOFF_MS.length - 1)]

/**
 * Whether an NVR should be asked at all right now. Every "no" here is a reason not to add load to a
 * box that is already struggling, and is returned as a sentence so the Events page can say why
 * intake is quiet rather than looking broken.
 * @returns {{ ok: boolean, why: string }}
 */
export function pollable(nvr, nowMs, { nextAt = 0, fails = 0, sdkBusy = false } = {}) {
  if (!nvr) return { ok: false, why: 'unknown NVR' }
  if (!nvr.online) return { ok: false, why: `${nvr.name ?? nvr.id} is offline` }
  // process-wide: whichever NVR the overdue call belongs to, a search here would queue behind it
  if (sdkBusy) return { ok: false, why: 'waiting: an NVR call is overdue, and any question now would only queue behind it' }
  if (nvr.degraded) return { ok: false, why: `${nvr.name ?? nvr.id} is busy or recovering` }
  if (nvr.stopped) return { ok: false, why: 'the NVR has been stopped' }
  // A box refusing streams is a box with nothing to spare; a search would only make it worse.
  if ((nvr.refusalsLast10Min ?? 0) >= 3) return { ok: false, why: `${nvr.name ?? nvr.id} is refusing streams; leaving it alone` }
  if (nowMs < nextAt) return { ok: false, why: fails ? `backing off after ${fails} failed ${fails === 1 ? 'try' : 'tries'}` : 'asked recently' }
  return { ok: true, why: '' }
}

/**
 * The NVR-local days a stretch of time covers, as YYYY-MM-DD, because the recorded-file search is
 * asked per local day. Capped, so a camera nobody polled for a month does not ask for 30 searches
 * in one pass — it catches up a few days at a time instead.
 */
export function daysToAsk(fromMs, toMs, tzOffsetMs = 0, maxDays = 2) {
  const DAY = 86_400_000
  const out = []
  const last = Math.floor((toMs + tzOffsetMs) / DAY) * DAY
  const first = Math.max(Math.floor((fromMs + tzOffsetMs) / DAY) * DAY, last - (maxDays - 1) * DAY)
  // The newest days are the ones that matter; an older one waits for the next pass, which is how a
  // camera nobody polled for a month catches up a couple of days at a time instead of asking for
  // thirty searches in one go.
  for (let d = first; d <= last; d += DAY) out.push(new Date(d).toISOString().slice(0, 10))
  return out
}

/**
 * The event poller.
 *
 * It holds no timer of its own beyond the interval it is started with, and every pass does at most
 * one camera on at most one NVR. That is deliberately slow: at one camera every few seconds a site
 * of forty cameras comes round every couple of minutes, which is fast enough for an alarm list and
 * slow enough that nobody watching live video notices.
 *
 * @param {object} deps
 * @param {() => object[]} deps.listNvrs
 * @param {(nvr: object) => Array<{ch: number, name?: string, online?: boolean}>} deps.camerasOf
 * @param {(nvr: object, ch: number, date: string) => Promise<{events: Array}>} deps.recordings
 *   the NVR's recorded-file search — nvr.playback.recordings, or a fake in the tests
 * @param {(nvr: object) => Promise<{tzOffsetMs: number}>} [deps.clock]
 * @param {(event: object) => void} [deps.onEvent] called for each newly stored event (the rules run here)
 * @param {() => number} [deps.now]
 * @param {(line: string) => void} [deps.log]
 * @param {() => boolean} [deps.sdkBusy] true while any SDK call in this process is overdue
 *   (sdk.mjs lateCalls() > 0): then no NVR is asked at all
 */
export function makeEventIntake({ listNvrs, camerasOf, recordings, clock = null, onEvent = () => {}, now = Date.now, log = console.log, store = { addEvent, lastEventMs }, sdkBusy = () => false }) {
  /** nvr id -> { nextAt, fails, queue: [ch], lastWhy } */
  const state = new Map()
  let offline = new Map() // camera key -> online, for the offline/online comparison
  // A pass still waiting (its clock read or search queued behind a slow call) when the next 5 s
  // tick comes: that tick does nothing. Without this each tick asked another NVR's clock, and
  // every one of those queued behind the same stuck call.
  let ticking = false

  const stateOf = (id) => {
    let s = state.get(id)
    if (!s) state.set(id, (s = { nextAt: 0, fails: 0, queue: [], lastWhy: '' }))
    return s
  }

  /** One camera on one NVR. Never throws. @returns {Promise<{stored: number, why: string}>} */
  async function pollCamera(nvr, ch) {
    const nowMs = now()
    const tzOffsetMs = clock ? (await clock(nvr).catch(() => ({ tzOffsetMs: 0 }))).tzOffsetMs ?? 0 : 0
    const since = store.lastEventMs(nvr.id, ch) ?? nowMs - FIRST_LOOK_MS
    let stored = 0
    for (const date of daysToAsk(since, nowMs, tzOffsetMs)) {
      const recs = await recordings(nvr, ch, date)
      for (const e of eventsFromRecordings(nvr.id, ch, recs)) {
        // Everything already held is skipped by the unique key, so a re-read costs one insert that
        // changes nothing rather than a duplicate row.
        const { event, isNew } = store.addEvent(e, nowMs)
        if (isNew && event) {
          stored++
          onEvent(event)
        }
      }
    }
    return { stored, why: '' }
  }

  /** One pass: the first NVR that may be asked gets one camera asked. */
  async function pass() {
    const nowMs = now()
    let busy = false
    try {
      busy = Boolean(sdkBusy())
    } catch {}
    for (const nvr of listNvrs()) {
      const s = stateOf(nvr.id)
      const can = pollable(nvr, nowMs, { nextAt: s.nextAt, fails: s.fails, sdkBusy: busy })
      if (!can.ok) {
        // A backoff reason must not paper over the failure that caused it: status() shows the
        // failure while one is outstanding, because 'asked recently' explains nothing.
        s.lastWhy = can.why
        continue
      }
      if (!s.queue.length) s.queue = camerasOf(nvr).map((c) => (typeof c === 'number' ? c : c.ch)).filter((c) => Number.isInteger(c))
      const ch = s.queue.shift()
      if (ch === undefined) {
        s.lastWhy = 'this NVR reports no cameras'
        s.nextAt = nowMs + MIN_POLL_MS
        continue
      }
      try {
        const r = await pollCamera(nvr, ch)
        s.fails = 0
        s.lastWhy = ''
        s.lastError = null
        // The rest is per camera; the whole-NVR minimum only applies once the list is exhausted.
        s.nextAt = nowMs + (s.queue.length ? CAMERA_REST_MS : MIN_POLL_MS)
        return { nvr: nvr.id, ch, stored: r.stored }
      } catch (e) {
        s.fails++
        s.lastWhy = `could not be asked: ${String(e?.message ?? e).slice(0, 80)}`
        s.lastError = s.lastWhy
        s.nextAt = nowMs + backoffFor(s.fails)
        s.queue = [] // start the list again next time rather than skipping the rest of the cameras
        log(`[events] ${nvr.id}/${ch + 1}: ${s.lastWhy}; next try in ${Math.round(backoffFor(s.fails) / 60_000)} min`)
        return { nvr: nvr.id, ch, stored: 0, error: s.lastWhy }
      }
    }
    return null
  }

  return {
    /**
     * One pass: at most one camera on one NVR. Returns what it did, so a caller (and the tests) can
     * see that a quiet intake is quiet for a reason rather than broken. null: nothing was asked
     * (also while the previous pass is still waiting).
     */
    async tick() {
      if (ticking) return null
      ticking = true
      try {
        return await pass()
      } finally {
        ticking = false
      }
    },

    /** Compares camera online state with the last pass and files anything that changed. */
    checkOffline(cameras) {
      const nowMs = now()
      const { events, state: next } = offlineEvents(offline, cameras, nowMs)
      offline = next
      const out = []
      for (const e of events) {
        const { event, isNew } = store.addEvent(e, nowMs)
        if (isNew && event) {
          out.push(event)
          onEvent(event)
        }
      }
      return out
    },

    /** What intake is doing per NVR, for the page. Never invents a healthy-looking silence. */
    status: () =>
      listNvrs().map((nvr) => {
        const s = stateOf(nvr.id)
        return {
          nvr: nvr.id,
          name: nvr.name ?? nvr.id,
          // The honest headline: this is the only source confirmed to work on these boxes.
          source: SOURCE_RECORDINGS,
          nextAt: s.nextAt,
          fails: s.fails,
          why: s.lastError || s.lastWhy || (nvr.online ? '' : `${nvr.name ?? nvr.id} is offline`),
          available: Boolean(nvr.online) && s.fails === 0
        }
      })
  }
}

/**
 * What this app can and cannot report, in the form the Alarms page prints at the bottom of its
 * filter list. Everything unconfirmed is named, with what it would take to confirm it.
 */
export function sourceReport() {
  return {
    confirmed: [
      { what: 'Motion, tamper, sensor, face, POS and the NVR’s smart detections', how: 'the NVR’s own recorded-file types (DD_RECORD_TYPE), read by the same search that draws the timeline' },
      { what: 'Camera offline', how: 'this server noticing a camera stop being online' }
    ],
    notAvailable: [
      { what: 'Person and vehicle detection', why: 'the recorded-file types say something intelligent happened, not what class of object it was', toConfirm: 'GET /api/admin/nvrs/<id>/event-probe — if searchSmartTarget answers, this becomes possible' },
      { what: 'Number plate matches', why: 'supportPlateMatch is advertised, but no command name for reading matches has been confirmed on these boxes', toConfirm: 'the same probe route' },
      { what: 'Live event push (an event the moment it happens)', why: 'no subscription command has been confirmed; intake polls the recorded-file index instead, so an event appears within a couple of minutes rather than instantly', toConfirm: 'the same probe route, plus the SDK’s NET_SDK_SetupAlarmChan / NET_SDK_SmartSubscrib entry points' }
    ]
  }
}

// ---- the routes ------------------------------------------------------------------------------------

const NO_STORE = { 'cache-control': 'no-store' }
// Number(null) and Number('') are both 0, and a 0 nobody asked for is a window that ends at the
// epoch: a missing parameter has to come back as null, never as a number.
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * The event routes. Same shape as handleClocks in nvr-probe.mjs: [status, body] (optionally with
 * headers) or null when the path is not one of these, so server.mjs needs one line to wire it in
 * and nothing in this file has to know how the server is built.
 *
 *   GET  /api/events?from=&to=&limit=            events, newest first (everyone signed in)
 *   GET  /api/events/sources                     what intake can and cannot report
 *   GET  /api/admin/nvrs/:id/event-probe         the read-only command hunt (admins)
 *   GET  /api/admin/nvrs/:id/channels/:ch/motion-tune    the NVR's motion settings (admins)
 *   POST /api/admin/nvrs/:id/channels/:ch/motion-tune    { threshold, confirm: true } (admins)
 *
 * @param {string} method
 * @param {string} pathname   with or without its query string
 * @param {() => Promise<object>} readJson
 * @param {{nvrs: Map, user?: string, admin?: boolean, intake?: object, query?: Function}} deps
 * @returns {Promise<[number, object, object?] | null>}
 */
export async function handleEvents(method, pathname, readJson, deps = {}) {
  const [path, search = ''] = String(pathname ?? '').split('?')
  const { nvrs, user = null, admin = false, intake = null, query = sdkQuery, canSee = () => true } = deps

  if (path === '/api/events/sources') {
    if (method !== 'GET') return [405, { error: 'Method not allowed' }]
    return [200, { ...sourceReport(), intake: intake?.status?.() ?? [] }, NO_STORE]
  }

  if (path === '/api/events') {
    if (method !== 'GET') return [405, { error: 'Method not allowed' }]
    if (!user) return [401, { error: 'Not signed in' }, NO_STORE]
    const p = new URLSearchParams(search)
    const { listEvents } = await import('./events-db.mjs')
    return [200, {
      // only cameras this user may see (rights.mjs, via server.mjs)
      events: listEvents({ fromMs: num(p.get('from')), toMs: num(p.get('to')), limit: num(p.get('limit')) ?? 500 }).filter((e) => canSee(e.nvr, e.ch)),
      sources: sourceReport()
    }, NO_STORE]
  }

  const probe = /^\/api\/admin\/nvrs\/([^/]+)\/event-probe$/.exec(path)
  if (probe) {
    if (method !== 'GET') return [405, { error: 'Method not allowed' }]
    if (!admin) return [403, { error: 'Admins only' }]
    const nvr = nvrs?.get(decodeURIComponent(probe[1]))
    if (!nvr) return [404, { error: 'Unknown NVR' }]
    if (!nvr.online) return [409, { error: `${nvr.name ?? nvr.id} is offline` }]
    const run = await probeEvents(nvr, query)
    return [200, { ...run, summary: summariseProbe(run) }, NO_STORE]
  }

  const tune = /^\/api\/admin\/nvrs\/([^/]+)\/channels\/(\d{1,3})\/motion-tune$/.exec(path)
  if (tune) {
    if (!admin) return [403, { error: 'Admins only' }]
    const nvr = nvrs?.get(decodeURIComponent(tune[1]))
    if (!nvr) return [404, { error: 'Unknown NVR' }]
    if (!nvr.online) return [409, { error: `${nvr.name ?? nvr.id} is offline` }]
    const ch = Number(tune[2])
    const { readMotion, writeMotionThreshold } = await import('./motion-tune.mjs')
    try {
      if (method === 'GET') return [200, await readMotion(nvr, ch, query), NO_STORE]
      if (method === 'POST') {
        const body = await readJson()
        // A threshold change is a WRITE to somebody else's NVR. It is never a stray request.
        if (body?.confirm !== true) {
          return [400, { error: 'confirm must be true: this changes a setting on the NVR itself, for this camera' }]
        }
        return [200, await writeMotionThreshold(nvr, ch, body, user, query), NO_STORE]
      }
      return [405, { error: 'Method not allowed' }, { allow: 'GET, POST' }]
    } catch (e) {
      const { errorAnswer } = await import('./nvr-xml.mjs')
      return errorAnswer(e)
    }
  }

  return null
}

/** Reading a list answer defensively: the children of whichever container the firmware used. */
export function itemsOf(xml) {
  const response = kid(parseXml(xml), 'response')
  const content = kid(response, 'content')
  if (!content) return []
  const direct = kids(content, 'item')
  if (direct.length) return direct
  // some firmware wraps the list in a named element (logList, chlList, ...)
  for (const c of content.children) {
    const inner = kids(c, 'item')
    if (inner.length) return inner
  }
  return []
}
