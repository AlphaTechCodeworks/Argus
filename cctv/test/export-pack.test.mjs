// Tests for export-pack.mjs: the integrity proof behind an evidence export.
// Run: node cctv/test/export-pack.test.mjs
//
// Most of these are adversarial on purpose. A pack that verifies when it should not is the worst
// outcome — worse than one that fails to verify — because somebody would rely on it. So every
// tamper we can think of gets its own case, and each asserts the specific problem, not merely
// that something went wrong.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MANIFEST_FILE, SIGNATURE_FILE, buildManifest, canonicalJson, decryptFile, describeFile,
  encryptFile, ensureKey, hashFile, manifestBytes, packFiles, signManifest, verifyPack, writePack,
} from '../export-pack.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const threw = (fn) => { try { fn(); return null } catch (e) { return e } }

const tmp = (tag) => mkdtempSync(join(tmpdir(), `cctv-ep-${tag}-`))
const AT = Date.UTC(2026, 8, 25, 14, 30, 0)

const keyDir = tmp('key')
const { privateKey, publicKeyPem } = ensureKey(keyDir)

/** A pack folder with two "video" files and a signed manifest. */
function makePack(tag = 'pack', { by = 'mike', at = AT, notes = 'Break-in, front door' } = {}) {
  const dir = tmp(tag)
  mkdirSync(join(dir, 'clips'), { recursive: true })
  writeFileSync(join(dir, 'clips', 'cam1.mp4'), Buffer.from('fake video one, long enough to matter'))
  writeFileSync(join(dir, 'clips', 'cam2.mp4'), Buffer.from('fake video two'))
  const files = packFiles(dir).map((p) => describeFile(dir, p))
  const manifest = buildManifest({
    files,
    clips: [
      { camera: 'Front door', nvr: 'nvr1', startMs: AT - 600_000, endMs: AT - 300_000 },
      { camera: 'Drive', nvr: 'nvr2', startMs: AT - 600_000, endMs: AT - 300_000 },
    ],
    clocks: [{ nvr: 'nvr1', offsetMs: 220_000 }, { nvr: 'nvr2', offsetMs: -40 }],
    exportedBy: by, exportedAt: at, notes,
  })
  const signed = signManifest(manifest, privateKey)
  writePack(dir, signed)
  return { dir, manifest, signed }
}

// ---------------------------------------------------------------- the key

{
  const d = tmp('key2')
  const first = ensureKey(d)
  check('the key is generated on first use', first.created === true)
  const again = ensureKey(d)
  check('the key is not regenerated on the second call', again.created === false)
  check('the same key comes back', again.publicKeyPem === first.publicKeyPem)

  const keyFile = join(d, 'export-key.pem')
  check('the private key file exists', existsSync(keyFile))
  // Windows does not carry POSIX permission bits, so the mode is only meaningful on the Linux
  // side where the server actually runs. Asserted there, skipped (visibly) here.
  const mode = statSync(keyFile).mode & 0o777
  if (process.platform === 'win32') console.log(`SKIP  the private key is mode 0600 (not meaningful on Windows, is ${mode.toString(8)})`)
  else check('the private key is mode 0600', mode === 0o600, mode.toString(8))

  const pem = readFileSync(keyFile, 'utf8')
  check('the private key file really holds a private key', pem.includes('PRIVATE KEY'))

  // The whole point: everything the module hands out or writes, other than this one file, must
  // be free of the private key. Checked against both the PEM text and its raw base64 body.
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const leaks = (s) => s.includes(pem.trim()) || (body.length > 0 && s.includes(body))

  const { dir, manifest, signed } = makePack('leak')
  check('the private key is not in the manifest', !leaks(JSON.stringify(manifest)))
  check('the private key is not in the signing result', !leaks(JSON.stringify(signed)))
  check('the signing result carries only the public key', signed.publicKey.includes('PUBLIC KEY') && !signed.publicKey.includes('PRIVATE'))
  check('the private key is not in the verify result', !leaks(JSON.stringify(verifyPack(dir))))
  for (const f of [MANIFEST_FILE, SIGNATURE_FILE]) {
    check(`the private key is not in ${f}`, !leaks(readFileSync(join(dir, f), 'utf8')))
  }
  // And nothing in a pack folder at all, in case a future field smuggles it in.
  for (const p of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!p.isFile()) continue
    const full = join(p.parentPath ?? p.path, p.name)
    check(`the private key is not in ${p.name}`, !leaks(readFileSync(full, 'latin1')))
  }
}

// ---------------------------------------------------------------- canonical serialisation

{
  // The same manifest built with its fields in a different order must give identical bytes, or
  // an honest pack would fail its own verification.
  const files = [
    { path: 'clips/b.mp4', bytes: 2, sha256: 'bb' },
    { path: 'clips/a.mp4', bytes: 1, sha256: 'aa' },
  ]
  const one = buildManifest({
    files,
    clips: [{ camera: 'Drive', nvr: 'nvr2', startMs: AT, endMs: AT + 1000 }, { camera: 'Front door', nvr: 'nvr1', startMs: AT, endMs: AT + 1000 }],
    clocks: [{ nvr: 'nvr2', offsetMs: -40 }, { nvr: 'nvr1', offsetMs: 220_000 }],
    exportedBy: 'mike', exportedAt: AT, notes: 'n',
  })
  const two = buildManifest({
    notes: 'n', exportedAt: AT, exportedBy: 'mike',
    clocks: [{ nvr: 'nvr1', offsetMs: 220_000 }, { nvr: 'nvr2', offsetMs: -40 }],
    clips: [{ camera: 'Front door', nvr: 'nvr1', startMs: AT, endMs: AT + 1000 }, { camera: 'Drive', nvr: 'nvr2', startMs: AT, endMs: AT + 1000 }],
    files: [files[1], files[0]],
  })
  check('a manifest built in a different field order gives the same bytes', manifestBytes(one).equals(manifestBytes(two)))
  check('and the same signature', signManifest(one, privateKey).signature === signManifest(two, privateKey).signature)

  // Key order inside a nested object must not matter either.
  check('nested key order does not change the bytes', canonicalJson({ b: 1, a: { d: 2, c: 3 } }) === canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  check('keys are sorted', canonicalJson({ b: 1, a: 2 }) === '{"a":2,"b":1}')
  check('a value JSON would drop is refused', threw(() => canonicalJson({ a: Number.NaN })) !== null)
  check('undefined fields are dropped consistently', canonicalJson({ a: 1, b: undefined }) === '{"a":1}')

  // Array order IS part of the signed bytes, which is why buildManifest sorts them itself.
  check('array order is preserved', canonicalJson([2, 1]) === '[2,1]')
}

// ---------------------------------------------------------------- what a good pack looks like

{
  const { dir, manifest } = makePack('good')
  const r = verifyPack(dir)
  check('a good pack verifies', r.ok === true, r.problems.join('; '))
  check('it reports no problems', r.problems.length === 0)
  check('every file is listed', manifest.files.length === 2)
  check('the hashes are real SHA-256 hex', manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)))
  check('the hash matches the file on disk', manifest.files[0].sha256 === hashFile(join(dir, manifest.files[0].path)))
  check('the exporter is recorded', manifest.exportedBy === 'mike')
  check('the time of export is recorded', manifest.exportedAt === new Date(AT).toISOString())
  check('the notes are recorded', manifest.notes === 'Break-in, front door')
  check('the app version is recorded', typeof manifest.app === 'string' && manifest.app.length > 0)
  check('the clips carry camera, NVR and server times', manifest.clips.every((c) => c.camera && c.nvr && c.startServer && c.endServer))
  check('each NVR clock offset is recorded', manifest.clocks.find((c) => c.nvr === 'nvr1')?.offsetMs === 220_000)
  check('a verified pack still verifies against the trusted public key', verifyPack(dir, { publicKey: publicKeyPem }).ok === true)
}

// ---------------------------------------------------------------- tampering

{
  const { dir } = makePack('flip')
  // One byte in the middle of a video file, same length: the size check will not catch it, only
  // the hash will.
  const f = join(dir, 'clips', 'cam1.mp4')
  const buf = readFileSync(f)
  buf[5] ^= 0x01
  writeFileSync(f, buf)
  const r = verifyPack(dir)
  check('a flipped byte in a video file fails', r.ok === false)
  check('and names the file', r.problems.some((p) => p.startsWith('clips/cam1.mp4') && p.includes('do not match')), r.problems.join('; '))
  check('and does not blame the other file', !r.problems.some((p) => p.startsWith('clips/cam2.mp4')), r.problems.join('; '))
}

{
  const { dir } = makePack('truncate')
  writeFileSync(join(dir, 'clips', 'cam1.mp4'), readFileSync(join(dir, 'clips', 'cam1.mp4')).subarray(0, 4))
  const r = verifyPack(dir)
  check('a truncated file fails', r.ok === false)
  check('and the size mismatch is reported', r.problems.some((p) => p.includes('bytes, the manifest says')), r.problems.join('; '))
}

{
  const { dir } = makePack('times')
  // The classic forgery: keep the video, move the clock.
  const m = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))
  m.clips[0].startServer = new Date(AT - 9_000_000).toISOString()
  writeFileSync(join(dir, MANIFEST_FILE), canonicalJson(m))
  const r = verifyPack(dir)
  check('a changed timestamp in the manifest fails', r.ok === false)
  check('and it is the signature that objects', r.problems.some((p) => p.includes('signature does not match')), r.problems.join('; '))
}

{
  const { dir } = makePack('whitespace')
  // Re-serialised with spaces but semantically identical: still not the signed bytes.
  const m = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(m, null, 2))
  check('a reformatted manifest fails, because the signature covers the bytes', verifyPack(dir).ok === false)
}

{
  const { dir } = makePack('rehash')
  // A forger who edits the file AND updates the hash still cannot re-sign the manifest.
  writeFileSync(join(dir, 'clips', 'cam1.mp4'), Buffer.from('a different video entirely'))
  const m = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))
  const entry = m.files.find((x) => x.path === 'clips/cam1.mp4')
  entry.sha256 = hashFile(join(dir, 'clips', 'cam1.mp4'))
  entry.bytes = statSync(join(dir, 'clips', 'cam1.mp4')).size
  writeFileSync(join(dir, MANIFEST_FILE), canonicalJson(m))
  const r = verifyPack(dir)
  check('editing a file and its hash together still fails on the signature', r.ok === false)
  check('and the hashes themselves now agree, so only the signature catches it', r.problems.length === 1 && r.problems[0].includes('signature'), r.problems.join('; '))
}

{
  const a = makePack('sigA')
  const b = makePack('sigB', { by: 'someone else', notes: 'a different incident' })
  // A signature lifted from another pack, signed by the same genuine key.
  writeFileSync(join(a.dir, SIGNATURE_FILE), readFileSync(join(b.dir, SIGNATURE_FILE)))
  const r = verifyPack(a.dir)
  check('a signature lifted from a different pack fails', r.ok === false)
  check('and says the signature does not match', r.problems.some((p) => p.includes('signature does not match')), r.problems.join('; '))
}

{
  const { dir } = makePack('otherkey')
  // Re-signed with an attacker's own key: internally consistent, but not this server's key.
  const other = ensureKey(tmp('otherkey-key'))
  const m = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))
  m.exportedBy = 'not mike'
  const bytes = canonicalJson(m)
  writeFileSync(join(dir, MANIFEST_FILE), bytes)
  writePack(dir, signManifest(m, other.privateKey))
  check('a pack re-signed with another key is self-consistent', verifyPack(dir).ok === true)
  const r = verifyPack(dir, { publicKey: publicKeyPem })
  check('but fails against this server’s public key', r.ok === false)
  check('and says so plainly', r.problems.some((p) => p.includes('different key')), r.problems.join('; '))
}

{
  const { dir } = makePack('missing')
  const f = join(dir, 'clips', 'cam2.mp4')
  writeFileSync(f, '')
  const empty = verifyPack(dir)
  check('an emptied file fails', empty.ok === false)
  // Now remove it outright.
  const { rmSync } = await import('node:fs')
  rmSync(f)
  const r = verifyPack(dir)
  check('a file listed but missing fails', r.ok === false)
  check('and says it is missing', r.problems.some((p) => p.includes('missing')), r.problems.join('; '))
}

{
  const { dir } = makePack('extra')
  writeFileSync(join(dir, 'clips', 'smuggled.mp4'), 'nobody accounted for this')
  const r = verifyPack(dir)
  check('an extra file not in the manifest is reported', r.ok === false)
  check('and is named', r.problems.some((p) => p.startsWith('clips/smuggled.mp4')), r.problems.join('; '))
}

{
  // Several problems at once: a verifier must give the whole picture, not stop at the first.
  const { dir } = makePack('many')
  const { rmSync } = await import('node:fs')
  const buf = readFileSync(join(dir, 'clips', 'cam1.mp4'))
  buf[0] ^= 0xff
  writeFileSync(join(dir, 'clips', 'cam1.mp4'), buf)
  rmSync(join(dir, 'clips', 'cam2.mp4'))
  writeFileSync(join(dir, 'extra.txt'), 'x')
  const r = verifyPack(dir)
  check('every problem is reported, not just the first', r.problems.length >= 3, r.problems.join('; '))
  check('the altered file is among them', r.problems.some((p) => p.startsWith('clips/cam1.mp4')))
  check('the missing file is among them', r.problems.some((p) => p.startsWith('clips/cam2.mp4')))
  check('the extra file is among them', r.problems.some((p) => p.startsWith('extra.txt')))
}

// ---------------------------------------------------------------- broken and absent manifests

{
  const dir = tmp('nomanifest')
  const r = verifyPack(dir)
  check('an absent manifest fails rather than throwing', r.ok === false && r.problems.length === 1)
  check('and says which file is missing', r.problems[0].includes(MANIFEST_FILE))
}
{
  const dir = tmp('emptymanifest')
  writeFileSync(join(dir, MANIFEST_FILE), '')
  check('an empty manifest fails rather than throwing', verifyPack(dir).ok === false)
}
{
  const dir = tmp('junkmanifest')
  writeFileSync(join(dir, MANIFEST_FILE), 'not json at all {')
  const r = verifyPack(dir)
  check('a manifest that is not JSON fails rather than throwing', r.ok === false)
  check('and says so', r.problems[0].includes('not valid JSON'), r.problems.join('; '))
}
{
  const dir = tmp('arraymanifest')
  writeFileSync(join(dir, MANIFEST_FILE), '[]')
  check('a manifest that is not an object fails', verifyPack(dir).ok === false)
}
{
  const { dir } = makePack('nosig')
  const { rmSync } = await import('node:fs')
  rmSync(join(dir, SIGNATURE_FILE))
  const r = verifyPack(dir)
  check('a pack with no signature fails', r.ok === false)
  check('and the file hashes are still checked', r.problems.length === 1 && r.problems[0].includes(SIGNATURE_FILE), r.problems.join('; '))
}
{
  const { dir } = makePack('junksig')
  writeFileSync(join(dir, SIGNATURE_FILE), '{"algorithm":"Ed25519","signature":"!!!not base64!!!","publicKey":"not a key"}')
  const r = verifyPack(dir)
  check('a rubbish signature file fails rather than throwing', r.ok === false)
}
{
  const dir = tmp('escape')
  writeFileSync(join(dir, MANIFEST_FILE), canonicalJson({ files: [{ path: '../secret.txt', sha256: 'x'.repeat(64) }] }))
  writeFileSync(join(dir, '..', 'secret.txt'), 'outside the pack')
  const r = verifyPack(dir)
  check('a manifest path that leaves the pack is refused', r.ok === false && r.problems.some((p) => p.includes('leaves the pack')), r.problems.join('; '))
}
{
  const dir = tmp('nonexistent')
  check('a folder that does not exist fails rather than throwing', verifyPack(join(dir, 'nope')).ok === false)
}

// ---------------------------------------------------------------- encryption

{
  const d = tmp('crypt')
  const src = join(d, 'pack.zip')
  const body = Buffer.from('the pack contents, which must come back byte for byte')
  writeFileSync(src, body)

  encryptFile(src, join(d, 'pack.enc'), 'correct horse')
  const enc = readFileSync(join(d, 'pack.enc'))
  check('the encrypted file is not the plaintext', !enc.includes('pack contents'))
  check('the encrypted file is longer than the plaintext (salt, IV, tag)', enc.length > body.length)

  decryptFile(join(d, 'pack.enc'), join(d, 'out.zip'), 'correct horse')
  check('the right password round-trips exactly', readFileSync(join(d, 'out.zip')).equals(body))

  const e = threw(() => decryptFile(join(d, 'pack.enc'), join(d, 'bad.zip'), 'wrong horse'))
  check('the wrong password throws', e !== null, String(e))
  check('and never writes plausible rubbish', !existsSync(join(d, 'bad.zip')))
  check('and the error does not leak the password', e !== null && !String(e.message).includes('wrong horse'), String(e?.message))

  // A single altered byte of ciphertext must fail the GCM tag, not decrypt to nearly-right data.
  const tampered = Buffer.from(enc)
  tampered[tampered.length - 20] ^= 0x01
  writeFileSync(join(d, 'tampered.enc'), tampered)
  check('altered ciphertext fails the auth tag', threw(() => decryptFile(join(d, 'tampered.enc'), join(d, 'no.zip'), 'correct horse')) !== null)
  check('and writes nothing', !existsSync(join(d, 'no.zip')))

  writeFileSync(join(d, 'plain.bin'), 'not one of ours')
  check('a file that is not an encrypted pack is refused', threw(() => decryptFile(join(d, 'plain.bin'), join(d, 'x'), 'p')) !== null)

  check('two encryptions of the same file differ (fresh salt and IV)', !readFileSync(encryptFile(src, join(d, 'a.enc'), 'p')).equals(readFileSync(encryptFile(src, join(d, 'b.enc'), 'p'))))
  check('an empty password is refused', threw(() => encryptFile(src, join(d, 'c.enc'), '')) !== null)

  // An encrypted pack still verifies once decrypted back into place.
  const { dir } = makePack('cryptpack')
  encryptFile(join(dir, 'clips', 'cam1.mp4'), join(d, 'cam1.enc'), 'pw')
  decryptFile(join(d, 'cam1.enc'), join(dir, 'clips', 'cam1.mp4'), 'pw')
  check('a decrypted file still matches its manifest hash', verifyPack(dir).ok === true, verifyPack(dir).problems.join('; '))
}

// ---------------------------------------------------------------- input validation

{
  check('buildManifest requires an exporter', threw(() => buildManifest({ files: [], clips: [], exportedAt: AT })) !== null)
  check('buildManifest requires a time of export', threw(() => buildManifest({ files: [], clips: [], exportedBy: 'mike' })) !== null)
  // Phase 6: the manifest can carry WHO exported, beyond the name. The rule that matters is that
  // adding it changed nothing for packs already issued, so their signatures still verify.
  const without = buildManifest({ files: [], clips: [], exportedBy: 'mike', exportedAt: AT })
  const withId = buildManifest({ files: [], clips: [], exportedBy: 'mike', exportedAt: AT, identity: { user: 'mike', admin: true, ip: '10.0.0.1', via: 'cctv-export' } })
  check('a manifest with no identity is byte-identical to the old shape', !manifestBytes(without).toString().includes('identity'))
  check('identity:null is treated as absent, so old packs keep their exact bytes', manifestBytes(buildManifest({ files: [], clips: [], exportedBy: 'mike', exportedAt: AT, identity: null })).equals(manifestBytes(without)))
  check('identity is recorded when given', withId.identity.user === 'mike' && withId.identity.admin === true && withId.identity.ip === '10.0.0.1')
  check('identity is signable: canonicalJson accepts it', typeof canonicalJson(withId) === 'string')
  check('identity is a fixed set of fields, whatever the caller passes', Object.keys(buildManifest({ files: [], clips: [], exportedBy: 'm', exportedAt: AT, identity: { user: 'm', sneaky: 1 } }).identity).sort().join() === 'admin,ip,user,via')
  check('a forged admin flag in identity must be the literal true', buildManifest({ files: [], clips: [], exportedBy: 'm', exportedAt: AT, identity: { admin: 'true' } }).identity.admin === false)
  check('a newline in identity cannot break the canonical bytes', !buildManifest({ files: [], clips: [], exportedBy: 'm', exportedAt: AT, identity: { user: 'a\nb' } }).identity.user.includes('\n'))
  check('identity order does not change the bytes', manifestBytes(withId).equals(manifestBytes(buildManifest({ files: [], clips: [], exportedBy: 'mike', exportedAt: AT, identity: { via: 'cctv-export', ip: '10.0.0.1', admin: true, user: 'mike' } }))))
  check('buildManifest requires a files array', threw(() => buildManifest({ clips: [], exportedBy: 'mike', exportedAt: AT })) !== null)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
