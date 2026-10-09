// Tests for app-fetch.mjs: the server taking each new release of the Android app from GitHub.
// A small local HTTP server stands in for GitHub. SDK-free, runs anywhere.
//   node cctv/test/app-fetch.test.mjs
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// point DATA_DIR somewhere harmless before the modules (via auth.mjs) read it at import
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'appf-data-'))
const { fetchLatestApp, startAppFetch, TOKEN_FILE } = await import('../app-fetch.mjs')
const { describeApp } = await import('../app-download.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const sha = (b) => createHash('sha256').update(b).digest('hex')

// ---- a stand-in for GitHub ----
const TOKEN = 't0ken'
const gh = {
  hits: [], // what was asked, in order
  release: null, // { apk: Buffer, info: string, apkSize?: number, omit?: 'apk' | 'info' }
  status: 200
}
const server = createServer((req, res) => {
  gh.hits.push(req.url)
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end('{"message":"Bad credentials"}')
  }
  if (gh.status !== 200) {
    res.writeHead(gh.status)
    return res.end()
  }
  const base = `http://127.0.0.1:${server.address().port}`
  if (req.url === '/repos/o/r/releases/latest') {
    const assets = []
    if (gh.release.omit !== 'apk') assets.push({ name: 'argus-android.apk', url: `${base}/assets/apk`, size: gh.release.apkSize ?? gh.release.apk.length })
    if (gh.release.omit !== 'info') assets.push({ name: 'argus-android.json', url: `${base}/assets/info`, size: gh.release.info.length })
    assets.push({ name: 'argus-android-9.9.9.apk', url: `${base}/assets/other`, size: 3 })
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ tag_name: 'v', assets }))
  }
  // the real API answers the asset only for Accept: application/octet-stream
  if (req.headers.accept !== 'application/octet-stream') {
    res.writeHead(415)
    return res.end()
  }
  if (req.url === '/assets/apk') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    return res.end(gh.release.apk)
  }
  if (req.url === '/assets/info') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    return res.end(gh.release.info)
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const api = `http://127.0.0.1:${server.address().port}`

const dir = mkdtempSync(join(tmpdir(), 'appf-'))
const appDir = join(dir, 'android')
mkdirSync(appDir, { recursive: true })
const apkOf = (fill) => Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(200_000, fill)])
const info = (versionCode, versionName) => JSON.stringify({ versionCode, versionName })
const round = (extra = {}) => fetchLatestApp({ dir: appDir, repo: 'o/r', api, ...extra })
const leftovers = () => existsSync(join(appDir, 'argus-android.apk.part')) || existsSync(join(appDir, 'argus-android.json.part'))

// ---- no token: nothing is asked of GitHub ----
gh.release = { apk: apkOf(1), info: info(101, '0.1.0') }
{
  const r = await round()
  check('without a token nothing is fetched and GitHub is not asked', r.updated === false && r.reason === 'no token' && gh.hits.length === 0, JSON.stringify(r))
}

// ---- a token that GitHub refuses ----
{
  const r = await round({ token: 'wrong' })
  check('a refused token is reported and nothing is placed', r.updated === false && /401/.test(r.reason) && (await describeApp(appDir)) === null, JSON.stringify(r))
}

// ---- the token in its file: the first release is taken ----
writeFileSync(join(appDir, TOKEN_FILE), `${TOKEN}\n`)
{
  const r = await round()
  const a = await describeApp(appDir)
  check('with the token file the release is taken', r.updated === true && r.versionCode === 101 && r.versionName === '0.1.0', JSON.stringify(r))
  check('and is then what the server offers, byte for byte', a && a.versionCode === 101 && a.size === gh.release.apk.length && a.sha256 === sha(gh.release.apk), JSON.stringify(a))
  check('nothing half-written is left behind', !leftovers())
}

// ---- the same release again: not downloaded twice ----
{
  gh.hits.length = 0
  const r = await round()
  check('the same release is not downloaded again', r.updated === false && r.reason === 'up to date' && !gh.hits.includes('/assets/apk'), JSON.stringify(gh.hits))
}

// ---- an older release never replaces a newer installer ----
gh.release = { apk: apkOf(2), info: info(90, '0.0.9') }
{
  const r = await round()
  const a = await describeApp(appDir)
  check('an older release is not taken', r.updated === false && a.versionCode === 101, JSON.stringify(r))
}

// ---- a newer one is ----
gh.release = { apk: apkOf(3), info: info(102, '0.2.0') }
{
  const r = await round()
  const a = await describeApp(appDir)
  check('a newer release replaces the installer', r.updated === true && a.versionCode === 102 && a.versionName === '0.2.0' && a.sha256 === sha(gh.release.apk), JSON.stringify(a))
}

// ---- a download that is not what GitHub said: the installer here is left alone ----
gh.release = { apk: apkOf(4), info: info(103, '0.3.0'), apkSize: 999_999 }
{
  const r = await round()
  const a = await describeApp(appDir)
  check('a download of the wrong size is thrown away', r.updated === false && /bytes/.test(r.reason) && a.versionCode === 102 && !leftovers(), JSON.stringify(r))
}
gh.release = { apk: Buffer.from('<html>not an apk</html>'), info: info(104, '0.4.0') }
{
  const r = await round()
  check('a download that is not a package is thrown away', r.updated === false && /not an Android package/.test(r.reason) && (await describeApp(appDir)).versionCode === 102 && !leftovers(), JSON.stringify(r))
}

// ---- releases that cannot be used ----
for (const [what, release, want] of [
  ['no installer', { apk: apkOf(5), info: info(105, '0.5.0'), omit: 'apk' }, /no argus-android\.apk/],
  ['no description', { apk: apkOf(5), info: info(105, '0.5.0'), omit: 'info' }, /no argus-android\.json/],
  ['a description that is not JSON', { apk: apkOf(5), info: 'oops' }, /not JSON/],
  ['a description without a version', { apk: apkOf(5), info: JSON.stringify({ versionName: '1' }) }, /no usable version/],
  ['a version name that could break a file name', { apk: apkOf(5), info: info(105, '1"\r\nx') }, /no usable version/]
]) {
  gh.release = release
  const r = await round()
  check(`a release with ${what} is refused and says why`, r.updated === false && want.test(r.reason) && (await describeApp(appDir)).versionCode === 102, JSON.stringify(r))
}

// ---- GitHub down, and a repository name that is not one ----
gh.status = 503
{
  const r = await round()
  check('GitHub answering 503 is reported, not thrown', r.updated === false && /503/.test(r.reason), JSON.stringify(r))
}
gh.status = 200
{
  const r = await round({ repo: '../../etc' })
  check('a repository name that is not owner/name is refused', r.updated === false && /owner\/name/.test(r.reason), JSON.stringify(r))
  const dead = await fetchLatestApp({ dir: appDir, repo: 'o/r', api: 'http://127.0.0.1:1', token: TOKEN })
  check('GitHub unreachable is reported, not thrown', dead.updated === false && typeof dead.reason === 'string', JSON.stringify(dead))
}

// ---- the timer says what happened once, not every round ----
{
  const said = []
  const answers = [{ updated: false, reason: 'no token' }, { updated: false, reason: 'no token' }, { updated: true, versionCode: 7, versionName: '0.7.0' }, { updated: false, reason: 'up to date' }]
  let i = 0
  const stop = startAppFetch({ everyMs: 20, firstMs: 1, log: (m) => said.push(m), round: async () => answers[Math.min(i++, answers.length - 1)] })
  await new Promise((r) => setTimeout(r, 200))
  stop()
  check('the log has the reason once and the update once', said.length === 2 && /no token/.test(said[0]) && /took Argus for Android 0\.7\.0 \(7\)/.test(said[1]), JSON.stringify(said))
}

check('the token file was never altered', readFileSync(join(appDir, TOKEN_FILE), 'utf8') === `${TOKEN}\n`)

server.close()
rmSync(dir, { recursive: true, force: true })
rmSync(process.env.DATA_DIR, { recursive: true, force: true })
console.log(`\n${failures ? `${failures} failed` : 'all passed'}`)
// exitCode, not process.exit(): exit() has deadlocked on the CI runner after "all passed"
process.exitCode = failures ? 1 : 0
