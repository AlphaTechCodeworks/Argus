// A picture for an event: one JPEG made from the server's own recording just after the event
// started, kept beside the event and shown on the Alarms page and at an alert's link.
//
// Why from our recording rather than from the camera or the NVR: it works on every camera type (the
// camera's own "target picture" exists only on some AI models), it asks nothing of the NVR (nvr-2 is
// at its bandwidth ceiling), and it is the footage an export would give, so the picture and the
// evidence cannot disagree.
//
// How: the recorder writes each camera in one-minute files, and a file is indexed only once it
// closes, so a crossing seen within seconds (alarm-watch.mjs) is rarely in a closed file yet.
// takeSnapshot therefore waits: every SNAP_POLL_MS it asks the index for the footage at the event
// start + 1 s (the file being written counts: rec-index.mjs at() and next() return it), and as soon
// as the first keyframe at or after that moment is on disk it hands that one keyframe to ffmpeg,
// which makes a JPEG at most 1280 wide. A keyframe decodes on its own (it carries its parameter
// sets; the export stills in export-job.mjs rely on the same), so no other frame is read. After
// SNAP_WAIT_MS it gives up and logs why. A keyframe more than SNAP_LATE_MS after that moment would
// show something else (a gap, a stalled camera), so there is no picture rather than a wrong one.
//
// ffmpeg runs one at a time and at low priority (transcode.mjs niceWrap): a burst of crossings must
// not take the cores the recorder needs. Files: DATA_DIR/event-snaps/<event id>.jpg, written under a
// temp name and renamed, so a half-written picture is never served. A picture goes when its event
// goes (sweepSnapshots, from the server's 5-minute housekeeping).
//
//   GET /api/events/:id/snapshot -> the JPEG, for a user who may play that camera back (rights.mjs)
//
// Nothing here imports sdk.mjs: the tests run on any machine (ffmpeg's own part on the server).
import { spawn as nodeSpawn } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DATA_DIR } from './auth.mjs'
import { getEvent } from './events-db.mjs'
import { CODEC, SegmentReader, codecOfPath, keyAtOrAfter } from './rec-reader.mjs'
import { can } from './rights.mjs'
import { securityHeaders } from './security.mjs'
import { niceWrap } from './transcode.mjs'

export const SNAP_DIR = join(DATA_DIR, 'event-snaps')
/** How long a picture waits for the recording to reach the event (the open file closes every minute). */
export const SNAP_WAIT_MS = 3 * 60_000
/** How often it looks again meanwhile. */
export const SNAP_POLL_MS = 5000
/** The picture is of this long after the start: the start is the alarm's first second, and what crossed is in the picture a second later. */
export const SNAP_AFTER_MS = 1000
/** A keyframe further than this past that moment shows something else (a gap, a stalled camera): no picture then. */
export const SNAP_LATE_MS = 15_000
/** One keyframe decodes in well under a second; an ffmpeg still running after this is killed. */
export const SNAP_FFMPEG_MS = 20_000
/** Far more than one JPEG of at most 1280 wide: an ffmpeg writing this much is not doing what it was asked. */
const MAX_JPEG_BYTES = 8 * 1024 * 1024
/** A temp file this old was left by a crash mid-write (a finished write renames it at once). */
const STALE_TMP_MS = 60 * 60_000
const SECURITY_HEADERS = securityHeaders()

const isEventId = (id) => Number.isSafeInteger(id) && id > 0
const stamp = (ms) => new Date(ms).toISOString()

/** The picture file of one event. Throws for anything but a positive whole number, so no request text ever becomes a path. */
export function snapPath(eventId) {
  const id = Number(eventId)
  if (!isEventId(id)) throw new Error(`not an event id: ${eventId}`)
  return join(SNAP_DIR, `${id}.jpg`)
}

/**
 * ffmpeg's arguments: one keyframe in on stdin (raw Annex B), one JPEG out on stdout, scaled down to
 * 1280 wide when the picture is wider (the height follows and is kept even; a smaller picture is
 * not enlarged). -q:v 4 is a clear picture at a modest size (export stills use 2, near lossless).
 * @param {0|1} codec CODEC.h264 / CODEC.h265
 */
export function snapArgs(codec) {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', codec === CODEC.h265 ? 'hevc' : 'h264', '-i', 'pipe:0',
    '-frames:v', '1',
    // the quotes are for ffmpeg's filter parser (the comma inside min() would split the filter), not
    // for a shell: there is none
    '-vf', "scale='min(1280,iw)':-2",
    '-q:v', '4',
    // image2pipe: the image2 muxer's form for a pipe, one JPEG and no file name pattern
    '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'
  ]
}

const isJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9

/** One keyframe through ffmpeg: resolves the JPEG bytes, rejects with why not. */
function toJpeg(keyBuf, codec, { ffmpeg, spawn, platform, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const { bin, args } = niceWrap(ffmpeg, snapArgs(codec), { platform, hasIonice: platform === 'linux' })
    let proc
    try {
      proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      reject(e)
      return
    }
    const out = []
    let bytes = 0
    let err = ''
    let settled = false
    const settle = (e, buf) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (e) reject(e)
      else resolve(buf)
    }
    const kill = () => {
      try {
        proc.kill('SIGKILL')
      } catch {}
    }
    // settled first, then killed: the kill's own 'close' must not replace the reason
    const timer = setTimeout(() => {
      settle(new Error(`ffmpeg did not finish within ${timeoutMs / 1000} s`))
      kill()
    }, timeoutMs)
    proc.stdout.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_JPEG_BYTES) {
        settle(new Error('ffmpeg wrote far more than one picture'))
        kill()
        return
      }
      out.push(chunk)
    })
    proc.stderr?.on('data', (chunk) => {
      err = (err + String(chunk)).slice(-300)
    })
    proc.on('error', (e) => settle(e.code === 'ENOENT' ? new Error(`${bin} is not installed (deploy/install-ubuntu.sh installs ffmpeg)`) : e))
    proc.on('close', (code) => {
      const buf = Buffer.concat(out)
      if (code !== 0) settle(new Error(`ffmpeg exited with ${code}${err.trim() ? `: ${err.trim()}` : ''}`))
      else if (!isJpeg(buf)) settle(new Error('ffmpeg gave no JPEG'))
      else settle(null, buf)
    })
    // an ffmpeg that quits early gives EPIPE here; its exit code says why
    proc.stdin.on('error', () => {})
    proc.stdin.end(keyBuf)
  })
}

// ffmpeg one at a time: a burst of crossings takes turns rather than starting a process each
let turn = Promise.resolve()
function oneAtATime(fn) {
  const run = turn.then(fn)
  turn = run.catch(() => {})
  return run
}

/** A reader for one index row; the file being written is read as growing (rec-reader.mjs). */
const openReader = (seg) => new SegmentReader({ path: seg.path, endMs: seg.endMs ?? null, growing: Boolean(seg.open) }).open()

/**
 * The first keyframe at or after t: { key: { buf, ts, codec } }, { wait: why } (not on disk yet: look
 * again later) or { none: why } (there will never be one close enough).
 */
async function findKeyframe(index, nvr, ch, t, readerFor) {
  let seg = index.at(nvr, ch, t)
  if (!seg) {
    // t is in no file: not recorded yet, or in a gap (then a file after it exists already)
    seg = index.next(nvr, ch, t)
    if (!seg) return { wait: 'the recording has not reached it yet' }
  }
  // t's own file, then the next one (the keyframe after t may start the next file)
  for (let files = 0; files < 2; files++) {
    if (seg.startMs - t > SNAP_LATE_MS) return { none: `nothing was recorded from ${stamp(t)} until ${Math.round((seg.startMs - t) / 1000)} s later` }
    let r
    try {
      r = await readerFor(seg)
    } catch (e) {
      // a file moved from the RAM spool to a drive (the index has its new place next time), or removed
      return { wait: `${seg.path} could not be read (${e.code ?? e.message})` }
    }
    try {
      const k = keyAtOrAfter(r.times, t)
      if (k >= 0) {
        if (r.times[k] - t > SNAP_LATE_MS) return { none: `the first keyframe after ${stamp(t)} came ${Math.round((r.times[k] - t) / 1000)} s later` }
        const kf = await r.keyframe(k)
        // (copied: the reader's buffer is not ours to keep)
        if (kf) return { key: { buf: Buffer.from(kf.buf), ts: kf.ts, codec: codecOfPath(seg.path) } }
        if (seg.open) return { wait: 'its keyframe is still being written' }
        return { none: `the keyframe at ${stamp(r.times[k])} could not be read` }
      }
      if (seg.open) return { wait: 'no keyframe after it has been recorded yet' }
    } finally {
      await r.close?.()
    }
    const after = index.next(nvr, ch, seg.startMs)
    if (!after) return { wait: 'the next file has not been started yet' }
    seg = after
  }
  return { none: `no keyframe after ${stamp(t)} in the two files that follow it` }
}

async function snap(event, id, file, o) {
  const label = `${event.nvr}/${event.ch} event ${id}`
  if (!o.index) {
    o.log(`[snapshot] ${label}: not taken, this server keeps no recordings of its own`)
    return null
  }
  const t = Number(event.startMs) + SNAP_AFTER_MS
  if (!Number.isFinite(t)) {
    o.log(`[snapshot] ${label}: not taken, the event has no start time`)
    return null
  }
  const until = o.now() + SNAP_WAIT_MS
  let why = ''
  for (;;) {
    const found = await findKeyframe(o.index, String(event.nvr), Number(event.ch), t, o.readerFor)
    if (found.key) {
      const jpeg = await oneAtATime(() => toJpeg(found.key.buf, found.key.codec, o))
      await mkdir(SNAP_DIR, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      try {
        await writeFile(tmp, jpeg)
        await rename(tmp, file)
      } finally {
        await rm(tmp, { force: true })
      }
      o.log(`[snapshot] ${label}: taken ${((found.key.ts - t + SNAP_AFTER_MS) / 1000).toFixed(1)} s after the start (${jpeg.length} bytes)`)
      return file
    }
    if (found.none) {
      o.log(`[snapshot] ${label}: not taken, ${found.none}`)
      return null
    }
    why = found.wait
    if (o.now() >= until) break
    await o.wait(SNAP_POLL_MS)
  }
  o.log(`[snapshot] ${label}: not taken, ${why} after ${SNAP_WAIT_MS / 60_000} minutes`)
  return null
}

const inFlight = new Map() // event id -> its picture being taken (a crossing that lasts is reported again)

/**
 * Takes an event's picture from the server's recording (see the top). Never throws: every failure is
 * logged once and resolves null. Called again for the same event (a crossing is reported again while
 * it lasts), it joins the picture being taken or returns the one already there.
 * @param {{ id: number, nvr: string, ch: number, startMs: number, seenMs?: number }} event an events-db row
 * @param {{ index: object|null, readerFor?: (seg: object) => Promise<object>, ffmpeg?: string,
 *           now?: () => number, wait?: (ms: number) => Promise<void>, spawn?: Function,
 *           platform?: string, timeoutMs?: number, log?: (line: string) => void }} deps
 *   index: nvrs.mjs recIndex() (null without server recording); readerFor(seg): an opened reader
 *   ({ times, keyframe(k), close() }, default rec-reader.mjs SegmentReader); ffmpeg: the binary;
 *   now/wait: the clock and the pause between looks; spawn/platform/timeoutMs: for the tests
 * @returns {Promise<string|null>} the JPEG's path, or null
 */
export async function takeSnapshot(event, { index, readerFor = openReader, ffmpeg = 'ffmpeg', now = Date.now, wait = (ms) => sleep(ms, undefined, { ref: false }), spawn = nodeSpawn, platform = process.platform, timeoutMs = SNAP_FFMPEG_MS, log = console.log } = {}) {
  const id = Number(event?.id)
  if (!isEventId(id)) {
    log('[snapshot] not taken: the event has no id')
    return null
  }
  const file = snapPath(id)
  // already taken; a file older than the event's row belonged to an earlier event with the same id
  // (SQLite can hand out the id of a deleted newest row again) and is taken afresh
  let st = null
  try {
    st = statSync(file, { throwIfNoEntry: false })
  } catch {} // unreadable: taken again, and writing it will say what is wrong
  if (st && !(st.mtimeMs < Number(event.seenMs))) return file
  if (inFlight.has(id)) return inFlight.get(id)
  const job = snap(event, id, file, { index, readerFor, ffmpeg, now, wait, spawn, platform, timeoutMs, log })
    .catch((e) => {
      log(`[snapshot] ${event.nvr}/${event.ch} event ${id}: not taken, ${e.message}`)
      return null
    })
    .finally(() => inFlight.delete(id))
  inFlight.set(id, job)
  return job
}

/**
 * GET /api/events/:id/snapshot: the event's picture, for someone who may play that camera back (from
 * the server or the NVR: the same rule as the /playback socket). Everything else is a bare 404, an
 * event on a camera the user may not see included: that it exists is not theirs to know either.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number|string} eventId from the URL
 * @param {{ user: string, admin: boolean }} who from the session (server.mjs), never from the request
 */
export async function handleSnapshot(req, res, eventId, who) {
  const answer = (status, body, headers) => {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
    res.end(body)
  }
  if (req.method !== 'GET') return answer(405, JSON.stringify({ error: 'Method not allowed' }), { 'content-type': 'application/json', allow: 'GET' })
  // no-store: the picture of a crossing seen seconds ago is usually still being taken
  const missing = () => answer(404, JSON.stringify({ error: 'No picture for that event' }), { 'content-type': 'application/json', 'cache-control': 'no-store' })
  const id = Number(eventId)
  if (!isEventId(id)) return missing()
  const ev = getEvent(id)
  const cam = ev ? { nvr: ev.nvr, ch: ev.ch } : null
  if (!cam || !(can(who, 'playback-server', cam) || can(who, 'playback-nvr', cam))) return missing()
  let jpeg
  try {
    jpeg = await readFile(snapPath(id))
  } catch {
    return missing() // not taken (yet, or at all)
  }
  // private: the next user of this browser may not be allowed this camera
  answer(200, jpeg, { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length), 'cache-control': 'private, max-age=300' })
}

/** Removes these events' pictures. Anything that is not an event id is skipped; a missing picture is fine. */
export function forgetSnapshots(eventIds) {
  for (const raw of eventIds ?? []) {
    const id = Number(raw)
    if (!isEventId(id)) continue
    try {
      rmSync(snapPath(id), { force: true })
    } catch (e) {
      console.warn(`[snapshot] could not remove the picture of event ${id}: ${e.message}`)
    }
  }
}

/**
 * Removes every picture whose event is gone, and temp files a crash left behind. Events go by
 * events-db forgetEventsBefore (acknowledged ones stay, and so do their pictures); this looks at
 * the pictures instead of being told which rows went, so a picture never outlives its event,
 * whatever removed the row. One indexed lookup per picture. Never throws: it runs in the server's
 * housekeeping chain, and a failure must not stop the jobs after it.
 * @param {{ exists?: (id: number) => boolean, now?: () => number }} [o]
 * @returns {Promise<{ removed: number }>}
 */
export async function sweepSnapshots({ exists = (id) => getEvent(id) !== null, now = Date.now } = {}) {
  let names
  try {
    names = await readdir(SNAP_DIR)
  } catch {
    return { removed: 0 } // no picture taken yet
  }
  const gone = []
  for (const name of names) {
    const m = /^(\d{1,15})\.jpg$/.exec(name)
    if (m) {
      try {
        if (!exists(Number(m[1]))) gone.push(Number(m[1]))
      } catch (e) {
        // the events could not be read: nothing is removed on a guess
        console.warn(`[snapshot] sweep stopped: ${e.message}`)
        return { removed: 0 }
      }
    } else if (name.endsWith('.tmp')) {
      try {
        const p = join(SNAP_DIR, name)
        if (now() - (await stat(p)).mtimeMs > STALE_TMP_MS) await rm(p, { force: true })
      } catch {}
    }
  }
  forgetSnapshots(gone)
  if (gone.length) console.log(`[snapshot] removed ${gone.length} picture(s) of events that are gone`)
  return { removed: gone.length }
}
