// Settings > Server > Reboot the machine: the app side (machine-reboot.mjs). It says why it will
// not, and only ever writes the request whole (renamed into place).
//   node cctv/test/machine-reboot.test.mjs
import { MIN_UPTIME_S, ROOT_SIDE, requestReboot } from '../machine-reboot.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const io = () => {
  const ops = []
  return { ops, write: (p) => ops.push(['write', p]), rename: (a, b) => ops.push(['rename', a, b]) }
}
{
  const x = io()
  const r = requestReboot({ dataDir: '/d', upSeconds: 1000, exists: () => false, ...x })
  check('machine side not installed: 501, nothing written', r.status === 501 && /not set up/.test(r.body.error) && x.ops.length === 0)
}
{
  const x = io()
  const r = requestReboot({ dataDir: '/d', upSeconds: 120, exists: (p) => p === ROOT_SIDE, ...x })
  check('within 5 minutes of a boot: 409 with how long to wait, nothing written', r.status === 409 && /180 s/.test(r.body.error) && x.ops.length === 0, r.body.error)
}
{
  const x = io()
  const r = requestReboot({ dataDir: '/d', upSeconds: MIN_UPTIME_S + 1, exists: (p) => p === ROOT_SIDE, ...x })
  check('otherwise: 200, the request written whole then renamed into place', r.status === 200 && x.ops.length === 2 && x.ops[0][0] === 'write' && /reboot-request\.tmp$/.test(x.ops[0][1]) && x.ops[1][0] === 'rename' && /reboot-request$/.test(x.ops[1][2]), JSON.stringify(x.ops))
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
