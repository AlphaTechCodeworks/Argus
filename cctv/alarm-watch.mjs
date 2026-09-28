// The cameras' own line-crossing alarms, seen within seconds.
//
// The recorded-file intake (events.mjs) finds a crossing only when it next reads that camera's file
// list: a median of 101 s on nvr1 and 1,218 s on value4u over the week to 2026-09-27. The NVR's live
// alarm list is much quicker. queryAlarmStatus, the command behind its web client's alarm status page,
// answers for every camera on the NVR in one small read (about 0.1 s): each AI alarm active right now
// is an item under content>intelligents with intelligentType (tripwire, pea, osc ...), sourceChl@id
// and alarmTime ("YYYY-MM-DD HH:MM:SS" in UTC, as the web client reads it). alarmTime is when the
// alarm started and stays put while it is active: nvr-2's answer of 2026-09-27 still listed a motion
// alarm 40 minutes after its alarmTime. Motion alarms are listed the same way under content>motions
// and are not used here: the recorded-file intake already covers motion.
//
// So every WATCH_EVERY_MS the watcher asks each online NVR that has at least one camera with lines
// switched on (tripwire.mjs keeps that list in lines-on.json) and hands each tripwire alarm on those
// cameras to onCrossing. It only reads, and only through the caller's `query` (nvr-xml.mjs transparent
// on the server), so the XML queue, the read breaker and the busy refusals all apply; a refusal only
// skips that NVR for that tick.
//
// Everything it touches is passed in (the NVR list, the lines list, the query, the clock), and it
// does not import nvr-xml.mjs, which loads the native SDK: the tests run on a PC without it.
import { chOfGuid, parseUtcText } from './nvr-log.mjs'
import { kid, kids, parseXml } from './xml.mjs'

export const WATCH_EVERY_MS = 5000
/** A failing NVR is logged at most this often: the watcher asks it every 5 s. */
export const FAIL_LOG_MS = 10 * 60_000
/** How an event found by the watcher says where it came from (events-db `source`). */
export const SOURCE_ALARM_STATUS = 'alarm-status'
const CROSSING_DETAIL = 'the camera’s own line-crossing alarm, read from the NVR’s live alarm list'

/**
 * The active AI alarms in a queryAlarmStatus answer, one per content>intelligents>item. An item whose
 * camera or time cannot be read is left out rather than guessed at. Motions and every other list in
 * the answer are ignored. Throws if the answer is not a document or the NVR refused the command.
 * @returns {Array<{ kind: string, chlId: string, ch: number, startMs: number }>}
 */
export function parseAlarmStatus(xml) {
  const response = kid(parseXml(String(xml ?? '')), 'response')
  if (!response) throw new Error('the NVR did not answer with a document')
  const status = (kid(response, 'status')?.text ?? '').trim()
  if (status && status !== 'success') throw new Error(`the NVR refused queryAlarmStatus (${status}, code ${(kid(response, 'errorCode')?.text ?? '').trim()})`)
  const out = []
  // direct children only: each item also lists its recorded channels as nested <item>s, and the list
  // starts with an <itemType> describing the enum
  for (const item of kids(kid(kid(response, 'content'), 'intelligents'), 'item')) {
    const chlId = String(kid(item, 'sourceChl')?.attrs?.id ?? '').trim()
    const ch = chOfGuid(chlId)
    const startMs = parseUtcText(kid(item, 'alarmTime')?.text ?? '')
    const kind = (kid(item, 'intelligentType')?.text ?? '').trim()
    if (!kind || !Number.isInteger(ch) || ch < 0 || startMs === null) continue
    out.push({ kind, chlId, ch, startMs })
  }
  return out
}

/** '<nvr id>/<ch>' keys (tripwire.mjs linesOn) -> Map of nvr id -> Set of 0-based channels. */
function camerasByNvr(keys) {
  const out = new Map()
  for (const key of keys ?? []) {
    const k = String(key)
    const at = k.lastIndexOf('/')
    const tail = k.slice(at + 1)
    const ch = Number(tail)
    if (at <= 0 || tail === '' || !Number.isInteger(ch) || ch < 0) continue
    const id = k.slice(0, at)
    if (!out.has(id)) out.set(id, new Set())
    out.get(id).add(ch)
  }
  return out
}

/**
 * Starts the watcher. Each tick asks every online, not recovering NVR with a camera in linesOn()
 * once, never while that NVR's previous query is still out, and reports each tripwire alarm on a
 * camera with lines on:
 *   onCrossing({ nvr, ch, type: 'line-crossing', subtype: 'tripwire', startMs, endMs, source: 'alarm-status', again })
 * again is false until an alarm (camera + start) has been filed (onCrossing returned without throwing)
 * and true on each later tick while the NVR still lists it; endMs is then startMs plus how long we
 * have seen it, measured on this server's clock so an NVR clock that is off cannot give an end before
 * the start. A failed query is
 * logged at most once per NVR per FAIL_LOG_MS and skipped; what was seen before it is kept, so an
 * alarm that outlasts a failure is not reported as new afterwards.
 *
 * @param {object} deps
 * @param {() => Iterable<object>} deps.nvrs         the NVRs (nvrs.mjs Nvr: id, name, online, degraded, stopped)
 * @param {() => Set<string>} deps.linesOn           '<nvr id>/<ch>' of every camera with lines switched on
 * @param {(nvr: object) => Promise<string>} deps.query  the queryAlarmStatus answer
 * @param {(e: object) => void} deps.onCrossing
 * @param {number} [deps.everyMs]
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]                  the clock (tests)
 * @param {() => boolean} [deps.sdkBusy]             true while any SDK call is overdue: nobody is asked
 * @returns {{ stop: () => void, tick: () => Promise<string[]> }} tick resolves to the ids of the NVRs it asked
 */
export function startAlarmWatch({ nvrs, linesOn, query, onCrossing, everyMs = WATCH_EVERY_MS, log = console.log, now = Date.now, sdkBusy = () => false }) {
  /** nvr id -> { busy, seen: Map('<ch>/<startMs>' -> first seen ms), fails, loggedAt, told } */
  const state = new Map()
  let stopped = false
  let listLoggedAt = -Infinity

  const stateOf = (id) => {
    let s = state.get(id)
    if (!s) state.set(id, (s = { busy: false, seen: new Map(), fails: 0, loggedAt: -Infinity, told: false }))
    return s
  }

  /** One NVR: one query, then each tripwire alarm on a camera with lines on. Never throws. */
  async function watchOne(nvr, cams) {
    const s = stateOf(nvr.id)
    s.busy = true
    try {
      let items
      try {
        items = parseAlarmStatus(await query(nvr))
      } catch (e) {
        s.fails++
        const nowMs = now()
        if (nowMs - s.loggedAt >= FAIL_LOG_MS) {
          s.loggedAt = nowMs
          s.told = true
          log(`[alarm-watch] ${nvr.id}: could not read the alarm list (${String(e?.message ?? e).slice(0, 120)}); until it answers, line crossings there are only found by the slower recorded-file intake (logged at most every ${FAIL_LOG_MS / 60_000} min)`)
        }
        return
      }
      if (stopped) return
      if (s.told) log(`[alarm-watch] ${nvr.id}: the alarm list answers again (after ${s.fails} failed ${s.fails === 1 ? 'read' : 'reads'})`)
      s.fails = 0
      s.told = false
      const nowMs = now()
      const seen = new Map()
      const tried = new Set()
      for (const it of items) {
        if (it.kind !== 'tripwire' || !cams.has(it.ch)) continue
        const key = `${it.ch}/${it.startMs}`
        if (tried.has(key)) continue // listed twice in one answer: still one alarm
        tried.add(key)
        const first = s.seen.get(key)
        try {
          onCrossing({
            nvr: nvr.id,
            ch: it.ch,
            type: 'line-crossing',
            subtype: 'tripwire',
            startMs: it.startMs,
            endMs: it.startMs + (first === undefined ? 0 : Math.max(0, nowMs - first)),
            source: SOURCE_ALARM_STATUS,
            again: first !== undefined
          })
          // remembered only once filed: an alarm whose first filing threw comes back as new (again:
          // false) on the next tick, so crossingHandler still hands a folded crossing to the rules
          seen.set(key, first ?? nowMs)
        } catch (e) {
          // filed before: still that alarm, its first sighting kept for its end
          if (first !== undefined) seen.set(key, first)
          log(`[alarm-watch] ${nvr.id}/${it.ch}: a crossing could not be filed: ${e?.message ?? e}`)
        }
      }
      // alarms no longer listed are forgotten: if the same camera and start ever came back it would be news
      s.seen = seen
    } finally {
      s.busy = false
    }
  }

  async function tick() {
    if (stopped) return []
    let busy = false
    try {
      busy = Boolean(sdkBusy())
    } catch {}
    // the SDK runs one call at a time for every NVR: a question now would only queue behind the overdue one
    if (busy) return []
    let cams
    try {
      cams = camerasByNvr(linesOn())
    } catch (e) {
      const nowMs = now()
      if (nowMs - listLoggedAt >= FAIL_LOG_MS) {
        listLoggedAt = nowMs
        log(`[alarm-watch] the list of cameras with lines could not be read: ${e?.message ?? e}`)
      }
      return []
    }
    const asked = []
    const runs = []
    const listed = new Set()
    for (const nvr of nvrs()) {
      listed.add(nvr.id)
      const mine = cams.get(nvr.id)
      if (!mine || !nvr.online || nvr.degraded || nvr.stopped) continue
      // its last query has not come back yet: never two at once to one NVR
      if (stateOf(nvr.id).busy) continue
      asked.push(nvr.id)
      runs.push(watchOne(nvr, mine))
    }
    // NVRs removed from the list take their memory with them
    for (const [id, s] of state) if (!listed.has(id) && !s.busy) state.delete(id)
    await Promise.all(runs)
    return asked
  }

  const timer = setInterval(() => {
    tick().catch((e) => log(`[alarm-watch] ${e?.message ?? e}`))
  }, everyMs)
  timer.unref?.()

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    tick
  }
}

/**
 * What the server does with one report from the watcher (nvrs.mjs passes the result as onCrossing):
 * store it with events-db addEvent, then call handle(event) only for a crossing not handled before.
 *   - a new row (isNew: true): always handled, whatever the watcher's own `again` says. `again` is
 *     only the watcher's memory of having filed this alarm before (watchOne remembers an alarm once
 *     onCrossing has returned, so a first attempt whose addEvent threw comes back as new), not what
 *     events-db holds: events-db's own isNew is the only source of truth for whether the notifier has
 *     seen this row.
 *   - not new, and the row returned starts at another time: events-db merged this crossing into the
 *     camera's previous line-crossing event (within 30 s) and extended it: handled again, so the
 *     rules see it and its bookmark grows (the notifier itself never sends one event twice).
 *   - not new, and the same alarm seen on a later tick (again), or a row already there with this very
 *     start (the server restarted while the alarm was still listed): addEvent has moved its end on;
 *     grew is called (a long alarm's bookmark can follow its end) but the rules and the notifier are not.
 * @param {{ addEvent: Function, handle: (event: object) => void, grew?: ((event: object) => void)|null, now?: () => number }} deps
 * @param {(event: object) => void} [deps.grew]  called with the stored row when a known alarm is seen
 *   again; not for the rules or the notifier
 * @returns {(e: object) => object|null} the event handed to handle, or null
 */
export function crossingHandler({ addEvent, handle, grew = null, now = Date.now }) {
  return (e) => {
    const { again, ...row } = e
    const { event, isNew } = addEvent({ ...row, detail: CROSSING_DETAIL }, now())
    if (!event) return null
    // a row events-db had not stored before is always handled: isNew is what the notifier has
    // actually seen, and it is not to be second-guessed by the watcher's own again bookkeeping
    if (!isNew && (again || event.startMs === row.startMs)) {
      grew?.(event)
      return null
    }
    handle(event)
    return event
  }
}
