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
  // source and filledMs arrived with gap backfill: a segment pulled from an NVR to fill a hole is
  // marked so an evidence export can say where it came from. An ordinary recording has neither.
  check('index: segment fields round-trip', JSON.stringify(idx.segments('b', 0, 0, 1e9)[0]) === JSON.stringify({ nvr: 'b', ch: 0, path: '/x/b/0/1.h264', startMs: 500, endMs: 59_000, bytes: 5, keyframes: 1, loc: 'L2', source: null, filledMs: null }))
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

// ---- after a restart: a camera that was recording has a gap row from the recorder's start until its
// first written frame (the parent's downtime row ends when the worker was spawned)
{
  const REASON = 'recording starting after a restart'
  const mk = (nvrId, chans, t) => {
    const streams = new Map()
    const sent = []
    const clock = { now: t }
    const rec = new Recorder({ nvrId, getStream: (ch) => streams.get(ch) ?? streams.set(ch, fakeStream()).get(ch), online: () => true, channels: () => chans.map((ch) => ({ ch, online: true })), send: (m) => sent.push(m), now: () => clock.now })
    const tapOf = (ch) => [...(streams.get(ch)?.clients ?? [])][0]
    const frame = (ch) => tapOf(ch).send(wire(true, 0, Buffer.from([0, 0, 0, 1, 0x65])))
    return { rec, sent, clock, streams, frame, gaps: (ch) => sent.filter((m) => m.t === 'recgap' && m.ch === ch) }
  }
  const t0 = Date.UTC(2026, 8, 27, 2, 29, 50)
  {
    const chans = [0]
    const { rec, clock, frame, gaps } = mk('n7', chans, t0)
    rec.apply({ recording: recording({}, { mode: 'continuous' }), locations: [location('LR')] })
    clock.now = t0 + 40_000 // login, a cool-down, the stream's start ...
    frame(0)
    await rec.idle()
    const g = gaps(0)
    check('restart: created at t0, first frame at t0+40 s: one recgap row with that reason', g.length === 1 && g[0].reason === REASON && g[0].fromMs === t0 && g[0].toMs === t0 + 40_000, J(g))
    clock.now += 1000
    frame(0)
    await rec.idle()
    check('... and no other row once it records', gaps(0).length === 1)
    chans.push(1) // a camera that turns up 4 minutes after the start (it came online)
    clock.now = t0 + 4 * 60_000
    rec.sync()
    clock.now += 5000
    frame(1)
    frame(0)
    await rec.idle()
    check('restart: a camera created later (past the start-up grace): none', gaps(1).length === 0, J(gaps(1)))
    const f = rec.flow(clock.now)
    check('flow: both cameras had a frame in the last 10 s', f?.cameras === 2 && f.flowing === 2 && f.frozen === 0, J(f))
    clock.now += 50_000
    frame(1)
    const f2 = rec.flow(clock.now)
    check('flow: one without a frame for 45 s is frozen, the other flowing', f2.cameras === 2 && f2.flowing === 1 && f2.frozen === 1 && J(f2.frozenChs) === '[0]', J(f2))
    await rec.stop()
  }
  {
    const { rec, clock, frame, gaps } = mk('n8', [0], t0)
    rec.apply({ recording: recording({}, { mode: 'continuous' }), locations: [location('LR2')] })
    clock.now = t0 + 1500
    frame(0)
    await rec.idle()
    check('restart: recording again within 3 s: no row (nothing worth one lost)', gaps(0).length === 0, J(gaps(0)))
    await rec.stop()
  }
  {
    const { rec, clock, frame, gaps } = mk('n9', [0], t0)
    rec.apply({ recording: recording(), locations: [location('LR3')] }) // recording off at the start
    clock.now = t0 + 30_000
    rec.apply({ recording: recording({}, { mode: 'continuous' }), locations: [location('LR3b')] }) // turned on 30 s in
    clock.now = t0 + 70_000
    frame(0)
    await rec.idle()
    check('restart: a camera turned on after the start (not recording before it): none', gaps(0).length === 0, J(gaps(0)))
    await rec.stop()
  }
  {
    const { rec, clock, streams, gaps } = mk('n10', [0], t0)
    rec.apply({ recording: recording({}, { mode: 'continuous' }), locations: [location('LR4')] })
    check('flow: a camera taken on just now is neither flowing nor frozen', J(rec.flow(t0)) === J({ at: t0, cameras: 1, flowing: 0, frozen: 0, recentMs: 10_000, frozenMs: 45_000, frozenChs: [] }), J(rec.flow(t0)))
    clock.now = t0 + 20_000
    streams.get(0).lastFailure = { at: clock.now, fast: true, reason: 'refused in 30 ms: error 31' }
    rec.sync()
    const g = gaps(0)
    check('restart: refused during the ramp-up: the ramp-up row ends there, the refusal has a row of its own', g.length === 1 && g[0].reason === REASON && g[0].toMs === t0 + 20_000 && rec.cams.get(0).gap?.reason?.startsWith('refused'), J({ g, open: rec.cams.get(0).gap }))
    clock.now = t0 + 45_000 // (the first refusal just after a start backs off 30-60 s)
    const f = rec.flow(clock.now)
    check('flow: a camera left alone after a refusal does not count (none left: null)', rec.cams.get(0).refusedUntil > clock.now && f === null, J({ f, until: rec.cams.get(0).refusedUntil - clock.now }))
    await rec.stop()
  }
  {
    // recording from t0+6 s; turned off at t0+60 s and on again at t0+100 s (inside the start-up grace)
    const { rec, clock, frame, gaps } = mk('n11', [0], t0)
    rec.apply({ recording: recording({}, { mode: 'continuous' }), locations: [location('LR5')] })
    clock.now = t0 + 6000
    frame(0)
    await rec.idle()
    const first = gaps(0).length
    clock.now = t0 + 60_000
    rec.apply({ recording: recording({ 'n11/0': { mode: 'off' } }, { mode: 'continuous' }), locations: [location('LR5')] })
    clock.now = t0 + 100_000
    rec.apply({ recording: recording({}, { mode: 'continuous' }), locations: [location('LR5')] })
    clock.now = t0 + 104_000
    frame(0)
    await rec.idle()
    const g = gaps(0).slice(first)
    check('restart: a camera turned off and on again within the grace: no ramp-up row over what it recorded', first === 1 && g.length === 0 && !rec.cams.get(0).gap, J({ first: gaps(0), open: rec.cams.get(0).gap }))
    await rec.stop()
  }
}

// ---- a main stream the NVR only trickles (a "no video" gap every few seconds) drops to the sub
{
  const streams = new Map()
  const asked = [] // the stream type getStream was asked for, in order (0 main, 1 sub)
  let now = Date.UTC(2026, 8, 24, 12, 0, 0)
  const rec = new Recorder({ nvrId: 'nt', getStream: (ch, type) => { asked.push(type); const k = `${ch}:${type}`; return streams.get(k) ?? streams.set(k, fakeStream()).get(k) }, online: () => true, channels: () => [0], send: () => {}, now: () => now, writerOpts: { rollOffsetMs: 0 } })
  rec.apply({ recording: recording({ 'nt/0': { mode: 'continuous' } }), locations: [location('LT')] })
  const main = streams.get('0:0')
  const tap = [...main.clients][0]
  const key = () => wire(true, 1, Buffer.from([0, 0, 0, 1, 0x26, 0]), now)
  check('stutter: it starts on the main stream', asked[0] === 0 && main.clients.size === 1)
  tap.send(key()); await rec.idle() // a clean keyframe first
  // then keyframes 5 s apart: each opens a "no video from the NVR" gap on the main stream
  for (let i = 0; i < 3; i++) { now += 5000; tap.send(key()); await rec.idle() }
  check('stutter: three short gaps in a row drop it off the main stream', main.clients.size === 0)
  rec.tick() // the worker's 250 ms tick re-attaches: now the sub-stream
  const sub = streams.get('0:1')
  check('stutter: the camera falls back to the sub-stream', asked.includes(1) && sub?.clients.size === 1)
  // and the sub-stream is not itself treated as a stutter (only the main is)
  const stap = [...sub.clients][0]
  stap.send(key()); await rec.idle()
  now += 5000; stap.send(key()); await rec.idle()
  check('stutter: a gap on the sub-stream is not counted (it stays on the sub)', streams.get('0:0')?.clients.size !== 1 || asked.filter((t) => t === 0).length === 1)
  await rec.stop()
}

// ---- the sub-stream a trickling main dropped to is refused at once: back to the main within seconds.
// 29 Sep, value4u cam 25: "only trickled video ... recording the sub-stream" at 04:21:03, the sub
// "refused ... trying again in 513 s" at 04:21:10, and "not recorded 04:20:58 - 04:29:44": 525 s of a
// camera that was sending video (stutter report 2.10). Long past the start: a refusal backs off 5-10 min.
{
  const streams = new Map()
  const asked = [] // stream types asked for, in order (0 main, 1 sub)
  const sent = []
  let now = Date.UTC(2026, 8, 29, 4, 20, 48)
  const rec = new Recorder({ nvrId: 'v4', getStream: (ch, type) => { asked.push(type); const k = `${ch}:${type}`; return streams.get(k) ?? streams.set(k, fakeStream()).get(k) }, online: () => true, channels: () => [24], send: (m) => sent.push(m), now: () => now, writerOpts: { rollOffsetMs: 0 } })
  rec.startedAt = -Infinity
  rec.apply({ recording: recording({ 'v4/24': { mode: 'continuous' } }), locations: [location('LV4')] })
  const tapOn = (type) => [...(streams.get(`24:${type}`)?.clients ?? [])][0]
  const key = async (type) => { tapOn(type)?.send(wire(true, 1, Buffer.from([0, 0, 0, 1, 0x26, 0]), now)); await rec.idle() }
  const ticks = (ms) => { for (let t = 0; t < ms; t += 250) { now += 250; rec.tick() } }
  const gaps = () => sent.filter((m) => m.t === 'recgap').map(({ fromMs, toMs, reason }) => ({ fromMs, toMs, reason }))
  const warned = []
  const warn = console.warn
  console.warn = (line) => warned.push(String(line))
  // the main trickles: keyframes 5 s apart, and the third short gap drops the camera to its sub
  await key(0)
  for (let i = 0; i < 2; i++) { now += 5000; await key(0) }
  const lastMain = now // 04:20:58, the last frame written
  now += 5000
  await key(0)
  ticks(250)
  check('trickle, then sub: the camera is on its sub-stream', tapOn(1) && !tapOn(0) && J(asked) === '[0,1]', J(asked))
  // the NVR sends nothing on the sub: 7 s later it counts as refused (LiveStream.lastFailure, fast)
  now += 7000
  streams.get('24:1').lastFailure = { at: now, fast: true, reason: 'no video within 8 s' }
  const tRefused = now
  rec.tick()
  ticks(5000)
  check('sub refused within 60 s of the trickle drop: back on the main stream within 5 s', tapOn(0) && !tapOn(1) && J(asked) === '[0,1,0]', J(asked))
  check('... not the 5-10 min back-off', !(rec.cams.get(24).refusedUntil > now), `refusedUntil ${rec.cams.get(24).refusedUntil ? `now +${rec.cams.get(24).refusedUntil - now} ms` : 0}`)
  check('... and says so', warned.some((l) => /^\[rec v4\/25\] refused by the NVR \(no video within 8 s\): the sub-stream it dropped to for a main that only trickled; back to the main stream now, the sub-stream left alone for \d+ s$/.test(l)), warned.join(' | '))
  now += 1000
  await key(0) // the trickle comes back into the file
  // (the trickle's first two short gaps have rows of their own, before lastMain)
  const g = gaps().filter((r) => r.fromMs >= lastMain)
  check('... one gap row, from the last frame written to the main\'s first frame back: seconds, not 525 s', g.length === 1 && g[0].fromMs === lastMain && g[0].toMs === now && now - lastMain < 30_000, `${J(g)}, ${(now - lastMain) / 1000} s (refused at +${(tRefused - lastMain) / 1000} s)`)
  // the main goes on trickling: while the sub is left alone, the trickle is recorded, not dropped again
  for (let i = 0; i < 4; i++) { now += 5000; await key(0); ticks(250) }
  check('... the trickle goes on being recorded: no drop to the refused sub-stream while it is left alone', tapOn(0) && !tapOn(1) && J(asked) === '[0,1,0]', J(asked))
  // ...until its back-off is over (10 min at most): then a trickle drops it to the sub again
  now = (rec.cams.get(24).subRefusedUntil || now + 10 * 60_000) + 1000
  await key(0)
  for (let i = 0; i < 3; i++) { now += 5000; await key(0) }
  ticks(250)
  check('... after the sub-stream\'s back-off, a trickle drops it to the sub again', tapOn(1) && !tapOn(0) && J(asked) === '[0,1,0,1]', J(asked))
  // this sub records for 2 minutes, then is refused: not just after a drop, so the usual back-off
  await key(1)
  now += 120_000
  await key(1)
  streams.get('24:1').lastFailure = { at: now, fast: true, reason: 'refused in 30 ms: error 31' }
  rec.tick()
  const wait = rec.cams.get(24).refusedUntil - now
  ticks(5000)
  check('a sub refused 2 min after the drop (it recorded meanwhile): the usual 5-10 min back-off, as before', !tapOn(0) && !tapOn(1) && wait >= 5 * 60_000 && wait <= 10 * 60_000 && J(asked) === '[0,1,0,1]', `${J(asked)}, ${wait} ms`)
  console.warn = warn
  await rec.stop()
}

// ---- an NVR set to record on its sub-streams (settings recording.nvrs[id].stream = 'sub')
{
  const streams = new Map()
  const asked = []
  let now = Date.UTC(2026, 8, 24, 13, 0, 0)
  const rec = new Recorder({ nvrId: 'nsub', getStream: (ch, type) => { asked.push(type); const k = `${ch}:${type}`; return streams.get(k) ?? streams.set(k, fakeStream()).get(k) }, online: () => true, channels: () => [0, 1], send: () => {}, now: () => now, writerOpts: { rollOffsetMs: 0 } })
  const cfg = recording({ 'nsub/0': { mode: 'continuous' }, 'nsub/1': { mode: 'continuous', stream: 'main' } })
  cfg.nvrs = { nsub: { stream: 'sub' } }
  rec.apply({ recording: cfg, locations: [location('LSB')] })
  check("nvr set to 'sub': its camera taps the sub-stream from the start, never the main", streams.get('0:1')?.clients.size === 1 && !streams.has('0:0'))
  check("... and a camera set to 'main' on that NVR keeps the main (camera beats NVR)", streams.get('1:0')?.clients.size === 1 && !streams.has('1:1'))
  const tap = [...streams.get('0:1').clients][0]
  const key = () => wire(true, 1, Buffer.from([0, 0, 0, 1, 0x26, 0]), now)
  tap.send(key()); await rec.idle()
  // gaps on a chosen sub-stream never count as a stutter, and it is not reported as degraded
  for (let i = 0; i < 4; i++) { now += 5000; tap.send(key()); await rec.idle() }
  rec.tick()
  check("... gaps on it do not move it (a choice, not a fallback)", streams.get('0:1')?.clients.size === 1 && !streams.has('0:0'))
  check("... and it is not listed as degraded", rec.degraded().length === 0, JSON.stringify(rec.degraded()))
  await rec.stop()
}

// ---- the stream setting changed while the cameras record: each moves to the new stream, one per NVR
// every 3 s (setting nvr-2 to 'sub' used to move only the cameras that happened to reattach)
{
  const streams = new Map()
  const asked = [] // `${ch}:${type}` getStream was asked for, in order (type 0 main, 1 sub)
  const sent = []
  let now = Date.UTC(2026, 8, 24, 14, 0, 5)
  const rec = new Recorder({ nvrId: 'nmg', getStream: (ch, type) => { const k = `${ch}:${type}`; asked.push(k); return streams.get(k) ?? streams.set(k, fakeStream()).get(k) }, online: () => true, channels: () => [0, 1], send: (m) => sent.push(m), now: () => now, writerOpts: { rollOffsetMs: 0 } })
  const cfg = (stream, cameras = {}) => ({ ...recording(cameras, { mode: 'continuous' }), ...(stream ? { nvrs: { nmg: { stream } } } : {}) })
  const L = location('LMG')
  const on = (ch, type) => streams.get(`${ch}:${type}`)?.clients.size === 1
  const key = () => wire(true, 1, Buffer.from([0, 0, 0, 1, 0x26, 0]), now)
  // a keyframe on every stream the recorder taps (a detached stream no longer reaches it)
  const frames = async () => { for (const s of streams.values()) for (const t of s.clients) t.send(key()); await rec.idle() }
  // the worker's 250 ms tick for ms, with video every second
  const run = async (ms) => { for (let t = 0; t < ms; t += 250) { now += 250; rec.tick(); if (now % 1000 === 0) await frames() } }
  const gaps = (ch) => sent.filter((m) => m.t === 'recgap' && m.ch === ch)
  const TO_SUB = 'switching to the sub-stream (recording setting changed)'
  const TO_MAIN = 'switching to the main stream (recording setting changed)'
  rec.apply({ recording: cfg(), locations: [L] })
  await frames()
  await run(2000)
  check("switch: two cameras recording their main streams under 'auto'", on(0, 0) && on(1, 0) && J(asked) === J(['0:0', '1:0']), J(asked))
  rec.apply({ recording: cfg('sub'), locations: [L] })
  rec.tick()
  check("switch: nvr set to 'sub': the first camera moves to its sub-stream within a tick", on(0, 1) && !on(0, 0), J(asked))
  check('... with an open gap naming the switch', rec.cams.get(0).gap?.reason === TO_SUB, J(rec.cams.get(0).gap))
  check('... the second stays on its main for now (one camera per NVR every 3 s)', on(1, 0) && !streams.has('1:1'), J(asked))
  await run(2750)
  check('... still on its main 2.75 s later', on(1, 0) && !streams.has('1:1'), J(asked))
  await run(250)
  check('... and on its sub-stream once 3 s have passed', on(1, 1) && !on(1, 0), J(asked))
  await run(3000)
  const g0 = gaps(0)
  const g1 = gaps(1)
  check('switch: one gap row per camera, naming the switch, from its last main frame to its first sub frame (1 s)', g0.length === 1 && g1.length === 1 && [...g0, ...g1].every((g) => g.reason === TO_SUB && g.toMs - g.fromMs === 1000), J([...g0, ...g1]))
  const seg0 = sent.filter((m) => m.t === 'segment' && m.ch === 0)
  check("... the main stream's file ends at the switch (the sub-stream starts a file of its own)", seg0.length === 1 && seg0[0].endMs === g0[0]?.fromMs, J(seg0))
  check('... recording the sub-stream it is set to is not degraded', rec.degraded().length === 0, J(rec.degraded()))
  // back to 'auto': both were on the sub-stream only because of the setting, so both go back to the main
  rec.apply({ recording: cfg(), locations: [L] })
  rec.tick()
  check("switch: back to 'auto': the first camera returns to its main stream within a tick", on(0, 0) && !on(0, 1), J(asked))
  check('... the second not yet', on(1, 1) && !on(1, 0), J(asked))
  await run(2000)
  // its sub-stream frames under 'auto' while it waits its turn must not make it a fallback: that
  // would list it degraded, and leave it on the sub-stream for good
  check('... recording its sub-stream while it waits: not taken for a fallback (not degraded)', on(1, 1) && rec.cams.get(1).pick.onSub === false && rec.degraded().length === 0, J({ pick: rec.cams.get(1).pick, degraded: rec.degraded() }))
  await run(1000)
  check('... and 3 s later the second too', on(1, 0) && !on(1, 1), J(asked))
  await run(2000)
  check('... getStream asked for exactly: main, main, sub, sub, main, main', J(asked) === J(['0:0', '1:0', '0:1', '1:1', '0:0', '1:0']), J(asked))
  check('... each return has its gap row', gaps(0).length === 2 && gaps(1).length === 2 && gaps(0)[1].reason === TO_MAIN && gaps(1)[1].reason === TO_MAIN, J([...gaps(0), ...gaps(1)]))
  // a camera that falls back to its sub-stream by itself under 'auto' is not taken back to the main:
  // camera 0's main only trickles (keyframes 5 s apart: three short gaps drop it to the sub)
  const m0 = [...streams.get('0:0').clients][0]
  for (let i = 0; i < 3; i++) { now += 5000; m0.send(key()); await rec.idle() }
  rec.tick()
  check('fallback: a main that only trickles drops camera 0 to its sub-stream', on(0, 1) && !on(0, 0), J(asked))
  for (let i = 0; i < 20; i++) { now += 250; rec.tick() }
  check("... not moved back before its first frame there (onSub not set yet: 'auto' chose that stream, not a setting)",on(0, 1) && !on(0, 0) && rec.cams.get(0).pick.onSub === false, J(rec.cams.get(0).pick))
  ;[...streams.get('0:1').clients][0].send(key())
  await rec.idle()
  for (let i = 0; i < 20; i++) { now += 250; rec.tick() }
  check('... nor once it records there (onSub): it stays on the sub-stream, listed as degraded', on(0, 1) && !on(0, 0) && rec.cams.get(0).pick.onSub === true && J(rec.degraded().map((d) => d.ch)) === '[0]', J({ pick: rec.cams.get(0).pick, degraded: rec.degraded() }))
  // ...until the camera is set to 'main': a setting moves even a fallback
  rec.apply({ recording: cfg(null, { 'nmg/0': { stream: 'main' } }), locations: [L] })
  check("switch: camera set to 'main' while on a fallback sub-stream: moved to the main", on(0, 0) && !on(0, 1) && rec.cams.get(0).gap?.reason === TO_MAIN, J({ asked, gap: rec.cams.get(0).gap }))
  await rec.stop()
}

// ---- a camera recording on events: a switch made while it waits for one leaves no gap row, and one made
// while it writes is ended by the new stream's first frame, not left open until the next event
{
  const streams = new Map()
  const sent = []
  let now = Date.UTC(2026, 8, 24, 15, 30, 0)
  const rec = new Recorder({ nvrId: 'nev', getStream: (ch, type) => { const k = `${ch}:${type}`; return streams.get(k) ?? streams.set(k, fakeStream()).get(k) }, online: () => true, channels: () => [0], send: (m) => sent.push(m), now: () => now, writerOpts: { rollOffsetMs: 0 } })
  const cfg = (stream) => ({ ...recording({}, { mode: 'motion' }), ...(stream ? { nvrs: { nev: { stream } } } : {}) })
  const L = location('LEV')
  const on = (type) => streams.get(`0:${type}`)?.clients.size === 1
  // a keyframe on the tapped stream, then a second passes
  const frame = async () => { for (const s of streams.values()) for (const t of s.clients) t.send(wire(true, 1, Buffer.from([0, 0, 0, 1, 0x26, 0]), now)); await rec.idle(); now += 1000 }
  const rows = () => sent.filter((m) => m.t === 'recgap')
  const t0 = now
  rec.apply({ recording: cfg(), locations: [L] })
  rec.applyEvents({ windows: { 0: [[t0, t0 + 1500]] }, at: t0 })
  await frame(); await frame(); await frame() // written, written, then past the window: waiting for an event
  rec.apply({ recording: cfg('sub'), locations: [L] })
  await frame(); await frame()
  check('events: switched while waiting for an event: on the sub-stream, and no gap (nothing was being written)', on(1) && !on(0) && rows().length === 0 && !rec.cams.get(0).gap, J({ rows: rows(), gap: rec.cams.get(0).gap }))
  rec.applyEvents({ windows: { 0: [[now, now + 500]] }, at: now })
  await frame() // written (t0+5 s), inside the new window
  rec.apply({ recording: cfg(), locations: [L] }) // t0+6 s: back to the main while writing
  await frame() // the main's first frame, past the window: not written
  const r = rows()
  check('events: switched while writing: the gap row ends at the new stream\'s first frame, even one not written', on(0) && r.length === 1 && r[0].reason === 'switching to the main stream (recording setting changed)' && r[0].fromMs === t0 + 5000 && r[0].toMs === t0 + 6000 && !rec.cams.get(0).gap, J({ r, gap: rec.cams.get(0).gap }))
  await rec.stop()
}

// ---- what follows a switch keeps its own reason (a switch's row took in a 5-10 min refusal, an hour
// offline, an NVR outage, a stall already under way), and a camera waiting out a refusal still follows
// its setting. Long past the start (startedAt -Infinity): a refusal backs off the full 5-10 min.
{
  const { gapKind } = await import('../reports.mjs')
  const TO_SUB = 'switching to the sub-stream (recording setting changed)'
  const TO_MAIN = 'switching to the main stream (recording setting changed)'
  const rig = (nvrId, chs = [0]) => {
    const streams = new Map()
    const sent = []
    const chans = chs.map((ch) => ({ ch, online: true }))
    const r = { now: Date.UTC(2026, 8, 24, 16, 0, 0), nvrOnline: true, streams, chans }
    r.rec = new Recorder({ nvrId, getStream: (ch, type) => { const k = `${ch}:${type}`; return streams.get(k) ?? streams.set(k, fakeStream()).get(k) }, online: () => r.nvrOnline, channels: () => chans.map((c) => ({ ...c })), send: (m) => sent.push(m), now: () => r.now, writerOpts: { rollOffsetMs: 0 } })
    r.rec.startedAt = -Infinity
    const L = location(`LX${nvrId}`)
    r.set = (stream) => r.rec.apply({ recording: { ...recording({}, { mode: 'continuous' }), ...(stream ? { nvrs: { [nvrId]: { stream } } } : {}) }, locations: [L] })
    r.on = (ch, type) => streams.get(`${ch}:${type}`)?.clients.size === 1
    // a keyframe on whichever stream camera ch is tapping now
    r.key = async (ch) => { for (const [k, s] of streams) if (k.startsWith(`${ch}:`)) for (const t of s.clients) t.send(wire(true, 1, Buffer.from([0, 0, 0, 1, 0x26, 0]), r.now)); await r.rec.idle() }
    r.refuse = (ch, type) => { streams.get(`${ch}:${type}`).lastFailure = { at: r.now, fast: true, reason: 'refused in 30 ms: error 31' } }
    r.gaps = (ch) => sent.filter((m) => m.t === 'recgap' && m.ch === ch).map(({ fromMs, toMs, reason }) => ({ fromMs, toMs, reason }))
    r.cam = (ch) => r.rec.cams.get(ch)
    r.ticks = (n) => { for (let i = 0; i < n; i++) { r.now += 250; r.rec.tick() } }
    return r
  }
  {
    // on the sub by a setting; the NVR set to 'main', and the NVR refuses that main
    const r = rig('xa')
    r.set('sub')
    await r.key(0)
    r.now += 1000
    await r.key(0)
    const last = r.now
    r.now += 500
    r.set('main')
    r.now += 1000
    r.refuse(0, 0)
    r.rec.tick()
    const tRef = r.now
    const wait = r.cam(0).refusedUntil - tRef
    check("switch, then the new stream refused: the switch's row ends at the refusal", J(r.gaps(0)) === J([{ fromMs: last, toMs: tRef, reason: TO_MAIN }]) && r.cam(0).gap?.fromMs === tRef && /^refused by the NVR/.test(r.cam(0).gap?.reason), J({ rows: r.gaps(0), open: r.cam(0).gap }))
    check("... it waits out the refusal (5-10 min under 'main')", !r.on(0, 0) && wait >= 5 * 60_000 && wait <= 10 * 60_000, `${wait} ms`)
    r.now = r.cam(0).refusedUntil + 1
    r.rec.tick()
    await r.key(0)
    const g = r.gaps(0)
    check('... and the wait is a row of its own, which reports file as refused by the NVR', g.length === 2 && g[1].fromMs === tRef && g[1].toMs === r.now && gapKind(g[1].reason) === 'refused by the NVR', J(g))
    await r.rec.stop()
  }
  {
    // the camera goes offline 2 s into a switch, for an hour
    const r = rig('xb')
    r.set()
    await r.key(0)
    r.now += 1000
    await r.key(0)
    const last = r.now
    r.now += 500
    r.set('sub')
    r.now += 2000
    r.chans[0].online = false
    r.rec.sync()
    const tOff = r.now
    r.now += 3_600_000
    r.chans[0].online = true
    r.rec.sync()
    await r.key(0)
    const g = r.gaps(0)
    check("switch, then the camera offline for an hour: the switch's row ends when it went, the hour is 'camera offline'", r.on(0, 1) && J(g) === J([{ fromMs: last, toMs: tOff, reason: TO_SUB }, { fromMs: tOff, toMs: r.now, reason: 'camera offline' }]), J(g))
    await r.rec.stop()
  }
  {
    // the NVR drops off just after a switch and is back an hour on: the worker does not drive the
    // recorder while it is logged out, and the relogin dropped the taps (LiveStream.fail)
    const r = rig('xc')
    r.set()
    await r.key(0)
    r.now += 1000
    await r.key(0)
    const last = r.now
    r.now += 500
    r.set('sub')
    const tSw = r.now
    r.nvrOnline = false
    r.now += 3_600_000
    r.nvrOnline = true
    for (const s of r.streams.values()) s.clients.clear()
    r.rec.tick()
    await r.key(0)
    const g = r.gaps(0)
    check("switch, then an NVR outage: the switch's row runs 30 s at most, the rest is 'no video from the NVR'", r.on(0, 1) && J(g) === J([{ fromMs: last, toMs: tSw + 30_000, reason: TO_SUB }, { fromMs: tSw + 30_000, toMs: r.now, reason: 'no video from the NVR' }]), J(g))
    await r.rec.stop()
  }
  {
    // the main has been silent for 20 s when the NVR is set to 'sub'
    const r = rig('xd')
    r.set()
    await r.key(0)
    r.now += 1000
    await r.key(0)
    const last = r.now
    r.ticks(80)
    r.set('sub')
    const tSw = r.now
    r.now += 1000
    await r.key(0)
    const g = r.gaps(0)
    check("a stall under way when the switch comes: 'no video from the NVR' up to the switch, the switch from there", J(g) === J([{ fromMs: last, toMs: tSw, reason: 'no video from the NVR' }, { fromMs: tSw, toMs: tSw + 1000, reason: TO_SUB }]), J(g))
    await r.rec.stop()
  }
  {
    // 'auto': camera 0's main refused once (a 5-10 min wait), then the NVR is set to 'sub'
    const r = rig('xe', [0, 1])
    r.set()
    await r.key(0)
    await r.key(1)
    r.now += 1000
    r.refuse(0, 0)
    r.rec.tick()
    const tRef = r.now
    const wait = r.cam(0).refusedUntil - r.now
    check("'auto', a main refused once: the camera waits 5-10 min with no stream", !r.on(0, 0) && !r.on(0, 1) && wait >= 5 * 60_000, `${wait} ms`)
    r.now += 1000
    r.set('sub')
    check("... the NVR set to 'sub': it takes its sub-stream at once, not when the wait ends", r.on(0, 1) && r.cam(0).refusedUntil === 0, J({ until: r.cam(0).refusedUntil - r.now }))
    check('... in its turn: camera 1 still on its main (one camera per NVR every 3 s)', r.on(1, 0) && !r.on(1, 1))
    r.ticks(12)
    check('... and camera 1 on its sub-stream 3 s later', r.on(1, 1) && !r.on(1, 0))
    await r.key(0)
    const g = r.gaps(0)
    check('... the time camera 0 recorded nothing is one row, refused by the NVR', g.length === 1 && g[0].fromMs <= tRef && g[0].toMs === r.now && gapKind(g[0].reason) === 'refused by the NVR', J(g))
    await r.rec.stop()
  }
  {
    // 'sub': the sub-stream refused
    const r = rig('xf')
    r.set('sub')
    await r.key(0)
    r.now += 1000
    r.refuse(0, 1)
    r.rec.tick()
    const wait = r.cam(0).refusedUntil - r.now
    check("'sub', the sub-stream refused: it waits 5-10 min, not asked for again at the next tick", !r.on(0, 1) && wait >= 5 * 60_000 && wait <= 10 * 60_000, `${wait} ms`)
    r.ticks(8)
    check('... still not asked for 2 s on', !r.on(0, 1))
    r.set('main')
    check("... then set to 'main': the main at once", r.on(0, 0) && r.cam(0).refusedUntil === 0, J({ until: r.cam(0).refusedUntil - r.now }))
    await r.rec.stop()
  }
  {
    const r = rig('xf2')
    r.set('sub')
    await r.key(0)
    r.now += 1000
    r.refuse(0, 1)
    r.rec.tick()
    r.now += 1000
    r.set()
    check("'sub' refused, then back to 'auto': the main at once, one refusal short of the sub", r.on(0, 0) && r.cam(0).refusedUntil === 0 && r.cam(0).pick.refusals === 1, J({ until: r.cam(0).refusedUntil - r.now, pick: r.cam(0).pick }))
    await r.rec.stop()
  }
  {
    // 'auto': the main refused twice drops to the sub; that sub refused before its first frame
    const r = rig('xg')
    r.set()
    await r.key(0)
    r.now += 1000
    r.refuse(0, 0)
    r.rec.tick()
    r.now = r.cam(0).refusedUntil + 1
    r.rec.tick()
    r.refuse(0, 0)
    r.now += 250
    r.rec.tick()
    check("'auto', the main refused twice: dropped to the sub-stream at once", r.cam(0).refusedUntil === 0)
    r.ticks(1)
    check('... the sub-stream attached', r.on(0, 1))
    r.refuse(0, 1)
    r.now += 250
    r.rec.tick()
    const wait = r.cam(0).refusedUntil - r.now
    check('... that sub-stream refused before its first frame: it waits 5-10 min, not asked for again at once', !r.on(0, 1) && wait >= 5 * 60_000, `${wait} ms`)
    await r.rec.stop()
  }
  {
    // on the sub by a setting; back to 'auto', and the NVR refuses the main it goes back to
    const r = rig('xh')
    r.set('sub')
    await r.key(0)
    r.now += 1000
    await r.key(0)
    const last = r.now
    r.now += 500
    r.set()
    check("back to 'auto': the camera moved to its main", r.on(0, 0) && !r.on(0, 1))
    r.now += 1000
    r.refuse(0, 0)
    r.rec.tick()
    const tRef = r.now
    check('... the NVR refuses that main: straight back to the sub-stream, not 5-10 min of nothing', r.cam(0).refusedUntil === 0, J({ until: r.cam(0).refusedUntil - r.now, pick: r.cam(0).pick }))
    r.ticks(1)
    await r.key(0)
    const g = r.gaps(0)
    check('... recording its sub-stream a tick later, as a fallback now (listed degraded)', r.on(0, 1) && J(r.rec.degraded().map((d) => d.ch)) === '[0]', J(r.rec.degraded()))
    check('... rows: the switch up to the refusal, then refused until the sub records', g.length === 2 && J(g[0]) === J({ fromMs: last, toMs: tRef, reason: TO_MAIN }) && g[1].fromMs === tRef && g[1].toMs === r.now && gapKind(g[1].reason) === 'refused by the NVR', J(g))
    r.ticks(40)
    check('... and it stays there (the setting does not move a fallback)', r.on(0, 1) && !r.on(0, 0))
    await r.rec.stop()
  }
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
