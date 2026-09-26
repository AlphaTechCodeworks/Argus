// Tests that a network share is checked from another process, and that a share which never answers
// cannot hold up the server (storage.mjs, location-probe.mjs).
//   node cctv/test/share-probe.test.mjs
// The case it exists for, 2026-09-26: the server froze twice inside one file call to a NAS whose SMB
// session had gone stale.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = mkdtempSync(join(tmpdir(), 'cctv-share-'))
process.env.CCTV_DATA = base
const storage = await import('../storage.mjs')
const { SHARE_ANSWER_MS, _test } = storage

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

// a share that answers: a folder with its marker
const good = join(base, 'share')
const { mkdirSync } = await import('node:fs')
mkdirSync(good)
writeFileSync(join(good, storage.MARKER), JSON.stringify({ id: 'loc-good' }))
{
  const h = await _test.probeShare({ id: 'loc-good', path: good }, 0, false)
  check('a share that answers is healthy, checked from another process', h.ok === true && h.marker === true, JSON.stringify(h))
}
{
  const h = await _test.probeShare({ id: 'loc-gone', path: join(base, 'nope') }, 0, false)
  check('a share that is not there is down, with the reason', h.ok === false && /missing/.test(h.reason), h.reason)
}

// a share that never answers: the probe hangs like a call into a stale SMB session
const hang = join(base, 'hang.mjs')
writeFileSync(hang, 'setInterval(() => {}, 1000)\n')
_test.setProbe(hang)
{
  const t0 = Date.now()
  let ticks = 0
  const iv = setInterval(() => ticks++, 100)
  const h = await _test.probeShare({ id: 'loc-stuck', path: good }, 0, false)
  clearInterval(iv)
  const took = Date.now() - t0
  check('a share that never answers is called down', h.ok === false && /not answering/.test(h.reason), h.reason)
  check('within the answer time, not forever', took < SHARE_ANSWER_MS + 2000, `${took} ms`)
  check('and the server kept running meanwhile', ticks > (SHARE_ANSWER_MS / 100) * 0.8, `${ticks} timer ticks`)
}

// listLocations never touches a share: its health is whatever the last check said
_test.setShareHealth('loc-x', { ok: false, reason: 'share not answering', marker: false })
check('markerMatches for a share uses the last check, not the share', storage.markerMatches({ id: 'loc-x', type: 'network', path: '/nowhere' }) === false)
_test.setShareHealth('loc-x', { ok: true, reason: '', marker: true })
check('and says yes once a check found the marker', storage.markerMatches({ id: 'loc-x', type: 'network', path: '/nowhere' }) === true)

rmSync(base, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
