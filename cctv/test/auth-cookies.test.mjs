// Cookie parsing (auth.mjs parseCookies) never throws: a malformed Cookie header on a WebSocket
// upgrade, where nothing catches, used to take the whole server down ("cctv_session=%").
//   node cctv/test/auth-cookies.test.mjs
// Also: a session is bound to the account it was issued to (auth.mjs verifySession and `since`).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// auth.mjs reads DATA_DIR (users.json, the session secret) when it is first imported
const dir = mkdtempSync(join(tmpdir(), 'cctv-auth-'))
process.env.DATA_DIR = dir
const { createSession, parseCookies, saveUsers, verifySession } = await import('../auth.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const safe = (h) => { try { return parseCookies(h) } catch (e) { return e } }

check('an ordinary header', JSON.stringify(safe('a=1; cctv_session=abc.123.sig')) === '{"a":"1","cctv_session":"abc.123.sig"}')
check('percent-encoding decoded', safe('x=a%20b').x === 'a b')
for (const bad of ['cctv_session=%', 'cctv_session=%E0%A4%A', 'a=%zz; b=2', '=%; ;;']) {
  const r = safe(bad)
  check(`malformed "${bad}": no throw`, !(r instanceof Error), r instanceof Error ? r.message : '')
}
check('... the bad value is kept as it came (it matches no session)', safe('cctv_session=%').cctv_session === '%')
check('... the good cookies beside it still parse', safe('a=%zz; b=2').b === '2')
check('no header at all', JSON.stringify(safe(undefined)) === '{}' && JSON.stringify(safe(null)) === '{}')
check('__proto__ as a cookie name does not touch the prototype', (() => { const r = safe('__proto__=x'); return Object.getPrototypeOf(r) === Object.prototype && ({}).x === undefined })())

// a session belongs to the account it was issued to: a name removed and made again is a new account,
// and a cookie of the earlier one (still unexpired) must not sign anyone in as the new one
{
  saveUsers({ ann: { hash: 'x', role: 'viewer' } })
  const old = createSession('ann')
  check('an account without "since" (made before it existed) keeps its sessions', verifySession(old) === 'ann')
  saveUsers({ ann: { hash: 'x', role: 'viewer', since: Date.now() + 1000 } })
  check('a token issued before the account existed is refused', verifySession(old) === null)
  saveUsers({ ann: { hash: 'x', role: 'viewer', since: Date.now() - 1000 } })
  check('a token issued after it is accepted', verifySession(createSession('ann')) === 'ann')
  saveUsers({})
  check('a removed account has no session at all', verifySession(createSession('ann')) === null)
}
rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
