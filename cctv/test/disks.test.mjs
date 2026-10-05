// Offline tests for preparing a USB drive (disks.mjs, the /api/admin/disks routes, the root
// helper service deploy/cctv-disk-helperd.mjs and the helper script deploy/cctv-disk-helper).
// NOTHING here touches a real disk: disks.mjs talks to a fake socket server; the helper service
// runs on a temp socket with fake helpers or the real script in its dry-run mode
// (CCTV_DISK_DRYRUN=1, a made-up device tree), where it prints the commands instead of running them.
//   node cctv/test/disks.test.mjs
import { spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-disks-test-'))
delete process.env.CCTV_DISK_DRYRUN
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ boss: { hash: 'x', role: 'admin' }, viewer: { hash: 'x', role: 'viewer' } }))
const disks = await import('../disks.mjs')
const storage = await import('../storage.mjs')
const { handleSettings } = await import('../settings-api.mjs')
const { parseDisks, _test } = disks

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// ---- parsing the helper's list -------------------------------------------------------------------
const sample = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'disks', 'list.json'), 'utf8'))
const list = parseDisks(sample)
const d = (dev) => list.find((x) => x.dev === dev)
check('only whole disks are listed (no loop, no DVD)', !d('/dev/loop0') && !d('/dev/sr0') && list.length === 7, list.map((x) => x.dev).join())
check('fields per the contract', ['dev', 'model', 'serial', 'sizeBytes', 'tran', 'partitions', 'eligible', 'why'].every((k) => k in d('/dev/sdb')))
check('system disk ineligible', d('/dev/sda').eligible === false && /system/i.test(d('/dev/sda').why), d('/dev/sda').why)
check('USB disk with an unmounted partition: eligible', d('/dev/sdb').eligible === true && d('/dev/sdb').why === '', d('/dev/sdb').why)
check('its partition is shown with what is on it', d('/dev/sdb').partitions.length === 1 && d('/dev/sdb').partitions[0].fstype === 'ntfs' && d('/dev/sdb').partitions[0].label === 'Seagate' && d('/dev/sdb').partitions[0].mountpoint === null && d('/dev/sdb').partitions[0].sizeBytes === 4000650887168)
check('mounted disk ineligible', d('/dev/sdc').eligible === false && /mounted/i.test(d('/dev/sdc').why) && d('/dev/sdc').partitions[0].mountpoint === '/media/owner/Photos', d('/dev/sdc').why)
check('size given as a string is read as a number', d('/dev/sdc').sizeBytes === 2000365289472)
check('LVM member ineligible', d('/dev/sdd').eligible === false && /LVM/i.test(d('/dev/sdd').why), d('/dev/sdd').why)
check('ZFS pool member ineligible', d('/dev/nvme0n1').eligible === false && /ZFS/i.test(d('/dev/nvme0n1').why), d('/dev/nvme0n1').why)
check('blank USB disk eligible', d('/dev/sde').eligible === true && d('/dev/sde').partitions.length === 0 && d('/dev/sde').tran === 'usb')
check('a serial that cannot be typed safely: ineligible', d('/dev/sdf').eligible === false && /serial/i.test(d('/dev/sdf').why))
check('the root list from the helper counts as system disks', parseDisks({ ...sample, root: ['/dev/sde'] }).find((x) => x.dev === '/dev/sde').eligible === false)
check('garbage from the helper: an error, not a crash', (() => { try { parseDisks({}); return false } catch (e) { return /helper/i.test(e.message) } })())

// ---- the API against a fake helper socket --------------------------------------------------------------
check('disks.mjs: the helper socket is /run/cctv-disk/helper.sock', disks.SOCKET === '/run/cctv-disk/helper.sock')
const dsrc = readFileSync(join(import.meta.dirname, '..', 'disks.mjs'), 'utf8')
check('disks.mjs: no sudo and no child processes at all', !/'sudo'|"sudo"|child_process|spawn\(/.test(dsrc))
const sockDir = mkdtempSync(join(tmpdir(), 'cctv-disks-sock-'))
const calls = []
let prepareLines = []
let prepareCode = 0
let openGate
let gate = new Promise((r) => (openGate = r))
const fake = createServer((sock) => {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', async (c) => {
    buf += c
    const i = buf.indexOf('\n')
    if (i < 0) return
    const req = JSON.parse(buf.slice(0, i))
    calls.push(req)
    if (req.op === 'list') {
      sock.end(`${JSON.stringify(sample)}\n{"exit":0}\n`)
      return
    }
    await gate
    for (const l of prepareLines) sock.write(`${l}\n`)
    sock.end(`{"exit":${prepareCode}}\n`)
  })
})
const fakePath = join(sockDir, 'helper.sock')
await new Promise((r) => fake.listen(fakePath, r))
_test.setSocket(fakePath)
const json = (o) => async () => o
const calledPrepare = () => calls.filter((a) => a.op === 'prepare')

const [g1, gb1] = await handleSettings('GET', '/api/admin/disks', json({}), 'boss')
check('GET /disks as admin: the list', g1 === 200 && gb1.disks.length === 7 && gb1.job === null, JSON.stringify(gb1).slice(0, 120))
const [g2] = await handleSettings('GET', '/api/admin/disks', json({}), 'viewer')
check('GET /disks as non-admin: 403', g2 === 403)
const [v1] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sdb', serial: 'NAABC123', fs: 'xfs' }), 'viewer')
check('prepare as non-admin: 403, helper not called', v1 === 403 && calledPrepare().length === 0)
const [s1, sb1] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sdb', serial: 'NAABC12', fs: 'xfs' }), 'boss')
check('serial mismatch: 400, helper not called', s1 === 400 && /serial/i.test(sb1.error) && calledPrepare().length === 0, sb1.error)
const [s2] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sdb', serial: 'naabc123', fs: 'xfs' }), 'boss')
check('serial must match exactly (case too)', s2 === 400 && calledPrepare().length === 0)
const [s3] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sdb', fs: 'xfs' }), 'boss')
check('no serial typed: 400', s3 === 400 && calledPrepare().length === 0)
const [s4] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sdb', serial: 'NAABC123', fs: 'ntfs' }), 'boss')
check('file system not xfs/ext4: 400', s4 === 400 && calledPrepare().length === 0)
const [s5, sb5] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sda', serial: 'S6PNNX0T123456', fs: 'xfs' }), 'boss')
check('system disk with the right serial: refused (409), helper not called', s5 === 409 && calledPrepare().length === 0, sb5.error)
const [s6] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sdc', serial: 'WX11A', fs: 'xfs' }), 'boss')
check('mounted disk: refused (409)', s6 === 409 && calledPrepare().length === 0)
const [s7] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sdz', serial: 'X', fs: 'xfs' }), 'boss')
check('unknown disk: 404', s7 === 404 && calledPrepare().length === 0)
const [s8] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sdb; reboot', serial: 'NAABC123', fs: 'xfs' }), 'boss')
check('odd device name: 400', s8 === 400 && calledPrepare().length === 0)
const [s9] = await handleSettings('GET', '/api/admin/disks/prepare', json({}), 'boss')
check('GET on prepare: 405', s9 === 405)

// a successful run (the fake helper reports the steps; the prepared folder is a temp dir here)
const mnt = mkdtempSync(join(tmpdir(), 'cctv-disks-mnt-'))
writeFileSync(join(mnt, '.cctv-recordings'), JSON.stringify({ id: 'usb-NAABC123', created: new Date().toISOString() }))
storage._test.setDevOf((p) => (p.startsWith(mnt) ? 2 : 1))
prepareLines = [
  JSON.stringify({ step: 'check', state: 'done' }),
  'not json',
  JSON.stringify({ step: 'wipe', state: 'done' }),
  JSON.stringify({ step: 'format', state: 'done' }),
  JSON.stringify({ done: true, path: mnt, id: 'usb-NAABC123' })
]
const [p1, pb1] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sdb', serial: 'NAABC123', fs: 'xfs' }), 'boss')
check('matching serial on an eligible disk: 202, job running', p1 === 202 && pb1.job?.state === 'running', JSON.stringify(pb1))
for (let i = 0; i < 100 && !calledPrepare().length; i++) await new Promise((r) => setTimeout(r, 20)) // the request is on its way
check('helper asked with exactly {op:prepare, dev, serial, fs}', JSON.stringify(calledPrepare()[0]) === JSON.stringify({ op: 'prepare', dev: '/dev/sdb', serial: 'NAABC123', fs: 'xfs' }), JSON.stringify(calledPrepare()[0]))
check('the list went over the socket as {op:list}', calls.some((c) => JSON.stringify(c) === '{"op":"list"}'))
const [p2, pb2] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sde', serial: 'BLANK42', fs: 'xfs' }), 'boss')
check('a second prepare while one runs: 409, helper not called again', p2 === 409 && calledPrepare().length === 1, JSON.stringify(pb2))
openGate()
await _test.running()
const [g3, gb3] = await handleSettings('GET', '/api/admin/disks', json({}), 'boss')
check('job done, steps kept, bad lines ignored', gb3.job?.state === 'done' && gb3.job.steps.length === 3, JSON.stringify(gb3.job))
check('the prepared drive was added as a storage location (main: none yet)', storage.listLocations().some((l) => l.id === 'usb-NAABC123' && l.path === mnt && l.type === 'usb' && l.role === 'main'))
check('the job says which location', gb3.job.location?.id === 'usb-NAABC123')

// a failing run
prepareLines = [JSON.stringify({ step: 'check', state: 'failed', message: 'serial does not match' })]
prepareCode = 3
const [p3] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sde', serial: 'BLANK42', fs: 'ext4' }), 'boss')
await _test.running()
const [, gb4] = await handleSettings('GET', '/api/admin/disks', json({}), 'boss')
check('helper failure: job failed with the message', p3 === 202 && gb4.job.state === 'failed' && /serial does not match/.test(gb4.job.error), JSON.stringify(gb4.job))
check('nothing added on failure', storage.listLocations().length === 1)

// progress: the steps check/wipe/partition/format/mount/marker/done, and no 'null' anywhere
{
  const { progressOf, PREPARE_STEPS } = await import('../disks.mjs')
  check('prepare steps in order', JSON.stringify(PREPARE_STEPS) === JSON.stringify(['check', 'wipe', 'partition', 'format', 'mount', 'marker', 'done']))
  const p0 = progressOf({ state: 'running', steps: [] })
  const pF = progressOf({ state: 'running', steps: [{ step: 'check', state: 'done' }, { step: 'wipe', state: 'done' }, { step: 'partition', state: 'done' }, { step: 'format', state: 'start' }] })
  const pD = progressOf({ state: 'done', steps: [{ step: 'marker', state: 'done' }] })
  check('progress: nothing yet 0 %, formatting 3 of 6 steps done, done 100 %', p0.pct === 0 && p0.step === 'check' && pF.step === 'format' && pF.done === 3 && pF.pct === 50 && pD.pct === 100 && pD.step === 'done', JSON.stringify([p0, pF, pD]))
  const mnt2 = mkdtempSync(join(tmpdir(), 'cctv-disks-mnt2-'))
  writeFileSync(join(mnt2, '.cctv-recordings'), JSON.stringify({ id: 'usb-BLANK42', created: new Date().toISOString() }))
  storage._test.setDevOf((p) => (p.startsWith(mnt) ? 2 : p.startsWith(mnt2) ? 3 : 1))
  const seq = []
  for (const s of ['check', 'wipe', 'partition', 'format', 'mount', 'marker']) seq.push(JSON.stringify({ step: s, state: 'start', message: null }), JSON.stringify({ step: s, state: 'done', message: null }))
  seq.push(JSON.stringify({ step: 'mount', state: null }))
  prepareLines = [...seq, JSON.stringify({ done: true, path: mnt2, id: 'usb-BLANK42' })]
  prepareCode = 0
  const [pp] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sde', serial: 'BLANK42', fs: 'xfs' }), 'boss')
  await _test.running()
  const [, g] = await handleSettings('GET', '/api/admin/disks', json({}), 'boss')
  check('a full run: done, progress 100 % at step done', pp === 202 && g.job.state === 'done' && g.job.progress?.pct === 100 && g.job.progress.step === 'done', JSON.stringify(g.job?.progress))
  check("no 'null' in the job's steps (null state or message from the helper)", !JSON.stringify(g.job.steps).includes('null') && g.job.steps.every((s) => s.state !== '' || s.message !== ''), JSON.stringify(g.job.steps).slice(0, 300))
  // prepared, but it could not be added as a location (here: its marker is gone): not 'failed'
  const mnt3 = mkdtempSync(join(tmpdir(), 'cctv-disks-mnt3-'))
  prepareLines = [JSON.stringify({ step: 'marker', state: 'done' }), JSON.stringify({ done: true, path: mnt3, id: 'usb-XYZ' })]
  await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sde', serial: 'BLANK42', fs: 'xfs' }), 'boss')
  await _test.running()
  const [, g2] = await handleSettings('GET', '/api/admin/disks', json({}), 'boss')
  check('prepared but not added: state "prepared", not "failed"', g2.job.state === 'prepared' && !g2.job.location, JSON.stringify(g2.job))
  check('  the job says what to do (add the folder by hand, with its path)', g2.job.nextStep?.includes(mnt3) && /[Aa]dd/.test(g2.job.nextStep) && g2.job.error === '', g2.job.nextStep)
  const ui = readFileSync(new URL('../public/settings.js', import.meta.url), 'utf8')
  check('settings page: a real progress bar and the prepared-but-not-added message', /el\('progress'/.test(ui) && /job\.nextStep/.test(ui) && /'prepared'/.test(ui))
  storage._test.setDevOf((p) => (p.startsWith(mnt) ? 2 : 1))
}

// the helper service not running (no socket): a clear error, no crash
_test.setSocket(join(sockDir, 'absent.sock'))
const [g5, gb5] = await handleSettings('GET', '/api/admin/disks', json({}), 'boss')
check('helper socket absent: GET /disks answers with an error naming the disk helper', /disk helper/.test(JSON.stringify(gb5)), `${g5} ${JSON.stringify(gb5)}`)
const [p5, pb5] = await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sde', serial: 'BLANK42', fs: 'xfs' }), 'boss')
check('helper socket absent: prepare refused before anything (the list fails)', p5 >= 400 && /disk helper/.test(pb5.error ?? ''), `${p5} ${JSON.stringify(pb5)}`)
// a helper that hangs up halfway through a prepare: the job fails
{
  const cut = createServer((sock) => {
    sock.setEncoding('utf8')
    let b = ''
    sock.on('data', (c) => {
      b += c
      if (!b.includes('\n')) return
      const req = JSON.parse(b.slice(0, b.indexOf('\n')))
      if (req.op === 'list') return sock.end(`${JSON.stringify(sample)}\n{"exit":0}\n`)
      sock.end(`${JSON.stringify({ step: 'wipe', state: 'start' })}\n`)
    })
  })
  const cutPath = join(sockDir, 'cut.sock')
  await new Promise((r) => cut.listen(cutPath, r))
  _test.setSocket(cutPath)
  await handleSettings('POST', '/api/admin/disks/prepare', json({ dev: '/dev/sde', serial: 'BLANK42', fs: 'xfs' }), 'boss')
  await _test.running()
  const [, gb6] = await handleSettings('GET', '/api/admin/disks', json({}), 'boss')
  check('helper hangs up without an exit line: job failed', gb6.job.state === 'failed' && /hung up|stopped/.test(gb6.job.error), JSON.stringify(gb6.job))
  cut.close()
}
fake.close()

// ---- the helper script itself, dry run only -----------------------------------------------------------
const HELPER = join(import.meta.dirname, '..', '..', 'deploy', 'cctv-disk-helper')
if (!existsSync(HELPER)) {
  check(`helper script present at ${HELPER} (copy deploy/cctv-disk-helper into the lab)`, false)
} else {
  const t = mkdtempSync(join(tmpdir(), 'cctv-helper-dry-'))
  const tree = (lines) => {
    const f = join(t, `tree-${Math.random().toString(36).slice(2)}`)
    writeFileSync(f, lines.join('\n') + '\n')
    return f
  }
  const sdb = tree([
    'NAME="/dev/sdb" TYPE="disk" FSTYPE="" MOUNTPOINTS="" SERIAL="NAABC123"',
    'NAME="/dev/sdb1" TYPE="part" FSTYPE="ntfs" MOUNTPOINTS="" SERIAL=""'
  ])
  const dry = (args, fakeTree, extraEnv = {}) => {
    const r = spawnSync('bash', [HELPER, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CCTV_DISK_DRYRUN: '1', CCTV_DISK_FAKE_TREE: fakeTree, CCTV_DISK_FAKE_ROOT: '/dev/sda', CCTV_DISK_FAKE_UUID: '1b2c3d4e-0000-4000-8000-00000000abcd', ...extraEnv }
    })
    const lines = r.stdout.split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return { bad: l }
      }
    })
    return { code: r.status, lines, runs: lines.filter((l) => 'run' in l).map((l) => l.run), stderr: r.stderr }
  }
  const ok = dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], sdb)
  const expected = [
    'wipefs -a /dev/sdb',
    'sgdisk -Z /dev/sdb',
    'sgdisk -n1:0:0 -t1:8300 -c1:cctv-rec /dev/sdb',
    'udevadm settle',
    'mkfs.xfs -f -L cctv-rec -m uuid=1b2c3d4e-0000-4000-8000-00000000abcd /dev/sdb1',
    'mkdir -p /srv/cctv-rec/1b2c3d4e-0000-4000-8000-00000000abcd',
    'fstab: UUID=1b2c3d4e-0000-4000-8000-00000000abcd /srv/cctv-rec/1b2c3d4e-0000-4000-8000-00000000abcd xfs defaults,nofail,x-systemd.device-timeout=10s 0 0',
    'systemctl daemon-reload',
    'mount /srv/cctv-rec/1b2c3d4e-0000-4000-8000-00000000abcd',
    'chown root:cctv-disk /srv/cctv-rec/1b2c3d4e-0000-4000-8000-00000000abcd',
    'chmod 2770 /srv/cctv-rec/1b2c3d4e-0000-4000-8000-00000000abcd',
    'marker: /srv/cctv-rec/1b2c3d4e-0000-4000-8000-00000000abcd/.cctv-recordings id usb-1b2c3d4e-0000-4000-8000-00000000abcd owner root:cctv-disk'
  ]
  check('dry run: exit 0, every line JSON', ok.code === 0 && ok.lines.every((l) => !l.bad), `${ok.code} ${ok.stderr} ${JSON.stringify(ok.lines.filter((l) => l.bad))}`)
  check('dry run: the exact command list', JSON.stringify(ok.runs) === JSON.stringify(expected), JSON.stringify(ok.runs, null, 1))
  check('dry run: ends with done + path + id', ok.lines.at(-1)?.done === true && ok.lines.at(-1).path === '/srv/cctv-rec/1b2c3d4e-0000-4000-8000-00000000abcd' && ok.lines.at(-1).id === 'usb-1b2c3d4e-0000-4000-8000-00000000abcd')
  check('dry run: progress steps reported', ['check', 'wipe', 'partition', 'format', 'mount', 'marker'].every((s) => ok.lines.some((l) => l.step === s)))

  const e4 = dry(['prepare', '/dev/sdb', 'NAABC123', 'ext4'], sdb)
  check('ext4: mkfs.ext4 -F and fsck pass 2', e4.code === 0 && e4.runs.includes('mkfs.ext4 -F -L cctv-rec -U 1b2c3d4e-0000-4000-8000-00000000abcd /dev/sdb1') && e4.runs.some((r) => r.startsWith('fstab:') && r.endsWith(' ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2')), JSON.stringify(e4.runs))

  const nv = tree(['NAME="/dev/nvme1n1" TYPE="disk" FSTYPE="" MOUNTPOINTS="" SERIAL="NV9"'])
  const nvr = dry(['prepare', '/dev/nvme1n1', 'NV9', 'xfs'], nv)
  check('nvme: partition is ...p1', nvr.code === 0 && nvr.runs.includes('mkfs.xfs -f -L cctv-rec -m uuid=1b2c3d4e-0000-4000-8000-00000000abcd /dev/nvme1n1p1'), JSON.stringify(nvr.runs))

  const refusedBy = (name, r, pattern) =>
    check(`helper refuses: ${name}`, r.code !== 0 && r.runs.length === 0 && r.lines.some((l) => l.state === 'failed' && pattern.test(l.message ?? '')), `${r.code} ${JSON.stringify(r.lines)} ${r.stderr}`)
  // two drives reporting the same serial (cheap USB enclosures): separate mount points (by UUID)
  const U2 = '9f8e7d6c-1111-4222-8333-444455556666'
  const twin = dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], sdb, { CCTV_DISK_FAKE_UUID: U2 })
  check('same serial, second drive: its own mount point /srv/cctv-rec/<its uuid>', twin.code === 0 && twin.lines.at(-1)?.path === `/srv/cctv-rec/${U2}` && twin.lines.at(-1)?.path !== ok.lines.at(-1)?.path && twin.lines.at(-1)?.id === `usb-${U2}`, JSON.stringify(twin.lines.at(-1)))
  const fstabOther = join(t, 'fstab-other')
  writeFileSync(fstabOther, `# a comment /srv/cctv-rec/1b2c3d4e-0000-4000-8000-00000000abcd\nUUID=aaaaaaaa-0000-4000-8000-000000000001 /srv/cctv-rec/1b2c3d4e-0000-4000-8000-00000000abcd xfs defaults 0 0\n`)
  refusedBy('target mount point in fstab for another UUID', dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], sdb, { CCTV_DISK_FAKE_FSTAB: fstabOther }), /fstab/i)
  const fstabSame = join(t, 'fstab-same')
  writeFileSync(fstabSame, `UUID=1b2c3d4e-0000-4000-8000-00000000abcd /srv/cctv-rec/1b2c3d4e-0000-4000-8000-00000000abcd xfs defaults 0 0\nUUID=aaaaaaaa-0000-4000-8000-000000000001 /srv/cctv-rec/other xfs defaults 0 0\n`)
  check('fstab lines for other mount points / the same UUID: no refusal', dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], sdb, { CCTV_DISK_FAKE_FSTAB: fstabSame }).code === 0)
  const mountsFile = join(t, 'mounts')
  writeFileSync(mountsFile, `/\n/srv/cctv-rec/1b2c3d4e-0000-4000-8000-00000000abcd\n`)
  refusedBy('target mount point already mounted', dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], sdb, { CCTV_DISK_FAKE_MOUNTS: mountsFile }), /already mounted/i)
  const swapped = tree(['NAME="/dev/sdb" TYPE="disk" FSTYPE="" MOUNTPOINTS="" SERIAL="OTHER999"'])
  refusedBy('serial changed between the checks and the wipe (read again just before wipefs)', dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], sdb, { CCTV_DISK_FAKE_TREE_AGAIN: swapped }), /serial of \/dev\/sdb changed/i)
  const nowMounted = tree(['NAME="/dev/sdb" TYPE="disk" FSTYPE="" MOUNTPOINTS="/media/x" SERIAL="NAABC123"'])
  refusedBy('disk mounted between the checks and the wipe', dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], sdb, { CCTV_DISK_FAKE_TREE_AGAIN: nowMounted }), /mounted now/i)
  const wipeAt = readFileSync(HELPER, 'utf8').indexOf('run wipefs')
  check('helper source: the serial re-read comes right before wipefs', readFileSync(HELPER, 'utf8').lastIndexOf('tree "$dev" again', wipeAt) > readFileSync(HELPER, 'utf8').lastIndexOf('say check done', wipeAt))
  check('helper source: every fake setting refused outside dry run', /env \| grep -q '\^CCTV_DISK_FAKE_'/.test(readFileSync(HELPER, 'utf8')))
  refusedBy('serial mismatch', dry(['prepare', '/dev/sdb', 'NAABC124', 'xfs'], sdb), /serial/i)
  refusedBy('mounted partition', dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], tree(['NAME="/dev/sdb" TYPE="disk" FSTYPE="" MOUNTPOINTS="" SERIAL="NAABC123"', 'NAME="/dev/sdb1" TYPE="part" FSTYPE="ext4" MOUNTPOINTS="/media/x" SERIAL=""'])), /mounted/i)
  refusedBy('swap in use', dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], tree(['NAME="/dev/sdb" TYPE="disk" FSTYPE="" MOUNTPOINTS="" SERIAL="NAABC123"', 'NAME="/dev/sdb1" TYPE="part" FSTYPE="swap" MOUNTPOINTS="[SWAP]" SERIAL=""'])), /mounted/i)
  refusedBy('ZFS member', dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], tree(['NAME="/dev/sdb" TYPE="disk" FSTYPE="" MOUNTPOINTS="" SERIAL="NAABC123"', 'NAME="/dev/sdb1" TYPE="part" FSTYPE="zfs_member" MOUNTPOINTS="" SERIAL=""'])), /ZFS|pool/i)
  refusedBy('LVM member', dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], tree(['NAME="/dev/sdb" TYPE="disk" FSTYPE="LVM2_member" MOUNTPOINTS="" SERIAL="NAABC123"'])), /LVM/i)
  refusedBy('RAID member', dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], tree(['NAME="/dev/sdb" TYPE="disk" FSTYPE="linux_raid_member" MOUNTPOINTS="" SERIAL="NAABC123"'])), /RAID/i)
  refusedBy('the system disk', dry(['prepare', '/dev/sda', 'SYS1', 'xfs'], tree(['NAME="/dev/sda" TYPE="disk" FSTYPE="" MOUNTPOINTS="" SERIAL="SYS1"'])), /system/i)
  refusedBy('a partition instead of a disk', dry(['prepare', '/dev/sdb1', 'NAABC123', 'xfs'], tree(['NAME="/dev/sdb1" TYPE="part" FSTYPE="" MOUNTPOINTS="" SERIAL="NAABC123"'])), /disk/i)
  refusedBy('odd device name', dry(['prepare', '/dev/sdb;id', 'NAABC123', 'xfs'], sdb), /device/i)
  refusedBy('odd serial', dry(['prepare', '/dev/sdb', '../../etc', 'xfs'], sdb), /serial/i)
  refusedBy('unknown file system', dry(['prepare', '/dev/sdb', 'NAABC123', 'ntfs'], sdb), /xfs|ext4/i)
  // a label with shell syntax in it must be read as text, never run
  const evil = tree(['NAME="/dev/sdb" TYPE="disk" FSTYPE="" MOUNTPOINTS="" SERIAL="NAABC123"', `NAME="/dev/sdb1" TYPE="part" FSTYPE="ntfs$(touch ${join(t, 'pwned')})" MOUNTPOINTS="" SERIAL=""`])
  dry(['prepare', '/dev/sdb', 'NAABC123', 'xfs'], evil)
  check('device tree text is never executed', !existsSync(join(t, 'pwned')))
  // (the helper is never run without CCTV_DISK_DRYRUN=1 here; its refusal of the fake-tree
  // settings outside dry run is checked in the source instead)
  const src = readFileSync(HELPER, 'utf8')
  const guard = src.indexOf('CCTV_DISK_FAKE_TREE only in dry run')
  const firstRun = src.search(/^\s*run /m)
  check('helper source: fake-tree settings refused outside dry run, before any command', guard > 0 && firstRun > guard)
  check('helper source: every destructive command goes through run()', !/^\s*(wipefs|sgdisk|mkfs\.\w+|mount|chown) /m.test(src))
  check('helper source: no sudo / SUDO_UID any more', !/SUDO_|through sudo/.test(src))

  // ---- the helper service (cctv-disk-helperd.mjs) on a temp socket ------------------------------------
  const D = join(import.meta.dirname, '..', '..', 'deploy', 'cctv-disk-helperd.mjs')
  if (!existsSync(D)) check(`helper service present at ${D} (copy deploy/cctv-disk-helperd.mjs into the lab)`, false)
  else {
    const { serve, parseRequest, SAFE_ENV, HELPER: DHELPER } = await import(D)
    check('service: runs /usr/local/sbin/cctv-disk-helper with a fixed environment (no CCTV_*)', DHELPER === '/usr/local/sbin/cctv-disk-helper' && Object.keys(SAFE_ENV).sort().join() === 'LC_ALL,PATH' && Object.isFrozen(SAFE_ENV))
    const refusedReq = (name, line) => { let m = ''; try { parseRequest(line) } catch (e) { m = e.message } check(`service refuses: ${name}`, /^refused/.test(m), m) }
    refusedReq('unknown op', '{"op":"shell","cmd":"id"}')
    refusedReq('list with arguments', '{"op":"list","dev":"/dev/sda"}')
    refusedReq('prepare with an extra field', '{"op":"prepare","dev":"/dev/sdb","serial":"A1","fs":"xfs","force":true}')
    refusedReq('prepare with a missing field', '{"op":"prepare","dev":"/dev/sdb","fs":"xfs"}')
    refusedReq('odd device', '{"op":"prepare","dev":"/dev/sdb;reboot","serial":"A1","fs":"xfs"}')
    refusedReq('a partition', '{"op":"prepare","dev":"/dev/sdb1","serial":"A1","fs":"xfs"}')
    refusedReq('odd serial', '{"op":"prepare","dev":"/dev/sdb","serial":"../x","fs":"xfs"}')
    refusedReq('odd file system', '{"op":"prepare","dev":"/dev/sdb","serial":"A1","fs":"ntfs"}')
    refusedReq('not JSON', 'list')
    refusedReq('an array', '["list"]')
    // parseRequest answers { args } (plus `stdin` for a netmount's secret: see netshares.test.mjs)
    check('service accepts list and prepare', JSON.stringify(parseRequest('{"op":"list"}').args) === '["list"]' && JSON.stringify(parseRequest('{"fs":"ext4","serial":"A1","dev":"/dev/nvme0n1","op":"prepare"}').args) === '["prepare","/dev/nvme0n1","A1","ext4"]')

    const ask = (path, text) => new Promise((resolve) => {
      const lines = []
      let b = ''
      const c = createConnection(path)
      c.setEncoding('utf8')
      c.on('connect', () => c.write(text))
      c.on('data', (d) => (b += d))
      c.on('error', (e) => resolve({ err: e.code, lines }))
      c.on('close', () => {
        for (const l of b.split('\n').filter(Boolean)) { try { lines.push(JSON.parse(l)) } catch { lines.push({ bad: l }) } }
        resolve({ lines, exit: lines.at(-1)?.exit })
      })
    })
    const startService = async (opts) => {
      const srv = createServer()
      const path = join(sockDir, `d-${Math.random().toString(36).slice(2)}.sock`)
      const st = serve(srv, { log: () => {}, ...opts })
      await new Promise((r) => srv.listen(path, r))
      return { srv, path, st }
    }
    // the real script, dry run, through the service: the whole chain
    const dryEnv = { PATH: process.env.PATH, CCTV_DISK_DRYRUN: '1', CCTV_DISK_FAKE_TREE: sdb, CCTV_DISK_FAKE_ROOT: '/dev/sda', CCTV_DISK_FAKE_UUID: '1b2c3d4e-0000-4000-8000-00000000abcd' }
    const helperCopy = join(sockDir, 'cctv-disk-helper') // executable copy (the lab copy is 644; installed it is 755)
    writeFileSync(helperCopy, readFileSync(HELPER))
    chmodSync(helperCopy, 0o755)
    const s1 = await startService({ helper: helperCopy, env: dryEnv })
    const r1 = await ask(s1.path, '{"op":"prepare","dev":"/dev/sdb","serial":"NAABC123","fs":"xfs"}\n')
    check('service + dry-run script: progress lines streamed, then exit 0', r1.exit === 0 && r1.lines.filter((l) => 'run' in l).map((l) => l.run).join('|') === expected.join('|') && r1.lines.at(-2)?.done === true, JSON.stringify(r1.lines).slice(0, 300))
    const r2 = await ask(s1.path, '{"op":"prepare","dev":"/dev/sdb","serial":"WRONG1","fs":"xfs"}\n')
    check('service + dry-run script: the script still refuses a wrong serial (re-checked before wiping)', r2.exit === 3 && !r2.lines.some((l) => 'run' in l) && r2.lines.some((l) => /serial/.test(l.message ?? '')), JSON.stringify(r2.lines))
    const r3 = await ask(s1.path, '{"op":"format","dev":"/dev/sdb"}\n')
    check('service: an unknown op is refused, nothing run', r3.exit === 2 && /refused/.test(r3.lines[0]?.error ?? '') && r3.lines.length === 2, JSON.stringify(r3.lines))
    const r4 = await ask(s1.path, 'x'.repeat(5000))
    check('service: an over-long request is refused', r4.exit === 2 && /too long/.test(r4.lines[0]?.error ?? ''), JSON.stringify(r4.lines))
    s1.srv.close()
    // a fake helper: prints its environment and arguments; a slow one for "one prepare at a time"
    const fakeHelper = join(sockDir, 'fake-helper')
    writeFileSync(fakeHelper, [
      '#!/bin/bash',
      'printf \'{"args":"%s","dry":"%s","path":"%s"}\\n\' "$*" "${CCTV_DISK_DRYRUN:-}" "$PATH"',
      '[ "$1" = prepare ] && sleep 1',
      'echo oops >&2',
      'exit 0',
      ''
    ].join('\n'))
    chmodSync(fakeHelper, 0o755)
    process.env.CCTV_DISK_DRYRUN = '1' // must NOT reach the helper through the default environment
    const s2 = await startService({ helper: fakeHelper })
    const r5 = await ask(s2.path, '{"op":"list"}\n')
    check('service: list runs "helper list" with the fixed environment (no CCTV_DISK_DRYRUN from the service)', r5.exit === 0 && r5.lines[0]?.args === 'list' && r5.lines[0]?.dry === '' && r5.lines[0]?.path === SAFE_ENV.PATH, JSON.stringify(r5.lines))
    delete process.env.CCTV_DISK_DRYRUN
    const pa = ask(s2.path, '{"op":"prepare","dev":"/dev/sdb","serial":"A1","fs":"xfs"}\n')
    await new Promise((r) => setTimeout(r, 200))
    const busy = await ask(s2.path, '{"op":"prepare","dev":"/dev/sdc","serial":"B2","fs":"ext4"}\n')
    check('service: a second prepare while one runs is refused', busy.exit === 4 && /being prepared/.test(busy.lines[0]?.message ?? ''), JSON.stringify(busy.lines))
    const listDuring = await ask(s2.path, '{"op":"list"}\n')
    check('service: list still works during a prepare', listDuring.exit === 0)
    const ra = await pa
    check('service: the first prepare finishes with its arguments passed exactly', ra.exit === 0 && ra.lines[0]?.args === 'prepare /dev/sdb A1 xfs', JSON.stringify(ra.lines))
    check('service: prepare done -> the next one is accepted', s2.st.preparing() === null)
    s2.srv.close()
    const s3 = await startService({ helper: fakeHelper, requestTimeoutMs: 200 })
    const r6 = await ask(s3.path, '{"op":"list"}') // no newline: never a whole request
    check('service: no complete request in time -> refused', r6.exit === 2 && /time limit/.test(r6.lines[0]?.error ?? ''), JSON.stringify(r6.lines))
    s3.srv.close()
    const dsrc2 = readFileSync(D, 'utf8')
    check('service source: only socket activation starts it as a server, as root', /LISTEN_FDS/.test(dsrc2) && /getuid/.test(dsrc2))
  }

  // ---- the unit files and the installer (text checks; systemd-analyze verify runs separately)
  const dep = (n) => readFileSync(join(import.meta.dirname, '..', '..', 'deploy', n), 'utf8')
  const unit = dep('cctv.service')
  for (const k of ['NoNewPrivileges=yes', 'PrivateDevices=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'DynamicUser=yes', 'RestrictSUIDSGID=yes', 'SupplementaryGroups=cctv-disk', 'ReadWritePaths=-/srv/cctv-rec']) check(`cctv.service: ${k}`, unit.split('\n').includes(k))
  check('cctv.service: no capabilities, no loosening', !/AmbientCapabilities|CapabilityBoundingSet|NoNewPrivileges=no|PrivateDevices=no/.test(unit))
  const sockU = dep('cctv-disk-helper.socket')
  for (const k of ['ListenStream=/run/cctv-disk/helper.sock', 'SocketMode=0660', 'SocketGroup=cctv-disk', 'SocketUser=root', 'Accept=no']) check(`socket unit: ${k}`, sockU.split('\n').includes(k))
  const svcU = dep('cctv-disk-helper.service')
  check('helper unit: runs the service script with node', svcU.includes('ExecStart=/usr/local/bin/node /usr/local/lib/cctv/cctv-disk-helperd.mjs'))
  check('helper unit: no mount namespace (its mount must be visible system-wide)', !/^(ProtectSystem|ProtectHome|PrivateTmp|PrivateDevices|ReadWritePaths|ReadOnlyPaths|BindPaths|TemporaryFileSystem|PrivateMounts|ProtectKernelModules|ProtectKernelLogs|MountAPIVFS)=/m.test(svcU))
  const inst = dep('install-ubuntu.sh')
  check('installer: no sudoers rule is written (the old one is removed)', !/visudo|NOPASSWD/.test(inst) && inst.includes('rm -f /etc/sudoers.d/cctv-disk'))
  check('installer: creates the cctv-disk group, installs and enables the socket', inst.includes('groupadd --system cctv-disk') && inst.includes('systemctl enable --now cctv-disk-helper.socket') && inst.includes('/usr/local/lib/cctv/cctv-disk-helperd.mjs'))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
