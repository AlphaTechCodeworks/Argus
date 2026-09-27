// XML calls from the UI (nvr-xml.mjs transparent) in the main process: one in flight in the whole
// process, each starting once the previous one returned and at least 250 ms after it started; at
// most 10 waiting, and a
// read beyond that answered "busy" at once; a per-NVR read breaker (2 reads in a row past their
// time limit: that NVR's reads refused for 60 s, other NVRs carry on, changes still go). The
// picture-settings survey (87 reads) ran through 04:11 next to the call that got the service
// restarted: the SDK runs one call at a time for every NVR, so a burst only queues inside it.
// A call waiting for its NVR's lane (held while that NVR has late calls) does not hold up the
// other NVRs' XML calls: it takes its process-wide turn only once the lane runs it.
// The native call is replaced (nvr-xml.mjs _test.setCall); the breaker has a fake clock. Nothing
// reaches an NVR.
// Needs the Linux SDK library (sdk.mjs loads it through koffi):  node cctv/test/nvr-xml.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'nvr-xml-'))
process.env.UV_THREADPOOL_SIZE = '64'
process.env.SDK_COOL_MS = '100' // a late read cools its NVR (not used by XML calls); keep it short
const { lateCalls, sdkCallT, sdkStuck } = await import('../sdk.mjs')
const { Lane } = await import('../lanes.mjs')
const { HttpError, _test, isReadCommand, transparent, xmlSettled } = await import('../nvr-xml.mjs')

const print = console.log.bind(console)
const out = []
console.warn = (...a) => out.push(a.join(' '))
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  print(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const fakeNvr = (id) => ({ id, name: `NVR ${id}`, online: true, userId: 7, gen: 1, stopped: false, lane: { run: (task) => Promise.resolve().then(task) } })
const [a, b, c] = ['xa', 'xb', 'xc'].map(fakeNvr)
const answer = (outBuf, len) => {
  const x = Buffer.from('<?xml version="1.0"?><response><status>success</status></response>')
  x.copy(outBuf)
  len.writeUInt32LE(x.length)
  return true
}

check('reads are told from changes by the command name', isReadCommand('queryChlVideoParam') && isReadCommand('getAlarmOutStatus') && isReadCommand('searchSmartTarget') && !isReadCommand('editChlVideoParam') && !isReadCommand('editCameraLensCtrlParam'))

// ---- 20 reads at once on 3 NVRs
{
  const log = [] // { nvr, start, end }
  let inFlight = 0
  let peak = 0
  _test.setCall(async (opts, _userId, _xml, _url, outBuf, _size, len) => {
    const e = { nvr: opts.nvr, start: Date.now(), end: 0 }
    log.push(e)
    peak = Math.max(peak, ++inFlight)
    await sleep(30)
    inFlight--
    e.end = Date.now()
    return answer(outBuf, len)
  })
  const t0 = Date.now()
  const settled = await Promise.all(Array.from({ length: 20 }, (_, i) => {
    const p = transparent([a, b, c][i % 3], 'queryChlVideoParam', '<x/>', `read ${i}`)
    return p.then((x) => ({ ok: true, x, at: Date.now() - t0 }), (e) => ({ ok: false, e, at: Date.now() - t0 }))
  }))
  const served = settled.filter((r) => r.ok)
  const busy = settled.filter((r) => !r.ok)
  check('never 2 XML calls in flight in the process', peak === 1, `peak ${peak}`)
  check('one in flight plus 10 waiting are served, in order', served.length === 11 && log.length === 11, `${served.length} served, ${log.length} calls`)
  check('the other 9 are answered busy at once (503, nothing sent)', busy.length === 9 && busy.every((r) => r.e instanceof HttpError && r.e.status === 503 && r.e.extra?.retryAfterS > 0 && r.at < 50), busy.map((r) => `${r.e?.status}@${r.at}`).join(' '))
  const apart = log.slice(1).map((e, i) => e.start - log[i].start)
  check('each starts at least 250 ms after the previous one started', apart.every((g) => g >= 245), apart.join(','))
  check('... and only after it returned', log.slice(1).every((e, i) => e.start >= log[i].end))
  check('... across NVRs (xa, xb, xc take turns)', new Set(log.map((e) => e.nvr)).size === 3)
  check('the queue is empty afterwards', await xmlSettled(a, 1000) && await xmlSettled(b, 1000) && await xmlSettled(c, 1000))
}

// ---- a change is never turned away by the queue length
{
  let calls = 0
  _test.setCall(async (_opts, _u, _x, _url, outBuf, _s, len) => {
    calls++
    await sleep(20)
    return answer(outBuf, len)
  })
  const reads = Array.from({ length: 11 }, (_, i) => transparent(a, 'queryX', '<x/>', `r${i}`).catch((e) => e))
  const extraRead = await transparent(b, 'queryX', '<x/>', 'one too many').catch((e) => e)
  const change = transparent(b, 'editChlVideoParam', '<x/>', 'a change')
  check('with 10 waiting, another read is busy', extraRead instanceof HttpError && extraRead.status === 503)
  const done = await change.catch((e) => e)
  await Promise.all(reads)
  check('... but a change still queues and goes out', typeof done === 'string' && calls === 12, `${done?.message ?? 'ok'}, ${calls} calls`)
}

// ---- the per-NVR read breaker (fake clock)
{
  let clock = Date.UTC(2026, 8, 27, 4, 11, 0)
  _test.setNow(() => clock)
  const sent = []
  // xa's reads come back 150 ms after an 50 ms time limit; everything else answers at once
  const late = (ms) => ({ async: (...args) => setTimeout(() => args.at(-1)(null, true), ms) })
  _test.setCall((opts, userId, xml, url, outBuf, size, len) => {
    sent.push(`${opts.nvr} ${url}`)
    if (opts.nvr === 'xa' && url.startsWith('query')) return sdkCallT({ ...opts, timeoutMs: 50 }, late(150), userId, xml, url, outBuf, size, len)
    return Promise.resolve(answer(outBuf, len))
  })
  // (each read waits for the one before to come back: while one is past its limit with nothing
  // back since, the SDK counts as stuck and every XML call is refused, which is tested elsewhere)
  const first = await transparent(a, 'queryChlVideoParam', '<x/>', 'r1').catch((e) => e)
  await sleep(200)
  const second = await transparent(a, 'queryChlVideoParam', '<x/>', 'r2').catch((e) => e)
  await sleep(200)
  check('two reads in a row run past their time limit', first?.name === 'SdkTimeout' && second?.name === 'SdkTimeout', `${first?.name} ${second?.name}`)
  check('... and the breaker is logged', out.some((l) => l.includes('[xa]') && l.includes('no reads to this NVR for 60 s')), out.join(' | '))
  const n = sent.length
  const refused = await transparent(a, 'queryChlVideoParam', '<x/>', 'r3').catch((e) => e)
  check('that NVR’s next read is refused at once (503), nothing sent', refused instanceof HttpError && refused.status === 503 && refused.extra?.retryAfterS === 60 && sent.length === n, `${refused?.status} ${refused?.message}`)
  const other = await transparent(b, 'queryChlVideoParam', '<x/>', 'other').catch((e) => e)
  check('another NVR’s reads carry on', typeof other === 'string' && sent.at(-1) === 'xb queryChlVideoParam')
  const change = await transparent(a, 'editChlVideoParam', '<x/>', 'change').catch((e) => e)
  check('a change to the broken NVR still goes out', typeof change === 'string' && sent.at(-1) === 'xa editChlVideoParam', change?.message)
  clock += 59_000
  const still = await transparent(a, 'queryChlVideoParam', '<x/>', 'r4').catch((e) => e)
  check('59 s later its reads are still refused', still instanceof HttpError && still.status === 503 && still.extra?.retryAfterS === 1)
  clock += 2000
  const m = sent.length
  const again = await transparent(a, 'queryChlVideoParam', '<x/>', 'r5').catch((e) => e)
  check('after 60 s a read goes out again', sent.length === m + 1 && again?.name === 'SdkTimeout', `${again?.name ?? again}`)
  await sleep(200)
  // one timeout after the breaker closed is not enough to open it again: the count starts over
  const next = sent.length
  const one = await transparent(a, 'queryChlVideoParam', '<x/>', 'r6').catch((e) => e)
  check('the count starts over: the first timeout after it closed does not reopen it', sent.length === next + 1 && one?.name === 'SdkTimeout', `${one?.name ?? one}`)
  await sleep(200)
  _test.setNow(null)
}

// ---- a call waiting for its NVR's lane does not hold up the other NVRs' XML calls. An NVR with two
// late calls holds its lane (lanes.mjs); a disk read to it (nvr-disks checks only that it is online)
// used to take the process-wide turn first and then sit in that lane, so every other NVR's settings
// reads and changes waited behind it, until those calls returned or 90 s passed.
{
  const log = [] // { nvr, start, end }
  let inFlight = 0
  let peak = 0
  _test.setCall(async (opts, _u, _x, _url, outBuf, _s, len) => {
    const e = { nvr: opts.nvr, start: Date.now(), end: 0 }
    log.push(e)
    peak = Math.max(peak, ++inFlight)
    await sleep(20)
    inFlight--
    e.end = Date.now()
    return answer(outBuf, len)
  })
  /** A fake native call that returns only when told to. */
  const held = () => {
    const f = { finish: () => {} }
    f.fn = { async: (...args) => (f.finish = () => args.at(-1)(null, 1)) }
    return f
  }
  const h = { ...fakeNvr('xh'), lane: new Lane('xh', 2) }
  const stuck = [held(), held()]
  const late = stuck.map((f, i) => sdkCallT({ nvr: 'xh', tag: `playback search ${i}`, timeoutMs: 50 }, f.fn).catch(() => {}))
  await sleep(100)
  // another NVR's call comes back meanwhile: the SDK is not stuck, only xh is slow
  await sdkCallT({ nvr: 'xq', tag: 'quick', timeoutMs: 500 }, { async: (...args) => setTimeout(() => args.at(-1)(null, 1), 5) })
  check('setup: xh has 2 late calls (so its lane holds), and the SDK is not stuck', lateCalls('xh') === 2 && sdkStuck() === false, `${lateCalls('xh')} late, stuck ${sdkStuck()}`)
  const t0 = Date.now()
  let heldDone = false
  const pHeld = transparent(h, 'queryDiskInfo', '<x/>', 'nvr disks').then(
    (x) => ((heldDone = true), x),
    (e) => ((heldDone = true), e)
  )
  await sleep(10)
  const others = await Promise.all([
    transparent(b, 'queryChlVideoParam', '<x/>', 'settings page').catch((e) => e),
    transparent(c, 'editChlVideoParam', '<x/>', 'a change').catch((e) => e)
  ])
  const took = Date.now() - t0
  check('other NVRs\' XML calls go out while xh\'s read waits for its lane', others.every((x) => typeof x === 'string') && took < 1000 && !heldDone && !log.some((e) => e.nvr === 'xh'), `${took} ms; ${others.map((x) => x?.message ?? 'ok').join(', ')}; sent: ${log.map((e) => e.nvr).join(',')}`)
  for (const f of stuck) f.finish()
  await Promise.all(late)
  const x = await pHeld
  check('once xh\'s late calls return, its read goes out', typeof x === 'string' && log.at(-1)?.nvr === 'xh', `${x?.message ?? 'ok'}; sent: ${log.map((e) => e.nvr).join(',')}`)
  check('... still one XML call in flight at a time, each 250 ms after the one before', peak === 1 && log.slice(1).every((e, i) => e.start - log[i].start >= 245 && e.start >= log[i].end), `peak ${peak}; ${log.slice(1).map((e, i) => e.start - log[i].start).join(',')}`)
  check('... and nothing is left queued', (await xmlSettled(h, 1000)) && (await xmlSettled(b, 1000)))
}

_test.setCall(null)
_test.resetBreakers()
print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
