// The clock arithmetic and document building, with nothing that touches the NVR.
//
// Split out from nvr-clock.mjs because that module reaches the NVR through nvr-xml.mjs, which
// loads the Linux SDK library -- so none of this could be tested on a machine without it. The
// timezone maths and the date formats are exactly the parts most worth testing: getting a date
// order wrong would set a recorder to the wrong day.


/** Carries an HTTP status so the route can answer properly, without dragging in nvr-xml.mjs. */
// the NVR's own web client sends this header on every request; matching it keeps us ordinary
const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>'

/**
 * The document that asks an NVR for its clock. It lives here, with the other document building,
 * because nvr-clock.mjs cannot be imported without the Linux SDK and so cannot be tested on a
 * development PC -- and this is precisely the kind of thing that needs testing. The version that
 * lived there wrote the opening <request> tag a second time on top of the one XML_HEADER already
 * provides, sending two opening tags and one close. Nothing rejected it loudly: the NVR simply
 * answered something unreadable, every clock read back with a null timezone, and the hourly
 * master-clock pass concluded it could not place any of them and did nothing, for weeks.
 */
// Note which XML_HEADER this is. The one in this file is the XML declaration alone; the one in
// nvr-xml.mjs also opens <request>. Mixing them up is the whole bug: nvr-clock.mjs imported that
// second one and then wrote the opening tag again itself.
export const QUERY_TIME = `${XML_HEADER}<request version="1.0" systemType="NVMS-9000" clientType="WEB"></request>`

/**
 * Ask for a clock reading, and ask again if the answer was no use.
 *
 * Here rather than in nvr-clock.mjs for the same reason as everything else in this file: that
 * module cannot be imported without the Linux SDK, so nothing in it can be tested on a development
 * PC -- which is how a malformed request document went unnoticed for weeks.
 *
 * Retrying matters because the NVRs that fail this call are the busy ones: rigginglot took 37
 * seconds over a routine SDK call on a link that pings in 10 ms with no packet loss, so the SDK's
 * "network timeout" is about load, not the network. Giving up on the first attempt means the
 * recorders that most need watching are the ones never checked.
 *
 * @param {() => Promise<string>} send one attempt
 * @param {object} o
 * @returns {Promise<{xml: string, clock: object, tries: number}>}
 * @throws the last failure, when no attempt produced a clock
 */
export async function readWithRetry(send, { tries = 3, waitMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = null
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(waitMs)
    try {
      const xml = String((await send()) ?? '')
      const clock = readClock(xml)
      // An answer without a timezone is not an answer: it is what a malformed request produces,
      // and treating it as a reading is what let the clock sync quietly do nothing.
      if (clock.timeZone) return { xml, clock, tries: i + 1 }
      last = new ClockError(502, 'the NVR answered, but not with its clock settings')
    } catch (e) {
      last = e
    }
  }
  throw last ?? new ClockError(502, 'the NVR was never asked')
}

export class ClockError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const TZ_RE = /^[A-Za-z]{2,6}[+-]?\d{1,2}(?:[A-Za-z]{2,6}(?:,M\d{1,2}\.\d\.\d(?:\/\d{1,2})?){0,2})?$/
/** The NVR only offers these; anything else is silently ignored by the device. */
const NTP_SERVERS = ['time.windows.com', 'time.nist.gov', 'time-nw.nist.gov', 'time-a.nist.gov', 'time-b.nist.gov']

const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])
// The tag must end where its name ends. Without that, looking for <timeZone> also matches
// <timezoneInfo> -- the name is a prefix and the match is case-insensitive -- and the clock gets
// read from an element that was never asked for.
const pick = (xml, tag) => new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*(?:<!\\[CDATA\\[)?\\s*([^<\\]]*)`, 'i').exec(xml)?.[1]?.trim() ?? null

/** What the NVR currently believes, from a queryTimeCfg answer. */
export function readClock(xml) {
  return {
    timeZone: pick(xml, 'timeZone'),
    daylight: pick(xml, 'daylightSwitch') === 'true',
    sync: pick(xml, 'type'), // 'NTP' or 'manually'
    ntpServer: pick(xml, 'ntpServer'),
    currentTime: pick(xml, 'currentTime'),
    dateFormat: pick(xml, 'date'),
    timeFormat: pick(xml, 'time')
  }
}

const pad = (n) => String(Math.floor(n)).padStart(2, '0')

/**
 * A moment written the way this NVR writes its own, taken from the formats it just reported.
 * Sending a date in the wrong order would set the clock to a different day, so the NVR's own
 * preference is followed rather than imposed.
 * @param {Date} d already shifted into the NVR's local time
 */
export function formatForNvr(d, { dateFormat = 'day-month-year', timeFormat = '24' } = {}) {
  const Y = d.getUTCFullYear()
  const M = pad(d.getUTCMonth() + 1)
  const D = pad(d.getUTCDate())
  const date = dateFormat === 'year-month-day' ? `${Y}-${M}-${D}` : dateFormat === 'month-day-year' ? `${M}/${D}/${Y}` : `${D}/${M}/${Y}`
  const h24 = d.getUTCHours()
  if (String(timeFormat) === '12') {
    const h = h24 % 12 || 12
    return `${date} ${pad(h)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${h24 < 12 ? 'AM' : 'PM'}`
  }
  return `${date} ${pad(h24)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/**
 * The document to send. Every field the NVR reported is written back; only what the caller asked
 * for changes. The formats are carried through untouched -- they are the owner's preference and
 * have nothing to do with correctness.
 *
 * `want.timeMs` sets the clock outright, which is how the server acts as the master: the server
 * is NTP-synced, its clock is what every recording is stamped against, and a remote site with no
 * way out to the internet can still be kept right.
 */
export function buildTimeCfg(now, want) {
  const timeZone = want.timeZone ?? now.timeZone
  const daylight = want.daylight ?? now.daylight
  const sync = want.ntp === undefined ? now.sync : want.ntp ? 'NTP' : 'manually'
  const ntpServer = want.ntpServer ?? now.ntpServer ?? 'time-b.nist.gov'
  // an explicit time only means anything while the NVR is not taking its own from NTP
  const setTime = want.timeMs !== undefined && sync !== 'NTP'
  const stamp = setTime ? formatForNvr(new Date(want.timeMs + (want.offsetMs ?? 0)), now) : null
  return (
    `${XML_HEADER}<request version="1.0" systemType="NVMS-9000" clientType="WEB">` +
    '<content>' +
    `<timezoneInfo><timeZone><![CDATA[${esc(timeZone)}]]></timeZone><daylightSwitch>${daylight ? 'true' : 'false'}</daylightSwitch></timezoneInfo>` +
    `<synchronizeInfo><type type="synchronizeType">${esc(sync)}</type><ntpServer><![CDATA[${esc(ntpServer)}]]></ntpServer>` +
    (stamp ? `<currentTime><![CDATA[${esc(stamp)}]]></currentTime>` : '') +
    '</synchronizeInfo>' +
    `<formatInfo><date type="dateFormat">${esc(now.dateFormat ?? 'day-month-year')}</date><time type="timeFormat">${esc(now.timeFormat ?? '24')}</time></formatInfo>` +
    '</content></request>'
  )
}

/** @throws {HttpError} on anything the NVR would not understand */
export function checkWanted(want) {
  const out = {}
  if (want.timeZone !== undefined) {
    if (typeof want.timeZone !== 'string' || !TZ_RE.test(want.timeZone)) throw new ClockError(400, 'timeZone must look like AST4 or EST5EDT,M3.2.0,M11.1.0')
    out.timeZone = want.timeZone
  }
  if (want.daylight !== undefined) out.daylight = want.daylight === true
  if (want.ntp !== undefined) out.ntp = want.ntp === true
  if (want.ntpServer !== undefined) {
    if (!NTP_SERVERS.includes(want.ntpServer)) throw new ClockError(400, `ntpServer must be one of: ${NTP_SERVERS.join(', ')}`)
    out.ntpServer = want.ntpServer
  }
  if (want.timeMs !== undefined) {
    // A clock is worth setting only to a believable moment. A wild value here would stamp every
    // recording from now on with it, and the recordings would outlive the mistake.
    if (!Number.isFinite(want.timeMs) || Math.abs(want.timeMs - Date.now()) > 365 * 86_400_000) {
      throw new ClockError(400, 'timeMs must be a moment within a year of now')
    }
    out.timeMs = want.timeMs
    if (want.offsetMs !== undefined) {
      if (!Number.isFinite(want.offsetMs) || Math.abs(want.offsetMs) > 14 * 3600_000) throw new ClockError(400, 'offsetMs must be within 14 hours')
      out.offsetMs = want.offsetMs
    }
  }
  if (!Object.keys(out).length) throw new ClockError(400, 'nothing to change')
  return out
}


const OFFSET_RE = /^[+-]?\d{1,2}(?:\.\d+)?$/

/**
 * The UTC moment a POSIX "Mm.w.d[/h]" rule falls on in `year`: weekday d (0 is Sunday) of week w
 * (5 means the last) of month m, at h o'clock (2 when not given) on a clock `offsetMs` from UTC.
 * null for anything else, including the Julian-day forms, which these NVRs do not offer.
 */
function ruleMoment(rule, year, offsetMs) {
  const m = /^M(\d{1,2})\.(\d)\.(\d)(?:\/(\d{1,2}))?$/.exec(rule)
  if (!m) return null
  const [month, week, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const hour = m[4] === undefined ? 2 : Number(m[4])
  if (month < 1 || month > 12 || week < 1 || week > 5 || day > 6 || hour > 24) return null
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  let date = 1 + ((day - firstWeekday + 7) % 7) + (week - 1) * 7
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  while (date > daysInMonth) date -= 7
  return Date.UTC(year, month - 1, date, hour) - offsetMs
}

/**
 * Milliseconds to add to UTC, at the moment `atMs`, for a POSIX zone like AST4 or
 * EST5EDT,M3.2.0,M11.1.0: the digits are hours WEST of UTC.
 *
 * `daylight` is the NVR's daylight saving switch. It says the NVR observes daylight saving, not
 * that it is in force today: whether it is in force comes from the zone's own two dates. (Until
 * 2026-10 the switch alone added the hour, all year, which would have set every such NVR an hour
 * fast from the first Sunday of November.)
 *
 * null when the offset cannot be worked out: a zone this cannot read, or one with daylight saving
 * switched on that does not say when it starts and ends (CST4CDT). The dates such a zone falls back
 * on are the firmware's own choice, and a wrong guess sets a recorder's clock an hour out.
 */
export function zoneOffsetMs(timeZone, daylight, atMs = Date.now()) {
  const m = /^[A-Za-z]{2,6}([+-]?\d{1,2}(?:\.\d+)?)/.exec(String(timeZone ?? ''))
  if (!m || !OFFSET_RE.test(m[1])) return null
  const west = Number(m[1])
  if (!Number.isFinite(west)) return null
  const standard = -west * 3600_000
  // a second zone name (EST5EDT) means daylight saving shifts it an hour east while in force
  const hasDst = /^[A-Za-z]{2,6}[+-]?\d{1,2}(?:\.\d+)?[A-Za-z]{2,6}/.test(String(timeZone))
  if (!daylight || !hasDst) return standard
  const rules = String(timeZone).split(',').slice(1)
  if (rules.length !== 2) return null
  // the start is given on the standard clock and the end on the summer one
  const year = new Date(atMs + standard).getUTCFullYear()
  const start = ruleMoment(rules[0], year, standard)
  const end = ruleMoment(rules[1], year, standard + 3600_000)
  if (start === null || end === null) return null
  // south of the equator the summer runs over the new year, so the start comes after the end
  const inForce = start < end ? atMs >= start && atMs < end : atMs >= start || atMs < end
  return standard + (inForce ? 3600_000 : 0)
}


/** The NVR's own time string back into a moment, read in whatever order it writes its dates. */
export function parseNvrTime(text, { dateFormat = 'day-month-year' } = {}) {
  const s = String(text ?? '').trim()
  const m = /^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i.exec(s)
  if (!m) return null
  const [, a, b, c, hh, mm, ss, ap] = m
  const [Y, M, D] =
    dateFormat === 'year-month-day' ? [a, b, c] : dateFormat === 'month-day-year' ? [c, a, b] : [c, b, a]
  let h = Number(hh)
  if (ap) h = (h % 12) + (ap.toUpperCase() === 'PM' ? 12 : 0)
  const t = Date.UTC(Number(Y), Number(M) - 1, Number(D), h, Number(mm), Number(ss))
  return Number.isFinite(t) ? t : null
}

