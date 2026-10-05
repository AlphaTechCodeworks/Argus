// Tests for nvr-clock.mjs: reading an NVR's clock settings, writing them back safely, working out
// a timezone offset, and the server acting as the master clock.
// Run: node cctv/test/nvr-clock.test.mjs
import { QUERY_TIME, buildTimeCfg, checkWanted, formatForNvr, parseNvrTime, readClock, readWithRetry, zoneOffsetMs } from '../clock-time.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

// Real answers from the site, 2026-09-25.
const NVR1 = `<?xml version="1.0" encoding="UTF-8"?><response cmdUrl="queryTimeCfg"><status>success</status><content><timezoneInfo><timeZone>AST4</timeZone><daylightSwitch>false</daylightSwitch></timezoneInfo><synchronizeInfo><type type="synchronizeType">NTP</type><ntpServer>time-b.nist.gov</ntpServer><currentTime><![CDATA[25/09/2026 03:14:55 PM]]></currentTime></synchronizeInfo><formatInfo><date type="dateFormat">day-month-year</date><time type="timeFormat">12</time></formatInfo></content></response>`
const NVR2 = `<?xml version="1.0" encoding="UTF-8"?><response cmdUrl="queryTimeCfg"><status>success</status><content><timezoneInfo><timeZone>AST4</timeZone><daylightSwitch>true</daylightSwitch></timezoneInfo><synchronizeInfo><type type="synchronizeType">manually</type><ntpServer>time.windows.com</ntpServer><currentTime><![CDATA[25/09/2026 15:19:49]]></currentTime></synchronizeInfo><formatInfo><date type="dateFormat">day-month-year</date><time type="timeFormat">24</time></formatInfo></content></response>`
const RIG = `<?xml version="1.0" encoding="UTF-8"?><response cmdUrl="queryTimeCfg"><status>success</status><content><timezoneInfo><timeZone>EST5EDT,M3.2.0,M11.1.0</timeZone><daylightSwitch>true</daylightSwitch></timezoneInfo><synchronizeInfo><type type="synchronizeType">manually</type><ntpServer>time.windows.com</ntpServer><currentTime><![CDATA[25/09/2026 03:19:00 PM]]></currentTime></synchronizeInfo><formatInfo><date type="dateFormat">day-month-year</date><time type="timeFormat">12</time></formatInfo></content></response>`
const SOLUS = `<?xml version="1.0" encoding="UTF-8"?><response cmdUrl="queryTimeCfg"><status>success</status><content><timezoneInfo><timeZone><![CDATA[AST4]]></timeZone><daylightSwitch>false</daylightSwitch></timezoneInfo><synchronizeInfo><type type="synchronizeType">manually</type><ntpServer><![CDATA[time.windows.com]]></ntpServer><currentTime><![CDATA[25/09/2026 03:42:41 PM]]></currentTime></synchronizeInfo><formatInfo><date type="dateFormat">day-month-year</date><time type="timeFormat">12</time></formatInfo></content></response>`

// ---- reading -------------------------------------------------------------------------------------
{
  const c = readClock(NVR1)
  check('reads the timezone', c.timeZone === 'AST4', c.timeZone)
  check('reads daylight saving off', c.daylight === false)
  check('reads that it uses NTP', c.sync === 'NTP', c.sync)
  check('reads the NTP server', c.ntpServer === 'time-b.nist.gov', c.ntpServer)
  check('reads the clock it shows', c.currentTime === '25/09/2026 03:14:55 PM', c.currentTime)
  check('reads the date format', c.dateFormat === 'day-month-year', c.dateFormat)
  check('reads the time format', c.timeFormat === '12', c.timeFormat)
}
{
  const c = readClock(SOLUS)
  check('reads a CDATA timezone', c.timeZone === 'AST4', c.timeZone)
  check('reads a CDATA NTP server', c.ntpServer === 'time.windows.com', c.ntpServer)
}
{
  check('nvr-2 has daylight saving on, unlike its neighbours', readClock(NVR2).daylight === true)
  check('rigginglot is on a different timezone', readClock(RIG).timeZone === 'EST5EDT,M3.2.0,M11.1.0')
  check('three of them are set to manual', [NVR2, RIG, SOLUS].every((x) => readClock(x).sync === 'manually'))
}

// ---- timezone offsets ------------------------------------------------------------------------------
{
  check('AST4 is four hours behind UTC', zoneOffsetMs('AST4', false) === -4 * 3600_000, String(zoneOffsetMs('AST4', false)))
  check('daylight saving does not move a zone with no summer name', zoneOffsetMs('AST4', true) === -4 * 3600_000)
  check('EST5EDT in winter is five hours behind', zoneOffsetMs('EST5EDT,M3.2.0,M11.1.0', false) === -5 * 3600_000)
  check('EST5EDT in summer is four hours behind', zoneOffsetMs('EST5EDT,M3.2.0,M11.1.0', true) === -4 * 3600_000)
  check('which is why rigginglot matches the others today but not in November',
    zoneOffsetMs('EST5EDT,M3.2.0,M11.1.0', true) === zoneOffsetMs('AST4', false) &&
    zoneOffsetMs('EST5EDT,M3.2.0,M11.1.0', false) !== zoneOffsetMs('AST4', false))
  check('a zone it cannot read gives null, not a guess', zoneOffsetMs('Europe/London', false) === null)
  check('an empty zone gives null', zoneOffsetMs('', false) === null && zoneOffsetMs(null, false) === null)
}

// ---- writing a moment in the NVR's own format ------------------------------------------------------
{
  const d = new Date(Date.UTC(2026, 8, 25, 15, 4, 5))
  check('day-month-year, 24 hour', formatForNvr(d, { dateFormat: 'day-month-year', timeFormat: '24' }) === '25/09/2026 15:04:05')
  check('day-month-year, 12 hour', formatForNvr(d, { dateFormat: 'day-month-year', timeFormat: '12' }) === '25/09/2026 03:04:05 PM')
  check('year-month-day', formatForNvr(d, { dateFormat: 'year-month-day', timeFormat: '24' }) === '2026-09-25 15:04:05')
  check('month-day-year', formatForNvr(d, { dateFormat: 'month-day-year', timeFormat: '24' }) === '09/25/2026 15:04:05')
  const noon = new Date(Date.UTC(2026, 8, 25, 12, 0, 0))
  const midnight = new Date(Date.UTC(2026, 8, 25, 0, 30, 0))
  check('noon is 12 PM, not 00 PM', formatForNvr(noon, { timeFormat: '12' }).includes('12:00:00 PM'), formatForNvr(noon, { timeFormat: '12' }))
  check('after midnight is 12 AM, not 00 AM', formatForNvr(midnight, { timeFormat: '12' }).includes('12:30:00 AM'), formatForNvr(midnight, { timeFormat: '12' }))
}

// ---- reading the NVR's time back -------------------------------------------------------------------
{
  check('reads a 12-hour afternoon time', parseNvrTime('25/09/2026 03:14:55 PM', { dateFormat: 'day-month-year' }) === Date.UTC(2026, 8, 25, 15, 14, 55))
  check('reads a 24-hour time', parseNvrTime('25/09/2026 15:19:49', { dateFormat: 'day-month-year' }) === Date.UTC(2026, 8, 25, 15, 19, 49))
  check('reads a morning time', parseNvrTime('25/09/2026 09:05:00 AM', { dateFormat: 'day-month-year' }) === Date.UTC(2026, 8, 25, 9, 5, 0))
  check('reads month-day-year the American way', parseNvrTime('09/25/2026 15:00:00', { dateFormat: 'month-day-year' }) === Date.UTC(2026, 8, 25, 15, 0, 0))
  check('reads year-month-day', parseNvrTime('2026-09-25 15:00:00', { dateFormat: 'year-month-day' }) === Date.UTC(2026, 8, 25, 15, 0, 0))
  check('nonsense gives null rather than a wrong moment', parseNvrTime('not a time') === null && parseNvrTime('') === null && parseNvrTime(null) === null)
  // a round trip is the real test: what we write must read back as the same moment
  const t = Date.UTC(2026, 8, 25, 15, 4, 5)
  for (const dateFormat of ['day-month-year', 'month-day-year', 'year-month-day']) {
    for (const timeFormat of ['12', '24']) {
      const back = parseNvrTime(formatForNvr(new Date(t), { dateFormat, timeFormat }), { dateFormat })
      check(`round trip: ${dateFormat} ${timeFormat} hour`, back === t, `${back} != ${t}`)
    }
  }
}

// ---- building the document -------------------------------------------------------------------------
{
  const now = readClock(RIG)
  const doc = buildTimeCfg(now, { timeZone: 'AST4', daylight: false })
  check('the new timezone is in the document', doc.includes('<timeZone><![CDATA[AST4]]></timeZone>'))
  check('daylight saving is turned off', doc.includes('<daylightSwitch>false</daylightSwitch>'))
  check('what was not asked for is carried through', doc.includes('manually') && doc.includes('time.windows.com'), doc)
  check('the formats are left as the owner had them', doc.includes('day-month-year') && doc.includes('>12<'), doc)
  check('no time is set unless one was asked for', !doc.includes('currentTime'))
}
{
  const now = readClock(NVR2)
  const t = Date.UTC(2026, 8, 25, 19, 15, 0)
  const doc = buildTimeCfg(now, { timeMs: t, offsetMs: -4 * 3600_000 })
  check('the server time is written in the NVR local time', doc.includes('<currentTime><![CDATA[25/09/2026 15:15:00]]></currentTime>'), doc.slice(doc.indexOf('currentTime') - 10, doc.indexOf('currentTime') + 60))
}
{
  // setting a time while the NVR takes its own from NTP would be pointless and confusing
  const doc = buildTimeCfg(readClock(NVR1), { timeMs: Date.now() })
  check('no time is pushed to an NVR that uses NTP', !doc.includes('currentTime'))
}

// ---- the documents we send are well formed -----------------------------------------------------
//
// This is the test that was missing. The query that reads an NVR's clock was built by writing an
// opening <request> tag on top of the one XML_HEADER already provides -- two opens, one close.
// Nothing failed loudly: the NVR answered something unreadable, every clock came back with a null
// timezone, and the hourly master-clock pass decided it could not place any of the NVRs and left
// them all alone. It ran for weeks and corrected nothing, and the only visible symptom was nvr-2
// sitting four minutes fast.
{
  const opens = (s) => (s.match(/<request\b/g) ?? []).length
  const closes = (s) => (s.match(/<\/request>/g) ?? []).length
  check('the clock query opens <request> exactly once', opens(QUERY_TIME) === 1, `${opens(QUERY_TIME)} opening tags: ${QUERY_TIME}`)
  check('and closes it exactly once', closes(QUERY_TIME) === 1, QUERY_TIME)
  check('the clock query carries the XML declaration first', QUERY_TIME.startsWith('<?xml'), QUERY_TIME.slice(0, 20))
  // the same trap in the document that actually writes a clock would set the wrong time, silently
  const doc = buildTimeCfg(readClock(NVR2), { timeMs: Date.UTC(2026, 8, 25, 19, 15, 0), offsetMs: -4 * 3600_000 })
  check('the clock write opens <request> exactly once', opens(doc) === 1, `${opens(doc)} opening tags`)
  check('and closes it exactly once', closes(doc) === 1)
  // every element opened is closed: a tag count mismatch is what made this invisible
  const tags = doc.match(/<\/?[A-Za-z][A-Za-z0-9]*/g) ?? []
  const depth = tags.reduce((d, t) => d + (t.startsWith('</') ? -1 : 1), 0)
  check('the clock write document is balanced', depth === 0, `depth ${depth}`)
}

// ---- asking again ----------------------------------------------------------------------------------
//
// The NVRs that fail a clock check are the busy ones, not the unreachable ones: rigginglot timed
// out twice on a link that pings in 10 ms with no packet loss, while a routine SDK call to it took
// 37 seconds. Giving up on the first attempt means the recorders that most need watching are the
// ones never checked.
{
  const noWait = { waitMs: 0, sleep: async () => {} }
  {
    let calls = 0
    const r = await readWithRetry(async () => { calls++; return NVR2 }, noWait)
    check('a good answer first time is not asked for twice', calls === 1 && r.tries === 1 && r.clock.timeZone === 'AST4')
  }
  {
    let calls = 0
    const r = await readWithRetry(async () => {
      calls++
      if (calls < 3) throw new Error('the NVR did not accept the request (network timeout)')
      return SOLUS
    }, noWait)
    check('a busy NVR is asked again until it answers', calls === 3 && r.tries === 3 && r.clock.timeZone === 'AST4')
  }
  {
    let thrown = null
    let calls = 0
    try {
      await readWithRetry(async () => { calls++; throw new Error('network timeout') }, noWait)
    } catch (e) { thrown = e }
    check('an NVR that never answers gives up, and says why', thrown !== null && /network timeout/.test(thrown.message), String(thrown))
    check('and does not ask for ever', calls === 3, String(calls))
  }
  {
    // The failure that started all this: a malformed request gets an answer with no clock in it.
    // Treating that as a reading is exactly what let the sync silently do nothing for weeks.
    let thrown = null
    const empty = '<?xml version="1.0"?><response cmdUrl="queryTimeCfg"><status>fail</status><errorCode>536870923</errorCode></response>'
    try { await readWithRetry(async () => empty, noWait) } catch (e) { thrown = e }
    check('an answer with no clock in it is not mistaken for a reading', thrown !== null && /not with its clock settings/.test(thrown.message), String(thrown))
  }
  {
    // It waits between attempts rather than hammering an NVR that is already struggling.
    const waits = []
    let calls = 0
    await readWithRetry(async () => { calls++; if (calls < 3) throw new Error('busy'); return NVR1 },
      { waitMs: 5000, sleep: async (ms) => { waits.push(ms) } })
    check('it pauses between attempts, but not before the first', waits.length === 2 && waits.every((w) => w === 5000), JSON.stringify(waits))
  }
}

// ---- refusing nonsense -----------------------------------------------------------------------------
{
  const bad = (w, why) => {
    let threw = false
    try { checkWanted(w) } catch { threw = true }
    check(`refuses ${why}`, threw)
  }
  bad({}, 'a change that changes nothing')
  bad({ timeZone: 'Europe/London' }, 'a timezone the NVR cannot take')
  bad({ timeZone: 'AST4; reboot' }, 'anything smuggled into a timezone')
  bad({ ntpServer: 'evil.example.com' }, 'an NTP server the NVR does not offer')
  bad({ timeMs: Date.now() + 400 * 86_400_000 }, 'a time a year out')
  bad({ timeMs: Number.NaN }, 'a time that is not a number')
  bad({ timeMs: Date.now(), offsetMs: 20 * 3600_000 }, 'an impossible timezone offset')

  const ok = checkWanted({ timeZone: 'EST5EDT,M3.2.0,M11.1.0', daylight: true, ntp: true, ntpServer: 'time-b.nist.gov' })
  check('accepts a sensible change', ok.timeZone === 'EST5EDT,M3.2.0,M11.1.0' && ok.daylight === true && ok.ntp === true)
  check('accepts the server pushing its time', checkWanted({ timeMs: Date.now(), offsetMs: -4 * 3600_000 }).timeMs > 0)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
