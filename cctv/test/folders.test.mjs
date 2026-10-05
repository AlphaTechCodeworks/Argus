// The storage-location folder browser (folders.mjs, settings-api.mjs, the Settings page): admins
// only; lists folders under /srv/cctv-rec, /mnt and /media only (here: temp roots), hides system
// areas (hidden folders, lost+found, WSL's Windows drives, links that lead outside the roots);
// "New folder" makes one folder inside a root; nothing else is written. Temp dirs only.
// Run:  node cctv/test/folders.test.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'folders-data-'))
const base = mkdtempSync(join(tmpdir(), 'folders-'))
const srv = join(base, 'srv-cctv-rec')
const mnt = join(base, 'mnt')
const media = join(base, 'media-absent') // a root that does not exist: left out
for (const d of [srv, mnt]) mkdirSync(d)
mkdirSync(join(srv, 'usb-1234'))
writeFileSync(join(srv, 'usb-1234', '.cctv-recordings'), '{"id":"usb-1234"}')
mkdirSync(join(srv, 'empty'))
mkdirSync(join(srv, '.hidden'))
mkdirSync(join(srv, 'lost+found'))
writeFileSync(join(srv, 'a-file.txt'), 'x')
mkdirSync(join(mnt, 'c')) // WSL: the Windows C: drive
mkdirSync(join(mnt, 'wsl'))
mkdirSync(join(mnt, 'wslg'))
mkdirSync(join(mnt, 'nas'))
mkdirSync(join(mnt, 'nas', 'cams'))
const outside = mkdtempSync(join(tmpdir(), 'folders-outside-'))
try {
  symlinkSync(outside, join(mnt, 'escape'))
} catch {}
process.env.CCTV_FOLDER_ROOTS = [srv, mnt, media].join(':')

const { ROOTS, listFolders, makeFolder } = await import('../folders.mjs')
const { handleSettings } = await import('../settings-api.mjs')
check('roots: /srv/cctv-rec, /mnt, /media by default (the test overrides them)', ROOTS.length === 3 && ROOTS[0] === srv)
{
  const src = readFileSync(new URL('../folders.mjs', import.meta.url), 'utf8')
  check('default roots in the code', /\['\/srv\/cctv-rec', '\/mnt', '\/media'\]/.test(src))
}

const top = listFolders('')
check('no path: the roots that exist', top.path === null && top.folders.map((f) => f.path).join() === [srv, mnt].join(), JSON.stringify(top))
const s = listFolders(srv)
const names = s.folders.map((f) => f.name)
check('a root: its folders, sorted, no files', names.join() === 'empty,usb-1234', names.join())
check('hidden folders and lost+found are not shown', !names.includes('.hidden') && !names.includes('lost+found'))
check('a folder with a recordings marker is flagged', s.folders.find((f) => f.name === 'usb-1234')?.recordings === true && s.folders.find((f) => f.name === 'empty')?.recordings === false)
check('a root has no parent (the top list instead)', s.parent === null)
const m = listFolders(mnt)
check('/mnt: Windows drives and WSL internals are hidden, links out of the roots too', m.folders.map((f) => f.name).join() === 'nas', m.folders.map((f) => f.name).join())
const n = listFolders(join(mnt, 'nas'))
check('a sub-folder: its parent is given', n.parent === mnt && n.folders[0]?.name === 'cams')
const refused = (fn, re) => {
  try {
    fn()
    return false
  } catch (e) {
    return e.status >= 400 && e.status < 500 && (!re || re.test(e.message))
  }
}
check('outside the roots: refused', refused(() => listFolders('/etc'), /only folders under/))
check('.. out of a root: refused', refused(() => listFolders(`${srv}/../..`)))
check('a relative path: refused', refused(() => listFolders('srv')))
check('a hidden system area by name: refused', refused(() => listFolders(join(mnt, 'c'))))
check('a link leading outside the roots: refused', !existsSync(join(mnt, 'escape')) || refused(() => listFolders(join(mnt, 'escape'))))
check('a folder that does not exist: 404', (() => { try { listFolders(join(srv, 'nope')); return false } catch (e) { return e.status === 404 } })())

// New folder
const made = makeFolder(join(mnt, 'nas'), 'usb 2')
check('New folder: made inside the folder shown', made.path === join(mnt, 'nas', 'usb 2') && existsSync(made.path))
check('New folder: an existing name is refused', refused(() => makeFolder(join(mnt, 'nas'), 'usb 2'), /exists/))
for (const bad of ['..', '.x', 'a/b', '', 'x'.repeat(80), 'lost+found', 'a\nb']) check(`New folder: bad name ${JSON.stringify(bad).slice(0, 20)} refused`, refused(() => makeFolder(srv, bad)))
check('New folder: outside the roots refused', refused(() => makeFolder(outside, 'x')) && !existsSync(join(outside, 'x')))
check('New folder: at the top list (no folder) refused', refused(() => makeFolder('', 'x')))

// the API: admins only; GET lists (read-only), POST makes a folder
const json = (o) => async () => o
const P = '/api/admin/storage/folders'
const [s1] = await handleSettings('GET', P, json({}), 'bob', false, { params: new URLSearchParams({ path: srv }) })
check('API: not an admin -> 403', s1 === 403)
const [s2, b2] = await handleSettings('GET', P, json({}), 'boss', true, { params: new URLSearchParams({ path: srv }) })
check('API: GET ?path= lists', s2 === 200 && b2.folders.length === 2 && b2.path === srv, JSON.stringify(b2))
const [s3, b3] = await handleSettings('GET', P, json({}), 'boss', true, { params: new URLSearchParams({ path: '/etc' }) })
check('API: GET outside the roots -> 4xx with a message', s3 >= 400 && s3 < 500 && /only folders under/.test(b3.error ?? ''), `${s3} ${JSON.stringify(b3)}`)
const [s4, b4] = await handleSettings('POST', P, json({ path: srv, name: 'cam-drive' }), 'boss', true)
check('API: POST {path, name} makes the folder', s4 === 200 && b4.path === join(srv, 'cam-drive') && existsSync(join(srv, 'cam-drive')), JSON.stringify(b4))
const [s5] = await handleSettings('DELETE', P, json({}), 'boss', true)
check('API: other methods 405', s5 === 405)

// the Settings page: a Browse button, the dialog, New folder, Select fills the path; server passes the query
const html = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8')
const js = readFileSync(new URL('../public/settings.js', import.meta.url), 'utf8')
check('page: Browse… next to the folder field, a folder dialog with New folder and Select', /id="l-browse"/.test(html) && /<dialog id="folders"/.test(html) && /id="f-new"/.test(html) && /id="f-select"/.test(html))
check('page: Select fills the folder field', /\$\('l-path'\)\.value = /.test(js) && /\/api\/admin\/storage\/folders/.test(js))
const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
check('server passes the query to handleSettings', /await handleSettings\(.*\{ ramEstimate, params: url\.searchParams \}\)/.test(server))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
