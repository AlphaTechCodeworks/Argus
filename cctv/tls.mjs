// HTTPS certificate: uses data/certs/{cert,key}.pem, generating a self-signed
// one on first start. Browsers need HTTPS for WebCodecs on anything but localhost.
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { createSecureContext } from 'node:tls'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'

const CERT_DIR = join(DATA_DIR, 'certs')
const CERT_FILE = join(CERT_DIR, 'cert.pem')
const KEY_FILE = join(CERT_DIR, 'key.pem')
const HOSTS_FILE = join(CERT_DIR, 'hosts')

/**
 * @param {string[]} hosts - names and IPs the certificate must be valid for
 * @returns {{ cert: Buffer, key: Buffer }}
 */
export const loadCertificate = (hosts) => {
  const wanted = [...new Set(['localhost', '127.0.0.1', ...hosts])].join(',')
  const current = existsSync(HOSTS_FILE) ? readFileSync(HOSTS_FILE, 'utf8') : ''
  // regenerate our own self-signed cert when the host list changes; never touch a user-supplied one
  const selfSigned = existsSync(HOSTS_FILE)
  if (!existsSync(CERT_FILE) || !existsSync(KEY_FILE) || (selfSigned && current !== wanted)) {
    mkdirSync(CERT_DIR, { recursive: true })
    const san = wanted
      .split(',')
      .map((h) => (/^[\d.]+$|:/.test(h) ? `IP:${h}` : `DNS:${h}`))
      .join(',')
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-subj', '/CN=CCTV Live',
      '-addext', `subjectAltName=${san}`,
      '-keyout', KEY_FILE, '-out', CERT_FILE
    ], { stdio: 'ignore' })
    writeFileSync(HOSTS_FILE, wanted)
    console.log(`Generated self-signed certificate for ${wanted}`)
  }
  return { cert: readFileSync(CERT_FILE), key: readFileSync(KEY_FILE) }
}

// A real certificate for one name, alongside the self-signed one for everything else.
//
// A machine reached by a real name from outside and by a bare IP address on the LAN cannot be
// covered by one certificate: a public authority will not issue for 192.168.x.x, and a self-signed
// certificate is not trusted anywhere. Installing the real one on its own quietly broke the LAN
// address, which had worked for months.
//
// So both are kept and the right one is chosen per connection, from the name the browser asks for.
// A browser reaching the tailnet name gets the real certificate and no warning; one reaching the
// LAN address by number gets the self-signed certificate exactly as before.
const REAL_DIR = join(CERT_DIR, 'named')

/** Where the real certificate lives once something (deploy/tailscale-cert.sh) has fetched one. */
export const namedCertPaths = { dir: REAL_DIR, cert: join(REAL_DIR, 'cert.pem'), key: join(REAL_DIR, 'key.pem') }

/**
 * Every real certificate there is: the one above, and one in each folder beside it
 * (certs/named/<any name>/cert.pem and key.pem). A second name needs a second certificate: the
 * tailnet name's comes from Tailscale and covers nothing else, so the public name the office uses
 * (reached directly on the LAN once its DNS says so) has its own, from its own renewal script.
 * Only folders holding both files; in name order, so which one answers for a name two of them
 * share does not depend on the disk.
 * @returns {{ cert: string, key: string }[]}
 */
export function namedCertFiles(dir = REAL_DIR, { exists = existsSync, list = (d) => readdirSync(d, { withFileTypes: true }) } = {}) {
  const pair = (d) => ({ cert: join(d, 'cert.pem'), key: join(d, 'key.pem') })
  const both = (p) => exists(p.cert) && exists(p.key)
  const out = [pair(dir)].filter(both)
  let folders = []
  try {
    folders = list(dir).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {} // no folder yet: only the self-signed certificate
  for (const name of folders) if (both(pair(join(dir, name)))) out.push(pair(join(dir, name)))
  return out
}

/** The context to answer `servername` with: the first certificate that names it, else undefined (the default). */
export function contextFor(servername, certs) {
  const want = String(servername ?? '').toLowerCase()
  return certs.find((c) => c.names.includes(want))?.context
}

/**
 * The https options: the self-signed certificate as the default, plus an SNI callback that serves
 * a real certificate to anyone who asked for its name. Everything is read once at start; a renewed
 * certificate arrives with a restart, which is what the renewal script does anyway.
 * @param {string[]} hosts names and IPs the self-signed certificate must cover
 */
export function httpsOptions(hosts) {
  const base = loadCertificate(hosts)
  const certs = []
  for (const p of namedCertFiles()) {
    try {
      const context = createSecureContext({ cert: readFileSync(p.cert), key: readFileSync(p.key) })
      const names = certNames(readFileSync(p.cert, 'utf8'))
      certs.push({ context, names })
      console.log(`Using the real certificate for ${names.join(', ') || 'its own name'}; self-signed elsewhere`)
    } catch (e) {
      // A certificate we cannot read must not stop the server starting: it would take every camera
      // off the air to fix a browser warning. The others, and the self-signed one, still serve.
      console.warn(`Could not read the real certificate ${p.cert}, leaving it out: ${e.message}`)
    }
  }
  if (!certs.length) return base
  return {
    ...base,
    SNICallback(servername, cb) {
      cb(null, contextFor(servername, certs)) // undefined = fall back to the default above
    }
  }
}

/** The names a certificate is valid for, from its subject and its subjectAltName. */
function certNames(pem) {
  try {
    const x = new X509Certificate(pem)
    const alt = (x.subjectAltName ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('DNS:'))
      .map((s) => s.slice(4).toLowerCase())
    const cn = /CN=([^,\n]+)/.exec(x.subject ?? '')?.[1]?.trim().toLowerCase()
    return [...new Set([...alt, ...(cn ? [cn] : [])])]
  } catch {
    return []
  }
}
