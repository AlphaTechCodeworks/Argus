// The NVR web client's XML commands, sent over the logged-in SDK connection with
// NET_SDK_TransparentConfig (strUrl = the command name, sendXML = the whole <request>
// document, no web token needed). Shared by substreams.mjs, imaging.mjs, lens.mjs and
// streams.mjs, together with the per-NVR lock and the change-log helpers they use.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { PRIORITY } from './lanes.mjs'
import { NET_SDK, lastError, lateCalls, sdkCallT } from './sdk.mjs'
import { kid, parseXml } from './xml.mjs'
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

/** Refuses (409) unless the NVR is online and not recovering. */
export function requireOnline(nvr) {
  if (!nvr.online) throw new HttpError(409, `${nvr.name} is ${nvr.status}; try again when it is online`)
  if (nvr.degraded) throw new HttpError(409, `${nvr.name} is busy or recovering; try again in a minute`)
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

// replaced by the offline tests: (opts, userId, xml, url, out, outSize, len) => Promise<bool>
let call = (opts, ...args) => sdkCallT(opts, NET_SDK.TransparentConfig, ...args)

/**
 * Sends one command and returns the answer. Refuses (nothing sent) if the session changed
 * while the call waited its turn: `gen` is the session the caller's data came from.
 */
export async function transparent(nvr, url, xml, tag, { gen = nvr.gen, outBytes = 256 * 1024 } = {}) {
  if (!nvr.online || nvr.userId < 0) throw new Error(`${nvr.name} is offline`)
  const out = Buffer.alloc(outBytes)
  const len = Buffer.alloc(4)
  const prev = xmlTails.get(nvr) ?? Promise.resolve()
  let returned
  const mine = new Promise((r) => (returned = r))
  const tail = prev.then(() => mine)
  xmlTails.set(nvr, tail)
  tail.then(() => {
    if (xmlTails.get(nvr) === tail) xmlTails.delete(nvr)
  })
  await prev
  const cap = setTimeout(() => returned(), XML_CAP_MS)
  const release = () => {
    clearTimeout(cap)
    returned()
  }
  let ok
  try {
    ok = await nvr.lane.run(
      () => {
        // the session as it is when the call really starts (a relogin may have happened while queued)
        const userId = nvr.userId
        if (userId < 0 || nvr.gen !== gen || nvr.stopped) throw new Error(`${nvr.name} reconnected; nothing was sent`)
        return call({ nvr: nvr.id, tag, onLate: release }, userId, xml, url, out, out.length, len)
      },
      { priority: PRIORITY.NORMAL }
    )
  } catch (e) {
    // after a timeout the native call is still running: onLate releases the queue when it returns
    if (e?.name !== 'SdkTimeout') release()
    throw e
  }
  release()
  if (!ok) throw new Error(`the NVR did not accept the request (${await lastError()})`)
  // some answers end with stray NUL bytes
  return out.toString('utf8', 0, Math.min(len.readUInt32LE(0), out.length)).replace(/\0+$/, '')
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
  }
}
