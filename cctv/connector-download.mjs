// Serves the NVR Site Connector installer to Settings > Remote sites.
//
// The installer is the Windows setup an admin runs on a server at an NVR site; it joins that server
// to the tailnet as a subnet router so this app can reach the site's NVRs by LAN IP. It carries a
// reusable Tailscale auth key baked in at build time, so it is a secret: it is NOT in the repo and
// the app never builds it. An admin builds it (build.ps1 -AuthKey ...) and drops the file in
// DATA_DIR/connector/; this module only hands out whatever is there.
//
// A .zip is preferred over a bare .exe: Chrome (Safe Browsing) blocks an unsigned .exe download hard,
// but lets an archive through. Zip the built installer, place the .zip, and the download goes through
// cleanly; a bare .exe still works (with the browser warning) as a fallback until the build is signed.
import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'

export const CONNECTOR_DIR = join(DATA_DIR, 'connector')
// in order of preference
const NAMES = ['NvrSiteConnector-Setup.zip', 'NvrSiteConnector-Setup.exe']
const TYPES = { '.zip': 'application/zip', '.exe': 'application/octet-stream' }

/** The installer file that is present (zip preferred), or null. */
function find(dir = CONNECTOR_DIR) {
  for (const name of NAMES) {
    const path = join(dir, name)
    try {
      const s = statSync(path)
      return { path, name, bytes: s.size, mtime: s.mtimeMs }
    } catch {
      /* try the next */
    }
  }
  return null
}

/** Whether an installer has been placed, and its size/age/name, for the Settings page to show. */
export function statusOf(dir = CONNECTOR_DIR) {
  const f = find(dir)
  return f ? { available: true, bytes: f.bytes, mtime: f.mtime, name: f.name } : { available: false }
}

/** Streams the installer as a download, or 404 (JSON) when none has been placed yet. */
export function sendInstaller(res, dir = CONNECTOR_DIR) {
  const f = find(dir)
  if (!f) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'No installer has been uploaded to this server yet.' }))
    return
  }
  const ext = f.name.slice(f.name.lastIndexOf('.'))
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'content-length': f.bytes,
    'content-disposition': `attachment; filename="${f.name}"`
  })
  createReadStream(f.path)
    .on('error', () => res.destroy())
    .pipe(res)
}
