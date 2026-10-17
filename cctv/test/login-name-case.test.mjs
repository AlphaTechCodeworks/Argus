// cctv/test/login-name-case.test.mjs
// Sign-in ignores capitals in the user name (auth.accountName); the password stays exact; and an account
// cannot be made whose name differs from another's only in capitals (users-api.mjs).
//   node cctv/test/login-name-case.test.mjs
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-case-'))
const { accountName } = await import('../auth.mjs')
let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const users = { mike: {}, 'Ann.Smith': {}, 'Bob@site': {} }
check('exact name: itself', accountName('mike', users) === 'mike')
check('other capitals: the account', accountName('Mike', users) === 'mike' && accountName('MIKE', users) === 'mike')
check('mixed-case account typed lower', accountName('ann.smith', users) === 'Ann.Smith')
check('spaces around it are ignored', accountName('  Mike ', users) === 'mike')
check('no such account: as typed', accountName('Nobody', users) === 'Nobody')
check('not a prototype name', accountName('Constructor', users) === 'Constructor' && accountName('__proto__', users) === '__proto__')
const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
check('server.mjs: the login looks the name up with accountName', /const user = auth\.accountName\(String\(creds\.user \?\? ''\)\)/.test(server))
const api = readFileSync(new URL('../users-api.mjs', import.meta.url), 'utf8')
check('users-api.mjs: a name differing only in capitals is refused', /u\.toLowerCase\(\) === name\.toLowerCase\(\)/.test(api) && /do not depend on capitals/.test(api))
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
