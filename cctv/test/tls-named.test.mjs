// The real certificates the HTTPS listener can answer with, chosen by the name the browser asks for
// (tls.mjs): the tailnet name's, and any more in folders beside it, such as the public name's once
// the office reaches the server directly. The self-signed one stays the default for everything else.
//   node cctv/test/tls-named.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tls-named-'))
const { contextFor, namedCertFiles } = await import('../tls.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const D = join('x', 'named')
const dir = (name) => ({ name, isDirectory: () => true })
const file = (name) => ({ name, isDirectory: () => false })
const fsOf = (files, entries) => ({ exists: (p) => files.has(p), list: () => entries })
const P = (...parts) => join(D, ...parts)

{
  const files = new Set([P('cert.pem'), P('key.pem')])
  const got = namedCertFiles(D, fsOf(files, [file('cert.pem'), file('key.pem')]))
  check('the one certificate there has always been is still found, alone', got.length === 1 && got[0].cert === P('cert.pem') && got[0].key === P('key.pem'))
}
{
  const files = new Set([P('cert.pem'), P('key.pem'), P('public', 'cert.pem'), P('public', 'key.pem'), P('half', 'cert.pem')])
  const got = namedCertFiles(D, fsOf(files, [file('cert.pem'), dir('public'), dir('half'), dir('empty'), file('key.pem')]))
  check('a folder beside it with both files is another certificate', got.length === 2 && got[1].cert === P('public', 'cert.pem') && got[1].key === P('public', 'key.pem'), JSON.stringify(got))
  check('a folder with only one of the two files is left out', !got.some((g) => g.cert.includes('half')))
}
{
  const files = new Set([P('b', 'cert.pem'), P('b', 'key.pem'), P('a', 'cert.pem'), P('a', 'key.pem')])
  const got = namedCertFiles(D, fsOf(files, [dir('b'), dir('a')]))
  check('folders alone, with no certificate at the top: both, in name order', got.length === 2 && got[0].cert === P('a', 'cert.pem') && got[1].cert === P('b', 'cert.pem'))
}
check('no folder at all: none (the self-signed certificate serves)', namedCertFiles(D, { exists: () => false, list: () => { throw new Error('ENOENT') } }).length === 0)

{
  const tail = { context: 'TAIL', names: ['cctv.tayra-hue.ts.net'] }
  const pub = { context: 'PUBLIC', names: ['cctv.jfl.gripe'] }
  const certs = [tail, pub]
  check('each name gets its own certificate', contextFor('cctv.tayra-hue.ts.net', certs) === 'TAIL' && contextFor('cctv.jfl.gripe', certs) === 'PUBLIC')
  check('the name is matched whatever its case', contextFor('CCTV.JFL.Gripe', certs) === 'PUBLIC')
  check('any other name, an address, or none: the default (self-signed) certificate', contextFor('192.168.1.232', certs) === undefined && contextFor('other.example', certs) === undefined && contextFor(undefined, certs) === undefined && contextFor('', certs) === undefined)
  check('two certificates for one name: the first answers', contextFor('cctv.jfl.gripe', [{ context: 'ONE', names: ['cctv.jfl.gripe'] }, pub]) === 'ONE')
  check('no real certificate at all: the default', contextFor('cctv.jfl.gripe', []) === undefined)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exitCode = failures ? 1 : 0
