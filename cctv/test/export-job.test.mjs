// Tests for the export job (export-job.mjs) and its routes (export-api.mjs).
//
// The footage is synthetic but real bitstreams: segment files written here in the same shape
// segment-writer.mjs produces (Annex B back to back, plus a 16-byte-per-keyframe .idx), and an
// H.264 SPS written bit by bit so mp4.mjs can parse a picture size out of it. Nothing touches an
// NVR, a real recording drive or ffmpeg.
//
//   node cctv/test/export-job.test.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const throwsAsync = async (fn) => {
  try {
    await fn()
    return ''
  } catch (e) {
    return e.message
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const job = await import('../export-job.mjs')
const { handleExports } = await import('../export-api.mjs')
const { verifyPack } = await import('../export-pack.mjs')

// ---- synthetic footage ---------------------------------------------------------------------

class BitWriter {
  constructor() {
    this.bits = []
  }
  u(n, v) {
    for (let i = n - 1; i >= 0; i--) this.bits.push((v / 2 ** i) & 1)
    return this
  }
  ue(v) {
    const c = v + 1
    const n = 32 - Math.clz32(c)
    this.u(n - 1, 0)
    return this.u(n, c)
  }
  end() {
    this.bits.push(1)
    while (this.bits.length % 8) this.bits.push(0)
    return this
  }
  bytes() {
    const b = Buffer.alloc(this.bits.length / 8)
    this.bits.forEach((bit, i) => {
      if (bit) b[i >> 3] |= 1 << (7 - (i & 7))
    })
    return b
  }
}
/** RBSP to NAL payload: an emulation prevention byte after every pair of zeros. */
const escape = (rbsp) => {
  const out = []
  let zeros = 0
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3)
      zeros = 0
    }
    out.push(b)
    zeros = b === 0 ? zeros + 1 : 0
  }
  return Buffer.from(out)
}
const h264Sps = () => {
  const w = new BitWriter()
  w.u(8, 66).u(8, 0).u(8, 30)
  w.ue(0).ue(0).ue(2).ue(1).u(1, 0)
  w.ue(640 / 16 - 1).ue(368 / 16 - 1)
  w.u(1, 1).u(1, 1).u(1, 0) // frame_mbs_only, direct_8x8, no cropping
  w.u(1, 0)
  return Buffer.concat([Buffer.from([0x67]), escape(w.end().bytes())])
}
const START4 = Buffer.from([0, 0, 0, 1])
const START3 = Buffer.from([0, 0, 1])
const annexB = (nals) => Buffer.concat(nals.flatMap((n, i) => [i % 2 ? START3 : START4, n]))
const SPS = h264Sps()
const PPS = Buffer.concat([Buffer.from([0x68]), Buffer.from([0xce, 0x38, 0x80])])
// The byte after the slice header's first byte has its top bit set: first_mb_in_slice == 0, which
// is what rec-reader.mjs splits access units on.
const idr = (n) => Buffer.concat([Buffer.from([0x65, 0x88]), Buffer.alloc(n, 0xa5)])
const slice = (n) => Buffer.concat([Buffer.from([0x41, 0x9a]), Buffer.alloc(n, 0x5a)])

const GOP_MS = 2000
const FRAME_MS = 400
const FRAMES_PER_GOP = 5

/**
 * One segment file plus its .idx: `gops` GOPs, a keyframe every GOP_MS from startMs.
 * @returns {{path:string, startMs:number, endMs:number, bytes:number, keyframes:number, keyTimes:number[]}}
 */
function writeSegment(dir, name, startMs, gops) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.h264`)
  const parts = []
  const rows = []
  const keyTimes = []
  let at = 0
  for (let g = 0; g < gops; g++) {
    const ts = startMs + g * GOP_MS
    rows.push({ offset: at, tsMs: ts })
    keyTimes.push(ts)
    const key = annexB([SPS, PPS, idr(500 + g)])
    parts.push(key)
    at += key.length
    for (let f = 1; f < FRAMES_PER_GOP; f++) {
      const p = annexB([slice(200 + f)])
      parts.push(p)
      at += p.length
    }
  }
  const data = Buffer.concat(parts)
  writeFileSync(path, data)
  const idx = Buffer.alloc(rows.length * 16)
  rows.forEach((r, i) => {
    idx.writeBigUInt64LE(BigInt(r.offset), i * 16)
    idx.writeBigInt64LE(BigInt(r.tsMs), i * 16 + 8)
  })
  writeFileSync(`${path}.idx`, idx)
  return { path, startMs, endMs: startMs + (gops - 1) * GOP_MS + (FRAMES_PER_GOP - 1) * FRAME_MS, bytes: data.length, keyframes: rows.length, keyTimes }
}

const root = mkdtempSync(join(tmpdir(), 'cctv-export-test-'))
const dataDir = join(root, 'data')
const recDir = join(root, 'rec')
const T0 = Date.UTC(2026, 8, 24, 10, 0, 0)
const segA = writeSegment(recDir, 'a', T0, 10) // keyframes T0 .. T0+18000
const segB = writeSegment(recDir, 'b', T0 + 20_000, 5) // T0+20000 .. T0+28000

/** A stand-in for rec-index.mjs: only segments() is used by the job. */
const fakeIndex = (segments = [segA, segB]) => ({
  segments: (nvr, ch, fromMs, toMs) => segments.filter((s) => s.endMs >= fromMs && s.startMs <= toMs).map((s) => ({ nvr, ch, path: s.path, startMs: s.startMs, endMs: s.endMs, bytes: s.bytes, keyframes: s.keyframes, loc: 'loc1' }))
})

const ADMIN = { user: 'boss', admin: true }
const VIEWER = { user: 'jo', admin: false }
const NVR1_SKEW = 220_000 // nvr1 runs about 220 s fast
const clockOf = (id) => (id === 'nvr1' ? NVR1_SKEW : 0)

const clip = (over = {}) => ({ nvr: 'nvr1', ch: 1, fromMs: T0 + 5000, toMs: T0 + 11_000, ...over })
const request = (over = {}) => ({ format: 'pack', name: 'break-in', notes: 'front door', clips: [clip()], ...over })

const runToEnd = async () => {
  await job.settled()
  await wait(10)
}

// ---- the bounds ----------------------------------------------------------------------------

{
  const index = fakeIndex()
  const long = await throwsAsync(() => job.planExport(request({ clips: [clip({ toMs: T0 + 5 * 3_600_000 })] }), { index, who: ADMIN }))
  check('a clip over 4 hours is refused', /at most 4\.00 hours/.test(long), long)
  check('the refusal names the figure actually asked for', /4\.99 hours|5\.00 hours/.test(long), long)

  const over = await throwsAsync(() => job.planExport(request(), { index: fakeIndex([{ ...segA, bytes: 60 * 1024 ** 3 }]), who: ADMIN }))
  check('over 50 GB is refused', /at most 50\.0 GB/.test(over) && /60\.0 GB/.test(over), over)

  const mp4Big = await throwsAsync(() => job.planExport(request({ format: 'mp4' }), { index: fakeIndex([{ ...segA, bytes: 4 * 1024 ** 3 }]), who: ADMIN }))
  check('an MP4 larger than memory allows is refused with a way out', /pack format/.test(mp4Big), mp4Big)

  const empty = await throwsAsync(() => job.planExport(request({ clips: [clip({ fromMs: T0 - 900_000, toMs: T0 - 600_000 })] }), { index, who: ADMIN }))
  check('a range with no recordings is refused', /no recordings/.test(empty), empty)
}

// ---- the rights check ----------------------------------------------------------------------

{
  const refused = await throwsAsync(() => job.planExport(request(), { index: fakeIndex(), who: VIEWER }))
  check('a non-admin is refused by the rights check, not by the route alone', /not allowed to export/.test(refused), refused)

  job._test.reset()
  const list = await handleExports({ method: 'GET', pathname: '/api/exports', who: VIEWER, user: 'jo', index: fakeIndex(), dataDir })
  check('GET /api/exports refuses a non-admin with 403', list[0] === 403, JSON.stringify(list))
  const start = await handleExports({ method: 'POST', pathname: '/api/exports', readJson: async () => request(), who: VIEWER, user: 'jo', index: fakeIndex(), dataDir })
  check('POST /api/exports refuses a non-admin with 403', start[0] === 403, JSON.stringify(start))
  check('nothing was written for the refused request', !existsSync(join(dataDir, 'exports')))
}

// ---- a pack: trimmed at keyframes, and it verifies -------------------------------------------

{
  job._test.reset()
  const started = job.startExport(request(), { dataDir, index: fakeIndex(), who: ADMIN, user: 'boss', clockOf })
  check('starting answers at once with a running job', started.state === 'running' && Boolean(started.id), started.state)
  await runToEnd()
  const done = job.getExport(dataDir, started.id)
  check('the pack job finishes', done.state === 'done' && done.progress.pct === 100, `${done.state} ${done.error}`)

  const dir = job.packDirOf(dataDir, started.id)
  const v = verifyPack(dir)
  check('the produced pack passes verifyPack', v.ok, v.problems.join('; '))

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const m = manifest.clips[0]
  check('the manifest names who exported it and the notes', manifest.exportedBy === 'boss' && manifest.notes === 'front door', manifest.exportedBy)
  check('a pack carries the original segment bytes unchanged', readFileSync(join(dir, 'clips', 'nvr1-ch1', 'a.h264')).equals(readFileSync(segA.path)))
  check('the .idx goes with it', existsSync(join(dir, 'clips', 'nvr1-ch1', 'a.h264.idx')))
  check('the manifest states the range the pack really covers, not the one asked for', Date.parse(m.startServer) === segA.startMs && Date.parse(m.endServer) === segA.endMs, `${m.startServer}..${m.endServer}`)
  check('what was asked for is recorded too', Date.parse(m.requestedStart) === T0 + 5000 && Date.parse(m.requestedEnd) === T0 + 11_000, `${m.requestedStart}..${m.requestedEnd}`)
  check("the NVR's clock offset is in the manifest", manifest.clocks[0].nvr === 'nvr1' && manifest.clocks[0].offsetMs === NVR1_SKEW, JSON.stringify(manifest.clocks))
  check("both times are stated: the server's and the NVR's own", Date.parse(m.startNvr) - Date.parse(m.startServer) === NVR1_SKEW && m.offsetMs === NVR1_SKEW, `${m.startServer} / ${m.startNvr}`)
  check('the player is noted as absent rather than listed when it does not exist yet', existsSync(join(dir, 'pack-player.html')) === existsSync(join(import.meta.dirname, '..', 'public', 'pack-player.html')))

  // Tampering: the pack is only evidence if changing it shows.
  const target = join(dir, 'clips', 'nvr1-ch1', 'a.h264')
  const original = readFileSync(target)
  const altered = Buffer.from(original)
  altered[altered.length - 1] ^= 0xff
  writeFileSync(target, altered)
  check('changing one byte of the video makes verification fail', verifyPack(dir).ok === false)
  writeFileSync(target, original)

  check('the ZIP entry list covers every file in the pack', job.zipEntriesOf(dataDir, started.id).length >= manifest.files.length + 2)
  job.removeExport(dataDir, started.id)
}

// ---- mp4: trimmed at keyframe boundaries ------------------------------------------------------

{
  job._test.reset()
  const started = job.startExport(request({ format: 'mp4' }), { dataDir, index: fakeIndex([segA]), who: ADMIN, user: 'boss', clockOf })
  await runToEnd()
  const done = job.getExport(dataDir, started.id)
  check('the mp4 job finishes', done.state === 'done', `${done.state} ${done.error}`)
  const dir = job.packDirOf(dataDir, started.id)
  check('one MP4 per camera, alongside the signed manifest', existsSync(join(dir, 'clips', 'nvr1-ch1.mp4')) && existsSync(join(dir, 'signature.json')))
  check('the mp4 pack verifies', verifyPack(dir).ok, verifyPack(dir).problems.join('; '))

  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).clips[0]
  const start = Date.parse(m.startServer)
  const end = Date.parse(m.endServer)
  check('the clip starts at the keyframe at or before the requested start', start <= T0 + 5000 && start > T0 + 5000 - GOP_MS - FRAME_MS, `${start - T0} ms into the file`)
  check('so the manifest states a start earlier than the one asked for', start < Date.parse(m.requestedStart))
  check('and it does not run past the requested end', end <= T0 + 11_000 && end > T0 + 11_000 - GOP_MS, `${end - T0}`)
  check('the manifest says the trim was to keyframes', m.trimmedToKeyframes === true)
  // The MP4 itself: ftyp first, and it holds fewer frames than the whole file.
  const mp4 = readFileSync(join(dir, 'clips', 'nvr1-ch1.mp4'))
  check('the MP4 starts with an ftyp box', mp4.subarray(4, 8).toString('latin1') === 'ftyp')
  check('the MP4 is smaller than the whole segment: it was trimmed', mp4.length < segA.bytes, `${mp4.length} of ${segA.bytes}`)
  job.removeExport(dataDir, started.id)
}

// ---- cancellation ------------------------------------------------------------------------------

{
  job._test.reset()
  job._test.setPause(25) // make the reads slow enough to cancel in the middle
  const started = job.startExport(request(), { dataDir, index: fakeIndex(), who: ADMIN, user: 'boss', clockOf })
  await wait(40)
  job.cancelExport(dataDir, started.id)
  await runToEnd()
  const done = job.getExport(dataDir, started.id)
  check('a cancelled job says so', done.state === 'cancelled', `${done.state} ${done.error}`)
  check('a cancelled job leaves nothing to download', job.packDirOf(dataDir, started.id) === null && !existsSync(join(dataDir, 'exports', started.id)))
  check('and nothing is left in the working folder', !existsSync(join(dataDir, 'exports', '.work', started.id)))
  job._test.setPause(0)
  job.removeExport(dataDir, started.id)
}

// ---- a failed job -------------------------------------------------------------------------------

{
  job._test.reset()
  // A segment whose .idx is missing: the reader cannot open it, so the job fails part-way.
  const broken = writeSegment(join(root, 'broken'), 'c', T0, 3)
  rmSync(`${broken.path}.idx`)
  const started = job.startExport(request({ format: 'mp4' }), { dataDir, index: fakeIndex([broken]), who: ADMIN, user: 'boss', clockOf })
  await runToEnd()
  const done = job.getExport(dataDir, started.id)
  check('a job that fails part-way is reported as failed, with why', done.state === 'failed' && done.error.length > 0, `${done.state}: ${done.error}`)
  check('a failed job leaves nothing downloadable', job.packDirOf(dataDir, started.id) === null && !existsSync(join(dataDir, 'exports', started.id)))
  check('and no half-made pack is left in the working folder', !existsSync(join(dataDir, 'exports', '.work', started.id)))
  const dl = await handleExports({ method: 'GET', pathname: `/api/exports/${started.id}`, who: ADMIN, user: 'boss', index: fakeIndex(), dataDir })
  check('its progress can still be read, so the page can say what went wrong', dl[0] === 200 && dl[1].state === 'failed' && dl[1].ready === false)
  job.removeExport(dataDir, started.id)
}

// ---- stills (needs ffmpeg; without it the job must say so plainly) -------------------------------

{
  job._test.reset()
  const started = job.startExport(request({ format: 'stills', everySeconds: 4 }), { dataDir, index: fakeIndex([segA]), who: ADMIN, user: 'boss', clockOf })
  await runToEnd()
  const done = job.getExport(dataDir, started.id)
  if (done.state === 'done') {
    const dir = job.packDirOf(dataDir, started.id)
    const shots = readdirSync(join(dir, 'stills', 'nvr1-ch1'))
    check('stills: a JPEG per keyframe, no closer together than asked', shots.length >= 2 && shots.every((f) => f.endsWith('.jpg')), shots.join())
    check('stills: the pack verifies, so the JPEGs are hashed like everything else', verifyPack(dir).ok, verifyPack(dir).problems.join('; '))
    check('stills: no temp keyframe file is left inside the pack', !readdirSync(dir).some((f) => f.startsWith('.still')))
  } else {
    check('stills: without ffmpeg the job fails with a message that names it', /ffmpeg/.test(done.error), done.error)
    console.log('NOTE  ffmpeg is not installed here, so the stills output itself was not checked')
  }
  job.removeExport(dataDir, started.id)
}

// ---- the routes ---------------------------------------------------------------------------------

{
  job._test.reset()
  const api = (method, pathname, body) => handleExports({ method, pathname, readJson: async () => body, who: ADMIN, user: 'boss', index: fakeIndex(), dataDir, clockOf })
  check('an unrelated path is not ours', (await api('GET', '/api/playback/timeline')) === null)
  const created = await api('POST', '/api/exports', request())
  check('POST /api/exports answers 201 with the job', created[0] === 201 && created[1].state === 'running' && created[1].format === 'pack', JSON.stringify(created[0]))
  const busy = await api('POST', '/api/exports', request())
  check('a second export while one is running answers 409', busy[0] === 409, JSON.stringify(busy))
  await runToEnd()
  const id = created[1].id
  const got = await api('GET', `/api/exports/${id}`)
  check('GET /api/exports/:id gives progress and the real clip times', got[0] === 200 && got[1].ready === true && got[1].clips[0].startMs === segA.startMs && got[1].clips[0].requestedFromMs === T0 + 5000, JSON.stringify(got[1]?.clips))
  const listed = await api('GET', '/api/exports')
  check('GET /api/exports lists it', listed[0] === 200 && listed[1].exports.some((e) => e.id === id))
  check('the download name is offered to the page', got[1].downloadName === 'break-in.zip', got[1].downloadName)
  check('an unknown id is 404', (await api('GET', '/api/exports/does-not-exist'))[0] === 404)
  check('PUT is not allowed', (await api('PUT', '/api/exports'))[0] === 405)
  const gone = await api('DELETE', `/api/exports/${id}`)
  check('DELETE removes it, folder and all', gone[0] === 200 && !existsSync(join(dataDir, 'exports', id)))
  check('deleting it twice is a 404, not a crash', (await api('DELETE', `/api/exports/${id}`))[0] === 404)
}

// ---- the ZIP wrapper and the streaming crypto ------------------------------------------------------

{
  const dir = join(root, 'zip')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'one.txt'), 'hello')
  const entries = [{ path: 'one.txt', bytes: 5, crc32: 0x3610a686 }]
  const chunks = []
  for await (const c of job.zipStream(dir, entries)) chunks.push(c)
  const zip = Buffer.concat(chunks)
  check('the ZIP starts with a local file header and ends with the central directory record', zip.readUInt32LE(0) === 0x04034b50 && zip.readUInt32LE(zip.length - 22) === 0x06054b50)
  check('the file is stored, not compressed, so the bytes inside are unchanged', zip.readUInt16LE(8) === 0 && zip.includes(Buffer.from('hello')))

  const src = join(dir, 'one.txt')
  const enc = join(dir, 'one.enc')
  await job.encryptFileStream(src, enc, 'correct horse')
  check('an encrypted file is not the plaintext', !readFileSync(enc).includes(Buffer.from('hello')))
  const wrong = await throwsAsync(() => job.decryptFileStream(enc, join(dir, 'bad.txt'), 'wrong'))
  check('a wrong password fails cleanly and writes nothing', /wrong password/.test(wrong) && !existsSync(join(dir, 'bad.txt')), wrong)
  await job.decryptFileStream(enc, join(dir, 'back.txt'), 'correct horse')
  check('the right password gives the bytes back', readFileSync(join(dir, 'back.txt'), 'utf8') === 'hello')
  const { decryptFile } = await import('../export-pack.mjs')
  decryptFile(enc, join(dir, 'viapack.txt'), 'correct horse')
  check('export-pack.mjs reads what the streaming encryptor wrote', readFileSync(join(dir, 'viapack.txt'), 'utf8') === 'hello')
  check('the streaming hash agrees with the file', (await job.hashFileStream(src)).length === 64)
}

// ---- exports never land on a recording location -------------------------------------------------

check('exports live under the data directory', existsSync(join(dataDir, 'exports')) && readdirSync(recDir).every((f) => !f.includes('export')))

rmSync(root, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nAll passed')
process.exit(failures ? 1 : 0)
