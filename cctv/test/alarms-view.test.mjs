// Offline tests for the Alarms page's line-crossing additions in public/alarms-view.js: the picture
// a line-crossing row carries, when a picture that failed to load is worth asking for again, the
// alarm a phone alert's link points at (/alarms.html#event=<id>), and what the page says when that
// alarm is not in the list it is showing.
//
// Pure: no DOM, no database, no SDK, so it runs on Windows with plain node:
//   node cctv/test/alarms-view.test.mjs
import {
  SNAPSHOT_KINDS, SNAPSHOT_SETTLE_MS, alarmRows, eventFromHash, labelOf, linkedEventNote, snapshotMayArrive, snapshotUrl
} from '../public/alarms-view.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 27, 14, 0, 0)
const MIN = 60_000

// --- which rows carry a picture ------------------------------------------------------------------
{
  check('line crossings are the kind that comes with a picture', SNAPSHOT_KINDS.includes('line-crossing'))
  const url = snapshotUrl({ id: 42, type: 'line-crossing' })
  check('a line crossing points at its own picture', url === '/api/events/42/snapshot', url)
  check('motion has none (nothing takes one)', snapshotUrl({ id: 42, type: 'motion' }) === null)
  check('nor does the old smart-detection kind', snapshotUrl({ id: 42, type: 'ai', subtype: 'tripwire' }) === null)
  // the id goes into a URL: only the whole number the database gave is let through
  check('an id that is not a positive whole number gives no address', [0, -1, 1.5, '7', 'x', true, null, undefined].every((id) => snapshotUrl({ id, type: 'line-crossing' }) === null))
  check('nothing at all gives nothing', snapshotUrl(null) === null && snapshotUrl(undefined) === null)

  const rows = alarmRows([
    { id: 9, camera: 'Maingate Roadway', nvr: 'nvr-2', ch: 2, type: 'line-crossing', subtype: 'tripwire', priority: 'high', startMs: T0, endMs: T0 + 10_000, ackMs: null },
    { id: 10, camera: 'Gate', nvr: 'nvr1', ch: 0, type: 'motion', subtype: '', priority: 'low', startMs: T0, endMs: null, ackMs: null }
  ], { now: T0 + MIN })
  check('the row of a line crossing carries its picture', rows[0].snapshot === '/api/events/9/snapshot', rows[0].snapshot)
  check('and says what it was in words', rows[0].what === `${labelOf('line-crossing')} (tripwire)`, rows[0].what)
  check('a motion row carries none', rows[1].snapshot === null)
  check('the rest of the row is as before', rows[0].id === 9 && rows[0].camera === 'Maingate Roadway' && rows[0].lasted === '10 s' && rows[0].needsAck === true && rows[0].nvr === 'nvr-2' && rows[0].ch === 2)
}

// --- a picture that failed to load: ask again, or stop asking --------------------------------------
{
  check('just after the crossing: it may still come', snapshotMayArrive(T0, T0 + 30_000))
  check('three minutes on: still possible (the snapshot waits that long for the recording)', snapshotMayArrive(T0, T0 + 3 * MIN))
  check('past the settle time: not coming', !snapshotMayArrive(T0, T0 + SNAPSHOT_SETTLE_MS))
  check('the settle time is longer than the snapshot\'s own three-minute wait', SNAPSHOT_SETTLE_MS > 3 * MIN)
  check('no start time: never worth asking again', !snapshotMayArrive(null, T0) && !snapshotMayArrive(undefined, T0))
}

// --- the link in a phone alert ---------------------------------------------------------------------
{
  check('#event=<id> names that alarm', eventFromHash('#event=123') === 123)
  check('without the #, too', eventFromHash('event=5') === 5)
  check('beside other things in the address', eventFromHash('#event=77&from=alert') === 77)
  check('a tab name is not an alarm', eventFromHash('#rules') === null && eventFromHash('#list') === null)
  check('an empty address is not an alarm', eventFromHash('') === null && eventFromHash(undefined) === null && eventFromHash(null) === null)
  const junk = ['#event=', '#event=abc', '#event=-4', '#event=1.5', '#event=0', '#event=1e3', '#event=12345678901234567890']
  check('nonsense is not an alarm', junk.every((h) => eventFromHash(h) === null), junk.filter((h) => eventFromHash(h) !== null).join(' '))
}

// --- when the linked alarm is not in the list ------------------------------------------------------
{
  const rows = alarmRows([{ id: 9, camera: 'Maingate Roadway', nvr: 'nvr-2', ch: 2, type: 'line-crossing', subtype: 'tripwire', priority: 'high', startMs: T0, endMs: null, ackMs: null }], { now: T0 })
  check('no link: nothing to say', linkedEventNote(null, rows) === '')
  check('the linked alarm is listed: nothing to say', linkedEventNote(9, rows) === '')
  const note = linkedEventNote(8, rows)
  check('not listed: the page says so and names it', /\b8\b/.test(note) && /not in the list/.test(note), note)
  // never "it does not exist": the list is a window of dates, and the server leaves out the alarms
  // of cameras this viewer may not see (alarms.mjs), so absence here proves neither
  check('and gives the likely reasons instead of claiming it does not exist', /older/.test(note) && /cannot see/.test(note) && !/does not exist/.test(note), note)
  check('an empty or missing list is handled', /not in the list/.test(linkedEventNote(8, [])) && /not in the list/.test(linkedEventNote(8, undefined)))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
