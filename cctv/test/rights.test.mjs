// Offline tests for per-user rights (rights.mjs) and the rights screen's render (public/audit.js).
// Temp data folder only; nothing is sent anywhere, and no SDK is needed.
//   node cctv/test/rights.test.mjs
//
// The point of this file is the refusals. A permission test that only proves "the admin can" has
// proved nothing: every case below that matters is a case where the answer must be false.
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
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
const { renderRights, grantText, saveRightsFailure } = await import('../public/audit.js')

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
const J = JSON.stringify
// a POST body's rights as a current editor sends them: every grantable list present, live-hd included
// (a body without it is an editor page from before Live HD, refused 409 outdated)
const v2 = (rights = {}) => ({ ...rights, grants: { 'live-hd': [], ...(rights.grants ?? {}) } })
const auditRowsAll = () => readFileSync(join(DATA, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

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
  check('a viewer keeps full screen at full quality everywhere (Live HD *), as before', store.users.jo.grants['live-hd']?.join() === '*')
  check('rights.json is written as version 2', JSON.parse(readFileSync(R.RIGHTS_FILE, 'utf8')).version === 2)
  check('...with its shadow: every account\'s Live HD', JSON.parse(readFileSync(R.RIGHTS_SHADOW, 'utf8')).users.jo.join() === '*')
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
  check('GET as admin: 200 with every account', s1 === 200 && b1.users.length === 4 && b1.actions.length === 6 && b1.actions[1] === 'live-hd', JSON.stringify(b1?.actions))
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

  const joSeen = b1.users.find((u) => u.user === 'jo').seen
  const [s6, b6] = await R.handleRights('POST', '/api/admin/rights', json({ user: 'jo', rights: v2({ grants: { live: ['n1'] }, formats: ['pack'] }), seen: joSeen }), ADMIN)
  check('POST as admin: 200 and the stored row comes back', s6 === 200 && b6.rights.grants.live.join() === 'n1')
  const [s7, b7] = await R.handleRights('POST', '/api/admin/rights', json({ user: 'ghost', rights: v2() }), ADMIN)
  check('POST for an unknown account: 400', s7 === 400 && /no account/.test(b7.error), b7?.error)

  const [s8, , h8] = await R.handleRights('DELETE', '/api/admin/rights', json({}), ADMIN)
  check('an unsupported method: 405 with an Allow header', s8 === 405 && /POST/.test(h8.allow))
  check('another path: not handled (null)', (await R.handleRights('GET', '/api/admin/nvrs', json({}), ADMIN)) === null)

  check('/api/rights/me is not handled any more (it was never reachable: handleRights runs inside the admin block)', (await R.handleRights('GET', '/api/rights/me', json({}), VIEWER)) === null)
}

// ---- STALE EDITOR: POST /api/admin/rights is a compare-and-swap on the `seen` GET hands out ----
// audit.js Save used to post the whole row it opened with, no compare: a screen left open while
// somebody else tightened this person's access would silently put it back on the next save.
{
  const json = (o) => async () => o
  const [, before] = await R.handleRights('GET', '/api/admin/rights', json({}), ADMIN)
  const joRow = before.users.find((u) => u.user === 'jo')
  check('GET /api/admin/rights: each row carries a seen token', typeof joRow.seen === 'string' && joRow.seen.length > 0, JSON.stringify(joRow))
  check('rightsToken is exported and agrees with what GET sent', R.rightsToken(R.rightsOf('jo')) === joRow.seen)

  const wrong = await R.handleRights('POST', '/api/admin/rights', json({ user: 'jo', rights: v2({ grants: { live: ['n9'] } }), seen: 'not-the-real-token' }), ADMIN)
  check('POST with the wrong seen token: 409 stale', wrong[0] === 409 && wrong[1].stale === true && /reopen/i.test(wrong[1].error), JSON.stringify(wrong[1]))
  check('...and the stored row is not touched', R.rightsOf('jo').grants.live.join() === 'n1')

  const missing = await R.handleRights('POST', '/api/admin/rights', json({ user: 'jo', rights: v2({ grants: { live: ['n9'] } }) }), ADMIN) // no seen at all
  check('POST with no seen token at all: refused the same way (an old client cannot overwrite blindly)', missing[0] === 409 && missing[1].stale === true)
  check('...and the stored row is still not touched', R.rightsOf('jo').grants.live.join() === 'n1')

  // an account that does not exist: saveRights' own "no account" 400 still wins over a stale refusal
  const unknown = await R.handleRights('POST', '/api/admin/rights', json({ user: 'ghost', rights: v2() }), ADMIN)
  check('an unknown account: 400, not 409 (there is no row to be stale about)', unknown[0] === 400)

  const fresh = await R.handleRights('POST', '/api/admin/rights', json({ user: 'jo', rights: v2({ grants: { live: ['n1', 'n9'] }, formats: ['pack'] }), seen: joRow.seen }), ADMIN)
  check('POST with the token GET just handed out: saved', fresh[0] === 200 && fresh[1].rights.grants.live.join() === 'n1,n9', JSON.stringify(fresh[1]))
  check('...and the token moves on once the row changes', R.rightsToken(R.rightsOf('jo')) !== joRow.seen)
  // put jo back exactly as later checks in this file expect
  R.saveRights('jo', { grants: { live: ['n1'] }, formats: ['pack'] })
}

// ---- audit.js pure part: what Save shows for a failed POST -------------------------------------
{
  check('an ordinary error: shown plainly, not offered a reopen', JSON.stringify(saveRightsFailure(400, { error: 'bad request' })) === JSON.stringify({ stale: false, message: 'bad request' }))
  check('a stale refusal: told apart so Save can offer to reopen instead of retry', JSON.stringify(saveRightsFailure(409, { error: 'stale, reopen it', stale: true })) === JSON.stringify({ stale: true, message: 'stale, reopen it' }))
  check('a 409 that is not the stale shape: an ordinary error, not a reopen offer', saveRightsFailure(409, { error: 'x' }).stale === false)
  check('a body with no error text at all: falls back to the status', saveRightsFailure(500, {}).message === 'the server answered 500')
}

// ---- AUDIT ADMIN CHANGES: a role change is stated explicitly, not folded into "admin; " --------
// the audit detail used to say "admin; " only while the account IS an admin, so a demotion (which
// ends with rights.admin === false, same as somebody who was never an admin) was never recorded.
{
  const json = (o) => async () => o
  const auditRows = () => readFileSync(join(DATA, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const lastFor = (user) => auditRows().filter((r) => r.action === 'rights-change' && r.target === user).at(-1)

  const seenOf = (user) => R.rightsToken(R.rightsOf(user))
  const promote = await R.handleRights('POST', '/api/admin/rights', json({ user: 'sam', rights: v2({ admin: true }), seen: seenOf('sam') }), ADMIN)
  check('sam is promoted', promote[0] === 200 && promote[1].rights.admin === true)
  check('the audit row says "made admin", not just "admin;"', /made admin;/.test(lastFor('sam').detail), lastFor('sam').detail)

  // no role change (still admin): the plain "admin; " summary is kept, exactly as before this fix
  const same = await R.handleRights('POST', '/api/admin/rights', json({ user: 'sam', rights: v2({ admin: true, grants: { live: ['nvr1'] } }), seen: seenOf('sam') }), ADMIN)
  check('sam stays admin', same[0] === 200 && same[1].rights.admin === true)
  check('the audit row keeps the plain "admin; " summary, no "made admin" (nothing changed)', /^admin; /.test(lastFor('sam').detail) && !/made admin/.test(lastFor('sam').detail), lastFor('sam').detail)

  const demote = await R.handleRights('POST', '/api/admin/rights', json({ user: 'sam', rights: v2({ admin: false }), seen: seenOf('sam') }), ADMIN)
  check('sam is demoted', demote[0] === 200 && demote[1].rights.admin === false)
  check('the audit row says "admin removed", where it used to say nothing at all', /admin removed;/.test(lastFor('sam').detail), lastFor('sam').detail)
  check('...and it is not confused with "made admin"', !/made admin/.test(lastFor('sam').detail))

  // never an admin, never touched: no role wording either way, only the grant summary
  const untouched = await R.handleRights('POST', '/api/admin/rights', json({ user: 'sam', rights: v2({ grants: { live: ['nvr2'] } }), seen: seenOf('sam') }), ADMIN)
  check('a viewer whose admin flag never changes: no "admin;"/"made admin"/"admin removed" wording at all', untouched[0] === 200 && !/admin/.test(lastFor('sam').detail), lastFor('sam').detail)
  R.saveRights('sam', {}) // back to a clean viewer with no grants, as later sections expect
}

// ---- the rights screen's render ------------------------------------------------------------
{
  const [, body] = await R.handleRights('GET', '/api/admin/rights', async () => ({}), ADMIN)
  const r = renderRights(body)
  check('the Rights table uses the editor\'s names, in its order', JSON.stringify(r.labels) === JSON.stringify(['Live', 'Live HD', 'Playback SD', 'Playback HD', 'Export']) && JSON.stringify(r.actions) === JSON.stringify(['live', 'live-hd', 'playback-nvr', 'playback-server', 'export']))
  check('... an action it does not know goes last, under its own key', renderRights({ actions: ['live', 'live-4k'], users: [], formats: [] }).labels.join() === 'Live,live-4k')
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
  const [st] = await R.handleRights('POST', '/api/admin/rights', async () => ({ user: 'NAME', rights: v2({ grants: { live: ['*'] } }) }), ADMIN)
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

// ---- /api/sites (sitesFor): a viewer is told only about sites they hold a grant on, and never where an NVR is
{
  const SITES = [
    { id: 'nvr1', site: 'Main site', name: 'NVR 1', host: '10.0.0.5', sn: '', status: 'online', error: '', model: 'X', serial: 'S1', cameras: 9 },
    { id: 'rigginglot', site: 'Rigginglot', name: 'Rigginglot', host: 'c2020.autonat.com', sn: 'ABC123456', status: 'offline', error: 'cannot be reached at 10.8.0.9:6036', model: 'Y', serial: 'S2', cameras: 4 }
  ]
  R.saveRights('jo', { grants: { live: ['nvr1/2'] } })
  R.saveRights('sam', {}) // explicit: with no row, migrateRights would hand a viewer live '*'
  const jo = R.sitesFor({ user: 'jo', admin: false }, SITES)
  check('sitesFor: a viewer sees only the NVR they hold a camera on', jo.length === 1 && jo[0].id === 'nvr1', JSON.stringify(jo))
  check('sitesFor: no address, P2P serial, serial, model or error for a viewer', ['host', 'sn', 'serial', 'model', 'error', 'cameras'].every((k) => !(k in (jo[0] ?? {}))))
  check('sitesFor: ...but the site, name and status the site filter needs', jo[0]?.site === 'Main site' && jo[0]?.name === 'NVR 1' && jo[0]?.status === 'online')
  R.saveRights('jo', { grants: { export: ['rigginglot'] }, formats: ['pack'] })
  check('sitesFor: a grant in any action counts', R.sitesFor({ user: 'jo', admin: false }, SITES).map((s) => s.id).join() === 'rigginglot')
  R.saveRights('jo', { grants: { 'playback-nvr': ['*'] } })
  check('sitesFor: a "*" grant is every site', R.sitesFor({ user: 'jo', admin: false }, SITES).length === 2)
  R.saveRights('jo', { grants: { live: ['nvr10/1', 'nvr'] } })
  check('sitesFor: another NVR whose id starts the same is not this one', R.sitesFor({ user: 'jo', admin: false }, SITES).length === 0)
  check('sitesFor: a zero-grant viewer is told about no site', R.sitesFor({ user: 'sam', admin: false }, SITES).length === 0)
  check('sitesFor: no session, no sites', R.sitesFor(null, SITES).length === 0)
  check('sitesFor: an admin sees every NVR in full', R.sitesFor({ user: 'boss', admin: true }, SITES)[1].sn === 'ABC123456')
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check("server.mjs answers /api/sites through sitesFor", /pathname === '\/api\/sites'\)[^\n]*sitesFor\(/.test(server))
}

// ---- canPlayAnyOn: the gate for /api/playback/now and /dates (a whole NVR's clock and recording days)
{
  R.saveRights('sam', { grants: {} })
  check("canPlayAnyOn: a zero-grant viewer may not read an NVR's clock or recording days", R.canPlayAnyOn(SAM, 'rigginglot', [0, 1, 2]) === false)
  R.saveRights('sam', { grants: { live: ['rigginglot'] } })
  check('... watching live is not playing back', R.canPlayAnyOn(SAM, 'rigginglot', [0, 1, 2]) === false)
  R.saveRights('jo', { grants: { 'playback-server': ['rigginglot/2'] } })
  check('... one camera there that may be played back is enough', R.canPlayAnyOn(VIEWER, 'rigginglot', [0, 1, 2]) === true)
  check('... but it opens no other NVR', R.canPlayAnyOn(VIEWER, 'nvr1', [0, 1, 2]) === false)
  R.saveRights('jo', { grants: { 'playback-nvr': ['nvr1'] } })
  check('... an NVR-wide grant counts with no cameras listed', R.canPlayAnyOn(VIEWER, 'nvr1', []) === true)
  check('... an admin may; no NVR named is refused', R.canPlayAnyOn(ADMIN, 'nvr1', []) === true && R.canPlayAnyOn(ADMIN, '', [0]) === false)
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const branch = src.slice(src.indexOf("pathname.startsWith('/api/playback/')"))
  check('server.mjs: every /api/playback/* path passes canPlayAnyOn or the per-camera check before playbackApi', branch.indexOf('canPlayAnyOn(') > 0 && branch.indexOf('canPlayAnyOn(') < branch.indexOf('playbackApi('))
}

// ---- canPlayNvr: the NVR's own recordings are playback-nvr, never playback-server -----------------
{
  R.saveRights('jo', { grants: { 'playback-server': ['n1/3'] } })
  check('canPlayNvr: a server-playback grant is not NVR playback', R.canPlayNvr(VIEWER, 'n1', 3) === false && R.canPlayServer(VIEWER, 'n1', 3) === true)
  R.saveRights('jo', { grants: { 'playback-nvr': ['n1/3'] } })
  check('canPlayNvr: an NVR-playback grant for that camera', R.canPlayNvr(VIEWER, 'n1', 3) === true && R.canPlayServer(VIEWER, 'n1', 3) === false)
  check('canPlayNvr refuses the camera next door', R.canPlayNvr(VIEWER, 'n1', 4) === false)
  check('canPlayNvr refuses null, undefined and junk channels', R.canPlayNvr(null, 'n1', 3) === false && R.canPlayNvr(undefined, 'n1', 3) === false && R.canPlayNvr(VIEWER, 'n1', -1) === false && R.canPlayNvr(VIEWER, 'n1', Number.NaN) === false)
  check('canPlayNvr allows a session admin', R.canPlayNvr(ADMIN, 'n1', 0) === true)
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const recordings = src.slice(src.indexOf("pathname === '/api/playback/recordings'"))
  check("server.mjs: /api/playback/recordings (an NVR search) asks playback-nvr only", /^[^\n]*\n[\s\S]{0,300}if \(!can\(who, 'playback-nvr', target\)\) return sendJson\(res, 403/.test(recordings) && !/playback-server/.test(recordings.slice(0, 400)))
  const motion = src.slice(src.indexOf("url.pathname === '/motion'"))
  check("server.mjs: /motion (reads the NVR's recordings) asks playback-nvr only", /if \(!can\(who, 'playback-nvr', target\)\) return ws\.close\(1008/.test(motion.slice(0, 400)) && !/playback-server/.test(motion.slice(0, 400)))
}

// ---- Live HD (stream rights, 2026-09-29) ------------------------------------------------------------------
{
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' }, sam: { hash: 'x', role: 'viewer' } })
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1/0', 'n2'] } })
  check('live-hd: allowed where Live covers the camera too', R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 0 }) === true)
  check('live-hd: refused where Live does not, whatever live-hd says (it counts only with Live)', R.can(VIEWER, 'live-hd', { nvr: 'n2', ch: 0 }) === false)
  check('live-hd: refused on a camera of a Live site it does not list', R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 1 }) === false)
  check('live-hd: an admin always', R.can(ADMIN, 'live-hd', { nvr: 'n9', ch: 9 }) === true)
  R.saveRights('jo', { grants: { 'live-hd': ['*'] } })
  check('canAny(live-hd) with no Live at all: false', R.canAny(VIEWER, 'live-hd') === false)
  check('Live HD alone reveals no site (sitesFor)', R.sitesFor(VIEWER, [{ id: 'n1', site: 'S', name: 'N', status: 'online' }]).length === 0)
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1'] } })
  check('canAny(live-hd) with Live: true', R.canAny(VIEWER, 'live-hd') === true)
}
// mayHd: the one rule for a recorded or still picture from the main stream
{
  R.saveRights('jo', { grants: { 'playback-nvr': ['n1'] } })
  check('mayHd: Playback SD alone may not see main', R.mayHd(VIEWER, 'n1', 0) === false)
  R.saveRights('jo', { grants: { 'playback-nvr': ['n1'], live: ['n1'], 'live-hd': ['n1/0'] } })
  check('mayHd: Live HD on that camera may, not on the next one', R.mayHd(VIEWER, 'n1', 0) === true && R.mayHd(VIEWER, 'n1', 1) === false)
  R.saveRights('jo', { grants: { 'playback-server': ['n1/1'] } })
  check('mayHd: Playback HD on that camera may', R.mayHd(VIEWER, 'n1', 1) === true && R.mayHd(VIEWER, 'n1', 0) === false)
  check('mayHd: no session, a junk channel or no NVR: refused; an admin: allowed', R.mayHd(null, 'n1', 1) === false && R.mayHd(VIEWER, 'n1', -1) === false && R.mayHd(VIEWER, '', 1) === false && R.mayHd(ADMIN, 'n1', 7) === true)
}
// intersectTargets: the cameras two grant lists both cover
{
  const I = R.intersectTargets
  check("intersect: '*' with anything is that thing", J(I(['*'], ['n1', 'n2/3'])) === J(['n1', 'n2/3']) && J(I(['n1/0'], ['*'])) === J(['n1/0']))
  check('intersect: a site with one of its cameras is the camera', J(I(['n1'], ['n1/3'])) === J(['n1/3']) && J(I(['n1/3'], ['n1'])) === J(['n1/3']))
  check('intersect: the same site or camera is itself', J(I(['n1', 'n2/4'], ['n1', 'n2/4'])) === J(['n1', 'n2/4']))
  check('intersect: other sites or cameras give nothing (n1 is not n10)', J(I(['n1', 'n2/1'], ['n3', 'n2/2', 'n10'])) === '[]')
  check('intersect: nothing on either side is nothing', J(I([], ['*'])) === '[]' && J(I(['*'], [])) === '[]' && J(I(undefined, ['*'])) === '[]')
}

// ---- editors from before Live HD, and the diff-first audit detail -----------------------------------------
{
  const lastRightsRow = (user) => auditRowsAll().filter((r) => r.action === 'rights-change' && r.target === user).at(-1)
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' } })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 2, users: {} }))
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1'] } })
  const seen = R.rightsToken(R.rightsOf('jo'))
  const [s, b] = await R.handleRights('POST', '/api/admin/rights', async () => ({ user: 'jo', rights: { grants: { live: ['n1'] } }, seen }), ADMIN)
  check('an editor from before Live HD (no live-hd list): 409 outdated, never stale (no reopen loop)', s === 409 && b.outdated === true && !('stale' in b) && /reload/i.test(b.error), J(b))
  check('... and the stored row keeps its Live HD', J(R.rightsOf('jo').grants['live-hd']) === J(['n1']))
  const [s2] = await R.handleRights('POST', '/api/admin/rights', async () => ({ user: 'jo', rights: v2({ grants: { live: ['n1'] } }), seen }), ADMIN)
  check('with the live-hd list: saved, and the audit row starts with the change', s2 === 200 && /^removed live-hd: n1 \| now: live=n1 live-hd=none /.test(lastRightsRow('jo').detail), lastRightsRow('jo')?.detail)
  check('rightsChangeDetail: nothing changed says so', R.rightsChangeDetail(R.rightsOf('jo'), R.rightsOf('jo')).startsWith('no changes | now: '))
  check('rightsChangeDetail: formats too', /added formats: mp4/.test(R.rightsChangeDetail(R.rightsOf('jo'), { ...R.rightsOf('jo'), formats: ['mp4'] })))
}

// ---- rights.json version 1 -> 2 -----------------------------------------------------------------------
{
  const disk = () => JSON.parse(readFileSync(R.RIGHTS_FILE, 'utf8'))
  const systemRows = () => auditRowsAll().filter((r) => r.user === 'system' && r.action === 'rights-change')
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' }, sam: { hash: 'x', role: 'viewer' } })
  rmSync(R.RIGHTS_SHADOW, { force: true })
  const v1 = JSON.stringify({ version: 1, users: { jo: { grants: { live: ['n1', 'n2/3'], 'playback-nvr': ['*'] } }, sam: { grants: { 'playback-server': ['n1'] } } } })
  writeFileSync(R.RIGHTS_FILE, v1)
  const before = systemRows().length
  check('upgrade: Live HD wherever Live is', R.can(VIEWER, 'live-hd', { nvr: 'n2', ch: 3 }) === true && J(R.rightsOf('jo').grants['live-hd']) === J(['n1', 'n2/3']))
  check('upgrade: nothing else changes (playback, export, formats)', J(R.rightsOf('jo').grants['playback-nvr']) === J(['*']) && J(R.rightsOf('sam').grants['playback-server']) === J(['n1']) && R.rightsOf('sam').grants['live-hd'].length === 0)
  check('upgrade: written back as version 2', disk().version === 2 && J(disk().users.jo.grants['live-hd']) === J(['n1', 'n2/3']))
  check('upgrade: the file it replaced is kept byte for byte as rights.v1.json', readFileSync(R.RIGHTS_V1_BACKUP, 'utf8') === v1)
  check('upgrade: one system audit row saying what it did', systemRows().length === before + 1 && /upgraded from version 1 to 2/.test(systemRows().at(-1).detail) && /jo/.test(systemRows().at(-1).detail), systemRows().at(-1)?.detail)
  check('upgrade: ... it names who has Playback SD beyond Live (there the NVR\'s HD now needs Live HD or Playback HD), and only them', /; 1 account\(s\) \(jo\) have Playback SD on cameras without Live/.test(systemRows().at(-1).detail) && /the stored playback, export and admin rights are unchanged/.test(systemRows().at(-1).detail), systemRows().at(-1)?.detail)
  check('upgrade: the shadow now holds every account\'s Live HD', J(JSON.parse(readFileSync(R.RIGHTS_SHADOW, 'utf8')).users.jo) === J(['n1', 'n2/3']))
  R.loadRights()
  R.loadRights()
  check('upgrade: a version 2 file is never upgraded again', systemRows().length === before + 1)

  rmSync(R.RIGHTS_SHADOW, { force: true })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ users: { jo: { grants: { live: ['n4'] } } } }))
  check('a file with no version is upgraded as version 1', J(R.rightsOf('jo').grants['live-hd']) === J(['n4']) && disk().version === 2)

  writeFileSync(R.RIGHTS_FILE, '{ not json')
  R.loadRights()
  check('an unreadable file is left as it is (never written over)', readFileSync(R.RIGHTS_FILE, 'utf8') === '{ not json')
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 1, users: ['jo'] }))
  R.loadRights()
  check('a file whose users is not an object is left as it is', disk().version === 1 && Array.isArray(disk().users))

  const v3 = JSON.stringify({ version: 3, users: { jo: { grants: { live: ['n1'], 'live-hd': ['n1'], 'live-4k': ['n1'] } }, sam: { grants: { 'live-4k': ['n2'] } } } })
  writeFileSync(R.RIGHTS_FILE, v3)
  check('version 3: read as far as version 2 understands it', R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 0 }) === true && !('live-4k' in R.rightsOf('jo').grants))
  check('version 3: not written, not upgraded', readFileSync(R.RIGHTS_FILE, 'utf8') === v3)
  check('version 3: reported once (one system audit row)', systemRows().filter((r) => /version 3, newer/.test(r.detail)).length === 1)
  const [s3, b3] = await R.handleRights('POST', '/api/admin/rights', async () => ({ user: 'jo', rights: v2({ grants: { live: ['n2'] } }), seen: R.rightsToken(R.rightsOf('jo')) }), ADMIN)
  check('version 3: an editor save is refused 409 newer, nothing written', s3 === 409 && b3.newer === true && !b3.stale && readFileSync(R.RIGHTS_FILE, 'utf8') === v3, J(b3))
  check('version 3: saveRights refuses as well (never rewritten as version 2)', threw(() => R.saveRights('jo', { grants: { live: ['n2'] } }))?.status === 409 && readFileSync(R.RIGHTS_FILE, 'utf8') === v3)
  const rows3 = systemRows().length
  check('version 3: an account removed (or made again) takes out its own row only; the version and what this release does not know stay', R.forgetRights('sam') === true && disk().version === 3 && !('sam' in disk().users) && J(disk().users.jo.grants['live-4k']) === J(['n1']), J(disk()))
  check('... and says so in the audit', systemRows().length === rows3 + 1 && /version 3, from a newer release\): the row of sam removed/.test(systemRows().at(-1).detail), systemRows().at(-1)?.detail)
}

// ---- a rollback and back: the shadow keeps the Live HD taken away before it -------------------------------
{
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' }, sam: { hash: 'x', role: 'viewer' } })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 2, users: {} }))
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1/0'] } }) // HD on one camera only
  // an older release rewrites the file: version 1, live-hd dropped; it also gave jo Live on n2, and sam Live
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 1, users: { jo: { grants: { live: ['n1', 'n2'] } }, sam: { grants: { live: ['n5'] } } } }))
  check('back again: an account the shadow remembers keeps the Live HD it had, not all of its Live', J(R.rightsOf('jo').grants['live-hd']) === J(['n1/0']))
  check('... a camera given Live meanwhile gets no HD (default deny)', R.can(VIEWER, 'live-hd', { nvr: 'n2', ch: 0 }) === false && R.can(VIEWER, 'live', { nvr: 'n2', ch: 0 }) === true)
  check('... an account the shadow does not know gets Live HD = Live, as a first upgrade', J(R.rightsOf('sam').grants['live-hd']) === J(['n5']))
  check('... the audit row says which were restored', /restored from rights\.v2\.json/.test(auditRowsAll().filter((r) => r.user === 'system').at(-1).detail))
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1'] } })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 1, users: { jo: { grants: { live: ['n1/2'] } } } }))
  check('back again: the remembered HD is cut to the Live there is now (shadow ∩ live)', J(R.rightsOf('jo').grants['live-hd']) === J(['n1/2']))
  // a name removed and made again while the older release ran is a new person
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': [] } })
  const sh = JSON.parse(readFileSync(R.RIGHTS_SHADOW, 'utf8'))
  writeFileSync(R.RIGHTS_SHADOW, JSON.stringify({ ...sh, writtenAt: Date.now() - 60_000 }))
  auth.saveUsers({ ...auth.loadUsers(), jo: { hash: 'y', role: 'viewer', since: Date.now() } })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 1, users: { jo: { grants: { live: ['n1'] } } } }))
  check('an account made after the shadow was written is not given the old holder\'s Live HD', J(R.rightsOf('jo').grants['live-hd']) === J(['n1']))
}

// ---- an odd version, and a shadow that cannot be used: never more Live HD than the files say (fail closed) ---
{
  const disk = () => JSON.parse(readFileSync(R.RIGHTS_FILE, 'utf8'))
  const systemRows = () => auditRowsAll().filter((r) => r.user === 'system' && r.action === 'rights-change')
  const said = [] // the console, while an upgrade runs
  const quiet = (fn) => {
    const keep = [console.log, console.warn, console.error]
    console.log = console.warn = console.error = (...a) => said.push(a.join(' '))
    try {
      return fn()
    } finally {
      ;[console.log, console.warn, console.error] = keep
    }
  }
  const BOSS_ROLE = { user: 'boss', admin: false } // an admin by the account's role alone
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' }, sam: { hash: 'x', role: 'viewer' } })
  const UNREADABLE = `${R.RIGHTS_SHADOW}.unreadable`
  check('the unusable shadow\'s place beside it (RIGHTS_SHADOW_UNREADABLE)', R.RIGHTS_SHADOW_UNREADABLE === UNREADABLE)
  rmSync(UNREADABLE, { recursive: true, force: true })

  // (a) a version 2 file whose version is a string or not a whole number is read as version 1 and upgraded;
  // a live-hd list a row already carries (even an empty one) is kept, cut to its Live: never replaced by Live
  for (const version of ['2', 2.5]) {
    rmSync(R.RIGHTS_SHADOW, { force: true })
    writeFileSync(R.RIGHTS_FILE, J({ version, users: { jo: { grants: { live: ['n1', 'n2'], 'live-hd': ['n1/0', 'n3'] } }, sam: { grants: { live: ['n5'], 'live-hd': [] } }, boss: { grants: { live: ['*'] } } } }))
    const rows = systemRows().length
    quiet(() => R.loadRights())
    check(`version ${J(version)}: upgraded (read as version 1), written back as version 2`, disk().version === 2, J(disk().version))
    check('... a row\'s own Live HD list is kept, cut to its Live (no Live on n3): not all of its Live', J(R.rightsOf('jo').grants['live-hd']) === J(['n1/0']) && R.can(VIEWER, 'live-hd', { nvr: 'n2', ch: 0 }) === false && R.can(VIEWER, 'live', { nvr: 'n2', ch: 0 }) === true, J(R.rightsOf('jo').grants['live-hd']))
    check('... an explicit empty list stays empty: no Live HD, not Live', R.rightsOf('sam').grants['live-hd'].length === 0 && R.can(SAM, 'live', { nvr: 'n5', ch: 0 }) === true && R.can(SAM, 'live-hd', { nvr: 'n5', ch: 0 }) === false)
    check('... a row without a list gets Live, as in any upgrade', J(disk().users.boss.grants['live-hd']) === J(['*']))
    const d = systemRows().at(-1)?.detail ?? ''
    check('... the audit row says what the file said, and whose lists were kept', systemRows().length === rows + 1 && d.includes(`(the file said version ${J(version)})`) && /Live HD kept as the file had it \(cut to Live\) for 2 account\(s\) \(jo, sam\)/.test(d), d)
  }
  // with a shadow too: the row's own list is what the file says (as a version 2 file is read), not the shadow's
  writeFileSync(R.RIGHTS_SHADOW, J({ version: 2, writtenAt: Date.now() - 1000, users: { jo: ['*'], sam: ['*'] } }))
  writeFileSync(R.RIGHTS_FILE, J({ version: '2', users: { jo: { grants: { live: ['n1'], 'live-hd': ['n1/0'] } }, sam: { grants: { live: ['n5'] } } } }))
  quiet(() => R.loadRights())
  check('... with a shadow: a row\'s own list, never widened by the shadow; a row without one as the shadow says (cut to Live)', J(R.rightsOf('jo').grants['live-hd']) === J(['n1/0']) && J(R.rightsOf('sam').grants['live-hd']) === J(['n5']))
  // a live-hd that is there but not a list (a string, null, an object) is the row's own list as well: empty,
  // as a version 2 file reads it; never Live, and never the shadow's
  rmSync(R.RIGHTS_SHADOW, { force: true })
  writeFileSync(R.RIGHTS_FILE, J({ version: '2', users: { jo: { grants: { live: ['n1'], 'live-hd': 'n1/0' } }, sam: { grants: { live: ['n5'], 'live-hd': null } }, boss: { grants: { live: ['*'], 'live-hd': {} } } } }))
  quiet(() => R.loadRights())
  check('... a live-hd that is not a list (a string, null, an object): its own list, empty, not all of its Live', R.rightsOf('jo').grants['live-hd'].length === 0 && R.rightsOf('sam').grants['live-hd'].length === 0 && R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 0 }) === false && R.can(SAM, 'live-hd', { nvr: 'n5', ch: 0 }) === false && J(disk().users.jo.grants['live-hd']) === '[]', `jo ${J(R.rightsOf('jo').grants['live-hd'])}, sam ${J(R.rightsOf('sam').grants['live-hd'])}`)
  check('... named as kept in the audit row', /Live HD kept as the file had it \(cut to Live\) for 3 account\(s\) \(boss, jo, sam\)/.test(systemRows().at(-1)?.detail ?? ''), systemRows().at(-1)?.detail)
  writeFileSync(R.RIGHTS_SHADOW, J({ version: 2, writtenAt: Date.now() - 1000, users: { jo: ['*'] } }))
  writeFileSync(R.RIGHTS_FILE, J({ version: 2.5, users: { jo: { grants: { live: ['n1'], 'live-hd': 'n1' } } } }))
  quiet(() => R.loadRights())
  check('... and with a shadow that holds Live HD for it: still its own, empty', R.rightsOf('jo').grants['live-hd'].length === 0, J(R.rightsOf('jo').grants['live-hd']))

  // (b) a shadow that exists but cannot be used: kept aside as rights.v2.json.unreadable, Live HD for nobody
  // (admins keep everything: admin is the role), named in the audit row and on the console
  const v1 = J({ version: 1, users: { jo: { grants: { live: ['n1'], 'playback-nvr': ['n1'] } }, sam: { grants: { live: ['n5'] } }, boss: { grants: { live: ['*'] } } } })
  const cases = [
    ['not JSON', 'not json'],
    ['writtenAt 1e300 (beyond what a Date holds: its time could not even be printed)', '{"version":2,"writtenAt":1e300,"users":{"jo":["n1"],"sam":["n5"]}}'],
    ['writtenAt -1e300', '{"version":2,"writtenAt":-1e300,"users":{"jo":["n1"],"sam":["n5"]}}'],
    ['writtenAt just past the Date range', J({ version: 2, writtenAt: 8.64e15 + 1, users: { jo: ['n1'], sam: ['n5'] } })],
    ['writtenAt not a number', J({ version: 2, writtenAt: '2026-09-29', users: { jo: ['n1'], sam: ['n5'] } })],
    // in the Date range, but no time a shadow was written at: every account with users.json `since` would
    // count as made after it, and get Live HD = Live
    ['writtenAt 0', J({ version: 2, writtenAt: 0, users: { jo: ['n1'], sam: ['n5'] } })],
    ['writtenAt -1', J({ version: 2, writtenAt: -1, users: { jo: ['n1'], sam: ['n5'] } })],
    ['writtenAt 1 (1970)', J({ version: 2, writtenAt: 1, users: { jo: ['n1'], sam: ['n5'] } })],
    ['writtenAt just before 2026 (the shadow came with this release)', J({ version: 2, writtenAt: Date.UTC(2026, 0, 1) - 1, users: { jo: ['n1'], sam: ['n5'] } })],
    ['users not an object', J({ version: 2, writtenAt: Date.now(), users: ['jo'] })],
    ['a list, not a shadow', '[]']
  ]
  for (const [what, bytes] of cases) {
    rmSync(UNREADABLE, { recursive: true, force: true })
    writeFileSync(R.RIGHTS_SHADOW, bytes)
    writeFileSync(R.RIGHTS_FILE, v1)
    const rows = systemRows().length
    said.length = 0
    const e = threw(() => quiet(() => R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 0 })))
    check(`shadow ${what}: nothing thrown, and rights.json upgraded`, e === null && disk().version === 2, e?.message)
    check('... Live HD for nobody (never Live HD = Live); Live itself as it was', R.rightsOf('jo').grants['live-hd'].length === 0 && R.rightsOf('sam').grants['live-hd'].length === 0 && R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 0 }) === false && R.can(VIEWER, 'live', { nvr: 'n1', ch: 0 }) === true && J(disk().users.jo.grants['live-hd']) === '[]')
    check('... an admin keeps everything (admin is the role, not a row)', R.can(BOSS_ROLE, 'live-hd', { nvr: 'n1', ch: 0 }) === true && R.mayHd(BOSS_ROLE, 'n1', 0) === true)
    check('... the unusable file kept aside, byte for byte, as rights.v2.json.unreadable; the new shadow holds no Live HD', existsSync(UNREADABLE) && readFileSync(UNREADABLE, 'utf8') === bytes && J(JSON.parse(readFileSync(R.RIGHTS_SHADOW, 'utf8')).users) === J({ boss: [], jo: [], sam: [] }))
    const d = systemRows().at(-1)?.detail ?? ''
    check('... one audit row naming the file, the accounts and what to do (re-grant Live HD in the editor)', systemRows().length === rows + 1 && d.startsWith('rights.json upgraded from version 1 to 2: rights.v2.json could not be used (') && d.includes('is kept as rights.v2.json.unreadable, so Live HD was given to nobody; re-grant it in the access editor (Users & audit, Edit access) to whoever should have it: 2 account(s) with Live have none now (jo, sam)'), d)
    check('... Playback SD beyond an HD right named as such (jo has Live there, but no Live HD now)', d.includes("1 account(s) (jo) have Playback SD on cameras without Live HD or Playback HD: there the NVR's recordings and event pictures are now SD only"), d)
    check('... and the same on the console', said.some((l) => l.includes('rights.v2.json.unreadable') && l.includes('re-grant it in the access editor') && l.includes('(jo, sam)')), said.join(' | '))
  }
  // the widening itself: writtenAt 0, and an account made since (users.json `since`), which would count as made
  // after the shadow and get Live HD = Live
  auth.saveUsers({ ...auth.loadUsers(), jo: { hash: 'x', role: 'viewer', since: Date.now() - 5000 } })
  rmSync(UNREADABLE, { recursive: true, force: true })
  writeFileSync(R.RIGHTS_SHADOW, J({ version: 2, writtenAt: 0, users: { jo: [], sam: [] } }))
  writeFileSync(R.RIGHTS_FILE, v1)
  quiet(() => R.loadRights())
  check('shadow writtenAt 0 and an account made since: not "made after the shadow" (Live HD = Live), Live HD for nobody', R.rightsOf('jo').grants['live-hd'].length === 0 && R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 0 }) === false, J(R.rightsOf('jo').grants['live-hd']))
  auth.saveUsers({ ...auth.loadUsers(), jo: { hash: 'x', role: 'viewer' } })
  rmSync(UNREADABLE, { recursive: true, force: true })
  // from 2026 on it is a time the shadow may have been written at
  writeFileSync(R.RIGHTS_SHADOW, J({ version: 2, writtenAt: Date.UTC(2026, 0, 1), users: { jo: ['n1/0'], sam: [] } }))
  writeFileSync(R.RIGHTS_FILE, `${v1} `)
  quiet(() => R.loadRights())
  check('shadow written at the start of 2026: used (restored, cut to Live)', J(R.rightsOf('jo').grants['live-hd']) === J(['n1/0']) && R.rightsOf('sam').grants['live-hd'].length === 0 && !existsSync(UNREADABLE), J(R.rightsOf('jo').grants['live-hd']))
  // an account's entry that is not a list: no Live HD for that account (not "not remembered", which is Live)
  rmSync(UNREADABLE, { recursive: true, force: true })
  writeFileSync(R.RIGHTS_SHADOW, J({ version: 2, writtenAt: Date.now() - 1000, users: { jo: 'n1', sam: ['n5'] } }))
  writeFileSync(R.RIGHTS_FILE, v1)
  quiet(() => R.loadRights())
  check('shadow with an entry that is not a list: that account gets no Live HD; the others as the shadow says', R.rightsOf('jo').grants['live-hd'].length === 0 && J(R.rightsOf('sam').grants['live-hd']) === J(['n5']) && !existsSync(UNREADABLE))
  check('... restored from the shadow for both (the audit row)', /Live HD restored from rights\.v2\.json \(written [^)]+\) for 2 account\(s\) \(jo, sam\)/.test(systemRows().at(-1)?.detail ?? ''), systemRows().at(-1)?.detail)
  // the unusable shadow's copy cannot be kept (a folder with a file in it where it would go): nothing is
  // written (the shadow would be written over), Live HD for nobody from memory, the upgrade tried again later
  writeFileSync(R.RIGHTS_SHADOW, 'not json')
  mkdirSync(UNREADABLE, { recursive: true })
  writeFileSync(join(UNREADABLE, 'x'), 'x')
  writeFileSync(R.RIGHTS_FILE, v1)
  let rows = systemRows().length
  const e1 = threw(() => quiet(() => R.rightsOf('jo')))
  check('shadow unusable and cannot be kept aside: nothing thrown, nothing written, Live HD for nobody', e1 === null && readFileSync(R.RIGHTS_FILE, 'utf8') === v1 && readFileSync(R.RIGHTS_SHADOW, 'utf8') === 'not json' && R.rightsOf('jo').grants['live-hd'].length === 0 && R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 0 }) === false && systemRows().length === rows, e1?.message)
  rmSync(UNREADABLE, { recursive: true, force: true })
  // a shadow that cannot even be read (a folder in its place): there are no bytes to keep, so nothing is
  // written either (as when the copy cannot be kept), and Live HD for nobody from memory
  rmSync(R.RIGHTS_SHADOW, { force: true })
  mkdirSync(R.RIGHTS_SHADOW)
  writeFileSync(R.RIGHTS_FILE, `${v1}  `)
  rows = systemRows().length
  const e0 = threw(() => quiet(() => R.rightsOf('jo')))
  check('shadow that cannot be read at all: nothing thrown, nothing written or moved, Live HD for nobody', e0 === null && readFileSync(R.RIGHTS_FILE, 'utf8') === `${v1}  ` && statSync(R.RIGHTS_SHADOW).isDirectory() && !existsSync(UNREADABLE) && R.rightsOf('jo').grants['live-hd'].length === 0 && R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 0 }) === false && systemRows().length === rows, e0?.message)
  rmSync(R.RIGHTS_SHADOW, { recursive: true, force: true })
  rmSync(UNREADABLE, { recursive: true, force: true })
  // never a moment without a shadow: the unusable one stays in its place until the shadow that replaces it
  // lands (one rename). A crash just before that rename, or adduser.mjs upgrading at the same moment, must
  // not find rights.json still version 1 and no shadow at all: that reads as "no shadow", Live HD = Live
  // for everyone. The files are looked at the moment that rename is asked for, then put back as a crash
  // there would leave them, and upgraded again.
  writeFileSync(R.RIGHTS_SHADOW, 'not json')
  writeFileSync(R.RIGHTS_FILE, v1)
  const fileText = (p) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf8') : null) // (null: none, or a folder)
  const shadowUsers = () => {
    try {
      return JSON.parse(readFileSync(R.RIGHTS_SHADOW, 'utf8')).users
    } catch {
      return null
    }
  }
  let moment = null
  const realRename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (moment === null && to === R.RIGHTS_SHADOW) moment = { rights: fileText(R.RIGHTS_FILE), shadow: fileText(R.RIGHTS_SHADOW), aside: fileText(UNREADABLE) }
    return realRename(from, to)
  }
  syncBuiltinESMExports() // (rights.mjs's own `renameSync` is this one now)
  try {
    quiet(() => R.loadRights())
  } finally {
    fs.renameSync = realRename
    syncBuiltinESMExports()
  }
  check('the unusable shadow is still in its place when the shadow replacing it is renamed in (its copy kept already)', moment?.shadow === 'not json' && moment?.aside === 'not json' && moment?.rights === v1, J(moment))
  check('... then replaced by a shadow with no Live HD; the copy kept', J(shadowUsers()) === J({ boss: [], jo: [], sam: [] }) && fileText(UNREADABLE) === 'not json')
  if (moment?.rights) {
    writeFileSync(R.RIGHTS_FILE, moment.rights)
    if (moment.shadow === null) rmSync(R.RIGHTS_SHADOW, { force: true })
    else writeFileSync(R.RIGHTS_SHADOW, moment.shadow)
    rows = systemRows().length
    quiet(() => R.loadRights())
    check('... a crash at that moment, then the next upgrade: still Live HD for nobody (never Live HD = Live)', R.rightsOf('jo').grants['live-hd'].length === 0 && R.rightsOf('sam').grants['live-hd'].length === 0 && R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 0 }) === false && R.can(SAM, 'live-hd', { nvr: 'n5', ch: 0 }) === false, `jo ${J(R.rightsOf('jo').grants['live-hd'])}, sam ${J(R.rightsOf('sam').grants['live-hd'])}`)
    check('... and its audit row names the unusable shadow again', systemRows().length === rows + 1 && systemRows().at(-1).detail.includes('rights.v2.json could not be used ('), systemRows().at(-1)?.detail)
  }
  rmSync(UNREADABLE, { recursive: true, force: true })
  // the shadow replacing it cannot be written (a folder where its temp file goes): nothing to put back, the
  // unusable one never left its place, so the next try fails closed the same way
  writeFileSync(R.RIGHTS_SHADOW, 'not json')
  writeFileSync(R.RIGHTS_FILE, `${v1}   `)
  const shadowTmp = `${R.RIGHTS_SHADOW}.tmp-${process.pid}`
  mkdirSync(shadowTmp)
  writeFileSync(join(shadowTmp, 'x'), 'x')
  rows = systemRows().length
  const e3 = threw(() => quiet(() => R.rightsOf('jo')))
  check('shadow unusable and its replacement cannot be written: nothing thrown, the unusable one in its place, its copy kept, rights.json version 1, Live HD for nobody', e3 === null && fileText(R.RIGHTS_SHADOW) === 'not json' && fileText(UNREADABLE) === 'not json' && disk().version === 1 && R.rightsOf('jo').grants['live-hd'].length === 0 && systemRows().length === rows, e3?.message)
  rmSync(shadowTmp, { recursive: true, force: true })
  rmSync(UNREADABLE, { recursive: true, force: true })
  // the shadow replaced, then rights.json cannot be written: the shadow now there holds no Live HD, so the
  // next try gives none either (restored from it)
  writeFileSync(R.RIGHTS_FILE, `${v1} `)
  const blocker = `${R.RIGHTS_FILE}.tmp-${process.pid}`
  mkdirSync(blocker)
  rows = systemRows().length
  const e2 = threw(() => quiet(() => R.rightsOf('jo')))
  check('shadow unusable and rights.json cannot be written: nothing thrown, the copy kept, the shadow now holds no Live HD, rights.json version 1, Live HD for nobody', e2 === null && fileText(UNREADABLE) === 'not json' && J(shadowUsers()) === J({ boss: [], jo: [], sam: [] }) && disk().version === 1 && R.rightsOf('jo').grants['live-hd'].length === 0 && systemRows().length === rows, e2?.message)
  rmSync(blocker, { recursive: true, force: true })
  writeFileSync(R.RIGHTS_FILE, v1)
  quiet(() => R.loadRights())
  check('... and the next try (the file changed): still Live HD for nobody, upgraded and audited', disk().version === 2 && R.rightsOf('jo').grants['live-hd'].length === 0 && R.rightsOf('sam').grants['live-hd'].length === 0 && systemRows().length === rows + 1, systemRows().at(-1)?.detail)
  rmSync(UNREADABLE, { recursive: true, force: true })

  // more than 8 names: the audit row (cut at 500 characters) names 8 "and N more"; the console, which has no
  // cap, names every account, so whoever re-grants Live HD has the whole list
  const many = Array.from({ length: 11 }, (_, i) => `v${String(i + 1).padStart(2, '0')}`)
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, ...Object.fromEntries(many.map((n) => [n, { hash: 'x', role: 'viewer' }])) })
  const manyV1 = J({ version: 1, users: Object.fromEntries(many.map((n) => [n, { grants: { live: ['n1'], 'playback-nvr': ['n1'] } }])) })
  const all = many.join(', ')
  const first8 = `${many.slice(0, 8).join(', ')} and 3 more`
  writeFileSync(R.RIGHTS_SHADOW, 'not json')
  writeFileSync(R.RIGHTS_FILE, manyV1)
  said.length = 0
  quiet(() => R.loadRights())
  let d = systemRows().at(-1)?.detail ?? ''
  check('11 accounts, shadow unusable: the audit row names 8 of them "and 3 more"', d.includes(`11 account(s) with Live have none now (${first8})`), d)
  check('... the console names all 11 (whom to re-grant Live HD), in every clause', said.some((l) => l.includes(`11 account(s) with Live have none now (${all})`) && l.includes(`11 account(s) (${all}) have Playback SD`)), said.join(' | '))
  rmSync(UNREADABLE, { recursive: true, force: true })
  rmSync(R.RIGHTS_SHADOW, { force: true })
  writeFileSync(R.RIGHTS_FILE, manyV1)
  said.length = 0
  quiet(() => R.loadRights())
  d = systemRows().at(-1)?.detail ?? ''
  check('11 accounts, no shadow: the audit row names 8 "and 3 more", the console all 11', d.includes(`Live HD given wherever Live was granted for 11 account(s) (${first8})`) && said.some((l) => l.includes(`Live HD given wherever Live was granted for 11 account(s) (${all})`)), `${d} || ${said.join(' | ')}`)
  rmSync(R.RIGHTS_SHADOW, { force: true })
}

// ---- the shadow never holds Live HD that rights.json has not got (written first, cut to old and new) --------
{
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' } })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 2, users: {} }))
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1/0'] } })
  const shadowHd = () => JSON.parse(readFileSync(R.RIGHTS_SHADOW, 'utf8')).users.jo
  const was = readFileSync(R.RIGHTS_FILE, 'utf8')
  // rights.json cannot be written (a folder where its temp file goes): the save fails after the shadow's first write
  const blocker = `${R.RIGHTS_FILE}.tmp-${process.pid}`
  mkdirSync(blocker)
  const e1 = threw(() => R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1'] } }))
  check('a grant that could not be saved: refused, rights.json as it was', e1 !== null && readFileSync(R.RIGHTS_FILE, 'utf8') === was, e1?.message)
  check('... and the shadow holds only the Live HD the old and the new row both have, never the grant', J(shadowHd()) === J(['n1/0']), J(shadowHd()))
  rmSync(blocker, { recursive: true, force: true })
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1'] } })
  check('saved: the shadow holds the new Live HD', J(shadowHd()) === J(['n1']))
  // the shadow cannot be written (a folder in its place): refused before rights.json is touched
  const now = readFileSync(R.RIGHTS_FILE, 'utf8')
  rmSync(R.RIGHTS_SHADOW, { force: true })
  mkdirSync(R.RIGHTS_SHADOW)
  const e2 = threw(() => R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': [] } }))
  check('a shadow that cannot be written: the save is refused, rights.json as it was', e2 !== null && /rights\.v2\.json/.test(e2.message) && readFileSync(R.RIGHTS_FILE, 'utf8') === now, e2?.message)
  const [s4, b4] = await R.handleRights('POST', '/api/admin/rights', async () => ({ user: 'jo', rights: v2({ grants: { live: ['n1'] } }), seen: R.rightsToken(R.rightsOf('jo')) }), ADMIN)
  check('... through the editor: an error, and nothing saved', s4 === 400 && /rights\.v2\.json/.test(b4.error) && J(R.rightsOf('jo').grants['live-hd']) === J(['n1']), J(b4))
  rmSync(R.RIGHTS_SHADOW, { recursive: true, force: true })
}

// ---- the camera lists the pages read (liveCameras, playbackCameras) ----------------------------------------
{
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' } })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 2, users: {} }))
  const CAMS = [{ nvr: 'n1', ch: 0, name: 'A' }, { nvr: 'n1', ch: 1, name: 'B' }, { nvr: 'n2', ch: 0, name: 'C' }]
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1/0'], 'playback-nvr': ['n1/1', 'n2'], 'playback-server': ['n2/0'] } })
  const live = R.liveCameras(VIEWER, CAMS)
  check('liveCameras: only the cameras with Live, their own fields kept', J(live.map((c) => c.name)) === J(['A', 'B']) && live[0].nvr === 'n1' && live[0].ch === 0)
  check('... hd where Live HD is; playback where either playback right is', live[0].hd === true && live[1].hd === false && live[0].playback === false && live[1].playback === true, J(live))
  const pb = R.playbackCameras(VIEWER, CAMS)
  check('playbackCameras: only cameras with a playback right', J(pb.map((c) => c.name)) === J(['B', 'C']))
  check('... Playback SD only: sd; no hd, no NVR HD (no Live HD there), no legs', J([pb[0].sd, pb[0].hd, pb[0].nvrHd, pb[0].legs]) === J([true, false, false, false]))
  check('... SD and HD: every flag (Playback HD may see main; legs need both)', J([pb[1].sd, pb[1].hd, pb[1].nvrHd, pb[1].legs]) === J([true, true, true, true]))
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1'], 'playback-nvr': ['n1'] } })
  check('... SD with Live HD there: NVR HD', R.playbackCameras(VIEWER, CAMS)[0].nvrHd === true)
  check('an admin: every camera, every flag', R.liveCameras(ADMIN, CAMS).every((c) => c.hd && c.playback) && R.liveCameras(ADMIN, CAMS).length === 3 && R.playbackCameras(ADMIN, CAMS).every((c) => c.sd && c.hd && c.nvrHd && c.legs))
  check('no session: nothing', R.liveCameras(null, CAMS).length === 0 && R.playbackCameras(null, CAMS).length === 0)
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check('server.mjs: /api/cameras through liveCameras, ?for=playback through playbackCameras', /pathname === '\/api\/cameras'\) return sendJson\(res, 200, url\.searchParams\.get\('for'\) === 'playback' \? playbackCameras\(who, allCameras\(\{ live: true \}\)\) : liveCameras\(who, allCameras\(\{ live: true \}\)\)\)/.test(src))
  const rsrc = readFileSync(new URL('../rights.mjs', import.meta.url), 'utf8')
  check('an admin\'s lists are made without asking can() per camera (as the old route did)', /export function liveCameras\(who, cams\) \{[^}]*?if \(who\?\.admin === true\) return cams\.map/.test(rsrc) && /export function playbackCameras\(who, cams\) \{\s*if \(who\?\.admin === true\) return cams\.map/.test(rsrc))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
