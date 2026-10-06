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

// ---- one native XML or power call per NVR inside the SDK -------------------------------------------
// The audit's finding H1. The cap on waiting (90 s) released the per-NVR queue and the process-wide
// turn whether or not the native call had returned, and the native call carried no exclusive key: once
// a call had been inside the SDK for 90 s, the next XML call for the SAME NVR started on the same
// login beside it (overlapping SDK calls have corrupted the heap). A reboot or shutdown had the same
// exposure. The blocks below shorten the cap and the gap, and each uses an NVR id of its own (the
// record and the read breaker go by id).
const CAP = 300 // the shortened cap (ms): the time limits (50-150 ms) and the waits are set well apart from it
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
  const [d, o] = ['xd', 'xo'].map(fakeNvr)
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
  const pFirst = transparent(d, 'queryChlVideoParam', '<x/>', 'first read').catch((e) => e)
  await sleep(20)
  await otherNvrAnswers() // (after the first read started: from here the SDK does not count as stuck)
  let secondAt = 0
  const pSecond = transparent(d, 'queryChlVideoParam', '<x/>', 'second read').catch((e) => e).then((x) => ((secondAt = Date.now() - t0), x))
  const e1 = await pFirst
  check('setup: xd\'s read is past its time limit and still inside the SDK, on record; the SDK is not stuck', e1?.name === 'SdkTimeout' && lateCalls('xd') === 1 && _test.inside(d)?.what === 'first read' && _test.inside(d)?.held === false && sdkStuck() === false, `${e1?.name ?? e1}; ${lateCalls('xd')} late; record ${JSON.stringify(_test.inside(d))}; stuck ${sdkStuck()}`)
  const pOther = transparent(o, 'queryChlVideoParam', '<x/>', 'other NVR').catch((e) => e)
  // (within: if the cap ever stopped passing the queue or the turn on, these two would wait for ever)
  const second = await within(pSecond, 2000)
  const other = await within(pOther, 1000)
  check('... and still not stuck once the cap has passed (so the refusal below is the record\'s)', sdkStuck() === false)
  check('the call queued behind it is refused when the cap passes (503, nothing sent), not started beside it', refusedFor(second, 'first read') && secondAt >= CAP - 30 && !sent.includes('xd second read'), `${second?.status ?? 'sent'} ${second?.message ?? ''} at ${secondAt} ms`)
  check('... and gave its place back at once, with the first call still inside (nothing of xd queued, no call admitted)', (await gaveBack(d)) && _test.inside(d)?.what === 'first read', `pending ${_test.pending()}; record ${JSON.stringify(_test.inside(d))}`)
  check('... never 2 calls of xd inside the SDK at once', count.peak('xd') === 1 && count.now('xd') === 1, `peak ${count.peak('xd')}; sent: ${sent.join(', ')}`)
  check('... while another NVR\'s call IS served when the cap passes: it frees the queue and the turn', typeof other === 'string' && sent.includes('xo other NVR') && count.now('xd') === 1, `${other?.message ?? 'ok'}; sent: ${sent.join(', ')}`)
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
{
  _test.setCap(CAP)
  _test.setGap(10)
  const w = { ...fakeNvr('xw'), lane: new Lane('xw', 2) }
  const o = fakeNvr('xwo')
  const stuck = [heldNative(), heldNative()]
  const late = stuck.map((f, i) => sdkCallT({ nvr: 'xw', tag: `playback search ${i}`, timeoutMs: 50 }, f.fn).catch(() => {}))
  await sleep(100)
  await otherNvrAnswers()
  const count = insideCounter()
  const sent = [] // "nvr tag", as the stand-in is entered
  const first = heldNative(() => count.leave('xw'))
  _test.setCall((opts, userId, xml, url, outBuf, size, len) => {
    sent.push(`${opts.nvr} ${opts.tag}`)
    count.enter(opts.nvr)
    // x0 stays inside the SDK until told to return: past its 50 ms time limit, then past the cap
    if (opts.tag === 'x0') return sdkCallT({ ...opts, timeoutMs: 50 }, first.fn, userId, xml, url, outBuf, size, len)
    count.leave(opts.nvr)
    return Promise.resolve(answer(outBuf, len))
  })
  const setup = lateCalls('xw') === 2 && sdkStuck() === false
  const ps = ['x0', 'x1', 'x2'].map((tag) => transparent(w, 'queryChlVideoParam', '<x/>', tag).catch((e) => e))
  // each call's cap frees the per-NVR queue for the next while it waits for the lane: 3 caps on (waited
  // for, not timed: three timers in a row run late on a busy machine), all three are in the lane's queue
  const allInLane = () => w.lane.pending === 3 && _test.pending() === 0
  const giveUp = Date.now() + 5000
  while (!allInLane() && Date.now() < giveUp) await sleep(20)
  check('setup: xw\'s lane is held by 2 late calls; its 3 XML calls all wait in the lane, none in the per-NVR queue, nothing sent', setup && allInLane() && w.lane.running === 0 && sent.length === 0, `${lateCalls('xw')} late; lane ${w.lane.running} running, ${w.lane.pending} waiting; pending ${_test.pending()}; sent: ${sent.join(', ')}`)
  // the late calls return: the lane runs x0 and x1 at once. x0 takes the turn and goes inside; x1 waits for the turn
  for (const f of stuck) f.finish()
  await Promise.all(late)
  await sleep(20)
  await otherNvrAnswers() // (after x0 started: from here the SDK does not count as stuck)
  const rs = [await within(ps[0], 2000), await within(ps[1], 2000), await within(ps[2], 2000)]
  const back = await gaveBack(w)
  const tTurn = Date.now()
  const other = await within(transparent(o, 'queryChlVideoParam', '<x/>', 'other NVR').catch((e) => e), 1000)
  const turnMs = Date.now() - tTurn
  check('x0 runs past its time limit inside the SDK; x1 and x2 are refused when its cap passes (503, nothing sent), by the record and not for a stuck SDK', sdkStuck() === false && rs[0]?.name === 'SdkTimeout' && refusedFor(rs[1], 'x0') && refusedFor(rs[2], 'x0') && _test.inside(w)?.held === true, `${rs.map((x) => (x?.name === 'SdkTimeout' ? x.name : (x?.message ?? 'sent'))).join(' | ')}; stuck ${sdkStuck()}`)
  check('... never 2 calls of xw inside the SDK at once', count.peak('xw') === 1 && count.now('xw') === 1 && sent.filter((s) => s.startsWith('xw ')).length === 1, `peak ${count.peak('xw')}; sent: ${sent.join(', ')}`)
  check('... the refused calls gave everything back at once: the lane is idle, nothing queued or admitted, another NVR\'s call is served at once', back && w.lane.running === 0 && w.lane.pending === 0 && typeof other === 'string' && turnMs < AT_ONCE, `gave back ${back}; lane ${w.lane.running} running, ${w.lane.pending} waiting; other NVR ${other?.message ?? 'served'} in ${turnMs} ms`)
  first.finish()
  const next = await transparent(w, 'queryChlVideoParam', '<x/>', 'next').catch((e) => e)
  check('once x0 has returned (late), the record is gone and the next call to xw goes out', _test.inside(w) === null && typeof next === 'string' && sent.at(-1) === 'xw next' && count.peak('xw') === 1, `${next?.message ?? 'ok'}; record ${JSON.stringify(_test.inside(w))}`)
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

check('at the end of the file nothing is left admitted', _test.pending() === 0, `pending ${_test.pending()}`)
ranToEnd = true
_test.setCall(null)
_test.resetBreakers()
print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
