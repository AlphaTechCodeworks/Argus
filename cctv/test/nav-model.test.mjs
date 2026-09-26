// cctv/test/nav-model.test.mjs
//   node cctv/test/nav-model.test.mjs
// The navigation used to be ten links copied by hand into every page, and the copies had drifted:
// a duplicate Storage tab on one page, Audit missing from another. One model now decides it.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { NAV_GROUPS, PHONE_BAR, currentId, navFor } from '../public/nav-model.js'
import { nextTheme, readTheme, saveTheme } from '../public/theme.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const ids = (groups) => groups.flatMap((g) => g.items.map((i) => i.id))
check('three groups in order', NAV_GROUPS.map((g) => g.id).join() === 'watch,monitor,admin')
check('watch holds live, playback, map (the wall is Many cameras in Playback)', ids([NAV_GROUPS[0]]).join() === 'live,playback,map')
check('monitor holds alarms, health', ids([NAV_GROUPS[1]]).join() === 'alarms,health')
check('admin holds sites, settings, storage, reports, audit', ids([NAV_GROUPS[2]]).join() === 'sites,settings,storage,reports,audit')
check('no item appears twice', new Set(ids(NAV_GROUPS)).size === ids(NAV_GROUPS).length)
check('only the admin group is admin-only', NAV_GROUPS.filter((g) => g.adminOnly).map((g) => g.id).join() === 'admin')

check('an admin sees all ten', ids(navFor({ admin: true })).length === 10)
check('a viewer never sees the admin pages', !ids(navFor({ admin: false })).some((i) => ['sites', 'settings', 'storage', 'reports', 'audit'].includes(i)))
check('an unknown user is treated as a viewer', ids(navFor({})).length === 5)

check('/ is live', currentId('/') === 'live')
check('/index.html is live', currentId('/index.html') === 'live')
check('/playback.html is playback', currentId('/playback.html') === 'playback')
check('/settings.html is settings', currentId('/settings.html') === 'settings')
check('a query string does not confuse it', currentId('/health.html?x=1') === 'health')
check('an unknown page marks nothing', currentId('/login.html') === null)

const pub = join(import.meta.dirname, '..', 'public')
for (const i of NAV_GROUPS.flatMap((g) => g.items)) {
  const file = i.href === '/' ? 'index.html' : i.href.slice(1).split('#')[0] // settings.html#storage is settings.html
  check(`${i.label} points at a page that exists`, existsSync(join(pub, file)), file)
}
check('the phone bar is the four used most', PHONE_BAR.join() === 'live,playback,alarms,health')
check('every phone-bar item is a real item', PHONE_BAR.every((p) => ids(NAV_GROUPS).includes(p)))

// themes
const mem = (init = {}) => { const m = { ...init }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v) }, m } }
check('dark by default', readTheme(mem()) === 'dark')
check('a saved light is read back', readTheme(mem({ 'cctv.theme': 'light' })) === 'light')
check('rubbish in storage means dark', readTheme(mem({ 'cctv.theme': 'purple' })) === 'dark')
const broken = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
check('a blocked store means dark, not a crash', readTheme(broken) === 'dark')
check('no store at all means dark', readTheme(null) === 'dark')
check('the toggle flips', nextTheme('dark') === 'light' && nextTheme('light') === 'dark')
const s = mem()
check('saving works', saveTheme(s, 'light') === true && s.m['cctv.theme'] === 'light')
check('saving to a blocked store says so rather than throwing', saveTheme(broken, 'light') === false)
check('saving nonsense is refused', saveTheme(mem(), 'purple') === false)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
