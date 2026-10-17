// Security headers and the visitor's address behind the Cloudflare tunnel (security.mjs).
//   node cctv/test/security.test.mjs
import { readFileSync } from 'node:fs'
import { CSP, clientIpOf, localProbe, routeOf, securityHeaders } from '../security.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

// the visitor's address
check('through the tunnel (cloudflared on this machine): the visitor behind it', clientIpOf('::ffff:127.0.0.1', '203.0.113.9') === '203.0.113.9')
check('... IPv6 visitors too', clientIpOf('127.0.0.1', '2001:db8::1') === '2001:db8::1' && clientIpOf('::1', '2001:db8::2') === '2001:db8::2')
check('a LAN client cannot claim another address with the header', clientIpOf('192.168.1.50', '1.2.3.4') === '192.168.1.50')
check('a garbage header from loopback is ignored', clientIpOf('127.0.0.1', '1.2.3.4, 5.6.7.8') === '127.0.0.1' && clientIpOf('127.0.0.1', '<script>') === '127.0.0.1')
{
  const office = routeOf('::ffff:192.168.2.57', undefined)
  check('shown to the visitor: an office PC is direct, by its own address', office.address === '192.168.2.57' && office.direct === true)
  const tunnel = routeOf('::ffff:127.0.0.1', '203.0.113.9')
  check('... one through the tunnel is not direct, by the address behind it', tunnel.address === '203.0.113.9' && tunnel.direct === false)
  check('... an office PC sending the header is still direct', routeOf('192.168.1.50', '1.2.3.4').direct === true && routeOf('192.168.1.50', '1.2.3.4').address === '192.168.1.50')
}
check('no header: the socket address', clientIpOf('::ffff:127.0.0.1', undefined) === '::ffff:127.0.0.1' && clientIpOf(undefined, undefined) === '')

// who gets the whole of /healthz (NVR ids, share paths, SDK load): the watcher on this machine
check('health detail: the watcher on this machine', localProbe('127.0.0.1', undefined) && localProbe('::ffff:127.0.0.1', undefined) && localProbe('::1', undefined))
check('health detail: not through the tunnel (cloudflared is loopback but adds CF-Connecting-IP)', !localProbe('127.0.0.1', '203.0.113.9') && !localProbe('::1', 'garbage') && !localProbe('127.0.0.1', ''))
check('health detail: not a LAN client, even without the header', !localProbe('192.168.1.50', undefined) && !localProbe(undefined, undefined) && !localProbe('127.0.0.2', undefined))
{
  // and server.mjs cuts the body down for anyone else before it is sent
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const route = src.slice(src.indexOf("if (pathname === '/healthz') {"))
  const end = route.indexOf('return sendJson(res, ok ? 200 : 503')
  const head = route.slice(0, end)
  check('server.mjs: /healthz sends the whole body only to localProbe or a signed-in admin, { ok } to anyone else',
    end > 0 && /localProbe\(req\.socket\.remoteAddress, req\.headers\['cf-connecting-ip'\]\)/.test(head) && /auth\.isAdmin\(/.test(head) && /^return sendJson\(res, ok \? 200 : 503, full \? body : \{ ok \}\)/.test(route.slice(end)))
}

// headers
const h =securityHeaders({})
check('enforced by default (every page was checked against it)', 'content-security-policy' in h && !('content-security-policy-report-only' in h))
check('CCTV_CSP=report-only goes back to reporting', 'content-security-policy-report-only' in securityHeaders({ CCTV_CSP: 'report-only' }))
check('HSTS, without includeSubDomains', /^max-age=\d+$/.test(h['strict-transport-security']))
check('the old headers stay', h['x-frame-options'] === 'DENY' && h['x-content-type-options'] === 'nosniff' && h['referrer-policy'] === 'no-referrer')
check('no inline or eval scripts allowed', /script-src 'self'(;|$)/.test(CSP) && !/unsafe-eval/.test(CSP))
check('not framable, no plugins, no base tag tricks', /frame-ancestors 'none'/.test(CSP) && /object-src 'none'/.test(CSP) && /base-uri 'none'/.test(CSP))
check('map tiles and blob pictures allowed', /img-src [^;]*tile\.openstreetmap\.org/.test(CSP) && /img-src [^;]*blob:/.test(CSP))

{
  // The sign-in page is shown before anyone is signed in, so everything it loads must be on the
  // short list of paths served without a session (server.mjs PUBLIC_PATHS). A file left off is
  // answered with a redirect to the sign-in page, and that script or stylesheet silently never runs.
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const list = /const PUBLIC_PATHS = new Set\(\[([^\]]*)\]\)/.exec(server)?.[1] ?? ''
  const allowed = new Set([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]))
  const wanted = [...page.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => (m[1].startsWith('/') ? m[1] : `/${m[1]}`))
  const missing = wanted.filter((p) => !allowed.has(p))
  check('everything the sign-in page loads is served before sign-in', wanted.length >= 8 && missing.length === 0, missing.join(' '))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
