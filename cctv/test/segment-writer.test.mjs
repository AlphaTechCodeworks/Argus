// Tests for segment-writer.mjs: 1-minute segment files + .idx keyframe index. Temp dirs only.
// Uses a real clip (Annex B) when present: ../set/nvr1-13.bin (the lab) or CCTV_TEST_CLIP; ffprobe
// checks a segment decodes when ffprobe is installed. Run:  node cctv/test/segment-writer.test.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { SegmentWriter, readIdx, segmentPath } from '../segment-writer.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))

// ---- path naming (UTC)
{
  const p = segmentPath('/r', 'nvr1', 12, Date.UTC(2026, 8, 24, 7, 5, 30), 'h265')
  check('path is <root>/<nvr>/<ch>/<YYYY-MM-DD>/<HH>/<HH-MM>.<ext> in UTC', p.replace(/\\/g, '/') === '/r/nvr1/12/2026-09-24/07/07-05.h265', p)
}

// ---- synthetic frames: rollover, first file at a keyframe, exact bytes, idx
{
  const root = mkdtempSync(join(tmpdir(), 'segw-'))
  const w = new SegmentWriter({ root, nvrId: 'n1', ch: 3, codec: 'h264' })
  const segs = []
  w.on('segment', (s) => segs.push(s))
  const t0 = Date.UTC(2026, 8, 24, 10, 0, 50) // 10 s before a minute boundary
  const frames = []
  // 2 delta frames first (dropped: no keyframe yet), then 1 fps-ish frames every 500 ms, key every 4 s
  for (let i = 0; i < 2; i++) frames.push({ buf: Buffer.from([0, 0, 0, 1, 0x41, i]), isKey: false, ts: t0 - 1000 + i * 100 })
  for (let i = 0; i < 180; i++) {
    const isKey = i % 8 === 0
    const body = Buffer.alloc(isKey ? 40 : 10 + (i % 5), i & 0xff)
    body.writeUInt32BE(1, 0)
    body[4] = isKey ? 0x65 : 0x41
    frames.push({ buf: body, isKey, ts: t0 + i * 500 })
  }
  for (const f of frames) w.write(f.buf, { isKey: f.isKey, ts: f.ts })
  const t1 = performance.now()
  const lastP = w.close()
  check('write() and close() return at once (the disk work is queued)', performance.now() - t1 < 50 && lastP instanceof Promise)
  const last = await lastP
  const all = [...segs]
  check('close() resolves to the last segment and emits it', last && all.at(-1) === last)
  check('three segments (10:00, 10:01, 10:02)', all.length === 3, all.map((s) => s.path).join(' '))
  const names = all.map((s) => s.path.replace(/\\/g, '/').split('/').slice(-3).join('/'))
  check('files named by the minute of their first frame', names.join() === '2026-09-24/10/10-00.h264,2026-09-24/10/10-01.h264,2026-09-24/10/10-02.h264', names.join())
  // key every 4 s from 10:00:50 -> keys at :50 :54 :58 :02 ... ; first at or after 10:01:00 is 10:01:02
  check('rollover at the first keyframe at or after the minute', all[1].startMs === Date.UTC(2026, 8, 24, 10, 1, 2), new Date(all[1].startMs).toISOString())
  check('first file starts at a keyframe (leading deltas dropped)', all[0].startMs === t0)
  const kept = frames.slice(2)
  const want = Buffer.concat(kept.map((f) => f.buf))
  const got = Buffer.concat(all.map((s) => readFileSync(s.path)))
  check('bytes concatenated equal the input frames exactly', got.equals(want), `${got.length} vs ${want.length}`)
  check('bytes field matches file sizes', all.every((s) => statSync(s.path).size === s.bytes))
  let idxOk = true
  let keysTotal = 0
  for (const s of all) {
    const rows = readIdx(`${s.path}.idx`)
    keysTotal += rows.length
    if (rows.length !== s.keyframes) idxOk = false
    const data = readFileSync(s.path)
    for (const r of rows) if (data[r.offset + 4] !== 0x65) idxOk = false
    if (rows[0].offset !== 0 || rows[0].tsMs !== s.startMs) idxOk = false
  }
  check('.idx offsets point at keyframe starts, one row per keyframe', idxOk && keysTotal === kept.filter((f) => f.isKey).length)
  check('endMs is the last frame time', all.at(-1).endMs === kept.at(-1).ts)
  check('close() again resolves to null', (await w.close()) === null)
}

// ---- codec change closes the segment; the next one waits for a keyframe
{
  const root = mkdtempSync(join(tmpdir(), 'segw-'))
  const w = new SegmentWriter({ root, nvrId: 'n1', ch: 0, codec: 'h264' })
  const segs = []
  w.on('segment', (s) => segs.push(s))
  const t = Date.UTC(2026, 8, 24, 11, 0, 5)
  w.write(Buffer.from([0, 0, 0, 1, 0x65]), { isKey: true, ts: t })
  w.write(Buffer.from([0, 0, 0, 1, 0x41]), { isKey: false, ts: t + 40 })
  w.write(Buffer.from([0, 0, 0, 1, 2, 1]), { isKey: false, ts: t + 80, codec: 'h265' })
  await w.drained()
  check('codec change closes the segment', segs.length === 1 && segs[0].path.endsWith('.h264'))
  w.write(Buffer.from([0, 0, 0, 1, 0x26, 1]), { isKey: true, ts: t + 120, codec: 'h265' })
  const s = await w.close()
  check('new codec: new file with the new extension from the next keyframe', s?.path.endsWith('.h265') && s.bytes === 6, s?.path)
  w.write(Buffer.from([0, 0, 0, 1, 0x26, 2]), { isKey: true, ts: t + 200, codec: 'h265' })
  const s2 = await w.close()
  check('same minute twice: the second file gets a suffix, nothing overwritten', /11-00-2\.h265$/.test(s2?.path ?? '') && readFileSync(s.path).length === 6, s2?.path)
}

// ---- write failure: 'error' event, no throw, writer waits for a keyframe again
{
  const root = mkdtempSync(join(tmpdir(), 'segw-'))
  const blocked = join(root, 'ro')
  writeFileSync(blocked, 'not a folder') // mkdir under a file fails on every OS (also as root)
  const w = new SegmentWriter({ root: blocked, nvrId: 'n1', ch: 0, codec: 'h264' })
  const errs = []
  w.on('error', (e) => errs.push(e))
  let threw = false
  try {
    w.write(Buffer.from([0, 0, 0, 1, 0x65]), { isKey: true, ts: Date.now() })
  } catch {
    threw = true
  }
  await w.drained()
  check('unwritable location: error event, no throw', !threw && errs.length === 1, errs[0]?.message)
  check('the error says the location is not writable', /not writable/.test(errs[0]?.message ?? ''), errs[0]?.message)
  void chmodSync
}

// ---- a slow disk: write() never waits; over 8 MB queued -> drop with 'overflow', resume at a keyframe
{
  const root = mkdtempSync(join(tmpdir(), 'segw-slow-'))
  let openGate
  let gate = new Promise((r) => (openGate = r))
  let writevCalls = 0
  // node:fs/promises, except that every data write hangs until the gate opens
  const slowFs = {
    mkdir: (p, o) => fsp.mkdir(p, o),
    async open(p, flags) {
      const fh = await fsp.open(p, flags)
      return {
        async writev(bufs) { writevCalls++; await gate; return fh.writev(bufs) },
        write: (...a) => fh.write(...a),
        sync: () => fh.sync(),
        close: () => fh.close()
      }
    }
  }
  const w = new SegmentWriter({ root, nvrId: 'n1', ch: 5, codec: 'h264', fs: slowFs })
  const segs = []
  const overflows = []
  w.on('segment', (s) => segs.push(s))
  w.on('overflow', (o) => overflows.push(o))
  const MB = 1024 * 1024
  const frame = (i, isKey) => { const b = Buffer.alloc(MB, i & 0xff); b.writeUInt32BE(1, 0); b[4] = isKey ? 0x65 : 0x41; return b }
  const t0 = Date.UTC(2026, 8, 24, 13, 0, 1)
  const accepted = []
  let slowest = 0
  let firstDrop = -1
  for (let i = 0; i < 14; i++) {
    const b = frame(i, i % 5 === 0)
    const s = performance.now()
    const ok = w.write(b, { isKey: i % 5 === 0, ts: t0 + i * 40 })
    slowest = Math.max(slowest, performance.now() - s)
    if (ok) accepted.push(b)
    else if (firstDrop < 0) firstDrop = i
    await new Promise((r) => setImmediate(r)) // let the (hanging) disk work start
  }
  check('slow disk: write() never waits for the disk', slowest < 20, `${slowest.toFixed(1)} ms`)
  check('slow disk: frames dropped once more than 8 MB wait', firstDrop === 8 && accepted.length === 8, `first drop ${firstDrop}, accepted ${accepted.length}`)
  check("slow disk: one 'overflow' with a reason", overflows.length === 1 && /disk too slow/.test(overflows[0].reason), JSON.stringify(overflows))
  check('slow disk: queue status shows the drop', w.queueStatus().dropping === true && w.queueStatus().dropped === 6 && w.queueStatus().queuedBytes > 8 * MB, JSON.stringify(w.queueStatus()))
  check('slow disk: the file was closed at the drop', w.open === false)
  openGate()
  await w.drained()
  check('slow disk: the queued frames reach the disk, the file is closed and reported', segs.length === 1 && readFileSync(segs[0].path).equals(Buffer.concat(accepted)) && segs[0].bytes === 8 * MB, `${segs.length} ${segs[0]?.bytes}`)
  check('slow disk: writes were coalesced', writevCalls < 8, `${writevCalls} writev calls for 8 frames`)
  const small = (k) => Buffer.from([0, 0, 0, 1, k ? 0x65 : 0x41, 7])
  const d1 = w.write(small(false), { isKey: false, ts: t0 + 1000 })
  const k1 = w.write(small(true), { isKey: true, ts: t0 + 1040 })
  check('slow disk: after draining, recording resumes at the next keyframe (not before)', d1 === false && k1 === true && w.queueStatus().dropping === false)
  const s2 = await w.close()
  check('slow disk: the resumed part is a new file', s2 && s2.path !== segs[0].path && /13-00-2\.h264$/.test(s2.path) && s2.bytes === 6, s2?.path)
}

// ---- the 5 s rule: a write that has waited too long also means dropping
{
  const root = mkdtempSync(join(tmpdir(), 'segw-age-'))
  let now = 1_000_000
  const hang = new Promise(() => {})
  const stuckFs = { mkdir: (p, o) => fsp.mkdir(p, o), open: async () => ({ writev: () => hang, write: () => hang, sync: () => hang, close: async () => {} }) }
  const w = new SegmentWriter({ root, nvrId: 'n1', ch: 6, fs: stuckFs, now: () => now, maxQueueMs: 5000 }) // (default is 10 s)
  const overflows = []
  w.on('overflow', (o) => overflows.push(o))
  const f = (k) => Buffer.from([0, 0, 0, 1, k ? 0x65 : 0x41])
  const a = w.write(f(true), { isKey: true, ts: Date.UTC(2026, 8, 24, 14, 0, 0) })
  now += 4000
  const b = w.write(f(false), { isKey: false, ts: Date.UTC(2026, 8, 24, 14, 0, 4) })
  now += 1500
  const c = w.write(f(false), { isKey: false, ts: Date.UTC(2026, 8, 24, 14, 0, 5) })
  check('stuck disk: small frames queue while the oldest waits under 5 s', a && b)
  check('stuck disk: dropped once the oldest has waited over 5 s', c === false && overflows.length === 1 && /waited 5\.5 s/.test(overflows[0].reason), JSON.stringify(overflows))
}

// ---- the real clip: split into frames, fake timestamps at 25 fps crossing minute boundaries, ffprobe
{
  const clip = process.env.CCTV_TEST_CLIP || ['../set/nvr1-13.bin', '../../set/nvr1-13.bin'].find((p) => existsSync(p))
  if (!clip || !existsSync(clip)) console.log('SKIP  real clip (set/nvr1-13.bin not found)')
  else {
    const data = readFileSync(clip)
    const frames = splitAccessUnits(data)
    const keys = frames.filter((f) => f.isKey).length
    check('real clip: split into frames with keyframes', frames.length > 10 && keys >= 1, `${frames.length} frames, ${keys} keys`)
    // repeat the clip so there are keyframes across two minute boundaries; 1 frame per 400 ms
    const root = mkdtempSync(join(tmpdir(), 'segw-real-'))
    const codec = /h265|hevc/.test(frames.codec) ? 'h265' : 'h264'
    const w = new SegmentWriter({ root, nvrId: 'nvr1', ch: 12, codec })
    const segs = []
    w.on('segment', (s) => segs.push(s))
    const t0 = Date.UTC(2026, 8, 24, 12, 0, 40)
    const fed = []
    let ts = t0
    // (as a camera would: the writer keeps up, so nothing is dropped)
    while (ts < t0 + 140_000) for (const f of frames) { w.write(f.buf, { isKey: f.isKey, ts }); fed.push(f.buf); ts += 400; if (w.queueStatus().queuedBytes > 1 << 20) await w.drained() }
    await w.close()
    check('real clip: several segments', segs.length >= 3, `${segs.length}`)
    const got = Buffer.concat(segs.map((s) => readFileSync(s.path)))
    check('real clip: bytes concatenated equal the input exactly', got.equals(Buffer.concat(fed)))
    let startsAtKey = true
    for (const s of segs) {
      const d = readFileSync(s.path)
      for (const r of readIdx(`${s.path}.idx`)) {
        const f = splitAccessUnits(d.subarray(r.offset))[0]
        if (!f?.isKey) startsAtKey = false
      }
    }
    check('real clip: every .idx offset is the start of a keyframe', startsAtKey)
    let probe = null
    try {
      probe = execFileSync('ffprobe', ['-v', 'error', '-f', codec === 'h265' ? 'hevc' : 'h264', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,codec_name', '-of', 'json', segs[1].path], { encoding: 'utf8' })
    } catch (e) {
      if (e.code === 'ENOENT') console.log('SKIP  ffprobe not installed')
      else probe = `error: ${e.stderr || e.message}`
    }
    if (probe !== null) {
      let n = 0
      try { n = Number(JSON.parse(probe).streams[0].nb_read_frames) } catch {}
      check('real clip: ffprobe decodes a middle segment', n > 0, probe.slice(0, 200))
    }
    void walk
  }
}

/** Splits Annex B into access units (H.264 or H.265), each with isKey. */
function splitAccessUnits(buf) {
  const starts = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      starts.push(i)
      i += buf[i + 2] === 1 ? 2 : 3
    }
  }
  const nalHdr = (s) => s + (buf[s + 2] === 1 ? 3 : 4)
  // codec guess: an H.265 VPS (type 32) or H.264 SPS (type 7) at the start
  const h0 = buf[nalHdr(starts[0])]
  const hevc = ((h0 >> 1) & 0x3f) === 32 || ((h0 >> 1) & 0x3f) === 33
  const out = []
  let cur = null
  let sawVcl = false
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k]
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length
    const h = nalHdr(s)
    let vcl, key, first, param
    if (hevc) {
      const t = (buf[h] >> 1) & 0x3f
      vcl = t < 32
      key = t >= 16 && t <= 21
      param = t >= 32 && t <= 35
      first = vcl && (buf[h + 2] & 0x80) !== 0
    } else {
      const t = buf[h] & 0x1f
      vcl = t >= 1 && t <= 5
      key = t === 5
      param = t === 7 || t === 8 || t === 9 || t === 6
      first = vcl && (buf[h + 1] & 0x80) !== 0 // first_mb_in_slice == 0 -> ue(v) '1'
    }
    if (!cur || (sawVcl && (param || first))) {
      cur = { s, e, isKey: false }
      out.push(cur)
      sawVcl = false
    }
    cur.e = e
    if (vcl) sawVcl = true
    if (key) cur.isKey = true
  }
  const frames = out.map((f) => ({ buf: buf.subarray(f.s, f.e), isKey: f.isKey }))
  frames.codec = hevc ? 'h265' : 'h264'
  return frames
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
