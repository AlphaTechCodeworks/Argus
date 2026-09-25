// Segment rollover off the write path (segment-writer.mjs): the fsync/close of a finished file
// runs outside the camera's write queue (the next file's writes do not wait for it), at most a
// few closes run at once per process, cameras roll at staggered seconds (rollOffsetMs; the file
// is still named after the minute of its first frame), maxQueueMs defaults to 10 s, and the
// segopen-before-segment contract holds. Temp dirs only.
// Run:  node cctv/test/segment-rollover.test.mjs
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_CONCURRENT_CLOSES, SegmentWriter, rollOffsetFor } from '../segment-writer.mjs'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const K = (i) => Buffer.from([0, 0, 0, 1, 0x65, i & 0xff])
const D = (i) => Buffer.from([0, 0, 0, 1, 0x41, i & 0xff])

// a filesystem whose fsync takes syncMs; records the order of events
const makeFs = (syncMs, events, concurrency) =>
  ({
    mkdir: (p, o) => fsp.mkdir(p, o),
    async open(p, flags) {
      const fh = await fsp.open(p, flags)
      const name = p.split(/[\\/]/).slice(-1)[0]
      return {
        async writev(bufs) {
          events.push(`write ${name}`)
          return fh.writev(bufs)
        },
        write: (...a) => fh.write(...a),
        async sync() {
          concurrency.now++
          concurrency.max = Math.max(concurrency.max, concurrency.now)
          events.push(`sync ${name}`)
          await sleep(syncMs)
          concurrency.now--
          events.push(`synced ${name}`)
          return fh.sync()
        },
        close: () => fh.close()
      }
    }
  })

check('maxQueueMs defaults to 10 s', new SegmentWriter({ root: tmpdir(), nvrId: 'x', ch: 0 }).maxQueueMs === 10_000)
check('at most a few closes at once (<= 4)', MAX_CONCURRENT_CLOSES >= 1 && MAX_CONCURRENT_CLOSES <= 4, String(MAX_CONCURRENT_CLOSES))

// ---- the next file's writes do not wait for the previous file's fsync
{
  const root = mkdtempSync(join(tmpdir(), 'roll-'))
  const events = []
  const conc = { now: 0, max: 0 }
  const w = new SegmentWriter({ root, nvrId: 'n1', ch: 1, fs: makeFs(400, events, conc) })
  const seen = []
  w.on('open', (o) => seen.push(`open ${o.path.split(/[\\/]/).at(-1)}`))
  w.on('segment', (s) => seen.push(`segment ${s.path.split(/[\\/]/).at(-1)}`))
  const t0 = Date.UTC(2026, 8, 25, 9, 0, 58)
  w.write(K(0), { isKey: true, ts: t0 })
  w.write(D(1), { isKey: false, ts: t0 + 1000 })
  await sleep(50)
  w.write(K(2), { isKey: true, ts: t0 + 2000 }) // 09:01:00 -> rollover
  w.write(D(3), { isKey: false, ts: t0 + 2040 })
  await sleep(150) // the old file's fsync (400 ms) is still running
  const wroteNew = events.some((e) => e === 'write 09-01.h264')
  const oldSynced = events.includes('synced 09-00.h264')
  check('rollover: the new file is written while the old one is still being fsynced', wroteNew && !oldSynced, events.join(', '))
  await w.drained()
  check('drained() waits for the background close', events.includes('synced 09-00.h264') && seen.includes('segment 09-00.h264'), seen.join(', '))
  check('segopen before segment for the same file', seen.indexOf('open 09-00.h264') < seen.indexOf('segment 09-00.h264'))
  check("the old file's segment comes before the new file's segopen (playback contract)", seen.indexOf('segment 09-00.h264') < seen.indexOf('open 09-01.h264'), seen.join(', '))
  const seg = await w.close()
  check('close() still resolves to the segment after its fsync', seg && /09-01\.h264$/.test(seg.path) && readFileSync(seg.path).length === 12, seg?.path)
}

// ---- concurrent closes are limited per process
{
  const root = mkdtempSync(join(tmpdir(), 'roll-many-'))
  const events = []
  const conc = { now: 0, max: 0 }
  const fs = makeFs(150, events, conc)
  const ws = Array.from({ length: 10 }, (_, ch) => new SegmentWriter({ root, nvrId: 'n1', ch, fs }))
  const t0 = Date.UTC(2026, 8, 25, 9, 5, 0)
  for (const w of ws) w.write(K(1), { isKey: true, ts: t0 })
  await sleep(50)
  await Promise.all(ws.map((w) => w.close()))
  check('10 cameras closing at once: fsyncs limited', conc.max <= MAX_CONCURRENT_CLOSES && conc.max >= 1, `max ${conc.max}`)
  check('all 10 closed', events.filter((e) => e.startsWith('synced ') && e.endsWith('.h264')).length === 10)
}

// ---- staggered rollover
{
  const offs = new Set()
  for (let ch = 0; ch < 16; ch++) offs.add(rollOffsetFor('nvr1', ch))
  check('roll offsets spread over the minute (0-59 s)', offs.size >= 8 && [...offs].every((o) => o >= 0 && o < 60_000 && o % 1000 === 0), [...offs].join(','))
  check('roll offset is stable per camera', rollOffsetFor('nvr1', 3) === rollOffsetFor('nvr1', 3))
  const root = mkdtempSync(join(tmpdir(), 'roll-off-'))
  const w = new SegmentWriter({ root, nvrId: 'n1', ch: 2, rollOffsetMs: 20_000 })
  const segs = []
  w.on('segment', (s) => segs.push(s))
  const t0 = Date.UTC(2026, 8, 25, 9, 10, 25)
  w.write(K(0), { isKey: true, ts: t0 }) // 09:10:25
  w.write(K(1), { isKey: true, ts: t0 + 40_000 }) // 09:11:05: before 09:11:20, no roll
  w.write(K(2), { isKey: true, ts: t0 + 56_000 }) // 09:11:21: roll
  w.write(K(3), { isKey: true, ts: t0 + 116_000 }) // 09:12:21: roll again
  await w.close()
  await w.drained()
  const names = segs.map((s) => s.path.split(/[\\/]/).at(-1))
  check('offset 20 s: rolls at hh:mm:20, files named by the minute of their first frame', names.join() === '09-10.h264,09-11.h264,09-12.h264', names.join())
  check('offset 20 s: segment times', segs[0].startMs === t0 && segs[0].endMs === t0 + 40_000 && segs[1].startMs === t0 + 56_000)
  const src = readFileSync(new URL('../recorder.mjs', import.meta.url), 'utf8')
  check('recorder staggers its writers (rollOffsetFor)', /rollOffsetMs: rollOffsetFor\(/.test(src))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
