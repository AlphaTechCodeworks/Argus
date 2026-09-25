// HTTPS certificate: uses data/certs/{cert,key}.pem, generating a self-signed
// one on first start. Browsers need HTTPS for WebCodecs on anything but localhost.
import { execFileSync } from 'node:child_process'
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
