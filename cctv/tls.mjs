// HTTPS certificate: uses data/certs/{cert,key}.pem, generating a self-signed
// one on first start. Browsers need HTTPS for WebCodecs on anything but localhost.
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { createSecureContext } from 'node:tls'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 * The https options: the self-signed certificate as the default, plus an SNI callback that serves
 * a real certificate to anyone who asked for its name. Everything is read once at start; a renewed
 * certificate arrives with a restart, which is what the renewal script does anyway.
 * @param {string[]} hosts names and IPs the self-signed certificate must cover
 */
export function httpsOptions(hosts) {
  const base = loadCertificate(hosts)
  if (!existsSync(namedCertPaths.cert) || !existsSync(namedCertPaths.key)) return base

  let real
  let names = []
  try {
    real = createSecureContext({ cert: readFileSync(namedCertPaths.cert), key: readFileSync(namedCertPaths.key) })
    names = certNames(readFileSync(namedCertPaths.cert, 'utf8'))
    console.log(`Using the real certificate for ${names.join(', ') || 'its own name'}; self-signed elsewhere`)
  } catch (e) {
    // A certificate we cannot read must not stop the server starting: it would take every camera
    // off the air to fix a browser warning.
    console.warn(`Could not read the real certificate, using the self-signed one: ${e.message}`)
    return base
  }
  return {
    ...base,
    SNICallback(servername, cb) {
      const want = String(servername ?? '').toLowerCase()
      cb(null, names.includes(want) ? real : undefined) // undefined = fall back to the default above
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
