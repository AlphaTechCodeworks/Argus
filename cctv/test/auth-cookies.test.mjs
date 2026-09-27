// Cookie parsing (auth.mjs parseCookies) never throws: a malformed Cookie header on a WebSocket
// upgrade, where nothing catches, used to take the whole server down ("cctv_session=%").
//   node cctv/test/auth-cookies.test.mjs
import { parseCookies } from '../auth.mjs'

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
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
