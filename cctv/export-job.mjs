// Evidence exports: the background job that turns recorded segments into a pack, an MP4 or a set
// of stills, signs the result and reports progress. The proof of integrity is export-pack.mjs and
// the container is mp4.mjs; this module is the glue that reads the recordings and fills a folder.
//
// Three rules shape it:
//  - Recording comes first. An export is a long read of the same drives the recorders are writing
//    to, so it reads in small pieces and yields between them (see #pause), one job at a time. A
//    slow export is a nuisance; a dropped minute of footage is gone for good.
//  - Nothing half-made is ever offered. Everything is built under exports/.work/<id> and renamed
//    into place only once the manifest is signed, so a crash, a failure or a cancel leaves a
//    working folder that is swept away, never a downloadable file nobody can vouch for.
//  - The manifest states what was actually produced, not what was asked for. Video can only be cut
//    at a keyframe, so the trimmed range differs from the requested one by up to a GOP. Both are
//    recorded (requestedStart / startServer), together with each NVR's clock offset and that NVR's
//    own idea of the time (nvr1 runs about 220 s fast).
//
// Streaming: export-pack.mjs reads whole files into memory to hash and to encrypt, which is fine
// for a manifest but not for a multi-GB clip. The streaming equivalents live here (copyHashed,
// hashFileStream, encryptFileStream, decryptFileStream); the file format they produce is exactly
// the one export-pack.mjs reads, so either side can be used on the same file.
//
// Exports live under the data directory (DATA_DIR/exports), never on a recording location: filling
// the recording drive with exports would stop the recording.
import { createHash, createCipheriv, createDecipheriv, randomUUID, scryptSync } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, join, sep } from 'node:path'
import { CODEC, SegmentReader, codecOfPath, keyAtOrBefore } from './rec-reader.mjs'
import { buildManifest, ensureKey, signManifest, writePack } from './export-pack.mjs'
import { writeMp4 } from './mp4.mjs'
import { can } from './rights.mjs'
import { audit } from './audit.mjs'

// ---------------------------------------------------------------------------- bounds

/** The longest stretch one clip may cover. Named in the refusal, with the figure actually asked for. */
export const MAX_CLIP_MS = 4 * 3_600_000
/** The most recorded video one job may read. */
export const MAX_BYTES = 50 * 1024 ** 3
/**
 * MP4 is built in memory by mp4.mjs (one Buffer for the whole file), so it gets a much tighter
 * bound than the pack format, which only ever copies a file at a time. Refusing with a clear
 * message beats an out-of-memory crash that takes the recorders down with it.
 */
export const MAX_MP4_BYTES = 1024 ** 3

const FORMATS = new Set(['pack', 'mp4', 'stills'])
const EXPORTS_DIR = 'exports'
const WORK_DIR = '.work'
const META_FILE = 'export.json'
const PACK_DIR = 'pack'
const PLAYER_SRC = join(import.meta.dirname, 'public', 'pack-player.html')
const PLAYER_NAME = 'pack-player.html'
const READ_CHUNK = 1024 * 1024 // copy in 1 MB pieces so a copy never holds a clip in memory
const STILL_MIN_EVERY_S = 1
const STILL_MAX = 2000 // a sane ceiling: 4 h at 1 s would be 14 400 JPEGs and an unusable export

// The encrypted-file layout of export-pack.mjs, repeated here because the streaming versions must
// produce and read exactly the same bytes. Changing either side alone would break old packs.
const MAGIC = Buffer.from('CCTVPACK1')
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const SCRYPT_COST = 16384

/** A refusal the API turns into a status code; the message is shown to the owner as it is. */
export class ExportError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ---------------------------------------------------------------------------- streaming crypto

/** SHA-256 of a file, read in pieces. The whole-file hashFile() of export-pack.mjs would not survive a 20 GB clip. */
export async function hashFileStream(file) {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(file, { highWaterMark: READ_CHUNK })) h.update(chunk)
  return h.digest('hex')
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crcStart = () => 0xffffffff
const crcUpdate = (c, buf) => {
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0
  return c
}
const crcEnd = (c) => (c ^ 0xffffffff) >>> 0

/**
 * Copies `src` to `dest` in pieces, returning { bytes, sha256, crc32 } measured on the way past.
 * One pass: the manifest hash and the ZIP checksum both come out of the same read, so a 20 GB
 * export is read once rather than three times.
 * @param {(n:number)=>void} [onBytes] called with each chunk's size, for the progress bar
 */
export async function copyHashed(src, dest, onBytes) {
  mkdirSync(dirname(dest), { recursive: true })
  const h = createHash('sha256')
  let crc = crcStart()
  let bytes = 0
  const read = createReadStream(src, { highWaterMark: READ_CHUNK })
  const write = createWriteStream(dest)
  await pipeline(read, async function* (source) {
    for await (const chunk of source) {
      h.update(chunk)
      crc = crcUpdate(crc, chunk)
      bytes += chunk.length
      onBytes?.(chunk.length)
      yield chunk
    }
  }, write)
  return { bytes, sha256: h.digest('hex'), crc32: crcEnd(crc) }
}

/** Buffer written to disk with its hash and CRC measured, for files this job produces itself. */
export function writeHashed(dest, buf) {
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf)
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), crc32: crcEnd(crcUpdate(crcStart(), buf)) }
}

const keyFor = (password, salt) => scryptSync(String(password), salt, 32, { N: SCRYPT_COST, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
const randomBytesOf = (n) => {
  const b = Buffer.allocUnsafe(n)
  globalThis.crypto.getRandomValues(b)
  return b
}

/**
 * AES-256-GCM over a stream, producing the same magic | salt | iv | ciphertext | tag file that
 * export-pack.mjs decryptFile reads. Written to a temp name and renamed, so a failure part-way
 * never leaves something that looks like a finished encrypted export.
 */
export async function encryptFileStream(src, dest, password) {
  if (!password) throw new Error('a password is required')
  const salt = randomBytesOf(SALT_BYTES)
  const iv = randomBytesOf(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', keyFor(password, salt), iv)
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp-${process.pid}`
  const out = createWriteStream(tmp)
  try {
    await writeChunk(out, Buffer.concat([MAGIC, salt, iv]))
    for await (const chunk of createReadStream(src, { highWaterMark: READ_CHUNK })) {
      const enc = cipher.update(chunk)
      if (enc.length) await writeChunk(out, enc)
    }
    const tail = cipher.final()
    if (tail.length) await writeChunk(out, tail)
    // The tag is only known once everything has been through the cipher, which is why it goes last.
    await writeChunk(out, cipher.getAuthTag())
    await endStream(out)
    renameSync(tmp, dest)
  } catch (e) {
    out.destroy()
    rmSync(tmp, { force: true })
    throw e
  }
  return dest
}

const writeChunk = (stream, buf) => new Promise((resolve, reject) => stream.write(buf, (e) => (e ? reject(e) : resolve())))
const endStream = (stream) => new Promise((resolve, reject) => stream.end((e) => (e ? reject(e) : resolve())))

/** The reverse. A wrong password fails before anything is put in place, never producing rubbish. */
export async function decryptFileStream(src, dest, password) {
  if (!password) throw new Error('a password is required')
  const size = statSync(src).size
  const head = MAGIC.length + SALT_BYTES + IV_BYTES
  if (size < head + TAG_BYTES) throw new Error('not an encrypted pack file')
  // The header and the trailing tag are read directly, so nothing larger than a few dozen bytes is
  // ever held in memory: the body goes through the decipher a chunk at a time.
  const hdr = Buffer.alloc(head)
  const tag = Buffer.alloc(TAG_BYTES)
  const fd = openSync(src, 'r')
  try {
    readSync(fd, hdr, 0, head, 0)
    readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES)
  } finally {
    closeSync(fd)
  }
  if (!hdr.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an encrypted pack file')
  const salt = hdr.subarray(MAGIC.length, MAGIC.length + SALT_BYTES)
  const iv = hdr.subarray(MAGIC.length + SALT_BYTES, head)
  const decipher = createDecipheriv('aes-256-gcm', keyFor(password, salt), iv)
  decipher.setAuthTag(tag)
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp-${process.pid}`
  try {
    await pipeline(createReadStream(src, { start: head, end: size - TAG_BYTES - 1, highWaterMark: READ_CHUNK }), decipher, createWriteStream(tmp))
    renameSync(tmp, dest)
  } catch {
    rmSync(tmp, { force: true })
    throw new Error('wrong password, or the file has been altered')
  }
  return dest
}

// ---------------------------------------------------------------------------- the ZIP wrapper

/**
 * A pack is a folder; a download has to be one file. This writes a stored (uncompressed) ZIP, so
 * the video inside a download is still byte for byte what the camera produced and the hashes in
 * the manifest still match after extracting.
 *
 * Stored, never deflated: recorded H.264 does not compress, and compressing would mean reading and
 * re-buffering gigabytes to save nothing. Sizes and CRCs are known before the file is opened
 * (measured when the pack was built), so no data descriptors are needed and the archive is valid
 * even if the transfer is cut off part-way through — a truncated ZIP is obviously truncated.
 * ZIP64 fields are written for any entry over 4 GB or past the 4 GB mark, so a 50 GB export works.
 *
 * @param {string} dir the pack folder
 * @param {Array<{path:string,bytes:number,crc32:number}>} entries pack-relative posix paths
 * @returns {AsyncGenerator<Buffer>} the archive, a piece at a time
 */
export async function* zipStream(dir, entries) {
  const ZIP64 = 0xffffffff
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b }
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b }
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
  const central = []
  let offset = 0
  let needsZip64 = false

  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8')
    const big = e.bytes >= ZIP64 || offset >= ZIP64
    if (big) needsZip64 = true
    // Version 45 (ZIP64) only where it is needed; bit 11 says the name is UTF-8.
    const extra = big ? Buffer.concat([u16(0x0001), u16(16), u64(e.bytes), u64(e.bytes)]) : Buffer.alloc(0)
    const local = Buffer.concat([
      u32(0x04034b50), u16(big ? 45 : 20), u16(0x0800), u16(0) /* stored */, u16(0), u16(0),
      u32(e.crc32), u32(big ? ZIP64 : e.bytes), u32(big ? ZIP64 : e.bytes), u16(name.length), u16(extra.length), name, extra
    ])
    const localOffset = offset
    yield local
    offset += local.length
    for await (const chunk of createReadStream(join(dir, e.path.split('/').join(sep)), { highWaterMark: READ_CHUNK })) {
      offset += chunk.length
      yield chunk
    }
    const cExtraParts = []
    if (e.bytes >= ZIP64) cExtraParts.push(u64(e.bytes), u64(e.bytes))
    if (localOffset >= ZIP64) cExtraParts.push(u64(localOffset))
    const cExtra = cExtraParts.length ? Buffer.concat([u16(0x0001), u16(cExtraParts.length * 8), ...cExtraParts]) : Buffer.alloc(0)
    central.push(Buffer.concat([
      u32(0x02014b50), u16(big ? 45 : 20), u16(big ? 45 : 20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(e.crc32), u32(e.bytes >= ZIP64 ? ZIP64 : e.bytes), u32(e.bytes >= ZIP64 ? ZIP64 : e.bytes),
      u16(name.length), u16(cExtra.length), u16(0), u16(0), u16(0), u32(0), u32(localOffset >= ZIP64 ? ZIP64 : localOffset), name, cExtra
    ]))
  }

  const dirStart = offset
  for (const c of central) {
    yield c
    offset += c.length
  }
  const dirBytes = offset - dirStart
  if (needsZip64 || central.length >= 0xffff || dirStart >= ZIP64) {
    yield Buffer.concat([
      u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(central.length), u64(central.length), u64(dirBytes), u64(dirStart)
    ])
    yield Buffer.concat([u32(0x07064b50), u32(0), u64(offset), u32(1)])
  }
  yield Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(Math.min(central.length, 0xffff)), u16(Math.min(central.length, 0xffff)),
    u32(Math.min(dirBytes, ZIP64)), u32(Math.min(dirStart, ZIP64)), u16(0)
  ])
}

// ---------------------------------------------------------------------------- planning

const posix = (p) => String(p).split(sep).join('/')
const safeName = (s) => String(s ?? '').replace(/[^A-Za-z0-9 _.-]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60)
const hours = (ms) => (ms / 3_600_000).toFixed(2)
const gib = (b) => (b / 1024 ** 3).toFixed(1)
const camKey = (nvr, ch) => `${safeName(nvr)}-ch${Number(ch)}`

/**
 * Checks a request and works out what it would read, without reading any video.
 * Refusals name the figure actually asked for: "4.7 hours" tells the owner what to change,
 * "too long" does not.
 * @returns {{clips:Array, bytes:number, format:string, name:string, notes:string, everyS:number}}
 */
export function planExport(body, { index, who }) {
  if (!index) throw new ExportError(503, 'The server is not recording (CCTV_LIVE_WORKER is off), so there is nothing to export')
  const format = String(body?.format ?? 'pack')
  if (!FORMATS.has(format)) throw new ExportError(400, `format must be one of ${[...FORMATS].join(', ')}`)
  const wanted = Array.isArray(body?.clips) ? body.clips : []
  if (!wanted.length) throw new ExportError(400, 'at least one clip is required')
  if (wanted.length > 32) throw new ExportError(400, `at most 32 clips in one export, ${wanted.length} were asked for`)
  const everyS = Math.max(STILL_MIN_EVERY_S, Math.round(Number(body?.everySeconds ?? 10) || 10))

  const clips = []
  let bytes = 0
  for (const c of wanted) {
    const nvr = String(c?.nvr ?? '')
    const ch = Number(c?.ch)
    const fromMs = Math.round(Number(c?.fromMs))
    const toMs = Math.round(Number(c?.toMs))
    if (!nvr || !Number.isInteger(ch) || ch < 0 || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new ExportError(400, 'each clip needs nvr, ch, fromMs and toMs')
    }
    if (toMs <= fromMs) throw new ExportError(400, 'each clip must end after it starts')
    if (toMs - fromMs > MAX_CLIP_MS) {
      throw new ExportError(400, `a clip may cover at most ${hours(MAX_CLIP_MS)} hours; ${nvr} channel ${ch} asks for ${hours(toMs - fromMs)} hours`)
    }
    // The rights check, never re-implemented here: rec-access.mjs decides who may take footage off
    // this server, and an export is a permanent copy, so it is no laxer than playback.
    if (!can(who, 'export', { nvr, ch, format })) throw new ExportError(403, `you are not allowed to export ${nvr} channel ${ch} as ${format}`)
    const segments = index.segments(nvr, ch, fromMs, toMs).filter((s) => !s.open && s.endMs != null)
    const segBytes = segments.reduce((n, s) => n + (Number(s.bytes) || 0), 0)
    bytes += segBytes
    clips.push({ nvr, ch, fromMs, toMs, segments, bytes: segBytes })
  }
  if (bytes > MAX_BYTES) {
    throw new ExportError(400, `an export may read at most ${gib(MAX_BYTES)} GB of recordings; this one would read ${gib(bytes)} GB`)
  }
  if (format === 'mp4' && bytes > MAX_MP4_BYTES) {
    throw new ExportError(400, `an MP4 export is built in memory and is limited to ${gib(MAX_MP4_BYTES)} GB; this one would read ${gib(bytes)} GB. Choose a shorter range, or the pack format.`)
  }
  if (!clips.some((c) => c.segments.length)) throw new ExportError(404, 'there are no recordings in that time range')

  return { format, clips, bytes, everyS, name: safeName(body?.name) || `export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`, notes: String(body?.notes ?? '').slice(0, 2000) }
}

// ---------------------------------------------------------------------------- the register

/** id -> job. Also mirrored to exports/<id>/export.json so the list survives a restart. */
const jobs = new Map()
let loaded = false
let running = null // the one job in flight: an export must not fight another export for the drive
let pauseMs = 0 // test hook: extra delay per read, to make cancellation observable

const exportsRoot = (dataDir) => join(dataDir, EXPORTS_DIR)
const workRoot = (dataDir) => join(exportsRoot(dataDir), WORK_DIR)

const view = (j) => ({
  id: j.id,
  name: j.name,
  format: j.format,
  state: j.state,
  error: j.error,
  by: j.by,
  startedAt: j.startedAt,
  endedAt: j.endedAt,
  bytes: j.bytes,
  notes: j.notes,
  clips: j.clips.map((c) => ({
    nvr: c.nvr,
    ch: c.ch,
    requestedFromMs: c.fromMs,
    requestedToMs: c.toMs,
    startMs: c.actualStartMs ?? null,
    endMs: c.actualEndMs ?? null,
    offsetMs: c.offsetMs ?? 0
  })),
  progress: { ...j.progress },
  downloadName: `${j.name}.zip`,
  ready: j.state === 'done'
})

/** Everything the exports page lists, newest first. Reads the folder once per process. */
export function listExports(dataDir) {
  loadFromDisk(dataDir)
  return [...jobs.values()].map(view).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
}

export function getExport(dataDir, id) {
  loadFromDisk(dataDir)
  const j = jobs.get(id)
  return j ? view(j) : null
}

/** The folder a finished export's pack lives in, or null when it is not ready. */
export function packDirOf(dataDir, id) {
  loadFromDisk(dataDir)
  const j = jobs.get(id)
  if (!j || j.state !== 'done') return null
  return join(exportsRoot(dataDir), id, PACK_DIR)
}

/** The ZIP entries of a finished export (path, bytes and CRC measured when it was built). */
export function zipEntriesOf(dataDir, id) {
  loadFromDisk(dataDir)
  return jobs.get(id)?.files ?? []
}

function loadFromDisk(dataDir) {
  if (loaded) return
  loaded = true
  const root = exportsRoot(dataDir)
  if (!existsSync(root)) return
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === WORK_DIR || jobs.has(e.name)) continue
    try {
      const j = JSON.parse(readFileSync(join(root, e.name, META_FILE), 'utf8'))
      // A job recorded as running cannot still be running: this process has just started.
      if (j.state === 'running') {
        j.state = 'failed'
        j.error = 'the server restarted while this export was being made'
      }
      jobs.set(j.id, j)
    } catch {
      // A folder without readable metadata is not an export anyone can be told about. Left alone
      // rather than deleted: deleting footage-shaped things on a parse error is how data is lost.
    }
  }
}

const saveMeta = (dataDir, j, dir) => {
  const target = dir ?? join(exportsRoot(dataDir), j.id)
  try {
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, META_FILE), JSON.stringify(j, null, 2))
  } catch (e) {
    console.warn(`[export] could not record ${j.id}: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------- running a job

/**
 * Starts an export. Returns at once with the job; the work happens in the background.
 * @param {object} body the request (format, clips, name, notes, everySeconds)
 * @param {{dataDir:string, index:object, who:object, user:string, clockOf?:(nvr:string)=>number}} deps
 *   clockOf: that NVR's clock offset in ms (NVR clock - server clock), 0 when unknown.
 */
export function startExport(body, { dataDir, index, who, user, clockOf = () => 0, ip = '' }) {
  loadFromDisk(dataDir)
  // An export nobody can be named for is not evidence, and the name is signed into the manifest,
  // so an unnamed caller is refused before any work is done rather than recorded as '?'. The name
  // comes from the session (server.mjs), never from the request body.
  if (!String(who?.user ?? user ?? '')) throw new ExportError(401, 'exports must be signed in for; there is no user on this request')
  if (running) throw new ExportError(409, 'another export is being made; wait for it to finish or cancel it')
  const plan = planExport(body, { index, who })
  const id = randomUUID()
  const job = {
    id,
    name: plan.name,
    format: plan.format,
    notes: plan.notes,
    everyS: plan.everyS,
    // The exporter's identity comes from the session (server.mjs), never from the request body,
    // and it ends up signed into the pack manifest. An export nobody can be named for is not
    // evidence, so an unnamed caller is refused outright rather than recorded as '?'.
    by: String(who?.user ?? user ?? ''),
    byAdmin: who?.admin === true,
    byIp: String(ip ?? ''),
    state: 'running',
    error: '',
    startedAt: new Date().toISOString(),
    endedAt: null,
    bytes: 0,
    bytesTotal: plan.bytes,
    files: [],
    cancelled: false,
    clips: plan.clips.map((c) => ({ nvr: c.nvr, ch: c.ch, fromMs: c.fromMs, toMs: c.toMs, bytes: c.bytes, offsetMs: Math.trunc(clockOf(c.nvr) || 0) })),
    progress: { step: 'starting', pct: 0, bytesDone: 0, bytesTotal: plan.bytes, message: '' }
  }
  jobs.set(id, job)
  const work = join(workRoot(dataDir), id)
  running = runJob(job, plan, { dataDir, work })
    .then(() => {
      if (job.state === 'running') job.state = 'done'
    })
    .catch((e) => {
      job.state = job.cancelled ? 'cancelled' : 'failed'
      job.error = job.cancelled ? 'cancelled' : e.message
      console.warn(`[export] ${id} ${job.state}: ${job.error}`)
    })
    .finally(() => {
      job.endedAt = new Date().toISOString()
      job.progress.pct = job.state === 'done' ? 100 : job.progress.pct
      job.progress.step = job.state
      // A failed or cancelled job leaves nothing behind at all: the work folder goes, and no
      // finished folder was ever created, so there is nothing to download and nothing to mistake
      // for evidence.
      if (job.state !== 'done') rmSync(work, { recursive: true, force: true })
      else saveMeta(dataDir, job)
      running = null
    })
  return view(job)
}

/** Waits for the job in flight (tests; the API never waits). */
export const settled = () => running ?? Promise.resolve()

/** Asks a running job to stop. It stops at the next chunk boundary and cleans up after itself. */
export function cancelExport(dataDir, id) {
  loadFromDisk(dataDir)
  const j = jobs.get(id)
  if (!j) return null
  if (j.state === 'running') {
    j.cancelled = true
    return view(j)
  }
  return view(j)
}

/** Cancels if it is running, then removes the export and everything in it. */
export function removeExport(dataDir, id) {
  loadFromDisk(dataDir)
  const j = jobs.get(id)
  if (!j) return false
  if (j.state === 'running') j.cancelled = true
  jobs.delete(id)
  rmSync(join(exportsRoot(dataDir), id), { recursive: true, force: true })
  rmSync(join(workRoot(dataDir), id), { recursive: true, force: true })
  return true
}

/**
 * Hands the event loop back. Called between every chunk read and every GOP: the recorders share
 * this process's event loop with a live worker's sockets, and an export that ran a tight read loop
 * would delay them. pauseMs adds a real delay (tests, and a possible future "gentle" setting).
 */
const breathe = () => new Promise((resolve) => (pauseMs > 0 ? setTimeout(resolve, pauseMs) : setImmediate(resolve)))

const stopIfCancelled = (job) => {
  if (job.cancelled) throw new ExportError(499, 'cancelled')
}

async function runJob(job, plan, { dataDir, work }) {
  const packDir = join(work, PACK_DIR)
  mkdirSync(packDir, { recursive: true })
  job.progress.step = 'reading'

  const add = (path, m) => {
    job.files.push({ path: posix(path), bytes: m.bytes, sha256: m.sha256, crc32: m.crc32 })
  }
  const onBytes = (n) => {
    job.bytes += n
    job.progress.bytesDone = job.bytes
    job.progress.pct = job.bytesTotal ? Math.min(99, Math.round((job.bytes / job.bytesTotal) * 100)) : 0
  }

  for (let i = 0; i < plan.clips.length; i++) {
    stopIfCancelled(job)
    const planned = plan.clips[i]
    const clip = job.clips[i]
    job.progress.message = `${clip.nvr} channel ${clip.ch}`
    if (plan.format === 'pack') await packClip(planned, clip, { packDir, add, onBytes, job })
    else if (plan.format === 'mp4') await mp4Clip(planned, clip, { packDir, add, onBytes, job })
    else await stillsClip(planned, clip, { packDir, add, onBytes, job, everyS: plan.everyS })
  }
  stopIfCancelled(job)

  // The player, copied in as it is. Task 4 owns the file; until it exists there is simply no player
  // in the pack, which is honest, rather than a broken link in the manifest.
  if (existsSync(PLAYER_SRC)) add(PLAYER_NAME, await copyHashed(PLAYER_SRC, join(packDir, PLAYER_NAME)))
  else job.progress.message = 'no pack player is installed yet, so none was copied in'

  stopIfCancelled(job)
  job.progress.step = 'signing'
  const manifest = buildManifest({
    files: job.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
    clips: job.clips.map((c) => ({ camera: `${c.nvr} channel ${c.ch}`, nvr: c.nvr, startMs: c.actualStartMs ?? c.fromMs, endMs: c.actualEndMs ?? c.toMs })),
    clocks: [...new Map(job.clips.map((c) => [c.nvr, { nvr: c.nvr, offsetMs: c.offsetMs }])).values()],
    exportedBy: job.by,
    // Signed into the manifest: the account, whether it held admin at the time, and where from.
    identity: { user: job.by, admin: job.byAdmin === true, ip: job.byIp ?? '', via: 'cctv-export' },
    exportedAt: Date.now(),
    notes: job.notes
  })
  // Both times, and what was asked for. buildManifest states the server's time; a reader who only
  // ever saw one of them could not tell whether a clip labelled 14:00 was 14:00 by the NVR's clock
  // or by ours, and on nvr1 those are nearly four minutes apart.
  // Matched on the camera label buildManifest was given, not on position: it sorts its clips.
  const byKey = new Map(job.clips.map((c) => [`${c.nvr} channel ${c.ch}`, c]))
  manifest.clips = manifest.clips.map((m) => {
    const c = byKey.get(m.camera) ?? null
    if (!c) return m
    const iso = (ms) => new Date(ms).toISOString()
    return {
      ...m,
      offsetMs: c.offsetMs,
      startNvr: iso((c.actualStartMs ?? c.fromMs) + c.offsetMs),
      endNvr: iso((c.actualEndMs ?? c.toMs) + c.offsetMs),
      requestedStart: iso(c.fromMs),
      requestedEnd: iso(c.toMs),
      trimmedToKeyframes: true
    }
  })
  const { privateKey } = ensureKey(dataDir)
  writePack(packDir, signManifest(manifest, privateKey))
  // The signed pair is part of the download, so it is listed among the ZIP entries (never among
  // the manifest's own files, which is why it is added only now).
  for (const name of ['manifest.json', 'signature.json']) {
    const full = join(packDir, name)
    const buf = readFileSync(full)
    job.files.push({ path: name, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), crc32: crcEnd(crcUpdate(crcStart(), buf)) })
  }

  stopIfCancelled(job)
  // Only now does the export exist. Renaming a folder is atomic on both Linux and Windows, so
  // there is no moment when a partly built export is sitting where a download would find it.
  const final = join(exportsRoot(dataDir), job.id)
  rmSync(final, { recursive: true, force: true })
  mkdirSync(exportsRoot(dataDir), { recursive: true })
  renameSync(work, final)
  job.state = 'done'
  // The audit trail must reach the packs: this row is how 'who exported that clip' is answerable
  // without opening the pack. It can never fail the export (audit() does not throw).
  audit(dataDir, { user: job.by, action: 'export', target: job.clips.map((c) => `${c.nvr}/${c.ch}`).join(' '), ip: job.byIp, detail: `${job.format} export "${job.name}" (${job.id}), ${job.bytes} bytes` })
  job.progress = { step: 'done', pct: 100, bytesDone: job.bytes, bytesTotal: job.bytesTotal, message: '' }
}

// ---- pack: the recorded files, unchanged -----------------------------------

async function packClip(planned, clip, { packDir, add, onBytes, job }) {
  const folder = `clips/${camKey(clip.nvr, clip.ch)}`
  let first = null
  let last = null
  for (const seg of planned.segments) {
    stopIfCancelled(job)
    if (!existsSync(seg.path)) continue // housekeeping may have deleted it since the plan was made
    const name = `${folder}/${basename(seg.path)}`
    add(name, await copyHashed(seg.path, join(packDir, name.split('/').join(sep)), onBytes))
    // The .idx goes too when it is there: it is recorded data, and it is what lets a reader find
    // the keyframes without scanning the whole file.
    if (existsSync(`${seg.path}.idx`)) {
      const idx = `${name}.idx`
      add(idx, await copyHashed(`${seg.path}.idx`, join(packDir, idx.split('/').join(sep))))
    }
    first = first === null ? seg.startMs : Math.min(first, seg.startMs)
    last = last === null ? seg.endMs : Math.max(last, seg.endMs)
    await breathe()
  }
  // A pack carries whole segment files, so the range it really covers is the segments' own span,
  // which reaches outside what was asked for. Saying otherwise would misstate the evidence.
  clip.actualStartMs = first ?? clip.fromMs
  clip.actualEndMs = last ?? clip.toMs
}

// ---- mp4: the same frames, a different wrapper -----------------------------

/**
 * The frames of one clip, trimmed at keyframe boundaries: everything from the last keyframe at or
 * before the requested start (a cut anywhere else would start with frames that cannot be decoded)
 * up to the last frame at or before the requested end.
 */
async function readFrames(planned, clip, job, onBytes) {
  const frames = []
  let codec = null
  for (const seg of planned.segments) {
    stopIfCancelled(job)
    if (!existsSync(seg.path)) continue
    codec ??= codecOfPath(seg.path) === CODEC.h265 ? 'h265' : 'h264'
    const reader = new SegmentReader({ path: seg.path, endMs: seg.endMs })
    await reader.open()
    try {
      let k = keyAtOrBefore(reader.times, clip.fromMs)
      if (k < 0) k = 0
      for (; k < reader.rows.length; k++) {
        stopIfCancelled(job)
        if (reader.times[k] > clip.toMs) break
        for (const f of await reader.gop(k)) {
          if (f.ts > clip.toMs) continue
          // Copied out of the reader's shared read buffer: the buffer is reused for the next GOP.
          frames.push({ bytes: Buffer.from(f.buf), ptsMs: f.ts, keyframe: f.isKey })
          onBytes?.(f.buf.length)
        }
        await breathe()
      }
    } finally {
      await reader.close()
    }
  }
  frames.sort((a, b) => a.ptsMs - b.ptsMs)
  return { frames, codec: codec ?? 'h264' }
}

async function mp4Clip(planned, clip, { packDir, add, onBytes, job }) {
  const { frames, codec } = await readFrames(planned, clip, job, onBytes)
  if (!frames.length) {
    clip.actualStartMs = clip.fromMs
    clip.actualEndMs = clip.fromMs
    return
  }
  clip.actualStartMs = Math.round(frames[0].ptsMs)
  clip.actualEndMs = Math.round(frames.at(-1).ptsMs)
  const name = `clips/${camKey(clip.nvr, clip.ch)}.mp4`
  // ptsMs is rebased to zero: mp4.mjs writes no edit list, so the wall-clock time of the clip
  // belongs in the manifest, which is where it is.
  const base = frames[0].ptsMs
  const buf = writeMp4({ frames: frames.map((f) => ({ ...f, ptsMs: f.ptsMs - base })), codec })
  add(name, writeHashed(join(packDir, name.split('/').join(sep)), buf))
}

// ---- stills: JPEGs from keyframes ------------------------------------------

const runFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err) => {
      if (!err) return resolve()
      if (err.code === 'ENOENT') return reject(new Error('ffmpeg is not installed, so stills cannot be made (deploy/install-ubuntu.sh installs it)'))
      reject(new Error(`ffmpeg failed: ${String(err.message).split('\n')[0]}`))
    })
  })

/**
 * One JPEG per keyframe, no closer together than everySeconds.
 *
 * This is the one place ffmpeg is used, and only because there is no JPEG encoder here. It decodes
 * a single keyframe that is written out on its own, and it never touches the video that goes into
 * the export: the pack and MP4 paths above copy the recorded bytes through untouched, which is
 * what makes the export evidence. A still is an illustration, and the manifest hashes it like
 * anything else so it cannot be swapped afterwards.
 */
async function stillsClip(planned, clip, { packDir, add, onBytes, job, everyS }) {
  const folder = `stills/${camKey(clip.nvr, clip.ch)}`
  // The single keyframe handed to ffmpeg goes beside the pack, never inside it: a stray temp file
  // in the pack would be an unaccounted-for file and would fail verification.
  const tmp = join(dirname(packDir), `.still-${process.pid}.${codecExt(planned)}`)
  let lastAt = -Infinity
  let made = 0
  let first = null
  let last = null
  try {
    for (const seg of planned.segments) {
      stopIfCancelled(job)
      if (!existsSync(seg.path)) continue
      const reader = new SegmentReader({ path: seg.path, endMs: seg.endMs })
      await reader.open()
      try {
        for (let k = 0; k < reader.rows.length; k++) {
          stopIfCancelled(job)
          const ts = reader.times[k]
          if (ts < clip.fromMs || ts > clip.toMs) continue
          if (ts - lastAt < everyS * 1000) continue
          if (made >= STILL_MAX) break
          const key = await reader.keyframe(k)
          if (!key) continue
          writeFileSync(tmp, key.buf)
          const name = `${folder}/${new Date(Math.round(ts)).toISOString().replace(/[:.]/g, '-')}.jpg`
          const out = join(packDir, name.split('/').join(sep))
          mkdirSync(dirname(out), { recursive: true })
          await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-frames:v', '1', '-q:v', '2', out])
          add(name, hashOf(out))
          onBytes?.(key.buf.length)
          lastAt = ts
          made++
          first = first === null ? ts : first
          last = ts
          await breathe()
        }
      } finally {
        await reader.close()
      }
    }
  } finally {
    rmSync(tmp, { force: true })
  }
  if (!made) throw new ExportError(404, `no keyframes were found for ${clip.nvr} channel ${clip.ch} in that range, so there are no stills to export`)
  clip.actualStartMs = Math.round(first)
  clip.actualEndMs = Math.round(last)
}

const codecExt = (planned) => (planned.segments.some((s) => codecOfPath(s.path) === CODEC.h265) ? 'h265' : 'h264')

function hashOf(file) {
  const buf = readFileSync(file)
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), crc32: crcEnd(crcUpdate(crcStart(), buf)) }
}

export const _test = {
  reset() {
    jobs.clear()
    loaded = false
    running = null
    pauseMs = 0
  },
  setPause(ms) {
    pauseMs = ms
  },
  jobs
}
