// The real ffmpeg behind event pictures (event-snapshot.mjs). ffmpeg is installed on the server
// only, so this runs there: video made by ffmpeg itself (its test pattern) goes through takeSnapshot
// and must come back as a JPEG of the right size. One keyframe through a fake reader, H.264 and
// (when this ffmpeg has libx265) H.265; and a 1080p H.264 segment file with its .idx, read by
// rec-reader.mjs, which also proves the scale filter's quoting (1920 wide comes back 1280 x 720).
// ffmpeg runs behind ionice and nice here exactly as in the service.
//   node cctv/test/event-snapshot-ffmpeg.test.mjs        (on the server copy)
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-snap-ffmpeg-test-'))
const { snapPath, takeSnapshot } = await import('../event-snapshot.mjs')
const { CODEC, splitUnits } = await import('../rec-reader.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 27, 14, 0, 0)

/** Raw Annex B from ffmpeg's test pattern: 10 fps, a keyframe every `gop` frames exactly, no B-frames. */
function testVideo({ size, codec = 'h264', frames = 1, gop = 10 }) {
  const enc = codec === 'h265'
    ? ['-c:v', 'libx265', '-x265-params', `log-level=error:keyint=${gop}:min-keyint=${gop}:scenecut=0:open-gop=0`]
    : ['-c:v', 'libx264', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0']
  return execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10`,
    '-frames:v', String(frames), ...enc, '-bf', '0', '-pix_fmt', 'yuv420p',
    '-f', codec === 'h265' ? 'hevc' : 'h264', 'pipe:1'
  ], { maxBuffer: 64 * 1024 * 1024 })
}

/** Width and height from a JPEG's frame header (SOF0-SOF15, not DHT/JPG/DAC), or null. */
function jpegSize(b) {
  if (!(b[0] === 0xff && b[1] === 0xd8)) return null
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null
    const m = b[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}

const logs = []
/** One file whose only keyframe is buf, 2 s after the event: nothing to wait for. */
const oneKey = (buf, path) => ({
  index: { at: () => ({ path, startMs: T0, endMs: T0 + 60_000 }), next: () => null },
  readerFor: async () => ({ times: [T0 + 2000], keyframe: async () => ({ buf, ts: T0 + 2000 }), close: async () => {} }),
  wait: async () => { throw new Error('nothing should wait: the recording is there') },
  log: (l) => logs.push(l)
})

// ---- one keyframe, H.264 ----------------------------------------------------------------------------
{
  const key = testVideo({ size: '320x240' })
  const got = await takeSnapshot({ id: 1, nvr: 'nvr1', ch: 0, startMs: T0 }, oneKey(key, '/x/nvr1/0/14-00.h264'))
  const size = got ? jpegSize(readFileSync(got)) : null
  check('an H.264 keyframe from ffmpeg becomes a JPEG', got === snapPath(1), logs.join(' | '))
  check('  320x240 stays 320x240 (a smaller picture is not enlarged)', size === '320x240', size)
}

// ---- one keyframe, H.265 (when this ffmpeg can make one) ------------------------------------------
{
  const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString()
  if (!encoders.includes('libx265')) {
    console.log('SKIP  H.265: this ffmpeg has no libx265 to make a test picture with')
  } else {
    const key = testVideo({ size: '640x360', codec: 'h265' })
    const got = await takeSnapshot({ id: 2, nvr: 'nvr1', ch: 0, startMs: T0 }, oneKey(key, '/x/nvr1/0/14-00.h265'))
    const size = got ? jpegSize(readFileSync(got)) : null
    check('an H.265 keyframe (an .h265 file, fed as hevc) becomes a 640x360 JPEG', got === snapPath(2) && size === '640x360', `${size} ${logs.join(' | ')}`)
  }
}

// ---- a 1080p segment file read by rec-reader.mjs ----------------------------------------------------
{
  const video = testVideo({ size: '1920x1080', frames: 30, gop: 10 })
  const keys = splitUnits(video, CODEC.h264).units.filter((u) => u.isKey)
  check('the test segment has 3 keyframes, 1 s apart', keys.length === 3, `${keys.length}`)
  const dir = join(process.env.DATA_DIR, 'rec', 'nvr1', '0', '2026-09-27', '14')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, '14-00.h264')
  writeFileSync(path, video)
  // the recorder's .idx: one 16-byte row per keyframe [uint64 LE offset, int64 LE ms]
  const idx = Buffer.alloc(16 * keys.length)
  keys.forEach((u, g) => {
    idx.writeBigUInt64LE(BigInt(u.start), g * 16)
    idx.writeBigInt64LE(BigInt(T0 + g * 1000), g * 16 + 8)
  })
  writeFileSync(`${path}.idx`, idx)
  const deps = {
    index: { at: () => ({ path, startMs: T0, endMs: T0 + 2900 }), next: () => null },
    wait: async () => { throw new Error('nothing should wait: the recording is there') },
    log: (l) => logs.push(l)
  }
  const got = await takeSnapshot({ id: 3, nvr: 'nvr1', ch: 0, startMs: T0 + 500 }, deps)
  const size = got ? jpegSize(readFileSync(got)) : null
  check('a segment file: the keyframe after start + 1 s becomes a JPEG', got === snapPath(3), logs.join(' | '))
  check('  1920x1080 comes back 1280x720 (the scale filter works as quoted)', size === '1280x720', size)
  check('  taken from the keyframe 2 s in (start + 1.5 s)', logs.some((l) => /event 3: taken 1\.5 s after the start/.test(l)), logs.join(' | '))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
