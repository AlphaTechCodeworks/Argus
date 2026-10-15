// Tests for the MPEG-TS writer of camera links (ts-mux.mjs): the tables' CRC, packet framing, the PES
// payload coming back whole, PTS from the camera's times (jumps carried over), PAT/PMT at keyframes,
// nothing before the first keyframe, a codec change refused. With ffmpeg/ffprobe on the PATH, a real
// H.264 and H.265 stream muxed here is read back by ffprobe (codec, frames, rate); skipped without.
// Run:  node cctv/test/ts-mux.test.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PMT_PID, START_TICKS, TS_PACKET, TsMuxer, VIDEO_PID, crc32mpeg, patSection, pmtSection } from '../ts-mux.mjs'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

// ---- the tables ----
{
  const pat = patSection()
  check('PAT: the well-known CRC of programme 1 -> PID 0x1000', pat.subarray(-4).toString('hex') === '2ab104b2', pat.toString('hex'))
  check('a section with its CRC checks to 0', crc32mpeg(pat) === 0 && crc32mpeg(pmtSection('h264')) === 0 && crc32mpeg(pmtSection('h265')) === 0)
  check('PMT: H.264 is stream type 0x1b, H.265 0x24', pmtSection('h264').includes(Buffer.from([0x1b, 0xe1, 0x00])) && pmtSection('h265').includes(Buffer.from([0x24, 0xe1, 0x00])))
  let threw = false
  try { pmtSection('mjpeg') } catch { threw = true }
  check('an unknown codec is refused', threw)
}

/** Reads a TS back: the PIDs seen, and each PES (its PTS and payload) on the video PID. */
function demux(buf) {
  const pids = []
  const pes = []
  const cc = new Map()
  let ccOk = true
  let cur = null
  for (let i = 0; i < buf.length; i += TS_PACKET) {
    const p = buf.subarray(i, i + TS_PACKET)
    if (p[0] !== 0x47 || p.length !== TS_PACKET) throw new Error(`bad packet at ${i}`)
    const pid = ((p[1] & 0x1f) << 8) | p[2]
    pids.push(pid)
    const c = p[3] & 0x0f
    if (cc.has(pid) && ((cc.get(pid) + 1) & 0x0f) !== c) ccOk = false
    cc.set(pid, c)
    if (pid !== VIDEO_PID) continue
    let o = 4
    let rai = false
    let pcr = null
    if (p[3] & 0x20) {
      const len = p[4]
      if (len > 0) {
        rai = Boolean(p[5] & 0x40)
        if (p[5] & 0x10) pcr = p[6] * 2 ** 25 + p[7] * 2 ** 17 + p[8] * 2 ** 9 + p[9] * 2 + (p[10] >> 7)
      }
      o = 5 + len
    }
    if (p[1] & 0x40) {
      if (cur) pes.push(cur)
      const h = p.subarray(o)
      const pts = (h[9] >> 1 & 0x07) * 2 ** 30 + h[10] * 2 ** 22 + (h[11] >> 1) * 2 ** 15 + h[12] * 2 ** 7 + (h[13] >> 1)
      cur = { pts, rai, pcr, parts: [h.subarray(14)] }
    } else cur.parts.push(p.subarray(o))
  }
  if (cur) pes.push(cur)
  return { pids, ccOk, pes: pes.map((x) => ({ ...x, payload: Buffer.concat(x.parts) })) }
}

// ---- framing, payload, times ----
{
  const m = new TsMuxer()
  check('a delta before the first keyframe: nothing', m.frame(Buffer.from([0, 0, 0, 1, 0x41]), { isKey: false, codec: 'h264', tsMs: 0 }) === null)
  const sizes = [1, 170, 171, 183, 184, 1000, 5000, 64 * 1024]
  const frames = sizes.map((n, i) => ({ payload: Buffer.from(Array.from({ length: n }, (_, j) => (i * 7 + j) & 0xff)), isKey: i === 0 || i === 5, codec: 'h264', tsMs: 1000 + i * 50 }))
  const out = Buffer.concat(frames.map((f) => m.frame(f.payload, f)))
  check('whole packets of 188 bytes', out.length % TS_PACKET === 0)
  const d = demux(out)
  check('continuity counters run on', d.ccOk)
  check('PAT and PMT before each keyframe (2 keyframes)', d.pids.filter((p) => p === 0).length === 2 && d.pids.filter((p) => p === PMT_PID).length === 2 && d.pids[0] === 0 && d.pids[1] === PMT_PID)
  check('every frame comes back whole, in order', d.pes.length === frames.length && d.pes.every((x, i) => x.payload.equals(frames[i].payload)), d.pes.map((x) => x.payload.length).join(','))
  check('PTS from the camera times: 50 ms = 4500 ticks, from START_TICKS', d.pes.every((x, i) => x.pts === START_TICKS + i * 4500), d.pes.map((x) => x.pts).join(','))
  check('keyframes marked random access, others not', d.pes.map((x) => x.rai).join() === frames.map((f) => f.isKey).join())
  check('a clock on every frame, behind its PTS', d.pes.every((x) => x.pcr !== null && x.pcr < x.pts))
}
{
  const m = new TsMuxer()
  const ts = [0, 40, 80, 70, 110, 60_000, 60_040, 60_040]
  const out = Buffer.concat(ts.map((t, i) => m.frame(Buffer.from([1, 2, 3]), { isKey: i === 0, codec: 'h265', tsMs: t })))
  const p = demux(out).pes.map((x) => (x.pts - START_TICKS) / 90)
  check('a clock set back or a jump of a minute: one 40 ms step; equal times still rise', JSON.stringify(p) === JSON.stringify([0, 40, 80, 120, 160, 200, 240, 240 + 1 / 90]), JSON.stringify(p))
  let threw = false
  try { m.frame(Buffer.from([1]), { isKey: true, codec: 'h264', tsMs: 1 }) } catch { threw = true }
  check('the codec changing mid-feed is an error (the feed restarts)', threw)
}

// ---- real streams through ffprobe (optional) ----
const has = (bin) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0
if (has('ffmpeg') && has('ffprobe')) {
  const dir = mkdtempSync(join(tmpdir(), 'tsmux-'))
  try {
    for (const [codec, enc, bsf, fmt] of [['h264', 'libx264', 'h264_metadata=aud=insert', 'h264'], ['h265', 'libx265', 'hevc_metadata=aud=insert', 'hevc']]) {
      const raw = join(dir, `in.${fmt}`)
      const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=20', '-t', '3', '-c:v', enc, '-g', '20', '-bf', '0', ...(enc === 'libx265' ? ['-x265-params', 'log-level=none'] : []), '-bsf:v', bsf, '-f', fmt, '-y', raw])
      if (r.status !== 0) { console.log(`SKIP  ${codec}: no ${enc} in this ffmpeg`); continue }
      // split into access units at each access unit delimiter (H.264 type 9, H.265 type 35)
      const b = readFileSync(raw)
      const starts = []
      for (let i = 0; i + 4 < b.length; i++) {
        if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === 1) {
          const t = codec === 'h264' ? b[i + 4] & 0x1f : (b[i + 4] >> 1) & 0x3f
          if (t === (codec === 'h264' ? 9 : 35)) starts.push(i)
        }
      }
      const aus = starts.map((s, i) => b.subarray(s, starts[i + 1] ?? b.length))
      const isKey = (au) => {
        for (let i = 0; i + 4 < au.length; i++) if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
          const t = codec === 'h264' ? au[i + 3] & 0x1f : (au[i + 3] >> 1) & 0x3f
          if (codec === 'h264' ? t === 5 : t >= 16 && t <= 21) return true
        }
        return false
      }
      const m = new TsMuxer()
      const ts = Buffer.concat(aus.map((au, i) => m.frame(au, { isKey: isKey(au), codec, tsMs: 5_000_000 + i * 50 })).filter(Boolean))
      const file = join(dir, `out-${codec}.ts`)
      writeFileSync(file, ts)
      const p = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,nb_read_frames,avg_frame_rate,width', '-of', 'json', file], { encoding: 'utf8' })
      const s = JSON.parse(p.stdout || '{}').streams?.[0] ?? {}
      check(`ffprobe reads our ${codec} TS: codec, size, every frame, 20 fps`, s.codec_name === (codec === 'h264' ? 'h264' : 'hevc') && s.width === 320 && Number(s.nb_read_frames) === aus.length && s.avg_frame_rate === '20/1', `${JSON.stringify(s)} of ${aus.length}${p.stderr ? `; ${p.stderr.slice(0, 200)}` : ''}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
} else console.log('SKIP  ffmpeg/ffprobe not on the PATH: the real-stream check')

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exitCode = failed ? 1 : 0
