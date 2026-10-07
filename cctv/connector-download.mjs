// Serves the NVR Site Connector installer to Settings > Remote sites.
//
// The installer (NvrSiteConnector-Setup.exe) is the Windows setup an admin runs on a server at an
// NVR site; it joins that server to the tailnet as a subnet router so this app can reach the site's
// NVRs by LAN IP. It carries a reusable Tailscale auth key baked in at build time, so it is a
// secret: it is NOT in the repo and the app never builds it. An admin builds it (build.ps1
// -AuthKey ...) and drops the file at INSTALLER_PATH; this module only hands out whatever is there.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'

const NAME = 'NvrSiteConnector-Setup.exe'
export const INSTALLER_PATH = join(DATA_DIR, 'connector', NAME)

/** Whether an installer has been placed, and its size/age, for the Settings page to show. */
export function statusOf(path = INSTALLER_PATH) {
  try {
    const s = statSync(path)
    return { available: true, bytes: s.size, mtime: s.mtimeMs, name: NAME }
  } catch {
    return { available: false }
  }
}

/** Streams the installer as a download, or 404 (JSON) when none has been placed yet. */
export function sendInstaller(res, path = INSTALLER_PATH) {
  if (!existsSync(path)) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'No installer has been uploaded to this server yet.' }))
    return
  }
  const size = statSync(path).size
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': size,
    'content-disposition': `attachment; filename="${NAME}"`
  })
  createReadStream(path)
    .on('error', () => res.destroy())
    .pipe(res)
}
