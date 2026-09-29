// Event pictures (event-snapshot.mjs): the file names, ffmpeg's arguments, the wait for the recording
// to reach the event (a fake index and clock), the keyframe read from real segment files through
// rec-reader.mjs (closed and still being written), ffmpeg one at a time and its failures, the route's
// rights, and pictures going with their events. ffmpeg is a fake here (it is on the server only);
// event-snapshot-ffmpeg.test.mjs runs the real one there.
//
// Temp data folder only; no NVR, no SDK, no ffmpeg.
//   node cctv/test/event-snapshot.test.mjs
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-snap-test-'))
// (every rights row below has an account: a row without one grants nothing, rights.mjs rightsOf)
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ alice: { hash: 'x', role: 'admin' }, bob: { hash: 'x', role: 'viewer' }, carol: { hash: 'x', role: 'viewer' }, dave: { hash: 'x', role: 'viewer' }, erin: { hash: 'x', role: 'viewer' } }))
// bob may watch live only; carol may play nvr1/3 back from the server; dave may play all of nvr1 back
// from the NVR; erin may too, and watch nvr1 live (the version 1 file is upgraded: Live HD = Live)
writeFileSync(join(process.env.DATA_DIR, 'rights.json'), JSON.stringify({
  version: 1,
  users: {
    bob: { grants: { live: ['*'] } },
    carol: { grants: { 'playback-server': ['nvr1/3'] } },
    dave: { grants: { 'playback-nvr': ['nvr1'] } },
    erin: { grants: { 'playback-nvr': ['nvr1'], live: ['nvr1'] } }
  }
}))

const {
  SD_RETRY_MS, SD_WIDTH, SNAP_AFTER_MS, SNAP_DIR, SNAP_LATE_MS, SNAP_POLL_MS, SNAP_WAIT_MS,
  forgetSnapshots, handleSnapshot, sdArgs, sdPath, sdSnapshot, snapArgs, snapPath, sweepSnapshots, takeSnapshot
} = await import('../event-snapshot.mjs')
const { addEvent, closeEvents } = await import('../events-db.mjs')
const { CODEC } = await import('../rec-reader.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 27, 14, 0, 0)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])])

// ---- names and arguments ------------------------------------------------------------------------
{
  check('SNAP_DIR is event-snaps in the data folder', SNAP_DIR === join(process.env.DATA_DIR, 'event-snaps'), SNAP_DIR)
  check('snapPath: <id>.jpg in SNAP_DIR (a numeric string too)', snapPath(12) === join(SNAP_DIR, '12.jpg') && snapPath('12') === join(SNAP_DIR, '12.jpg'))
  const throws = (v) => { try { snapPath(v); return false } catch { return true } }
  check('snapPath: anything but a positive whole number is refused (never a path from outside)', ['../x', '1/2', 1.5, -3, 0, '', null, undefined, NaN].every(throws))
  check('the wait is 3 minutes, looking every 5 s', SNAP_WAIT_MS === 180_000 && SNAP_POLL_MS === 5000 && SNAP_AFTER_MS === 1000)
  const a = snapArgs(CODEC.h264).join(' ')
  check('snapArgs H.264: raw h264 on stdin, one frame, one JPEG on stdout',
    a.includes('-f h264 -i pipe:0') && a.includes('-frames:v 1') && a.includes('-q:v 4') && a.endsWith('-f image2pipe -c:v mjpeg pipe:1'), a)
  check('  scaled to at most 1280 wide, height even (quoted for the filter parser, no shell)', snapArgs(CODEC.h264).includes("scale='min(1280,iw)':-2"))
  check('snapArgs H.265: hevc on stdin', snapArgs(CODEC.h265).join(' ').includes('-f hevc -i pipe:0'))
}

// ---- a fake ffmpeg --------------------------------------------------------------------------------
// how: 'ok' writes a JPEG, 'junk' writes something else, 'fail' exits 1 with a message, 'hang' never
// ends, 'enoent' is not installed. It counts how many run at once.
const procs = []
let running = 0
let most = 0
class FakeProc extends EventEmitter {
  constructor(bin, args, how) {
    super()
    Object.assign(this, { bin, args, how, killed: [], input: null })
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    running++
    most = Math.max(most, running)
    this.stdin = Object.assign(new EventEmitter(), {
      end: (buf) => {
        this.input = Buffer.from(buf)
        if (how === 'hang') return
        setImmediate(() => {
          if (how === 'enoent') {
            running--
            this.emit('error', Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' }))
            return
          }
          if (how === 'ok') this.stdout.emit('data', JPEG)
          if (how === 'junk') this.stdout.emit('data', Buffer.from('not a picture'))
          if (how === 'fail') this.stderr.emit('data', Buffer.from('Invalid data found when processing input\n'))
          running--
          this.emit('close', how === 'fail' ? 1 : 0)
        })
      }
    })
  }
  kill(sig) {
    this.killed.push(sig)
    running--
    this.emit('close', null)
  }
}
const spawnAs = (how) => (bin, args) => {
  const p = new FakeProc(bin, args, how)
  procs.push(p)
  return p
}

// A camera's recordings as the index reports them: files [{ path, startMs, endMs, open? }] (the test
// may change them between looks), like rec-index.mjs at() and next()
const fakeIndex = (files) => ({
  at: (nvr, ch, t) => [...files].reverse().find((s) => t >= s.startMs && (s.open ? t <= s.startMs + 180_000 : t <= s.endMs)) ?? null,
  next: (nvr, ch, after) => files.find((s) => s.startMs > after) ?? null
})

/** Everything takeSnapshot is given, fake: readers { path: { times, keys: { k: Buffer } } }. */
function rig({ files = [], readers = {}, how = 'ok', onWait = () => {}, ...rest } = {}) {
  const r = { files, readers, waits: [], logs: [], opened: [], closed: 0, clock: T0 + 5000 }
  r.deps = {
    index: fakeIndex(files),
    readerFor: async (seg) => {
      r.opened.push(seg.path)
      const x = r.readers[seg.path]
      if (!x) throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
      return { times: x.times, keyframe: async (k) => (x.keys[k] ? { buf: x.keys[k], ts: x.times[k] } : null), close: async () => { r.closed++ } }
    },
    now: () => r.clock,
    wait: async (ms) => {
      r.waits.push(ms)
      r.clock += ms
      onWait(r)
    },
    spawn: spawnAs(how),
    platform: 'linux',
    log: (l) => r.logs.push(l),
    ...rest
  }
  return r
}
let nextId = 100
const ev = (o = {}) => ({ id: nextId++, nvr: 'nvr1', ch: 3, startMs: T0, seenMs: Date.now() - 60_000, ...o })
const noTmp = () => !existsSync(SNAP_DIR) || readdirSync(SNAP_DIR).every((n) => !n.endsWith('.tmp'))

// ---- the recording is there already ---------------------------------------------------------------
{
  const K = Buffer.from('key at T0+2s')
  const r = rig({
    files: [{ path: '/r/nvr1/3/14-00.h264', startMs: T0 - 20_000, endMs: T0 + 40_000 }],
    readers: { '/r/nvr1/3/14-00.h264': { times: [T0 - 20_000, T0 - 18_000, T0 + 2000, T0 + 4000], keys: { 2: K, 3: Buffer.from('later') } } }
  })
  const e = ev()
  const got = await takeSnapshot(e, r.deps)
  const p = procs.at(-1)
  check('footage on disk already: the picture is taken at once, without waiting', got === snapPath(e.id) && r.waits.length === 0, `${got} waits ${r.waits.length}`)
  check('  the first keyframe at or after start + 1 s went to ffmpeg, and only it', p.input.equals(K))
  check('  ffmpeg behind ionice and nice, with the snapshot arguments (h264 from the file name)',
    p.bin === 'ionice' && p.args.join(' ').startsWith('-c 3 nice -n 10 ffmpeg -hide_banner') && p.args.join(' ').includes('-f h264 -i pipe:0'), `${p.bin} ${p.args.join(' ')}`)
  check('  the JPEG is SNAP_DIR/<id>.jpg, no temp file left', readFileSync(got).equals(JPEG) && noTmp())
  check('  the reader was closed', r.closed === 1 && r.opened.length === 1)
  check('  one line in the log says it was taken and when', r.logs.length === 1 && /taken 2\.0 s after the start/.test(r.logs[0]), r.logs.join(' | '))
  const again = rig()
  const before = procs.length
  check('asked again for the same event: the picture there is returned, no ffmpeg, no index', (await takeSnapshot(e, again.deps)) === got && procs.length === before && again.opened.length === 0)
  const retake = rig({ files: r.files, readers: r.readers })
  const n = procs.length
  check('a picture older than the event row (an id used again) is taken afresh', (await takeSnapshot({ ...e, seenMs: Date.now() + 60_000 }, retake.deps)) === got && procs.length === n + 1)
}

// ---- waiting for the file being written -------------------------------------------------------------
{
  const K = Buffer.from('key written late')
  const path = '/r/nvr1/3/14-00.h264'
  const r = rig({
    files: [{ path, startMs: T0 - 10_000, endMs: null, open: true }],
    readers: { [path]: { times: [T0 - 10_000, T0 - 8000], keys: {} } },
    onWait: (x) => {
      if (x.waits.length === 2) x.readers[path].times.push(T0 + 2000) // its keyframe has started arriving
      if (x.waits.length === 3) x.readers[path].keys[2] = K // and is complete
    }
  })
  const e = ev()
  const got = await takeSnapshot(e, r.deps)
  check('open file: waits (5 s each) until the keyframe after the event is on disk and complete',
    got === snapPath(e.id) && r.waits.join() === '5000,5000,5000' && procs.at(-1).input.equals(K), `waits ${r.waits.join()}`)
  check('  a fresh reader each look, each one closed', r.opened.length === 4 && r.closed === 4)
}

// ---- never recorded -----------------------------------------------------------------------------------
{
  const r = rig()
  const n = procs.length
  const e = ev()
  const got = await takeSnapshot(e, r.deps)
  check('no recording ever: gives up after SNAP_WAIT_MS (36 looks 5 s apart), no ffmpeg',
    got === null && r.waits.length === SNAP_WAIT_MS / SNAP_POLL_MS && procs.length === n, `waits ${r.waits.length}`)
  check('  and says why, once', r.logs.length === 1 && /not taken, the recording has not reached it yet after 3 minutes/.test(r.logs[0]), r.logs.join(' | '))
  check('  no file', !existsSync(snapPath(e.id)))
}

// ---- the keyframe in the next file --------------------------------------------------------------------
{
  const K = Buffer.from('first key of the next file')
  const r = rig({
    files: [
      { path: '/r/a.h264', startMs: T0 - 50_000, endMs: T0 + 1500 },
      { path: '/r/b.h264', startMs: T0 + 1800, endMs: T0 + 61_000 }
    ],
    readers: {
      '/r/a.h264': { times: [T0 - 50_000, T0 - 2000], keys: { 0: Buffer.from('x'), 1: Buffer.from('y') } },
      '/r/b.h264': { times: [T0 + 1800, T0 + 3800], keys: { 0: K } }
    }
  })
  const got = await takeSnapshot(ev(), r.deps)
  check('no keyframe after the moment in its file: the next file\'s first keyframe', got !== null && procs.at(-1).input.equals(K) && r.opened.join() === '/r/a.h264,/r/b.h264', r.opened.join())
}
{
  const K = Buffer.from('b0')
  const r = rig({
    files: [{ path: '/r/a.h264', startMs: T0 - 50_000, endMs: T0 + 500 }, { path: '/r/b.h264', startMs: T0 + 1200, endMs: T0 + 61_000 }],
    readers: { '/r/b.h264': { times: [T0 + 1200], keys: { 0: K } } }
  })
  const got = await takeSnapshot(ev(), r.deps)
  check('the moment between two files: the next file\'s first keyframe', got !== null && procs.at(-1).input.equals(K) && r.opened.join() === '/r/b.h264', r.opened.join())
}
{
  const r = rig({ files: [{ path: '/r/b.h264', startMs: T0 + 60_000, endMs: T0 + 120_000 }] })
  const got = await takeSnapshot(ev(), r.deps)
  check('a gap: the next footage starts a minute later, so no picture and no waiting',
    got === null && r.waits.length === 0 && r.opened.length === 0 && /nothing was recorded from .* until 59 s later/.test(r.logs[0] ?? ''), r.logs.join(' | '))
}
{
  const r = rig({ files: [{ path: '/r/a.h264', startMs: T0 - 10_000, endMs: T0 + 50_000 }], readers: { '/r/a.h264': { times: [T0 - 10_000, T0 + 1000 + SNAP_LATE_MS + 1000], keys: { 1: Buffer.from('z') } } } })
  const got = await takeSnapshot(ev(), r.deps)
  check('a keyframe more than SNAP_LATE_MS after the moment is not used', got === null && r.waits.length === 0 && /first keyframe after .* came 16 s later/.test(r.logs[0] ?? ''), r.logs.join(' | '))
}
{
  // the RAM spool moved the file to a drive between two looks: the index has the new path next time
  const K = Buffer.from('moved')
  const r = rig({
    files: [{ path: '/ram/a.h264', startMs: T0 - 10_000, endMs: T0 + 50_000 }],
    readers: { '/disk/a.h264': { times: [T0 - 10_000, T0 + 2000], keys: { 1: K } } },
    onWait: (x) => { x.files[0].path = '/disk/a.h264' }
  })
  const got = await takeSnapshot(ev(), r.deps)
  check('a file that cannot be opened is looked for again, and found at its new place', got !== null && r.waits.length === 1 && procs.at(-1).input.equals(K))
}
{
  const r = rig({ files: [{ path: '/r/nvr1/3/14-00.h265', startMs: T0 - 10_000, endMs: T0 + 50_000 }], readers: { '/r/nvr1/3/14-00.h265': { times: [T0 + 2000], keys: { 0: Buffer.from('hevc key') } } } })
  await takeSnapshot(ev(), r.deps)
  check('an .h265 file goes to ffmpeg as hevc', procs.at(-1).args.join(' ').includes('-f hevc -i pipe:0'))
}

// ---- ffmpeg's failures --------------------------------------------------------------------------------
const oneFile = () => ({ files: [{ path: '/r/a.h264', startMs: T0 - 10_000, endMs: T0 + 50_000 }], readers: { '/r/a.h264': { times: [T0 + 2000], keys: { 0: Buffer.from('k') } } } })
for (const [how, want, extra] of [
  ['fail', /ffmpeg exited with 1: Invalid data found/, {}],
  ['junk', /ffmpeg gave no JPEG/, {}],
  ['enoent', /ionice is not installed/, {}],
  ['hang', /ffmpeg did not finish within 0\.03 s/, { timeoutMs: 30 }]
]) {
  const r = rig({ ...oneFile(), how, ...extra })
  const e = ev()
  const got = await takeSnapshot(e, r.deps)
  check(`ffmpeg ${how}: no picture, the reason logged once, no file and no temp file`,
    got === null && r.logs.length === 1 && want.test(r.logs[0]) && !existsSync(snapPath(e.id)) && noTmp(), r.logs.join(' | '))
  if (how === 'hang') check('  a hung ffmpeg is killed', procs.at(-1).killed.join() === 'SIGKILL')
}

// ---- once per event, one ffmpeg at a time ---------------------------------------------------------------
{
  const r = rig(oneFile())
  const e = ev()
  const n = procs.length
  const [a, b] = await Promise.all([takeSnapshot(e, r.deps), takeSnapshot(e, r.deps)])
  check('the same event twice at once: one picture taken, both get it', a === snapPath(e.id) && b === a && procs.length === n + 1)
  most = 0
  const got = await Promise.all([ev(), ev(), ev()].map((x) => takeSnapshot(x, rig(oneFile()).deps)))
  check('three events at once: three pictures, ffmpeg never more than one at a time', got.every(Boolean) && most === 1, `most ${most}`)
}
{
  const logs = []
  check('no index (no server recording): null, said once', (await takeSnapshot(ev(), { index: null, log: (l) => logs.push(l) })) === null && /keeps no recordings/.test(logs[0] ?? ''))
  check('an event without an id: null', (await takeSnapshot({ nvr: 'nvr1', ch: 3, startMs: T0 }, { index: fakeIndex([]), log: () => {} })) === null)
}

// ---- real segment files through rec-reader.mjs -----------------------------------------------------------
// Synthetic H.264 as the recorder writes it: GOPs of SPS+PPS+IDR then 9 P frames, one .idx row
// [uint64 LE offset, int64 LE ms] per keyframe. Fill bytes are never zero, so no false start codes.
{
  const nal = (hdr, fill, len) => Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(hdr), Buffer.alloc(len, fill)])
  const keyAU = (fill) => Buffer.concat([nal([0x67, 0x64], fill, 12), nal([0x68], fill, 4), nal([0x65, 0x88], fill, 600)])
  const pAU = (fill) => nal([0x41, 0x9a], fill, 200)
  const dir = join(process.env.DATA_DIR, 'rec', 'nvr1', '3', '2026-09-27', '14')
  mkdirSync(dir, { recursive: true })
  /** Writes GOPs 0..n-1 (keys 1 s apart from T0); returns the file's bytes and its .idx rows. */
  const gops = (n) => {
    const parts = []
    const rows = []
    let at = 0
    for (let g = 0; g < n; g++) {
      const au = [keyAU(0x51 + g), ...Array.from({ length: 9 }, () => pAU(0x61 + g))]
      rows.push({ offset: at, tsMs: T0 + g * 1000 })
      for (const b of au) at += b.length
      parts.push(...au)
    }
    return { buf: Buffer.concat(parts), rows }
  }
  const idxOf = (rows) => {
    const b = Buffer.alloc(16 * rows.length)
    rows.forEach((r, i) => {
      b.writeBigUInt64LE(BigInt(r.offset), i * 16)
      b.writeBigInt64LE(BigInt(r.tsMs), i * 16 + 8)
    })
    return b
  }

  const closed = join(dir, '14-00.h264')
  const c = gops(4)
  writeFileSync(closed, c.buf)
  writeFileSync(`${closed}.idx`, idxOf(c.rows))
  const r1 = rig({ files: [{ path: closed, startMs: T0, endMs: T0 + 3900 }] })
  delete r1.deps.readerFor // the real one: rec-reader.mjs SegmentReader
  const got = await takeSnapshot(ev({ startMs: T0 + 500 }), r1.deps)
  check('a closed segment file: the keyframe at or after start + 1 s is GOP 2\'s SPS+PPS+IDR, exactly',
    got !== null && procs.at(-1).input.equals(keyAU(0x53)), `${procs.at(-1).input.length} bytes`)

  // a file still being written: key 3's row is there but only half of its bytes
  const growing = join(dir, '14-01.h264')
  const g = gops(4)
  const key3 = g.rows[3].offset
  writeFileSync(growing, g.buf.subarray(0, key3 + 300))
  writeFileSync(`${growing}.idx`, idxOf(g.rows))
  const r2 = rig({
    files: [{ path: growing, startMs: T0, endMs: null, open: true }],
    // then the rest of key 3 and the first P frame after it arrive
    onWait: (x) => { if (x.waits.length === 1) appendFileSync(growing, g.buf.subarray(key3 + 300, key3 + keyAU(0x54).length + pAU(0x64).length)) }
  })
  delete r2.deps.readerFor
  const got2 = await takeSnapshot(ev({ startMs: T0 + 1500 }), r2.deps)
  check('a growing file: waits while the keyframe is half written, then sends it whole',
    got2 !== null && r2.waits.length === 1 && procs.at(-1).input.equals(keyAU(0x54)), `waits ${r2.waits.length}, ${procs.at(-1).input.length} bytes, logs ${r2.logs.join(' | ')}`)
}

// ---- the route --------------------------------------------------------------------------------------------
const fakeRes = () => ({
  status: 0, headers: {}, body: null,
  writeHead(s, h) { this.status = s; this.headers = h; return this },
  end(b) { this.body = b }
})
const call = async (id, who, method = 'GET', deps = { spawn: spawnAs('ok'), platform: 'linux' }) => {
  const res = fakeRes()
  await handleSnapshot({ method }, res, id, who, deps)
  return res
}
const erin = { user: 'erin', admin: false }
const alice = { user: 'alice', admin: true }
const bob = { user: 'bob', admin: false }
const carol = { user: 'carol', admin: false }
const dave = { user: 'dave', admin: false }
// the rows are older than their pictures, as takeSnapshot's always are (it waits for the recording);
// a picture older than its row is an earlier event's (handleSnapshot answers 404)
const SEEN = Date.now() - 60_000
const { event: shown } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0, source: 'test' }, SEEN)
const { event: other } = addEvent({ nvr: 'nvr2', ch: 0, type: 'motion', startMs: T0, source: 'test' }, SEEN)
const { event: bare } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 + 60_000, source: 'test' }, SEEN)
mkdirSync(SNAP_DIR, { recursive: true })
writeFileSync(snapPath(shown.id), JPEG)
writeFileSync(snapPath(other.id), JPEG)
{
  const a = await call(shown.id, alice)
  check('an admin gets the JPEG', a.status === 200 && a.headers['content-type'] === 'image/jpeg' && Buffer.from(a.body).equals(JPEG) && a.headers['content-length'] === String(JPEG.length))
  check('  with the security headers, never cached (the next user of the browser may be allowed less)', a.headers['x-content-type-options'] === 'nosniff' && a.headers['cache-control'] === 'private, no-store')
  check('server playback of that camera is enough', (await call(shown.id, carol)).status === 200)
  check('  but not for another camera', (await call(other.id, carol)).status === 404)
  check('NVR playback of the whole NVR is enough too', (await call(String(shown.id), dave)).status === 200)
  const b = await call(shown.id, bob)
  check('live only: 404, the same as no event at all', b.status === 404 && JSON.parse(b.body).error === 'No picture for that event')
  check('no such event, or no id: 404', (await call(999999, alice)).status === 404 && (await call('abc', alice)).status === 404 && (await call(0, alice)).status === 404)
  const n = await call(bare.id, alice)
  check('an event whose picture is not there (yet): 404, never cached', n.status === 404 && n.headers['cache-control'] === 'no-store')
  const p = await call(shown.id, alice, 'POST')
  check('anything but GET: 405', p.status === 405 && p.headers.allow === 'GET')
}

// ---- the full picture or the SD copy, by right (stream rights) --------------------------------------------
{
  const { event: pic } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 + 120_000, source: 'test' }, SEEN)
  const FULL = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200, 9), Buffer.from([0xff, 0xd9])])
  writeFileSync(snapPath(pic.id), FULL)
  const before = procs.length
  const c = await call(pic.id, carol)
  check('Playback HD: the full picture, no ffmpeg', c.status === 200 && Buffer.from(c.body).equals(FULL) && procs.length === before)
  const e = await call(pic.id, erin)
  check('Playback SD with Live HD (every viewer after the upgrade): the full picture', e.status === 200 && Buffer.from(e.body).equals(FULL) && procs.length === before)
  const d = await call(pic.id, dave)
  const p = procs.at(-1)
  check('Playback SD only: the SD copy, made from the stored picture', d.status === 200 && procs.length === before + 1 && p.input.equals(FULL) && Buffer.from(d.body).equals(JPEG), `${d.status} ${procs.length - before}`)
  check('... at most 704 wide, a JPEG from a JPEG (quoted for the filter parser; no shell)', SD_WIDTH === 704 && p.args.includes("scale='min(704,iw)':-2") && p.args.join(' ').includes('-f image2pipe -c:v mjpeg -i pipe:0') && sdArgs().includes("scale='min(704,iw)':-2"), p.args.join(' '))
  check('... kept beside it as <id>-sd.jpg', existsSync(sdPath(pic.id)) && sdPath(pic.id) === join(SNAP_DIR, `${pic.id}-sd.jpg`))
  check('... never cached by the browser', d.headers['cache-control'] === 'private, no-store')
  await call(pic.id, dave)
  check('asked again: the kept copy, no second ffmpeg', procs.length === before + 1)
  const later = new Date(Date.now() + 60_000)
  utimesSync(snapPath(pic.id), later, later) // the full picture taken again (an event id used again)
  await call(pic.id, dave)
  check('the full picture newer than the copy: the copy is made again', procs.length === before + 2)
  const { event: failPic } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 + 180_000, source: 'test' }, SEEN)
  writeFileSync(snapPath(failPic.id), FULL)
  const f = await call(failPic.id, dave, 'GET', { spawn: spawnAs('fail'), platform: 'linux' })
  check('the copy cannot be made: 404, never the full picture', f.status === 404 && !existsSync(sdPath(failPic.id)), String(f.status))
  const f2 = await call(failPic.id, dave)
  check('... asked again at once: 404 without trying again (for SD_RETRY_MS, 5 minutes)', f2.status === 404 && procs.length === before + 3 && SD_RETRY_MS === 300_000)
  check('live only: still 404, and no ffmpeg for it', (await call(pic.id, bob)).status === 404 && procs.length === before + 3)
  // a picture older than its event's row belonged to an earlier event with the same id (SQLite can
  // hand out a deleted newest row's id again), maybe of another camera
  const { event: reused } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 + 240_000, source: 'test' })
  writeFileSync(snapPath(reused.id), FULL)
  const old = new Date(Date.now() - 600_000)
  utimesSync(snapPath(reused.id), old, old)
  check('a picture older than its event (an id used again): 404 whole and as the SD copy, and no copy made of it', (await call(reused.id, carol)).status === 404 && (await call(reused.id, dave)).status === 404 && procs.length === before + 3 && !existsSync(sdPath(reused.id)))
  const src = readFileSync(new URL('../event-snapshot.mjs', import.meta.url), 'utf8')
  check('the SD copies take turns on a queue of their own, never ahead of or behind a new event\'s picture', /sdOneAtATime\(\(\) => toJpeg\(input, sdArgs\(\)/.test(src) && /= await oneAtATime\(\(\) => toJpeg\(found\.key\.buf, snapArgs\(found\.key\.codec\), o\)\)/.test(src))
  check('sdPath refuses what is not an event id', (() => { try { sdPath('../x'); return false } catch { return true } })())
}

// ---- the SD copy and the picture it was made from (an event id used again while a copy is made, D4) -------
{
  // an ffmpeg that answers only when told (a copy can wait its turn on the queue); its "copy" names its input
  const held = []
  const spawnHeld = () => {
    const p = new EventEmitter()
    p.stdout = new EventEmitter()
    p.stderr = new EventEmitter()
    p.stdin = Object.assign(new EventEmitter(), { end: (buf) => { p.input = Buffer.from(buf); held.push(p) } })
    p.kill = () => p.emit('close', null)
    return p
  }
  const copyOf = (b) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from('sd-copy-of:'), b]) // (a JPEG's first and last bytes)
  const answer = (p) => { p.stdout.emit('data', copyOf(p.input)); p.emit('close', 0) }
  const until = async (pred) => { for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); return pred() }
  const deps = { spawn: spawnHeld, platform: 'linux', timeoutMs: 10_000 }
  const OLD = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(100, 1), Buffer.from([0xff, 0xd9])])
  const NEW = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(100, 2), Buffer.from([0xff, 0xd9])])
  const { event: first } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 + 300_000, source: 'test' }, SEEN)
  writeFileSync(snapPath(first.id), OLD)
  const m1 = new Date(SEEN + 10_000)
  utimesSync(snapPath(first.id), m1, m1)
  const job1 = sdSnapshot(first, deps)
  await until(() => held.length === 1)
  // meanwhile the newest row is deleted and its id handed out again: a new event, seen later, and its picture
  // taken over the old one
  const second = { ...first, seenMs: m1.getTime() + 10_000 }
  writeFileSync(snapPath(first.id), NEW)
  const m2 = new Date(m1.getTime() + 20_000)
  utimesSync(snapPath(first.id), m2, m2)
  const job2 = sdSnapshot(second, deps)
  answer(held[0])
  const got1 = await job1
  check('a copy whose picture was taken again while it was made (an id used again): the request it was made for gets it (that picture was its event\'s when asked)', got1.equals(copyOf(OLD)))
  check('... but it is not kept as <id>-sd.jpg (newer than the new picture, it would be served for the new event)', !existsSync(sdPath(first.id)))
  await until(() => held.length === 2)
  check('the new event\'s request does not join the copy of the old picture: a copy of its own, of the new picture', held.length === 2 && held[1].input.equals(NEW), `${held.length} ffmpeg(s)`)
  if (held[1]) answer(held[1])
  const got2 = await job2
  check('... which it gets, and which is kept', got2.equals(copyOf(NEW)) && existsSync(sdPath(first.id)) && readFileSync(sdPath(first.id)).equals(copyOf(NEW)), got2.subarray(2, 14).toString())
  check('... asked again: that kept copy, no ffmpeg', (await sdSnapshot(second, deps)).equals(copyOf(NEW)) && held.length === 2)
  // the picture removed with its event while its copy was made: no copy left behind for the id
  const { event: gone } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 + 360_000, source: 'test' }, SEEN)
  writeFileSync(snapPath(gone.id), OLD)
  const job3 = sdSnapshot(gone, deps)
  await until(() => held.length === 3)
  forgetSnapshots([gone.id])
  if (held[2]) answer(held[2])
  await job3.catch(() => null)
  check('a picture removed while its copy was made: the copy is not kept', held.length === 3 && !existsSync(sdPath(gone.id)))
}

// ---- pictures go with their events ---------------------------------------------------------------------
{
  forgetSnapshots([shown.id, 'x', -1, null])
  check('forgetSnapshots removes the pictures named, skipping what is not an id', !existsSync(snapPath(shown.id)) && existsSync(snapPath(other.id)))
  forgetSnapshots([shown.id])
  check('  a picture already gone is fine', true)

  writeFileSync(snapPath(424242), JPEG) // an event that is no longer in the database
  const stale = join(SNAP_DIR, '77.jpg.123.tmp')
  const fresh = join(SNAP_DIR, '78.jpg.123.tmp')
  writeFileSync(stale, 'x')
  writeFileSync(fresh, 'x')
  const old = new Date(Date.now() - 2 * 3_600_000)
  utimesSync(stale, old, old)
  writeFileSync(join(SNAP_DIR, 'readme.txt'), 'not a picture')
  writeFileSync(sdPath(424243), JPEG) // an SD copy whose event is gone (its full picture already went)
  writeFileSync(sdPath(other.id), JPEG)
  const { removed } = await sweepSnapshots()
  check('sweepSnapshots: a picture whose event is gone is removed, one whose event is there stays',
    !existsSync(snapPath(424242)) && existsSync(snapPath(other.id)) && removed >= 1, `removed ${removed}`)
  check('  an old temp file is removed, a fresh one (a write in progress) stays, other files stay', !existsSync(stale) && existsSync(fresh) && existsSync(join(SNAP_DIR, 'readme.txt')))
  const kept = await sweepSnapshots({ exists: () => { throw new Error('database locked') } })
  check('  events that cannot be read: nothing removed, nothing thrown', kept.removed === 0 && existsSync(snapPath(other.id)))
  check('sweepSnapshots: an SD copy goes with its event, and stays while the event is there', !existsSync(sdPath(424243)) && existsSync(sdPath(other.id)))
  forgetSnapshots([other.id])
  check('forgetSnapshots removes the SD copy with the picture', !existsSync(sdPath(other.id)) && !existsSync(snapPath(other.id)))
}

closeEvents()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
