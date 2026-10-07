// Tests for connector-download.mjs: the Settings > Remote sites installer status and download.
// SDK-free, runs anywhere.  node cctv/test/connector-download.test.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

// point DATA_DIR somewhere harmless before the module (via auth.mjs) reads it at import
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'conn-data-'))
const { statusOf, sendInstaller, INSTALLER_PATH } = await import('../connector-download.mjs')

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
    this.destroyedByUs = false
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
const exe = join(dir, 'NvrSiteConnector-Setup.exe')

// ---- status ----
check('INSTALLER_PATH is under DATA_DIR/connector and keeps the setup name', INSTALLER_PATH.replace(/\\/g, '/').endsWith('/connector/NvrSiteConnector-Setup.exe'), INSTALLER_PATH)
check('status of a missing installer is "not available"', JSON.stringify(statusOf(exe)) === JSON.stringify({ available: false }))

const bytes = Buffer.alloc(2048, 7)
writeFileSync(exe, bytes)
const s = statusOf(exe)
check('status of a present installer: available, with its size, mtime and name', s.available === true && s.bytes === 2048 && typeof s.mtime === 'number' && s.name === 'NvrSiteConnector-Setup.exe', JSON.stringify(s))

// ---- download, present ----
{
  const res = new MockRes()
  sendInstaller(res, exe)
  await piped(res)
  check('download of a present installer: 200, octet-stream, attachment, right length', res.status === 200 && res.headers['content-type'] === 'application/octet-stream' && res.headers['content-length'] === 2048 && /attachment; filename="NvrSiteConnector-Setup\.exe"/.test(res.headers['content-disposition'] ?? ''), JSON.stringify(res.headers))
  check('download of a present installer: the body is the file, byte for byte', res.body().equals(bytes), `${res.body().length} bytes`)
}

// ---- download, missing ----
{
  const res = new MockRes()
  sendInstaller(res, join(dir, 'nope.exe'))
  await piped(res)
  check('download when none is placed: 404 JSON saying so, no file streamed', res.status === 404 && res.headers['content-type'] === 'application/json' && /No installer has been uploaded/.test(res.body().toString()), `${res.status} ${res.body().toString().slice(0, 80)}`)
}

rmSync(dir, { recursive: true, force: true })
rmSync(process.env.DATA_DIR, { recursive: true, force: true })
console.log(`\n${failures ? `${failures} failed` : 'all passed'}`)
process.exit(failures ? 1 : 0)
