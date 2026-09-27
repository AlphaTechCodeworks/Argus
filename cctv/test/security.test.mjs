// Security headers and the visitor's address behind the Cloudflare tunnel (security.mjs).
//   node cctv/test/security.test.mjs
import { CSP, clientIpOf, securityHeaders } from '../security.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

// the visitor's address
check('through the tunnel (cloudflared on this machine): the visitor behind it', clientIpOf('::ffff:127.0.0.1', '203.0.113.9') === '203.0.113.9')
check('... IPv6 visitors too', clientIpOf('127.0.0.1', '2001:db8::1') === '2001:db8::1' && clientIpOf('::1', '2001:db8::2') === '2001:db8::2')
check('a LAN client cannot claim another address with the header', clientIpOf('192.168.1.50', '1.2.3.4') === '192.168.1.50')
check('a garbage header from loopback is ignored', clientIpOf('127.0.0.1', '1.2.3.4, 5.6.7.8') === '127.0.0.1' && clientIpOf('127.0.0.1', '<script>') === '127.0.0.1')
check('no header: the socket address', clientIpOf('::ffff:127.0.0.1', undefined) === '::ffff:127.0.0.1' && clientIpOf(undefined, undefined) === '')

// headers
const h = securityHeaders({})
check('report-only by default (pages are checked against it first)', 'content-security-policy-report-only' in h && !('content-security-policy' in h))
check('CCTV_CSP=enforce makes it binding', 'content-security-policy' in securityHeaders({ CCTV_CSP: 'enforce' }))
check('HSTS, without includeSubDomains', /^max-age=\d+$/.test(h['strict-transport-security']))
check('the old headers stay', h['x-frame-options'] === 'DENY' && h['x-content-type-options'] === 'nosniff' && h['referrer-policy'] === 'no-referrer')
check('no inline or eval scripts allowed', /script-src 'self'(;|$)/.test(CSP) && !/unsafe-eval/.test(CSP))
check('not framable, no plugins, no base tag tricks', /frame-ancestors 'none'/.test(CSP) && /object-src 'none'/.test(CSP) && /base-uri 'none'/.test(CSP))
check('map tiles and blob pictures allowed', /img-src [^;]*tile\.openstreetmap\.org/.test(CSP) && /img-src [^;]*blob:/.test(CSP))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
