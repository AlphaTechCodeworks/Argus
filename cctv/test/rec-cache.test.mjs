// Tests for playback from server recordings, phase 3 Task 6 ("Recent footage in RAM"):
//   rec-cache.mjs     createWarmer: each finished segment and its .idx read once, start to end,
//                     into one reused buffer, one file at a time (warms the OS file cache);
//                     estimateRecentRam: RAM per memory.recentMinutes choice from the recording
//                     cameras' real bytes per minute, next to MemAvailable
//   rec-index.mjs     recentOf(nvr, ch, limit): newest first
//   settings-api.mjs  GET /api/admin/settings carries memory (the estimate) when given one
//   nvrs.mjs          a worker's {t:'segment'} reaches the warmer (CCTV_LIVE_WORKER=on)
// Temp dirs, fake fs objects, the fake SDK and *.invalid hosts only: nothing reaches an NVR.
// Run:  node cctv/test/rec-cache.test.mjs
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}\n`)
}
const until = async (pred, ms = 8000) => {
  const t = Date.now()
  while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50))
  return pred()
}
const J = (v) => JSON.stringify(v)
/** A module, or {} with a FAIL when it cannot be loaded (so a missing file still reports the rest). */
const load = async (path) => {
  try {
    return await import(path)
  } catch (e) {
    check(`load ${path}`, false, e.message)
    return {}
  }
}

const data = mkdtempSync(join(tmpdir(), 'rec-cache-'))
process.env.DATA_DIR = data
writeFileSync(join(data, 'users.json'), J({ boss: { hash: 'x', role: 'admin' }, viewer: { hash: 'x', role: 'viewer' } }))
writeFileSync(join(data, 'nvrs.json'), J({ nvrs: [{ id: 'w1', site: 'T', name: 'W1', host: 'w1.invalid', port: 6036, user: 'u', password: 'p' }] }))
process.env.CCTV_WORKER_FAKE_SDK = '1'
// The worker is guarded (process-guard.mjs): a promise rejection nobody catches in it is one line on
// its stderr, and every check here would still pass. With Node's own flag it ends there instead, as
// it did before the guard, and the test that started it fails.
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --unhandled-rejections=strict`.trim()

const { createWarmer, estimateRecentRam } = await load('../rec-cache.mjs')
const { openRecIndex } = await load('../rec-index.mjs')
const { handleSettings } = await load('../settings-api.mjs')
const { RECENT_MINUTES } = await load('../settings.mjs')

const M = 60_000
const MB = 1_000_000
const T = Date.UTC(2026, 8, 24, 12, 0, 0)
const tick = (ms) => new Promise((r) => (ms ? setTimeout(r, ms) : setImmediate(r)))

/**
 * A fake fs.promises: open(path, flags) -> handle { stat, read, close }. sizes: path -> bytes.
 * Every open and read is logged; open handles are counted (max too). failRead: paths whose
 * read throws EIO; a path missing from sizes fails to open with ENOENT.
 */
function fakeFs(sizes, { failRead = new Set(), delayMs = 0 } = {}) {
  const log = { opens: [], reads: [], open: 0, maxOpen: 0, closes: 0 }
  return {
    log,
    async open(path, flags) {
      log.opens.push({ path, flags })
      await tick(delayMs)
      if (!sizes.has(path)) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' })
      log.open++
      log.maxOpen = Math.max(log.maxOpen, log.open)
      const size = sizes.get(path)
      let closed = false
      return {
        async stat() {
          return { size }
        },
        async read(buffer, offset, length, position) {
          await tick(delayMs)
          if (failRead.has(path)) throw Object.assign(new Error(`EIO: i/o error, read '${path}'`), { code: 'EIO' })
          const n = Math.max(0, Math.min(length, size - position))
          log.reads.push({ path, buffer, offset, length, position, n })
          return { bytesRead: n, buffer }
        },
        async close() {
          if (closed) return
          closed = true
          log.open--
          log.closes++
        }
      }
    }
  }
}
/** Whether path was read exactly once, completely: contiguous reads from 0 covering size bytes. */
const readOnce = (log, path, size) => {
  const rs = log.reads.filter((r) => r.path === path && r.n > 0).sort((a, b) => a.position - b.position)
  let pos = 0
  for (const r of rs) {
    if (r.position !== pos || r.offset !== 0) return false
    pos += r.n
  }
  return pos === size && log.opens.filter((o) => o.path === path).length === 1
}
const segAt = (name, endMs) => ({ t: 'segment', nvr: 'n1', ch: 2, path: `/r/n1/2/2026-09-24/12/${name}.h264`, startMs: endMs - 59_960, endMs, bytes: 1, keyframes: 30, loc: 'L1' })

// ---- the warmer
if (createWarmer) {
  // minutes 2: the file and its .idx read once each, completely, always into the same Buffer
  {
    const a = segAt('11-58', T - 10_000)
    const b = segAt('11-59', T - 1_000)
    const sizes = new Map([
      [a.path, 2.5 * (1 << 20) + 123],
      [`${a.path}.idx`, 30 * 16],
      [b.path, (1 << 20) * 3],
      [`${b.path}.idx`, 16]
    ])
    const fs = fakeFs(sizes, { delayMs: 1 })
    const w = createWarmer({ minutes: () => 2, fs, now: () => T })
    w.onSegment(a)
    w.onSegment(b)
    await w.idle()
    const st = w.stats()
    check('minutes 2: the segment file read once, completely', readOnce(fs.log, a.path, sizes.get(a.path)), J(fs.log.reads.filter((r) => r.path === a.path).map((r) => [r.position, r.n])))
    check('minutes 2: its .idx read once, completely', readOnce(fs.log, `${a.path}.idx`, sizes.get(`${a.path}.idx`)))
    check('minutes 2: the second segment and its .idx too', readOnce(fs.log, b.path, sizes.get(b.path)) && readOnce(fs.log, `${b.path}.idx`, 16))
    check('opened read-only', fs.log.opens.every((o) => o.flags === 'r'), J(fs.log.opens.map((o) => o.flags)))
    const bufs = new Set(fs.log.reads.map((r) => r.buffer))
    const buf = [...bufs][0]
    check('every read goes into the same Buffer object (one reused buffer, nothing kept)', bufs.size === 1 && Buffer.isBuffer(buf), `${bufs.size} buffers`)
    check('the buffer is 1 MB (the default chunk)', buf?.length === 1 << 20, buf?.length)
    check('reads are at most one chunk each', fs.log.reads.every((r) => r.length <= 1 << 20))
    check('stats: 2 warmed, 4 files, the bytes of all four, no errors', st.warmed === 2 && st.files === 4 && st.bytes === [...sizes.values()].reduce((x, y) => x + y, 0) && st.errors === 0 && st.dropped === 0 && st.skipped === 0, J(st))
    check('every handle closed, one file at a time', fs.log.open === 0 && fs.log.closes === 4 && fs.log.maxOpen === 1, J({ open: fs.log.open, closes: fs.log.closes, max: fs.log.maxOpen }))
    check('idle when done: nothing pending', st.pending === 0)
  }
  // minutes 0: nothing read
  {
    const s = segAt('11-59', T - 1_000)
    const fs = fakeFs(new Map([[s.path, 100], [`${s.path}.idx`, 16]]))
    const w = createWarmer({ minutes: () => 0, fs, now: () => T })
    w.onSegment(s)
    await w.idle()
    check('minutes 0: no reads (not even an open)', fs.log.opens.length === 0 && fs.log.reads.length === 0 && w.stats().warmed === 0)
    const w2 = createWarmer({ minutes: () => { throw new Error('settings unreadable') }, fs, now: () => T })
    let threw = false
    try {
      w2.onSegment(s)
      await w2.idle()
    } catch {
      threw = true
    }
    check('minutes() throwing: treated as off, nothing thrown, no reads', !threw && fs.log.opens.length === 0)
    let on = 2
    const fs3 = fakeFs(new Map([[s.path, 100], [`${s.path}.idx`, 16]]), { delayMs: 5 })
    const w3 = createWarmer({ minutes: () => on, fs: fs3, now: () => T })
    const s2 = segAt('11-59b', T - 500)
    fs3.log.opens.length = 0
    w3.onSegment(s) // in flight
    w3.onSegment(s2) // queued
    on = 0 // turned off while s2 waits
    await w3.idle()
    check('turned off while queued: the queued segment is not read', !fs3.log.opens.some((o) => o.path === s2.path), J(fs3.log.opens.map((o) => o.path)))
  }
  // age: a segment that ended more than `minutes` ago is skipped
  {
    const old = segAt('11-55', T - 2 * M - 1)
    const edge = segAt('11-56', T - 2 * M)
    const fs = fakeFs(new Map([[old.path, 100], [`${old.path}.idx`, 16], [edge.path, 100], [`${edge.path}.idx`, 16]]))
    const w = createWarmer({ minutes: () => 2, fs, now: () => T })
    w.onSegment(old)
    w.onSegment(edge)
    await w.idle()
    check('a segment older than 2 min is skipped (no open)', !fs.log.opens.some((o) => o.path.startsWith(old.path)) && w.stats().skipped === 1, J(w.stats()))
    check('one that ended exactly 2 min ago is still warmed', readOnce(fs.log, edge.path, 100) && w.stats().warmed === 1)
  }
  // 100 segments at once: maxPending 64 holds, the oldest are dropped and counted, one file open at a time
  {
    const segs = Array.from({ length: 100 }, (_, i) => segAt(`q${String(i).padStart(3, '0')}`, T - 1000 + i))
    const sizes = new Map(segs.flatMap((s) => [[s.path, 3000], [`${s.path}.idx`, 32]]))
    const fs = fakeFs(sizes, { delayMs: 1 })
    const w = createWarmer({ minutes: () => 2, fs, now: () => T, maxPending: 64 })
    let maxPending = 0
    for (const s of segs) {
      w.onSegment(s)
      maxPending = Math.max(maxPending, w.stats().pending)
    }
    const whileBusy = w.stats()
    await w.idle()
    const st = w.stats()
    const opened = new Set(fs.log.opens.map((o) => o.path))
    check('maxPending 64 holds while 100 arrive at once', maxPending <= 64 && whileBusy.pending <= 64, `${maxPending}`)
    check('the overflow is dropped and counted (dropped + warmed = 100)', st.dropped >= 35 && st.dropped <= 36 && st.dropped + st.warmed === 100, J(st))
    check('the newest 64 are all warmed', segs.slice(-64).every((s) => opened.has(s.path) && opened.has(`${s.path}.idx`)))
    check('the dropped ones are the oldest (none of q001..q035 read)', segs.slice(1, 36).every((s) => !opened.has(s.path)))
    check('at most one file open at any time', fs.log.maxOpen === 1 && fs.log.open === 0, `max ${fs.log.maxOpen}`)
  }
  // errors: counted, never thrown; the next file is still warmed
  {
    const a = segAt('e1', T - 3000)
    const b = segAt('e2', T - 2000) // missing: ENOENT at open (housekeeping deleted it)
    const c = segAt('e3', T - 1000)
    const sizes = new Map([[a.path, 5000], [`${a.path}.idx`, 16], [c.path, 7000], [`${c.path}.idx`, 32]])
    const fs = fakeFs(sizes, { failRead: new Set([a.path]) })
    const w = createWarmer({ minutes: () => 2, fs, now: () => T })
    const realWarn = console.warn
    const warned = []
    console.warn = (...x) => warned.push(x.join(' '))
    let threw = false
    try {
      w.onSegment(a)
      w.onSegment(b)
      w.onSegment(c)
      w.onSegment(null)
      w.onSegment({})
      await w.idle()
    } catch {
      threw = true
    } finally {
      console.warn = realWarn
    }
    const st = w.stats()
    check('a read error and a missing file: counted, nothing thrown', !threw && st.errors === 2, J(st))
    check('the next file is still warmed after the errors', readOnce(fs.log, c.path, 7000) && readOnce(fs.log, `${c.path}.idx`, 32) && st.warmed === 1, J(st))
    check('the handle of the failed read is closed', fs.log.open === 0)
    check('a malformed report (null, no path) is ignored', fs.log.opens.every((o) => typeof o.path === 'string' && o.path.startsWith('/r/')))
    check('errors are logged at most once', warned.length <= 1, J(warned))
  }
  // the real fs: a temp file and its .idx
  {
    const dir = mkdtempSync(join(tmpdir(), 'rec-cache-fs-'))
    const p = join(dir, '12-00.h265')
    writeFileSync(p, Buffer.alloc(2_600_000, 7))
    writeFileSync(`${p}.idx`, Buffer.alloc(48, 1))
    const w = createWarmer({ minutes: () => 5, now: () => T })
    w.onSegment({ path: p, startMs: T - 60_000, endMs: T - 100 })
    await w.idle()
    const st = w.stats()
    check('real fs: warmed with node:fs/promises (all bytes read)', st.warmed === 1 && st.bytes === 2_600_048 && st.errors === 0, J(st))
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ---- rec-index recentOf
const idx = openRecIndex ? openRecIndex(join(data, 'cache.db')) : null
const addSegs = (nvr, ch, n, { bytesPerMin, durMs = 60_000, endAt = T }) => {
  for (let i = 0; i < n; i++) {
    const end = endAt - i * durMs - 40
    const start = end - durMs + 40
    idx.addSegment({ nvr, ch, path: `/r/${nvr}/${ch}/${start}.h264`, startMs: start, endMs: end, bytes: Math.round((bytesPerMin * (end - start)) / 60_000), keyframes: 30, loc: 'L1' })
  }
}
if (idx) {
  check('recentOf exists', typeof idx.recentOf === 'function')
  addSegs('n1', 1, 5, { bytesPerMin: 30 * MB }) // the 5 newest: 30 MB/min
  addSegs('n1', 1, 2, { bytesPerMin: 100 * MB, endAt: T - 5 * 60_000 }) // older, not sampled
  addSegs('n1', 2, 4, { bytesPerMin: 12 * MB, durMs: 30_000 }) // 12 MB/min in 30 s files
  addSegs('n1', 2, 1, { bytesPerMin: 12 * MB, durMs: 60_000, endAt: T - 2 * 60_000 })
  addSegs('n1', 3, 5, { bytesPerMin: 50 * MB }) // mode 'off': ignored
  addSegs('n1', 4, 5, { bytesPerMin: 70 * MB }) // no override, the default mode (off)
  const r = idx.recentOf?.('n1', 1, 5) ?? []
  check('recentOf: at most limit rows, newest first', r.length === 5 && r.every((s, i) => i === 0 || s.startMs < r[i - 1].startMs), J(r.map((s) => s.startMs)))
  check('recentOf: the camera\'s newest segments only', r.length > 0 && r.every((s) => s.nvr === 'n1' && s.ch === 1) && r[0].endMs === T - 40 && r.every((s) => s.bytes === 30 * MB - 20_000 || s.bytes === 30 * MB), J(r.map((s) => s.bytes)))
  check('recentOf: plain objects with the segment fields', r[0] && Object.getPrototypeOf(r[0]) === Object.prototype && ['nvr', 'ch', 'path', 'startMs', 'endMs', 'bytes', 'keyframes', 'loc'].every((k) => k in r[0]))
  check('recentOf: a camera without segments gives []', J(idx.recentOf?.('n9', 0, 5)) === '[]')
  check('recentOf: limit 2', idx.recentOf?.('n1', 1, 2)?.length === 2)
}

// ---- the RAM estimate
if (estimateRecentRam && idx) {
  const DEF = { mode: 'off', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 183, preS: 10, postS: 20 }
  const settings = {
    recording: { defaults: DEF, cameras: { 'n1/1': { mode: 'continuous' }, 'n1/2': { mode: 'motion' }, 'n1/3': { mode: 'off' }, 'n2/0': { mode: 'continuous' } } },
    memory: { recentMinutes: 2 }
  }
  const meminfo = 'MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:   12345678 kB\nBuffers:           10000 kB\n'
  const e = estimateRecentRam({ index: idx, settings, readMeminfo: () => meminfo })
  const near = (x, y) => Math.abs(x - y) <= 1000 // bytes: the 40 ms seams between files
  check('two recording cameras at 30 and 12 MB/min: perMinuteBytes 42 MB', near(e.perMinuteBytes, 42 * MB), e.perMinuteBytes)
  check('byMinutes[2] = 84 MB', near(e.byMinutes?.[2], 84 * MB), J(e.byMinutes))
  check('byMinutes has every non-zero choice (1, 2, 5, 10)', J(Object.keys(e.byMinutes ?? {}).map(Number).sort((a, b) => a - b)) === J(RECENT_MINUTES.filter((m) => m > 0)) && near(e.byMinutes[10], 420 * MB))
  check('an \'off\' camera (override or default) is ignored; one with no segments counts in cameras only', e.cameras === 3 && e.measured === 2, J({ cameras: e.cameras, measured: e.measured }))
  check('only the 5 most recent segments are sampled (the older 100 MB/min ones are not)', e.perMinuteBytes < 43 * MB)
  check('MemAvailable: 12345678 kB parsed to bytes', e.memAvailableBytes === 12345678 * 1024, e.memAvailableBytes)
  const noProc = estimateRecentRam({ index: idx, settings, readMeminfo: () => { throw new Error('ENOENT /proc/meminfo') } })
  check('without /proc/meminfo: memAvailableBytes null (and the rest still there)', noProc.memAvailableBytes === null && near(noProc.perMinuteBytes, 42 * MB))
  check('meminfo without MemAvailable: null', estimateRecentRam({ index: idx, settings, readMeminfo: () => 'MemTotal: 1 kB\n' }).memAvailableBytes === null)
  const all = estimateRecentRam({ index: idx, settings: { ...settings, recording: { ...settings.recording, defaults: { ...DEF, mode: 'continuous' } } }, readMeminfo: () => meminfo })
  check('default mode on: cameras without an override count (n1/4 at 70 MB/min), \'off\' overrides still ignored', near(all.perMinuteBytes, 112 * MB) && all.cameras === 4 && all.measured === 3, J(all))
  const listed = estimateRecentRam({ index: idx, settings: { ...settings, recording: { ...settings.recording, defaults: { ...DEF, mode: 'continuous' } } }, list: [{ nvr: 'n1', ch: 1 }, { nvr: 'n1', ch: 3 }, { nvr: 'n3', ch: 7 }], readMeminfo: () => meminfo })
  check('with a camera list: those cameras plus the overrides (n3/7 recording, no segments yet)', near(listed.perMinuteBytes, 42 * MB) && listed.cameras === 4 && listed.measured === 2, J(listed))
  const none = estimateRecentRam({ index: null, settings, readMeminfo: () => meminfo })
  check('no index (flag off): no bytes, nothing thrown', none.perMinuteBytes === 0 && none.measured === 0 && none.memAvailableBytes === 12345678 * 1024, J(none))
}

// ---- GET /api/admin/settings carries memory
if (handleSettings) {
  const json = (o) => async () => o
  let calls = 0
  const fakeMem = { perMinuteBytes: 42 * MB, byMinutes: { 1: 42 * MB, 2: 84 * MB, 5: 210 * MB, 10: 420 * MB }, cameras: 2, measured: 2, memAvailableBytes: 8e9 }
  const ramEstimate = () => (calls++, fakeMem)
  const [g1, b1] = await handleSettings('GET', '/api/admin/settings', json({}), 'boss', true, { ramEstimate })
  check('GET with a ramEstimate: memory is its answer', g1 === 200 && J(b1.memory) === J(fakeMem) && b1.settings && b1.choices && calls === 1, J(b1.memory))
  const [g2, b2] = await handleSettings('GET', '/api/admin/settings', json({}), 'boss', true)
  check('GET without one: memory null', g2 === 200 && b2.memory === null && b2.settings && b2.choices)
  const [g3, b3] = await handleSettings('GET', '/api/admin/settings', json({}), 'boss')
  check('old callers (4 arguments) unchanged: 200, settings and choices', g3 === 200 && b3.memory === null && Array.isArray(b3.choices.recentMinutes))
  const [g4, b4] = await handleSettings('GET', '/api/admin/settings', json({}), 'boss', true, { ramEstimate: () => { throw new Error('boom') } })
  check('a failing estimate: still 200, memory null', g4 === 200 && b4.memory === null && b4.settings)
  const [p1] = await handleSettings('POST', '/api/admin/settings', json({ memory: { recentMinutes: 5 } }), 'boss', true, { ramEstimate })
  check('POST does not compute the estimate', p1 === 200 && calls === 1)
  const [v1, vb1] = await handleSettings('GET', '/api/admin/settings', json({}), 'viewer', false, { ramEstimate })
  check('non-admin: 403, estimate not computed', v1 === 403 && !('memory' in vb1) && calls === 1)
  await handleSettings('POST', '/api/admin/settings', json({ memory: { recentMinutes: 2 } }), 'boss', true)
}

// ---- the app: nvrs.mjs hands each finished segment to the warmer (CCTV_LIVE_WORKER=on)
{
  const path = mkdtempSync(join(tmpdir(), 'rc-app-'))
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, '.cctv-recordings'), J({ id: 'LA', created: new Date().toISOString() }))
  const L = { id: 'LA', path, type: 'usb', role: 'main', limitGB: null }
  const DEF = { mode: 'off', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 183, preS: 10, postS: 20 }
  writeFileSync(join(data, 'settings.json'), J({ recording: { defaults: DEF, cameras: { 'w1/2': { mode: 'continuous' } } }, memory: { recentMinutes: 2 }, storage: { locations: [L], lowFreePct: 15, floorFreePct: 5 } }))
  process.env.CCTV_LIVE_WORKER = 'on'
  await import('./fake-sdk.mjs')
  const { startNvrs, stopNvrs, recIndex, recWarmer } = await import('../nvrs.mjs')
  const { saveSettings } = await import('../settings.mjs')
  check('nvrs.mjs exports recWarmer()', typeof recWarmer === 'function')
  const realLog = console.log
  console.log = () => {}
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => (/^(PASS|FAIL|SKIP|\n)/.test(String(chunk)) ? realWrite(chunk, ...rest) : true)
  try {
    startNvrs()
    check('app: the warmer is created with the recording (startRecording)', typeof recWarmer === 'function' && recWarmer() != null && typeof recWarmer().onSegment === 'function')
    check('app: a file is being written', await until(() => recIndex()?.openOf('w1', 2) != null, 10_000))
    const open = recIndex()?.openOf('w1', 2)?.path
    saveSettings({ recording: { cameras: { 'w1/2': { mode: 'off' } } } }, 'test')
    check('app: its segment is indexed when recording stops', await until(() => open && recIndex()?.has(open), 10_000))
    const w = typeof recWarmer === 'function' ? recWarmer() : null
    check('app: the finished segment reached the warmer and was read', await until(() => (w?.stats().warmed ?? 0) >= 1, 10_000) && w.stats().bytes > 0 && w.stats().errors === 0, J(w?.stats()))
    check('app: the file is still there (warming only reads)', open && existsSync(open) && existsSync(`${open}.idx`))
    await stopNvrs()
  } finally {
    process.stdout.write = realWrite
    console.log = realLog
  }
}

idx?.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
