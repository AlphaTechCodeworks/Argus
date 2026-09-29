// Whether this is a phone rather than a PC, laptop or tablet. The browser says so itself where it
// can (navigator.userAgentData.mobile, Chrome and Edge); otherwise every phone browser names itself
// in its user agent. A touch screen alone is not enough: touchscreen laptops have one too.
export function isPhone(nav = globalThis.navigator) {
  if (!nav) return false
  if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile
  const ua = String(nav.userAgent ?? '')
  return /iPhone|iPod|Android.*Mobile|Mobile.*Firefox|Windows Phone/i.test(ua)
}

/** The most frames a second worth drawing here: a phone's small screen gains nothing above 15. */
export const maxLiveFps = (nav) => (isPhone(nav) ? 15 : null)

/**
 * Whether the page was opened on the local network (https://192.168.1.232:8443) rather than through
 * the Cloudflare tunnel (https://cctv.jfl.gripe) or the tailnet, judged by the address in the address
 * bar. Local: the private IPv4 ranges (10.x, 172.16-31.x, 192.168.x), this machine (127.x, localhost,
 * ::1), link-local (169.254.x, fe80::), IPv6 private addresses (fc00::/7), and names no public DNS
 * answers for: one without a dot, .local (mDNS), .lan, .home.arpa, .internal. Everything else is
 * remote, the tailnet's 100.64-127.x and *.ts.net included -- as the server counts it
 * (adaptive-live.mjs isRemoteAddress: the tunnel and the tailnet). No host at all (a test, a file) is
 * local: nothing changes.
 */
export function isLocalHost(host = globalThis.location?.hostname) {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '')
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number)
    if ([a, b, c, d].some((n) => n > 255)) return false
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (h.startsWith('[')) return /^\[(::1\]|fe[89ab][0-9a-f]?:|f[cd][0-9a-f]{0,2}:)/.test(h)
  if (/^\d+(\.\d+)*$/.test(h)) return false // (not an address: 256.1.1.1)
  return !h.includes('.') || /\.(local|lan|home\.arpa|internal)$/.test(h)
}
