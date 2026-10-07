// The nightly cameras read (camera-export.mjs): when "2 AM on site" is, and whose clock says so.
// No NVR is read: the timer is a stand-in, and the schedule is only asked what it set.
//   node cctv/test/camera-export.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { msUntilSiteHour, startCameraReportSchedule } from '../camera-export.mjs'
import { useSiteOffset } from '../site-time.mjs'

let failures = 0
const say = console.log // (the schedule's own log lines are silenced below; the results are not)
const check = (n, ok, e = '') => { if (!ok) failures++; say(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const H = 3600_000

// ---- the wait until the site's clock reads the hour
{
  const T = Date.UTC(2026, 9, 7, 3, 30) // 03:30 UTC = 23:30 the evening before on a UTC-4 site
  check('23:30 on site: 2 AM is two and a half hours away', msUntilSiteHour(T, 2, -240) === 2.5 * H, String(msUntilSiteHour(T, 2, -240) / H))
  check('the same moment on a UTC server clock: 2 AM passed, so tomorrow', msUntilSiteHour(T, 2, 0) === 22.5 * H, String(msUntilSiteHour(T, 2, 0) / H))
  check('exactly on the hour waits a whole day, not zero', msUntilSiteHour(Date.UTC(2026, 9, 7, 6, 0), 2, -240) === 24 * H)
  check('east of UTC works too', msUntilSiteHour(Date.UTC(2026, 9, 7, 12, 0), 2, 600) === 4 * H)
  const at = T + msUntilSiteHour(T, 2, -240)
  check('and it lands on 06:00 UTC, which is 02:00 at UTC-4', new Date(at).toISOString() === '2026-10-07T06:00:00.000Z', new Date(at).toISOString())
}

// ---- the schedule takes the site's offset from site-time.mjs (the NVRs' zone first), not the
// variable alone: with it unset, "2 AM" was 2 AM UTC
{
  const realSetTimeout = globalThis.setTimeout
  const realLog = console.log
  const realEnv = process.env.CCTV_SITE_TZ_OFFSET_MIN
  const timers = []
  const landsAt = () => new Date(Date.now() + timers.at(-1).ms).getUTCHours() * 60 + new Date(Date.now() + timers.at(-1).ms).getUTCMinutes()
  try {
    globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } }
    console.log = () => {}
    delete process.env.CCTV_SITE_TZ_OFFSET_MIN
    const dataDir = mkdtempSync(join(tmpdir(), 'cctv-camera-export-test-'))

    // the NVRs' zones have not been read yet (the first minutes after start): the variable decides
    useSiteOffset(() => null)
    process.env.CCTV_SITE_TZ_OFFSET_MIN = '-300'
    startCameraReportSchedule(new Map(), { dataDir })
    check('before the NVRs have been read, the variable is used: 2 AM at UTC-5 is 07:00 UTC', timers.length === 1 && landsAt() === 7 * 60, String(landsAt()))

    // by the time it fires the NVRs have said UTC-4: it aims again and reads nothing
    useSiteOffset(() => -240)
    timers.at(-1).fn()
    check('a timer aimed before the NVRs were read aims again, at their 2 AM (06:00 UTC)', timers.length === 2 && landsAt() === 6 * 60, `${timers.length} timers, ${landsAt()}`)

    // with the variable unset the NVRs' zone still decides (this is the case that ran at 2 AM UTC)
    delete process.env.CCTV_SITE_TZ_OFFSET_MIN
    timers.length = 0
    startCameraReportSchedule(new Map(), { dataDir })
    check('with the variable unset, the NVRs’ zone decides: 06:00 UTC, not 02:00', timers.length === 1 && landsAt() === 6 * 60, String(landsAt()))
  } finally {
    globalThis.setTimeout = realSetTimeout
    console.log = realLog
    if (realEnv === undefined) delete process.env.CCTV_SITE_TZ_OFFSET_MIN
    else process.env.CCTV_SITE_TZ_OFFSET_MIN = realEnv
    useSiteOffset(() => null)
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
