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
// XML calls to one NVR go out one at a time, in order, and the next starts only once the
// previous one has really returned from the SDK (even long after its time limit). The queue
// sits OUTSIDE the lane on purpose: the session check inside lane.run stays the last thing
// before the native call, so a call queued behind a slow one can never go out on a login
// that was logged out meanwhile (the SDK reuses login ids). It also keeps a queued call from
// holding one of the NVR's two lane slots while it waits, which would block live video.

const xmlTails = new WeakMap() // nvr -> promise that settles when its last queued XML call has returned from the SDK
const XML_CAP_MS = 90_000 // never block the queue for ever: the watchdog handles calls stuck longer

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
// Nothing is queued at all while the SDK is stuck (sdk.mjs sdkStuck).
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

/** Refuses (503, nothing sent) while the SDK is stuck, or reads while this NVR's read breaker is open. */
function refuseNow(nvr, read) {
  if (sdkStuck()) throw new HttpError(503, `The connection to the NVRs is stuck on an earlier call; nothing was sent. Try again in a minute`, { retryAfterS: STUCK_RETRY_S })
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
 * 503 while the SDK is stuck, while the process-wide queue is full (reads) and while this NVR's
 * read breaker is open (reads): see above.
 */
export async function transparent(nvr, url, xml, tag, { gen = xmlGen(nvr), outBytes = 256 * 1024 } = {}) {
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
  const mine = new Promise((r) => (returned = r)) // resolves once the native call has returned, nothing was sent, or the cap
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
  const release = () => {
    clearTimeout(cap)
    returned()
    passTurn?.(sentAt)
    passTurn = null
  }
  // never block the queues for ever (the watchdog handles calls stuck longer): from here while it
  // waits for its lane, and again from its process-wide turn
  cap = setTimeout(release, XML_CAP_MS)
  let text = null // the answer when it came from the worker (nothing is written to `out` then)
  let ok
  try {
    // things may have changed while it waited: the SDK stuck, the breaker opened
    refuseNow(nvr, read)
    ok = await nvr.lane.run(
      async () => {
        // the process-wide turn, only now that the lane runs this call (see takeTurn)
        passTurn = await takeTurn()
        clearTimeout(cap)
        cap = setTimeout(release, XML_CAP_MS)
        // and once more after that wait: the SDK stuck, the breaker opened
        refuseNow(nvr, read)
        // the session as it is when the call really starts: a relogin may have happened while it was
        // queued, or the path may have changed between this login and the worker's
        const borrowed = nvr.borrowing === true
        const userId = nvr.userId
        if ((!borrowed && userId < 0) || xmlGen(nvr) !== gen || nvr.stopped) throw new Error(`${nvr.name} reconnected; nothing was sent`)
        sentAt = Date.now()
        if (borrowed) {
          text = String((await viaWorker(nvr, { op: 'xml', url, xml, tag, outBytes }, !read)).text ?? '')
          return true
        }
        return call({ nvr: nvr.id, tag, onLate: release }, userId, xml, url, out, out.length, len)
      },
      { priority: PRIORITY.NORMAL }
    )
  } catch (e) {
    if (read && sentAt) noteRead(nvr, e?.name === 'SdkTimeout')
    // after a timeout the native call is still running: onLate releases the queues when it returns
    // (a call that went to the worker leaves no native call running here, timed out or not)
    if (e?.name !== 'SdkTimeout' || e.viaWorker) release()
    throw e
  }
  release()
  if (read) noteRead(nvr, false)
  if (!ok) throw new Error(`the NVR did not accept the request (${await lastErrorReason('no reason given')})`)
  if (text !== null) return text
  // some answers end with stray NUL bytes
  return out.toString('utf8', 0, Math.min(len.readUInt32LE(0), out.length)).replace(/\0+$/, '')
}

/**
 * Reboot or power the NVR off (NET_SDK_RebootDVR / NET_SDK_ShutDownDVR), on its control login, or the worker's while that is borrowed. One
 * SDK call, taken on this NVR's lane and the process-wide turn like every other, so it never overlaps
 * another call (overlapping SDK calls have corrupted the heap). The device drops right after, so there
 * is nothing to read back: the boolean is only whether the NVR accepted the command.
 * @param {import('./nvrs.mjs').Nvr} nvr
 * @param {'reboot'|'shutdown'} action
 * @returns {Promise<boolean>}
 */
export async function power(nvr, action) {
  if (!xmlOnline(nvr) || noOwnSession(nvr)) throw new Error(`${nvr.name} is offline`)
  const fn = action === 'shutdown' ? NET_SDK.ShutDownDVR : NET_SDK.RebootDVR
  const gen = xmlGen(nvr)
  return nvr.lane.run(
    async () => {
      const passTurn = await takeTurn()
      try {
        const borrowed = nvr.borrowing === true
        const userId = nvr.userId
        if ((!borrowed && userId < 0) || xmlGen(nvr) !== gen || nvr.stopped) throw new Error(`${nvr.name} reconnected; nothing was sent`)
        if (borrowed) return Boolean((await viaWorker(nvr, { op: 'power', action }, true)).accepted)
        return Boolean(await sdkCallT({ nvr: nvr.id, tag: action }, fn, userId))
      } finally {
        passTurn()
      }
    },
    { priority: PRIORITY.HIGH }
  )
}

/** Waits (up to maxMs) until no XML call to this NVR is queued or inside the SDK. Resolves true if none is. */
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
export const _test = {
  setCall(fn) {
    call = fn ?? ((opts, ...args) => sdkCallT(opts, NET_SDK.TransparentConfig, ...args))
  },
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
