// LiveStream start failures: a start the NVR refuses at once is marked fast (lastFailure.fast) and
// logged with the SDK's last error; a start that gets a valid handle but no video within 8 s
// (nvr-2 refuses silently) is treated as refused: stopped, marked, retried on the back-off.
// Fake SDK functions and a fake NVR object: nothing reaches an NVR.
// Run:  node cctv/test/live-refusal.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'refusal-'))
process.env.CCTV_WORKER_FAKE_SDK = '1'
process.env.CCTV_TEST_FIRST_FRAME_MS = '400'
const { NET_SDK, liveFrames, FRAME_TYPE_VIDEO } = await import('../sdk.mjs')
const { Lane } = await import('../lanes.mjs')

const print = console.log.bind(console)
const out = []
console.log = (...a) => out.push(a.join(' '))
console.warn = (...a) => out.push(a.join(' '))
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  print(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const until = async (cond, maxMs) => {
  for (const end = Date.now() + maxMs; Date.now() < end; await sleep(25)) if (cond()) return true
  return cond()
}

const log = []
let nextHandle = 500
const feeding = new Set([7]) // channels whose handle delivers video
const handleCh = new Map()
const answers = {
  GetLastError: () => 31, // NET_SDK_DVR_NORESOURCE
  LivePlay: (userId, info) => {
    log.push({ fn: 'LivePlay', ch: info.lChannel })
    if (info.lChannel === 5) return -1 // refused at once
    const h = nextHandle++
    handleCh.set(h, info.lChannel)
    return h
  },
  StopLivePlay: (h) => {
    log.push({ fn: 'StopLivePlay', ch: handleCh.get(h) })
    return true
  }
}
for (const name of Object.keys(NET_SDK)) {
  const answer = answers[name] ?? (() => true)
  NET_SDK[name] = {
    fake: true,
    async(...args) {
      const cb = args.at(-1)
      setTimeout(() => cb(null, answer(...args.slice(0, -1))), 5)
    }
  }
}
if (!Object.values(NET_SDK).every((f) => f.fake)) throw new Error('the SDK is not fully faked: not running')
const realClaim = liveFrames.claim.bind(liveFrames)
const timers = []
liveFrames.claim = (h, fn) => {
  realClaim(h, fn)
  if (!feeding.has(handleCh.get(h))) return
  let n = 0
  const t = setInterval(() => {
    const key = n++ % 25 === 0
    fn({ frameType: FRAME_TYPE_VIDEO, length: 16, keyFrame: key ? 1 : 0, width: 64, height: 36, time: Date.now() * 1000 }, Buffer.alloc(16, 1))
  }, 40)
  t.unref()
  timers.push(t)
}

const { LiveStream } = await import('../live.mjs')
const nvr = {
  id: 'fake',
  userId: 3,
  lane: new Lane('fake', 2),
  failed: 0,
  liveFailed() {
    this.failed++
    return Promise.resolve()
  },
  liveStarted() {},
  streamStopped() {},
  noteCodec() {}
}
const ws = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, send() {} })

const refused = new LiveStream(nvr, 5, 0)
refused.add(ws())
check('fast refusal: lastFailure marked fast', await until(() => refused.lastFailure?.fast === true, 3000), JSON.stringify(refused.lastFailure))
check('fast refusal: the reason carries the SDK error', /refused/.test(refused.lastFailure?.reason ?? '') && /error 31|no resource|31/.test(refused.lastFailure?.reason ?? ''), refused.lastFailure?.reason)
// (31 has a text now, sdk.mjs errorText: "NVR has no resources left")
check('fast refusal: the log says why', out.some((l) => l.includes('fake/6:main failed to start') && /31|no resource/.test(l)), out.filter((l) => l.includes('fake/6')).join(' | '))

const silent = new LiveStream(nvr, 6, 0)
silent.add(ws())
check('silent: plays first', await until(() => silent.state === 'playing', 2000))
check('silent: no video in the first-frame window -> refused', await until(() => silent.lastFailure?.silent === true && silent.lastFailure.fast === true, 3000), JSON.stringify(silent.lastFailure))
check('silent: its handle is stopped and a restart is scheduled', await until(() => log.some((c) => c.fn === 'StopLivePlay' && c.ch === 6), 2000) && silent.state === 'restarting')
check('silent: logged', out.some((l) => l.includes('fake/7:main') && /no video/.test(l)))

const good = new LiveStream(nvr, 7, 0)
good.add(ws())
await sleep(900)
check('a stream with video: no failure', good.state === 'playing' && good.lastFailure == null, JSON.stringify(good.lastFailure))

for (const s of [refused, silent, good]) await s.stop()
for (const t of timers) clearInterval(t)
print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
