// Offline tests for per-user rights (rights.mjs) and the rights screen's render (public/audit.js).
// Temp data folder only; nothing is sent anywhere, and no SDK is needed.
//   node cctv/test/rights.test.mjs
//
// The point of this file is the refusals. A permission test that only proves "the admin can" has
// proved nothing: every case below that matters is a case where the answer must be false.
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-rights-test-'))
const DATA = process.env.DATA_DIR
const USERS = join(DATA, 'users.json')

// boss: an admin created before this phase. legacy: the oldest shape of all, a bare hash string,
// which auth.mjs already treats as an admin. jo/sam: viewers.
writeFileSync(
  USERS,
  JSON.stringify({
    boss: { hash: 'x', role: 'admin' },
    legacy: 'scrypt:aa:bb',
    jo: { hash: 'x', role: 'viewer' },
    sam: { hash: 'x', role: 'viewer' }
  })
)

const R = await import('../rights.mjs')
const { renderRights, grantText } = await import('../public/audit.js')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const threw = (fn) => {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

const ADMIN = { user: 'boss', admin: true }
const VIEWER = { user: 'jo', admin: false }
const SAM = { user: 'sam', admin: false }

// ---- the migration -------------------------------------------------------------------------
// This is the part that decides whether anybody is locked out of a running server.
{
  const store = R.loadRights() // no rights.json yet: migrates from users.json
  check('migration wrote rights.json', statSync(R.RIGHTS_FILE).isFile())
  // Windows has no POSIX modes and node reports 0666 whatever was asked for, so the mode is only
  // asserted where it means something. It is the deployment target (Linux) that has to be right.
  const mode = statSync(R.RIGHTS_FILE).mode & 0o777
  check(
    process.platform === 'win32' ? 'rights.json mode: not checked on Windows' : 'rights.json is mode 0600',
    process.platform === 'win32' ? true : mode === 0o600,
    mode.toString(8)
  )
  check('the existing admin is still an admin', store.users.boss.admin === true)
  check('the oldest role-less account is still an admin', store.users.legacy.admin === true)
  check('a viewer is not an admin', store.users.jo.admin === false)
  check('a viewer keeps live everywhere, as before', store.users.jo.grants.live.join() === '*')
  check('a viewer keeps NVR playback everywhere, as before', store.users.jo.grants['playback-nvr'].join() === '*')
  check('a viewer gains NO server playback (canPlayServer refused them)', store.users.jo.grants['playback-server'].length === 0)
  check('a viewer gains NO export', store.users.jo.grants.export.length === 0 && store.users.jo.formats.length === 0)
  check('adminList names both admins', R.adminList().join() === 'boss,legacy', R.adminList().join())
}

// The real lockout guard: an admin whose account exists but who has no row here at all.
{
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 1, users: { jo: R.emptyRights() } }))
  check('an admin with no rights row is still an admin (never locked out)', R.can({ user: 'boss', admin: false }, 'admin') === true)
  check('...and adminList still finds them', R.adminList().includes('boss'))
  check('a viewer with no rights row gets nothing', R.can({ user: 'sam', admin: false }, 'live', { nvr: 'n1', ch: 0 }) === false)
}

// ---- default deny --------------------------------------------------------------------------
{
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 1, users: {} }))
  for (const action of R.ACTIONS) {
    check(`nobody: ${action} denied`, R.can(null, action, { nvr: 'n1', ch: 0 }) === false)
    check(`unknown user: ${action} denied`, R.can({ user: 'nobody-at-all', admin: false }, action, { nvr: 'n1', ch: 0 }) === false)
    check(`empty-rights viewer: ${action} denied`, R.can(SAM, action, { nvr: 'n1', ch: 0 }, { honourSessionAdmin: false }) === false)
  }
  check('undefined who: denied', R.can(undefined, 'live', { nvr: 'n1', ch: 0 }) === false)
  check('a string who with no rights: denied', R.can('sam', 'live', { nvr: 'n1', ch: 0 }) === false)
  check('an unknown action is denied even for an admin', R.can(ADMIN, 'delete-everything', { nvr: 'n1', ch: 0 }) === false)
  check('an empty action is denied', R.can(ADMIN, '', null) === false)
  check('canAny is default deny too', R.ACTIONS.every((a) => R.canAny(SAM, a) === false))
}

// ---- forged and hostile input --------------------------------------------------------------
{
  // The exact attack the rules call out: a client that sends its own role.
  check('who.admin as the string "true" is not admin', R.can({ user: 'sam', admin: 'true' }, 'admin') === false)
  check('who.admin as 1 is not admin', R.can({ user: 'sam', admin: 1 }, 'admin') === false)
  check('who.admin as {} is not admin', R.can({ user: 'sam', admin: {} }, 'admin') === false)
  check('a "role" field on who is ignored entirely', R.can({ user: 'sam', role: 'admin' }, 'admin') === false)
  check('a "rights" field on who is ignored entirely', R.can({ user: 'sam', rights: { admin: true } }, 'admin') === false)
  check('a "grants" field on who is ignored entirely', R.can({ user: 'sam', grants: { live: ['*'] } }, 'live', { nvr: 'n1', ch: 0 }) === false)
  check('a numeric user name is not a user', R.can({ user: 7, admin: false }, 'live', { nvr: 'n1', ch: 0 }) === false)
  check('an empty user name is not a user', R.can({ user: '', admin: false }, 'live', { nvr: 'n1', ch: 0 }) === false)
  check('a prototype-ish name does not resolve to a row', R.can({ user: '__proto__', admin: false }, 'live', { nvr: 'n1', ch: 0 }) === false)
  check('a "constructor" name does not resolve to a row', R.can({ user: 'constructor', admin: false }, 'admin') === false)

  // A stored row that has been tampered with by hand.
  const tampered = R.cleanRights({ admin: 'yes', grants: { live: ['*'], 'no-such-action': ['*'] }, formats: ['pack', 'exe'], extra: 1 })
  check('cleanRights: admin only from the literal true', tampered.admin === false)
  check('cleanRights: an unknown action is dropped', !('no-such-action' in tampered.grants))
  check('cleanRights: an unknown format is dropped', tampered.formats.join() === 'pack')
  check('cleanRights: unknown keys do not survive', Object.keys(tampered).sort().join() === 'admin,formats,grants')
  check('cleanRights of a string is empty rights', R.cleanRights('admin').admin === false)
  check('cleanRights of an array is empty rights', R.cleanRights([{ admin: true }]).admin === false)
  check('cleanRights of null is empty rights', R.cleanRights(null).admin === false)

  const t = R.cleanRights({ grants: { live: ['*', 'n1', 'n1/3', 'n1/003', '../../etc', 'n1/x', 'n1/3/4', 5, null, { nvr: 'n1' }] } })
  check('cleanTarget keeps only the three legal shapes', t.grants.live.join() === '*,n1,n1/3', t.grants.live.join())
  check('a channel with leading zeros normalises to one grant', t.grants.live.filter((x) => x.startsWith('n1/')).length === 1)
}

// ---- grants that do work ---------------------------------------------------------------------
{
  writeFileSync(
    R.RIGHTS_FILE,
    JSON.stringify({
      version: 1,
      users: {
        jo: {
          admin: false,
          grants: {
            live: ['n1'], // the whole of site n1
            'playback-server': ['n1/3'], // one camera only
            'playback-nvr': [],
            export: ['n1/3']
          },
          formats: ['pack']
        },
        sam: { admin: false, grants: { live: ['*'], 'playback-server': [], 'playback-nvr': [], export: [] }, formats: [] }
      }
    })
  )

  check('a site grant covers every camera on that site', R.can(VIEWER, 'live', { nvr: 'n1', ch: 0 }) && R.can(VIEWER, 'live', { nvr: 'n1', ch: 99 }))
  check('a site grant does NOT cross to another site', R.can(VIEWER, 'live', { nvr: 'n2', ch: 0 }) === false)
  check('a camera grant covers that camera', R.can(VIEWER, 'playback-server', { nvr: 'n1', ch: 3 }) === true)
  check('a camera grant does NOT cover the camera next door', R.can(VIEWER, 'playback-server', { nvr: 'n1', ch: 4 }) === false)
  check('a camera grant does NOT become a site grant', R.can(VIEWER, 'playback-server', { nvr: 'n1' }) === false)
  check('one action does not leak into another', R.can(VIEWER, 'playback-nvr', { nvr: 'n1', ch: 3 }) === false)
  check('a site-wide "*" grant covers any site', R.can(SAM, 'live', { nvr: 'whatever', ch: 12 }) === true)
  check('"*" for live does not grant playback', R.can(SAM, 'playback-server', { nvr: 'whatever', ch: 12 }) === false)
  check('a viewer is never an admin, however many grants they hold', R.can(SAM, 'admin') === false)

  // Target shapes that must not accidentally widen anything.
  check('a missing target does not satisfy a site grant', R.can(VIEWER, 'live', null) === false)
  check('an empty target object does not satisfy a site grant', R.can(VIEWER, 'live', {}) === false)
  check('target "*" is not a camera and does not match', R.can(VIEWER, 'live', '*') === false)
  check('a string channel does not match a camera grant', R.can(VIEWER, 'playback-server', { nvr: 'n1', ch: '3' }) === false)
  check('a fractional channel does not match', R.can(VIEWER, 'playback-server', { nvr: 'n1', ch: 3.5 }) === false)
  check('a negative channel does not match', R.can(VIEWER, 'playback-server', { nvr: 'n1', ch: -1 }) === false)
  check('a NaN channel does not match', R.can(VIEWER, 'playback-server', { nvr: 'n1', ch: Number.NaN }) === false)
  check('the string target shape works too', R.can(VIEWER, 'playback-server', 'n1/3') === true)

  // Export: the format is half the permission.
  check('export of a granted camera in a granted format', R.can(VIEWER, 'export', { nvr: 'n1', ch: 3, format: 'pack' }) === true)
  check('export in a format NOT granted is refused', R.can(VIEWER, 'export', { nvr: 'n1', ch: 3, format: 'mp4' }) === false)
  check('export with no format named is refused', R.can(VIEWER, 'export', { nvr: 'n1', ch: 3 }) === false)
  check('export in a made-up format is refused', R.can(VIEWER, 'export', { nvr: 'n1', ch: 3, format: 'iso' }) === false)
  check('export of a camera NOT granted is refused', R.can(VIEWER, 'export', { nvr: 'n1', ch: 4, format: 'pack' }) === false)
  check('canAny(export) is true for jo', R.canAny(VIEWER, 'export') === true)
  check('canAny(export) is false for sam, who has no formats', R.canAny(SAM, 'export') === false)

  // The old call shape still behaves.
  check('canPlayServer still works for a granted camera', R.canPlayServer(VIEWER, 'n1', 3) === true)
  check('canPlayServer refuses an ungranted camera', R.canPlayServer(VIEWER, 'n1', 4) === false)
  check('canPlayServer refuses null and undefined', R.canPlayServer(null, 'n1', 0) === false && R.canPlayServer(undefined, 'n1', 0) === false)
  check('canPlayServer allows a session admin, as it always did', R.canPlayServer(ADMIN, 'n1', 0) === true)
}

// ---- admins can do everything ------------------------------------------------------------------
{
  for (const action of R.ACTIONS) {
    check(`stored admin: ${action} allowed`, R.can({ user: 'boss', admin: false }, action, { nvr: 'n9', ch: 9, format: 'mp4' }) === true)
  }
  check('CCTV_AUTH=off (user "dev", admin true) still works with no account', R.can({ user: 'dev', admin: true }, 'export', { nvr: 'n1', ch: 0, format: 'pack' }) === true)
  check('...and honourSessionAdmin:false proves the store alone would refuse it', R.can({ user: 'dev', admin: true }, 'export', { nvr: 'n1', ch: 0, format: 'pack' }, { honourSessionAdmin: false }) === false)
}

// ---- saving ---------------------------------------------------------------------------------
{
  const saved = R.saveRights('jo', { admin: false, grants: { live: ['n2'] }, formats: ['mp4'] })
  check('saveRights stores the cleaned row', saved.grants.live.join() === 'n2' && saved.formats.join() === 'mp4')
  check('...and it is on disk', JSON.parse(readFileSync(R.RIGHTS_FILE, 'utf8')).users.jo.grants.live.join() === 'n2')
  check('...and takes effect at once', R.can(VIEWER, 'live', { nvr: 'n2', ch: 0 }) === true && R.can(VIEWER, 'live', { nvr: 'n1', ch: 0 }) === false)

  check('an account that does not exist cannot be given rights', threw(() => R.saveRights('ghost', { admin: true }))?.status === 400)
  check('a name with a slash is refused', threw(() => R.saveRights('a/b', { admin: true }))?.status === 400)
  check('an empty name is refused', threw(() => R.saveRights('', { admin: true }))?.status === 400)
  check('a non-string name is refused', threw(() => R.saveRights(null, { admin: true }))?.status === 400)
  check('the ghost got no row', !('ghost' in R.loadRights().users))

  // The production lockout guard.
  R.saveRights('legacy', { admin: false })
  const last = threw(() => R.saveRights('boss', { admin: false }))
  check('the last admin cannot be demoted', last?.status === 400 && /at least one admin/.test(last.message), last?.message)
  check('...and boss is still an admin afterwards', R.can({ user: 'boss', admin: false }, 'admin') === true)
  R.saveRights('sam', { admin: true })
  check('with a second admin, the first can be stepped down', R.saveRights('boss', { admin: false }).admin === false)
  check('...and boss really has lost admin now', R.can({ user: 'boss', admin: false }, 'admin') === false)
  R.saveRights('boss', { admin: true })
  R.saveRights('sam', { admin: false, grants: { live: ['*'] } })
}

// ---- a broken rights file ---------------------------------------------------------------------
{
  const good = readFileSync(R.RIGHTS_FILE, 'utf8')
  writeFileSync(R.RIGHTS_FILE, '{ not json')
  check('an unreadable file denies a viewer rather than guessing', R.can(VIEWER, 'live', { nvr: 'n1', ch: 0 }) === false)
  check('...but a session admin still gets in (no lockout)', R.can(ADMIN, 'admin') === true)
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ users: 'not an object' }))
  check('a file with a nonsense users field denies everyone', R.can(VIEWER, 'live', { nvr: 'n1', ch: 0 }) === false)
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ users: { jo: { admin: true } } }))
  // admin is the account's role in users.json and nothing else: a flag in this file never decides it
  check('a hand-edited admin flag in rights.json grants nothing (users.json decides)', R.can({ user: 'jo', admin: false }, 'admin') === false)
  writeFileSync(R.RIGHTS_FILE, good)
  chmodSync(R.RIGHTS_FILE, 0o600)
}

// ---- the route -------------------------------------------------------------------------------
{
  const json = (o) => async () => o
  const [s1, b1] = await R.handleRights('GET', '/api/admin/rights', json({}), ADMIN)
  check('GET as admin: 200 with every account', s1 === 200 && b1.users.length === 4 && b1.actions.length === 5, JSON.stringify(b1?.actions))
  check('GET lists the admins', b1.admins.includes('boss'))

  const [s2, b2] = await R.handleRights('GET', '/api/admin/rights', json({}), VIEWER)
  check('GET as a viewer: 403', s2 === 403, JSON.stringify(b2))
  const [s3] = await R.handleRights('POST', '/api/admin/rights', json({ user: 'jo', rights: { admin: true } }), VIEWER)
  check('POST as a viewer: 403', s3 === 403)
  check('...and jo did not become an admin', R.can({ user: 'jo', admin: false }, 'admin') === false)

  // The escalation attempt the rules ask for: a viewer claiming to be someone else in the body.
  const [s4] = await R.handleRights('POST', '/api/admin/rights', json({ user: 'jo', rights: { admin: true }, admin: true, who: ADMIN }), VIEWER)
  check('a viewer cannot escalate by putting admin:true in the body', s4 === 403)
  check('...still not an admin', R.can({ user: 'jo', admin: false }, 'admin') === false)
  const [s5] = await R.handleRights('POST', '/api/admin/rights', json({ user: 'jo', rights: { admin: true } }), null)
  check('no session at all: 403', s5 === 403)

  const [s6, b6] = await R.handleRights('POST', '/api/admin/rights', json({ user: 'jo', rights: { grants: { live: ['n1'] }, formats: ['pack'] } }), ADMIN)
  check('POST as admin: 200 and the stored row comes back', s6 === 200 && b6.rights.grants.live.join() === 'n1')
  const [s7, b7] = await R.handleRights('POST', '/api/admin/rights', json({ user: 'ghost', rights: {} }), ADMIN)
  check('POST for an unknown account: 400', s7 === 400 && /no account/.test(b7.error), b7?.error)

  const [s8, , h8] = await R.handleRights('DELETE', '/api/admin/rights', json({}), ADMIN)
  check('an unsupported method: 405 with an Allow header', s8 === 405 && /POST/.test(h8.allow))
  check('another path: not handled (null)', (await R.handleRights('GET', '/api/admin/nvrs', json({}), ADMIN)) === null)

  const [s9, b9] = await R.handleRights('GET', '/api/rights/me', json({}), VIEWER)
  check('/api/rights/me: a viewer may read their own rights', s9 === 200 && b9.user === 'jo' && b9.admin === false)
  check('...and it is their OWN row, not a way to read anyone else', b9.rights.grants.live.join() === 'n1')
  const [s10] = await R.handleRights('GET', '/api/rights/me', json({}), null)
  check('/api/rights/me with no session: 401', s10 === 401)
}

// ---- the rights screen's render ------------------------------------------------------------
{
  const [, body] = await R.handleRights('GET', '/api/admin/rights', async () => ({}), ADMIN)
  const r = renderRights(body)
  check('render lists every account', r.users.length === 4)
  check('render does not offer "admin" as a per-camera column', !r.actions.includes('admin'))
  const boss = r.users.find((u) => u.user === 'boss')
  check('an admin reads as "everywhere (admin)", not as empty', boss.cells.every((c) => c.text === 'everywhere (admin)'))
  check('an admin may use any export format', boss.formatText === 'any format')
  const jo = r.users.find((u) => u.user === 'jo')
  check('a camera-less action says "no access", never a blank', jo.cells.find((c) => c.action === 'playback-nvr').text === 'no access')
  check('grantText turns targets into English', grantText(['*']) === 'everywhere' && grantText(['n1']) === 'all of n1' && grantText(['n1/3']) === 'n1 camera 4')
  check('grantText of nothing says so', grantText([]) === 'no access' && grantText(undefined) === 'no access')
  check('the note warns while there is only one admin', /only admin/.test(renderRights({ users: [{ user: 'a', admin: true }], actions: [], formats: [] }).note))
  check('renderRights survives a junk body', renderRights(null).users.length === 0 && renderRights({}).users.length === 0)
}

// ---- admin is kept in one place: the account's role in users.json ----------------------------------
// Two stores deciding admin meant a demoted admin kept every camera (a stale admin:true row), and the
// editor's Admin switch could not take admin away (the users.json role still said admin).
const auth = await import('../auth.mjs')
const whoOf = (user) => ({ user, admin: auth.isAdmin(user) }) // as server.mjs builds it from the session
{
  auth.saveUsers({
    boss: { hash: 'x', role: 'admin' },
    bob: { hash: 'x', role: 'admin' },
    alice: { hash: 'x', role: 'admin' },
    carol: { hash: 'x', role: 'viewer' },
    jo: { hash: 'x', role: 'viewer' },
    sam: { hash: 'x', role: 'viewer' }
  })
  R.migrateRights() // bob and alice get the migration's admin rows
  check('setup: the migration stored an admin row for bob', R.loadRights().users.bob?.admin === true)

  // (i) demoted in users.json, the stale admin row must not keep him an admin
  auth.saveUsers({ ...auth.loadUsers(), bob: { hash: 'x', role: 'viewer' } })
  check('a demoted admin loses every camera, whatever his old row says', R.can(whoOf('bob'), 'live', { nvr: 'nvr1', ch: 0 }) === false)
  check('...and every export', R.canAny(whoOf('bob'), 'export') === false)
  check('...and is not listed as an admin', !R.adminList().includes('bob'), R.adminList().join())

  // (ii) the editor's Admin switch off really takes admin away
  R.saveRights('alice', { admin: false, grants: { live: ['solus'] } })
  check('saving admin:false makes the account a viewer in users.json', auth.isAdmin('alice') === false && auth.loadUsers().alice.role === 'viewer')
  check('...so she keeps only what was ticked', R.can(whoOf('alice'), 'live', { nvr: 'nvr1', ch: 0 }) === false && R.can(whoOf('alice'), 'live', { nvr: 'solus', ch: 2 }) === true)
  check('...and the password is untouched', auth.loadUsers().alice.hash === 'x')

  // (iii) and the switch on makes an admin
  R.saveRights('carol', { admin: true })
  check('saving admin:true makes the account an admin in users.json', auth.isAdmin('carol') === true && R.can(whoOf('carol'), 'admin') === true)

  // (iv) the last admin still cannot be switched off, and users.json keeps the role
  R.saveRights('carol', { admin: false })
  const last = threw(() => R.saveRights('boss', { admin: false }))
  check('the last admin cannot be demoted', last?.status === 400 && /at least one admin/.test(last.message), last?.message)
  check('...and users.json still has boss as an admin', auth.loadUsers().boss.role === 'admin' && R.adminList().join() === 'boss', R.adminList().join())

  // (v) a row whose account is gone is nothing
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 1, users: { ...R.loadRights().users, ghost2: { admin: true, grants: { live: ['*'] }, formats: [] } } }))
  check('a row left behind by a removed account is not an admin', R.rightsOf('ghost2').admin === false)
  check('...and grants nothing', R.can({ user: 'ghost2', admin: false }, 'live', { nvr: 'nvr1', ch: 0 }) === false && JSON.stringify(R.rightsOf('ghost2')) === JSON.stringify(R.emptyRights()))
}

// ---- rights rows follow the accounts ---------------------------------------------------------------
{
  // a stale row (the production data has one called "NAME") is never shown, and goes on the next save
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 1, users: { ...R.loadRights().users, NAME: { admin: false, grants: { live: ['*'] }, formats: [] } } }))
  const [, listed] = await R.handleRights('GET', '/api/admin/rights', async () => ({}), ADMIN)
  check('GET /api/admin/rights lists only existing accounts', !listed.users.some((u) => u.user === 'NAME' || u.user === 'ghost2') && listed.users.length === Object.keys(auth.loadUsers()).length, listed.users.map((u) => u.user).join())
  const [st] = await R.handleRights('POST', '/api/admin/rights', async () => ({ user: 'NAME', rights: { grants: { live: ['*'] } } }), ADMIN)
  check('POST /api/admin/rights refuses a user that does not exist', st === 400)
  R.saveRights('jo', { grants: { live: ['nvr1/0'] } })
  const stored = Object.keys(R.loadRights().users)
  check('the next save prunes rows of accounts that do not exist', !stored.includes('NAME') && !stored.includes('ghost2') && stored.includes('jo'), stored.join())

  // forgetRights: an account removed or created drops its row, so a name that comes back starts clean
  check('forgetRights removes the row', R.forgetRights('jo') === true && !Object.hasOwn(R.loadRights().users, 'jo'))
  check('...and the account then has no access at all', JSON.stringify(R.rightsOf('jo')) === JSON.stringify(R.emptyRights()))
  check('...a second forget is a no-op', R.forgetRights('jo') === false)
  R.saveRights('boss', { admin: true, grants: { live: ['nvr1'] } })
  R.forgetRights('boss')
  check('an admin account with its row forgotten is still an admin (the role decides)', R.rightsOf('boss').admin === true && R.can(whoOf('boss'), 'admin') === true)
  check('forgetRights ignores junk names', R.forgetRights(null) === false && R.forgetRights('') === false && R.forgetRights('__proto__') === false)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
