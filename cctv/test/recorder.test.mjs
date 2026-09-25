// Tests for recording (phase 2, Task 5): recorder.mjs (inside the live worker), rec-index.mjs
// (node:sqlite in the parent) and the wiring in nvr-worker.mjs / worker-supervisor.mjs / nvrs.mjs.
// Fake SDK only (test/fake-sdk.mjs), hosts *.invalid, temp dirs: nothing reaches an NVR.
// Run:  node cctv/test/recorder.test.mjs
import { fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const J = (v) => JSON.stringify(v)
const check = (n, ok, e = '') => { if (!ok) failures++; process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}\n`) }
const until = async (pred, ms = 8000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)); return pred() }
const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : [])
const location = (id, role = 'main') => {
  const path = mkdtempSync(join(tmpdir(), `rec-${id}-`))
  writeFileSync(join(path, '.cctv-recordings'), JSON.stringify({ id, created: new Date().toISOString() }))
  return { id, path, type: 'usb', role, limitGB: null }
}

const data = mkdtempSync(join(tmpdir(), 'cctv-rec-'))
process.env.DATA_DIR = data
writeFileSync(join(data, 'nvrs.json'), JSON.stringify({ nvrs: [{ id: 'w1', site: 'T', name: 'W1', host: 'w1.invalid', port: 6036, user: 'u', password: 'p' }] }))
process.env.CCTV_WORKER_FAKE_SDK = '1'

const { Recorder } = await import('../recorder.mjs')
const { openRecIndex } = await import('../rec-index.mjs')
const DEFAULTS = { mode: 'off', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 183, preS: 10, postS: 20 }
const recording = (cameras = {}, defaults = {}) => ({ defaults: { ...DEFAULTS, ...defaults }, cameras })

// a stream like LiveStream: a set of clients; frames in the sdk.mjs wire format (16-byte header)
const fakeStream = () => ({ clients: new Set(), add(ws) { this.clients.add(ws) }, remove(ws) { this.clients.delete(ws) } })
const wire = (isKey, codec, payload, ts = 0) => {
  const b = Buffer.alloc(16 + payload.length)
  b[0] = isKey ? 1 : 0
  b[1] = codec
  b.writeBigInt64LE(BigInt(ts * 1000), 8)
  payload.copy(b, 16)
  return b
}

// ---- rec-index
{
  const idx = openRecIndex(join(data, 'test-index.db'))
  idx.addSegment({ nvr: 'a', ch: 1, path: '/x/a/1/1.h264', startMs: 1000, endMs: 60_000, bytes: 10, keyframes: 2, loc: 'L1' })
  idx.addSegment({ nvr: 'a', ch: 1, path: '/x/a/1/2.h264', startMs: 60_000, endMs: 120_000, bytes: 20, keyframes: 2, loc: 'L1' })
  idx.addSegment({ nvr: 'b', ch: 0, path: '/x/b/0/1.h264', startMs: 500, endMs: 59_000, bytes: 5, keyframes: 1, loc: 'L2' })
  idx.addGap({ nvr: 'a', ch: 1, fromMs: 120_000, toMs: 130_000, reason: 'location not writable' })
  check('index: segments by camera and time (overlap)', idx.segments('a', 1, 50_000, 70_000).length === 2 && idx.segments('a', 1, 61_000, 62_000).length === 1)
  check('index: segment fields round-trip', JSON.stringify(idx.segments('b', 0, 0, 1e9)[0]) === JSON.stringify({ nvr: 'b', ch: 0, path: '/x/b/0/1.h264', startMs: 500, endMs: 59_000, bytes: 5, keyframes: 1, loc: 'L2' }))
  check('index: oldest first', idx.oldest(2).map((s) => s.path).join() === '/x/b/0/1.h264,/x/a/1/1.h264')
  check('index: oldest on one location', idx.oldest(5, { loc: 'L1' }).length === 2)
  check('index: gaps', idx.gaps('a', 1, 0, 1e9)[0]?.reason === 'location not writable')
  idx.addSegment({ nvr: 'a', ch: 1, path: '/x/a/1/1.h264', startMs: 1000, endMs: 60_000, bytes: 11, keyframes: 2, loc: 'L1' })
  check('index: same path twice replaces the row', idx.segments('a', 1, 0, 1e9).length === 2 && idx.segments('a', 1, 0, 2000)[0].bytes === 11)
  idx.remove('/x/a/1/1.h264')
  check('index: remove', idx.segments('a', 1, 0, 1e9).length === 1)
  check('index: cameras', JSON.stringify(idx.cameras()) === JSON.stringify([{ nvr: 'a', ch: 1 }, { nvr: 'b', ch: 0 }]))
  idx.close()
  const again = openRecIndex(join(data, 'test-index.db'))
  check('index: persists across reopen', again.segments('a', 1, 0, 1e9).length === 1)
  again.close()
}

// ---- Recorder with a fake stream and a fake clock
{
  const streams = new Map()
  const sent = []
  let now = Date.UTC(2026, 8, 24, 10, 0, 55)
  // (rollOffsetMs 0: rolls exactly at the minute; the staggered roll is tested in segment-rollover.test.mjs)
  const rec = new Recorder({ nvrId: 'n1', getStream: (ch) => streams.get(ch) ?? streams.set(ch, fakeStream()).get(ch), online: () => true, channels: () => [0, 1, 2], send: (m) => sent.push(m), now: () => now, writerOpts: { rollOffsetMs: 0 } })
  const L1 = location('L1')
  const L2 = location('L2', 'overflow')
  rec.apply({ recording: recording(), locations: [L1, L2] })
  check('recorder: off by default: no stream taken', streams.size === 0)
  rec.apply({ recording: recording({ 'n1/1': { mode: 'continuous' } }), locations: [L1, L2] })
  const s1 = streams.get(1)
  check('recorder: continuous camera taps its main stream', s1?.clients.size === 1 && streams.size === 1)
  const tap = [...s1.clients][0]
  // the disk work is asynchronous: each frame is followed by waiting for the writers
  const feed = async (n, keyEvery = 5, codec = 1) => {
    for (let i = 0; i < n; i++) {
      const key = i % keyEvery === 0
      tap.send(wire(key, codec, Buffer.from([0, 0, 0, 1, key ? 0x26 : 0x02, i & 0xff])))
      now += 1000
      await rec.idle()
    }
  }
  await feed(20) // 10:00:55 -> 10:01:15: rollover at the key at 10:01:00
  const segs = sent.filter((m) => m.t === 'segment')
  check('recorder: a segment message at the minute rollover', segs.length === 1 && segs[0].nvr === 'n1' && segs[0].ch === 1 && segs[0].loc === 'L1', JSON.stringify(sent))
  check('recorder: segment written into the location, .h265 from the header codec', segs[0] && segs[0].path.startsWith(L1.path) && segs[0].path.endsWith('10-00.h265') && existsSync(segs[0].path))
  check('recorder: bytes are the payload after the 16-byte header', segs[0] && readFileSync(segs[0].path).length === 5 * 6)
  // the location becomes unwritable: failover to L2 and a gap
  const { rmSync } = await import('node:fs')
  rmSync(L1.path, { recursive: true, force: true })
  writeFileSync(L1.path, 'gone') // the folder is now a file: every write under it fails
  await feed(12) // key at +0 is in the open file (fd still valid)... then rollover at 10:02 fails -> switch
  await feed(46) // on through 10:02:00: the rollover there fails (reported after the fact) -> switch; recording resumes at the next keyframe
  const gap = sent.find((m) => m.t === 'recgap')
  check('recorder: unwritable location -> recgap with a clear reason', gap && /location not writable/.test(gap.reason) && gap.nvr === 'n1' && gap.ch === 1, JSON.stringify(gap))
  check('recorder: gap has from < to', gap && gap.fromMs <= gap.toMs)
  const st = rec.status()
  check('recorder: switched to the failover location', st[1]?.loc === 'L2', JSON.stringify(st))
  check('recorder: status reports the failed location', /not writable/.test(JSON.stringify(st[1]?.lastError ?? '')), JSON.stringify(st))
  // turning recording off: tap removed, segment closed and reported
  const before = sent.filter((m) => m.t === 'segment').length
  rec.apply({ recording: recording(), locations: [L2] })
  await rec.idle()
  check('recorder: off -> tap removed from the stream', s1.clients.size === 0)
  const after = sent.filter((m) => m.t === 'segment')
  check('recorder: off -> the open segment is closed and reported', after.length === before + 1 && after.at(-1).path.startsWith(L2.path), JSON.stringify(after.at(-1)))
  // no location at all: nothing written, a gap once one comes back
  rec.apply({ recording: recording({}, { mode: 'motion' }), locations: [] })
  check('recorder: default mode applies to every channel (motion treated as continuous)', streams.get(0)?.clients.size === 1 && streams.get(2)?.clients.size === 1)
  const t0 = [...streams.get(0).clients][0]
  t0.send(wire(true, 0, Buffer.from([0, 0, 0, 1, 0x65])))
  now += 1000
  rec.apply({ recording: recording({}, { mode: 'motion' }), locations: [L2] })
  t0.send(wire(true, 0, Buffer.from([0, 0, 0, 1, 0x65])))
  const g2 = sent.filter((m) => m.t === 'recgap' && m.ch === 0)
  check('recorder: no location -> recgap "no storage location" once writing resumes', g2.length === 1 && /no storage location/.test(g2[0].reason), JSON.stringify(g2))
  const stopped = rec.stop()
  check('recorder: stop() returns a promise (last segments reported when it resolves)', stopped instanceof Promise)
  await stopped
  check('recorder: stop closes everything', [...streams.values()].every((s) => s.clients.size === 0))
}

// ---- Recorder on a slow disk: the frame path never waits; a "disk too slow" gap; resumes at a keyframe
{
  const { mkdir, open } = await import('node:fs/promises')
  let openGate
  let gate = new Promise((r) => (openGate = r))
  const slowFs = {
    mkdir,
    async open(p, flags) {
      const fh = await open(p, flags)
      return { writev: async (b) => (await gate, fh.writev(b)), write: (...a) => fh.write(...a), sync: () => fh.sync(), close: () => fh.close() }
    }
  }
  const streams = new Map()
  const sent = []
  let now = Date.UTC(2026, 8, 24, 15, 0, 5)
  const rec = new Recorder({ nvrId: 'n2', getStream: (ch) => streams.get(ch) ?? streams.set(ch, fakeStream()).get(ch), online: () => true, channels: () => [0], send: (m) => sent.push(m), now: () => now, writerOpts: { fs: slowFs, maxQueueBytes: 2 * 1024 * 1024 } })
  const L = location('LS')
  rec.apply({ recording: recording({}, { mode: 'continuous' }), locations: [L] })
  const s = streams.get(0)
  const viewer = { OPEN: 1, readyState: 1, bufferedAmount: 0, got: 0, send() { this.got++ } } // a live viewer on the same stream
  s.add(viewer)
  const fanOut = (b) => { for (const c of s.clients) c.send(b) } // what LiveStream does per frame
  const big = (key) => wire(key, 0, Buffer.concat([Buffer.from([0, 0, 0, 1, key ? 0x65 : 0x41]), Buffer.alloc(256 * 1024)]))
  let slowest = 0
  for (let i = 0; i < 40; i++) {
    const t = performance.now()
    fanOut(big(i % 10 === 0))
    slowest = Math.max(slowest, performance.now() - t)
    now += 100
    await new Promise((r) => setImmediate(r))
  }
  check('slow disk: the SDK fan-out never waits for the disk', slowest < 20, `${slowest.toFixed(1)} ms`)
  check('slow disk: the live viewer got every frame', viewer.got === 40, String(viewer.got))
  check('slow disk: status shows the queue and the drops', rec.status()[0]?.queue?.dropped > 0 && /disk too slow/.test(rec.status()[0]?.lastError?.reason ?? ''), JSON.stringify(rec.status()))
  check('slow disk: no gap reported yet (still dropping)', !sent.some((m) => m.t === 'recgap'))
  openGate()
  await rec.idle()
  fanOut(big(false))
  now += 100
  check('slow disk: after catching up, a delta frame is not written (waits for a keyframe)', !sent.some((m) => m.t === 'recgap'))
  fanOut(big(true))
  const gap = sent.find((m) => m.t === 'recgap')
  check('slow disk: recgap "disk too slow" when recording resumes at the keyframe', gap && /disk too slow/.test(gap.reason) && gap.fromMs < gap.toMs && gap.toMs === now, JSON.stringify(gap))
  await rec.stop()
  const segs = sent.filter((m) => m.t === 'segment')
  check('slow disk: the part before the drop and the part after are both segments', segs.length === 2 && segs.every((x) => existsSync(x.path)), JSON.stringify(segs.map((x) => x.path)))
}

// ---- missing frames: stalls, resumption mid-GOP, capture times, short gaps
{
  const { readIdx } = await import('../segment-writer.mjs')
  const streams = new Map()
  const sent = []
  let now = Date.UTC(2026, 8, 24, 11, 0, 1)
  const SKEW = 7_200_123 // the NVR's clock (header time) runs 2 h ahead of ours: only differences count
  let hdr = now + SKEW
  const rec = new Recorder({ nvrId: 'n3', getStream: (ch) => streams.get(ch) ?? streams.set(ch, fakeStream()).get(ch), online: () => true, channels: () => [4], send: (m) => sent.push(m), now: () => now })
  const L = location('LM')
  rec.apply({ recording: recording({ 'n3/4': { mode: 'continuous' } }), locations: [L] })
  const tap = [...streams.get(4).clients][0]
  // payload marker byte: 0x11 normal, 0xAA a delta that must not be written
  const frame = (key, mark) => tap.send(wire(key, 0, Buffer.from([0, 0, 0, 1, key ? 0x65 : 0x41, mark]), hdr))
  const steady = async (n, stepMs = 50, keyEvery = 20, mark = 0x11) => {
    for (let i = 0; i < n; i++) {
      frame(i % keyEvery === 0, mark)
      now += stepMs
      hdr += stepMs
      await rec.idle()
    }
  }
  await steady(40)
  // a 12 s stall inside the SDK: frames lost (header time jumps too), then deltas resume mid-GOP
  const beforeStall = now - 50
  now += 12_000
  hdr += 12_000
  for (let i = 0; i < 5; i++) { // deltas only
    frame(false, 0xaa)
    now += 50
    hdr += 50
    await rec.idle()
  }
  const keyAt = now
  await steady(10, 50, 1000, 0x11) // i=0 is a key
  await rec.idle()
  const gaps = sent.filter((m) => m.t === 'recgap' && m.ch === 4)
  check('stall: a gap row for the 12 s without video', gaps.length === 1 && /no video/.test(gaps[0].reason) && Math.abs(gaps[0].fromMs - beforeStall) <= 60 && Math.abs(gaps[0].toMs - keyAt) <= 300, JSON.stringify(gaps))
  // a 5 s stall: also a gap row (shorter than the old 10 s threshold)
  now += 5000
  hdr += 5000
  await steady(21)
  const gaps2 = sent.filter((m) => m.t === 'recgap' && m.ch === 4)
  check('stall: a 5 s pause produces a gap row too', gaps2.length === 2 && gaps2[1].toMs - gaps2[1].fromMs >= 4900, JSON.stringify(gaps2))
  // a catch-up burst: two keyframes 2 s apart in capture time delivered 1 ms apart
  now += 2400 // delayed (under the gap threshold), but no frame lost
  const k1 = now
  for (let i = 0; i < 41; i++) {
    frame(i % 40 === 0, 0x11) // keys at i=0 and i=40: header 2 s apart
    now += 1 / 40
    hdr += 50
    await rec.idle()
  }
  now = Math.ceil(now) + 50
  await steady(5)
  await rec.stop()
  const segs = sent.filter((m) => m.t === 'segment' && m.ch === 4)
  const bytes = Buffer.concat(segs.map((s) => readFileSync(s.path)))
  check('stall: no delta written after the stall before the next keyframe', segs.length >= 1 && !bytes.includes(0xaa), `${bytes.filter((b) => b === 0xaa).length} bad deltas`)
  const rows = segs.flatMap((s) => readIdx(`${s.path}.idx`))
  // steady keyframes are 1 s apart; only the burst's two keys are 2 s apart in capture time
  const burst = rows.filter((r) => r.tsMs >= k1 - 3000 && r.tsMs <= k1 + 2)
  const pair = burst.findIndex((r, i) => i > 0 && r.tsMs - burst[i - 1].tsMs >= 1950 && r.tsMs - burst[i - 1].tsMs <= 2050)
  const squeezed = burst.some((r, i) => i > 0 && r.tsMs - burst[i - 1].tsMs < 10)
  check('burst: keyframe times come from the capture time (2 s apart, not 1 ms)', pair > 0 && !squeezed, JSON.stringify(burst))
  check('burst: no keyframe time in the future', rows.every((r) => r.tsMs <= now))
  check('times never go backwards in the .idx', rows.every((r, i) => i === 0 || r.tsMs >= rows[i - 1].tsMs))
}

// ---- an ~11 s dropout the NVR then catches up (frames buffered, not lost): capture times kept through the
// whole catch-up burst, although it lags arrival by more than 5 s at its start (Cashier Front's dropouts)
{
  const { readIdx } = await import('../segment-writer.mjs')
  const streams = new Map()
  const sent = []
  let now = Date.UTC(2026, 8, 24, 12, 0, 1)
  let hdr = now + 3_600_000
  const rec = new Recorder({ nvrId: 'n5', getStream: (ch) => streams.get(ch) ?? streams.set(ch, fakeStream()).get(ch), online: () => true, channels: () => [0], send: (m) => sent.push(m), now: () => now })
  rec.apply({ recording: recording({ 'n5/0': { mode: 'continuous' } }), locations: [location('LB')] })
  const tap = [...streams.get(0).clients][0]
  let i = 0
  const frame = async (dNow) => {
    tap.send(wire(i % 20 === 0, 0, Buffer.from([0, 0, 0, 1, i % 20 === 0 ? 0x65 : 0x41, 0x11]), hdr))
    i++
    hdr += 50
    now += dNow
    await rec.idle()
  }
  for (let j = 0; j < 100; j++) await frame(50) // 5 s steady, 20 fps
  now += 11_000 // nothing arrives for 11 s...
  for (let j = 0; j < 230; j++) await frame(4) // ...then what the NVR buffered arrives 4 ms apart (catching up to ~0.4 s behind)
  for (let j = 0; j < 100; j++) await frame(50)
  await rec.stop()
  const segs = sent.filter((m) => m.t === 'segment')
  const rows = segs.flatMap((s) => readIdx(`${s.path}.idx`))
  const steps = rows.slice(1).map((r, j) => r.tsMs - rows[j].tsMs)
  const odd = steps.filter((s) => Math.abs(s - 1000) > 2)
  check('11 s dropout caught up: every keyframe 1 s after the one before (capture time kept through the burst)', rows.length === 22 && odd.length === 0, `${rows.length} rows, odd steps ${J(odd)}`)
  check('11 s dropout caught up: no gap row (nothing was lost)', !sent.some((m) => m.t === 'recgap'), J(sent.filter((m) => m.t === 'recgap')))
  check('11 s dropout caught up: no time in the future', rows.every((r) => r.tsMs <= now))
}

// ---- the NVR's frames arrive late for good (its clock or a steady backlog): times go back to arrival after a while
{
  const { readIdx } = await import('../segment-writer.mjs')
  const streams = new Map()
  const sent = []
  let now = Date.UTC(2026, 8, 24, 12, 10, 1)
  let hdr = now + 3_600_000
  const rec = new Recorder({ nvrId: 'n6', getStream: (ch) => streams.get(ch) ?? streams.set(ch, fakeStream()).get(ch), online: () => true, channels: () => [0], send: (m) => sent.push(m), now: () => now })
  rec.apply({ recording: recording({ 'n6/0': { mode: 'continuous' } }), locations: [location('LC')] })
  const tap = [...streams.get(0).clients][0]
  let i = 0
  const frame = async () => {
    tap.send(wire(i % 20 === 0, 0, Buffer.from([0, 0, 0, 1, i % 20 === 0 ? 0x65 : 0x41, 0x11]), hdr))
    i++
    hdr += 50
    now += 50
    await rec.idle()
  }
  for (let j = 0; j < 100; j++) await frame()
  now += 8000 // 8 s late from here on, and it never catches up
  for (let j = 0; j < 1400; j++) await frame() // 70 s
  await rec.stop()
  const rows = sent.filter((m) => m.t === 'segment').flatMap((s) => readIdx(`${s.path}.idx`))
  const lag = now - rows.at(-1).tsMs
  check('a lasting 8 s lag: keyframe times return to arrival time', lag < 1500, `last key ${lag} ms behind arrival`)
  check('a lasting 8 s lag: times never go backwards', rows.every((r, j) => j === 0 || r.tsMs >= rows[j - 1].tsMs))
}

// ---- the worker: recording shares the live pull; settings messages start and stop it
{
  const L = location('LW')
  const child = fork(new URL('../nvr-worker.mjs', import.meta.url), [], { serialization: 'advanced', stdio: ['ignore', 'pipe', 'inherit', 'ipc'], env: { ...process.env, CCTV_WORKER_NVR: 'w1' } })
  const got = []
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.on('message', (m) => got.push(m))
  check('worker: ready', await until(() => got.some((m) => m.t === 'ready')))
  child.send({ t: 'want', ch: 2, type: 0 }) // a live viewer on the same main stream
  check('worker: live frames', await until(() => got.some((m) => m.t === 'frame' && m.key === '2:0')))
  child.send({ t: 'settings', recording: recording({ 'w1/2': { mode: 'continuous' } }), locations: [L] })
  check('worker: recording writes a file into the location', await until(() => walk(L.path).some((f) => f.endsWith('.h264')), 6000), walk(L.path).join(' '))
  check('worker: recording and live share one LivePlay', globalThis.__fakeSdk === undefined && (out.match(/stream w1\/3:main started/g) ?? []).length === 1, out)
  child.send({ t: 'unwant', ch: 2, type: 0 }) // the viewer leaves: recording goes on
  await new Promise((r) => setTimeout(r, 300))
  const size1 = walk(L.path).filter((f) => f.endsWith('.h264')).reduce((n, f) => n + readFileSync(f).length, 0)
  await new Promise((r) => setTimeout(r, 600))
  const size2 = walk(L.path).filter((f) => f.endsWith('.h264')).reduce((n, f) => n + readFileSync(f).length, 0)
  check('worker: recording continues after the last live viewer leaves', size2 > size1, `${size1} -> ${size2}`)
  const n0 = got.filter((m) => m.t === 'frame').length
  child.send({ t: 'settings', recording: recording(), locations: [L] })
  check('worker: recording off -> a segment message', await until(() => got.some((m) => m.t === 'segment')), '')
  const seg = got.find((m) => m.t === 'segment')
  check('worker: segment message fields', seg?.nvr === 'w1' && seg.ch === 2 && seg.loc === 'LW' && seg.bytes > 0 && seg.keyframes >= 1 && seg.endMs >= seg.startMs, JSON.stringify(seg))
  check('worker: no live frames forwarded after the viewer left', got.filter((m) => m.t === 'frame').length === n0)
  check('worker: stats include recording status', await until(() => got.some((m) => m.t === 'stats' && m.rec), 7000))
  child.send({ t: 'stop' })
  await until(() => child.exitCode !== null || child.signalCode !== null)
}

// ---- the app: nvrs.mjs (CCTV_LIVE_WORKER=on) sends settings to the worker and indexes its segments
{
  const L = location('LA')
  // a file an earlier (crashed) worker left open: no index row yet
  const orphanDir = join(L.path, 'w1', '4', '2026-09-01', '07')
  mkdirSync(orphanDir, { recursive: true })
  const orphan = join(orphanDir, '07-15.h264')
  writeFileSync(orphan, Buffer.alloc(64, 1))
  const { utimesSync } = await import('node:fs')
  utimesSync(orphan, Date.UTC(2026, 8, 1, 7, 15, 50) / 1000, Date.UTC(2026, 8, 1, 7, 15, 50) / 1000)
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ recording: { defaults: DEFAULTS, cameras: { 'w1/2': { mode: 'continuous' } } }, storage: { locations: [L], lowFreePct: 15, floorFreePct: 5 } }))
  process.env.CCTV_LIVE_WORKER = 'on'
  await import('./fake-sdk.mjs')
  const { nvrs, startNvrs, stopNvrs, recIndex } = await import('../nvrs.mjs')
  const { saveSettings } = await import('../settings.mjs')
  const realLog = console.log
  console.log = () => {}
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => (/^(PASS|FAIL|SKIP|\n)/.test(String(chunk)) ? realWrite(chunk, ...rest) : true)
  startNvrs()
  check('app: worker ready', await until(() => nvrs.get('w1')?.worker?.state() === 'ready'))
  check('app: at worker start, a segment file left open by a crash gets an index row', await until(() => recIndex()?.has(orphan)), '')
  const orow = recIndex()?.segments('w1', 4, 0, 1e15)[0]
  check('app: recovered row: start from the name, end from the last write, bytes kept', orow?.startMs === Date.UTC(2026, 8, 1, 7, 15) && orow.endMs === Date.UTC(2026, 8, 1, 7, 15, 50) && orow.bytes === 64 && orow.loc === 'LA', JSON.stringify(orow))
  const nvr = nvrs.get('w1')
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], send(b) { this.got.push(b) } }
  nvr.getStream(2, 0).add(ws)
  check('app: recording files appear', await until(() => walk(L.path).some((f) => f.endsWith('.h264')), 8000))
  check('app: live viewer unaffected (frames arrive, first is a key)', await until(() => ws.got.length > 5) && ws.got[0][0] === 1)
  saveSettings({ recording: { cameras: { 'w1/2': { mode: 'off' } } } }, 'test')
  check('app: settings change reaches the worker; its segment lands in the index', await until(() => recIndex()?.segments('w1', 2, 0, Date.now() + 1000).length > 0, 8000))
  const row = recIndex().segments('w1', 2, 0, Date.now() + 1000)[0]
  check('app: index row points at the file on the location', row && row.path.startsWith(L.path) && existsSync(row.path) && row.loc === 'LA', JSON.stringify(row))
  check('app: data/recordings.db created', existsSync(join(data, 'recordings.db')))
  await stopNvrs()
  process.stdout.write = realWrite
  console.log = realLog
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
