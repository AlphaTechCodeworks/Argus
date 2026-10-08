// Accounts from the app, not only from the server's command line (adduser.mjs): an admin can add a
// user -- a viewer who watches and plays back, or another admin -- change a password or role, and
// remove one. What a viewer may see is then set per camera on the Audit page (rights.mjs).
//
//   GET    /api/admin/users              -> { users: [{ name, role }] }
//   POST   /api/admin/users              { name, password?, role } -> { user: { name, role } }
//                                         (password required for a new user, at least 8 characters)
//   DELETE /api/admin/users/:name        -> { removed: name }
//
// The same rules as adduser.mjs, and two of its own: the last admin cannot be removed or made a
// viewer (nobody could administer the system after), and an admin cannot remove themselves. The
// password is hashed here (auth.mjs hashPassword) and never stored, logged or sent back.
//
// Rights follow the account. A removed account's rights row goes with it, and a new account starts
// with none (rights.mjs forgetRights): a new viewer sees nothing until an admin ticks something, and
// a name that comes back never inherits what its last holder was allowed. A new account records
// `since`, so the last holder's unexpired cookie does not sign in as the new one (auth.mjs).
import { audit } from './audit.mjs'
import { DATA_DIR, hashPassword, loadUsers, saveUsers, signOutUser } from './auth.mjs'
import { userSessions } from './user-sessions.mjs'
import { HttpError } from './nvr-xml.mjs'
import { forgetRights } from './rights.mjs'

const NAME_RE = /^[\w.@-]{1,64}$/
const ROLES = ['viewer', 'admin']

const list = (users) => Object.entries(users).map(([name, u]) => ({ name, role: u.role === 'admin' ? 'admin' : 'viewer' })).sort((a, b) => a.name.localeCompare(b.name))
const admins = (users) => Object.entries(users).filter(([, u]) => u.role === 'admin').map(([n]) => n)

/**
 * @returns {Promise<[number, object]|null>} null when the path is not ours
 * @param {{ user: string, admin: boolean }} who from the signed session, never the request body
 */
export async function handleUsers(method, pathname, readJson, who, { disconnectUser = () => {} } = {}) {
  if (pathname !== '/api/admin/users' && !pathname.startsWith('/api/admin/users/')) return null
  if (!who?.admin) throw new HttpError(403, 'Only an admin can manage accounts')
  let users = loadUsers()

  if (method === 'GET' && pathname === '/api/admin/users') {
    const sessions = userSessions.list()
    const byUser = new Map()
    for (const session of sessions) {
      if (!byUser.has(session.user)) byUser.set(session.user, [])
      byUser.get(session.user).push(session)
    }
    return [200, { users: list(users).map(u => ({ ...u, self: u.name === who.user, sessions: byUser.get(u.name) ?? [] })) }, { 'cache-control': 'no-store' }]
  }

  const kick = /^\/api\/admin\/users\/([^/]+)\/sign-out$/.exec(pathname)
  if (method === 'POST' && kick) {
    const name = decodeURIComponent(kick[1])
    if (name === who.user) throw new HttpError(409, 'Use Sign out to end your own session')
    if (!signOutUser(name)) throw new HttpError(404, 'No such user')
    disconnectUser(name)
    userSessions.forget(name)
    audit(DATA_DIR, { user: who.user, action: 'user-sign-out', target: name, ok: true })
    return [200, { signedOut: name }]
  }

  if (method === 'POST' && pathname === '/api/admin/users') {
    const body = await readJson()
    const name = String(body?.name ?? '').trim()
    const role = String(body?.role ?? 'viewer')
    const password = body?.password === undefined || body?.password === '' ? null : String(body.password)
    if (!NAME_RE.test(name)) throw new HttpError(400, 'A user name is letters, digits and . _ @ - (up to 64)')
    if (!ROLES.includes(role)) throw new HttpError(400, 'role must be viewer or admin')
    const existed = Object.hasOwn(users, name)
    if (!existed && !password) throw new HttpError(400, 'A new user needs a password')
    if (password !== null && password.length < 8) throw new HttpError(400, 'A password is at least 8 characters')
    if (existed && users[name].role === 'admin' && role !== 'admin' && admins(users).length <= 1) {
      throw new HttpError(409, `${name} is the only admin: add another admin first`)
    }
    const hash = password !== null ? await hashPassword(password) : null
    // Hashing yields: preserve any other account's concurrent sign-out/change.
    users = loadUsers()
    if (Object.hasOwn(users, name) !== existed) throw new HttpError(409, 'This account changed; refresh and try again')
    if (existed && users[name].role === 'admin' && role !== 'admin' && admins(users).length <= 1) throw new HttpError(409, `${name} is the only admin: add another admin first`)
    users[name] = { ...(users[name] ?? {}), role, ...(hash !== null ? { hash, ...(existed ? { mustChangePassword: true, since: Math.max(Date.now() + 1, (users[name].since || 0) + 1) } : {}) } : {}), ...(existed ? {} : { since: Date.now() }) }
    saveUsers(users)
    if (hash !== null && existed) userSessions.forget(name)
    if (!existed) forgetRights(name) // a row left behind by an earlier account of this name
    audit(DATA_DIR, { user: who.user, action: existed ? 'user-change' : 'user-add', target: name, detail: `${role}${password !== null ? ', password set' : ''}`, ok: true })
    console.log(`[users] ${who.user} ${existed ? 'changed' : 'added'} ${name} (${role}${password !== null ? ', password set' : ''})`)
    return [200, { user: { name, role } }]
  }

  const m = /^\/api\/admin\/users\/([^/]+)$/.exec(pathname)
  if (method === 'DELETE' && m) {
    const name = decodeURIComponent(m[1])
    if (!Object.hasOwn(users, name)) throw new HttpError(404, 'No such user')
    if (name === who.user) throw new HttpError(409, 'You cannot remove your own account')
    if (users[name].role === 'admin' && admins(users).length <= 1) throw new HttpError(409, `${name} is the only admin`)
    delete users[name]
    saveUsers(users)
    userSessions.forget(name)
    forgetRights(name)
    audit(DATA_DIR, { user: who.user, action: 'user-remove', target: name, ok: true })
    console.log(`[users] ${who.user} removed ${name}`)
    return [200, { removed: name }]
  }
  throw new HttpError(405, 'Method not allowed')
}
