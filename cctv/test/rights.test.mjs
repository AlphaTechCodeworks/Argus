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

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
