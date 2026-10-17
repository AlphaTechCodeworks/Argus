// A release that changes only pages, taken up without a restart.
//
// Every install restarted the service: each viewer's video dropped and the NVRs took one to three
// minutes to log in again, twelve times on 2026-10-09, most of them for a change to a page script or
// a stylesheet. The pages are plain files read from the release's public folder, so a release that
// differs from the running one in nothing else can be served by the process already running: the
// installer switches the `current` link as it always did and sends the main process SIGHUP instead
// of restarting it (server.mjs), and this says whether that is safe and where the pages now are.
//
// Safe means: everything the process has loaded is the same in the new release. That is judged from
// the files themselves, never from what the installer says it changed.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PAGES = 'cctv/public'
const NOT_LOADED = new Set([PAGES, 'cctv/test', 'RELEASE']) // pages, tests, and the release's own name
const BY_SIZE = new Set(['node_modules', 'bin']) // large and never edited in place: names and sizes

/**
 * One digest of everything in a release the server process loads: the contents of its own files,
 * and the names and sizes of the libraries beside them.
 */
export function serverDigest(root) {
  const h = createHash('sha256')
  const walk = (dir, rel, bySize) => {
    for (const name of readdirSync(dir).sort()) {
      const r = rel ? `${rel}/${name}` : name
      if (NOT_LOADED.has(r)) continue
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p, r, bySize || BY_SIZE.has(r))
      else {
        h.update(`${r}\0${st.size}\0`)
        if (!bySize) h.update(readFileSync(p))
      }
    }
  }
  walk(root, '', false)
  return h.digest('hex')
}

/**
 * Whether the release `link` points at can be served by a process started from `running`.
 * @param {{ running: string, link: string }} o running: the release root the process was started
 *   from (its loaded code); link: the `current` link the installer switches
 * @returns {{ ok: true, root: string, release: string, publicDir: string } | { ok: false, why: string }}
 */
export function pagesFrom({ running, link }) {
  let root
  try {
    root = realpathSync(link)
  } catch (e) {
    return { ok: false, why: `cannot follow ${link} (${e.code ?? e.message})` }
  }
  const publicDir = join(root, 'cctv', 'public')
  if (!existsSync(join(publicDir, 'index.html'))) return { ok: false, why: `${root} has no pages` }
  let same
  try {
    same = serverDigest(root) === serverDigest(running)
  } catch (e) {
    return { ok: false, why: `could not compare the releases (${e.code ?? e.message})` }
  }
  if (!same) return { ok: false, why: `${root} changes the server's own files: it needs a restart` }
  let release = ''
  try {
    release = readFileSync(join(root, 'RELEASE'), 'utf8').trim()
  } catch {}
  if (!release) return { ok: false, why: `${root} has no RELEASE name` }
  return { ok: true, root, release, publicDir }
}
