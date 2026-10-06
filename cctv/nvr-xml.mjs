// The NVR web client's XML commands, sent over the logged-in SDK connection with
// NET_SDK_TransparentConfig (strUrl = the command name, sendXML = the whole <request>
// document, no web token needed). Shared by substreams.mjs, imaging.mjs, lens.mjs and
// streams.mjs, together with the per-NVR lock and the change-log helpers they use.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { PRIORITY } from './lanes.mjs'
import { NET_SDK, lastErrorReason, lateCalls, sdkCallT, sdkStuck } from './sdk.mjs'
import { kid, parseXml } from './xml.mjs'
import { xmlDegraded, xmlGen, xmlOnline } from './xml-session.mjs'
// The parser itself lives in xml.mjs, which imports nothing: modules that only read an NVR's
// answer can use it without loading the native SDK. Re-exported here so nothing else had to change.
export { XML_HEADER, esc, kid, kids, parseXml } from './xml.mjs'

export class HttpError extends Error {
  /** @param {number} status @param {string} message @param {object} [extra] fields added to the JSON answer (e.g. needsAck) */
  constructor(status, message, extra) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

/** { response, status, errorCode, reboot } of any NVR answer. */
export function parseAnswer(xml) {
  const response = kid(parseXml(xml), 'response')
  if (!response) throw new Error('bad answer from the NVR (no <response>)')
  return {
    response,
    status: kid(response, 'status')?.text.trim() ?? '',
    errorCode: kid(response, 'errorCode')?.text.trim() ?? '',
    reboot: kid(response, 'rebootParam')?.text.trim() ?? ''
  }
}

/**
 * Every leaf under a camera's <chl>: dotted path -> trimmed text, e.g. "sharpen.value" -> "199".
 * cfgFile (which profile the answer is for) and the schedule's list of choices are left out.
 * Used to find side effects of a change and differences between profiles.
 */
export function leafMap(chl) {
  const out = new Map()
  const walk = (node, prefix) => {
    const seen = new Map()
    for (const c of node.children) {
      const n = (seen.get(c.name) ?? 0) + 1
      seen.set(c.name, n)
      const path = `${prefix}${c.name}${n > 1 ? `[${n}]` : ''}`
      if (path === 'cfgFile' || path === 'scheduleInfo.types') continue
      if (c.children.length) walk(c, `${path}.`)
      else out.set(path, c.text.trim())
    }
  }
  if (chl) walk(chl, '')
  return out
}

/**
 * Which device an NVR really is: change logs are tied to this, not just the NVR's id in the
 * app. NVRs reached by serial number all share the P2P relay's address, so their serial is it.
 */
export const deviceOf = (nvr) => (nvr.cfg.sn ? `sn:${nvr.cfg.sn}` : `${nvr.cfg.host}:${nvr.cfg.port}`)

/** A channel's id in the NVR's XML: "{0000000N-0000-...}" with N = 0-based channel + 1, in hex. */
export const chlIdOf = (ch) => `{${(ch + 1).toString(16).toUpperCase().padStart(8, '0')}-0000-0000-0000-000000000000}`

/** The NVR and camera an admin route names, or 404. */
export function cameraOf(nvrs, nvrId, ch) {
  const nvr = nvrs.get(nvrId)
  if (!nvr) throw new HttpError(404, 'No such NVR')
  if (!Number.isInteger(ch) || ch < 0 || ch > 255 || !nvr.channels.some((c) => c.ch === ch)) throw new HttpError(404, 'No such camera on this NVR')
  return { nvr, chlId: chlIdOf(ch), name: nvr.channels.find((c) => c.ch === ch)?.name ?? `Camera ${ch + 1}` }
}

/** Refuses (409) unless an XML command can be sent to the NVR and its session is not recovering. */
export function requireOnline(nvr) {
  if (!xmlOnline(nvr)) throw new HttpError(409, `${nvr.name} is ${nvr.status}; try again when it is online`)
  if (xmlDegraded(nvr)) throw new HttpError(409, `${nvr.name} is busy or recovering; try again in a minute`)
}

/** [status, body] for an error thrown by a handler. */
export function errorAnswer(e) {
  if (e instanceof HttpError) return [e.status, { error: e.message, ...(e.extra ?? {}) }]
  if (e instanceof SyntaxError) return [400, { error: 'Bad JSON' }]
  return [502, { error: e.message }]
}

// ---- one XML call at a time per NVR ------------------------------------------------------
//
// Two things do this, and they are kept apart on purpose: a queue that callers wait in, and a
// record of the call that is inside the SDK.
//
// The queue (xmlTails). XML calls to one NVR go out one at a time, in order: a call waits for
// the one before it to return from the SDK, also after that one's time limit (onLate), but for
// at most XML_CAP_MS. The cap bounds how long callers wait and nothing else: when it passes it
// frees this queue and the process-wide turn (below), so the calls behind stop waiting and
// other NVRs' calls go on. It does not say that the call has left the SDK. The queue sits
// OUTSIDE the lane on purpose: the session check inside lane.run stays the last thing before
// the native call, so a call queued behind a slow one can never go out on a login that was
// logged out meanwhile (the SDK reuses login ids). It also keeps a queued call from holding one
// of the NVR's two lane slots while it waits, which would block live video.
//
// The record (xmlInside). This is what protects the SDK. Per NVR id it names the one native XML
// or power call (TransparentConfig, reboot, shutdown) that is inside the SDK. A call is entered
// in the same synchronous step that hands its native call to sdkCallT, right after the session
// check, and is refused (503, nothing sent) if another one is there. The record is cleared only
// when that native call has really returned or was never started: an answer in time, a native
// error in time, koffi refusing the arguments, and after a time-out only when the call comes
// back (onLate). No timer clears it, the cap least of all, and no relogin: it goes by the NVR's
// id, not by the Nvr object or the login, so it outlives both.
// The queue alone used to stand for both, and the cap broke it: once a call had been inside the
// SDK for 90 s, the next XML call for the same NVR was let go and started on the same login
// beside it, and overlapping SDK calls have corrupted the heap (sdk.mjs `exclusive`). A reboot
// was worse off: it passed the turn at its own 10 s time limit with nothing to hold the next
// XML call back. Now, when the cap passes with the call still inside (for a reboot: when its
// time limit does), the record is marked held: the calls queued behind it are refused as they
// come out of the queue, and every later XML call (reads and changes alike), reboot and
// shutdown of that NVR at the door, until it returns. That is for as long as it takes, also
// for a healthy call whose own time limit is longer than the cap (transparent's timeoutMs): it
// still gets its answer. If it never returns, that NVR's settings and reboot stay refused until
// the service is restarted, which is right: the call is still inside. Nothing restarts it by
// itself while the other NVRs keep answering: the watchdog then leaves the process alone on
// purpose (watchdog.mjs: one NVR's stuck call is no evidence while calls to others come back),
// and nvrs.mjs declines a relogin while the call is late. The "still inside the SDK" line in
// the log and the 503 texts say what is going on; someone then has to restart the service.
//
// Backstop: the native calls also carry sdk.mjs's exclusive key `${id}/xml`. With a correct
// record it is never contended. sdk.mjs frees the key in the native call's own callback: on a
// return in time before the record is cleared (that follows a few promise ticks later, when the
// caller's wait ends), on a late return right after it, in the same synchronous callback (onLate
// clears the record, then the key goes). Either way the key is free before another call to this
// NVR can get as far as its native call, so nothing ever waits on it. If the record logic were
// ever wrong, the key turns an overlap into a wait. That is better than two calls on one login,
// but it is not harmless:
//  - the waiting call is already past its session check, so it starts later on the login id it
//    read before the wait, even if that login was logged out meanwhile (a logout waits for the
//    key for 30 s at most);
//  - no time limit runs while it waits (sdk.mjs starts it with the native call), so its caller
//    and its lane slot wait for as long as the other call stays inside. An XML call's cap still
//    passes the queue and the turn on; a reboot or shutdown has no cap, and keeps the
//    process-wide turn, i.e. every NVR's XML calls, for that long;
//  - nothing logs that a call waited on the key (sdk.mjs would have to; it does not yet).
// So the key is the last line only, not a second queue: the record has to stay right.
// The key also lets a logout see these calls (nvrs.mjs waits for the keys under `${id}/`, for as
// long as it already waited for this queue).
//
// What this does NOT cover: other kinds of SDK call on the same login (the camera list, clock
// reads, playback searches and starts) still run beside an XML call, since the NVR's lane lets
// two run at once; and a logout, after its own bounded wait, can still run under a call that is
// inside the SDK.

const xmlTails = new WeakMap() // nvr -> promise that settles when nothing need wait for its last queued XML call any more: it returned from the SDK, nothing was sent, or the cap passed
const XML_CAP_MS = 90_000 // the longest callers wait behind one call: never block the queue and the turn for ever. It lets nothing into the SDK (xmlInside does that), and nothing ends a call stuck longer: while other NVRs answer, the watchdog leaves the process alone (see above)
let capMs = XML_CAP_MS // (tests shorten it: _test.setCap)

// ---- and one at a time in the whole process, paced, with a short queue -------------------
//
// The SDK runs one call at a time for every NVR, so a burst of XML calls (the page that reads
// every camera's picture settings: 87 reads, still running at 04:11 next to the call that got the
// service restarted) only queues inside it, where every other NVR's control calls wait behind it.
// So: one XML call in flight in this process, and the next starts only once the previous one has
// returned and at least XML_GAP_MS after it started (slow calls run back to back, a burst of fast
// ones goes out at 4 a second; the NVR disk reads, 3 per NVR, still fit their 8 s). At most
// XML_MAX_WAITING calls wait; a read beyond that is answered "busy" at once. Reads (query...,
// get..., search...) to an NVR that has let two of them in a row run past their time limit are
// refused for XML_READ_BREAKER_MS (other failures are answers, e.g. a probe of a command the
// firmware lacks, and do not count). Changes (edit...) are never turned away by the queue length
// or the breaker: an admin is waiting on each one, and the change lock allows one per NVR.
// Nothing is queued at all while the SDK is stuck (sdk.mjs sdkStuck), nor for an NVR whose earlier
// call is held inside the SDK (xmlInside above): those two turn changes away as well, because they
// are about what the SDK can take, not about load. None of these refusals sends anything, so none
// counts towards the breaker.
// A call takes its process-wide turn only once its NVR's lane runs it, right before the native call
// (takeTurn). Taken earlier, a call waiting for its lane would keep every NVR's XML calls waiting:
// an NVR with two late calls holds its lane, e.g. for a disk read from nvr-disks (which checks only
// that the NVR is online), until those calls return or XML_CAP_MS passes, and every other NVR's
// settings pages would queue and then be turned away behind it. The price is that a call waiting for
// its turn keeps its lane slot meanwhile, as it used to while its native call queued inside the SDK
// behind the same calls; only one XML call per NVR gets that far (the per-NVR queue above), so the
// turns ahead of it are at most one call per other NVR.
const XML_GAP_MS = 250
const XML_MAX_WAITING = 10
const XML_READ_FAILS = 2 // timeouts in a row ...
const XML_READ_BREAKER_MS = 60_000 // ... and that NVR's reads are refused this long
const BUSY_RETRY_S = 5 // "try again" hint for a full queue
const STUCK_RETRY_S = 30 // ... and while the SDK is stuck
const INSIDE_RETRY_S = 30 // ... and while an earlier call to the same NVR is still inside the SDK

let gapMs = XML_GAP_MS // (tests that shorten every other timing shorten this too: _test.setGap)
let xmlGate = Promise.resolve() // settles once the last call to take its turn has returned and XML_GAP_MS has passed since it started
let xmlPending = 0 // admitted and not yet returned: the one in flight plus those waiting

/**
 * Waits for the process-wide turn: every call that took its turn earlier has returned, and the
 * last one to go out started at least gapMs ago. Resolves to done(sentAt), which passes the turn on
 * (sentAt: when this call's native call started, 0 if nothing was sent: then no gap is kept).
 */
async function takeTurn() {
  const before = xmlGate
  let done
  const finished = new Promise((r) => (done = r))
  xmlGate = before.then(() => finished).then((at) => (at ? sleep(Math.max(0, at + gapMs - Date.now())) : undefined))
  await before
  return done
}
const readFails = new Map() // nvr id -> { fails, openUntil }
let now = Date.now // (the tests' clock)
/** Whether a command only reads (NVMS-9000 web command names). */
export const isReadCommand = (url) => /^(query|get|search)/i.test(String(url))

// The record of the one native XML or power call per NVR that is inside the SDK (see "one XML call
// at a time per NVR" above for why, and for what clears it). There is no way to clear it from
// outside, on purpose, the tests included: they let their stand-in calls return.
const xmlInside = new Map() // nvr id -> { what, since, held }: by id, so it survives a relogin and a re-created Nvr object
/** sdk.mjs `exclusive` key of an NVR's XML and power calls: the backstop behind xmlInside. */
const xmlKey = (nvr) => `${nvr.id}/xml`
/** How long a call on record has been inside the SDK, in whole seconds. */
const insideS = (rec) => Math.round((Date.now() - rec.since) / 1000)

/** The refusal (503, nothing sent) while an earlier call to this NVR is still inside the SDK. */
const insideError = (nvr, rec) =>
  new HttpError(503, `${nvr.name} is still answering an earlier request (${rec.what}, ${insideS(rec)} s so far); nothing was sent. Try again shortly`, { retryAfterS: INSIDE_RETRY_S })

/**
 * Check and set in one synchronous step: throws the refusal if a call to this NVR is inside the
 * SDK, else records this one as inside and returns its record. It must be the last thing before
 * the native call, with nothing awaited in between (the session check comes right before it).
 * @param {{ id: string, name: string }} nvr
 * @param {string} what  the call's tag, for the refusal and the log
 */
function enterSdk(nvr, what) {
  const there = xmlInside.get(nvr.id)
  if (there) throw insideError(nvr, there)
  const rec = { what: what || 'a request', since: Date.now(), held: false }
  xmlInside.set(nvr.id, rec)
  return rec
}

/**
 * The native call has really returned, or was never started: its record goes. Only the call that
 * set a record clears it, and calling this twice is harmless. Nothing else may delete from xmlInside.
 */
function leaveSdk(nvr, rec) {
  if (xmlInside.get(nvr.id) !== rec) return
  xmlInside.delete(nvr.id)
  if (rec.held) console.warn(`[${nvr.id}] ${rec.what} returned from the SDK after ${insideS(rec)} s: XML calls to this NVR go out again`)
}

/**
 * Callers have stopped waiting for a call that is still inside the SDK (the cap passed, or a
 * reboot's time limit): from now on this NVR's calls are refused at the door (refuseHeld). Logged once.
 */
function holdSdk(nvr, rec) {
  if (rec.held || xmlInside.get(nvr.id) !== rec) return
  rec.held = true
  console.warn(`[${nvr.id}] ${rec.what} is still inside the SDK after ${insideS(rec)} s: XML calls to this NVR are refused until it returns`)
}

/** Refuses (503, nothing sent) while a call to this NVR that callers stopped waiting for is still inside the SDK. */
function refuseHeld(nvr) {
  const rec = xmlInside.get(nvr.id)
  if (rec?.held) throw insideError(nvr, rec)
}

/**
 * Refuses (503, nothing sent) while the SDK is stuck, while an earlier call to this NVR is held
 * inside the SDK (reads and changes alike), or reads while this NVR's read breaker is open.
 */
function refuseNow(nvr, read) {
  if (sdkStuck()) throw new HttpError(503, `The connection to the NVRs is stuck on an earlier call; nothing was sent. Try again in a minute`, { retryAfterS: STUCK_RETRY_S })
  // at the door, so a caller is not queued only to be refused at the last moment (enterSdk). Not while
  // the worker's login is borrowed: such a call enters no SDK of this process, so a call of this
  // NVR still inside it (held from before the control login was lost, say) is nothing it can run
  // beside, and the worker's login is the way round exactly that. The worker's own transparent()
  // keeps the record for the worker's SDK.
  if (nvr.borrowing !== true) refuseHeld(nvr)
  const b = readFails.get(nvr.id)
  if (read && b?.openUntil > now()) {
    const s = Math.ceil((b.openUntil - now()) / 1000)
    throw new HttpError(503, `${nvr.name} did not answer ${XML_READ_FAILS} settings reads in time; not asking it again for ${s} s`, { retryAfterS: s })
  }
}

/** A read came back (ok) or ran past its time limit (timeout): counts towards this NVR's breaker. */
function noteRead(nvr, timedOut) {
  if (!timedOut) return void readFails.delete(nvr.id)
  const b = readFails.get(nvr.id) ?? { fails: 0, openUntil: 0 }
  if (b.openUntil && b.openUntil <= now()) b.fails = 0 // (a closed breaker starts counting again)
  b.fails++
  if (b.fails >= XML_READ_FAILS) {
    b.openUntil = now() + XML_READ_BREAKER_MS
    console.warn(`[${nvr.id}] ${b.fails} settings reads in a row ran past their time limit: no reads to this NVR for ${XML_READ_BREAKER_MS / 1000} s`)
    b.fails = 0
  }
  readFails.set(nvr.id, b)
}

// replaced by the offline tests: (opts, userId, xml, url, out, outSize, len) => Promise<bool>
let call = (opts, ...args) => sdkCallT(opts, NET_SDK.TransparentConfig, ...args)
// ... and the reboot/shutdown call: (opts, action, userId) => Promise<bool>
const nativePower = (opts, action, userId) => sdkCallT(opts, action === 'shutdown' ? NET_SDK.ShutDownDVR : NET_SDK.RebootDVR, userId)
let powerCall = nativePower

/** No session of this process's own to send on (the worker's is borrowed, or there is none). */
const noOwnSession = (nvr) => nvr.borrowing !== true && nvr.userId < 0

/**
 * The same command on the worker's login (nvrs.mjs Nvr borrowing): the NVR refuses this process a
 * second one. The worker runs it through its own transparent() / power(), on its own lane. Errors
 * are marked viaWorker: no native call of this process is left running behind them, so the queue is
 * released at once even after a timeout. `write`: a change or a power command, whose loss with the
 * worker leaves it unknown whether the NVR acted.
 */
async function viaWorker(nvr, req, write) {
  try {
    return await nvr.worker.request({ ...req, gen: nvr.worker.stats()?.gen ?? null })
  } catch (e) {
    const err = e?.status ? new HttpError(e.status, e.message, e.extra ?? undefined) : e instanceof Error ? e : new Error(String(e))
    if (err.name === 'WorkerLost') err.message = write ? `${nvr.name}: the connection was lost; the change may or may not have been made` : `${nvr.name}: the connection was lost; try again`
    err.viaWorker = true
    throw err
  }
}

/**
 * Sends one command and returns the answer. Refuses (nothing sent) if the session changed
 * while the call waited its turn: `gen` is the session the caller's data came from. Refuses with
 * 503 while the SDK is stuck, while an earlier XML or power call to this NVR is still inside the
 * SDK after callers stopped waiting for it, while the process-wide queue is full (reads) and while
 * this NVR's read breaker is open (reads): see above.
 *
 * timeoutMs: the SDK time limit for this one call (sdk.mjs sdkCallT); left out, the command's own
 * default (budgetOf) applies. It may be longer than XML_CAP_MS, for a heavy read that rightly takes
 * minutes: the call still gets its answer, the cap still frees the queue and the process-wide turn
 * for other NVRs after 90 s, and this NVR's other XML calls are refused until it has returned.
 */
export async function transparent(nvr, url, xml, tag, { gen = xmlGen(nvr), outBytes = 256 * 1024, timeoutMs } = {}) {
  if (!xmlOnline(nvr) || noOwnSession(nvr)) throw new Error(`${nvr.name} is offline`)
  const read = isReadCommand(url)
  refuseNow(nvr, read)
  if (read && xmlPending > XML_MAX_WAITING) {
    throw new HttpError(503, `Too many NVR settings requests at once (${xmlPending - 1} waiting); nothing was sent. Try again shortly`, { retryAfterS: BUSY_RETRY_S })
  }
  const out = Buffer.alloc(outBytes)
  const len = Buffer.alloc(4)
  const prev = xmlTails.get(nvr) ?? Promise.resolve()
  let returned
  const mine = new Promise((r) => (returned = r)) // resolves once nothing need wait for this call any more: the native call has returned, nothing was sent, or the cap
  const tail = prev.then(() => mine)
  xmlTails.set(nvr, tail)
  tail.then(() => {
    if (xmlTails.get(nvr) === tail) xmlTails.delete(nvr)
  })
  xmlPending++
  mine.then(() => xmlPending--)
  await prev
  let sentAt = 0
  let passTurn = null // set while this call holds the process-wide turn (takeTurn)
  let cap = null
  let rec = null // this call's record of being inside the SDK (enterSdk): from right before the native call until done()
  // Callers stop waiting for this call: the per-NVR queue and the process-wide turn pass on. This
  // does NOT say that the call has left the SDK: only done() does, which clears the record first.
  const release = () => {
    clearTimeout(cap)
    returned()
    passTurn?.(sentAt)
    passTurn = null
  }
  // The native call has really returned, or nothing was sent. The record goes before the queues
  // are released, so whichever call is let through next finds it clear.
  const done = () => {
    if (rec) leaveSdk(nvr, rec)
    rec = null
    release()
  }
  // The cap: never block the queues for ever, from here while it waits for its lane, and again from
  // its process-wide turn. It frees the waiting only: a call still inside the SDK keeps its record,
  // marked held before the queues are released, so whichever call is let through next is refused
  // instead of started beside it. (Nothing ends such a call from here: see "If it never returns".)
  const capped = () => {
    if (rec) holdSdk(nvr, rec)
    release()
  }
  cap = setTimeout(capped, capMs)
  let text = null // the answer when it came from the worker (nothing is written to `out` then)
  let ok
  try {
    // things may have changed while it waited: the SDK stuck, the call before this one still inside it at its cap, the breaker opened
    refuseNow(nvr, read)
    ok = await nvr.lane.run(
      async () => {
        // the process-wide turn, only now that the lane runs this call (see takeTurn)
        passTurn = await takeTurn()
        clearTimeout(cap)
        cap = setTimeout(capped, capMs)
        // and once more after that wait
        refuseNow(nvr, read)
        // the session as it is when the call really starts: a relogin may have happened while it was
        // queued, or the path may have changed between this login and the worker's
        const borrowed = nvr.borrowing === true
        const userId = nvr.userId
        if ((!borrowed && userId < 0) || xmlGen(nvr) !== gen || nvr.stopped) throw new Error(`${nvr.name} reconnected; nothing was sent`)
        if (borrowed) {
          // nothing of this call enters this process's SDK, so it takes no record here (the worker
          // runs it through its own transparent(), which keeps the record for the worker's SDK), and
          // the process-wide turn is passed on at once (0: no native call started here, so no gap is
          // kept): other NVRs' XML calls must not wait out a round trip to this NVR's worker. This
          // NVR's own queue still holds until the answer is back, so the worker gets one request at
          // a time.
          sentAt = Date.now()
          passTurn?.(0)
          passTurn = null
          text = String((await viaWorker(nvr, { op: 'xml', url, xml, tag, outBytes }, !read)).text ?? '')
          return true
        }
        // From here to the native call nothing is awaited: the session check above, the record and
        // the call are one synchronous step.
        // on record as inside the SDK, or refused (503, nothing sent) because another call to this NVR is
        rec = enterSdk(nvr, tag || url)
        sentAt = Date.now()
        // exclusive: the backstop behind the record. The key is free whenever the record is, so sdkCallT
        // hands the call to the SDK a few promise ticks from here, before any timer or native return
        // can run; unless every native slot is taken (sdk.mjs MAX_NATIVE): then it waits in sdk.mjs's
        // own queue, as it always did, with its record and key set and its session check behind it.
        // It only ever waits on the key if the record logic is wrong. That is a wait instead of two
        // calls on one login, with no time limit running and the session check already done: see
        // "Backstop" above for what it costs.
        return call({ nvr: nvr.id, tag, exclusive: xmlKey(nvr), onLate: done, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, userId, xml, url, out, out.length, len)
      },
      { priority: PRIORITY.NORMAL }
    )
  } catch (e) {
    if (read && sentAt) noteRead(nvr, e?.name === 'SdkTimeout')
    // after a timeout the native call is still inside the SDK: its record stays, and the queues stay
    // held up to the cap, until onLate (done) says it has returned. Any other error: it has returned
    // or was never started (done clears its record), or nothing was sent (there is no record). A call
    // that went to the worker has no record here, so it releases at once, timed out or not: no native
    // call of this process is left running behind it.
    if (!(rec && e?.name === 'SdkTimeout')) done()
    throw e
  }
  done()
  if (read) noteRead(nvr, false)
  if (!ok) throw new Error(`the NVR did not accept the request (${await lastErrorReason('no reason given')})`)
  if (text !== null) return text
  // some answers end with stray NUL bytes
  return out.toString('utf8', 0, Math.min(len.readUInt32LE(0), out.length)).replace(/\0+$/, '')
}

/**
 * Reboot or power the NVR off (NET_SDK_RebootDVR / NET_SDK_ShutDownDVR), on its control login, or the
 * worker's while that is borrowed. One SDK call, taken on this NVR's lane and the process-wide turn
 * like the XML calls, and kept apart from them by the same record (xmlInside) and exclusive key, both
 * ways (overlapping SDK calls have corrupted the heap): it is refused (503, nothing sent) while an XML
 * or power call to this NVR is inside this process's SDK, and XML calls are refused while it is. The
 * turn passes when the caller's wait ends: at the latest when the 10 s time limit does, which sdk.mjs
 * counts from the start of the native call. There is no cap on that wait here as there is in
 * transparent(): were this call ever to wait on the exclusive key (only if the record logic is wrong,
 * see "Backstop" above), it would keep the process-wide turn, and with it every NVR's XML calls, until
 * the other call returns. The record stays until the native call has really returned (onLate), where
 * the turn alone used to let the next XML call onto the login beside it. A reboot sent through the
 * worker enters no SDK of this process and takes no record here: the worker's own power() keeps it.
 * The device drops right after, so there is nothing to read back: the boolean is only whether the
 * NVR accepted the command.
 * @param {import('./nvrs.mjs').Nvr} nvr
 * @param {'reboot'|'shutdown'} action
 * @returns {Promise<boolean>}
 */
export async function power(nvr, action) {
  if (!xmlOnline(nvr) || noOwnSession(nvr)) throw new Error(`${nvr.name} is offline`)
  // at the door, as refuseNow does for XML calls: no lane slot and no turn taken only to be refused
  // (not while the worker's login is borrowed: that call never enters this process's SDK)
  if (nvr.borrowing !== true) refuseHeld(nvr)
  const gen = xmlGen(nvr)
  return nvr.lane.run(
    async () => {
      const passTurn = await takeTurn()
      let rec = null // this call's record of being inside the SDK (enterSdk)
      let inside = false // it ran past its time limit and is still inside the SDK: only onLate clears the record
      try {
        const borrowed = nvr.borrowing === true
        const userId = nvr.userId
        if ((!borrowed && userId < 0) || xmlGen(nvr) !== gen || nvr.stopped) throw new Error(`${nvr.name} reconnected; nothing was sent`)
        if (borrowed) {
          passTurn() // as in transparent(): the turn is this process's SDK's, which this call never enters
          return Boolean((await viaWorker(nvr, { op: 'power', action }, true)).accepted)
        }
        // from here to the native call nothing is awaited, as in transparent()
        // on record as inside the SDK, or refused (503, nothing sent) because another call to this NVR is
        rec = enterSdk(nvr, action)
        // (exclusive: the backstop behind the record, see transparent())
        return Boolean(await powerCall({ nvr: nvr.id, tag: action, exclusive: xmlKey(nvr), onLate: () => leaveSdk(nvr, rec) }, action, userId))
      } catch (e) {
        inside = rec !== null && e?.name === 'SdkTimeout'
        throw e
      } finally {
        // before the turn passes: the record goes (the call has returned or was never started), or it is
        // marked held, so the XML call that takes the turn next is refused instead of started beside it
        if (rec && inside) holdSdk(nvr, rec)
        else if (rec) leaveSdk(nvr, rec)
        passTurn()
      }
    },
    { priority: PRIORITY.HIGH }
  )
}

/**
 * Waits (up to maxMs) until this NVR's XML queue is empty: no XML call to it is waiting its turn, and
 * none is inside the SDK within the cap. Resolves true if so. A call still inside the SDK after the
 * cap, and a reboot or shutdown, are not in the queue: a logout sees those through their exclusive
 * key (sdk.mjs exclusiveSettled), which it waits for as well.
 */
export async function xmlSettled(nvr, maxMs) {
  const until = Date.now() + maxMs
  for (;;) {
    const tail = xmlTails.get(nvr)
    if (!tail) return true
    const left = until - Date.now()
    if (left <= 0) return false
    let timer
    const done = await Promise.race([tail.then(() => true), new Promise((r) => (timer = setTimeout(() => r(false), left)))])
    clearTimeout(timer)
    if (!done) return false
    const now = xmlTails.get(nvr)
    if (!now || now === tail) return true // nothing new was queued behind it meanwhile
  }
}

/** Waits (up to a limit) for calls to this NVR that outlived their time limit to return. */
export async function settled(nvr, maxMs = 90_000) {
  const until = Date.now() + maxMs
  while (lateCalls(nvr.id) > 0 && Date.now() < until) await sleep(1000)
  return lateCalls(nvr.id) === 0
}

// ---- one change at a time per NVR -----------------------------------------------------------
//
// Picture, sub-stream, stream and lens changes share one lock per NVR: a change reads, checks,
// logs, sends and reads back, and none of that may interleave with another change to the same
// NVR. It is held for the whole change, including the wait for a camera restart (up to 3 min).

const locks = new Map() // nvr id -> { what, since, note }
const hhmm = (t) => new Date(t).toTimeString().slice(0, 5)

/**
 * Runs fn(lock) holding the NVR's change lock, or throws 409 at once (synchronously) if
 * another change holds it. fn may set lock.note (e.g. "waiting for the camera to restart").
 * @template T
 * @param {{ id: string }} nvr
 * @param {string} what  e.g. "A picture change"
 * @param {(lock: { what: string, since: number, note: string }) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withNvrLock(nvr, what, fn) {
  const held = locks.get(nvr.id)
  if (held) {
    throw new HttpError(409, `${held.what} is running on this NVR (since ${hhmm(held.since)}${held.note ? `, ${held.note}` : ''}); try again shortly`)
  }
  const mine = { what, since: Date.now(), note: '' }
  locks.set(nvr.id, mine)
  let p
  try {
    p = Promise.resolve(fn(mine))
  } catch (e) {
    p = Promise.reject(e)
  }
  return p.finally(() => {
    if (locks.get(nvr.id) === mine) locks.delete(nvr.id)
  })
}

/** Who holds the NVR's change lock, or null. */
export const nvrLock = (nvr) => locks.get(nvr.id) ?? null

// ---- change logs ------------------------------------------------------------------------------
//
// One JSON object per line. Readers get the parsed lines, cached until the file's size or
// time changes (views read the log on every open). Above 1 MB a log is cut down to half that
// (the newest lines, at most 2000) plus, per camera and profile, the last 20 change/result
// pairs (so Undo keeps working), written to a temp file and renamed over the old one. Cutting
// to half, not just under the limit, matters: a change line carries every setting before it
// (~0.7 kB), so 2000 lines alone are over 1 MB, and a log that stays over the limit would be
// re-read and rewritten on every later change, on the thread that relays live video.

const LOG_MAX_BYTES = 1024 * 1024
const LOG_KEEP_LINES = 2000
const LOG_KEEP_PAIRS = 20
const logCache = new Map() // file -> { key, entries }

/** Parsed lines of a JSON-lines file (never throws; [] if missing). The array is shared: don't change it. */
export function readLogCached(file) {
  let st
  try {
    st = statSync(file)
  } catch {
    return []
  }
  const key = `${st.size}:${st.mtimeMs}`
  const hit = logCache.get(file)
  if (hit?.key === key) return hit.entries
  const entries = []
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  for (const l of text.split('\n')) {
    if (!l) continue
    try {
      const e = JSON.parse(l)
      if (e && typeof e === 'object' && !Array.isArray(e)) entries.push(e)
    } catch {}
  }
  logCache.set(file, { key, entries })
  return entries
}

/**
 * Shortens a log above maxBytes (1 MB) to about half of it. keyOf(changeLine) names the
 * camera/profile a change line belongs to: the last keepPairs changes of each, with their
 * results (lines with the same seq), are always kept (fewer per camera only if even those
 * would not fit); then the newest other lines while they fit. Without keyOf only the newest
 * lines are kept. Returns true if the file was rewritten.
 */
export function rotateLog(file, { keyOf = null, maxBytes = LOG_MAX_BYTES, keepLines = LOG_KEEP_LINES, keepPairs = LOG_KEEP_PAIRS } = {}) {
  try {
    if (!existsSync(file) || statSync(file).size <= maxBytes) return false
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const budget = Math.floor(maxBytes / 2)
    const size = (i) => Buffer.byteLength(lines[i]) + 1
    const keep = new Set() // line indexes
    let bytes = 0
    if (keyOf) {
      const parsed = lines.map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      const perKey = new Map() // key -> seqs of change lines, oldest first
      for (const e of parsed) {
        if (e?.kind !== 'change' || typeof e.seq !== 'string') continue
        const k = keyOf(e)
        if (!perKey.has(k)) perKey.set(k, [])
        perKey.get(k).push(e.seq)
      }
      const pinned = (n) => {
        const seqs = new Set([...perKey.values()].flatMap((s) => s.slice(-n)))
        return parsed.flatMap((e, i) => (e && seqs.has(e.seq) ? [i] : []))
      }
      let n = keepPairs
      let idx = pinned(n)
      while (n > 1 && idx.reduce((t, i) => t + size(i), 0) > budget) idx = pinned((n = Math.max(1, n >> 1)))
      for (const i of idx) {
        keep.add(i)
        bytes += size(i)
      }
    }
    // then the newest lines, while they fit
    let count = 0
    for (let i = lines.length - 1; i >= 0 && count < keepLines; i--) {
      if (keep.has(i)) continue
      if (bytes + size(i) > budget) break
      keep.add(i)
      bytes += size(i)
      count++
    }
    const out = lines.filter((_l, i) => keep.has(i))
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${out.join('\n')}\n`, { mode: 0o600 })
    renameSync(tmp, file)
    logCache.delete(file)
    return true
  } catch (e) {
    console.warn(`[log] could not shorten ${file}: ${e.message}`)
    return false
  }
}

/** A new change id: sortable by time, unique enough for one app. */
export const newSeq = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** A plain JSON object (not null, not an array). */
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

// for the offline tests: replace the native call (null puts the real one back)
// A stand-in has to keep sdkCallT's word, because the record of the call inside the SDK (xmlInside)
// goes by it: it settles with anything but an SdkTimeout only once its "native call" has returned
// or was never started, and one that rejects with an error named SdkTimeout must later call
// opts.onLate, or that NVR stays refused for the rest of the process (there is no hook that clears a
// record). A stand-in built on sdkCallT with a fake function does both by itself.
export const _test = {
  setCall(fn) {
    call = fn ?? ((opts, ...args) => sdkCallT(opts, NET_SDK.TransparentConfig, ...args))
  },
  /** The same for the reboot/shutdown call, under the same rule: (opts, action, userId) => Promise<bool> (null: the real one). */
  setPower(fn) {
    powerCall = fn ?? nativePower
  },
  /** How long callers wait behind one call before the queue and the turn pass on (null: 90 s). */
  setCap(ms) {
    capMs = ms ?? XML_CAP_MS
  },
  /** The record of this NVR's XML or power call inside the SDK ({ what, since, held }), or null. */
  inside: (nvr) => xmlInside.get(nvr.id) ?? null,
  /** XML calls admitted and not yet returned or given up waiting for (xmlPending). */
  pending: () => xmlPending,
  /** The read breaker's clock (null: the real one). */
  setNow(fn) {
    now = fn ?? Date.now
  },
  /** Forgets every NVR's read breaker. */
  resetBreakers() {
    readFails.clear()
  },
  /** The gap between XML calls (null: 250 ms), for tests that shorten the flows' own timings. */
  setGap(ms) {
    gapMs = ms ?? XML_GAP_MS
  }
}
