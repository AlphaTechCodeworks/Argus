// The site's wall clock (site-time.mjs): the NVRs' zone first, then CCTV_SITE_TZ_OFFSET_MIN, then
// the server's own. The server runs on UTC; the backfill's 01:00-05:00 ran 21:00-01:00 on site.
//   node cctv/test/site-time.test.mjs
import { commonOffset, siteDate, siteDayStart, siteMinutesOfDay, siteOffsetMin, useSiteOffset } from '../site-time.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const T = Date.UTC(2026, 8, 26, 3, 30) // 03:30 UTC = 23:30 the day before on site (UTC-4)

useSiteOffset(() => -240)
check('the NVRs say UTC-4: that is the site offset', siteOffsetMin(T) === -240)
check('03:30 UTC is 23:30 on site', siteMinutesOfDay(T) === 23 * 60 + 30)
check('... on the 25th', siteDate(T) === '2026-09-25')
check('the site\'s 26th starts at 04:00 UTC', siteDayStart('2026-09-26') === Date.UTC(2026, 8, 26, 4, 0))
useSiteOffset(() => null)
process.env.CCTV_SITE_TZ_OFFSET_MIN = '-300'
check('no NVR read yet: CCTV_SITE_TZ_OFFSET_MIN', siteOffsetMin(T) === -300)
delete process.env.CCTV_SITE_TZ_OFFSET_MIN
check('neither: the server\'s own zone (the old behaviour)', siteOffsetMin(T) === -new Date(T).getTimezoneOffset())
check('the most common NVR zone wins (one set wrongly is outvoted)', commonOffset([-240, -240, 0, -240, null]) === -240)
check('no zone read at all: none', commonOffset([]) === null)
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
