// deploy/cctv.service restart back-off and the installer's journald size cap. Reads the files;
// in the lab it also runs `bash -n` on the installer and `systemd-analyze verify` on the unit
// (when present). Nothing is installed, started or restarted.
// Run:  node cctv/test/service-unit.test.mjs   (from the release folder: ../deploy next to cctv/)
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const deploy = ['../../deploy', '../deploy'].map((p) => new URL(`${p}/`, import.meta.url)).find((u) => existsSync(new URL('cctv.service', u)))
if (!deploy) {
  console.log('SKIP  deploy/ not found next to cctv/')
  process.exit(0)
}
const unit = readFileSync(new URL('cctv.service', deploy), 'utf8')
const section = (name) => (unit.split(/^\[/m).find((s) => s.startsWith(`${name}]`)) ?? '')
const key = (sec, k) => section(sec).match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim()

check('first restart still quick (RestartSec=2)', key('Service', 'Restart') === 'always' && key('Service', 'RestartSec') === '2')
check('restart delay rises: RestartSteps and RestartMaxDelaySec (60 s)', Number(key('Service', 'RestartSteps')) >= 3 && key('Service', 'RestartMaxDelaySec') === '60')
const burst = Number(key('Unit', 'StartLimitBurst'))
const interval = key('Unit', 'StartLimitIntervalSec')
check('a start limit in [Unit] (StartLimitIntervalSec / StartLimitBurst)', Boolean(interval) && interval !== '0' && burst > 5, `${interval} ${burst}`)
check('the start limit is not in [Service] (ignored there)', !/^StartLimit/m.test(section('Service')))

const inst = readFileSync(new URL('install-ubuntu.sh', deploy), 'utf8')
check('installer: journald drop-in with a size cap', /journald\.conf\.d\/cctv\.conf/.test(inst) && /SystemMaxUse=1G/.test(inst) && /SystemMaxFileSize=64M/.test(inst) && /MaxRetentionSec=/.test(inst))
check("installer: an admin's own journald drop-in is not overwritten", /\[ -e "?\$jconf"? \]|\[ ! -e "?\$jconf"? \]|-e \/etc\/systemd\/journald\.conf\.d\/cctv\.conf/.test(inst))
check('installer: journald picks it up (restart of systemd-journald, not of cctv)', /systemctl restart systemd-journald/.test(inst))
const bashN = spawnSync('bash', ['-n', new URL('install-ubuntu.sh', deploy).pathname])
check('installer: bash -n', bashN.status === 0, String(bashN.stderr))

// systemd-analyze verify (lab): no unknown keys
const sa = spawnSync('sh', ['-c', 'command -v systemd-analyze'])
if (sa.status !== 0) console.log('SKIP  systemd-analyze not installed')
else {
  const d = mkdtempSync(join(tmpdir(), 'unit-'))
  const f = join(d, 'cctv-verify.service')
  writeFileSync(f, unit)
  const r = spawnSync('systemd-analyze', ['verify', f], { encoding: 'utf8' })
  const out = `${r.stdout}${r.stderr}`
  check('systemd-analyze: no unknown or misplaced keys', !/Unknown key|Unknown section|not valid|Invalid/i.test(out), out.split('\n').filter((l) => /Unknown|Invalid|valid/.test(l)).join(' | '))
  try {
    execFileSync('rm', ['-rf', d])
  } catch {}
}
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
