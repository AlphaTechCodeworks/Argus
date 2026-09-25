// The proof of integrity for an evidence export: a canonical manifest listing a SHA-256 of every
// file in the pack, signed with the server's Ed25519 key, plus the optional password encryption.
//
// Nothing here reads recordings or writes video; it is deliberately pure file-and-crypto work so
// that the part a court would lean on can be tested to destruction. See export-job.mjs for the
// job that fills a pack folder.
//
// Two rules shape the whole module:
//   - A pack that verifies when it should not is far worse than one that fails to verify, so
//     every check is fail-closed: anything unexpected is a problem, never a shrug.
//   - The manifest must serialise to identical bytes every time, or an honest pack would fail
//     verification. Hence canonicalJson below, and the sorting in buildManifest.

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, scryptSync, sign as signRaw, verify as verifyRaw } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export const MANIFEST_FILE = 'manifest.json'
export const SIGNATURE_FILE = 'signature.json'
const KEY_FILE = 'export-key.pem'
const PUB_FILE = 'export-key.pub'

const MANIFEST_VERSION = 1
const APP_VERSION = '2.0.0'

// AES-256-GCM with a scrypt key. The header is plaintext on purpose: the salt and IV are not
// secrets, and a reader needs them before it can even try a password.
const MAGIC = Buffer.from('CCTVPACK1')
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const SCRYPT_COST = 16384 // N=2^14: ~100 ms per attempt here, which is the point

// ---------------------------------------------------------------------------- canonical bytes

/**
 * JSON with object keys in sorted order, so the same data always produces the same bytes no
 * matter what order the caller happened to build the object in. Insertion order is not part of
 * the evidence and must not change the signature.
 * Rejects anything JSON would silently drop or render ambiguously (undefined, functions,
 * non-finite numbers): a field that vanishes between signing and verifying is a forgery hole.
 */
export function canonicalJson(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot serialise the number ${value}`)
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  throw new Error(`cannot serialise a value of type ${typeof value}`)
}

/** The exact bytes that are signed and written to manifest.json. */
export const manifestBytes = (manifest) => Buffer.from(canonicalJson(manifest), 'utf8')

// ---------------------------------------------------------------------------- the signing key

/**
 * The server's Ed25519 key pair, generated on first call under `dataDir`.
 * The private key is written mode 0600 and is returned only as a KeyObject: it is never turned
 * back into text anywhere else in this module, so it cannot reach a manifest, an API answer or
 * a log line by accident.
 * @param {string} dataDir
 * @returns {{privateKey:import('node:crypto').KeyObject, publicKey:import('node:crypto').KeyObject, publicKeyPem:string, created:boolean}}
 */
export function ensureKey(dataDir) {
  const keyFile = join(dataDir, KEY_FILE)
  const pubFile = join(dataDir, PUB_FILE)
  let created = false

  if (!existsSync(keyFile)) {
    mkdirSync(dataDir, { recursive: true })
    const pair = generateKeyPairSync('ed25519')
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
    // Temp-then-rename so a key half-written by a crash is never picked up as the real one.
    const tmp = `${keyFile}.tmp-${process.pid}`
    writeFileSync(tmp, pem, { mode: 0o600 })
    renameSync(tmp, keyFile)
    chmodSync(keyFile, 0o600) // rename keeps the mode, but be explicit in case the temp existed
    writeFileSync(pubFile, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 })
    created = true
  }

  const privateKey = createPrivateKey(readFileSync(keyFile, 'utf8'))
  const publicKey = createPublicKey(privateKey)
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  // Kept in step in case an older install has the private key but not the public one.
  if (!existsSync(pubFile)) writeFileSync(pubFile, publicKeyPem, { mode: 0o644 })
  return { privateKey, publicKey, publicKeyPem, created }
}

// ---------------------------------------------------------------------------- the manifest

/** SHA-256 of a file, as lower-case hex. */
export function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const posix = (p) => p.split(sep).join('/')

/** Every file under `dir`, as pack-relative posix paths, excluding the manifest and signature. */
export function packFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) out.push(posix(relative(dir, full)))
    }
  }
  walk(dir)
  return out.filter((p) => p !== MANIFEST_FILE && p !== SIGNATURE_FILE).sort()
}

/** Describes one file for the manifest: its pack-relative path, its size and its SHA-256. */
export function describeFile(dir, path) {
  const full = join(dir, path)
  return { path: posix(path), bytes: statSync(full).size, sha256: hashFile(full) }
}

/**
 * The manifest object. Arrays are sorted as well as keys, so the order the caller supplies
 * files, clips or clocks in cannot change the signed bytes.
 *
 * Clip times are server time. Each NVR's clock offset at the moment of export is recorded
 * separately (nvr1 runs about 220 s fast) so a reader can convert to what that NVR believed the
 * time was, rather than being told one time and left to guess which clock it came from.
 *
 * @param {{files:Array<{path:string,sha256:string,bytes?:number}>,
 *          clips:Array<{camera:string,nvr:string,startMs:number,endMs:number}>,
 *          clocks?:Array<{nvr:string,offsetMs:number}>,
 *          exportedBy:string, exportedAt:number|string, notes?:string, app?:string,
 *          identity?:{user?:string, admin?:boolean, ip?:string, via?:string}|null}} o
 *
 * `identity` records WHO took the export in more than a name: the account, whether they held admin
 * at the time, the address they asked from, and how (the web export page, a script). It is added
 * only when supplied, and when it is absent the manifest bytes are exactly what they were before
 * this field existed — so every pack already issued still verifies against its own signature,
 * unchanged. verifyPack re-hashes the manifest bytes as they sit on disk and never inspects the
 * shape beyond `files`, so a new optional key cannot invalidate an old pack.
 */
export function buildManifest({ files, clips, clocks = [], exportedBy, exportedAt, notes = '', app = APP_VERSION, identity = null }) {
  if (!Array.isArray(files)) throw new Error('files must be an array')
  if (!Array.isArray(clips)) throw new Error('clips must be an array')
  if (!exportedBy) throw new Error('exportedBy is required')
  if (exportedAt === undefined || exportedAt === null) throw new Error('exportedAt is required')

  const iso = (v) => (typeof v === 'string' ? new Date(v) : new Date(v)).toISOString()

  return {
    manifestVersion: MANIFEST_VERSION,
    app,
    algorithm: { hash: 'SHA-256', signature: 'Ed25519' },
    exportedBy: String(exportedBy),
    exportedAt: iso(exportedAt),
    // Spread, so the key simply is not there when no identity was given: an absent key and a key
    // holding null are different bytes, and only the absent one matches the older packs.
    ...(identity ? { identity: cleanIdentity(identity) } : {}),
    notes: String(notes),
    files: files
      .map((f) => ({ path: posix(String(f.path)), bytes: f.bytes ?? null, sha256: String(f.sha256) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    clips: clips
      .map((c) => ({
        camera: String(c.camera),
        nvr: String(c.nvr),
        startServer: iso(c.startMs),
        endServer: iso(c.endMs),
      }))
      .sort((a, b) => cmp(`${a.nvr}\u0000${a.camera}\u0000${a.startServer}`, `${b.nvr}\u0000${b.camera}\u0000${b.startServer}`)),
    clocks: clocks
      .map((c) => ({ nvr: String(c.nvr), offsetMs: Math.trunc(c.offsetMs ?? 0) }))
      .sort((a, b) => cmp(a.nvr, b.nvr)),
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * A fixed set of fields with fixed types, so the signed bytes cannot be steered by whatever the
 * caller happened to hand over. Everything is a string or a boolean: canonicalJson refuses
 * undefined, and a surprise object here would be a surprise in a court exhibit.
 */
function cleanIdentity(id) {
  const s = (v, max = 120) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max)
  return { user: s(id.user, 64), admin: id.admin === true, ip: s(id.ip, 64), via: s(id.via, 64) }
}

/**
 * Signs the canonical manifest bytes.
 * @returns {{manifest:object, signature:string, publicKey:string, algorithm:string}}
 * The private key is not among them, and never will be.
 */
export function signManifest(manifest, privateKey) {
  const bytes = manifestBytes(manifest)
  const signature = signRaw(null, bytes, privateKey).toString('base64')
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
  return { manifest, signature, publicKey, algorithm: 'Ed25519' }
}

/** Writes manifest.json and signature.json into a pack folder. */
export function writePack(dir, signed) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MANIFEST_FILE), manifestBytes(signed.manifest))
  writeFileSync(
    join(dir, SIGNATURE_FILE),
    canonicalJson({ algorithm: signed.algorithm ?? 'Ed25519', signature: signed.signature, publicKey: signed.publicKey })
  )
}

// ---------------------------------------------------------------------------- verification

/**
 * Re-hashes every file the manifest lists and checks the signature over the manifest bytes as
 * they are on disk (not as re-serialised, so whitespace tampering is caught too).
 *
 * Returns every problem found rather than the first: someone checking an export in a dispute
 * wants the full picture, and "one file is wrong" and "every file is wrong" mean quite different
 * things. Never throws for a bad pack — an absent or unreadable manifest is a problem, not a
 * crash — because a verifier that falls over is indistinguishable from one that says nothing.
 *
 * @param {string} dir
 * @param {{publicKey?:string}} [opts] a trusted public key to require; without one the pack's own
 *   key is used, which proves internal consistency only (see the module notes in the tests).
 * @returns {{ok:boolean, problems:string[], manifest:object|null}}
 */
export function verifyPack(dir, { publicKey: trustedKey } = {}) {
  const problems = []
  const fail = (m) => { problems.push(m); return { ok: false, problems, manifest: null } }

  if (!existsSync(dir) || !statSync(dir).isDirectory()) return fail(`${dir} is not a folder`)

  const manifestPath = join(dir, MANIFEST_FILE)
  if (!existsSync(manifestPath)) return fail(`${MANIFEST_FILE} is missing`)
  let raw
  try { raw = readFileSync(manifestPath) } catch (e) { return fail(`${MANIFEST_FILE} cannot be read: ${e.message}`) }
  if (raw.length === 0) return fail(`${MANIFEST_FILE} is empty`)
  let manifest
  try { manifest = JSON.parse(raw.toString('utf8')) } catch (e) { return fail(`${MANIFEST_FILE} is not valid JSON: ${e.message}`) }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return fail(`${MANIFEST_FILE} is not a manifest object`)
  if (!Array.isArray(manifest.files)) return fail(`${MANIFEST_FILE} lists no files`)

  // The signature first, but carry on to the file hashes either way: a reader deserves to know
  // which files changed even once the signature has told them something has.
  const sigPath = join(dir, SIGNATURE_FILE)
  let sig = null
  if (!existsSync(sigPath)) problems.push(`${SIGNATURE_FILE} is missing`)
  else {
    try { sig = JSON.parse(readFileSync(sigPath, 'utf8')) } catch (e) { problems.push(`${SIGNATURE_FILE} is not valid JSON: ${e.message}`) }
  }
  if (sig) {
    const pem = trustedKey ?? sig.publicKey
    if (!pem) problems.push('the signature carries no public key')
    else if (!sig.signature) problems.push('the signature is missing')
    else {
      try {
        const ok = verifyRaw(null, raw, createPublicKey(pem), Buffer.from(String(sig.signature), 'base64'))
        if (!ok) problems.push('the signature does not match the manifest')
      } catch (e) {
        problems.push(`the signature could not be checked: ${e.message}`)
      }
    }
    if (trustedKey && sig.publicKey && normalisePem(sig.publicKey) !== normalisePem(trustedKey)) {
      problems.push('the pack was signed by a different key than the one supplied')
    }
  }

  const listed = new Set()
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      problems.push('a file entry in the manifest is malformed')
      continue
    }
    const path = entry.path
    listed.add(path)
    // A path that escapes the pack would let a manifest point at a file elsewhere on the machine
    // and "verify" against it.
    if (path.startsWith('/') || path.includes('..') || /^[a-zA-Z]:/.test(path)) {
      problems.push(`${path}: the manifest path leaves the pack`)
      continue
    }
    const full = join(dir, path)
    if (!existsSync(full) || !statSync(full).isFile()) { problems.push(`${path}: listed in the manifest but missing`); continue }
    const size = statSync(full).size
    if (entry.bytes !== null && entry.bytes !== undefined && size !== entry.bytes) {
      problems.push(`${path}: is ${size} bytes, the manifest says ${entry.bytes}`)
    }
    if (hashFile(full) !== entry.sha256) problems.push(`${path}: the contents do not match the manifest hash`)
  }

  // An extra file is not proof of tampering, but an export nobody can account for every file in
  // is not evidence either, so it counts as a problem.
  for (const path of packFiles(dir)) if (!listed.has(path)) problems.push(`${path}: present in the pack but not in the manifest`)

  return { ok: problems.length === 0, problems, manifest }
}

const normalisePem = (pem) => String(pem).replace(/\s+/g, '')

// ---------------------------------------------------------------------------- encryption

const keyFor = (password, salt) => scryptSync(String(password), salt, 32, { N: SCRYPT_COST, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })

/**
 * AES-256-GCM, key from scrypt. Layout: magic | salt | iv | ciphertext | tag.
 * The tag goes last so the file can be written as it is encrypted.
 */
export function encryptFile(src, dest, password) {
  if (!password) throw new Error('a password is required')
  const salt = randomSalt()
  const iv = randomIv()
  const cipher = createCipheriv('aes-256-gcm', keyFor(password, salt), iv)
  const body = Buffer.concat([cipher.update(readFileSync(src)), cipher.final()])
  atomicWrite(dest, Buffer.concat([MAGIC, salt, iv, body, cipher.getAuthTag()]))
  return dest
}

/**
 * Fails cleanly on a wrong password: GCM's tag is checked before anything is written, so a bad
 * password gives an error and no output file, never plausible rubbish.
 */
export function decryptFile(src, dest, password) {
  if (!password) throw new Error('a password is required')
  const buf = readFileSync(src)
  const min = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES
  if (buf.length < min || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an encrypted pack file')
  let at = MAGIC.length
  const salt = buf.subarray(at, (at += SALT_BYTES))
  const iv = buf.subarray(at, (at += IV_BYTES))
  const body = buf.subarray(at, buf.length - TAG_BYTES)
  const tag = buf.subarray(buf.length - TAG_BYTES)

  const decipher = createDecipheriv('aes-256-gcm', keyFor(password, salt), iv)
  decipher.setAuthTag(tag)
  let out
  try {
    out = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    // Deliberately not the underlying message, which says nothing useful and varies by version.
    throw new Error('wrong password, or the file has been altered')
  }
  atomicWrite(dest, out)
  return dest
}

function atomicWrite(dest, buf) {
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, buf)
    renameSync(tmp, dest)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

// Small wrappers so the sizes above stay in one place.
function randomSalt() { return cryptoRandom(SALT_BYTES) }
function randomIv() { return cryptoRandom(IV_BYTES) }
function cryptoRandom(n) {
  const b = Buffer.allocUnsafe(n)
  globalThis.crypto.getRandomValues(b)
  return b
}
