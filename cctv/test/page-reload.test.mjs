import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pagesFrom, serverDigest } from '../page-reload.mjs'

/** A small release: server files, a library, pages, a test, its name. */
function release(base, name) {
  const root = join(base, 'releases', name)
  for (const d of ['cctv/public/css', 'cctv/test', 'bin/linux', 'node_modules/ws']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, 'cctv/server.mjs'), 'export const a = 1\n')
  writeFileSync(join(root, 'cctv/live.mjs'), 'export const b = 2\n')
  writeFileSync(join(root, 'cctv/public/index.html'), '<p>one</p>')
  writeFileSync(join(root, 'cctv/public/css/live.css'), 'a{}')
  writeFileSync(join(root, 'cctv/test/x.test.mjs'), '1')
  writeFileSync(join(root, 'bin/linux/libsdk.so'), Buffer.alloc(64))
  writeFileSync(join(root, 'node_modules/ws/index.js'), 'ws')
  writeFileSync(join(root, 'VERSION'), '1.0\n')
  writeFileSync(join(root, 'RELEASE'), `${name}\n`)
  return root
}
/** The installer's step: a copy of the running release under a new name, then the `current` link. */
function next(base, from, name, change) {
  const root = join(base, 'releases', name)
  cpSync(from, root, { recursive: true })
  writeFileSync(join(root, 'RELEASE'), `${name}\n`)
  change(root)
  const link = join(base, 'current')
  rmSync(link, { force: true })
  symlinkSync(root, link, 'junction')
  return { root, link }
}

test('pages, a stylesheet, a test and the name may change: taken up, and its pages are where it says', () => {
  const base = mkdtempSync(join(tmpdir(), 'argus-pages-'))
  const running = release(base, 'r1')
  const { root, link } = next(base, running, 'r2', (r) => {
    writeFileSync(join(r, 'cctv/public/index.html'), '<p>two</p>')
    writeFileSync(join(r, 'cctv/public/css/live.css'), 'a{color:red}')
    writeFileSync(join(r, 'cctv/public/new.js'), 'x')
    writeFileSync(join(r, 'cctv/test/x.test.mjs'), '2')
  })
  const r = pagesFrom({ running, link })
  assert.equal(r.ok, true, r.why)
  assert.equal(r.release, 'r2')
  assert.equal(r.publicDir.replaceAll('\\', '/').endsWith('releases/r2/cctv/public'), true)
  assert.equal(serverDigest(root), serverDigest(running))
})

test('a server file changed, added or gone, or a library of another size: a restart, said so', () => {
  const base = mkdtempSync(join(tmpdir(), 'argus-pages-'))
  const running = release(base, 'r1')
  const cases = {
    'edited in place, same length': (r) => writeFileSync(join(r, 'cctv/live.mjs'), 'export const b = 3\n'),
    added: (r) => writeFileSync(join(r, 'cctv/frame-gaps.mjs'), 'x'),
    gone: (r) => rmSync(join(r, 'cctv/live.mjs')),
    'library': (r) => writeFileSync(join(r, 'bin/linux/libsdk.so'), Buffer.alloc(65)),
    'module': (r) => writeFileSync(join(r, 'node_modules/ws/index.js'), 'ws2'),
    'version': (r) => writeFileSync(join(r, 'VERSION'), '1.1\n')
  }
  let n = 2
  for (const [what, change] of Object.entries(cases)) {
    const { link } = next(base, running, `r${n++}`, change)
    const r = pagesFrom({ running, link })
    assert.equal(r.ok, false, what)
    assert.match(r.why, /needs a restart/, what)
  }
})

test('no link, no pages or no name: not taken up, with the reason', () => {
  const base = mkdtempSync(join(tmpdir(), 'argus-pages-'))
  const running = release(base, 'r1')
  assert.match(pagesFrom({ running, link: join(base, 'nowhere') }).why, /cannot follow/)
  assert.match(pagesFrom(next(base, running, 'r2', (r) => rmSync(join(r, 'cctv/public'), { recursive: true })) && { running, link: join(base, 'current') }).why, /has no pages/)
  assert.match(pagesFrom(next(base, running, 'r3', (r) => writeFileSync(join(r, 'RELEASE'), '\n')) && { running, link: join(base, 'current') }).why, /no RELEASE name/)
})
