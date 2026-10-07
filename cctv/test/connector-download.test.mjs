// Tests for connector-download.mjs: the Settings > Remote sites installer status and download.
// A .zip is preferred over a bare .exe (Chrome blocks unsigned .exe downloads). SDK-free, runs anywhere.
//   node cctv/test/connector-download.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

// point DATA_DIR somewhere harmless before the module (via auth.mjs) reads it at import
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'conn-data-'))
const { statusOf, sendInstaller } = await import('../connector-download.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

/** A stand-in for the HTTP response: records writeHead, collects the body, and is a pipe target. */
class MockRes extends Writable {
  constructor() {
    super()
    this.chunks = []
    this.status = 0
    this.headers = {}
  }
  writeHead(status, headers) {
    this.status = status
    this.headers = headers || {}
    return this
  }
  _write(chunk, _enc, cb) {
    this.chunks.push(Buffer.from(chunk))
    cb()
  }
  body() {
    return Buffer.concat(this.chunks)
  }
}
const piped = (res) => new Promise((r) => res.on('finish', r).on('close', r))

const dir = mkdtempSync(join(tmpdir(), 'conn-'))
mkdirSync(join(dir, 'connector'), { recursive: true })
const connDir = join(dir, 'connector')
const exe = join(connDir, 'NvrSiteConnector-Setup.exe')
const zip = join(connDir, 'NvrSiteConnector-Setup.zip')

const download = async (d) => {
  const res = new MockRes()
  sendInstaller(res, d)
  await piped(res)
  return res
}

// ---- nothing placed ----
check('status of an empty connector dir is "not available"', JSON.stringify(statusOf(connDir)) === JSON.stringify({ available: false }))
{
  const res = await download(connDir)
  check('download when none is placed: 404 JSON saying so', res.status === 404 && res.headers['content-type'] === 'application/json' && /No installer has been uploaded/.test(res.body().toString()), `${res.status}`)
}

// ---- only a bare .exe (fallback) ----
const exeBytes = Buffer.alloc(2048, 7)
writeFileSync(exe, exeBytes)
{
  const s = statusOf(connDir)
  check('exe only: available, reported as the .exe with its size', s.available === true && s.name === 'NvrSiteConnector-Setup.exe' && s.bytes === 2048, JSON.stringify(s))
  const res = await download(connDir)
  check('exe only: served as octet-stream attachment, byte-exact', res.status === 200 && res.headers['content-type'] === 'application/octet-stream' && /filename="NvrSiteConnector-Setup\.exe"/.test(res.headers['content-disposition'] ?? '') && res.body().equals(exeBytes), JSON.stringify(res.headers))
}

// ---- a .zip present: preferred over the .exe, served as application/zip ----
const zipBytes = Buffer.from('PK\u0003\u0004 pretend-zip')
writeFileSync(zip, zipBytes)
{
  const s = statusOf(connDir)
  check('zip present: it is preferred over the exe', s.available === true && s.name === 'NvrSiteConnector-Setup.zip' && s.bytes === zipBytes.length, JSON.stringify(s))
  const res = await download(connDir)
  check('zip present: served as application/zip attachment, byte-exact', res.status === 200 && res.headers['content-type'] === 'application/zip' && /filename="NvrSiteConnector-Setup\.zip"/.test(res.headers['content-disposition'] ?? '') && res.body().equals(zipBytes), JSON.stringify(res.headers))
}

rmSync(dir, { recursive: true, force: true })
rmSync(process.env.DATA_DIR, { recursive: true, force: true })
console.log(`\n${failures ? `${failures} failed` : 'all passed'}`)
process.exit(failures ? 1 : 0)
