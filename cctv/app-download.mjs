// Serves the Android app's installer to the app itself, so that Argus for Android can update from
// the server it is signed in to.
//
// The app (github.com/AlphaTechCodeworks/argus-android) is built and signed by its own release
// workflow, which produces two files. An admin drops both in DATA_DIR/android/:
//   argus-android.apk    the installer
//   argus-android.json   { "versionCode": 123, "versionName": "0.2.0" }
// and this module only hands out what is there, as connector-download.mjs does for the site
// connector. The size and SHA-256 the app is told are taken from the installer itself, not from
// the description, so the two cannot disagree. Android refuses an installer that is not signed with
// the key of the app already installed, so the most a server can offer is a newer build of that app.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'

export const APP_DIR = join(DATA_DIR, 'android')
const APK = 'argus-android.apk'
const INFO = 'argus-android.json'
// what a version name may be: it goes into a download's file name
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/

// The installer is some 20 MB: hashed once per file, not once per question. Keyed by everything
// that changes when either file is replaced.
let cached = null

const sha256Of = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })

/** The installer that has been placed, with its path, or null when there is none to offer. */
async function find(dir) {
  const path = join(dir, APK)
  let apk, infoStat, text
  try {
    apk = await stat(path)
    infoStat = await stat(join(dir, INFO))
    text = await readFile(join(dir, INFO), 'utf8')
  } catch {
    return null // either file missing: an installer nobody can name the version of is not offered
  }
  let info
  try {
    info = JSON.parse(text)
  } catch {
    return null
  }
  if (!info || typeof info !== 'object') return null
  const { versionCode, versionName } = info
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) return null
  if (typeof versionName !== 'string' || !VERSION_NAME.test(versionName)) return null
  const key = `${path}|${apk.size}|${apk.mtimeMs}|${infoStat.mtimeMs}|${infoStat.size}`
  if (cached?.key !== key) {
    let sha256
    try {
      sha256 = await sha256Of(path)
    } catch {
      return null
    }
    cached = { key, sha256 }
  }
  return { path, versionCode, versionName, sha256: cached.sha256, size: apk.size }
}

/** What GET /api/app/android answers: { versionCode, versionName, sha256, size }, or null. */
export async function describeApp(dir = APP_DIR) {
  const f = await find(dir)
  return f ? { versionCode: f.versionCode, versionName: f.versionName, sha256: f.sha256, size: f.size } : null
}

/** Streams the installer as a download, or 404 (JSON) when none has been placed. */
export async function sendApp(res, dir = APP_DIR) {
  const f = await find(dir)
  if (!f) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'No app installer has been placed on this server.' }))
    return
  }
  res.writeHead(200, {
    'content-type': 'application/vnd.android.package-archive',
    'content-length': f.size,
    'content-disposition': `attachment; filename="argus-android-${f.versionName}.apk"`
  })
  createReadStream(f.path)
    .on('error', () => res.destroy())
    .pipe(res)
}
