// Set-up codes (setup-codes.mjs): one use, a time limit, only the hash kept. Plain node, no server.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODE_TTL_MS, makeSetupCodes, setupLink } from '../setup-codes.mjs'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

const dir = mkdtempSync(join(tmpdir(), 'setup-codes-'))
const file = join(dir, 'setup-codes.json')
let t = 1_000_000
const codes = makeSetupCodes(file, { now: () => t })

const a = codes.create('alice', 'boss')
check('a code is 32 url-safe characters', /^[A-Za-z0-9_-]{32}$/.test(a.code), a.code.length)
check('it lasts CODE_TTL_MS', a.expires === t + CODE_TTL_MS)
check('the file holds its hash, never the code', !readFileSync(file, 'utf8').includes(a.code) && /"hash":"[0-9a-f]{64}"/.test(readFileSync(file, 'utf8')))
check('one is waiting for alice', codes.pending('alice') === 1 && codes.pending('bob') === 0)
check('a wrong code is nobody', codes.redeem('x'.repeat(32)) === null && codes.redeem('') === null && codes.redeem(undefined) === null)
check('...and does not use up the real one', codes.pending('alice') === 1)
const who = codes.redeem(a.code)
check('the code signs in its account', who?.user === 'alice' && who.by === 'boss')
check('only once', codes.redeem(a.code) === null && codes.pending('alice') === 0)

const b1 = codes.create('bob', 'boss')
const b2 = codes.create('bob', 'boss')
check('a new code cancels the account\'s earlier one', codes.redeem(b1.code) === null && codes.pending('bob') === 1)
check('...and works itself', codes.redeem(b2.code)?.user === 'bob')

const c = codes.create('carol', 'boss')
t += CODE_TTL_MS + 1
check('too old is refused', codes.redeem(c.code) === null)

t += 10
const d = codes.create('dave', 'boss')
codes.forget('dave')
check('forgotten with its account', codes.redeem(d.code) === null)

const e1 = codes.create('erin', 'boss')
const again = makeSetupCodes(file, { now: () => t })
check('kept across a restart', again.redeem(e1.code)?.user === 'erin')

check('the link: the set-up page, the code after the #', setupLink('https://cctv.example.com/', 'abc') === 'https://cctv.example.com/setup.html#c=abc')

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `${failed} FAILED` : 'all passed')
process.exitCode = failed ? 1 : 0
