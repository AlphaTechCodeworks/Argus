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
check('admin leads with Users & access, then sites, settings, storage, reports', ids([NAV_GROUPS[2]]).join() === 'audit,sites,settings,storage,reports')
check('no item appears twice', new Set(ids(NAV_GROUPS)).size === ids(NAV_GROUPS).length)
check('only the admin group is admin-only', NAV_GROUPS.filter((g) => g.adminOnly).map((g) => g.id).join() === 'admin')

check('an admin sees all ten', ids(navFor({ admin: true })).length === 10)
check('a viewer never sees the admin pages', !ids(navFor({ admin: false })).some((i) => ['sites', 'settings', 'storage', 'reports', 'audit'].includes(i)))
check('an unknown user is treated as a viewer', ids(navFor({})).length === 5)

// partial admins: only the admin links their capabilities reach, and the Admin group
// disappears when none remain
check('a camera manager sees Sites only in Admin', ids(navFor({ admin: false, adminCaps: ['cameras'] })).filter((i) => ['audit', 'sites', 'settings', 'storage', 'reports'].includes(i)).join() === 'sites')
// a deputy holds `audit`, which reaches the Users & access page for the log; account management
// inside that page is gated separately (mayEditAdmin, audit.js), not by hiding the link
check('a deputy admin (all but users) sees every admin link (users-management is gated in-page)', (() => { const a = ids(navFor({ admin: false, adminCaps: ['cameras', 'settings', 'storage', 'reports', 'audit', 'reboot', 'diagnostics'] })); return ['audit', 'sites', 'settings', 'storage', 'reports'].every((i) => a.includes(i)) })())
check('a deputy WITHOUT the audit cap does not see the Users & access link', !ids(navFor({ admin: false, adminCaps: ['cameras', 'settings', 'storage', 'reports', 'reboot', 'diagnostics'] })).includes('audit'))
check('the `users` capability shows Users & access', ids(navFor({ admin: false, adminCaps: ['users'] })).includes('audit'))
check('the `audit` capability alone also shows Users & access (the log lives there)', ids(navFor({ admin: false, adminCaps: ['audit'] })).includes('audit'))
check('a partial admin with no mapped area sees no Admin group', navFor({ admin: false, adminCaps: ['reboot'] }).some((g) => g.id === 'admin') === false)
check('a reboot/diagnostics-only admin still sees the viewer groups', ids(navFor({ admin: false, adminCaps: ['reboot'] })).join() === 'live,playback,map,alarms,health')

// the Map page can be turned off per person (rights.mjs canSeeMap): the nav link then disappears
check('Map on by default', ids(navFor({ admin: false })).includes('map'))
check('a viewer with the Map turned off does not see the Map link', !ids(navFor({ admin: false, map: false })).includes('map'))
check('...but still sees the other Watch items', ids(navFor({ admin: false, map: false })).filter((i) => ['live', 'playback', 'alarms', 'health'].includes(i)).join() === 'live,playback,alarms,health')
check('a full admin always sees the Map even if map:false', ids(navFor({ admin: true, map: false })).includes('map'))

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
