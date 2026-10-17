// Brings each new release of the Android app from GitHub to DATA_DIR/android/, where
// app-download.mjs hands it to the app. With this running, tagging a release of
// github.com/AlphaTechCodeworks/argus-android is all it takes: within the half hour the server holds
// it, and every device offers the update the next time it asks.
//
// The app's repository is private, so the server needs a token that may read it and nothing else
// (a fine-grained personal access token: that one repository, Contents: Read-only). An admin puts
// it in DATA_DIR/android/github-token (mode 0600). No token, no fetching: the folder can still be
// filled by hand, as before. The token is read at each round, so placing or replacing it needs no
// restart.
//
// A release carries two files (its workflow makes them): argus-android.apk and argus-android.json.
// Only a release with a higher versionCode than the installer already here is taken, the download
// is checked against the size GitHub states before it replaces anything, and Android itself refuses
// an installer not signed with the app's own key, so a wrong file here cannot reach a device.
import { createWriteStream } from 'node:fs'
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { APP_DIR, describeApp } from './app-download.mjs'

export const TOKEN_FILE = 'github-token'
const APK = 'argus-android.apk'
const INFO = 'argus-android.json'
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

const tokenIn = async (dir) => {
  try {
    return (await readFile(join(dir, TOKEN_FILE), 'utf8')).trim() || null
  } catch {
    return null
  }
}

/**
 * One round: looks at the repository's latest release and takes it if it is newer than what is here.
 * Never throws; what happened is in the answer.
 * @returns {Promise<{ updated: boolean, versionCode?: number, versionName?: string, reason?: string }>}
 */
export async function fetchLatestApp({
  dir = APP_DIR,
  repo = process.env.CCTV_APP_REPO || 'AlphaTechCodeworks/argus-android',
  api = 'https://api.github.com',
  token,
  fetchImpl = fetch
} = {}) {
  const part = join(dir, `${APK}.part`)
  try {
    if (!REPO.test(repo)) return { updated: false, reason: 'the repository name is not owner/name' }
    const key = token ?? (await tokenIn(dir))
    if (!key) return { updated: false, reason: 'no token' }
    const headers = { authorization: `Bearer ${key}`, 'user-agent': 'argus-server', 'x-github-api-version': '2022-11-28' }

    const res = await fetchImpl(`${api}/repos/${repo}/releases/latest`, { headers: { ...headers, accept: 'application/vnd.github+json' } })
    if (!res.ok) return { updated: false, reason: `GitHub answered ${res.status}` }
    const release = await res.json()
    const assets = Array.isArray(release?.assets) ? release.assets : []
    const apkAsset = assets.find((a) => a?.name === APK)
    const infoAsset = assets.find((a) => a?.name === INFO)
    if (!apkAsset || !infoAsset) return { updated: false, reason: `the latest release has no ${!apkAsset ? APK : INFO}` }

    // the asset itself, not its description: the API hands it over for this Accept, by a redirect
    const binary = { headers: { ...headers, accept: 'application/octet-stream' } }
    const infoRes = await fetchImpl(infoAsset.url, binary)
    if (!infoRes.ok) return { updated: false, reason: `GitHub answered ${infoRes.status} for ${INFO}` }
    let info
    try {
      info = JSON.parse(await infoRes.text())
    } catch {
      return { updated: false, reason: `${INFO} in the release is not JSON` }
    }
    const { versionCode, versionName } = info ?? {}
    if (!Number.isSafeInteger(versionCode) || versionCode <= 0 || typeof versionName !== 'string' || !VERSION_NAME.test(versionName)) {
      return { updated: false, reason: `${INFO} in the release has no usable version` }
    }
    const have = await describeApp(dir)
    if (have && versionCode <= have.versionCode) return { updated: false, reason: 'up to date', versionCode: have.versionCode }

    const apkRes = await fetchImpl(apkAsset.url, binary)
    if (!apkRes.ok || !apkRes.body) return { updated: false, reason: `GitHub answered ${apkRes.status} for ${APK}` }
    await pipeline(Readable.fromWeb(apkRes.body), createWriteStream(part, { mode: 0o600 }))
    const got = (await stat(part)).size
    if (Number.isSafeInteger(apkAsset.size) && got !== apkAsset.size) {
      await rm(part, { force: true })
      return { updated: false, reason: `the download was ${got} bytes, GitHub said ${apkAsset.size}` }
    }
    const head = Buffer.alloc(2)
    const fh = await open(part, 'r')
    await fh.read(head, 0, 2, 0)
    await fh.close()
    if (head.toString('latin1') !== 'PK') {
      await rm(part, { force: true })
      return { updated: false, reason: 'the download is not an Android package' }
    }

    // the description first to a side file, then both into place one after the other
    const infoPart = join(dir, `${INFO}.part`)
    await writeFile(infoPart, `${JSON.stringify({ versionCode, versionName })}\n`, { mode: 0o644 })
    await rename(part, join(dir, APK))
    await rename(infoPart, join(dir, INFO))
    return { updated: true, versionCode, versionName }
  } catch (e) {
    await rm(part, { force: true }).catch(() => {})
    return { updated: false, reason: e?.message ?? String(e) }
  }
}

/**
 * Looks for a new release now and then for as long as the server runs. Says in the log when it
 * takes one, and when the reason it could not changes (not every half hour).
 */
export function startAppFetch({ everyMs = 30 * 60_000, firstMs = 90_000, log = console.log, round = fetchLatestApp } = {}) {
  let said = null
  const go = async () => {
    const r = await round()
    if (r.updated) {
      log(`[app] took Argus for Android ${r.versionName} (${r.versionCode}) from GitHub`)
      said = null
    } else if (r.reason !== 'up to date' && r.reason !== said) {
      said = r.reason
      // no token is the ordinary state of a server that does not hand out the app: said once, quietly
      log(`[app] not fetching the Android app: ${r.reason}`)
    }
  }
  const first = setTimeout(go, firstMs)
  const timer = setInterval(go, everyMs)
  first.unref()
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
