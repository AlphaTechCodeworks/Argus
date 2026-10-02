// Tests for what server playback (rec-playback.mjs ServerPlayback) says and logs when it waits, and for
// the next file being opened ahead of need. The playback hunt of 1 Oct 2026 (finding F9, probe
// sim-slowfile.mjs) showed the real class on two temp files joined at 19:55:00, the second slow to open:
// the socket got `started` and nothing more, and the journal's one line read "idx 5 ms, first frame 6 ms".
//   waiting     {type:'waiting'} once the pacer has had nothing to send for 2 s while playing, a log line
//               naming the file, {type:'playing'} before the next frame, and the close line's figures
//   ahead       the next file is opened when the one playing opens, not 3 s before its end; the whole-file
//               read-ahead stays one file ahead
//   next        footage with pictures seconds apart (time-lapse) says when the next one is due
//   stale       an error from a read nobody needs any more is logged, not dropped
// Temp dirs, a temp index and a fake WebSocket only: nothing reaches an NVR or a share.
// Run:  node cctv/test/rec-playback-wait.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rec-pbw-'))
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ a: { hash: 'x', role: 'admin' } }))

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}\n`)
}
const J = (v) => JSON.stringify(v)
const s1 = (ms) => (ms / 1000).toFixed(2)

const { SegmentWriter } = await import('../segment-writer.mjs')
const { openRecIndex } = await import('../rec-index.mjs')
const { ServerPlayback } = await import('../rec-playback.mjs')

const ROOT = mkdtempSync(join(tmpdir(), 'rec-pbw-loc-'))
const IDX = openRecIndex(join(process.env.DATA_DIR, 'recordings.db'))
const NVR = { id: 'n1', online: true, playback: { lastClock: () => ({ tzOffsetMs: 0, skewMs: 0 }) } }

// synthetic H.264-shaped frames, 20 a second, a keyframe every 2 s (as the hunt's probe made them)
const SC4 = Buffer.from([0, 0, 0, 1])
const SC3 = Buffer.from([0, 0, 1])
const body = (n, seed) => {
  const b = Buffer.alloc(n, 0x55)
  b[0] = 0x80 | (seed & 0x7f)
  return b
}
const key = (i) => Buffer.concat([SC4, Buffer.from([0x67, 0x64]), body(12, i), SC3, Buffer.from([0x68]), body(4, i), SC3, Buffer.from([0x65, 0x88]), body(2000, i)])
const delta = (i) => Buffer.concat([SC4, Buffer.from([0x41, 0x9a]), body(400, i)])
const frames = (t0, n) => Array.from({ length: n }, (_, i) => ({ ts: t0 + i * 50, isKey: i % 40 === 0, buf: i % 40 === 0 ? key(i) : delta(i) }))

/** Records each group as a file of its own (real SegmentWriter) and indexes them. */
async function record(ch, groups) {
  const w = new SegmentWriter({ root: ROOT, nvrId: NVR.id, ch, codec: 'h264' })
  const segs = []
  w.on('segment', (s) => segs.push(s))
  for (const g of groups) {
    for (const f of g) {
      w.write(f.buf, { isKey: f.isKey, ts: f.ts })
      if (w.queueStatus().queuedBytes > 1 << 20) await w.drained()
    }
    await w.close()
  }
  for (const s of segs) IDX.addSegment({ nvr: NVR.id, ch, ...s, loc: 'L1' })
  return segs
}

/** node:fs/promises where opening any path that starts with `slow` takes delayMs; opens are counted by path. */
function slowFs(slow, delayMs, opens = []) {
  return {
    opens,
    async open(path, flags) {
      opens.push(String(path))
      if (slow && String(path).startsWith(slow)) await sleep(delayMs)
      return fsp.open(path, flags)
    }
  }
}

/** A session on a fake socket: what it was sent (frames and texts, with their arrival), and what it logged. */
function play(ch, start, opts = {}) {
  const t0 = performance.now()
  const at = () => performance.now() - t0
  const r = { sent: [], texts: [], logs: [], ahead: [], t0 }
  r.ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    handlers: {},
    on(e, f) { this.handlers[e] = f },
    send(m) {
      if (typeof m === 'string') r.texts.push({ at: at(), ...JSON.parse(m) })
      else r.sent.push({ at: at(), ts: Number(m.readBigInt64LE(8)) / 1000, bytes: m.length })
    },
    close(code, reason) {
      if (this.readyState !== 1) return
      this.readyState = 3
      this.handlers.close?.(code, Buffer.from(reason ?? ''))
    },
    command(o) { this.handlers.message?.(Buffer.from(J(o)), false) }
  }
  r.session = new ServerPlayback({ ws: r.ws, nvr: NVR, ch, start, index: IDX, readAhead: (p) => r.ahead.push(p), log: (l) => r.logs.push({ at: at(), l }), ...opts })
  r.text = (type) => r.texts.find((m) => m.type === type)
  r.all = (type) => r.texts.filter((m) => m.type === type)
  /** The longest time with no frame sent, from the first frame to `until` ms (or the last frame). */
  r.silence = (until = null) => {
    let longest = 0
    const end = until ?? r.sent.at(-1)?.at ?? 0
    for (let i = 1; i <= r.sent.length; i++) {
      const a = r.sent[i - 1].at
      const b = i < r.sent.length ? r.sent[i].at : end
      if (a < end) longest = Math.max(longest, Math.min(b, end) - a)
    }
    return longest
  }
  return r
}

// 19:54:40-19:55:00 and 19:55:00-19:55:40, as in the probe (the owner's second session of 30 Sep began at
// 19:54:58.650, 1.35 s before file 19-55)
const T0 = Date.UTC(2026, 8, 30, 19, 54, 40)
const camA = await record(0, [frames(T0, 400), frames(T0 + 20_000, 800)])
const camB = await record(1, [frames(T0, 400), frames(T0 + 20_000, 400), frames(T0 + 40_000, 400)])
const camC = await record(2, [frames(T0, 400), frames(T0 + 20_000, 400)])
const camD = await record(3, [frames(T0, 100)])
const camE = await record(4, [frames(T0, 400), frames(T0 + 20_000, 800)])
// camera 5: a picture every 3 s, all keyframes (what time-lapse thinning leaves, thin-file.mjs planThin)
const T5 = Date.UTC(2026, 8, 20, 10, 0, 5)
const camF = await record(5, [Array.from({ length: 6 }, (_, i) => ({ ts: T5 + i * 3000, isKey: true, buf: key(i) }))])
const camG = await record(6, [frames(T0, 400), frames(T0 + 20_000, 400)])
check('footage: two files joined at 19:55:00 (three on camera 2)', camA.length === 2 && camB.length === 3 && camC.length === 2 && camE.length === 2 && camF.length === 1 && camG.length === 2 && camA[1].startMs === T0 + 20_000, `${camA.length} ${camB.length} ${camC.length} ${camF.length}`)
const JOIN = T0 + 20_000

// The cases run side by side (each on a camera of its own): 13 s of waiting once, not once each.
await Promise.all([
  // ---- the probe, as a test: the second file takes 6 s to open (3 s the data file, 3 s its .idx) ----
  (async () => {
    const start = JOIN - 1350
    const fs = slowFs(camA[1].path, 3000)
    const p = play(0, start, { fs })
    await sleep(4200)
    const last = p.sent.at(-1)
    const w = p.text('waiting')
    check('slow next file: frames up to the join, then nothing (the second file is still opening)', p.sent.length > 20 && last.ts < JOIN && last.ts > JOIN - 100, `${p.sent.length} frames, the last ${s1(JOIN - (last?.ts ?? 0))} s of footage before the join, sent at ${s1(last?.at ?? 0)} s`)
    check('  the page is told {type:"waiting"} within 2.5 s of the last frame, not before 2 s', Boolean(w) && w.at - last.at >= 1950 && w.at - last.at <= 2500, w ? `${s1(w.at - last.at)} s after the last frame` : J(p.texts.map((t) => t.type)))
    check('  with why, in words, and what it waits on', typeof w?.why === 'string' && /recording store/i.test(w.why) && w.on === 'store', J(w))
    check('  said once, not at every tick', p.all('waiting').length === 1, `${p.all('waiting').length}`)
    const line = p.logs.find((x) => /nothing to send/.test(x.l))
    check('  a log line at that moment names the file and the wait', Boolean(line) && line.l.includes(camA[1].path) && /nothing to send for 2\.\d s/.test(line.l) && /^\[n1\] server playback ch1: /.test(line.l) && Math.abs(line.at - w.at) < 100, line?.l ?? p.logs.map((x) => x.l).join(' | '))
    await sleep(3300) // (the opens end 6 s after they began)
    const iPlaying = p.texts.findIndex((m) => m.type === 'playing')
    const next = p.sent.find((f) => f.at > last.at + 1000)
    check('  when the file has opened the frames go on from the join, none lost', Boolean(next) && Math.abs(next.ts - JOIN) < 60 && p.sent.every((f, i) => i === 0 || f.ts > p.sent[i - 1].ts) && p.sent.filter((f) => f.ts >= start).every((f, i, a) => i === 0 || f.ts - a[i - 1].ts < 60), next ? `first after the wait: ${s1(next.ts - JOIN)} s from the join, sent at ${s1(next.at)} s` : 'no frame after the wait')
    check('  {type:"playing"} comes before the first of them, with how long the wait was', iPlaying >= 0 && p.texts[iPlaying].at <= next.at && p.texts[iPlaying].waitedMs > 3500 && p.texts[iPlaying].waitedMs < 6500, J(p.texts[iPlaying]))
    const back = p.logs.find((x) => /playing again/.test(x.l))
    check('  and a log line says how long it was', Boolean(back) && /playing again after [3-6]\.\d s/.test(back.l), back?.l)
    check('  the second file was opened once (its data file and its .idx), not once ahead and once at need', fs.opens.filter((o) => o.startsWith(camA[1].path)).length === 2, J(fs.opens.filter((o) => o.startsWith(camA[1].path)).length))
    p.ws.close(1000, 'viewer left')
    await sleep(50)
    const end = p.logs.at(-1).l
    check('close line: the start timings as before, then what the session did', /^\[n1\] server playback ch1 from 2026-09-30T19:54:58\.650Z: index \d+ ms, idx \d+ ms, first frame \d+ ms; /.test(end), end)
    check('  local or remote, the frames and bytes sent, the queue in node, the close code, the longest wait', new RegExp(`; local viewer, ${p.sent.length} frames \\(\\d+\\.\\d\\d MB\\) sent, 0\\.00 MB queued in node at the end \\(0\\.00 at most\\), closed with code 1000 "viewer left", longest wait [3-6]\\.\\d s$`).test(end), end)
    const bytes = p.sent.reduce((n, f) => n + f.bytes, 0)
    check('  the bytes are those of the frames', end.includes(`(${(bytes / 1e6).toFixed(2)} MB)`), `${(bytes / 1e6).toFixed(2)} MB sent`)
  })(),

  // ---- the next file is opened when the one playing opens, not 3 s before its end -----------------
  (async () => {
    // 8 s before the join, and the second file takes 5 s to open: asked for 3 s before the join it was
    // ready 2 s late; asked for at the start it is ready 3 s early
    const start = JOIN - 8000
    const fs = slowFs(camB[1].path, 2500)
    const p = play(1, start, { fs })
    await sleep(1000)
    check('next file ahead: asked for as soon as the first file is playing', fs.opens.some((o) => o === camB[1].path), J(fs.opens.map((o) => o.slice(-14))))
    check('  the whole-file read-ahead is the next file only, as before', J(p.ahead) === J([camB[1].path]), J(p.ahead.map((a) => a.slice(-10))))
    await sleep(9000)
    const first2 = p.sent.find((f) => f.ts >= JOIN)
    check('  a next file that takes 5 s to open: no pause at the join', Boolean(first2) && p.silence() < 300, `longest time without a frame ${s1(p.silence())} s; first frame of the second file at ${s1(first2?.at ?? 0)} s`)
    check('  nothing said, nothing logged: there was no wait', p.all('waiting').length === 0 && p.all('playing').length === 0 && !p.logs.some((x) => /nothing to send/.test(x.l)), J(p.texts.map((t) => t.type)))
    check('  every frame of both files, in order', p.sent.filter((f) => f.ts >= start).every((f, i, a) => i === 0 || (f.ts > a[i - 1].ts && f.ts - a[i - 1].ts < 60)))
    check('  the second file was opened once', fs.opens.filter((o) => o.startsWith(camB[1].path)).length === 2, `${fs.opens.filter((o) => o.startsWith(camB[1].path)).length} opens`)
    check('  the third is opened ahead once the second plays, and read ahead only then: never two whole files ahead', fs.opens.some((o) => o === camB[2].path) && J(p.ahead) === J([camB[1].path, camB[2].path]), J(p.ahead.map((a) => a.slice(-10))))
    p.session.close()
    await sleep(100)
    p.ws.readyState = 3
  })(),

  // ---- a next file that cannot be opened ahead is skipped at need, as before ----------------------
  (async () => {
    const gone = camC[1].path
    const opens = []
    const fs = {
      async open(path, flags) {
        opens.push(String(path))
        if (String(path).startsWith(gone)) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' })
        return fsp.open(path, flags)
      }
    }
    const p = play(2, JOIN - 1500, { fs, endGraceMs: 600 })
    await sleep(3000)
    check('a next file that is gone: nothing fails while the one before it plays; skipped at need, logged once', p.logs.filter((x) => /ENOENT, skipped/.test(x.l)).length === 1 && !p.text('error') && p.ws.readyState === 1 && p.text('end')?.newest === true, `${J(p.texts.map((t) => t.type))} | ${p.logs.map((x) => x.l).join(' | ')}`)
    p.session.close()
  })(),

  // ---- the end of the footage: waiting, then the end --------------------------------------------
  (async () => {
    const p = play(3, T0 + 3500, { endGraceMs: 4500 })
    await sleep(5000)
    const w = p.text('waiting')
    const end = p.text('end')
    const last = p.sent.at(-1)
    check('end of the footage: {type:"waiting"} for the next recording after 2 s, then {type:"end"} as before', Boolean(w) && w.on === 'newest' && /next recording/i.test(w.why) && w.at - last.at >= 1950 && end?.newest === true && end.at > w.at, J(p.texts))
    check('  no {type:"playing"} without a frame, and nothing more after the end', p.all('playing').length === 0 && p.all('waiting').length === 1, J(p.texts.map((t) => t.type)))
    p.session.close()
  })(),

  // ---- a paused session waits for nobody; a slow link is logged, not said ---------------------------
  (async () => {
    const fs = slowFs(camE[1].path, 2500)
    const p = play(4, JOIN - 1000, { fs })
    await sleep(300)
    p.ws.command({ pause: true })
    await sleep(2700)
    check('paused: nothing is said and nothing logged, however long the next file takes', p.all('waiting').length === 0 && !p.logs.some((x) => /nothing to send/.test(x.l)), J(p.texts.map((t) => t.type)))
    p.session.close()
    // the socket backs up over pauseAbove: the reader stops, the pacer runs dry. The viewer's own link.
    const q = play(4, T0 + 1000, { readAheadMs: 500 })
    await sleep(300)
    q.ws.bufferedAmount = 9 * 1024 * 1024
    await sleep(3200)
    const line = q.logs.find((x) => /nothing to send/.test(x.l))
    check('the socket backed up (9 MB queued in node): logged, with the queue', Boolean(line) && /9\.44 MB queued/.test(line.l) && /link/.test(line.l), line?.l ?? q.logs.map((x) => x.l).join(' | '))
    check('  not said to the page: the message would only queue behind the video', q.all('waiting').length === 0, J(q.texts.map((t) => t.type)))
    q.ws.close(1006, '')
    await sleep(30)
    check('  the close line has the queue and the code', /9\.44 MB queued in node at the end \(9\.44 at most\), closed with code 1006, longest wait \d+\.\d s$/.test(q.logs.at(-1).l), q.logs.at(-1).l)
  })(),

  // ---- pictures seconds apart: the page is told when the next one is due -----------------------------
  (async () => {
    const p = play(5, T5 + 100)
    await sleep(7000)
    const nx = p.all('next')
    check('a picture every 3 s (time-lapse): each goes at its time', p.sent.length === 3 && Math.abs(p.sent[1].at - p.sent[0].at - 2900) < 250 && Math.abs(p.sent[2].at - p.sent[1].at - 3000) < 250, p.sent.map((f) => s1(f.at)).join(' '))
    check('  {type:"next", inMs} after each: the page is not waiting, the next picture is that far off', nx.length >= 2 && nx.every((m) => m.inMs > 1000 && m.inMs <= 3000) && Math.abs(nx[0].inMs - 2900) < 200 && nx[0].at >= p.sent[0].at && nx[0].at - p.sent[0].at < 200, J(nx))
    check('  and no {type:"waiting"}: the pacer has its next picture', p.all('waiting').length === 0 && !p.logs.some((x) => /nothing to send/.test(x.l)), J(p.texts.map((t) => t.type)))
    p.session.close()
  })(),

  // ---- an error from a read nobody needs any more ---------------------------------------------------
  (async () => {
    const bad = camG[1].path
    const fs = {
      async open(path, flags) {
        if (String(path) === bad) {
          await sleep(400)
          throw Object.assign(new Error(`EIO: i/o error, open '${path}'`), { code: 'EIO' })
        }
        return fsp.open(path, flags)
      }
    }
    // a start in the second file hangs on its open; a seek into the first makes that read stale
    const p = play(6, JOIN + 5000, { fs })
    await sleep(100)
    p.ws.command({ seek: T0 + 2000, gen: 1 })
    await sleep(900)
    const line = p.logs.find((x) => /no longer needed/.test(x.l))
    check('a read that failed after a seek made it stale: logged with what the system said', Boolean(line) && /EIO/.test(line.l) && /^\[n1\] server playback ch7: /.test(line.l), p.logs.map((x) => x.l).join(' | '))
    check('  the session is not failed by it: the seek plays', p.ws.readyState === 1 && !p.text('error') && p.texts.some((m) => m.type === 'started' && m.gen === 1) && p.sent.length > 5, J(p.texts.map((t) => t.type)))
    p.session.close()
  })()
])

// ---- a session that fails closes with its own code in the line -------------------------------------
{
  const fs = { open: async (path) => { throw Object.assign(new Error(`EIO: i/o error, open '${path}'`), { code: 'EIO' }) } }
  const p = play(0, T0 + 1000, { fs, remote: true, original: true })
  await sleep(200)
  check('a failed session: the close line says remote, no frames, and the code it closed with', /; remote viewer, 0 frames \(0\.00 MB\) sent, .*closed with code 1011 "playback failed", longest wait 0\.\d s$/.test(p.logs.at(-1)?.l ?? ''), p.logs.map((x) => x.l).join(' | '))
}

// ---- a conversion's lag in the close line -----------------------------------------------------------
{
  // a converter stand-in that hands each picture back 300 ms after it was given it
  const makeTranscoder = (o) => ({
    inCodec: o.inCodec,
    push: (ts, isKey, buf) => setTimeout(() => o.onFrame(ts, isKey, buf.subarray(0, 8)), 300),
    endPicture() {},
    reset() {},
    close() {}
  })
  const p = play(0, T0 + 1000, { remote: true, fitAboveKbps: 0, pool: { active: 0, max: 2, acquire: () => ({ release() {} }) }, makeTranscoder })
  await sleep(1500)
  p.ws.close(1001, '')
  await sleep(30)
  const end = p.logs.at(-1).l
  const m = /conversion (\d+) ms behind at the end \((\d+) at most\)$/.test(end) ? end.match(/conversion (\d+) ms behind at the end \((\d+) at most\)$/) : null
  check('a converted session: the close line ends with how far the conversion was behind (footage in, not yet out)', Boolean(m) && Number(m[1]) >= 200 && Number(m[1]) <= 450 && Number(m[2]) >= Number(m[1]), end)
}

// ---- the keep-alive: quiet() only once no frame has gone out for quietMs (F5; server.mjs) ----------
// The patient keep-alive cuts a /playback socket only when it has made no progress for ~30 s, not on
// one missed pong (a socket through the tunnel answers its ping late behind its own backlog).
{
  const p = play(4, JOIN - 1000, { quietMs: 400 })
  await sleep(200)
  check('keep-alive: while frames are going out it is not quiet (not to be cut)', p.sent.length > 2 && p.session.quiet() === false, `${p.sent.length} frames, quiet ${p.session.quiet()}`)
  p.ws.command({ pause: true })
  await sleep(550) // > quietMs with no frame
  check('  no frame for quietMs: quiet (a dead socket would now be cut)', p.session.quiet() === true)
  p.ws.command({ pause: false })
  await sleep(200)
  check('  playing again: not quiet', p.session.quiet() === false)
  p.session.close()
}

IDX.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
