// Which session an XML command would go out on (xml-session.mjs): an Nvr answers for itself
// (xmlOnline / xmlDegraded / xmlGen: the control login, or the worker's while borrowing); an object
// that does not know about borrowing, like the stand-ins in the settings tests, is judged by its
// plain online / degraded / gen. No SDK is loaded.
// Run:  node cctv/test/xml-session.test.mjs
import { readFileSync } from 'node:fs'
import { xmlDegraded, xmlGen, xmlOnline } from '../xml-session.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const plain = { online: true, degraded: false, gen: 3 }
check('a plain object: its own online', xmlOnline(plain) === true && xmlOnline({ online: false }) === false)
check('a plain object: its own degraded', xmlDegraded(plain) === false && xmlDegraded({ degraded: true }) === true)
check('a plain object: its own gen', xmlGen(plain) === 3)

const borrowing = { online: false, degraded: true, gen: 3, xmlOnline: true, xmlDegraded: false, xmlGen: 'worker:111:4' }
check('an NVR that borrows: online for XML though its control login is down', xmlOnline(borrowing) === true)
check('an NVR that borrows: not degraded though its control login is', xmlDegraded(borrowing) === false)
check("an NVR that borrows: the worker's session", xmlGen(borrowing) === 'worker:111:4')

const down = { online: false, degraded: true, gen: 3, xmlOnline: false, xmlDegraded: true, xmlGen: 'own:3' }
check('an NVR that cannot borrow: offline', xmlOnline(down) === false && xmlDegraded(down) === true && xmlGen(down) === 'own:3')
check('nothing at all: offline, not a throw', xmlOnline(undefined) === false && xmlDegraded(null) === false && xmlGen(undefined) === undefined)

// alarm-watch.mjs and the modules handed `transparent` must be able to import this without the SDK
const src = readFileSync(new URL('../xml-session.mjs', import.meta.url), 'utf8')
check('the module imports nothing', !/^\s*import\s/m.test(src))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
