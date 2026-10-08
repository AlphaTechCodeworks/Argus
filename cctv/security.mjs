// Security headers and the visitor's address (security audit 2026-09-27, now that Argus is public
// through the Cloudflare tunnel).

// A Content-Security-Policy as a backstop against any script injection, and HSTS so a browser never
// falls back to plain HTTP. Enforced since 2026-09-27, after every page was loaded under it in report-only
// mode: the only violations were Cloudflare's injected analytics beacon (blocked now, which is
// fine) and framing (refused, as meant). CCTV_CSP=report-only goes back to reporting. Map tiles come from
// OpenStreetMap and ArcGIS. No includeSubDomains on HSTS: other *.jfl.gripe hosts are not ours to
// force onto HTTPS.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://server.arcgisonline.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ')

export function securityHeaders(env = process.env) {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=15552000',
    [env.CCTV_CSP === 'report-only' ? 'content-security-policy-report-only' : 'content-security-policy']: CSP
  }
}

// Through the tunnel every visitor arrives from cloudflared on this machine (127.0.0.1), so the
// sign-in limiter counted all of them as one address: 10 bad passwords from anyone locked every remote
// user out for 15 minutes, and the audit log said 127.0.0.1 for everyone. Cloudflare passes the
// visitor's address in CF-Connecting-IP. It is believed only on a connection from this machine
// itself: anyone reaching the port directly could otherwise claim any address.
const LOOPBACK = /^(?:::ffff:)?127\.0\.0\.1$|^::1$/
const IP_TEXT = /^[0-9A-Fa-f:.]{2,45}$/
export const clientIpOf = (peer, cfHeader) =>
  LOOPBACK.test(peer ?? '') && typeof cfHeader === 'string' && IP_TEXT.test(cfHeader) ? cfHeader : (peer ?? '')

/**
 * How this visitor reached the server, for showing to them (/api/me, the foot of the menu): their
 * address as the server sees it, and whether they came straight to it (the office network, the VPN)
 * or round through the Cloudflare tunnel. The same name (cctv.jfl.gripe) does both, depending on
 * what the visitor's DNS answered, so the address bar cannot tell them which.
 */
export function routeOf(peer, cfHeader) {
  const address = clientIpOf(peer, cfHeader).replace(/^::ffff:/i, '')
  return { address, direct: address === (peer ?? '').replace(/^::ffff:/i, '') }
}

// /healthz tells the watchers on this machine (cctv-healthwatch.mjs, cctv-watch.ps1, the Docker
// healthcheck) which share is stuck and how each NVR's worker is doing. It needs no sign-in, and the
// same port is reachable through the tunnel, whose cloudflared also connects from 127.0.0.1 but always
// adds CF-Connecting-IP: only a loopback call with no such header at all is the machine asking itself.
export const localProbe = (peer, cfHeader) => LOOPBACK.test(peer ?? '') && cfHeader === undefined
