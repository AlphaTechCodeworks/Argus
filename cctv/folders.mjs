// The folder browser for adding a storage location (Settings tab, admins only; settings-api.mjs):
//
//   GET  /api/admin/storage/folders?path=<folder>  -> { path, parent, folders: [{ name, path, recordings }] }
//        (no path: the roots that exist, parent null). Read-only.
//   POST /api/admin/storage/folders { path, name }  -> { path }   "New folder": one folder inside path
//
// Only folders under ROOTS (/srv/cctv-rec, /mnt, /media) are shown, and system areas are hidden:
// hidden folders, lost+found, WSL's Windows drives and internals under /mnt (c, d, ..., wsl, wslg),
// and anything whose real path (links followed) is outside the roots. No files are listed, and
// nothing is written except the one folder "New folder" makes.
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { HttpError } from './nvr-xml.mjs'

const DEFAULT_ROOTS = ['/srv/cctv-rec', '/mnt', '/media']
// (tests: CCTV_FOLDER_ROOTS, colon-separated)
export const ROOTS = process.env.CCTV_FOLDER_ROOTS ? process.env.CCTV_FOLDER_ROOTS.split(':').filter(Boolean) : DEFAULT_ROOTS
const MARKER = '.cctv-recordings'
const MAX_ENTRIES = 500
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/

const inside = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
const realRoots = () =>
  ROOTS.map((r) => {
    try {
      return { root: r, real: realpathSync(r) }
    } catch {
      return null
    }
  }).filter(Boolean)

/** A system area that is never shown or opened (by its name in its folder). */
function hiddenName(name, parent) {
  if (name.startsWith('.') || name === 'lost+found') return true
  // WSL: /mnt/c, /mnt/d ... are the Windows drives, /mnt/wsl and /mnt/wslg its internals
  if (basename(parent) === 'mnt' && (/^[a-z]$/.test(name) || name === 'wsl' || name === 'wslg')) return true
  return false
}

/**
 * The folder, checked: absolute, under a root (also after links are followed), no hidden part.
 * @returns {{ path: string, root: string }} path: as asked (normalised); root: the root it is under
 */
function checked(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[\0\n]/.test(path)) throw new HttpError(400, 'path must be a folder')
  if (!isAbsolute(path)) throw new HttpError(400, 'path must be a full folder path')
  const p = resolve(path)
  const roots = realRoots()
  const r = roots.find((x) => inside(p, x.root))
  if (!r) throw new HttpError(403, `only folders under ${ROOTS.join(', ')} can be browsed`)
  // every part below the root must be a visible name
  const rel = p.slice(r.root.length).split(sep).filter(Boolean)
  let parent = r.root
  for (const part of rel) {
    if (hiddenName(part, parent)) throw new HttpError(403, `${join(parent, part)} is a system area`)
    parent = join(parent, part)
  }
  if (!existsSync(p)) throw new HttpError(404, `${p} does not exist`)
  let real
  try {
    real = realpathSync(p)
  } catch (e) {
    throw new HttpError(404, `${p}: ${e.code || e.message}`)
  }
  if (!roots.some((x) => inside(real, x.real))) throw new HttpError(403, `only folders under ${ROOTS.join(', ')} can be browsed (${p} leads elsewhere)`)
  if (!statSync(real).isDirectory()) throw new HttpError(400, `${p} is not a folder`)
  return { path: p, root: r.root }
}

/** The folders in path ('' or null: the roots that exist). */
export function listFolders(path) {
  if (!path) {
    const folders = realRoots().map(({ root }) => ({ name: root, path: root, recordings: existsSync(join(root, MARKER)) }))
    return { path: null, parent: null, folders }
  }
  const { path: p, root } = checked(path)
  const roots = realRoots()
  let entries
  try {
    entries = readdirSync(p, { withFileTypes: true })
  } catch (e) {
    throw new HttpError(403, `cannot read ${p} (${e.code || e.message})`)
  }
  const folders = []
  for (const e of entries) {
    if (folders.length >= MAX_ENTRIES) break
    if (hiddenName(e.name, p)) continue
    const full = join(p, e.name)
    let real
    try {
      real = realpathSync(full)
      if (!statSync(real).isDirectory()) continue
    } catch {
      continue
    }
    if (!roots.some((x) => inside(real, x.real))) continue // a link out of the roots
    folders.push({ name: e.name, path: full, recordings: existsSync(join(full, MARKER)) })
  }
  folders.sort((a, b) => a.name.localeCompare(b.name))
  return { path: p, parent: p === root ? null : dirname(p), folders }
}

/** "New folder": makes path/name (name: letters, digits, space . _ + -; not hidden). */
export function makeFolder(path, name) {
  if (!path) throw new HttpError(400, 'open a folder first: new folders go inside one')
  const { path: p } = checked(path)
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..') || hiddenName(name, p)) {
    throw new HttpError(400, 'Folder name: up to 64 letters, digits, spaces and . _ + - (not starting with a dot)')
  }
  const full = join(p, name)
  if (existsSync(full)) throw new HttpError(409, `${full} already exists`)
  try {
    mkdirSync(full, { mode: 0o770 })
  } catch (e) {
    throw new HttpError(403, `cannot make ${full} (${e.code || e.message})`)
  }
  console.log(`[storage] folder made for a location: ${full}`)
  return { path: full }
}
