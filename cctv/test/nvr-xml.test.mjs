// XML calls from the UI (nvr-xml.mjs transparent) in the main process: one in flight in the whole
// process, each starting once the previous one returned and at least 250 ms after it started; at
// most 10 waiting, and a
// read beyond that answered "busy" at once; a per-NVR read breaker (2 reads in a row past their
// time limit: that NVR's reads refused for 60 s, other NVRs carry on, changes still go). The
// picture-settings survey (87 reads) ran through 04:11 next to the call that got the service
// restarted: the SDK runs one call at a time for every NVR, so a burst only queues inside it.
// A call waiting for its NVR's lane (held while that NVR has late calls) does not hold up the
// other NVRs' XML calls: it takes its process-wide turn only once the lane runs it.
// One native XML or power call per NVR inside the SDK: the 90 s cap on waiting used to let the next
// call for the same NVR start on the same login beside one that had not returned (the audit's H1).
// Now the cap frees only the queue and the turn; a record per NVR (nvr-xml.mjs xmlInside), cleared
// only when the native call has really returned, has that NVR's XML calls and reboots refused until
// then.
// The native calls are replaced (nvr-xml.mjs _test.setCall, _test.setPower); the breaker has a fake
// clock. Nothing reaches an NVR.
// Needs the Linux SDK library (sdk.mjs loads it through koffi):  node cctv/test/nvr-xml.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'nvr-xml-'))
process.env.UV_THREADPOOL_SIZE = '64'
process.env.SDK_COOL_MS = '100' // a late read cools its NVR (not used by XML calls); keep it short
const { exclusiveSettled, lateCalls, onCallSettled, sdkCallT, sdkStuck } = await import('../sdk.mjs')
const { Lane } = await import('../lanes.mjs')
const { HttpError, _test, isReadCommand, power, transparent, xmlSettled } = await import('../nvr-xml.mjs')

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
  // ... but that was the second in a row since it closed, and two in a row open it, as the first time.
  // (It used to open once and never again: the time it had closed at stayed, and every later
  // time-out started the count over.)
  const k = sent.length
  const seventh = await transparent(a, 'queryChlVideoParam', '<x/>', 'r7').catch((e) => e)
  const logged = out.filter((l) => l.includes('[xa]') && l.includes('no reads to this NVR for 60 s')).length
  check('two timeouts in a row after it closed open it again: the next read is refused, nothing sent, and it is logged a second time', seventh instanceof HttpError && seventh.status === 503 && seventh.extra?.retryAfterS === 60 && sent.length === k && logged === 2, `${seventh?.status ?? seventh?.name} ${seventh?.message ?? seventh}; sent ${sent.length - k}; logged ${logged}x`)
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

// ---- borrowing: the control login is refused, the command goes out on the worker's login.
// Same queue, same refusals; the native call in this process is never made.
{
  let native = 0
  _test.setCall(async () => {
    native++
    throw new Error('the SDK must not be called while borrowing')
  })
  _test.setNow(null)
  const sent = []
  let reply = (m) => ({ ok: true, text: `<answer for="${m.url}"/>` })
  const w = fakeNvr('xw')
  Object.assign(w, {
    online: false, userId: -1, borrowing: true, xmlOnline: true, xmlDegraded: false, xmlGen: 'worker:111:5',
    worker: {
      stats: () => ({ gen: 5 }),
      request: async (m) => {
        sent.push(m)
        const r = reply(m)
        if (r instanceof Error) throw r
        return r
      }
    }
  })
  const text = await transparent(w, 'queryTimeCfg', '<request/>', 'clock', { outBytes: 2048 })
  check('borrowing: the answer is the worker\'s', text === '<answer for="queryTimeCfg"/>', text)
  check('borrowing: the worker got the whole command and its own session generation', sent.length === 1 && sent[0].op === 'xml' && sent[0].url === 'queryTimeCfg' && sent[0].xml === '<request/>' && sent[0].tag === 'clock' && sent[0].outBytes === 2048 && sent[0].gen === 5, JSON.stringify(sent[0]))
  check('borrowing: nothing went to the SDK here', native === 0)

  const stale = await transparent(w, 'queryTimeCfg', '<request/>', 'clock', { gen: 'own:1' }).catch((e) => e)
  check('borrowing: a caller holding the control login\'s session is refused, nothing sent', stale instanceof Error && /reconnected; nothing was sent/.test(stale.message) && sent.length === 1, stale?.message)

  reply = () => Object.assign(new Error('Too many NVR settings requests at once'), { status: 503, extra: { retryAfterS: 5 } })
  const busy = await transparent(w, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  check("borrowing: the worker's own refusal comes through as the same HTTP error", busy instanceof HttpError && busy.status === 503 && busy.extra?.retryAfterS === 5, `${busy?.status} ${JSON.stringify(busy?.extra)}`)

  reply = () => Object.assign(new Error('the video connection restarted'), { name: 'WorkerLost' })
  const lostWrite = await transparent(w, 'editTimeCfg', '<request/>', 'clock write').catch((e) => e)
  check('borrowing: a change lost with the worker says it may have been made', /NVR xw: the connection was lost; the change may or may not have been made/.test(lostWrite?.message), lostWrite?.message)
  const lostRead = await transparent(w, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  check('borrowing: a read lost with the worker says try again', /NVR xw: the connection was lost; try again/.test(lostRead?.message), lostRead?.message)

  reply = () => Object.assign(new Error('the video connection did not answer in time'), { name: 'SdkTimeout' })
  const late = await transparent(w, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  check('borrowing: a timeout is a timeout', late?.name === 'SdkTimeout')
  reply = () => ({ ok: true, text: 'after' })
  const after = await Promise.race([transparent(w, 'queryTimeCfg', '<request/>', 'clock'), sleep(3000).then(() => 'stuck')])
  check('borrowing: a timeout does not hold the queue (no native call is left running here)', after === 'after', after)

  // the process-wide turn is not held for the worker round trip: another NVR's command goes out meanwhile
  {
    const o = fakeNvr('xo')
    let letGo
    w.worker.request = async (m) => {
      sent.push(m)
      return new Promise((r) => (letGo = () => r({ ok: true, text: 'slow' })))
    }
    _test.setCall(async (_opts, _userId, _xml, _url, outBuf, _size, len) => answer(outBuf, len))
    const slow = transparent(w, 'queryTimeCfg', '<request/>', 'clock')
    await sleep(50)
    const other = await Promise.race([transparent(o, 'queryTimeCfg', '<request/>', 'clock').then(() => 'went'), sleep(2000).then(() => 'held')])
    check('borrowing: another NVR is not held up while the worker answers', other === 'went', other)
    letGo()
    check('borrowing: and the slow answer still arrives', (await slow) === 'slow')
    _test.setCall(async () => {
      native++
      throw new Error('the SDK must not be called while borrowing')
    })
  }

  // reboot / shutdown on the worker's login
  {
    const before = sent.length
    w.worker.request = async (m) => {
      sent.push(m)
      return { ok: true, accepted: true }
    }
    const rebooted = await power(w, 'reboot')
    check('borrowing: reboot goes to the worker', rebooted === true && sent.length === before + 1 && sent.at(-1).op === 'power' && sent.at(-1).action === 'reboot' && sent.at(-1).gen === 5, JSON.stringify(sent.at(-1)))
    w.worker.request = async () => {
      throw Object.assign(new Error('the video connection restarted'), { name: 'WorkerLost' })
    }
    const lostPower = await power(w, 'shutdown').catch((e) => e)
    check('borrowing: a power command lost with the worker says it may have been made', /may or may not have been made/.test(lostPower?.message), lostPower?.message)
    w.worker.request = async () => {
      throw Object.assign(new Error('the video connection is not ready; nothing was sent'), { name: 'WorkerNotReady' })
    }
    const notReady = await transparent(w, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
    check('borrowing: a worker that is not ready is an error', notReady?.name === 'WorkerNotReady', notReady?.name)
    w.worker.request = async (m) => {
      sent.push(m)
      return { ok: true, text: 'next' }
    }
    const next = await Promise.race([transparent(w, 'queryTimeCfg', '<request/>', 'clock'), sleep(3000).then(() => 'stuck')])
    check('borrowing: and the queue moves on after it', next === 'next', next)
  }

  // the control login comes back: the next command uses it
  Object.assign(w, { online: true, userId: 9, borrowing: false, xmlGen: 'own:2' })
  const before = sent.length
  _test.setCall(async (_opts, userId, _xml, _url, outBuf, _size, len) => {
    native = userId
    return answer(outBuf, len)
  })
  await transparent(w, 'queryTimeCfg', '<request/>', 'clock')
  check('borrowing ended: the command goes out on the control login', native === 9 && sent.length === before)
  _test.setCall(null)
}


// ---- one native XML or power call per NVR inside the SDK -------------------------------------------
// The audit's finding H1. The cap on waiting (90 s) released the per-NVR queue and the process-wide
// turn whether or not the native call had returned, and the native call carried no exclusive key: once
// a call had been inside the SDK for 90 s, the next XML call for the SAME NVR started on the same
// login beside it (overlapping SDK calls have corrupted the heap). A reboot or shutdown had the same
// exposure. The blocks below shorten the cap and the gap, and each uses an NVR id of its own (the
// record and the read breaker go by id).
const CAP = 300 // the shortened cap (ms): the time limits (50-150 ms) and the waits are set well apart from it
const LANE_CAP = 1000 // the real-lane block's cap (ms): well clear of a stalled event loop (why it matters there: at the block)
const AT_ONCE = 200 // "at once" (ms), for a call refused at the door or served on a free turn: well under the cap, which is how long it would take queued, or behind a turn that was not passed on
await sleep(300) // (the last call above keeps the process-wide turn for its 250 ms gap)
// A call left hanging by a broken queue, turn or record stops this file at an await that never settles:
// node then exits with 13 and no summary. Say so, so that such a run does not end without a FAIL line.
let ranToEnd = false
process.on('exit', () => {
  if (!ranToEnd) print('FAIL  the file stopped before its end: an await never settled (a call was left hanging), or an error was thrown')
})

/** A fake native function (for sdkCallT) that returns only when told to: finish() answers, finish(err) fails. */
const heldNative = (onReturn = () => {}) => {
  const f = { finish: () => {} }
  f.fn = {
    async: (...args) => {
      f.finish = (err = null) => {
        onReturn()
        // (TransparentConfig's arguments: userId, xml, url, out, outSize, len; a reboot has only userId)
        if (!err && Buffer.isBuffer(args[3])) answer(args[3], args[5])
        args.at(-1)(err, !err)
      }
    }
  }
  return f
}
/**
 * A call to another NVR comes back. While a call is past its time limit and nothing has come back
 * since it started, the SDK counts as stuck and every XML call is refused for THAT, with the same
 * status and also "nothing was sent". So a block with a late call has another NVR answer after that
 * call started, checks that sdkStuck() is false, and matches the record's own wording (refusedFor).
 */
const otherNvrAnswers = () => sdkCallT({ nvr: 'xq', tag: 'quick', timeoutMs: 500 }, { async: (...args) => setTimeout(() => args.at(-1)(null, 1), 5) })
/** The record's refusal: 503, a retry hint, and its own wording, naming the call that is inside the SDK. */
const refusedFor = (e, what) => e instanceof HttpError && e.status === 503 && e.extra?.retryAfterS > 0 && e.message.includes(`is still answering an earlier request (${what}, `) && /\d+ s so far\); nothing was sent/.test(e.message)
/** How many stand-in calls of each NVR are inside the "SDK" at once (peak: the most there ever were). */
const insideCounter = () => {
  const now = new Map()
  const most = new Map()
  return {
    enter(id) {
      now.set(id, (now.get(id) ?? 0) + 1)
      most.set(id, Math.max(most.get(id) ?? 0, now.get(id)))
    },
    leave: (id) => now.set(id, now.get(id) - 1),
    now: (id) => now.get(id) ?? 0,
    peak: (id) => most.get(id) ?? 0
  }
}
/** After a block: nothing is left queued for its NVRs, and no call is left admitted (pending 0). */
const nothingLeft = async (...list) => {
  for (const n of list) if (!(await xmlSettled(n, 1000))) return false
  return _test.pending() === 0
}
/**
 * Right after a refusal, while the call it was refused for is still inside the SDK: the refused call
 * gave its place back at once (nothing of this NVR is queued, no call is admitted). nothingLeft at the
 * end of a block cannot see that: a refused call that kept its place loses it to its own cap, and the
 * calls after it only wait that out (in the service: 90 s of that NVR's queue, or of every NVR's turn,
 * after each refusal).
 */
const gaveBack = async (nvr) => (await xmlSettled(nvr, 20)) && _test.pending() === 0
/** p's outcome, or an Error if it has not settled within ms: a call left hanging fails its check by name, instead of stopping the file at an await that never ends. */
const within = (p, ms) => {
  let timer
  return Promise.race([p, new Promise((r) => (timer = setTimeout(() => r(new Error(`not settled within ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer))
}
/** A lane like fakeNvr's that counts the jobs it is given (a call refused at the door takes none). */
const countingLane = () => {
  const lane = { jobs: 0, run: (task) => (lane.jobs++, Promise.resolve().then(task)) }
  return lane
}
/**
 * A fake NVR that watches its session being read. transparent() and power() read nvr.gen when they are
 * asked and again at their session check, which has to be the last thing before the record and the
 * native call, with nothing awaited in between. atCall(), for a stand-in to call as it is entered, says
 * how that went: atCheck is the record as it was at the last read of gen (null, unless the record was
 * entered before the session check), what and held are the record now, and ticked says whether a
 * promise tick has passed since that read (true: something was awaited between the session check and
 * the native call).
 */
const watchedNvr = (id) => {
  const n = fakeNvr(id)
  let gen = n.gen
  let atCheck
  let ticked = false
  Object.defineProperty(n, 'gen', {
    get() {
      atCheck = _test.inside(n)
      ticked = false
      queueMicrotask(() => (ticked = true))
      return gen
    },
    set(v) {
      gen = v
    }
  })
  n.atCall = () => ({ atCheck, what: _test.inside(n)?.what, held: _test.inside(n)?.held, ticked })
  return n
}
/** An atCall(): the session check, the record and the native call were one synchronous step, in that order. */
const oneStep = (seen, what) => seen?.atCheck === null && seen.what === what && seen.held === false && seen.ticked === false
/** Every seam a block below may have touched, back as it was. */
const restore = () => {
  _test.setCap(null)
  _test.setCall(null)
  _test.setPower(null)
  _test.setGap(null)
  _test.resetBreakers()
}
// (for the last block: a listener on every native return that throws when told to, and one registered
// after it that counts its calls)
let listenerThrows = false
let laterListenerRan = 0
onCallSettled(() => {
  if (listenerThrows) throw new Error('listener boom')
})
onCallSettled(() => laterListenerRan++)

// ---- the defect: a call still inside the SDK when the cap passes, and the next call for the same NVR
{
  _test.setCap(CAP)
  _test.setGap(10)
  const [d, o] = ['xd', 'xdo'].map(fakeNvr)
  d.lane = countingLane()
  const count = insideCounter()
  const sent = [] // "nvr tag", as the stand-in is entered
  const first = heldNative(() => count.leave('xd'))
  _test.setCall((opts, userId, xml, url, outBuf, size, len) => {
    sent.push(`${opts.nvr} ${opts.tag}`)
    count.enter(opts.nvr)
    // xd's first read stays inside the SDK until told to return: past its 50 ms time limit, then past the cap
    if (opts.tag === 'first read') return sdkCallT({ ...opts, timeoutMs: 50 }, first.fn, userId, xml, url, outBuf, size, len)
    count.leave(opts.nvr)
    return Promise.resolve(answer(outBuf, len))
  })
  const t0 = Date.now()
  let heldAtTimeout // (read in the rejection's own handler: a stalled event loop cannot let the cap pass first)
  const pFirst = transparent(d, 'queryChlVideoParam', '<x/>', 'first read').catch((e) => ((heldAtTimeout = _test.inside(d)?.held), e))
  await sleep(20)
  await otherNvrAnswers() // (after the first read started: from here the SDK does not count as stuck)
  let secondAt = 0
  const pSecond = transparent(d, 'queryChlVideoParam', '<x/>', 'second read').catch((e) => e).then((x) => ((secondAt = Date.now() - t0), x))
  const e1 = await pFirst
  check('setup: xd\'s read is past its time limit and still inside the SDK, on record; the SDK is not stuck', e1?.name === 'SdkTimeout' && lateCalls('xd') === 1 && _test.inside(d)?.what === 'first read' && heldAtTimeout === false && sdkStuck() === false, `${e1?.name ?? e1}; ${lateCalls('xd')} late; held at the time-out ${heldAtTimeout}; record now ${JSON.stringify(_test.inside(d))}; stuck ${sdkStuck()}`)
  const pOther = transparent(o, 'queryChlVideoParam', '<x/>', 'other NVR').catch((e) => e)
  // (within: if the cap ever stopped passing the queue or the turn on, these two would wait for ever)
  const second = await within(pSecond, 2000)
  const other = await within(pOther, 1000)
  check('... and still not stuck once the cap has passed (so the refusal below is the record\'s)', sdkStuck() === false)
  check('the call queued behind it is refused when the cap passes (503, nothing sent), not started beside it', refusedFor(second, 'first read') && secondAt >= CAP - 30 && !sent.includes('xd second read'), `${second?.status ?? 'sent'} ${second?.message ?? ''} at ${secondAt} ms`)
  check('... and gave its place back at once, with the first call still inside (nothing of xd queued, no call admitted)', (await gaveBack(d)) && _test.inside(d)?.what === 'first read', `pending ${_test.pending()}; record ${JSON.stringify(_test.inside(d))}`)
  check('... never 2 calls of xd inside the SDK at once', count.peak('xd') === 1 && count.now('xd') === 1, `peak ${count.peak('xd')}; sent: ${sent.join(', ')}`)
  check('... while another NVR\'s call IS served when the cap passes: it frees the queue and the turn', typeof other === 'string' && sent.includes('xdo other NVR') && count.now('xd') === 1, `${other?.message ?? 'ok'}; sent: ${sent.join(', ')}`)
  const heldLines = out.filter((l) => l.includes('[xd]') && l.includes('still inside the SDK after') && l.includes('XML calls to this NVR are refused until it returns'))
  check('... the cap does not clear the record: it is still set, now held (logged once)', _test.inside(d)?.what === 'first read' && _test.inside(d)?.held === true && heldLines.length === 1, `record ${JSON.stringify(_test.inside(d))}; ${heldLines.length} lines`)
  const tDoor = Date.now()
  const doorRead = await transparent(d, 'queryChlVideoParam', '<x/>', 'third read').catch((e) => e)
  const doorChange = await transparent(d, 'editChlVideoParam', '<x/>', 'a change').catch((e) => e)
  check('from then on xd\'s calls are refused at the door, a change too', sdkStuck() === false && refusedFor(doorRead, 'first read') && refusedFor(doorChange, 'first read') && Date.now() - tDoor < AT_ONCE && sent.filter((s) => s.startsWith('xd ')).length === 1, `${doorRead?.message ?? 'sent'} | ${doorChange?.message ?? 'sent'}`)
  check('... none of the refused calls took a lane slot or the turn (only the first read ever reached the lane)', d.lane.jobs === 1, `${d.lane.jobs} lane jobs`)
  // The record goes by the NVR's id, not by the login or the Nvr object, so it outlives both: the call
  // is still inside the SDK whatever became of the session it started on (and the SDK reuses login
  // ids). So a call is still refused after a relogin (the next session, another login id), and so is
  // one from a re-created Nvr object with the same id, which has no queue of its own to wait in.
  _test.setPower(() => Promise.resolve(true))
  d.gen = 2
  d.userId = 8
  const d2 = { ...fakeNvr('xd'), gen: 2, userId: 8 }
  const afterRelogin = await transparent(d, 'queryChlVideoParam', '<x/>', 'after relogin').catch((e) => e)
  const newObject = await transparent(d2, 'queryChlVideoParam', '<x/>', 'new object').catch((e) => e)
  const newObjectReboot = await power(d2, 'reboot').catch((e) => e)
  check('the record goes by the NVR\'s id: still refused after a relogin, and for a re-created Nvr object (its reboot too)', refusedFor(afterRelogin, 'first read') && refusedFor(newObject, 'first read') && refusedFor(newObjectReboot, 'first read') && sent.filter((s) => s.startsWith('xd ')).length === 1 && count.peak('xd') === 1, `${afterRelogin?.message ?? 'sent'} | ${newObject?.message ?? 'sent'} | ${newObjectReboot?.message ?? newObjectReboot}; sent: ${sent.join(', ')}`)
  // the call finally returns (late)
  first.finish()
  check('when it finally returns, the record is gone (logged)', _test.inside(d) === null && lateCalls('xd') === 0 && count.now('xd') === 0 && out.some((l) => l.includes('[xd]') && l.includes('first read returned')), `record ${JSON.stringify(_test.inside(d))}`)
  const next = await transparent(d, 'queryChlVideoParam', '<x/>', 'next read').catch((e) => e)
  check('... and the next call to xd goes out (one real timeout and then refusals: its read breaker stayed closed)', typeof next === 'string' && sent.at(-1) === 'xd next read' && count.peak('xd') === 1, `${next?.message ?? 'ok'}; sent: ${sent.join(', ')}`)
  check('... nothing is left admitted or queued', await nothingLeft(d, o), `pending ${_test.pending()}`)
  restore()
}

// ---- a healthy slow call: its caller's time limit is longer than the cap (a heavy read over a slow
// link that rightly takes minutes). The cap still frees the waiting and the call still gets its answer,
// and nothing else of that NVR goes in beside it meanwhile.
{
  _test.setCap(CAP)
  _test.setGap(10)
  const s = fakeNvr('xs')
  const count = insideCounter()
  const sent = []
  let slowLimit // the time limit the slow call's native call was given
  const slow = heldNative(() => count.leave('xs'))
  _test.setCall((opts, userId, xml, url, outBuf, size, len) => {
    sent.push(opts.tag)
    count.enter(opts.nvr)
    if (opts.tag === 'slow read') {
      // its caller's own time limit has to come in opts: the fake function has no C name, so without
      // it sdkCallT would give it the 30 s default and this block would show nothing about timeoutMs
      slowLimit = opts.timeoutMs
      return sdkCallT(opts, slow.fn, userId, xml, url, outBuf, size, len)
    }
    count.leave(opts.nvr)
    return Promise.resolve(answer(outBuf, len))
  })
  let slowBack = false
  const pSlow = transparent(s, 'queryNodeEncodeInfo', '<x/>', 'slow read', { timeoutMs: 5000 }).then(
    (x) => ((slowBack = true), x),
    (e) => ((slowBack = true), e)
  )
  await sleep(20)
  // two reads wait behind it, up to the cap. Both are refused on their way out of the queue, which is
  // where a read's outcome is counted for the breaker (a read refused at the door never gets that far)
  const pQueued = [1, 2].map((i) => transparent(s, 'queryChlVideoParam', '<x/>', `queued read ${i}`).catch((e) => e))
  const queued = [await within(pQueued[0], 2000), await within(pQueued[1], 2000)]
  check('setup: the slow call has its caller\'s time limit (5 s) and is within it when the cap passes, and the SDK is not stuck', slowLimit === 5000 && lateCalls('xs') === 0 && sdkStuck() === false && !slowBack && _test.inside(s)?.held === true, `limit ${slowLimit}; ${lateCalls('xs')} late; stuck ${sdkStuck()}; back ${slowBack}; record ${JSON.stringify(_test.inside(s))}`)
  check('the callers queued behind it are refused when the cap passes (503, nothing sent)', queued.every((e) => refusedFor(e, 'slow read')) && sent.length === 1 && count.peak('xs') === 1, `${queued.map((e) => e?.message ?? 'sent').join(' | ')}; peak ${count.peak('xs')}`)
  check('... and gave their places back at once, with the slow call still inside', (await gaveBack(s)) && !slowBack, `pending ${_test.pending()}; back ${slowBack}`)
  const doorRead = await transparent(s, 'queryChlVideoParam', '<x/>', 'door read').catch((e) => e)
  const doorChange = await transparent(s, 'editChlVideoParam', '<x/>', 'door change').catch((e) => e)
  check('... and later ones at the door, a change too', refusedFor(doorRead, 'slow read') && refusedFor(doorChange, 'slow read') && sent.length === 1, `${doorRead?.message ?? 'sent'} | ${doorChange?.message ?? 'sent'}`)
  check('... none of it counted for the read breaker (the 2 reads refused out of the queue would have opened it)', !out.some((l) => l.includes('[xs]') && l.includes('no reads to this NVR')))
  slow.finish()
  const x = await pSlow
  check('the slow call\'s own caller still gets its answer when it returns', typeof x === 'string' && /success/.test(x), `${x?.message ?? 'ok'}`)
  check('... and the record is gone', _test.inside(s) === null, JSON.stringify(_test.inside(s)))
  const after = await transparent(s, 'queryChlVideoParam', '<x/>', 'after').catch((e) => e)
  check('... and the next call to that NVR goes out', typeof after === 'string' && sent.at(-1) === 'after' && count.peak('xs') === 1, `${after?.message ?? 'ok'}`)
  check('... nothing is left admitted or queued', await nothingLeft(s), `pending ${_test.pending()}`)
  restore()
}

// ---- nor does a refusal start the read breaker's count over (a read that came back does). A read
// past its time limit, a read refused behind it, a second read past its time limit: the breaker opens.
{
  _test.setCap(CAP)
  _test.setGap(10)
  const r = fakeNvr('xr')
  let native = null // the fake native function the next read goes to (50 ms time limit); null: answered at once
  _test.setCall((opts, userId, xml, url, outBuf, size, len) => (native ? sdkCallT({ ...opts, timeoutMs: 50 }, native.fn, userId, xml, url, outBuf, size, len) : Promise.resolve(answer(outBuf, len))))
  const h1 = (native = heldNative())
  const pT1 = transparent(r, 'queryChlVideoParam', '<x/>', 'timeout 1').catch((e) => e)
  await sleep(20)
  await otherNvrAnswers()
  // queued behind it and refused when the cap passes: on its way out of the queue, where a read's outcome is counted
  const refused = await within(transparent(r, 'queryChlVideoParam', '<x/>', 'refused read').catch((e) => e), 2000)
  const t1 = await pT1
  const notStuck = sdkStuck() === false
  h1.finish()
  const h2 = (native = heldNative())
  const t2 = await transparent(r, 'queryChlVideoParam', '<x/>', 'timeout 2').catch((e) => e)
  h2.finish()
  native = null
  const next = await transparent(r, 'queryChlVideoParam', '<x/>', 'next read').catch((e) => e)
  check('a timeout, a refusal, a second timeout: the breaker opens (the refusal did not start its count over)', t1?.name === 'SdkTimeout' && notStuck && refusedFor(refused, 'timeout 1') && t2?.name === 'SdkTimeout' && next instanceof HttpError && next.status === 503 && /did not answer 2 settings reads in time/.test(next.message) && out.some((l) => l.includes('[xr]') && l.includes('no reads to this NVR')), `${t1?.name ?? t1} | ${refused?.message ?? 'sent'} | ${t2?.name ?? t2} | ${next?.message ?? 'sent'}`)
  check('... nothing is left admitted or queued, and no record', (await nothingLeft(r)) && _test.inside(r) === null, `pending ${_test.pending()}; record ${JSON.stringify(_test.inside(r))}`)
  restore()
}

// ---- the record is cleared on every way a native call ends, and never set when nothing is sent
{
  _test.setCap(CAP)
  _test.setGap(10)
  const n = watchedNvr('xe')
  const sent = []
  let native = null // what the stand-in does with the next call
  let seen = null // n.atCall() as the stand-in was last entered
  _test.setCall((opts, ...args) => {
    sent.push(opts.tag)
    seen = n.atCall()
    return native(opts, ...args)
  })
  const answers = (_opts, _u, _x, _url, outBuf, _s, len) => Promise.resolve(answer(outBuf, len))
  /** After a case: no record is left, and a following call to the NVR goes out. */
  const clearAfter = async (what) => {
    const left = _test.inside(n)
    native = answers
    const before = sent.length
    const x = await transparent(n, 'queryChlVideoParam', '<x/>', `after ${what}`).catch((e) => e)
    return left === null && typeof x === 'string' && sent.length === before + 1 && _test.inside(n) === null
  }

  native = answers
  const x1 = await transparent(n, 'queryChlVideoParam', '<x/>', 'in time').catch((e) => e)
  const step1 = seen
  const c1 = await clearAfter('an answer')
  check('entered as the last step before the native call: no record yet at the session check, this call\'s at the native call, nothing awaited in between', oneStep(step1, 'in time'), JSON.stringify(step1))
  check('cleared: an answer in time', typeof x1 === 'string' && c1, `${x1?.message ?? 'ok'}`)

  native = (opts, ...args) => sdkCallT({ ...opts, timeoutMs: 500 }, { async: (...a) => setTimeout(() => a.at(-1)(new Error('native boom')), 10) }, ...args)
  const x2 = await transparent(n, 'queryChlVideoParam', '<x/>', 'native error').catch((e) => e)
  const c2 = await clearAfter('a native error')
  check('cleared: a native error in time', x2?.message === 'native boom' && c2, `${x2?.message ?? x2}`)

  native = () => {
    throw new Error('stand-in boom')
  }
  const x3 = await transparent(n, 'queryChlVideoParam', '<x/>', 'throws').catch((e) => e)
  const c3 = await clearAfter('a throw')
  check('cleared: the stand-in throwing synchronously (nothing was started)', x3?.message === 'stand-in boom' && c3, `${x3?.message ?? x3}`)

  const refusing = {
    async: () => {
      throw new TypeError('koffi refused the arguments')
    }
  }
  native = (opts, ...args) => sdkCallT({ ...opts, timeoutMs: 500 }, refusing, ...args)
  const x4 = await transparent(n, 'queryChlVideoParam', '<x/>', 'koffi throws').catch((e) => e)
  const c4 = await clearAfter('koffi throwing')
  check('cleared: koffi refusing the arguments (nothing runs natively)', x4 instanceof TypeError && c4, `${x4?.message ?? x4}`)

  // a relogin while the call waits its turn: it is refused at its session check, which comes before the
  // record. (That the record is not LEFT set says nothing about the order: an error clears it again in
  // the same tick. So the record is read at the session check itself: watchedNvr.)
  native = answers
  const before5 = sent.length
  const p5 = transparent(n, 'queryChlVideoParam', '<x/>', 'queued').catch((e) => e)
  n.gen = 2
  const x5 = await p5
  const atCheck5 = n.atCall().atCheck
  const back5 = await gaveBack(n)
  const notSent = sent.length === before5
  const c5 = await clearAfter('a relogin')
  check('"reconnected; nothing was sent" (the session changed while the call was queued): nothing sent, no record at its session check or left after it', /reconnected; nothing was sent/.test(x5?.message) && notSent && atCheck5 === null && c5, `${x5?.message ?? x5}; record at the session check ${JSON.stringify(atCheck5)}`)
  check('... and it gave its place back at once', back5, `pending ${_test.pending()}`)

  for (const [what, err] of [['a late answer', null], ['a late error', new Error('late boom')]]) {
    const h = heldNative()
    native = (opts, ...args) => sdkCallT({ ...opts, timeoutMs: 50 }, h.fn, ...args)
    const x = await transparent(n, 'queryChlVideoParam', '<x/>', what).catch((e) => e)
    await sleep(30)
    const still = _test.inside(n)?.what === what // the time limit does not clear it: the call is still inside
    h.finish(err)
    const cleared = await clearAfter(what)
    check(`cleared: SdkTimeout, then ${what} (onLate), and not before`, x?.name === 'SdkTimeout' && still && cleared, `${x?.name ?? x}; still ${still}; cleared ${cleared}`)
  }
  check('... nothing is left admitted or queued', await nothingLeft(n), `pending ${_test.pending()}`)
  restore()
}

// ---- reboot and shutdown (power()) share the record with the XML calls, both ways
{
  _test.setCap(CAP)
  _test.setGap(10)
  const p = watchedNvr('xp')
  p.lane = countingLane()
  const q = fakeNvr('xpo') // another NVR: how fast it is served shows whether the process-wide turn is free
  const sent = [] // xp's XML calls, as their stand-in is entered
  const powered = [] // reboots and shutdowns, as theirs is
  let powerOpts = null
  let powerSeen = null // p.atCall() as the power stand-in was last entered
  const xml = heldNative()
  let reboot = null // a native reboot that returns only when told to; null: accepted at once
  _test.setCall((opts, userId, x, url, outBuf, size, len) => {
    if (opts.nvr === 'xp') sent.push(opts.tag)
    // (a healthy slow read: within its 5 s all through)
    if (opts.tag === 'held read') return sdkCallT({ ...opts, timeoutMs: 5000 }, xml.fn, userId, x, url, outBuf, size, len)
    return Promise.resolve(answer(outBuf, len))
  })
  _test.setPower((opts, action, userId) => {
    powered.push(action)
    powerOpts = opts
    // (read here, in the same synchronous step that entered the record: no timing is involved)
    powerSeen = p.atCall()
    return reboot ? sdkCallT({ ...opts, timeoutMs: 150 }, reboot.fn, userId) : Promise.resolve(true)
  })
  /** Another NVR's call, asked now: whether it was served, and how long that took (no time at all if the turn is free). */
  const otherNvrServed = async () => {
    const t = Date.now()
    const x = await within(transparent(q, 'queryChlVideoParam', '<x/>', 'other NVR').catch((e) => e), 1000)
    return { ok: typeof x === 'string', ms: Date.now() - t }
  }

  // an XML call of xp is inside the SDK: a reboot waits its turn, and is refused when the cap passes
  const t0 = Date.now()
  const pXml = transparent(p, 'queryNodeEncodeInfo', '<x/>', 'held read').catch((e) => e)
  await sleep(20)
  // (and a shutdown asked just before a relogin: by the time it gets its turn, ahead of the reboot, its
  // session is gone. It has to be told that, at its session check, and not that the NVR is busy: the
  // session check comes before the record in power() as well)
  const pStale = power(p, 'shutdown').catch((e) => e)
  p.gen = 2
  const r1 = await within(power(p, 'reboot').catch((e) => e), 2000)
  const waited = Date.now() - t0
  const stale = await within(pStale, 1000)
  const turn1 = await otherNvrServed()
  check('power(): refused while an XML call of that NVR is inside the SDK (503, nothing sent)', sdkStuck() === false && refusedFor(r1, 'held read') && powered.length === 0 && waited >= CAP - 30, `${r1?.message ?? r1} after ${waited} ms`)
  check('... and it passed the turn on: another NVR\'s call is served at once', turn1.ok && turn1.ms < AT_ONCE, `${turn1.ok ? 'served' : 'not served'} in ${turn1.ms} ms`)
  check('... a shutdown whose session changed while it waited is refused at its session check ("reconnected"), which comes before the record', /reconnected; nothing was sent/.test(stale?.message) && powered.length === 0, `${stale?.message ?? stale}`)
  const tDoor = Date.now()
  const r2 = await power(p, 'shutdown').catch((e) => e)
  check('... and at the door from then on, without a lane slot or the turn', refusedFor(r2, 'held read') && powered.length === 0 && Date.now() - tDoor < AT_ONCE && p.lane.jobs === 3, `${r2?.message ?? r2}; ${p.lane.jobs} lane jobs (the read, the stale shutdown, the first reboot)`)
  xml.finish()
  const x1 = await pXml
  const r3 = await power(p, 'reboot').catch((e) => e)
  check('once the XML call has returned, a reboot goes out (same exclusive key, a late handler)', typeof x1 === 'string' && r3 === true && powered.join() === 'reboot' && powerOpts?.exclusive === 'xp/xml' && typeof powerOpts?.onLate === 'function' && _test.inside(p) === null, `${x1?.message ?? 'ok'}; ${r3?.message ?? r3}; ${powered.join()}; key ${powerOpts?.exclusive}`)
  check('... entered as the last step before its native call: no record yet at the session check, the reboot\'s at the native call, nothing awaited in between', oneStep(powerSeen, 'reboot'), JSON.stringify(powerSeen))

  // a reboot is inside the SDK and runs past its time limit (150 ms here): an XML call waiting its turn
  reboot = heldNative()
  powerSeen = null
  const pReboot = power(p, 'reboot').catch((e) => e)
  await sleep(20)
  await otherNvrAnswers()
  const pRead = transparent(p, 'queryChlVideoParam', '<x/>', 'read during reboot').catch((e) => e)
  const [r4, x2] = [await within(pReboot, 2000), await within(pRead, 2000)]
  // (right away: the read was refused holding the turn, and a call that kept it would lose it to its own cap, 300 ms on)
  const back2 = await gaveBack(p)
  const turn2 = await otherNvrServed()
  check('a reboot past its time limit rejects with SdkTimeout and stays on record, held (logged)', oneStep(powerSeen, 'reboot') && r4?.name === 'SdkTimeout' && _test.inside(p)?.what === 'reboot' && _test.inside(p)?.held === true && out.some((l) => l.includes('[xp] reboot is still inside the SDK after')), `${r4?.name ?? r4}; at its native call ${JSON.stringify(powerSeen)}; record ${JSON.stringify(_test.inside(p))}`)
  check('an XML call is refused while a reboot is inside the SDK (503, nothing sent)', sdkStuck() === false && refusedFor(x2, 'reboot') && !sent.includes('read during reboot'), `stuck ${sdkStuck()}; ${x2?.message ?? 'sent'}`)
  check('... and gave its place and the turn back at once: nothing of xp is queued, another NVR\'s call is served at once', back2 && turn2.ok && turn2.ms < AT_ONCE, `gave back ${back2}; ${turn2.ok ? 'served' : 'not served'} in ${turn2.ms} ms`)
  const x3 = await transparent(p, 'editChlVideoParam', '<x/>', 'change after the timeout').catch((e) => e)
  const r5 = await power(p, 'reboot').catch((e) => e)
  check('after a reboot that timed out, XML calls and another reboot are refused until it returns', refusedFor(x3, 'reboot') && refusedFor(r5, 'reboot') && powered.length === 2 && sent.length === 1, `${x3?.message ?? 'sent'} | ${r5?.message ?? r5}; ${powered.length} power calls`)
  reboot.finish()
  reboot = null
  const x4 = await transparent(p, 'queryChlVideoParam', '<x/>', 'read after reboot').catch((e) => e)
  check('once it has returned (late), the record is gone and XML calls go out again', _test.inside(p) === null && typeof x4 === 'string' && sent.at(-1) === 'read after reboot', `${x4?.message ?? 'ok'}; record ${JSON.stringify(_test.inside(p))}`)
  check('... nothing is left admitted or queued', await nothingLeft(p, q), `pending ${_test.pending()}`)
  restore()
}

// ---- the last check alone, in the NVR's real lane. Two XML calls of one NVR can be in its lane at
// once: the first one's cap frees the per-NVR queue while it still waits for a lane that late calls of
// another kind hold. Both are then past the door and the queue, and only the turn and the record are
// left to keep the second out of the SDK while the first is inside.
// The cap is LANE_CAP here, not CAP: x0's cap must not pass before otherNvrAnswers() has returned
// (below, a few ms after x0 starts), or the SDK counts as stuck when x1 and x2 are refused and it is
// that, not the record, which refuses them. A second is well clear of an event loop stalled on a
// busy machine; "at once" for the other NVR's call is then half of it, which a turn kept until the
// refused call's cap is not.
{
  _test.setCap(LANE_CAP)
  _test.setGap(10)
  const w = { ...fakeNvr('xlw'), lane: new Lane('xlw', 2) }
  const o = fakeNvr('xwo')
  const stuck = [heldNative(), heldNative()]
  const late = stuck.map((f, i) => sdkCallT({ nvr: 'xlw', tag: `playback search ${i}`, timeoutMs: 50 }, f.fn).catch(() => {}))
  await sleep(100)
  await otherNvrAnswers()
  const count = insideCounter()
  const sent = [] // "nvr tag", as the stand-in is entered
  const first = heldNative(() => count.leave('xlw'))
  _test.setCall((opts, userId, xml, url, outBuf, size, len) => {
    sent.push(`${opts.nvr} ${opts.tag}`)
    count.enter(opts.nvr)
    // x0 stays inside the SDK until told to return: past its 50 ms time limit, then past the cap
    if (opts.tag === 'x0') return sdkCallT({ ...opts, timeoutMs: 50 }, first.fn, userId, xml, url, outBuf, size, len)
    count.leave(opts.nvr)
    return Promise.resolve(answer(outBuf, len))
  })
  const setup = lateCalls('xlw') === 2 && sdkStuck() === false
  const ps = ['x0', 'x1', 'x2'].map((tag) => transparent(w, 'queryChlVideoParam', '<x/>', tag).catch((e) => e))
  // each call's cap frees the per-NVR queue for the next while it waits for the lane: 3 caps on (waited
  // for, not timed: three timers in a row run late on a busy machine), all three are in the lane's queue
  const allInLane = () => w.lane.pending === 3 && _test.pending() === 0
  const giveUp = Date.now() + 10_000
  while (!allInLane() && Date.now() < giveUp) await sleep(20)
  check('setup: xlw\'s lane is held by 2 late calls; its 3 XML calls all wait in the lane, none in the per-NVR queue, nothing sent', setup && allInLane() && w.lane.running === 0 && sent.length === 0, `${lateCalls('xlw')} late; lane ${w.lane.running} running, ${w.lane.pending} waiting; pending ${_test.pending()}; sent: ${sent.join(', ')}`)
  // the late calls return: the lane runs x0 and x1 at once. x0 takes the turn and goes inside; x1 waits for the turn
  for (const f of stuck) f.finish()
  await Promise.all(late)
  await sleep(20)
  await otherNvrAnswers() // (after x0 started: from here the SDK does not count as stuck)
  const rs = [await within(ps[0], 5000), await within(ps[1], 5000), await within(ps[2], 5000)]
  const back = await gaveBack(w)
  const tTurn = Date.now()
  const other = await within(transparent(o, 'queryChlVideoParam', '<x/>', 'other NVR').catch((e) => e), 1000)
  const turnMs = Date.now() - tTurn
  check('x0 runs past its time limit inside the SDK; x1 and x2 are refused when its cap passes (503, nothing sent), by the record and not for a stuck SDK', sdkStuck() === false && rs[0]?.name === 'SdkTimeout' && refusedFor(rs[1], 'x0') && refusedFor(rs[2], 'x0') && _test.inside(w)?.held === true, `${rs.map((x) => (x?.name === 'SdkTimeout' ? x.name : (x?.message ?? 'sent'))).join(' | ')}; stuck ${sdkStuck()}`)
  check('... never 2 calls of xlw inside the SDK at once', count.peak('xlw') === 1 && count.now('xlw') === 1 && sent.filter((s) => s.startsWith('xlw ')).length === 1, `peak ${count.peak('xlw')}; sent: ${sent.join(', ')}`)
  check('... the refused calls gave everything back at once: the lane is idle, nothing queued or admitted, another NVR\'s call is served at once', back && w.lane.running === 0 && w.lane.pending === 0 && typeof other === 'string' && turnMs < LANE_CAP / 2, `gave back ${back}; lane ${w.lane.running} running, ${w.lane.pending} waiting; other NVR ${other?.message ?? 'served'} in ${turnMs} ms`)
  first.finish()
  const next = await transparent(w, 'queryChlVideoParam', '<x/>', 'next').catch((e) => e)
  check('once x0 has returned (late), the record is gone and the next call to xlw goes out', _test.inside(w) === null && typeof next === 'string' && sent.at(-1) === 'xlw next' && count.peak('xlw') === 1, `${next?.message ?? 'ok'}; record ${JSON.stringify(_test.inside(w))}`)
  check('... nothing is left admitted or queued', (await nothingLeft(w, o)) && w.lane.running === 0 && w.lane.pending === 0, `pending ${_test.pending()}`)
  restore()
}

// ---- the native call's options: a caller's own time limit, and the exclusive key (the backstop)
{
  const t = fakeNvr('xt')
  let seen = null
  _test.setCall((opts, _u, _x, _url, outBuf, _s, len) => {
    seen = opts
    return answer(outBuf, len)
  })
  await transparent(t, 'queryNodeEncodeInfo', '<x/>', 'default read')
  check('no timeoutMs given: none in the native call\'s options (the SDK\'s own time limit applies)', seen !== null && !('timeoutMs' in seen), JSON.stringify(Object.keys(seen ?? {})))
  check('the native call carries its NVR\'s exclusive key and a late handler', seen?.exclusive === 'xt/xml' && typeof seen?.onLate === 'function' && seen?.nvr === 'xt' && seen?.tag === 'default read', JSON.stringify(seen))
  await transparent(t, 'queryNodeEncodeInfo', '<x/>', 'slow-link read', { timeoutMs: 240_000 })
  check('a timeoutMs given reaches the native call\'s options', seen?.timeoutMs === 240_000 && seen?.exclusive === 'xt/xml', JSON.stringify(seen?.timeoutMs))
  check('... nothing is left admitted or queued', await nothingLeft(t), `pending ${_test.pending()}`)
  restore()
}

// ---- sdk.mjs release(): a settle listener that throws must not stop what follows it in the native
// callback (onLate, and the exclusive key being freed). A skipped onLate would leave the record set,
// and that NVR's XML calls and reboot refused until the service is restarted.
{
  _test.setCap(CAP)
  _test.setGap(10)
  const l = fakeNvr('xl')
  const h = heldNative()
  _test.setCall((opts, userId, xml, url, outBuf, size, len) => (opts.tag === 'late read' ? sdkCallT({ ...opts, timeoutMs: 50 }, h.fn, userId, xml, url, outBuf, size, len) : Promise.resolve(answer(outBuf, len))))
  const e1 = await transparent(l, 'queryChlVideoParam', '<x/>', 'late read').catch((e) => e)
  let threw = null
  listenerThrows = true
  const ranBefore = laterListenerRan
  try {
    h.finish()
  } catch (e) {
    threw = e
  }
  listenerThrows = false
  check('a settle listener that throws does not stop a late return reaching the record (logged)', e1?.name === 'SdkTimeout' && threw === null && _test.inside(l) === null && out.some((x) => x.includes('settle listener') && x.includes('listener boom')), `${e1?.name ?? e1}; threw ${threw?.message ?? 'nothing'}; record ${JSON.stringify(_test.inside(l))}`)
  // (each listener is tried by itself: one try around them all would skip the ones after the one that
  // threw, and those are what restarts held-back work: the lanes' kick, the live pacers' and idle stops')
  check('... nor the listeners registered after it', laterListenerRan === ranBefore + 1, `ran ${laterListenerRan - ranBefore} times`)
  const next = await transparent(l, 'queryChlVideoParam', '<x/>', 'next read').catch((e) => e)
  check('... nor the exclusive key being freed: the NVR\'s next call goes out', typeof next === 'string' && (await exclusiveSettled('xl/', 100)), `${next?.message ?? 'ok'}`)
  check('... nothing is left admitted or queued', await nothingLeft(l), `pending ${_test.pending()}`)
  restore()
}

// ---- the record and a borrowed login (the control login refused, the command on the worker's)
// A call sent through the worker enters no SDK of this process: it takes no record here, and a call of
// this NVR that is still inside this process's SDK (held from before the control login was lost) does
// not turn it away: the record is about this process's SDK, which a borrowed call never enters. It is
// not a way round a call wedged on the control login (that NVR stays on its own login, and refused:
// a late call keeps nvrs.mjs from the relogin that would start borrowing); this block builds the
// state by hand. The worker's own transparent() and power() keep the record for the worker's SDK.
{
  _test.setCap(CAP)
  _test.setGap(10)
  const b = fakeNvr('xbw')
  const first = heldNative()
  let nativeWhileBorrowing = 0
  _test.setCall((opts, userId, xml, url, outBuf, size, len) => {
    if (opts.tag === 'held read') return sdkCallT({ ...opts, timeoutMs: 50 }, first.fn, userId, xml, url, outBuf, size, len)
    nativeWhileBorrowing++
    return Promise.resolve(answer(outBuf, len))
  })
  _test.setPower(async () => {
    nativeWhileBorrowing++
    return true
  })
  const pHeld = transparent(b, 'queryChlVideoParam', '<x/>', 'held read').catch((e) => e)
  await sleep(20)
  await otherNvrAnswers() // (from here the SDK does not count as stuck)
  const eHeld = await pHeld
  await sleep(CAP + 150) // the cap passes with the call still inside
  check('setup: a call of this NVR is held inside this process\'s SDK, and the SDK is not stuck', eHeld?.name === 'SdkTimeout' && _test.inside(b)?.what === 'held read' && _test.inside(b)?.held === true && sdkStuck() === false, `${eHeld?.name} ${JSON.stringify(_test.inside(b))} stuck ${sdkStuck()}`)
  const refusedOwn = await transparent(b, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  check('... on its own login it is refused, as above', refusedFor(refusedOwn, 'held read'), `${refusedOwn?.status} ${refusedOwn?.message}`)

  // the control login is lost and the worker's is borrowed
  const asked = []
  const recordDuring = []
  Object.assign(b, {
    online: false, userId: -1, borrowing: true, xmlOnline: true, xmlDegraded: false, xmlGen: 'worker:1:1',
    worker: {
      stats: () => ({ gen: 1 }),
      request: async (m) => {
        asked.push(m.op)
        recordDuring.push(_test.inside(b)?.what ?? null)
        return m.op === 'power' ? { accepted: true } : { text: '<from the worker/>' }
      }
    }
  })
  const t0 = Date.now()
  const viaWorker = await within(transparent(b, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e), 2000)
  check('borrowed: an XML call goes out on the worker\'s login, at once, although a call of this NVR is held inside this process', viaWorker === '<from the worker/>' && asked.join() === 'xml' && Date.now() - t0 < AT_ONCE, `${viaWorker?.message ?? viaWorker} after ${Date.now() - t0} ms; asked ${asked.join()}`)
  const reboot = await within(power(b, 'reboot').catch((e) => e), 2000)
  check('... and so does a reboot', reboot === true && asked.join() === 'xml,power', `${reboot?.message ?? reboot}; asked ${asked.join()}`)
  check('... neither entered this process\'s SDK, and neither took the record: it still names the call that is inside', nativeWhileBorrowing === 0 && recordDuring.join() === 'held read,held read' && _test.inside(b)?.what === 'held read', `${nativeWhileBorrowing} native, record during ${recordDuring.join()}, now ${_test.inside(b)?.what}`)
  check('... and both gave back their place in the queue', await gaveBack(b), `pending ${_test.pending()}`)

  // on its own login again while that call is still inside: refused again, until it returns
  Object.assign(b, { online: true, userId: 7, borrowing: false, xmlOnline: undefined, xmlDegraded: undefined, xmlGen: undefined, worker: undefined })
  const ownAgain = await transparent(b, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  const rebootAgain = await power(b, 'reboot').catch((e) => e)
  check('on its own login again while that call is inside: an XML call and a reboot are refused as before', refusedFor(ownAgain, 'held read') && refusedFor(rebootAgain, 'held read') && nativeWhileBorrowing === 0, `${ownAgain?.message ?? ownAgain} | ${rebootAgain?.message ?? rebootAgain}`)
  first.finish()
  await sleep(30)
  const after = await transparent(b, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  check('... until it returns: then the record is gone and a call goes out on its own login', _test.inside(b) === null && typeof after === 'string' && nativeWhileBorrowing === 1, `${JSON.stringify(_test.inside(b))} ${after?.message ?? 'ok'} native ${nativeWhileBorrowing}`)
  check('... nothing is left admitted or queued', await nothingLeft(b), `pending ${_test.pending()}`)
  restore()
}

// ---- a borrowed call (the command on the worker's login): what the merge with #16 decided for it
{
  _test.setCap(CAP)
  _test.setGap(10)
  const k = fakeNvr('xbk')
  const o = fakeNvr('xbo')
  let native = 0
  _test.setCall((opts, _u, _x, _url, outBuf, _s, len) => {
    if (opts.nvr === 'xbk') native++
    return Promise.resolve(answer(outBuf, len))
  })
  const insideDuring = [] // this process's record for xbk while the worker has the call
  let reply = () => ({ text: 'ok' })
  let asked = 0
  Object.assign(k, {
    online: false, userId: -1, borrowing: true, xmlOnline: true, xmlDegraded: false, xmlGen: 'worker:1:1',
    worker: {
      stats: () => ({ gen: 1 }),
      request: async (m) => {
        asked++
        insideDuring.push(_test.inside(k))
        const r = reply(m)
        if (r instanceof Error) throw r
        return r
      }
    }
  })
  // no record in this process, also when none is there yet
  const ok = await transparent(k, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  const okReboot = await power(k, 'reboot').catch((e) => e)
  check('a borrowed call takes no record in this process (none before, none while the worker has it, none after)', ok === 'ok' && okReboot === false && insideDuring.length === 2 && insideDuring.every((x) => x === null) && _test.inside(k) === null && native === 0, `${ok?.message ?? ok}; during ${JSON.stringify(insideDuring)}`)
  // the worker's own record refuses (its 503): the wording and the retry hint reach this process's caller, for a read and for a reboot
  reply = () => Object.assign(new Error('NVR xbk is still answering an earlier request (clock, 12 s so far); nothing was sent. Try again shortly'), { status: 503, extra: { retryAfterS: 30 } })
  const wRead = await transparent(k, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  const wReboot = await power(k, 'reboot').catch((e) => e)
  check('the worker\'s "still answering" refusal comes through whole (503, retryAfterS, its wording), for a read and a reboot', refusedFor(wRead, 'clock') && wRead.extra.retryAfterS === 30 && refusedFor(wReboot, 'clock') && wReboot.extra.retryAfterS === 30, `${wRead?.message} | ${wReboot?.message}`)
  // a borrowed read that times out counts for the read breaker
  reply = () => Object.assign(new Error('the video connection did not answer in time'), { name: 'SdkTimeout' })
  const t1 = await transparent(k, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  const t2 = await transparent(k, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  const before = asked
  const t3 = await transparent(k, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  check('two borrowed reads in a row that time out open the read breaker: the third is not sent to the worker', t1?.name === 'SdkTimeout' && t2?.name === 'SdkTimeout' && t3 instanceof HttpError && t3.status === 503 && /did not answer 2 settings reads in time/.test(t3.message) && asked === before, `${t1?.name} ${t2?.name} ${t3?.message ?? t3}; asked ${asked - before}`)
  // a borrowed reboot does not keep the process-wide turn while the worker answers
  let letGo = () => {}
  k.worker.request = () => new Promise((r) => (letGo = () => r({ accepted: true })))
  const slowReboot = power(k, 'reboot').catch((e) => e)
  await sleep(30)
  const other = await within(transparent(o, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e), 1000)
  check('another NVR is not held up while the worker answers a reboot', typeof other === 'string', `${other?.message ?? 'ok'}`)
  letGo()
  check('... and the reboot\'s answer still arrives', (await within(slowReboot, 1000)) === true)
  check('... nothing is left admitted or queued', await nothingLeft(k, o), `pending ${_test.pending()}`)
  restore()
}

// ---- power(): the record is cleared on a native error in time and on a throw (only a time-out holds it)
{
  _test.setCap(CAP)
  _test.setGap(10)
  const e = fakeNvr('xpe')
  _test.setCall((_opts, _u, _x, _url, outBuf, _s, len) => Promise.resolve(answer(outBuf, len)))
  _test.setPower(() => Promise.reject(new Error('native boom')))
  const r1 = await power(e, 'reboot').catch((x) => x)
  const left1 = _test.inside(e)
  _test.setPower(() => {
    throw new Error('stand-in boom')
  })
  const r2 = await power(e, 'shutdown').catch((x) => x)
  const left2 = _test.inside(e)
  const after = await transparent(e, 'queryChlVideoParam', '<x/>', 'after').catch((x) => x)
  check('power(): a native error in time and a synchronous throw both clear the record; the next call goes out', r1?.message === 'native boom' && left1 === null && r2?.message === 'stand-in boom' && left2 === null && typeof after === 'string', `${r1?.message} ${JSON.stringify(left1)} | ${r2?.message} ${JSON.stringify(left2)} | ${after?.message ?? 'ok'}`)
  check('... nothing is left admitted or queued', await nothingLeft(e), `pending ${_test.pending()}`)
  restore()
}

// ---- the read breaker and a borrowed read: only a time-out counts, only an answer starts the count
// over. Whatever else the worker comes back with (turned away with nothing sent, in each of the ways
// it does that; the worker lost with the request out) is not known to be a read that came back from
// the NVR, and leaves the count as it is, as this process's own refusals do.
{
  _test.setCap(CAP)
  _test.setGap(10)
  /** An NVR on a borrowed login whose worker gives these replies in turn (then 'ok'), and how often it was asked. */
  const borrowing = (id, replies) => {
    const n = fakeNvr(id)
    const box = { nvr: n, asked: 0 }
    Object.assign(n, {
      online: false, userId: -1, borrowing: true, xmlOnline: true, xmlDegraded: false, xmlGen: 'worker:1:1',
      worker: {
        stats: () => ({ gen: 1 }),
        request: async () => {
          const x = (replies[box.asked++] ?? (() => ({ text: 'ok' })))()
          if (x instanceof Error) throw x
          return x
        }
      }
    })
    return box
  }
  const timesOut = () => Object.assign(new Error('the video connection did not answer in time'), { name: 'SdkTimeout' })
  const read = (n) => transparent(n, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  const refusedByBreaker = (e) => e instanceof HttpError && e.status === 503 && /did not answer 2 settings reads in time/.test(e.message)

  const r = borrowing('xbr', [
    timesOut,
    () => Object.assign(new Error('NVR xbr is still answering an earlier request (clock, 3 s so far); nothing was sent. Try again shortly'), { status: 503, extra: { retryAfterS: 30 } }),
    () => Object.assign(new Error('the video connection is not ready; nothing was sent'), { name: 'WorkerNotReady' }),
    () => new Error('NVR xbr reconnected; nothing was sent'),
    () => new Error('not started: the worker is stopping'),
    () => Object.assign(new Error('the video connection was lost; try again'), { name: 'WorkerLost' }),
    // (an error the worker passed on: the NVR's own refusal of the request. On this process's own
    // login that one starts the count over, see the next block; through the worker it is not told
    // apart from the others)
    () => new Error('the NVR did not accept the request (no permission)'),
    timesOut
  ])
  const got = []
  for (let i = 0; i < 8; i++) got.push(await read(r.nvr))
  const next = await read(r.nvr)
  check('a borrowed read: each of the worker\'s outcomes reaches the caller as it was given', got[0]?.name === 'SdkTimeout' && got[1]?.status === 503 && got[2]?.name === 'WorkerNotReady' && /reconnected; nothing was sent/.test(got[3]?.message) && /the worker is stopping/.test(got[4]?.message) && got[5]?.name === 'WorkerLost' && /did not accept the request/.test(got[6]?.message) && got[7]?.name === 'SdkTimeout', got.map((e) => (e?.status ? `${e.status}` : (e?.name ?? 'ok'))).join(' | '))
  check('a time-out, six outcomes that are not an answer, a time-out: the breaker is open, and the next read is refused here, not sent', refusedByBreaker(next) && r.asked === 8, `${next?.status} ${next?.message ?? next}; asked ${r.asked}`)

  const a = borrowing('xba', [timesOut, () => ({ text: 'an answer' }), timesOut])
  const got2 = [await read(a.nvr), await read(a.nvr), await read(a.nvr)]
  const next2 = await read(a.nvr)
  check('a time-out, an ANSWER, a time-out: the answer started the count over, and the next read is sent', got2[0]?.name === 'SdkTimeout' && got2[1] === 'an answer' && got2[2]?.name === 'SdkTimeout' && next2 === 'ok' && a.asked === 4, `${got2.map((e) => e?.name ?? e).join(' | ')} | ${next2?.message ?? next2}; asked ${a.asked}`)

  // the breaker opens again after it has closed, on a borrowed login as on the NVR's own
  let clock = Date.UTC(2026, 9, 6, 12, 0, 0)
  _test.setNow(() => clock)
  const c = borrowing('xbc', [timesOut, timesOut, timesOut, timesOut])
  const open1 = [await read(c.nvr), await read(c.nvr), await read(c.nvr)]
  clock += 61_000
  const open2 = [await read(c.nvr), await read(c.nvr), await read(c.nvr)]
  check('a borrowed login: two time-outs open the breaker, and two more after it has closed open it again', open1[0]?.name === 'SdkTimeout' && open1[1]?.name === 'SdkTimeout' && refusedByBreaker(open1[2]) && open2[0]?.name === 'SdkTimeout' && open2[1]?.name === 'SdkTimeout' && refusedByBreaker(open2[2]) && c.asked === 4, `${[...open1, ...open2].map((e) => e?.status ?? e?.name ?? e).join(' | ')}; asked ${c.asked}`)
  _test.setNow(null)
  check('... nothing is left admitted or queued', await nothingLeft(r.nvr, a.nvr, c.nvr), `pending ${_test.pending()}`)
  restore()
}

// ---- ... and on this process's own login an error IN TIME does start the count over: there it is
// known to be the NVR's answer (it did not accept the request), and an NVR that answers is not one
// to stop asking. This is the one place the two paths differ.
{
  _test.setCap(CAP)
  _test.setGap(10)
  const n = fakeNvr('xoe')
  const sent = []
  const late = (ms) => ({ async: (...args) => setTimeout(() => args.at(-1)(null, true), ms) })
  _test.setCall((opts, userId, xml, url, outBuf, size, len) => {
    sent.push(opts.tag)
    if (opts.tag === 'times out') return sdkCallT({ ...opts, timeoutMs: 50 }, late(150), userId, xml, url, outBuf, size, len)
    if (opts.tag === 'not accepted') return Promise.resolve(false)
    if (opts.tag === 'fails') return Promise.reject(new Error('the call failed in the SDK'))
    return Promise.resolve(answer(outBuf, len))
  })
  const read = (tag) => transparent(n, 'queryChlVideoParam', '<x/>', tag).catch((e) => e)
  // (each read waits for the one before to have come back, late: see the first breaker block)
  const t1 = await read('times out')
  await sleep(200)
  const no = await read('not accepted')
  const t2 = await read('times out')
  await sleep(200)
  const after = await read('next')
  check('own login: a time-out, a request the NVR did not accept (in time), a time-out: the count started over, and the next read is sent', t1?.name === 'SdkTimeout' && no instanceof Error && no.name !== 'SdkTimeout' && !(no instanceof HttpError && no.status === 503) && t2?.name === 'SdkTimeout' && typeof after === 'string' && sent.join() === 'times out,not accepted,times out,next', `${t1?.name} | ${no?.message ?? no} | ${t2?.name} | ${after?.message ?? 'sent'}; sent ${sent.join()}`)
  // (the same for a call that came back in time with an error of the SDK's own, thrown and not returned)
  const g = fakeNvr('xog')
  const v1 = await transparent(g, 'queryChlVideoParam', '<x/>', 'times out').catch((e) => e)
  await sleep(200)
  const failed = await transparent(g, 'queryChlVideoParam', '<x/>', 'fails').catch((e) => e)
  const v2 = await transparent(g, 'queryChlVideoParam', '<x/>', 'times out').catch((e) => e)
  await sleep(200)
  const afterFailed = await transparent(g, 'queryChlVideoParam', '<x/>', 'next').catch((e) => e)
  check('own login: a time-out, a call that failed in time, a time-out: the count started over, and the next read is sent', v1?.name === 'SdkTimeout' && failed?.message === 'the call failed in the SDK' && v2?.name === 'SdkTimeout' && typeof afterFailed === 'string', `${v1?.name} | ${failed?.message ?? failed} | ${v2?.name} | ${afterFailed?.message ?? 'sent'}`)
  // (and without the error between them the same two time-outs do open it: the checks above are not passing for want of a breaker)
  const m = fakeNvr('xof')
  const u1 = await transparent(m, 'queryChlVideoParam', '<x/>', 'times out').catch((e) => e)
  await sleep(200)
  const u2 = await transparent(m, 'queryChlVideoParam', '<x/>', 'times out').catch((e) => e)
  await sleep(200)
  const refused = await transparent(m, 'queryChlVideoParam', '<x/>', 'next').catch((e) => e)
  check('... while two time-outs with nothing between them open it', u1?.name === 'SdkTimeout' && u2?.name === 'SdkTimeout' && refused instanceof HttpError && refused.status === 503 && /did not answer 2 settings reads in time/.test(refused.message), `${u1?.name} | ${u2?.name} | ${refused?.message ?? 'sent'}`)
  check('... nothing is left admitted or queued', await nothingLeft(n, g, m), `pending ${_test.pending()}`)
  restore()
}

// ---- a borrowed call keeps no gap behind it. The gap between two calls is for the SDK of this
// process (a burst of fast native calls), and a borrowed call never entered it.
{
  _test.setCap(CAP)
  const GAP = 1500 // long, so that a gap kept shows; "at once" is a third of it
  _test.setGap(GAP)
  _test.setCall((_opts, _u, _x, _url, outBuf, _s, len) => Promise.resolve(answer(outBuf, len)))
  const g = fakeNvr('xbg')
  const [o1, o2] = ['xbg1', 'xbg2'].map(fakeNvr)
  Object.assign(g, { online: false, userId: -1, borrowing: true, xmlOnline: true, xmlDegraded: false, xmlGen: 'worker:1:1', worker: { stats: () => ({ gen: 1 }), request: async () => ({ text: 'from the worker' }) } })
  const viaWorker = await transparent(g, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  const t0 = Date.now()
  const after = await within(transparent(o1, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e), 2 * GAP)
  const afterMs = Date.now() - t0
  check('after a borrowed call another NVR\'s call goes out at once: no gap is kept behind it', viaWorker === 'from the worker' && typeof after === 'string' && afterMs < GAP / 3, `${afterMs} ms (a gap is ${GAP})`)
  // (and the gap is there to be kept: behind that call, which did enter this process's SDK)
  const t1 = Date.now()
  const behind = await within(transparent(o2, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e), 2 * GAP)
  const behindMs = Date.now() - t1
  check('... while behind a call on this process\'s own login the gap is kept', typeof behind === 'string' && behindMs >= GAP / 2, `${behindMs} ms`)
  check('... nothing is left admitted or queued', await nothingLeft(g, o1, o2), `pending ${_test.pending()}`)
  restore()
}

// ---- notAfter: a command that waited past its time to be sent is not sent.
// A request handed to a worker can sit in the worker's lane (held behind a late call) long after the
// main process stopped waiting for it. Sent then, a clock write would set a stale time and a reboot
// would arrive minutes after the admin was told it had failed.
{
  _test.setNow(null)
  _test.resetBreakers()
  _test.setCap(null)
  let native = 0
  _test.setCall(async (_opts, _userId, _xml, _url, outBuf, _size, len) => {
    native++
    return answer(outBuf, len)
  })
  const n = fakeNvr('xd')
  const late = await transparent(n, 'editTimeCfg', '<request/>', 'clock write', { notAfter: Date.now() - 1 }).catch((e) => e)
  check('notAfter: a command past its time is refused, nothing sent', late instanceof Error && /waited too long to be sent; nothing was sent/.test(late.message) && native === 0, late?.message)
  check('notAfter: and it leaves no record of being inside the SDK', _test.inside(n) === null)
  const inTime = await transparent(n, 'queryTimeCfg', '<request/>', 'clock', { notAfter: Date.now() + 60_000 }).catch((e) => e)
  check('notAfter: a command in time is sent', native === 1 && typeof inTime === 'string', inTime?.message)
  const none = await transparent(n, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  check('notAfter: one with no time named is sent as always', native === 2 && typeof none === 'string', none?.message)

  let powered = 0
  _test.setPower(async () => {
    powered++
    return true
  })
  const latePower = await power(n, 'reboot', { notAfter: Date.now() - 1 }).catch((e) => e)
  check('notAfter: a reboot past its time is refused, nothing sent', /waited too long to be sent; nothing was sent/.test(latePower?.message ?? '') && powered === 0 && _test.inside(n) === null, latePower?.message ?? String(latePower))
  const powerInTime = await power(n, 'reboot', { notAfter: Date.now() + 60_000 }).catch((e) => e)
  check('notAfter: a reboot in time is sent', powerInTime === true && powered === 1, powerInTime?.message)

  // through the worker: the request says by when it must have been sent (the cap: after that the
  // main process's queue has moved on)
  const sent = []
  const w = fakeNvr('xe')
  Object.assign(w, {
    online: false, userId: -1, borrowing: true, xmlOnline: true, xmlDegraded: false, xmlGen: 'worker:1:5',
    worker: {
      stats: () => ({ gen: 5 }),
      request: async (m) => {
        sent.push(m)
        return m.op === 'power' ? { ok: true, accepted: true } : { ok: true, text: '' }
      }
    }
  })
  const t0 = Date.now()
  await transparent(w, 'editTimeCfg', '<request/>', 'clock write')
  check('notAfter: a borrowed command tells the worker by when to send it', sent[0]?.notAfter >= t0 + 90_000 && sent[0]?.notAfter <= Date.now() + 90_000, String(sent[0]?.notAfter - t0))
  await power(w, 'reboot')
  check('notAfter: and so does a borrowed reboot', sent[1]?.op === 'power' && sent[1]?.notAfter >= t0 + 90_000 && sent[1]?.notAfter <= Date.now() + 90_000, String(sent[1]?.notAfter - t0))
  _test.setPower(null)
}

check('at the end of the file nothing is left admitted', _test.pending() === 0, `pending ${_test.pending()}`)
ranToEnd = true
_test.setCall(null)
_test.resetBreakers()
print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
