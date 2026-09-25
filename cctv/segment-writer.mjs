// One camera's recording as 1-minute segment files, bytes exactly as received (Annex B, never
// altered): <root>/<nvr>/<ch>/<YYYY-MM-DD>/<HH>/<HH-MM>.<h264|h265> (UTC, the minute of the
// file's first frame), plus <file>.idx: one 16-byte row per keyframe [uint64 LE offset, int64 LE
// time in ms]. A file always starts at a keyframe; a new one starts at the first keyframe at or
// after each minute boundary, and when the codec changes. close() fsyncs both files.
//
// The disk work is asynchronous and off the frame path: write() only decides (rollover, which
// file, byte counts) and queues; one chain of fs/promises operations per camera does the
// opening, writing (consecutive frames coalesced into one writev), fsync and closing. write()
// never waits for the disk. When the queue holds more than maxQueueBytes (8 MB) or its oldest
// entry is older than maxQueueMs (5 s) the disk is too slow: the open file is closed (what was
// queued is still written), frames are dropped ('overflow' once) and recording starts again at
// the first keyframe after the queue has come back under both limits. The fsync and close of a
// finished file run outside that chain (at most MAX_CONCURRENT_CLOSES per process), so the next
// file's writes never wait behind them; rollOffsetMs staggers each camera's rollover second
// (recorder.mjs: rollOffsetFor), the file is still named after the minute of its first frame.
//
// Events: 'open' {path, startMs} once a new file and its .idx have both been created (not when
// that fails; playback reads the file while it grows); 'segment' {path, startMs, endMs, bytes,
// keyframes} for every finished file (after its fsync); 'error' (Error, with .code and .path)
// when a disk operation fails: that file is abandoned and the writer waits for the next keyframe
// to try again; 'overflow' {queuedBytes, ageMs, reason} when it starts dropping frames.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'

const MINUTE = 60_000
const COALESCE_BYTES = 4 * 1024 * 1024 // at most this much per writev
const pad = (n) => String(n).padStart(2, '0')

// Finished files are fsynced and closed off the camera's write queue (the next file's writes go
// on meanwhile), at most this many at once per process: the fsyncs of every camera rolling over
// would otherwise hit the disk together and fill the libuv pool the SDK calls share.
export const MAX_CONCURRENT_CLOSES = 3
let closesRunning = 0
const closeWaiters = []
async function withCloseSlot(fn) {
  // (a finished close hands its slot straight to the next waiter)
  if (closesRunning >= MAX_CONCURRENT_CLOSES) await new Promise((r) => closeWaiters.push(r))
  else closesRunning++
  try {
    return await fn()
  } finally {
    const next = closeWaiters.shift()
    if (next) next()
    else closesRunning--
  }
}

/** A camera's rollover second (0-59 s after the minute, whole seconds), stable per camera: cameras don't all roll together. */
export function rollOffsetFor(nvrId, ch) {
  let h = 2166136261
  for (const c of `${nvrId}/${ch}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return ((h >>> 0) % 60) * 1000
}

/** The file for a segment whose first frame is at tsMs (UTC). */
export function segmentPath(root, nvrId, ch, tsMs, ext) {
  const d = new Date(tsMs)
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const hh = pad(d.getUTCHours())
  return join(root, String(nvrId), String(ch), day, hh, `${hh}-${pad(d.getUTCMinutes())}.${ext}`)
}

/** Rows of an .idx file: [{ offset, tsMs }]. */
export function readIdx(file) {
  return parseIdx(readFileSync(file))
}

/** Rows of .idx bytes (a trailing partial row is ignored). */
export function parseIdx(buf) {
  const rows = []
  for (let o = 0; o + 16 <= buf.length; o += 16) rows.push({ offset: Number(buf.readBigUInt64LE(o)), tsMs: Number(buf.readBigInt64LE(o + 8)) })
  return rows
}

export class SegmentWriter extends EventEmitter {
  /**
   * @param {{ root: string, nvrId: string, ch: number, codec?: 'h264'|'h265', fs?: object,
   *           now?: () => number, maxQueueBytes?: number, maxQueueMs?: number }} opts
   *   fs: { mkdir, open } like node:fs/promises (tests: a slow one); now: wall clock for the queue age
   */
  constructor({ root, nvrId, ch, codec = 'h264', fs = fsp, now = Date.now, maxQueueBytes = 8 * 1024 * 1024, maxQueueMs = 10_000, rollOffsetMs = 0 }) {
    super()
    this.rollOffsetMs = ((Math.round(rollOffsetMs) % MINUTE) + MINUTE) % MINUTE // rollover at this many ms after each minute
    this.closing = new Set() // background closes (fsync + close) of finished files
    this.root = root
    this.nvrId = nvrId
    this.ch = ch
    this.codec = codec
    this.fs = fs
    this.now = now
    this.maxQueueBytes = maxQueueBytes
    this.maxQueueMs = maxQueueMs
    this.cur = null // the file being written: { base, path, fh, idxFh, startMs, endMs, bytes, keyframes, rollAt, failed }
    this.queue = [] // { kind: 'open'|'data'|'close', file, at, buf?, row?, resolve? }; [0] may be in progress
    this.queuedBytes = 0
    this.pumping = false
    this.dropping = false
    this.idleWaiters = []
    this.stats = { dropped: 0, droppedBytes: 0, overflows: 0 }
  }

  /**
   * Queues one frame. Never waits for the disk.
   * @param {Buffer} buf one frame (the SDK payload after the 16-byte wire header); kept until written
   * @param {{ isKey: boolean, ts: number, codec?: 'h264'|'h265' }} meta ts in ms
   * @returns {boolean} whether the frame was queued for the file (false: dropped)
   */
  write(buf, { isKey, ts, codec }) {
    if (codec && codec !== this.codec) {
      this.close()
      this.codec = codec
    }
    if (this.cur && isKey && ts >= this.cur.rollAt) this.close()
    const over = this.#overLimit()
    if (over) {
      if (!this.dropping) {
        this.dropping = true
        this.stats.overflows++
        this.close() // what is queued is still written; the file ends here
        this.emit('overflow', over)
      }
      this.stats.dropped++
      this.stats.droppedBytes += buf.length
      return false
    }
    if (!this.cur) {
      if (!isKey) return false // a file starts at a keyframe (also after a drop or a failure)
      this.#open(ts)
    }
    this.dropping = false
    const c = this.cur
    let row = null
    if (isKey) {
      row = Buffer.allocUnsafe(16)
      row.writeBigUInt64LE(BigInt(c.bytes), 0)
      row.writeBigInt64LE(BigInt(Math.round(ts)), 8)
      c.keyframes++
    }
    this.#push({ kind: 'data', file: c, buf, row })
    c.bytes += buf.length
    c.endMs = ts
    return true
  }

  /** Finishes the current file. Resolves to its segment (after the fsync), or null (none open / it failed). */
  close() {
    const c = this.cur
    if (!c) return Promise.resolve(null)
    this.cur = null
    return new Promise((resolve) => this.#push({ kind: 'close', file: c, resolve }))
  }

  /** A file is open for writing (possibly still being created). */
  get open() {
    return this.cur !== null
  }

  /** Resolves once everything queued so far has been done. */
  drained() {
    if (!this.pumping && this.queue.length === 0 && this.closing.size === 0) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  /** Queue state: { queuedBytes, queued, ageMs, dropping, dropped, droppedBytes, overflows }. */
  queueStatus() {
    return { queuedBytes: this.queuedBytes, queued: this.queue.length, ageMs: this.queue.length ? this.now() - this.queue[0].at : 0, dropping: this.dropping, ...this.stats }
  }

  #overLimit() {
    if (this.queuedBytes > this.maxQueueBytes) return { reason: `disk too slow: ${(this.queuedBytes / 1048576).toFixed(1)} MB waiting to be written`, queuedBytes: this.queuedBytes, ageMs: this.queue.length ? this.now() - this.queue[0].at : 0 }
    if (this.queue.length) {
      const age = this.now() - this.queue[0].at
      if (age > this.maxQueueMs) return { reason: `disk too slow: a write has waited ${(age / 1000).toFixed(1)} s`, queuedBytes: this.queuedBytes, ageMs: age }
    }
    return null
  }

  #open(ts) {
    const base = segmentPath(this.root, this.nvrId, this.ch, ts, this.codec)
    const off = this.rollOffsetMs
    this.cur = { base, path: base, fh: null, idxFh: null, startMs: ts, endMs: ts, bytes: 0, keyframes: 0, rollAt: (Math.floor((ts - off) / MINUTE) + 1) * MINUTE + off, failed: false }
    this.#push({ kind: 'open', file: this.cur })
  }

  #push(op) {
    op.at = this.now()
    if (op.buf) this.queuedBytes += op.buf.length + (op.row ? 16 : 0)
    this.queue.push(op)
    if (!this.pumping) this.#pump()
  }

  async #pump() {
    this.pumping = true
    try {
      while (this.queue.length) {
        const op = this.queue[0]
        if (op.kind === 'data') {
          // this and the following frames of the same file: one writev each for data and idx
          let n = 0
          let size = 0
          while (n < this.queue.length && this.queue[n].kind === 'data' && this.queue[n].file === op.file && (n === 0 || size < COALESCE_BYTES)) size += this.queue[n++].buf.length
          const ops = this.queue.slice(0, n)
          if (!op.file.failed) await this.#data(op.file, ops)
          this.queue.splice(0, n)
          for (const o of ops) this.queuedBytes -= o.buf.length + (o.row ? 16 : 0)
          continue
        }
        if (op.kind === 'open') await this.#doOpen(op.file)
        else if (op.kind === 'close') {
          // all of this file's writes are done (queue order): its fsync and close run in the
          // background, and the queue goes on with the next file
          // (one camera's closes stay in file order: 'segment' events keep their order)
          const prev = this.closeChain ?? Promise.resolve()
          const p = prev.then(() => withCloseSlot(() => this.#doClose(op.file))).then(op.resolve, (e) => {
            console.warn(`[rec ${this.nvrId}/${this.ch}] close failed: ${e?.message ?? e}`)
            op.resolve(null)
          })
          this.closeChain = p
          this.closing.add(p)
          p.finally(() => {
            this.closing.delete(p)
            this.#maybeIdle()
          })
        }
        this.queue.shift()
      }
    } finally {
      this.pumping = false
      if (this.queue.length) this.#pump()
      else this.#maybeIdle()
    }
  }

  #maybeIdle() {
    if (this.pumping || this.queue.length || this.closing.size) return
    for (const r of this.idleWaiters.splice(0)) r()
  }

  async #doOpen(f) {
    try {
      await this.fs.mkdir(dirname(f.base), { recursive: true })
      // the same minute again (restart, codec change): a suffix, never overwrite
      for (let n = 2; ; n++) {
        try {
          f.fh = await this.fs.open(f.path, 'wx')
          break
        } catch (e) {
          if (e.code !== 'EEXIST' || n > 99) throw e
          f.path = f.base.replace(/\.(h26[45])$/, `-${n}.$1`)
        }
      }
      f.idxFh = await this.fs.open(`${f.path}.idx`, 'w')
    } catch (e) {
      await this.#fail(f, e)
      return
    }
    // a listener's bug must not end the file (nor reach the pump as an unhandled rejection)
    const emitOpen = () => {
      try {
        this.emit('open', { path: f.path, startMs: f.startMs })
      } catch (e) {
        console.warn(`[rec ${this.nvrId}/${this.ch}] 'open' listener failed: ${e.message}`)
      }
    }
    // playback's contract: the old file's 'segment' comes before the new file's 'open'. The old
    // file may still be closing in the background: announce this one after it (writes go on meanwhile)
    if (this.closing.size && this.closeChain) this.closeChain.then(emitOpen, emitOpen)
    else emitOpen()
  }

  async #data(f, ops) {
    try {
      const rows = ops.filter((o) => o.row).map((o) => o.row)
      if (rows.length) await writevAll(f.idxFh, rows)
      await writevAll(
        f.fh,
        ops.map((o) => o.buf)
      )
    } catch (e) {
      await this.#fail(f, e)
    }
  }

  async #doClose(f) {
    if (f.failed) return null
    try {
      await f.fh.sync()
      await f.idxFh.sync()
    } catch (e) {
      await this.#fail(f, e)
      return null
    }
    await closeQuiet(f)
    const seg = { path: f.path, startMs: f.startMs, endMs: f.endMs, bytes: f.bytes, keyframes: f.keyframes }
    this.emit('segment', seg)
    return seg
  }

  async #fail(f, e) {
    if (f.failed) return
    f.failed = true
    if (this.cur === f) this.cur = null // the next keyframe starts a new file
    await closeQuiet(f)
    const err = new Error(`location not writable: ${f.path} (${e.code || e.message})`)
    err.code = e.code
    err.path = f.path
    // 'error' without a listener would throw: never let a disk problem crash the worker
    if (this.listenerCount('error')) this.emit('error', err)
    else console.warn(`[rec ${this.nvrId}/${this.ch}] ${err.message}`)
  }
}

async function writevAll(fh, bufs) {
  let total = 0
  for (const b of bufs) total += b.length
  const { bytesWritten } = await fh.writev(bufs)
  if (bytesWritten >= total) return
  // a short write: the rest in one piece
  const rest = Buffer.concat(bufs).subarray(bytesWritten)
  for (let o = 0; o < rest.length; ) {
    const r = await fh.write(rest, o, rest.length - o)
    if (!r.bytesWritten) throw Object.assign(new Error('short write'), { code: 'EIO' })
    o += r.bytesWritten
  }
}

async function closeQuiet(f) {
  for (const k of ['fh', 'idxFh']) {
    const h = f[k]
    f[k] = null
    if (!h) continue
    try {
      await h.close()
    } catch {}
  }
}
