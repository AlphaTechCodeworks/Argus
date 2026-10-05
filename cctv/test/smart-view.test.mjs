// Tests for public/smart-view.js: turning a raw SMART table into something a person can read.
//   node cctv/test/smart-view.test.mjs
//
// The fixture is nvr-2's real drive, read on 2026-09-25: a Seagate SkyHawk AI 12 TB, 462 days
// powered on, in good health. Every awkward case this has to handle is present in it.
import { hours, rawText, smartRows, smartSummary } from '../public/smart-view.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const A = (id, name, value, worst, threshold, raw, kind = 'Oldage', status = 'normal') =>
  ({ id, name, value, worst, threshold, raw, kind, status })

// nvr-2's own figures.
const REAL = {
  verdict: 'good',
  state: 'ok',
  temperature: 30,
  peakTemp: 39,
  powerOnDays: 463,
  powerOnHours: 11090,
  flyingHours: 10780,
  powerCycles: 48,
  unsafeShutdowns: 31,
  loadCycles: 532,
  crcErrors: 0,
  concerns: [],
  attrs: [
    A(1, 'Read error rate', 100, 64, 44, 1352435, 'Pre-fail'),
    A(5, 'Reallocated sectors', 100, 100, 10, 0, 'Pre-fail'),
    A(7, 'Seek error rate', 89, 60, 45, 889728777, 'Pre-fail'),
    A(9, 'Power-on hours', 88, 88, 0, 11090),
    A(187, 'Reported uncorrectable', 100, 100, 0, 0),
    A(188, 'Command timeout', 100, 100, 0, 0),
    A(190, 'Airflow temperature', 70, 61, 0, 639369246),
    A(192, 'Unsafe shutdowns', 100, 100, 0, 31),
    A(193, 'Load/unload cycles', 100, 100, 0, 532),
    A(194, 'Temperature', 30, 40, 0, 30),
    A(197, 'Pending sectors', 100, 100, 0, 0),
    A(198, 'Offline uncorrectable', 100, 100, 0, 0),
    A(199, 'CRC errors', 200, 200, 0, 0),
    A(240, 'Head flying hours', 100, 253, 0, 10780),
    A(241, 'Total written', 100, 253, 0, 1824924453)
  ]
}

// ---- units -------------------------------------------------------------------------------------
check('hours become something a person can picture', hours(11090) === '11,090 h (1.3 years)', String(hours(11090)))
check('a young drive is counted in days, not fractions of a year', hours(500) === '500 h (21 days)', String(hours(500)))
check('a figure that is not there stays absent', hours(null) === null && hours(undefined) === null)

// ---- the table ---------------------------------------------------------------------------------
{
  const rows = smartRows(REAL)
  const by = (id) => rows.find((r) => r.id === id)
  check('every attribute is listed', rows.length === REAL.attrs.length, `${rows.length}`)
  check('hours are written as hours', by(9).raw === '11,090 h (1.3 years)', by(9).raw)
  check('a temperature is written as a temperature', by(194).raw === '30 °C', by(194).raw)
  check('counts get thousands separators', by(193).raw === '532' && by(241).raw.startsWith('1,824,924,453'), by(193).raw)

  // The trap. This drive is healthy and reports 889 million seek errors, because Seagate encode
  // the field. Shown, but never presented as a bare number somebody might read as a fault.
  check('a vendor-encoded figure says so', by(7).raw === '889,728,777 (encoded)', by(7).raw)
  check('and is played down rather than alarming', by(7).state === 'muted' && by(7).note.includes('ignore the raw figure'), by(7).state)
  check('the same for the read error rate', by(1).state === 'muted')

  // 0.93 TB claimed against about 331 TB really written: a wrapped counter, not a young drive.
  check('a wrapped counter admits it', by(241).raw.includes('counter wrapped') && by(241).state === 'muted', by(241).raw)

  check('the five that matter are marked', [5, 187, 188, 197, 198].every((id) => by(id).key === true))
  check('and nothing else is', rows.filter((r) => r.key).length === 5)
  check('a healthy drive has no row in the red', rows.every((r) => r.state !== 'bad'))
  check('pre-fail and wear-out are told apart', by(5).kind === 'Predicts failure' && by(9).kind === 'Wears out', `${by(5).kind}/${by(9).kind}`)
  check('the drive\'s own margin is shown', by(5).margin === '100 / 10', by(5).margin)
  check('every row explains itself', rows.every((r) => r.note.length > 10))
}
{
  // One reallocated sector is the whole point of the exercise.
  const going = { ...REAL, attrs: REAL.attrs.map((a) => (a.id === 5 ? { ...a, raw: 24, value: 90 } : a)) }
  const row = smartRows(going).find((r) => r.id === 5)
  check('a key attribute that has started counting goes red', row.state === 'bad' && row.raw === '24', JSON.stringify(row.state))
  // ...but the same count on an attribute that does not predict failure does not.
  const loaded = { ...REAL, attrs: REAL.attrs.map((a) => (a.id === 193 ? { ...a, raw: 24000 } : a)) }
  check('a high count on a wear attribute is not a fault', smartRows(loaded).find((r) => r.id === 193).state === '')
  // the drive flagging something itself is trusted even where we would not have judged it
  const flagged = { ...REAL, attrs: REAL.attrs.map((a) => (a.id === 193 ? { ...a, status: 'warn' } : a)) }
  check('an attribute the drive itself flags goes amber', smartRows(flagged).find((r) => r.id === 193).state === 'warn')
}
check('no attributes at all gives no rows, not a crash', smartRows(null).length === 0 && smartRows({}).length === 0)

// ---- the summary -------------------------------------------------------------------------------
{
  const s = smartSummary(REAL)
  const get = (label) => s.find((x) => x.label === label)
  check('the drive\'s verdict leads', get('The drive\'s own verdict').value === 'Good' && get('The drive\'s own verdict').state === 'ok')
  check('the temperature carries its high-water mark', get('Temperature').value === '30 °C, peak 39 °C', get('Temperature').value)
  check('and 30 °C is not a problem', get('Temperature').state === 'ok')
  check('age is in years with the duty alongside', get('Age').value === '11,090 h (1.3 years)' && get('Age').note.includes('97 %'), get('Age').note)

  // The finding that is actually worth acting on, and is about the building rather than the disk.
  const p = get('Unclean power-downs')
  check('unclean power-downs are counted and put in proportion', p.value === '31 of 48 (65 %)', p.value)
  check('and explained as a power problem, not a disk problem', p.state === 'warn' && p.note.includes('UPS'), p.note)

  check('a clean cable says so', get('Cable errors').value === '0' && get('Cable errors').state === 'ok')
  check('a healthy drive says the counts that matter are all zero', get('Failing sectors').value === 'None' && get('Failing sectors').state === 'ok')
}
{
  const hot = smartSummary({ ...REAL, temperature: 52, peakTemp: 55 })
  check('a drive being cooked is marked', hot.find((x) => x.label === 'Temperature').state === 'bad')
  const clean = smartSummary({ ...REAL, unsafeShutdowns: 1, powerCycles: 48 })
  check('the odd unclean shutdown is not made into a drama', clean.find((x) => x.label === 'Unclean power-downs').state === 'ok')
  const cable = smartSummary({ ...REAL, crcErrors: 7 })
  check('cable errors point at the cable first', cable.find((x) => x.label === 'Cable errors').note.includes('reseat'))
  const failing = smartSummary({ ...REAL, attrs: REAL.attrs.map((a) => (a.id === 197 ? { ...a, raw: 8 } : a)) })
  const f = failing.find((x) => x.label === 'Failing sectors')
  check('a drive starting to fail names what is counting', f.state === 'bad' && f.value.includes('Pending sectors: 8'), f.value)
}
{
  // Nothing is invented for a drive that gave us nothing.
  check('no SMART at all gives nothing, not zeroes', smartSummary(null).length === 0)
  const bare = smartSummary({ verdict: null, state: 'unknown', attrs: [] })
  check('missing figures are left out rather than shown as 0', !bare.some((x) => ['Temperature', 'Age', 'Cable errors'].includes(x.label)), JSON.stringify(bare.map((x) => x.label)))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
