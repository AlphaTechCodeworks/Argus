// Offline tests for adding a NAS share (netshares.mjs, the /api/admin/netshares routes, the root
// helper service deploy/cctv-disk-helperd.mjs and the helper script deploy/cctv-disk-helper).
// NOTHING here touches a real NAS: netshares.mjs talks to a fake socket server, and the helper
// script runs in its dry-run mode (CCTV_DISK_DRYRUN=1), where it prints the commands instead of
// running them and writes the credentials file and the mount unit into a temp tree so they can be
// read back. Security is the point of this file: every refusal is checked, and the password is
// hunted for in everything the code produces.
//   node cctv/test/netshares.test.mjs
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-net-test-'))
delete process.env.CCTV_DISK_DRYRUN
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ boss: { hash: 'x', role: 'admin' } }))
const netshares = await import('../netshares.mjs')
const storage = await import('../storage.mjs')
const settings = await import('../settings.mjs')
const { _test, cleanShare, isName, isSubdir, listShares, progressOf, runShareJob, shareId, NET_STEPS } = netshares

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// The one password used everywhere below. Nothing the code produces may contain it, except the
// credentials file the helper writes as root.
const PASS = 'Sup3rSecret-NAS-pw!'
const hasPass = (v) => JSON.stringify(v ?? '').includes(PASS)

// ---- what netshares.mjs refuses before anything reaches the helper --------------------------------
const good = { action: 'test', proto: 'smb', server: '192.168.0.121', share: 'Backups', subdir: 'CCTV Backup', user: 'cctv', pass: PASS }
const refused = (name, body, pattern = /./) => {
  let m = ''
  let status = 0
  try {
    cleanShare({ ...good, ...body })
  } catch (e) {
    m = e.message
    status = e.status ?? 0
  }
  check(`refused: ${name}`, status === 400 && pattern.test(m), m || 'accepted!')
}
refused('a shell command in the server', { server: '192.168.0.121; reboot' }, /Server/)
refused('a backtick in the server', { server: '192.168.0.121`id`' }, /Server/)
refused('a pipe in the server', { server: '1.2.3.4|nc evil 1' }, /Server/)
refused('an out-of-range IPv4 address', { server: '999.1.1.1' }, /Server/)
refused('an over-long server', { server: `${'a'.repeat(300)}.example` }, /Server/)
refused('a slash in the SMB share (a path, not a share)', { share: 'Backups/../etc' }, /Share/)
refused('a backslash in the SMB share', { share: 'Backups\\x' }, /Share/)
refused('a semicolon in the SMB share', { share: 'Backups;id' }, /Share/)
refused('a dollar sign in the SMB share', { share: 'Back$(id)ups' }, /Share/)
refused('an over-long SMB share', { share: 'a'.repeat(65) }, /Share/)
refused('an empty SMB share', { share: '' }, /Share/)
refused('a traversal in the folder inside the share', { subdir: '../../etc' }, /Folder/)
refused('a ".." part in the middle of the folder', { subdir: 'a/../../etc' }, /Folder/)
refused('a folder that is just a dot', { subdir: '.' }, /Folder/)
refused('a hidden folder', { subdir: '.ssh' }, /Folder/)
refused('a folder five parts deep', { subdir: 'a/b/c/d/e' }, /Folder/)
refused('an over-long folder', { subdir: 'a'.repeat(260) }, /Folder/)
refused('a NUL in the folder', { subdir: 'ok\0bad' }, /Folder/)
refused('an odd NFS export', { proto: 'nfs', share: '/export/../../etc', user: '', pass: '' }, /Export/)
refused('an NFS export with a relative part', { proto: 'nfs', share: 'export/cctv', user: '', pass: '' }, /Export/)
refused('a shell command in the user name', { user: 'cctv;id' }, /User/)
refused('an over-long password', { pass: 'x'.repeat(257) }, /password/)
refused('a line break in the password (it would break the stdin protocol)', { pass: 'a\nb' }, /line breaks/)
refused('SMB without a user name', { user: '' }, /user name/)
refused('an unknown protocol', { proto: 'iscsi' }, /SMB or NFS/)

const ok1 = cleanShare(good)
check('accepted: the real share, space and all', ok1.share === 'Backups' && ok1.subdir === 'CCTV Backup' && ok1.server === '192.168.0.121')
check('accepted: a host name, a DOMAIN\\user and an NFS export', Boolean(cleanShare({ ...good, server: 'nas.local', user: 'WORK\\cctv' })) && cleanShare({ ...good, proto: 'nfs', share: '/export/cctv', user: '', pass: '' }).proto === 'nfs')
check('accepted: names with a space, brackets, & and +', isName('CCTV Backup') && isName('Cam (old) & new+1') && isSubdir('CCTV Backup/2024'))
check('refused as a name: trailing space, leading dot, "..", a slash', !isName('CCTV '), '')
check('refused as a name: "..", ".", leading dot, a quote', !isName('..') && !isName('.') && !isName('.hidden') && !isName('a"b') && !isName('a/b'))
check('the share id is derived, never typed, and cannot be the test id', shareId('CCTV Backup') === 'cctv-backup' && shareId('probe') === 'probe-2' && shareId('!!!') === 'nas')
check('the share id stays unique', shareId('Backups', new Set(['backups'])) === 'backups-2')

// ---- the helper service: what it refuses, and where the password goes ------------------------------
const D = join(import.meta.dirname, '..', '..', 'deploy', 'cctv-disk-helperd.mjs')
const HELPER = join(import.meta.dirname, '..', '..', 'deploy', 'cctv-disk-helper')
const { serve, parseRequest } = await import(pathToFileURL(D).href)
const REQ = { op: 'netmount', proto: 'smb', server: '192.168.0.121', share: 'Backups', subdir: 'CCTV Backup', id: 'nas1', user: 'cctv', pass: PASS, mode: 'add' }
const refusedReq = (name, o) => {
  let m = ''
  try {
    parseRequest(typeof o === 'string' ? o : JSON.stringify(o))
  } catch (e) {
    m = e.message
  }
  check(`service refuses: ${name}`, /^refused/.test(m), m || 'accepted!')
}
refusedReq('an extra field', { ...REQ, force: true })
refusedReq('a missing field', { op: 'netmount', proto: 'smb', server: '1.2.3.4', share: 'a', id: 'b', user: 'c', pass: 'd', mode: 'add' })
refusedReq('an unknown mode', { ...REQ, mode: 'force' })
refusedReq('an unknown protocol', { ...REQ, proto: 'iscsi' })
refusedReq('a shell command in the server', { ...REQ, server: '1.2.3.4;reboot' })
refusedReq('a traversal in the share', { ...REQ, share: '../../etc' })
refusedReq('a traversal in the folder', { ...REQ, subdir: '../../etc/systemd/system' })
refusedReq('an absolute folder', { ...REQ, subdir: '/etc' })
refusedReq('a traversal in the id', { ...REQ, id: '../../etc/cctv/nas-x' })
refusedReq('an upper-case id (it names a file and a unit)', { ...REQ, id: 'NAS1' })
refusedReq('an over-long id', { ...REQ, id: 'a'.repeat(33) })
refusedReq('an over-long password', { ...REQ, pass: 'x'.repeat(257) })
refusedReq('a line break in the password', { ...REQ, pass: 'a\nb' })
refusedReq('a carriage return in the password', { ...REQ, pass: 'a\rb' })
refusedReq('a password that is not text', { ...REQ, pass: 42 })
refusedReq('SMB without a user name', { ...REQ, user: '' })
refusedReq('netunmount with extra fields', { op: 'netunmount', id: 'nas1', force: true })
refusedReq('netunmount with an odd id', { op: 'netunmount', id: '../x' })
refusedReq('an unknown op', { op: 'netshell', id: 'nas1' })

const p1 = parseRequest(JSON.stringify(REQ))
check('service: netmount -> the helper arguments, in order, with the folder last', JSON.stringify(p1.args) === JSON.stringify(['netmount', 'smb', '192.168.0.121', 'Backups', 'nas1', 'add', 'CCTV Backup']), JSON.stringify(p1.args))
check('service: the password is NOT an argument (ps and /proc/<pid>/cmdline are world-readable)', !hasPass(p1.args))
check('service: the password goes on stdin only, with the user name, one line each', p1.stdin === `cctv\n${PASS}\n`)
check('service: the user name is not an argument either', !JSON.stringify(p1.args).includes('cctv'))
const p2 = parseRequest(JSON.stringify({ op: 'netmount', ...REQ, proto: 'nfs', share: '/export/cctv', subdir: '', user: '', pass: '', mode: 'test' }))
check('service: NFS with no folder and no credentials', JSON.stringify(p2.args) === JSON.stringify(['netmount', 'nfs', '192.168.0.121', '/export/cctv', 'nas1', 'test', '']))
check('service: netunmount takes only the id', JSON.stringify(parseRequest('{"op":"netunmount","id":"nas1"}').args) === JSON.stringify(['netunmount', 'nas1']))
const dsrc = readFileSync(D, 'utf8')
check('service source: netmount logging names the share, never the user name or the password', !/log\([^)]*r?\.?pass/.test(dsrc) && /never the user name or the password/.test(dsrc))
const nsrc = readFileSync(join(import.meta.dirname, '..', 'netshares.mjs'), 'utf8')
check('netshares.mjs: no sudo and no child processes at all', !/'sudo'|"sudo"|child_process|spawn\(/.test(nsrc))
check('netshares.mjs: the password is never written to the settings or the job', !/pass:\s*f\.pass[\s\S]{0,200}job =/.test(nsrc) && !/entry\.pass|mine\.pass/.test(nsrc))

// ---- the helper script itself, dry run only --------------------------------------------------------
if (!existsSync(HELPER)) check(`helper script present at ${HELPER}`, false)
else {
  const t = mkdtempSync(join(tmpdir(), 'cctv-net-dry-'))
  let run = 0
  const dry = (args, extraEnv = {}, stdin = `cctv\n${PASS}\n`) => {
    const base = join(t, `r${run++}`)
    mkdirSync(base)
    const r = spawnSync('bash', [HELPER, ...args], {
      encoding: 'utf8',
      input: stdin,
      env: {
        PATH: process.env.PATH,
        CCTV_DISK_DRYRUN: '1',
        CCTV_DISK_FAKE_NET_BASE: join(base, 'srv'),
        CCTV_DISK_FAKE_ETC: join(base, 'etc'),
        CCTV_DISK_FAKE_UNITS: join(base, 'units'),
        CCTV_DISK_FAKE_GID: '900',
        ...extraEnv
      }
    })
    const lines = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return { bad: l }
        }
      })
    const unitDir = join(base, 'units')
    const credDir = join(base, 'etc')
    const readAll = (d) => (existsSync(d) ? Object.fromEntries(readdirSync(d).map((f) => [f, readFileSync(join(d, f), 'utf8')])) : {})
    return { code: r.status, lines, runs: lines.filter((l) => 'run' in l).map((l) => l.run), stderr: r.stderr, units: readAll(unitDir), creds: readAll(credDir), credDir, base }
  }

  // the real case: share "Backups", folder "CCTV Backup" (a space, on purpose)
  const a = dry(['netmount', 'smb', '192.168.0.121', 'Backups', 'nas1', 'add', 'CCTV Backup'])
  const unitName = Object.keys(a.units)[0]
  const unit = a.units[unitName] ?? ''
  check('SMB add: exit 0, every line JSON', a.code === 0 && a.lines.every((l) => !l.bad), `${a.code} ${a.stderr} ${JSON.stringify(a.lines.filter((l) => l.bad))}`)
  check('SMB add: a .mount unit, not an fstab line', unitName?.endsWith('.mount') && !a.runs.some((r) => r.startsWith('fstab:')), `${unitName} ${JSON.stringify(a.runs)}`)
  check('SMB add: the unit name is systemd path escaping of the mount point (- becomes \\x2d)', unitName?.includes('\\x2d') && !unitName.includes(' '), unitName)
  check('SMB add: What is the SHARE, not the folder inside it', /^What=\/\/192\.168\.0\.121\/Backups$/m.test(unit), unit)
  check('SMB add: Where is the mount point, with no space in it', /^Where=.*\/nas1$/m.test(unit) && !/^Where=.* .*$/m.test(unit), unit)
  check('SMB add: Type=cifs', /^Type=cifs$/m.test(unit))
  for (const o of ['vers=3.1.1', 'cache=strict', 'actimeo=1', 'uid=0', 'gid=900', 'file_mode=0660', 'dir_mode=2770', '_netdev', 'nofail'])
    check(`SMB add: option ${o}`, new RegExp(`^Options=(.*,)?${o.replace(/[.\\]/g, '\\$&')}(,|$)`, 'm').test(unit), unit.split('\n').find((l) => l.startsWith('Options=')))
  check('SMB add: nofail, so a NAS that is off can never hold up the boot', /^Options=.*(^|,)nofail(,|$)/m.test(unit))
  check('SMB add: the unit points at the credentials file, and holds NO password', /^Options=.*credentials=.*\/nas-nas1\.cred/m.test(unit) && !hasPass(unit))
  check('SMB add: the unit is enabled so it comes back after a reboot', a.runs.some((r) => /^systemctl enable .*\.mount$/.test(r)))
  check('SMB add: the folder inside the share is made and the write is proven there', a.runs.some((r) => r === `mkdir -p ${join(a.base, 'srv')}/nas1/CCTV Backup`) && a.runs.some((r) => r.startsWith('verify:') && r.includes('/nas1/CCTV Backup/.cctv-write-test')), JSON.stringify(a.runs))
  const done = a.lines.at(-1)
  check('SMB add: the answer names the recordings folder (with its space) and the mount point', done?.done === true && done.path === `${join(a.base, 'srv')}/nas1/CCTV Backup` && done.mount === `${join(a.base, 'srv')}/nas1` && done.subdir === 'CCTV Backup', JSON.stringify(done))
  check('SMB add: progress steps reported in order', NET_STEPS.filter((s) => s !== 'done').every((s) => a.lines.some((l) => l.step === s)))

  const credName = Object.keys(a.creds)[0]
  const cred = a.creds[credName] ?? ''
  check('SMB add: the credentials file is /etc/cctv/nas-<id>.cred', credName === 'nas-nas1.cred', credName)
  check('SMB add: it holds the user name and the password, and nothing else', cred === `username=cctv\npassword=${PASS}\n`, cred.replace(PASS, '<pass>'))
  const mode = statSync(join(a.credDir, credName)).mode & 0o777
  check('SMB add: the credentials file is 0600 (no group, no other)', (mode & 0o077) === 0, mode.toString(8))
  check('SMB add: the credentials FILE is the only place the password is (not stdout, not a unit)', !hasPass(a.lines) && !hasPass(a.runs) && !hasPass(a.units) && !hasPass(a.stderr), 'a leak!')
  check('SMB add: a DOMAIN\\user is split out into domain=', (dry(['netmount', 'smb', '1.2.3.4', 'Backups', 'nas1', 'add', ''], {}, `WORK\\cctv\n${PASS}\n`).creds['nas-nas1.cred'] ?? '').includes('\ndomain=WORK\n'))

  const n = dry(['netmount', 'nfs', '192.168.0.121', '/export/cctv', 'nas2', 'add', ''], {}, '\n\n')
  const nunit = Object.values(n.units)[0] ?? ''
  check('NFS add: What is <server>:<export>, Type=nfs4', /^What=192\.168\.0\.121:\/export\/cctv$/m.test(nunit) && /^Type=nfs4$/m.test(nunit), nunit)
  for (const o of ['vers=4.1', 'hard', 'timeo=600', 'retrans=2', '_netdev', 'nofail'])
    check(`NFS add: option ${o}`, new RegExp(`^Options=(.*,)?${o.replace(/[.]/g, '\\.')}(,|$)`, 'm').test(nunit), nunit.split('\n').find((l) => l.startsWith('Options=')))
  check('NFS add: no credentials file at all (NFS has no password)', Object.keys(n.creds).length === 0, JSON.stringify(Object.keys(n.creds)))

  const fb = dry(['netmount', 'smb', '1.2.3.4', 'Backups', 'nas1', 'add', ''], { CCTV_DISK_FAKE_MOUNT_FAIL: '3.1.1' })
  check('SMB: 3.1.1 refused -> falls back to 3.0 and says so', fb.code === 0 && /^Options=.*vers=3\.0$/m.test(Object.values(fb.units)[0] ?? '') && fb.lines.at(-1)?.vers === '3.0', JSON.stringify(fb.lines.at(-1)))
  const nofb = dry(['netmount', 'smb', '1.2.3.4', 'Backups', 'nas1', 'add', ''], { CCTV_DISK_FAKE_MOUNT_FAIL: '3.1.1 3.0' })
  check('SMB: no version works -> failure, and everything is undone', nofb.code !== 0 && nofb.lines.some((l) => l.state === 'failed') && nofb.runs.some((r) => r.startsWith('shred -u ')) && nofb.runs.some((r) => /^rm -f .*\.mount$/.test(r)), JSON.stringify(nofb.lines.at(-1)))
  const vf = dry(['netmount', 'smb', '1.2.3.4', 'Backups', 'nas1', 'add', 'CCTV Backup'], { CCTV_DISK_FAKE_VERIFY_FAIL: '1' })
  check('mounted but not writable: reported as a failure, mount and credentials undone', vf.code !== 0 && vf.lines.some((l) => l.step === 'verify' && l.state === 'failed') && vf.runs.some((r) => r.startsWith('shred -u ')), JSON.stringify(vf.lines.at(-1)))
  check('  and the message says what is wrong without naming the password', /written to and read back/.test(vf.lines.at(-1)?.message ?? '') && !hasPass(vf.lines))

  const tm = dry(['netmount', 'smb', '1.2.3.4', 'Backups', 'nas1', 'test', 'CCTV Backup'])
  // (a dry run prints the removals instead of doing them, so the unit file is still on disk here)
  check('test mode: nothing is enabled, and the unit and the credentials file are removed again', tm.code === 0 && !tm.runs.some((r) => /^systemctl enable/.test(r)) && tm.runs.some((r) => r.startsWith('shred -u ')) && tm.runs.some((r) => /^rm -f .*\.mount$/.test(r)) && tm.runs.some((r) => /^systemctl stop /.test(r)), JSON.stringify(tm.runs))
  const um = dry(['netunmount', 'nas1'])
  check('netunmount: stops, disables, removes the unit and shreds the credentials file', um.code === 0 && ['systemctl stop', 'systemctl disable', 'rm -f', 'systemctl daemon-reload', 'shred -u', 'rmdir'].every((c) => um.runs.some((r) => r.startsWith(c))), JSON.stringify(um.runs))

  const dryRefused = (name, args, pattern, stdin) => {
    const r = dry(args, {}, stdin)
    check(`helper refuses: ${name}`, r.code !== 0 && r.runs.length === 0 && r.lines.some((l) => l.state === 'failed' && pattern.test(l.message ?? '')), `${r.code} ${JSON.stringify(r.lines)} ${r.stderr}`)
  }
  dryRefused('a shell command in the server', ['netmount', 'smb', '1.2.3.4;reboot', 'Backups', 'nas1', 'add', ''], /server/i)
  dryRefused('a backtick in the server', ['netmount', 'smb', '1.2.3.4`id`', 'Backups', 'nas1', 'add', ''], /server/i)
  dryRefused('a slash in the SMB share', ['netmount', 'smb', '1.2.3.4', '../../etc', 'nas1', 'add', ''], /share/i)
  dryRefused('a command substitution in the SMB share', ['netmount', 'smb', '1.2.3.4', '$(touch /tmp/pwned)', 'nas1', 'add', ''], /share/i)
  dryRefused('a traversal in the id', ['netmount', 'smb', '1.2.3.4', 'Backups', '../../etc/cctv/x', 'add', ''], /id/i)
  dryRefused('an over-long id', ['netmount', 'smb', '1.2.3.4', 'Backups', 'a'.repeat(33), 'add', ''], /id/i)
  dryRefused('a traversal in the folder', ['netmount', 'smb', '1.2.3.4', 'Backups', 'nas1', 'add', '../../etc'], /folder/i)
  dryRefused('an absolute folder', ['netmount', 'smb', '1.2.3.4', 'Backups', 'nas1', 'add', '/etc'], /folder/i)
  dryRefused('an NFS export with ".."', ['netmount', 'nfs', '1.2.3.4', '/export/../../etc', 'nas1', 'add', ''], /export/i, '\n\n')
  dryRefused('an unknown protocol', ['netmount', 'iscsi', '1.2.3.4', 'Backups', 'nas1', 'add', ''], /smb or nfs/i)
  dryRefused('an unknown mode', ['netmount', 'smb', '1.2.3.4', 'Backups', 'nas1', 'wipe', ''], /mode/i)
  dryRefused('a shell command in the user name', ['netmount', 'smb', '1.2.3.4', 'Backups', 'nas1', 'add', ''], /user name/i, `cctv;id\n${PASS}\n`)
  dryRefused('an over-long password', ['netmount', 'smb', '1.2.3.4', 'Backups', 'nas1', 'add', ''], /password/i, `cctv\n${'x'.repeat(257)}\n`)
  dryRefused('SMB with no user name', ['netmount', 'smb', '1.2.3.4', 'Backups', 'nas1', 'add', ''], /user name/i, `\n${PASS}\n`)
  dryRefused('an odd id on netunmount', ['netunmount', '../x'], /id/i)
  check('a refusal never runs anything and never shows the password', !existsSync('/tmp/pwned'))

  const hsrc = readFileSync(HELPER, 'utf8')
  check('helper source: the password is only ever written by write_cred', (hsrc.match(/\$nas_pass|\$\{nas_pass/g) ?? []).length <= 4 && !/say .*nas_pass|jstr .*nas_pass|echo .*nas_pass/.test(hsrc))
  check('helper source: the password is cleared as soon as the file is written', /nas_pass=''\s*\n\s*say credentials done/.test(hsrc))
  check('helper source: no fstab line for a network share (a systemd .mount unit instead)', !/netmount[\s\S]*?>>\s*\/etc\/fstab/.test(hsrc))
}

// ---- the whole flow against a fake helper socket ----------------------------------------------------
const sockDir = mkdtempSync(join(tmpdir(), 'cctv-net-sock-'))
const calls = []
let replyLines = []
let replyCode = 0
const fake = createServer((sock) => {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (c) => {
    buf += c
    const i = buf.indexOf('\n')
    if (i < 0) return
    calls.push(JSON.parse(buf.slice(0, i)))
    for (const l of replyLines) sock.write(`${l}\n`)
    sock.end(`{"exit":${replyCode}}\n`)
  })
})
const fakePath = join(sockDir, 'helper.sock')
await new Promise((r) => fake.listen(fakePath, r))
_test.setSocket(fakePath)

// a mount point with a space in it, exactly as the real NAS will give
const srv = mkdtempSync(join(tmpdir(), 'cctv-net-srv-'))
const mount = join(srv, 'nas1')
const dataPath = join(mount, 'CCTV Backup')
mkdirSync(dataPath, { recursive: true })
storage._test.setDevOf((p) => (p.startsWith(mount) ? 2 : 1))
_test.setStat(
  (p) => ({ dev: p.startsWith(mount) ? 2 : 1 }),
  () => ({ bavail: 1000n, bsize: 4096n, blocks: 5000n })
)

const jobDone = async () => {
  await _test.running()
  await new Promise((r) => setImmediate(r))
}

// --- test (mount, prove a write, undo) ---
replyLines = [JSON.stringify({ step: 'check', state: 'done' }), 'not json', JSON.stringify({ step: 'verify', state: 'done' }), JSON.stringify({ done: true, path: dataPath, mount, subdir: 'CCTV Backup', id: 'probe', unit: 'srv-x.mount', proto: 'smb', vers: '3.1.1', mode: 'test' })]
const j1 = runShareJob({ ...good, action: 'test' }, 'boss')
check('test: 202-style job starts running', j1.state === 'running' && j1.action === 'test')
check('test: the job object holds no password', !hasPass(j1))
await jobDone()
check('test: the helper was asked with op netmount, mode test, id probe', calls.at(-1)?.op === 'netmount' && calls.at(-1)?.mode === 'test' && calls.at(-1)?.id === 'probe' && calls.at(-1)?.subdir === 'CCTV Backup', JSON.stringify({ ...calls.at(-1), pass: '<pass>' }))
check('test: the password does reach the helper (it has to: only root may hold it)', calls.at(-1)?.pass === PASS)
check('test: the finished job is done, with no location and no share added', netshares.currentJob().state === 'done' && listShares().length === 0)
check('test: bad lines from the helper are ignored', netshares.currentJob().steps.length === 2, JSON.stringify(netshares.currentJob().steps))
check('test: nothing the API answers with holds the password', !hasPass(netshares.currentJob()) && !hasPass(listShares()))

// --- add ---
replyLines = [JSON.stringify({ step: 'mount', state: 'done' }), JSON.stringify({ done: true, path: dataPath, mount, subdir: 'CCTV Backup', id: 'backups', unit: 'srv-cctv\\x2dnet-backups.mount', proto: 'smb', vers: '3.1.1', mode: 'add' })]
runShareJob({ ...good, action: 'add', role: 'main' }, 'boss')
await jobDone()
const job2 = netshares.currentJob()
check('add: the job finished and registered a storage location', job2.state === 'done' && job2.location?.path === dataPath && job2.location.type === 'network' && job2.location.role === 'main', JSON.stringify(job2).slice(0, 300))
check('add: the id is derived from the share name', calls.at(-1)?.id === 'backups' && calls.at(-1)?.mode === 'add')
const shares1 = listShares()
check('add: listed, mounted, with free space and no password field', shares1.length === 1 && shares1[0].mounted === true && shares1[0].freeBytes === 1000 * 4096 && !('pass' in shares1[0]), JSON.stringify(shares1))
check('add: the listed share keeps the folder with its space', shares1[0].path === dataPath && shares1[0].subdir === 'CCTV Backup')
check('add: the storage location is the folder inside the share, not the mount point', storage.listLocations().some((l) => l.path === dataPath && l.type === 'network'))
check('add: the marker file was written inside the folder with the space', existsSync(join(dataPath, '.cctv-recordings')))
check('add: the saved settings hold no password anywhere', !hasPass(settings.getSettings()) && !hasPass(readFileSync(join(process.env.DATA_DIR, 'settings.json'), 'utf8')))
check('add: the same share twice is refused', (() => { try { runShareJob({ ...good, action: 'add', role: 'main' }, 'boss'); return false } catch (e) { return e.status === 409 } })())

// --- not mounted (the NAS is off) ---
_test.setStat(() => ({ dev: 1 }), () => ({ bavail: 0n, bsize: 0n, blocks: 0n }))
const off = listShares()
check('a NAS that is off: listed as not mounted, free space unknown, still no password', off[0].mounted === false && off[0].freeBytes === null && !hasPass(off))
_test.setStat((p) => ({ dev: p.startsWith(mount) ? 2 : 1 }), () => ({ bavail: 1000n, bsize: 4096n, blocks: 5000n }))

// --- remove ---
replyLines = [JSON.stringify({ done: true, path: mount, id: 'backups', unit: 'srv-cctv\\x2dnet-backups.mount' })]
runShareJob({ action: 'remove', id: 'backups' }, 'boss')
await jobDone()
check('remove: the helper was asked to unmount, by id only', calls.at(-1)?.op === 'netunmount' && JSON.stringify(calls.at(-1)) === '{"op":"netunmount","id":"backups"}')
check('remove: gone from the list and from the storage locations', listShares().length === 0 && !storage.listLocations().some((l) => l.path === dataPath))
check('remove: an unknown share is a 404', (() => { try { runShareJob({ action: 'remove', id: 'nope' }, 'boss'); return false } catch (e) { return e.status === 404 } })())
check('remove: an odd id never reaches the helper', (() => { const before = calls.length; try { runShareJob({ action: 'remove', id: '../../etc' }, 'boss') } catch {} return calls.length === before })())

// --- a failing helper ---
replyLines = [JSON.stringify({ step: 'mount', state: 'failed', message: 'the share could not be mounted (wrong name, password, or the NAS is not reachable)' })]
replyCode = 3
runShareJob({ ...good, action: 'add', role: 'main' }, 'boss')
await jobDone()
const bad = netshares.currentJob()
check('a helper failure: the job fails with the message, and nothing is added', bad.state === 'failed' && /could not be mounted/.test(bad.error) && listShares().length === 0, JSON.stringify(bad).slice(0, 200))
check('the failure message never names the password', !hasPass(bad))

// --- the helper service not running ---
replyCode = 0
_test.setSocket(join(sockDir, 'absent.sock'))
runShareJob({ ...good, action: 'test' }, 'boss')
await jobDone()
check('helper socket absent: a clear error naming the disk helper, no crash', netshares.currentJob().state === 'failed' && /disk helper/.test(netshares.currentJob().error), netshares.currentJob().error)
fake.close()

// --- progress ---
check('the steps, in order', JSON.stringify(NET_STEPS) === JSON.stringify(['check', 'credentials', 'unit', 'mount', 'verify', 'done']))
const pr = progressOf({ state: 'running', steps: [{ step: 'check', state: 'done' }, { step: 'credentials', state: 'done' }, { step: 'unit', state: 'start' }] })
check('progress: two of five steps done is 40 %, at the step being worked on', pr.done === 2 && pr.pct === 40 && pr.step === 'unit', JSON.stringify(pr))
check('progress: done is 100 %', progressOf({ state: 'done', steps: [] }).pct === 100)

// ---- one mount job at a time, through the real service on a temp socket -----------------------------
{
  const fakeHelper = join(sockDir, 'fake-helper')
  writeFileSync(fakeHelper, ['#!/bin/bash', 'IFS= read -r u || true', 'IFS= read -r p || true', 'printf \'{"args":"%s","user":"%s","passlen":"%s","env":"%s"}\\n\' "$*" "$u" "${#p}" "$(env | grep -c . )"', '[ "$1" = netmount ] && sleep 1', 'exit 0', ''].join('\n'))
  chmodSync(fakeHelper, 0o755)
  const server = createServer()
  const path = join(sockDir, 'd.sock')
  const st = serve(server, { log: () => {}, helper: fakeHelper, env: { PATH: process.env.PATH } })
  await new Promise((r) => server.listen(path, r))
  const ask = (text) =>
    new Promise((resolve) => {
      let b = ''
      const c = createConnection(path)
      c.setEncoding('utf8')
      c.on('connect', () => c.write(text))
      c.on('data', (d) => (b += d))
      c.on('error', () => resolve({ lines: [] }))
      c.on('close', () => {
        const lines = []
        for (const l of b.split('\n').filter(Boolean)) {
          try {
            lines.push(JSON.parse(l))
          } catch {
            lines.push({ bad: l })
          }
        }
        resolve({ lines, exit: lines.at(-1)?.exit })
      })
    })
  const first = ask(`${JSON.stringify(REQ)}\n`)
  await new Promise((r) => setTimeout(r, 200))
  const busy = await ask(`${JSON.stringify({ ...REQ, id: 'nas2' })}\n`)
  check('service: a second mount job while one runs is refused', busy.exit === 4 && /being mounted/.test(busy.lines[0]?.message ?? ''), JSON.stringify(busy.lines))
  const r1 = await first
  check('service: the helper got the arguments exactly, and the secret only on stdin', r1.exit === 0 && r1.lines[0]?.args === 'netmount smb 192.168.0.121 Backups nas1 add CCTV Backup' && r1.lines[0]?.user === 'cctv' && r1.lines[0]?.passlen === String(PASS.length), JSON.stringify(r1.lines))
  check('service: nothing it streams back holds the password', !hasPass(r1.lines))
  check('service: mount job done -> the next one is accepted', st.mounting() === null)
  const bad2 = await ask('{"op":"netmount","proto":"smb","server":"1.2.3.4;id","share":"a","subdir":"","id":"x","user":"u","pass":"p","mode":"add"}\n')
  check('service: a refused request runs nothing', bad2.exit === 2 && /refused/.test(bad2.lines[0]?.error ?? '') && bad2.lines.length === 2, JSON.stringify(bad2.lines))
  server.close()
}

// ---- the page and the deployment files --------------------------------------------------------------
const ui = readFileSync(new URL('../public/settings.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8')
check('settings page: a Network drive section with protocol, server, share, folder, user, password', ['n-proto', 'n-server', 'n-share', 'n-subdir', 'n-user', 'n-pass', 'n-role'].every((id) => html.includes(`id="${id}"`)))
check('settings page: a Test button and an Add button', html.includes('id="n-test"') && html.includes('id="n-add"'))
check('settings page: mounted state, free space and a Remove per share', /Not mounted/.test(ui) && /gb\(s\.freeBytes\)/.test(ui) && /action: 'remove'/.test(ui))
check('settings page: a real progress bar, as the USB section has', /el\('progress'/.test(ui) && /renderNetJob/.test(ui))
check('settings page: the password field is a password field and is cleared after sending', /id="n-pass" type="password"/.test(html) && /\$\('n-pass'\)\.value = ''/.test(ui))
const svc = readFileSync(new URL('../../deploy/cctv.service', import.meta.url), 'utf8')
check('cctv.service: the app may write under /srv/cctv-net', svc.split('\n').includes('ReadWritePaths=-/srv/cctv-net'))
check('cctv.service: still no capabilities and no loosening', !/AmbientCapabilities|CapabilityBoundingSet|NoNewPrivileges=no/.test(svc))
const inst = readFileSync(new URL('../../deploy/install-ubuntu.sh', import.meta.url), 'utf8')
check('installer: makes /srv/cctv-net and installs cifs-utils and nfs-common', /install -d -m 755 \/srv\/cctv-net/.test(inst) && /cifs-utils nfs-common/.test(inst))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
