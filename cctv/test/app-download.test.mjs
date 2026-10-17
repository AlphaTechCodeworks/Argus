// Tests for app-download.mjs: the Android app's installer, described and served to the app itself
// so that it can update from the server it is signed in to. SDK-free, runs anywhere.
//   node cctv/test/app-download.test.mjs
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

// point DATA_DIR somewhere harmless before the module (via auth.mjs) reads it at import
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'app-data-'))
const { describeApp, sendApp } = await import('../app-download.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

/** A stand-in for the HTTP response: records writeHead, collects the body, and is a pipe target. */
class MockRes extends Writable {
  constructor() {
    super()
    this.chunks = []
    this.status = 0
    this.headers = {}
  }
  writeHead(status, headers) {
    this.status = status
    this.headers = headers || {}
    return this
  }
  _write(chunk, _enc, cb) {
    this.chunks.push(Buffer.from(chunk))
    cb()
  }
  body() {
    return Buffer.concat(this.chunks)
  }
}
const piped = (res) => new Promise((r) => res.on('finish', r).on('close', r))
const download = async (d) => {
  const res = new MockRes()
  await sendApp(res, d)
  await piped(res)
  return res
}
const sha = (b) => createHash('sha256').update(b).digest('hex')

const dir = mkdtempSync(join(tmpdir(), 'app-'))
const appDir = join(dir, 'android')
mkdirSync(appDir, { recursive: true })
const apk = join(appDir, 'argus-android.apk')
const info = join(appDir, 'argus-android.json')

// ---- nothing placed ----
check('an empty folder describes no app', (await describeApp(appDir)) === null)
check('a folder that does not exist describes no app', (await describeApp(join(dir, 'nowhere'))) === null)
{
  const res = await download(appDir)
  check('download when none is placed: 404 JSON saying so', res.status === 404 && res.headers['content-type'] === 'application/json' && /No app installer/.test(res.body().toString()), `${res.status}`)
}

// ---- the installer without its description, and the other way round: not offered ----
const bytes1 = Buffer.alloc(300_000, 5)
writeFileSync(apk, bytes1)
check('an installer without its description is not offered', (await describeApp(appDir)) === null)
{
  const res = await download(appDir)
  check('and is not served either: nobody can tell what version it is', res.status === 404, `${res.status}`)
}

// ---- both placed ----
writeFileSync(info, JSON.stringify({ versionCode: 205, versionName: '0.3.0' }))
{
  const a = await describeApp(appDir)
  check('described with the version from the file and the size and SHA-256 of the installer itself', a && a.versionCode === 205 && a.versionName === '0.3.0' && a.size === 300_000 && a.sha256 === sha(bytes1), JSON.stringify(a))
  check('nothing else is told (no paths)', a && Object.keys(a).sort().join() === 'sha256,size,versionCode,versionName', JSON.stringify(a))
  const res = await download(appDir)
  check('served as an Android package, byte-exact, with its length', res.status === 200 && res.headers['content-type'] === 'application/vnd.android.package-archive' && res.headers['content-length'] === 300_000 && /filename="argus-android-0\.3\.0\.apk"/.test(res.headers['content-disposition'] ?? '') && res.body().equals(bytes1), JSON.stringify(res.headers))
}

// ---- a new installer replaces it: the checksum follows the file, not a stale answer ----
const bytes2 = Buffer.alloc(300_000, 9) // same size on purpose
writeFileSync(apk, bytes2)
utimesSync(apk, new Date(), new Date(Date.now() + 5000))
writeFileSync(info, JSON.stringify({ versionCode: 206, versionName: '0.3.1' }))
{
  const a = await describeApp(appDir)
  check('a replaced installer is hashed again', a && a.versionCode === 206 && a.sha256 === sha(bytes2), JSON.stringify(a))
}

// ---- a description that is not one ----
for (const [what, text] of [
  ['not JSON', 'oops'],
  ['no version code', JSON.stringify({ versionName: '1.0' })],
  ['a version code that is not a positive whole number', JSON.stringify({ versionCode: -3, versionName: '1.0' })],
  ['a version name that is not text', JSON.stringify({ versionCode: 5, versionName: 7 })],
  ['a version name that could break a header', JSON.stringify({ versionCode: 5, versionName: '1.0"\r\nx: y' })]
]) {
  writeFileSync(info, text)
  check(`a description with ${what} offers nothing`, (await describeApp(appDir)) === null)
}

rmSync(dir, { recursive: true, force: true })
rmSync(process.env.DATA_DIR, { recursive: true, force: true })
console.log(`\n${failures ? `${failures} failed` : 'all passed'}`)
// exitCode, not process.exit(): exit() has deadlocked on the CI runner after "all passed"
process.exitCode = failures ? 1 : 0
