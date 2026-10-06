// A stream that stalls inside the live worker (CCTV_LIVE_WORKER=on) is restarted by the worker
// itself: StopLivePlay then LivePlay, and frames flow again. Before the fix nothing in the worker
// ran Nvr.checkStalled(), so a stalled NVR stream left a hole until the NVR recovered by itself.
// Fake SDK only (test/fake-sdk.mjs), hosts *.invalid: nothing reaches an NVR.
// Run:  node cctv/test/nvr-worker-stall.test.mjs
import { fork } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const until = async (pred, ms = 8000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)); return pred() }

const data = mkdtempSync(join(tmpdir(), 'cctv-stall-'))
writeFileSync(join(data, 'nvrs.json'), JSON.stringify({ nvrs: [{ id: 'w1', site: 'T', name: 'W1', host: 'w1.invalid', port: 6036, user: 'u', password: 'p' }] }))

const child = fork(new URL('../nvr-worker.mjs', import.meta.url), [], {
  serialization: 'advanced',
  stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  env: { ...process.env, DATA_DIR: data, CCTV_WORKER_NVR: 'w1', CCTV_WORKER_FAKE_SDK: '1', CCTV_FAKE_STALL_AFTER_FRAMES: '30', CCTV_FAKE_LOG_CALLS: '1', CCTV_TEST_STALL_MS: '1500', CCTV_TEST_STALL_CHECK_MS: '300' }
})
let out = ''
child.stdout.on('data', (d) => (out += d))
const frames = []
child.on('message', (m) => m?.t === 'frame' && frames.push(Date.now()))
let ready = false
child.on('message', (m) => m?.t === 'ready' && (ready = true))
check('worker ready', await until(() => ready))
child.send({ t: 'want', ch: 0, type: 0 })
check('frames arrive', await until(() => frames.length >= 20))
// the fake stream stops after 30 frames (1.2 s); the handle stays open
await until(() => frames.length >= 30)
const stalledAt = Date.now()
check('stalled stream is restarted by the worker', await until(() => /stalled, restarting/.test(out), 6000), out.split('\n').filter(Boolean).slice(-4).join(' | '))
const callsNow = () => out.split('\n').filter((l) => l.startsWith('[fake-sdk] ')).map((l) => l.slice(11).split(' ')[0]) // (LivePlay lines also name the stream)
await until(() => callsNow().filter((c) => c === 'LivePlay').length >= 2, 10_000) // after the restart back-off
const calls = callsNow()
const stopIdx = calls.indexOf('StopLivePlay')
check('StopLivePlay then LivePlay, once', calls.filter((c) => c === 'StopLivePlay').length === 1 && calls.lastIndexOf('LivePlay') > stopIdx && stopIdx > 0, calls.join(','))
check('frames flow again after the restart', await until(() => frames.some((t) => t > stalledAt + 500) && frames.length >= 40, 5000), `${frames.length}`)
child.send({ t: 'stop' })
check('worker exits on stop', await until(() => child.exitCode !== null || child.signalCode !== null))
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
