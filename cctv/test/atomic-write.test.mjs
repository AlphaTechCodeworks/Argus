// Tests for atomic-write.mjs: a durable "write a temp file, fsync it, rename it over the target"
// replace, used for the small JSON state files (backfill run flag, storage stalls, thin pace). The
// point of the module over a plain writeFile+rename is the fsync BEFORE the rename: rename is atomic
// against a torn write, but without the fsync the temp's bytes may not have reached disk, so a crash
// can leave an empty or short file on reboot. The order is checked here on a recording fs that still
// does the real I/O (so the round-trip is real), and the module defaults to node:fs when none is passed.
// Run: node cctv/test/atomic-write.test.mjs
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import * as realFs from 'node:fs'
import * as realFsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { writeFileAtomic, writeFileAtomicSync } from '../atomic-write.mjs'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const before = (ops, a, b) => ops.includes(a) && ops.includes(b) && ops.indexOf(a) < ops.indexOf(b)
const noTemp = (dir, file) => !readdirSync(dir).some((n) => n !== basename(file) && n.startsWith(basename(file)))

const dir = mkdtempSync(join(tmpdir(), 'atomic-'))

// a recording fs that delegates to the real one: real files are written, the op order is captured
const recSync = (ops) => ({
  openSync: (...a) => (ops.push(`open:${a[1]}`), realFs.openSync(...a)),
  writeSync: (...a) => (ops.push('write'), realFs.writeSync(...a)),
  fsyncSync: (...a) => (ops.push('fsync'), realFs.fsyncSync(...a)),
  closeSync: (...a) => (ops.push('close'), realFs.closeSync(...a)),
  renameSync: (...a) => (ops.push('rename'), realFs.renameSync(...a))
})
const recAsync = (ops) => ({
  open: async (...a) => {
    ops.push(`open:${a[1]}`)
    const fh = await realFsp.open(...a)
    return {
      writeFile: (...b) => (ops.push('write'), fh.writeFile(...b)),
      sync: () => (ops.push('fsync'), fh.sync()),
      close: () => (ops.push('close'), fh.close())
    }
  },
  rename: async (...a) => (ops.push('rename'), realFsp.rename(...a))
})

// ---- sync
{
  const file = join(dir, 'sync.json')
  const ops = []
  writeFileAtomicSync(file, '{"a":1}\n', recSync(ops))
  check('sync: the data is written', readFileSync(file, 'utf8') === '{"a":1}\n')
  check('sync: no temp file left behind', noTemp(dir, file), readdirSync(dir).join())
  check('sync: the temp is written, fsynced, then renamed (fsync before rename)', before(ops, 'write', 'fsync') && before(ops, 'fsync', 'rename'), ops.join(','))
  writeFileAtomicSync(file, '{"a":2}\n', recSync([]))
  check('sync: replaces an existing file', readFileSync(file, 'utf8') === '{"a":2}\n')
  check('sync: defaults to node:fs when no fs is passed', (writeFileAtomicSync(join(dir, 'def.json'), 'x\n'), readFileSync(join(dir, 'def.json'), 'utf8') === 'x\n'))
}

// ---- async
{
  const file = join(dir, 'async.json')
  const ops = []
  await writeFileAtomic(file, '{"b":1}\n', recAsync(ops))
  check('async: the data is written', readFileSync(file, 'utf8') === '{"b":1}\n')
  check('async: no temp file left behind', noTemp(dir, file), readdirSync(dir).join())
  check('async: the temp is written, fsynced, then renamed (fsync before rename)', before(ops, 'write', 'fsync') && before(ops, 'fsync', 'rename'), ops.join(','))
  await writeFileAtomic(file, '{"b":2}\n', recAsync([]))
  check('async: replaces an existing file', readFileSync(file, 'utf8') === '{"b":2}\n')
  await writeFileAtomic(join(dir, 'defa.json'), 'y\n')
  check('async: defaults to node:fs/promises when none is passed', existsSync(join(dir, 'defa.json')) && readFileSync(join(dir, 'defa.json'), 'utf8') === 'y\n')
}

rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
