// The rules about events and alarms: what an event is called, which rule matches it, how urgent
// that makes it, when it is worth waking somebody, and which stretch of footage an event asks the
// recorder to keep.
//
// Pure: no I/O, no timers, and above all no SDK. Everything in phase 7 that can be
// decided by thinking rather than by asking an NVR lives here, because the SDK is a Linux .so and
// the tests have to run on the Windows machine this is written on. events.mjs and alarms.mjs do
// the talking; this module does the deciding.
//
// The honesty rule that runs through the whole phase: a kind of event we have not confirmed these
// NVRs can report is never invented. There is no "person" or "vehicle" here that came from a guess;
// see EVENT_TYPES below and the discovery notes in events.mjs.
//
// The priorities and the words for each kind of event come from public/alarms-view.js, which the
// Alarms page also loads — the same arrangement bookmarks.mjs has with public/bookmarks-view.js, so
// the page and the server cannot drift apart about what an alarm is called or how urgent it is.
import { DEFAULT_PRIORITY, EVENT_KINDS, PRIORITIES, labelOf, priorityRank } from './public/alarms-view.js'

export { DEFAULT_PRIORITY, PRIORITIES, labelOf, priorityRank }

/**
 * Where each kind of event could actually come from. The kinds themselves, their words and whether
 * they are confirmed live in public/alarms-view.js, which the Alarms page loads too; this adds the
 * evidence for each one, which is server-side reasoning and no use to the page.
 */
const FROM = Object.freeze({
  motion: 'the NVR’s own motion recordings (DD_RECORD_TYPE_MOTION)',
  'camera-offline': 'this server: the camera stopped being online',
  'video-loss': 'the NVR’s video-loss recordings (DD_RECORD_TYPE)',
  tamper: 'the NVR’s occlusion recordings (DD_RECORD_TYPE_SHELTER)',
  sensor: 'the NVR’s sensor recordings (DD_RECORD_TYPE_SENSOR)',
  ai: 'the NVR’s intelligent recordings (tripwire, intrusion, object, exception)',
  face: 'the NVR’s face recordings (DD_RECORD_TYPE_VFD)',
  pos: 'the NVR’s POS recordings (DD_RECORD_TYPE_POS)',
  // The two people ask for by name, and exactly the two this app cannot produce. The recorded-event
  // index says "something intelligent happened", not what class of object it was.
  'ai-person': 'needs a confirmed per-target query; see events.mjs EVENT_PROBES',
  'ai-vehicle': 'needs a confirmed per-target query; see events.mjs EVENT_PROBES',
  plate: 'needs a confirmed plate query; see events.mjs EVENT_PROBES',
  // Whatever the NVR recorded that we have no name for. Better a row saying "the NVR called this
  // 0x8000" than a row that quietly calls it motion.
  'nvr-event': 'a recording type bit this app does not have a name for'
})

/** Every kind of event, with its words, whether it is confirmed, and the evidence for it. */
export const EVENT_TYPES = Object.freeze(EVENT_KINDS.map((k) => Object.freeze({ ...k, from: FROM[k.type] ?? 'unknown' })))

/** Every type name, for validation. */
export const TYPE_NAMES = Object.freeze(EVENT_TYPES.map((t) => t.type))
/** The types something in this app can actually produce today. */
export const CONFIRMED_TYPES = Object.freeze(EVENT_TYPES.filter((t) => t.confirmed).map((t) => t.type))


// ---- the NVR's recording-type bits ---------------------------------------------------------
//
// DD_RECORD_TYPE, from the SDK's own header (docs/include/dvrdvstypedef.h). This is the one event
// source in this phase that is not a guess: playback.mjs already reads these bits out of the
// recorded-file search every time the timeline is drawn, and they are documented by the vendor.
//
// What they do NOT carry is the class of object. "Tripwire" means something crossed a line, not
// that it was a person. That is why ai-person and ai-vehicle above are marked unconfirmed.

/** manual (0x1) and schedule (0x2): ordinary round-the-clock recording, not an event. */
export const CONTINUOUS_BITS = 0x1 | 0x2

/** bit -> what this app calls it. Straight from the vendor header; nothing here is inferred. */
export const RECORD_TYPE_BITS = Object.freeze([
  { bit: 0x0004, type: 'motion', subtype: '' },
  { bit: 0x0008, type: 'sensor', subtype: '' },
  { bit: 0x0010, type: 'ai', subtype: 'behaviour' },
  { bit: 0x0020, type: 'tamper', subtype: 'occlusion' },
  { bit: 0x0040, type: 'ai', subtype: 'overspeed' },
  { bit: 0x0080, type: 'ai', subtype: 'line crossed' },
  { bit: 0x0100, type: 'ai', subtype: 'object left or taken' },
  { bit: 0x0200, type: 'ai', subtype: 'exception' },
  { bit: 0x0400, type: 'ai', subtype: 'tripwire' },
  { bit: 0x0800, type: 'ai', subtype: 'area entered' },
  { bit: 0x1000, type: 'face', subtype: '' },
  { bit: 0x2000, type: 'pos', subtype: '' },
  { bit: 0x4000, type: 'sensor', subtype: 'PIR' }
])

/**
 * The event kinds in one recorded file's type bits. Continuous bits are dropped (they are not
 * events); any bit left over that we have no name for becomes one 'nvr-event' naming the bit, so
 * the page can say what the NVR reported without pretending to understand it.
 * @returns {Array<{type: string, subtype: string}>} empty when the file is plain recording
 */
export function typesFromRecordBits(bits) {
  const n = Number(bits)
  if (!Number.isFinite(n) || n <= 0) return []
  const out = []
  let seen = 0
  for (const r of RECORD_TYPE_BITS) {
    if (n & r.bit) {
      out.push({ type: r.type, subtype: r.subtype })
      seen |= r.bit
    }
  }
  const unknown = n & ~seen & ~CONTINUOUS_BITS
  if (unknown) out.push({ type: 'nvr-event', subtype: `type 0x${unknown.toString(16)}` })
  return out
}

// ---- schedules ------------------------------------------------------------------------------
//
// A rule can be limited to certain days and hours: "the yard camera at night is critical, the same
// camera at noon is not worth a phone buzzing". Times are wall-clock on the site, so the caller
// passes the site's offset from UTC rather than this module guessing at a timezone database.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const minutesOf = (hhmm) => {
  const m = HHMM.exec(String(hhmm ?? ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/**
 * Whether `ms` falls inside a schedule.
 *
 * No schedule at all, or an empty list, means always — a rule somebody wrote without thinking
 * about hours should fire, not sit silently doing nothing.
 *
 * A span whose end is at or before its start runs through midnight (22:00–06:00). Its `days` are
 * the days it STARTS on, which is what people mean by "Friday night".
 *
 * @param {Array<{days?: number[], from?: string, to?: string}>|null} schedule
 * @param {number} ms
 * @param {number} [tzOffsetMin] minutes to add to UTC to get site wall-clock time (e.g. -240)
 */
export function inSchedule(schedule, ms, tzOffsetMin = 0) {
  if (!Array.isArray(schedule) || schedule.length === 0) return true
  const local = Number(ms) + Number(tzOffsetMin || 0) * 60_000
  if (!Number.isFinite(local)) return false
  const d = new Date(local)
  const day = d.getUTCDay() // the local day, because local time was folded into the number above
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes()
  for (const span of schedule) {
    const from = minutesOf(span?.from) ?? 0
    const to = minutesOf(span?.to) ?? 24 * 60
    const days = Array.isArray(span?.days) && span.days.length ? span.days.map(Number) : null
    if (to > from) {
      // an ordinary span inside one day
      if (minute < from || minute >= to) continue
      if (days && !days.includes(day)) continue
      return true
    }
    // through midnight: either the late part of the starting day, or the early part of the next
    if (minute >= from) {
      if (!days || days.includes(day)) return true
    } else if (minute < to) {
      const startedOn = (day + 6) % 7
      if (!days || days.includes(startedOn)) return true
    }
  }
  return false
}

// ---- rules ----------------------------------------------------------------------------------

/** "<nvr>/<ch>", the key cameras are named by everywhere else in this app. */
export const cameraKey = (nvr, ch) => `${nvr}/${Number(ch)}`

const MAX_NAME = 80
const isStr = (v) => typeof v === 'string'

/**
 * Checks a rule as the browser or an API caller sent it.
 * Empty `cameras` means every camera, and empty `types` means every kind: the same "unset means
 * all" the schedule uses, so a half-filled form does something obvious rather than nothing.
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function checkRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'A rule must be an object' }
  const name = String(raw.name ?? '').trim()
  if (!name) return { ok: false, error: 'Give the rule a name' }
  if (name.length > MAX_NAME) return { ok: false, error: `The name must be ${MAX_NAME} characters or fewer` }

  const cameras = raw.cameras ?? []
  if (!Array.isArray(cameras) || !cameras.every(isStr)) return { ok: false, error: 'cameras must be a list of "<nvr>/<channel>" keys' }
  if (cameras.some((c) => !/^[A-Za-z0-9._-]{1,64}\/\d{1,3}$/.test(c))) return { ok: false, error: 'each camera must look like "<nvr>/<channel>"' }

  const types = raw.types ?? []
  if (!Array.isArray(types) || !types.every(isStr)) return { ok: false, error: 'types must be a list of event kinds' }
  const unknown = types.find((t) => !TYPE_NAMES.includes(t))
  if (unknown) return { ok: false, error: `${unknown} is not an event kind this app knows` }

  const priority = raw.priority ?? DEFAULT_PRIORITY
  if (!PRIORITIES.includes(priority)) return { ok: false, error: `priority must be one of: ${PRIORITIES.join(', ')}` }

  const schedule = raw.schedule ?? []
  if (!Array.isArray(schedule)) return { ok: false, error: 'schedule must be a list of spans' }
  const clean = []
  for (const s of schedule) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: 'each schedule span must be an object' }
    // 00:00 to 00:00 is the whole day: "to" at or before "from" means the span runs through
    // midnight, and a span that runs from midnight through midnight covers everything.
    const from = s.from ?? '00:00'
    const to = s.to ?? '00:00'
    if (!HHMM.test(String(from))) return { ok: false, error: 'schedule from must be a time as HH:MM' }
    if (!HHMM.test(String(to))) return { ok: false, error: 'schedule to must be a time as HH:MM' }
    const days = s.days ?? []
    if (!Array.isArray(days) || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return { ok: false, error: 'schedule days must be whole numbers 0 (Sunday) to 6' }
    }
    clean.push({ days: [...new Set(days)].sort(), from: String(from), to: String(to) })
  }

  const minGapS = raw.minGapS ?? 0
  if (!Number.isInteger(minGapS) || minGapS < 0 || minGapS > 3600) return { ok: false, error: 'minGapS must be a whole number of seconds from 0 to 3600' }

  return {
    ok: true,
    value: {
      name,
      enabled: raw.enabled !== false,
      cameras: [...new Set(cameras)],
      types: [...new Set(types)],
      schedule: clean,
      priority,
      notify: raw.notify === true,
      minGapS
    }
  }
}

/** Whether one rule covers one event. An empty camera or type list means "all of them". */
export function ruleMatches(rule, event, { tzOffsetMin = 0 } = {}) {
  if (!rule || rule.enabled === false) return false
  if (rule.cameras?.length && !rule.cameras.includes(cameraKey(event.nvr, event.ch))) return false
  if (rule.types?.length && !rule.types.includes(event.type)) return false
  return inSchedule(rule.schedule, event.startMs, tzOffsetMin)
}

/**
 * What the rules make of one event: how urgent it is and whether anyone is told.
 *
 * The most urgent matching rule sets the priority; notification is the OR of every matching rule,
 * because a rule that says "tell me" must not be cancelled by a second rule that happens to be
 * quieter. With no matching rule an event is still kept — it just sits at the bottom of the list
 * and nobody's phone rings.
 *
 * @returns {{ priority: string, notify: boolean, rule: object|null, matched: object[] }}
 */
export function applyRules(rules, event, { tzOffsetMin = 0, defaultPriority = DEFAULT_PRIORITY } = {}) {
  const matched = (Array.isArray(rules) ? rules : []).filter((r) => ruleMatches(r, event, { tzOffsetMin }))
  if (!matched.length) return { priority: defaultPriority, notify: false, rule: null, matched: [] }
  const best = matched.reduce((a, b) => (priorityRank(b.priority) < priorityRank(a.priority) ? b : a))
  return { priority: best.priority, notify: matched.some((r) => r.notify === true), rule: best, matched }
}

/**
 * Whether a notification for this rule and camera is still inside its quiet period.
 * A gate kept by the caller (`lastSentMs` per rule and camera), so a camera watching a busy road
 * does not send one message per car. Without a gap set, everything goes.
 */
export function withinQuietGap(rule, lastSentMs, nowMs) {
  const gap = Number(rule?.minGapS ?? 0) * 1000
  if (!gap) return false
  return Number.isFinite(lastSentMs) && nowMs - lastSentMs < gap
}

// ---- pre/post recording windows ---------------------------------------------------------------
//
// Motion and AI recording modes come down to one question asked many times a second: should this
// camera be writing right now? The answer is "yes if we are inside some event's window", where a
// window is the event itself plus `preS` before it and `postS` after it.
//
// The pre-roll is why the server keeps a rolling buffer in the first place: the interesting part
// of a break-in is the ten seconds before the movement that triggered it.

/** One event's window: the event grown by preS before and postS after. */
export function eventWindow(event, { preS = 0, postS = 0 } = {}) {
  const start = Number(event?.startMs)
  if (!Number.isFinite(start)) return null
  const end = Number.isFinite(Number(event?.endMs)) ? Number(event.endMs) : start
  return [start - Math.max(0, preS) * 1000, Math.max(start, end) + Math.max(0, postS) * 1000]
}

/**
 * Every event's window, merged into the stretches a camera should be recording.
 * Windows that touch or overlap become one, so a burst of movement is one continuous file rather
 * than a stutter of starts and stops — which is both kinder to the disk and easier to watch.
 * @returns {Array<[number, number]>} oldest first, none overlapping another
 */
export function recordWindows(events, { preS = 0, postS = 0, joinMs = 0 } = {}) {
  const spans = (Array.isArray(events) ? events : [])
    .map((e) => eventWindow(e, { preS, postS }))
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0])
  const out = []
  for (const [s, e] of spans) {
    const last = out.at(-1)
    if (last && s <= last[1] + joinMs) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** Whether time `t` falls in any window (ends inclusive: a window is a stretch, not an interval). */
export function inWindows(windows, t) {
  return (windows ?? []).some(([s, e]) => t >= s && t <= e)
}

/**
 * Whether a camera in an event-driven mode should be writing at `nowMs`, given the events known so
 * far. `graceMs` keeps recording going a little past the last window rather than cutting on the
 * exact millisecond, because events arrive in batches from a poll and the next batch may extend it.
 */
export function shouldRecord(events, nowMs, { preS = 0, postS = 0, graceMs = 0 } = {}) {
  return inWindows(recordWindows(events, { preS, postS, joinMs: graceMs }), nowMs)
}

/**
 * Which recording mode reacts to which events.
 * 'continuous' never consults events; 'off' records nothing. The event modes list the kinds that
 * start a window — and note that 'ai' here is the NVR's own intelligent recording, not a promise
 * about people or vehicles.
 */
export const MODE_TYPES = Object.freeze({
  motion: ['motion'],
  ai: ['ai', 'face'],
  'ai-or-motion': ['ai', 'face', 'motion']
})

/** Whether this mode is driven by events at all. */
export const isEventMode = (mode) => Object.hasOwn(MODE_TYPES, mode)

/** The events of one camera that a mode cares about. */
export function eventsForMode(events, mode) {
  const want = MODE_TYPES[mode]
  if (!want) return []
  return (events ?? []).filter((e) => want.includes(e.type))
}

// ---- the alarm list -----------------------------------------------------------------------------

/**
 * The order the Alarms page shows things in: anything still unacknowledged first (that is the whole
 * point of the page — what still needs a human), then by urgency, then newest first.
 */
export function prioritise(alarms) {
  return [...(alarms ?? [])].sort((a, b) => {
    const ackA = a.ackMs ? 1 : 0
    const ackB = b.ackMs ? 1 : 0
    if (ackA !== ackB) return ackA - ackB
    const r = priorityRank(a.priority) - priorityRank(b.priority)
    if (r) return r
    return (b.startMs ?? 0) - (a.startMs ?? 0)
  })
}

/**
 * The page's filters, applied to a list already fetched. Every filter left out means "no
 * restriction"; `acked` is a tri-state (true, false, or null for both).
 */
export function filterAlarms(list, { types = null, cameras = null, priorities = null, fromMs = null, toMs = null, acked = null, text = '' } = {}) {
  const needle = String(text ?? '').trim().toLowerCase()
  return (list ?? []).filter((a) => {
    if (types?.length && !types.includes(a.type)) return false
    if (cameras?.length && !cameras.includes(cameraKey(a.nvr, a.ch))) return false
    if (priorities?.length && !priorities.includes(a.priority)) return false
    if (fromMs !== null && Number.isFinite(fromMs) && (a.endMs ?? a.startMs) < fromMs) return false
    if (toMs !== null && Number.isFinite(toMs) && a.startMs > toMs) return false
    if (acked === true && !a.ackMs) return false
    if (acked === false && a.ackMs) return false
    if (needle && !`${labelOf(a.type)} ${a.subtype ?? ''} ${a.camera ?? ''} ${a.detail ?? ''} ${a.ackNote ?? ''}`.toLowerCase().includes(needle)) return false
    return true
  })
}

/** The counts the page's header shows: how much is waiting, and how urgent the worst of it is. */
export function summarise(alarms) {
  const out = { total: 0, unacked: 0, worst: null, byPriority: Object.fromEntries(PRIORITIES.map((p) => [p, 0])) }
  for (const a of alarms ?? []) {
    out.total++
    if (!a.ackMs) out.unacked++
    if (Object.hasOwn(out.byPriority, a.priority)) out.byPriority[a.priority]++
    if (!a.ackMs && (out.worst === null || priorityRank(a.priority) < priorityRank(out.worst))) out.worst = a.priority
  }
  return out
}

/**
 * One line of text for a notification, reusing the phase 1 delivery shape ({ key, kind, title,
 * detail, severity }) so alert-send.mjs needs no changes at all.
 */
export function alarmMessage(alarm, { ruleName = '' } = {}) {
  const where = alarm.camera || cameraKey(alarm.nvr, alarm.ch)
  const what = alarm.subtype ? `${labelOf(alarm.type)} (${alarm.subtype})` : labelOf(alarm.type)
  return {
    key: `alarm/${alarm.id ?? `${alarm.nvr}/${alarm.ch}/${alarm.startMs}`}`,
    kind: 'alarm',
    title: `${what} — ${where}`,
    detail: [alarm.detail, ruleName ? `rule: ${ruleName}` : ''].filter(Boolean).join(' · '),
    // The phase 1 sender knows two words for urgency, so the four priorities fold onto them.
    severity: priorityRank(alarm.priority) <= priorityRank('high') ? 'high' : 'medium'
  }
}

/** Acknowledgement text: short, and never blank pretending to be a reason. */
export function checkAck(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Send an object' }
  const note = String(raw.note ?? '').trim()
  if (note.length > 500) return { ok: false, error: 'The note must be 500 characters or fewer' }
  return { ok: true, value: { note } }
}
