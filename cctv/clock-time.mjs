// The clock arithmetic and document building, with nothing that touches the NVR.
//
// Split out from nvr-clock.mjs because that module reaches the NVR through nvr-xml.mjs, which
// loads the Linux SDK library -- so none of this could be tested on a machine without it. The
// timezone maths and the date formats are exactly the parts most worth testing: getting a date
// order wrong would set a recorder to the wrong day.


/** Carries an HTTP status so the route can answer properly, without dragging in nvr-xml.mjs. */
// the NVR's own web client sends this header on every request; matching it keeps us ordinary
const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>'

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

/** Hours to add to UTC for a POSIX zone like AST4 or EST5EDT: the digits are hours WEST of UTC. */
export function zoneOffsetMs(timeZone, daylight) {
  const m = /^[A-Za-z]{2,6}([+-]?\d{1,2}(?:\.\d+)?)/.exec(String(timeZone ?? ''))
  if (!m || !OFFSET_RE.test(m[1])) return null
  const west = Number(m[1])
  if (!Number.isFinite(west)) return null
  // a second zone name (EST5EDT) means daylight saving shifts it an hour east while in force
  const hasDst = /^[A-Za-z]{2,6}[+-]?\d{1,2}(?:\.\d+)?[A-Za-z]{2,6}/.test(String(timeZone))
  const dst = daylight && hasDst ? 1 : 0
  return (-west + dst) * 3600_000
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

