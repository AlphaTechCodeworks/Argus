// Tests for backfill.mjs (phase 2b: gap backfill from the NVRs).
//
//   ranges          mergeRanges / complement / intersect / chunkRanges
//   findGaps        holes from the segments, reasons borrowed from the recorder's gap rows, holes
//                   nothing explains reported as 'unknown', the tail and the pre-history left alone
//   gapPlan         older than the NVR keeps -> permanent; the NVR has nothing -> permanent;
//                   "we could not ask" -> NOT decided (never recorded as filled or as permanent)
//   scheduling      the off-peak window (including one that wraps midnight), msUntilWindow,
//                   the rate limit, the backoff ladders, nvrReady, chooseGap (deadline first, one
//                   camera per NVR, backoffs), mayRun (live recording and exports win)
//   the ledger      rec-index.mjs backfill_gaps: note/list/set, a hole seen twice keeps its state
//   the job         scan(), fill() against fake NVRs and a real SegmentWriter: real segments and
//                   real .idx files land at the right times and are indexed as backfilled; a refusal
//                   backs off hard and does not retry; an unknown answer leaves the row pending;
//                   a restart picks up where it left off
//   the routes      handleBackfill: admin only, methods, GET/run/stop
//
// Temp dirs, a temp index, fake NVRs and a fake leg only: nothing reaches an NVR and nothing here
// imports the SDK, so it runs on Windows.
// Run:  node cctv/test/backfill.test.mjs
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'backfill-'))
process.env.DATA_DIR = DATA
// one admin and one ordinary user, so the route checks are real (auth.mjs reads this file)
writeFileSync(join(DATA, 'users.json'), JSON.stringify({ boss: { role: 'admin', hash: 'x' }, bob: { role: 'viewer', hash: 'x' } }))

let failures = 0
let checks = 0
const check = (n, ok, e = '') => {
  checks++
  if (!ok) failures++
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}\n`)
}
const J = (v) => JSON.stringify(v)

const { openRecIndex } = await import('../rec-index.mjs')
const { SegmentWriter, parseIdx } = await import('../segment-writer.mjs')
let bf = {}
try {
  bf = await import('../backfill.mjs')
} catch (e) {
  check('load ../backfill.mjs', false, e.message)
  console.log('\n1 failed')
  process.exit(1)
}
const { BackfillJob, PERMANENT, backoffMs, chooseGap, chunkRanges, complement, findGaps, gapPlan, handleBackfill, initBackfill, inWindow, intersect, mayRun, mergeRanges, msUntilWindow, nvrReady, parseHhmm, restAfterMs, writerSink } = bf

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
// a fixed "now" on a round hour, so nothing in these tests depends on when they are run
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0)

// ---- ranges ------------------------------------------------------------------------------------

check('mergeRanges sorts and merges', J(mergeRanges([[30, 40], [0, 10], [11, 20]], 0)) === J([[0, 10], [11, 20], [30, 40]]))
 check('mergeRanges joins across a seam within joinMs', J(mergeRanges([[0, 10], [11, 20]], 2000)) === J([[0, 20]]))
check('mergeRanges drops nonsense (NaN, end before start)', J(mergeRanges([[5, 4], [Number.NaN, 9], [1, 2]])) === J([[1, 2]]))
check('mergeRanges never mutates its input', (() => { const a = [[5, 6], [1, 2]]; mergeRanges(a); return a[0][0] === 5 })())
check('complement of nothing is the whole window', J(complement([], 0, 100)) === J([[0, 100]]))
check('complement finds the hole between two stretches', J(complement([[0, 10], [20, 30]], 0, 30)) === J([[10, 20]]))
check('complement clips to the window', J(complement([[0, 10]], 5, 40)) === J([[10, 40]]))
check('intersect keeps only the overlap', J(intersect([[0, 10], [20, 30]], [[5, 25]])) === J([[5, 10], [20, 25]]))
check('intersect of disjoint lists is empty', J(intersect([[0, 5]], [[10, 20]])) === J([]))
check('chunkRanges cuts long stretches, keeps short ones whole', J(chunkRanges([[0, 25], [100, 105]], 10)) === J([[0, 10], [10, 20], [20, 25], [100, 105]]))

// ---- findGaps ----------------------------------------------------------------------------------

const seg = (s, e) => ({ startMs: s, endMs: e })
{
  // an hour of footage, five minutes missing in the middle
  const segments = [seg(NOW - 10 * HOUR, NOW - 9 * HOUR), seg(NOW - 9 * HOUR + 5 * MIN, NOW - 8 * HOUR)]
  const gaps = findGaps({ segments, now: NOW, nvr: 'nvr-1', ch: 3 })
  check('findGaps: one hole between two stretches', gaps.length === 1 && gaps[0].durationMs === 5 * MIN, J(gaps))
  check('findGaps: the hole carries the camera and its age', gaps[0]?.nvr === 'nvr-1' && gaps[0]?.ch === 3 && gaps[0]?.ageMs === 9 * HOUR - 5 * MIN)
  check('findGaps: with no recorder row the hole is unknown, not guessed at', gaps[0]?.kind === 'unknown' && gaps[0]?.reason === null)
}
{
  const segments = [seg(NOW - 10 * HOUR, NOW - 9 * HOUR), seg(NOW - 9 * HOUR + 5 * MIN, NOW - 8 * HOUR)]
  const gapRows = [{ fromMs: NOW - 9 * HOUR, toMs: NOW - 9 * HOUR + 5 * MIN, reason: 'refused by the NVR (no reason given)' }]
  const gaps = findGaps({ segments, gapRows, now: NOW })
  check('findGaps: a recorder row that explains the hole gives it its reason', gaps[0]?.kind === 'recorder' && gaps[0]?.reason === 'refused by the NVR (no reason given)', J(gaps))
}
{
  // a 2 s row against a 5 min hole explains nothing: saying "refused" here would be a lie
  const segments = [seg(NOW - 10 * HOUR, NOW - 9 * HOUR), seg(NOW - 9 * HOUR + 5 * MIN, NOW - 8 * HOUR)]
  const gapRows = [{ fromMs: NOW - 9 * HOUR, toMs: NOW - 9 * HOUR + 2000, reason: 'disk too slow' }]
  const gaps = findGaps({ segments, gapRows, now: NOW })
  check('findGaps: a row covering a sliver of the hole does not get to name it', gaps[0]?.kind === 'unknown' && gaps[0]?.reason === null, J(gaps))
}
{
  const segments = [seg(NOW - 10 * HOUR, NOW - 9 * HOUR), seg(NOW - 9 * HOUR + 30 * MIN, NOW - 8 * HOUR)]
  const gapRows = [
    { fromMs: NOW - 9 * HOUR, toMs: NOW - 9 * HOUR + 20 * MIN, reason: 'camera offline' },
    { fromMs: NOW - 9 * HOUR + 20 * MIN, toMs: NOW - 9 * HOUR + 30 * MIN, reason: 'no video from the NVR' }
  ]
  const gaps = findGaps({ segments, gapRows, now: NOW })
  check('findGaps: two rows over one hole are both named, longest first', gaps[0]?.reason === 'camera offline; no video from the NVR', J(gaps[0]))
}
{
  const segments = [seg(NOW - 10 * HOUR, NOW - 9 * HOUR), seg(NOW - 9 * HOUR + 1500, NOW - 8 * HOUR)]
  check('findGaps: a 1.5 s seam is not a hole (JOIN_MS)', findGaps({ segments, now: NOW }).length === 0)
  check('findGaps: minGapMs is honoured', findGaps({ segments: [seg(0, 1000), seg(6000, 9000)], now: 10 * DAY, minGapMs: 10_000, tailMs: 0 }).length === 0)
}
{
  // footage stops an hour ago: that is the recorder's business, not a hole to backfill
  const segments = [seg(NOW - 10 * HOUR, NOW - HOUR)]
  check('findGaps: nothing after the last segment is a hole', findGaps({ segments, now: NOW }).length === 0)
  const withTail = findGaps({ segments: [seg(NOW - 10 * HOUR, NOW - 3 * HOUR), seg(NOW - 2 * HOUR, NOW - MIN)], now: NOW })
  check('findGaps: a hole inside the tail is left to the live fallback', withTail.length === 0, J(withTail))
}
check('findGaps: a camera with no footage has no holes, only no history', findGaps({ segments: [], gapRows: [{ fromMs: 0, toMs: DAY, reason: 'x' }], now: NOW }).length === 0)
{
  const segments = [seg(NOW - 10 * HOUR, NOW - 9 * HOUR), seg(NOW - 8 * HOUR, NOW - 7 * HOUR), seg(NOW - 6 * HOUR, NOW - 5 * HOUR)]
  const gaps = findGaps({ segments, now: NOW })
  check('findGaps: several holes come back oldest first', gaps.length === 2 && gaps[0].fromMs < gaps[1].fromMs, J(gaps.map((g) => g.durationMs)))
}

// ---- gapPlan -----------------------------------------------------------------------------------

const RET = 30 * DAY
{
  const old = { fromMs: NOW - 40 * DAY, toMs: NOW - 39 * DAY }
  const p = gapPlan(old, { now: NOW, nvrRetentionMs: RET })
  check('gapPlan: older than the NVR keeps is permanent, without asking', p.permanent && p.permanentReason === PERMANENT.aged && p.decided)
}
{
  const g = { fromMs: NOW - 2 * DAY, toMs: NOW - 2 * DAY + 5 * MIN }
  check('gapPlan: not asked yet is not a decision', gapPlan(g, { now: NOW, nvrRetentionMs: RET }).decided === false)
  const busy = gapPlan(g, { now: NOW, nvrRetentionMs: RET, coverage: { ranges: [], reason: 'the NVR is busy' } })
  check('gapPlan: "we could not ask" is never recorded as permanent', busy.decided === false && busy.permanent === false && busy.why === 'the NVR is busy')
  const nothing = gapPlan(g, { now: NOW, nvrRetentionMs: RET, coverage: { ranges: [] } })
  check('gapPlan: the NVR answering "nothing there" is permanent', nothing.decided && nothing.permanent && nothing.permanentReason === PERMANENT.nothing)
  const part = gapPlan(g, { now: NOW, nvrRetentionMs: RET, coverage: { ranges: [[g.fromMs + MIN, g.fromMs + 2 * MIN]] } })
  check('gapPlan: the work is the overlap of the hole and what the NVR has', part.decided && !part.permanent && J(part.work) === J([[g.fromMs + MIN, g.fromMs + 2 * MIN]]))
}

// ---- scheduling --------------------------------------------------------------------------------

check('parseHhmm reads a time of day', parseHhmm('01:00') === 60 && parseHhmm('23:59') === 1439)
check('parseHhmm refuses rubbish', parseHhmm('24:00') === null && parseHhmm('1:00') === null && parseHhmm('') === null)
check('inWindow: inside 01:00-05:00', inWindow(60, '01:00', '05:00') && inWindow(299, '01:00', '05:00'))
check('inWindow: the end is exclusive', !inWindow(300, '01:00', '05:00') && !inWindow(59, '01:00', '05:00'))
check('inWindow: a window across midnight wraps', inWindow(23 * 60, '22:00', '04:00') && inWindow(30, '22:00', '04:00') && !inWindow(12 * 60, '22:00', '04:00'))
check('inWindow: an empty window is never open', !inWindow(60, '01:00', '01:00'))
{
  // msUntilWindow uses the local clock, so it is tested against a local time built here
  const at = (h, m) => new Date(2026, 0, 15, h, m, 0).getTime()
  check('msUntilWindow is 0 while the window is open', msUntilWindow(at(2, 0), '01:00', '05:00') === 0)
  check('msUntilWindow counts to the next opening', msUntilWindow(at(23, 0), '01:00', '05:00') === 2 * HOUR)
  check('msUntilWindow from just after closing is nearly a day', msUntilWindow(at(5, 30), '01:00', '05:00') === 19.5 * HOUR)
}
check('restAfterMs waits out the rate limit', restAfterMs(1e6, 0, 8, 0) === 1000)
check('restAfterMs counts the time already spent', restAfterMs(1e6, 600, 8, 0) === 400)
check('restAfterMs adds the fixed rest and never goes negative', restAfterMs(1000, 60_000, 8, 30) === 30_000)
check('backoffMs doubles and stops at the ceiling', backoffMs(1, [10, 80]) === 10 && backoffMs(3, [10, 80]) === 40 && backoffMs(9, [10, 80]) === 80)

check('nvrReady: an offline NVR is not asked', nvrReady({ online: false }, NOW).ok === false)
check('nvrReady: a degraded NVR is not asked', nvrReady({ online: true, degraded: true }, NOW).why === 'the NVR is busy recovering')
check('nvrReady: a cooling NVR is not asked', nvrReady({ online: true, cooling: true }, NOW).why === 'the NVR is cooling down after late calls')
check('nvrReady: an NVR refusing streams is not asked', nvrReady({ online: true, refusing: true }, NOW).why === 'the NVR is refusing streams')
check('nvrReady: an NVR inside its backoff is not asked', nvrReady({ online: true, busyUntil: NOW + 1000 }, NOW).ok === false)
check('nvrReady: a healthy NVR is asked', nvrReady({ online: true }, NOW).ok === true)

{
  const nvrs = new Map([['nvr-1', { online: true }], ['nvr-2', { online: true, refusing: true }]])
  const retentionMsOf = () => RET
  const rows = [
    { id: 1, nvr: 'nvr-1', ch: 0, fromMs: NOW - 2 * DAY, toMs: NOW - 2 * DAY + MIN, state: 'pending' },
    { id: 2, nvr: 'nvr-1', ch: 1, fromMs: NOW - 29 * DAY, toMs: NOW - 29 * DAY + 10 * MIN, state: 'pending' },
    { id: 3, nvr: 'nvr-2', ch: 0, fromMs: NOW - 28 * DAY, toMs: NOW - 28 * DAY + MIN, state: 'pending' }
  ]
  const pick = chooseGap(rows, { now: NOW, nvrs, retentionMsOf })
  check('chooseGap: the gap the NVR loses soonest goes first', pick.row?.id === 2, J(pick))
  check('chooseGap: an NVR refusing streams is skipped, not retried', chooseGap([rows[2]], { now: NOW, nvrs, retentionMsOf }).why === 'the NVR is refusing streams')
  check('chooseGap: one camera at a time per NVR', chooseGap(rows, { now: NOW, nvrs, retentionMsOf, busyNvrs: new Set(['nvr-1']) }).row === null)
  check('chooseGap: a row inside its backoff waits', chooseGap([{ ...rows[0], nextTryMs: NOW + 1000 }], { now: NOW, nvrs, retentionMsOf }).why === 'waiting out a backoff')
  check('chooseGap: filled and permanent rows are never picked', chooseGap(rows.map((r) => ({ ...r, state: 'permanent' })), { now: NOW, nvrs, retentionMsOf }).row === null)
  check('chooseGap: a gap already past the NVR retention is skipped', chooseGap([{ ...rows[0], fromMs: NOW - 40 * DAY, toMs: NOW - 39 * DAY }], { now: NOW, nvrs, retentionMsOf }).why === 'older than the NVR still keeps')
  const short = chooseGap([{ ...rows[1], id: 4, toMs: NOW - 29 * DAY + 2 * MIN }, rows[1]], { now: NOW, nvrs, retentionMsOf })
  check('chooseGap: with the same deadline the shorter gap goes first', short.row?.id === 4)
}
{
  const cfg = { enabled: true, windowStart: '00:00', windowEnd: '23:59' }
  check('mayRun: live recording wins', mayRun({ now: NOW, cfg, running: true, recordingBusy: true }).why === 'live recording needs the NVRs; backfill stands down')
  check('mayRun: an export wins', mayRun({ now: NOW, cfg, running: true, exportsBusy: true }).go === false)
  check('mayRun: switched off in the settings', mayRun({ now: NOW, cfg: { ...cfg, enabled: false }, running: true }).go === false)
  check('mayRun: stopped', mayRun({ now: NOW, cfg, running: false }).why === 'the job is stopped')
  check('mayRun: outside the window', mayRun({ now: NOW, cfg: { ...cfg, windowStart: '01:00', windowEnd: '01:01' }, running: true }).why?.startsWith('outside the off-peak window'))
  check('mayRun: everything clear', mayRun({ now: NOW, cfg, running: true }).go === true)
}

// ---- the ledger in the recordings DB -------------------------------------------------------------

const index = openRecIndex(join(DATA, 'recordings.db'))
{
  const g = { nvr: 'nvr-1', ch: 0, fromMs: NOW - DAY, toMs: NOW - DAY + 5 * MIN, reason: null, kind: 'unknown' }
  const a = index.backfillNote(g, NOW)
  check('ledger: a new hole starts pending with no attempts', a.state === 'pending' && a.attempts === 0 && a.firstSeenMs === NOW, J(a))
  index.backfillSet(a.id, { attempts: 3, lastError: 'the NVR is busy' })
  const b = index.backfillNote(g, NOW + 1000)
  check('ledger: the same hole seen again keeps its state and attempts', b.id === a.id && b.attempts === 3 && b.lastError === 'the NVR is busy')
  index.backfillSet(a.id, { state: 'permanent', note: PERMANENT.nothing })
  check('ledger: a permanent row can be listed on its own', index.backfillList({ state: 'permanent' }).length === 1)
  check('ledger: the list filters by state', index.backfillList({ state: 'pending' }).length === 0)
  index.backfillRemove(a.id)
  check('ledger: a row can be removed', index.backfillList({}).length === 0)
}
{
  // The job's pick list: pending rows only, oldest hole first (playback report 9). It read the newest
  // 5,000 rows of every state, so the oldest pending rows -- the ones nearest the NVR's deadline --
  // were never tried at all.
  const note = (days, state = null) => {
    const r = index.backfillNote({ nvr: 'q', ch: 0, fromMs: NOW - days * DAY, toMs: NOW - days * DAY + MIN, reason: null, kind: 'unknown' }, NOW)
    if (state) index.backfillSet(r.id, { state })
    return r
  }
  const rows = [note(3), note(5), note(9, 'permanent'), note(7, 'filled'), note(6)]
  const pending = typeof index.backfillPending === 'function' ? index.backfillPending({ limit: 2 }) : []
  check('ledger: backfillPending lists pending rows oldest first, up to the limit', J(pending.map((r) => r.id)) === J([rows[4].id, rows[1].id]), J(pending.map((r) => r.fromMs - NOW)))
  check('ledger: ... and never a filled or permanent row', typeof index.backfillPending === 'function' && index.backfillPending({ limit: 100 }).every((r) => r.state === 'pending') && index.backfillPending({ limit: 100 }).length === 3)
  for (const r of rows) index.backfillRemove(r.id)
}
{
  index.addSegment({ nvr: 'n', ch: 0, path: '/x/a.h264', startMs: 1, endMs: 2, bytes: 10, keyframes: 1, loc: 'L', source: 'backfill:n', filledMs: NOW })
  index.addSegment({ nvr: 'n', ch: 0, path: '/x/b.h264', startMs: 3, endMs: 4, bytes: 10, keyframes: 1, loc: 'L' })
  check('segments: a backfilled row states its source and when it was pulled', index.byPath('/x/a.h264')?.source === 'backfill:n' && index.byPath('/x/a.h264')?.filledMs === NOW)
  check('segments: live footage has no source', index.byPath('/x/b.h264')?.source === null)
  index.remove('/x/a.h264')
  index.remove('/x/b.h264')
}

// ---- the job -------------------------------------------------------------------------------------

/** A frame as the SDK wire format has it: key flag, codec, size, time in us; then the payload. */
function frame(tsMs, isKey, size = 400, codec = 0) {
  const b = Buffer.alloc(16 + size)
  b[0] = isKey ? 1 : 0
  b[1] = codec
  b.writeUInt32LE(size, 4)
  b.writeBigInt64LE(BigInt(Math.round(tsMs * 1000)), 8)
  b.fill(0x41, 16)
  return b
}

/**
 * A stand-in for rec-fallback's startLeg: it feeds the sink the frames the fake NVR "has" for the
 * stretch asked for, one keyframe a second, and then ends the way a real leg does.
 */
function fakeLeg(behaviour = {}) {
  const calls = []
  const fn = ({ ch, fromMs, toMs, real, skewMs, floorMs }) => {
    calls.push({ ch, fromMs, toMs, skewMs, floorMs })
    const done = (async () => {
      if (behaviour.refuse) return { reason: 'error', message: 'refused: resource limit reached', frames: 0 }
      if (behaviour.silent) return { reason: 'end', frames: 0 }
      // span: the frames it sends whatever it was asked for (a leg that ignores floorMs)
      const [a, b] = behaviour.span ? behaviour.span(fromMs, toMs) : [fromMs, toMs]
      for (let t = a; t < b; t += behaviour.stepMs ?? 1000) real.send(frame(t, true))
      return { reason: 'reached', frames: Math.ceil((toMs - fromMs) / 1000) }
    })()
    return { done, close() {}, command() {}, fromMs, toMs }
  }
  fn.calls = calls
  return fn
}

const nowBox = { t: NOW }
const cfg = { enabled: true, windowStart: '00:00', windowEnd: '23:59', nvrRetentionDays: 30, minGapSeconds: 10, maxGapMinutes: 60, perNvrMbps: 8, restSeconds: 0 }
const root = mkdtempSync(join(tmpdir(), 'backfill-rec-'))
const locations = () => [{ id: 'L1', path: root, role: 'main' }]

function makeJob(over = {}) {
  return new BackfillJob({
    index,
    nvrs: new Map([['nvr-1', { id: 'nvr-1', online: true }], ['nvr-2', { id: 'nvr-2', online: true }]]),
    locations,
    settings: () => ({ backfill: { ...cfg, ...(over.cfg ?? {}) } }),
    coverage: over.coverage ?? (async (_n, _ch, from, to) => ({ ranges: [[from, to]], skewMs: 0 })),
    leg: over.leg ?? fakeLeg(),
    now: () => nowBox.t,
    exportsBusy: over.exportsBusy ?? (() => false),
    recordingBusy: over.recordingBusy ?? (() => false),
    refusingOf: over.refusingOf ?? (() => false),
    stateFile: join(DATA, over.stateFile ?? 'backfill-state.json'),
    log: () => {},
    ...(over.extra ?? {})
  })
}

// one camera with a 3-minute hole two days ago
const CAM = { nvr: 'nvr-1', ch: 2 }
const HOLE_FROM = NOW - 2 * DAY
const HOLE_TO = HOLE_FROM + 3 * MIN
index.addSegment({ ...CAM, path: join(root, 'pre.h264'), startMs: HOLE_FROM - 10 * MIN, endMs: HOLE_FROM, bytes: 1000, keyframes: 10, loc: 'L1' })
index.addSegment({ ...CAM, path: join(root, 'post.h264'), startMs: HOLE_TO, endMs: HOLE_TO + 10 * MIN, bytes: 1000, keyframes: 10, loc: 'L1' })
index.addGap({ ...CAM, fromMs: HOLE_FROM, toMs: HOLE_TO, reason: 'refused by the NVR (no reason given)' })

{
  const job = makeJob()
  const s = await job.scan()
  check('scan: the hole is found and written to the ledger', s.found === 1 && s.added === 1, J(s))
  const rows = index.backfillList({ state: 'pending' })
  check('scan: the ledger row carries the recorder reason', rows.length === 1 && rows[0].reason === 'refused by the NVR (no reason given)' && rows[0].kind === 'recorder', J(rows))
  check('scan: seeing it again adds nothing', (await job.scan()).added === 0)
}
{
  const job = makeJob()
  const row = index.backfillList({ state: 'pending' })[0]
  const rest = await job.fill(row)
  const after = index.backfillRow(row.id)
  check('fill: the row is marked filled', after.state === 'filled' && after.filledMs === NOW, J(after))
  check('fill: it rested for the rate limit rather than going straight on', rest >= 0)
  const segs = index.segments(CAM.nvr, CAM.ch, HOLE_FROM, HOLE_TO).filter((x) => x.source)
  check('fill: real segments were written and indexed', segs.length >= 3, J(segs.map((x) => x.path)))
  check('fill: every one is marked as backfilled, with the time', segs.every((x) => x.source === 'backfill:nvr-1' && x.filledMs === NOW))
  check('fill: they land at the times the footage really has', segs[0].startMs >= HOLE_FROM && segs.at(-1).endMs <= HOLE_TO, `${segs[0].startMs - HOLE_FROM}`)
  check('fill: the files are really on disk', segs.every((x) => existsSync(x.path)))
  const idx = segs.map((x) => `${x.path}.idx`)
  check('fill: each segment has a keyframe index beside it', idx.every((f) => existsSync(f)))
  const rows0 = parseIdx(readFileSync(idx[0]))
  check('fill: the index rows hold real keyframe times', rows0.length > 0 && rows0[0].tsMs >= HOLE_FROM && rows0[0].offset === 0, J(rows0.slice(0, 2)))
  check('fill: the hole is gone from the timeline', job.holesOf(CAM.nvr, CAM.ch, HOLE_FROM - MIN, HOLE_TO + MIN).length === 0)
}
{
  // nvr-2's situation: it is at its bandwidth limit and turns the leg away
  index.addSegment({ nvr: 'nvr-2', ch: 0, path: join(root, 'p2a.h264'), startMs: HOLE_FROM - 10 * MIN, endMs: HOLE_FROM, bytes: 1000, keyframes: 10, loc: 'L1' })
  index.addSegment({ nvr: 'nvr-2', ch: 0, path: join(root, 'p2b.h264'), startMs: HOLE_TO, endMs: HOLE_TO + 10 * MIN, bytes: 1000, keyframes: 10, loc: 'L1' })
  const leg = fakeLeg({ refuse: true })
  const job = makeJob({ leg })
  await job.scan()
  const row = index.backfillList({ state: 'pending' }).find((r) => r.nvr === 'nvr-2')
  const wait = await job.fill(row)
  check('refusal: the wait is the long ladder, not a retry', wait === bf.REFUSED_BACKOFF_MS[0], `${wait}`)
  check('refusal: the row stays pending, with the refusal recorded', index.backfillRow(row.id).state === 'pending' && /refus/i.test(index.backfillRow(row.id).lastError ?? ''))
  check('refusal: the whole NVR stands down, not just that camera', job.nvrBackoff.get('nvr-2') > NOW)
  check('refusal: the scheduler now skips every gap on that NVR', chooseGap([{ ...index.backfillRow(row.id), nextTryMs: job.nextTry.get(row.id) }], { now: NOW, nvrs: job.nvrView(), retentionMsOf: () => 30 * DAY }).row === null)
  check('refusal: the NVR was asked exactly once', leg.calls.length === 1)
  index.backfillSet(row.id, { state: 'permanent', note: 'test tidy-up' })
}
{
  // "we could not ask" must never become "there is nothing there"
  const job = makeJob({ coverage: async () => ({ ranges: [], reason: 'the NVR is busy' }) })
  index.addSegment({ nvr: 'nvr-1', ch: 5, path: join(root, 'p5a.h264'), startMs: HOLE_FROM - 10 * MIN, endMs: HOLE_FROM, bytes: 1000, keyframes: 10, loc: 'L1' })
  index.addSegment({ nvr: 'nvr-1', ch: 5, path: join(root, 'p5b.h264'), startMs: HOLE_TO, endMs: HOLE_TO + 10 * MIN, bytes: 1000, keyframes: 10, loc: 'L1' })
  await job.scan()
  const row = index.backfillList({ state: 'pending' }).find((r) => r.ch === 5)
  await job.fill(row)
  const after = index.backfillRow(row.id)
  check('unknown: a busy NVR leaves the row pending, never permanent', after.state === 'pending' && after.attempts === 1 && after.lastError === 'the NVR is busy', J(after))
  check('unknown: it waits out the refusal ladder, because busy is a capacity answer', job.nextTry.get(row.id) === NOW + bf.REFUSED_BACKOFF_MS[0])
}
{
  // the NVR answers plainly that it has nothing: that IS a decision, and a final one
  const job = makeJob({ coverage: async () => ({ ranges: [] }) })
  index.addSegment({ nvr: 'nvr-1', ch: 6, path: join(root, 'p6a.h264'), startMs: HOLE_FROM - 10 * MIN, endMs: HOLE_FROM, bytes: 1000, keyframes: 10, loc: 'L1' })
  index.addSegment({ nvr: 'nvr-1', ch: 6, path: join(root, 'p6b.h264'), startMs: HOLE_TO, endMs: HOLE_TO + 10 * MIN, bytes: 1000, keyframes: 10, loc: 'L1' })
  await job.scan()
  const row = index.backfillList({ state: 'pending' }).find((r) => r.ch === 6)
  await job.fill(row)
  const after = index.backfillRow(row.id)
  check('permanent: the NVR having nothing ends the matter', after.state === 'permanent' && after.note === PERMANENT.nothing, J(after))
  check('permanent: it is listed for the Storage/Health page', job.status().permanent.some((r) => r.id === row.id))
  check('permanent: it is never picked again', chooseGap([after], { now: NOW, nvrs: job.nvrView(), retentionMsOf: () => 30 * DAY }).row === null)
}
{
  // a hole the NVR has already rolled past: marked permanent by the scan itself, never asked about
  const leg = fakeLeg()
  const job = makeJob({ leg })
  const old = NOW - 45 * DAY
  index.addSegment({ nvr: 'nvr-1', ch: 7, path: join(root, 'p7a.h264'), startMs: old - 10 * MIN, endMs: old, bytes: 1000, keyframes: 10, loc: 'L1' })
  index.addSegment({ nvr: 'nvr-1', ch: 7, path: join(root, 'p7b.h264'), startMs: old + 5 * MIN, endMs: old + 15 * MIN, bytes: 1000, keyframes: 10, loc: 'L1' })
  // the hole was found while it was still young; the NVR has since rolled past it
  const seen = index.backfillNote({ nvr: 'nvr-1', ch: 7, fromMs: old, toMs: old + 5 * MIN, reason: null, kind: 'unknown' }, NOW - 40 * DAY)
  const s = await job.scan()
  const row = index.backfillRow(seen.id)
  check('aged out: the scan marks it permanent once the NVR has lost it', row?.state === 'permanent' && row.note === PERMANENT.aged, J(row))
  check('aged out: it counted as permanent', s.permanent >= 1)
  check('aged out: no NVR was asked', leg.calls.length === 0)
}
{
  // a leg that starts and sends nothing is a failure, not an empty stretch of history
  const job = makeJob({ leg: fakeLeg({ silent: true }) })
  index.addSegment({ nvr: 'nvr-1', ch: 8, path: join(root, 'p8a.h264'), startMs: HOLE_FROM - 10 * MIN, endMs: HOLE_FROM, bytes: 1000, keyframes: 10, loc: 'L1' })
  index.addSegment({ nvr: 'nvr-1', ch: 8, path: join(root, 'p8b.h264'), startMs: HOLE_TO, endMs: HOLE_TO + 10 * MIN, bytes: 1000, keyframes: 10, loc: 'L1' })
  await job.scan()
  const row = index.backfillList({ state: 'pending' }).find((r) => r.ch === 8)
  await job.fill(row)
  const after = index.backfillRow(row.id)
  check('no video: the row stays pending and counts an attempt', after.state === 'pending' && after.attempts === 1, J(after))
  check('no video: nothing was indexed as filled', index.segments('nvr-1', 8, HOLE_FROM, HOLE_TO).filter((x) => x.source).length === 0)
  index.backfillSet(row.id, { state: 'permanent', note: 'test tidy-up' })
}
{
  // a pull bigger than maxGapMinutes is cut up: one bounded leg per turn
  const leg = fakeLeg()
  const job = makeJob({ leg, cfg: { maxGapMinutes: 1 } })
  index.addSegment({ nvr: 'nvr-1', ch: 9, path: join(root, 'p9a.h264'), startMs: HOLE_FROM - 10 * MIN, endMs: HOLE_FROM, bytes: 1000, keyframes: 10, loc: 'L1' })
  index.addSegment({ nvr: 'nvr-1', ch: 9, path: join(root, 'p9b.h264'), startMs: HOLE_FROM + 5 * MIN, endMs: HOLE_FROM + 15 * MIN, bytes: 1000, keyframes: 10, loc: 'L1' })
  await job.scan()
  const row = index.backfillList({ state: 'pending' }).find((r) => r.ch === 9)
  await job.fill(row)
  check('chunking: only one bounded piece is pulled per turn', leg.calls.length === 1 && leg.calls[0].toMs - leg.calls[0].fromMs === MIN, J(leg.calls))
  const after = index.backfillRow(row.id)
  check('chunking: the row stays pending with what is left noted', after.state === 'pending' && /left/.test(after.note ?? ''), J(after))
  await job.fill(index.backfillRow(row.id))
  check('chunking: the next turn carries on where the footage now ends', leg.calls.length === 2 && leg.calls[1].fromMs >= leg.calls[0].toMs - 2000 && leg.calls[1].fromMs > leg.calls[0].fromMs, J(leg.calls))
}

// ---- the same NVR footage pulled over and over (playback report 9) -------------------------------
//
// nvr1/18, ledger row 2658, hole 17:48:03-17:56:11: every pull wrote 17:44:48-17:47:11. The NVR starts
// a playback at the file that holds the asked-for time, minutes before the hole; the leg kept those
// frames (no floorMs), the job counted the written file as progress and cleared the retry wait, and
// chooseGap picked the same row again on the next tick. 108 of 293 backfilled segments were copies.

/**
 * An NVR as rec-fallback's startLeg meets it: a playback asked to start at `start` begins at the start
 * of the file holding that time (fileBeforeMs earlier) and plays one keyframe a second up to
 * hasTo(start), then ends.
 */
function playingNvr({ fileBeforeMs = 3 * MIN, hasTo }) {
  const starts = []
  return {
    id: 'nvr-1',
    online: true,
    starts,
    playback: {
      connect(ws, url) {
        const start = Number(url.searchParams.get('start'))
        starts.push(start)
        setImmediate(() => {
          ws.send(JSON.stringify({ type: 'started' }))
          for (let t = start - fileBeforeMs; t < hasTo(start); t += 1000) ws.send(frame(t, true))
          ws.send(JSON.stringify({ type: 'end' }))
        })
      }
    }
  }
}
/** A camera with footage either side of a 3-minute hole two days ago; its pending ledger row. */
function holeOn(ch) {
  index.addSegment({ nvr: 'nvr-1', ch, path: join(root, `h${ch}a.h264`), startMs: HOLE_FROM - 10 * MIN, endMs: HOLE_FROM, bytes: 1000, keyframes: 10, loc: 'L1' })
  index.addSegment({ nvr: 'nvr-1', ch, path: join(root, `h${ch}b.h264`), startMs: HOLE_TO, endMs: HOLE_TO + 10 * MIN, bytes: 1000, keyframes: 10, loc: 'L1' })
  return index.backfillNote({ nvr: 'nvr-1', ch, fromMs: HOLE_FROM, toMs: HOLE_TO, reason: null, kind: 'unknown' }, NOW)
}
const pulled = (ch) => index.segments('nvr-1', ch, HOLE_FROM - 20 * MIN, HOLE_TO + 20 * MIN).filter((x) => x.source)
{
  const { startLeg } = await import('../rec-fallback.mjs')
  // the NVR has footage through the hole: only the hole's part of it is written
  const nvr = playingNvr({ hasTo: (start) => start + 5 * MIN })
  const job = makeJob({ leg: startLeg, extra: { nvrs: new Map([['nvr-1', nvr]]) } })
  const row = holeOn(10)
  await job.fill(row)
  const segs = pulled(10)
  check('floor: the NVR is asked from the start of the hole (and plays from its file start)', nvr.starts.length === 1 && nvr.starts[0] === HOLE_FROM, J(nvr.starts))
  check('floor: nothing from before the hole is written again', segs.length > 0 && segs.every((x) => x.startMs >= HOLE_FROM - 1), J(segs.map((x) => (x.startMs - HOLE_FROM) / 1000)))
  check('floor: the hole is filled', index.backfillRow(row.id).state === 'filled' && job.holesOf('nvr-1', 10, HOLE_FROM - MIN, HOLE_TO + MIN).length === 0, J(index.backfillRow(row.id)))

  // row 2658: the NVR has nothing inside the hole, only the minutes before it
  const empty = playingNvr({ hasTo: (start) => start - MIN })
  const job2 = makeJob({ leg: startLeg, extra: { nvrs: new Map([['nvr-1', empty]]) } })
  const row2 = holeOn(11)
  const wait = await job2.fill(row2)
  const after = index.backfillRow(row2.id)
  check('floor: footage from before the hole is not written at all', pulled(11).length === 0, J(pulled(11).map((x) => (x.startMs - HOLE_FROM) / 1000)))
  check('floor: ... so that pull is a failure: attempt counted, row pending, the row backed off', after.state === 'pending' && after.attempts === 1 && job2.nextTry.get(row2.id) === NOW + bf.ERROR_BACKOFF_MS[0], J({ after, nextTry: job2.nextTry.get(row2.id) - NOW }))
  // the back-off is the row's; the job itself only rests, and must wake while the row still waits
  check('floor: ... the job rests a tick, not the row\'s back-off', wait >= job2.tickMs && wait < bf.ERROR_BACKOFF_MS[0], `${wait}`)
  check('floor: ... and when the job wakes the pick does not take the same row', chooseGap([{ ...after, nextTryMs: job2.nextTry.get(row2.id) }], { now: NOW + wait, nvrs: job2.nvrView(), retentionMsOf: () => 30 * DAY }).row === null)
  index.backfillSet(row2.id, { state: 'permanent', note: 'test tidy-up' })
}
{
  // Written files are not progress: only a hole that got shorter is. A leg that writes footage outside
  // the hole (the frames before it, as every pull of row 2658 did) is a failed try with a back-off.
  const leg = fakeLeg({ span: (from) => [from - 3 * MIN, from - MIN] })
  const job = makeJob({ leg })
  const row = holeOn(12)
  const wait = await job.fill(row)
  const after = index.backfillRow(row.id)
  check('floor: the job gives the leg floorMs 1 ms before the piece it pulls', leg.calls[0]?.floorMs === leg.calls[0]?.fromMs - 1, J(leg.calls))
  check('progress: the leg did write files (outside the hole)', pulled(12).length > 0)
  check('progress: a pull that did not shorten the hole is a failure, not progress', after.state === 'pending' && after.attempts === 1 && /hole/.test(after.lastError ?? ''), J(after))
  check('progress: ... the row backs off, the job only rests a tick before its next pick', job.nextTry.get(row.id) === NOW + bf.ERROR_BACKOFF_MS[0] && wait >= job.tickMs && wait < bf.ERROR_BACKOFF_MS[0], `${wait}`)
  check('progress: ... and says so in the job state', /hole/.test(job.last.what) && job.last.errors === 1, J(job.last))
  // a second failed try doubles the row's wait, as any other failure does
  const wait2 = await job.fill(index.backfillRow(row.id))
  check('progress: the next failed try makes the row wait longer', job.nextTry.get(row.id) === NOW + bf.backoffMs(2, bf.ERROR_BACKOFF_MS) && index.backfillRow(row.id).attempts === 2 && wait2 < bf.ERROR_BACKOFF_MS[0], `${wait2}`)
  index.backfillSet(row.id, { state: 'permanent', note: 'test tidy-up' })

  // a failed pull still used the NVR's bandwidth: the job's rest after it honours the rate limit
  const slow = makeJob({ leg: fakeLeg({ span: (from) => [from - 3 * MIN, from - MIN] }), cfg: { perNvrMbps: 0.004 } })
  const rowS = holeOn(14)
  const waitS = await slow.fill(rowS)
  check('progress: after a failed pull the job still rests for the rate limit (~50 kB at 4 kbit/s)', waitS > 60_000 && waitS < bf.ERROR_BACKOFF_MS[0] && slow.nextTry.get(rowS.id) === NOW + bf.ERROR_BACKOFF_MS[0], `${waitS}`)
  index.backfillSet(rowS.id, { state: 'permanent', note: 'test tidy-up' })

  // under a second of the hole is not progress either
  const tiny = fakeLeg({ span: (from) => [from, from + 500], stepMs: 400 })
  const job2 = makeJob({ leg: tiny })
  const row2 = holeOn(13)
  const wait3 = await job2.fill(row2)
  check('progress: shortening the hole by under a second is a failure too', index.backfillRow(row2.id).attempts === 1 && job2.nextTry.get(row2.id) === NOW + bf.ERROR_BACKOFF_MS[0] && wait3 < bf.ERROR_BACKOFF_MS[0], J({ row: index.backfillRow(row2.id), wait3 }))
  index.backfillSet(row2.id, { state: 'permanent', note: 'test tidy-up' })
}
{
  // The oldest pending hole is tried first even with thousands of newer rows in the ledger (5,785 on
  // the server; the newest 5,000 were read, so the oldest 785 -- nearest their deadline -- never were).
  const leg = fakeLeg()
  const job = makeJob({ leg })
  const OLD_FROM = NOW - 29 * DAY
  index.addSegment({ nvr: 'nvr-1', ch: 41, path: join(root, 'o41a.h264'), startMs: OLD_FROM - 10 * MIN, endMs: OLD_FROM, bytes: 1000, keyframes: 10, loc: 'L1' })
  index.addSegment({ nvr: 'nvr-1', ch: 41, path: join(root, 'o41b.h264'), startMs: OLD_FROM + 3 * MIN, endMs: OLD_FROM + 13 * MIN, bytes: 1000, keyframes: 10, loc: 'L1' })
  const oldest = index.backfillNote({ nvr: 'nvr-1', ch: 41, fromMs: OLD_FROM, toMs: OLD_FROM + 3 * MIN, reason: null, kind: 'unknown' }, NOW)
  const filler = []
  for (let i = 0; i < 5100; i++) filler.push(index.backfillNote({ nvr: 'nvr-1', ch: 40, fromMs: NOW - 20 * DAY + i * MIN, toMs: NOW - 20 * DAY + i * MIN + 30_000, reason: null, kind: 'unknown' }, NOW).id)
  job.running = true
  await job.tick()
  job.stop('test')
  check('oldest first: with 5,100 newer rows in the ledger the oldest pending hole is the one pulled', leg.calls.length === 1 && leg.calls[0].fromMs === OLD_FROM, J({ calls: leg.calls.map((c) => (c.fromMs - NOW) / DAY), what: job.last.what }))
  check('oldest first: ... and it is filled', index.backfillRow(oldest.id).state === 'filled', J(index.backfillRow(oldest.id)))
  for (const id of filler) index.backfillRemove(id)
}

// ---- one stuck row must not hold the whole job (playback report 9, review) -----------------------
//
// fill() handed a failed row's back-off to tick() as the job's rest, and set the row's nextTry to that
// same moment: the job woke just as the row came due, and the row -- stuck, so the oldest, so first in
// the pick -- was pulled again. Over 8 h a hole the NVR had nothing for was pulled at 0, 5, 15, 35, 75,
// 155, 275 and 395 min, and a fillable hole on the same NVR was never tried. These drive the real
// tick() at the delay it arms each time, each on an index of its own.
{
  const fairRoot = mkdtempSync(join(tmpdir(), 'backfill-fair-'))
  let n = 0
  /**
   * A running job on a fresh index with one 3-minute hole per [nvr, ch, daysAgo], and a leg that
   * records every pull and plays `legOf(nvrId, ch)` (a fakeLeg; the default fills the hole).
   */
  const setup = (holes, { legOf = () => null, coverage } = {}) => {
    const idx = openRecIndex(join(fairRoot, `fair-${++n}.db`))
    const rows = holes.map(([nvr, ch, days]) => {
      const from = NOW - days * DAY
      idx.addSegment({ nvr, ch, path: join(fairRoot, `${n}-${nvr}-${ch}a.h264`), startMs: from - 10 * MIN, endMs: from, bytes: 1000, keyframes: 10, loc: 'L1' })
      idx.addSegment({ nvr, ch, path: join(fairRoot, `${n}-${nvr}-${ch}b.h264`), startMs: from + 3 * MIN, endMs: from + 13 * MIN, bytes: 1000, keyframes: 10, loc: 'L1' })
      return idx.backfillNote({ nvr, ch, fromMs: from, toMs: from + 3 * MIN, reason: null, kind: 'unknown' }, NOW)
    })
    const good = fakeLeg()
    const pulls = []
    const leg = (o) => {
      pulls.push({ nvr: o.nvr.id, ch: o.ch, atMs: nowBox.t - NOW })
      return (legOf(o.nvr.id, o.ch) ?? good)(o)
    }
    const job = makeJob({ leg, coverage, cfg: { restSeconds: 30 }, extra: { index: idx, locations: () => [{ id: 'L1', path: fairRoot, role: 'main' }] } })
    job.running = true
    return { idx, rows, job, pulls }
  }
  /** Ticks the job at the delay it arms each time, until `forMs` of simulated time has gone by. */
  const run = async (job, forMs) => {
    const until = nowBox.t + forMs
    for (let i = 0; nowBox.t < until && i < 5000; i++) {
      await job.tick()
      nowBox.t += job.timer?._idleTimeout ?? job.tickMs
    }
    job.stop('test')
  }

  for (const [what, stuck] of [['writes only footage from before the hole', { span: (from) => [from - 3 * MIN, from - MIN] }], ['has nothing inside the hole', { silent: true }]]) {
    nowBox.t = NOW
    // the stuck hole is the oldest, so it is always first in the pick; one fillable hole on the same
    // NVR, one on another
    const { idx, rows, job, pulls } = setup([['nvr-1', 1, 20], ['nvr-1', 2, 19], ['nvr-2', 3, 18]], { legOf: (nvr, ch) => (ch === 1 ? fakeLeg(stuck) : null) })
    await run(job, 8 * HOUR)
    const on = (ch) => pulls.filter((p) => p.ch === ch)
    check(`one stuck row (the NVR ${what}): the first tick pulls it`, pulls[0]?.ch === 1, J(pulls.slice(0, 3)))
    check(`one stuck row (${what}): the next tick, when the job wakes, pulls another row instead`, pulls[1]?.ch === 2 && pulls[1].atMs < 2 * MIN, J(pulls.slice(0, 3)))
    check(`one stuck row (${what}): the other rows, on both NVRs, are filled`, idx.backfillRow(rows[1].id).state === 'filled' && idx.backfillRow(rows[2].id).state === 'filled', J(pulls.slice(0, 4)))
    // the stuck row is still tried, but only on its own back-off ladder: 5, 10, 20, ... min apart
    const gaps = on(1).slice(1).map((p, i) => p.atMs - on(1)[i].atMs)
    check(`one stuck row (${what}): it is still retried, each time only after its own back-off`, on(1).length >= 4 && on(1).length <= 8 && gaps.every((g, i) => g >= bf.backoffMs(i + 1, bf.ERROR_BACKOFF_MS)), J(on(1).map((p) => p.atMs / MIN)))
    check(`one stuck row (${what}): it stays pending, with its attempts counted`, idx.backfillRow(rows[0].id).state === 'pending' && idx.backfillRow(rows[0].id).attempts === on(1).length, J(idx.backfillRow(rows[0].id)))
    idx.close()
  }

  // An NVR that cannot be asked (its search fails) or whose leg breaks off is a problem with the NVR,
  // not the row: the NVR stands down for the row's back-off, so the short rest does not become a new
  // search or leg on it every tick, and the other NVRs carry on meanwhile.
  const searchFails = async (nvr, ch, from, to) => (nvr.id === 'nvr-1' ? { ranges: [], reason: 'the NVR search failed' } : { ranges: [[from, to]], skewMs: 0 })
  // a leg that errors before a frame, with a message that is not a refusal
  const breakingLeg = () => ({ fromMs, toMs }) => ({ done: Promise.resolve({ reason: 'error', message: 'the connection was reset' }), close() {}, command() {}, fromMs, toMs })
  for (const [what, opts] of [['search fails', { coverage: searchFails }], ['leg breaks off', { legOf: (nvr) => (nvr === 'nvr-1' ? breakingLeg() : null) }]]) {
    nowBox.t = NOW
    const asked = []
    const coverage = opts.coverage ?? (async (_n, _ch, from, to) => ({ ranges: [[from, to]], skewMs: 0 }))
    const counted = async (nvr, ch, from, to) => {
      asked.push({ nvr: nvr.id, ch, atMs: nowBox.t - NOW })
      return coverage(nvr, ch, from, to)
    }
    const { idx, rows, job } = setup([['nvr-1', 1, 20], ['nvr-1', 2, 19], ['nvr-2', 3, 18]], { ...opts, coverage: counted })
    await run(job, 4 * MIN)
    check(`an NVR whose ${what}: it stands down, and the job goes on with the other NVR`, asked[0]?.nvr === 'nvr-1' && asked[1]?.nvr === 'nvr-2' && asked[1].atMs < 2 * MIN && idx.backfillRow(rows[2].id).state === 'filled', J(asked))
    check(`an NVR whose ${what}: it is not asked again for its next row inside the back-off`, asked.filter((a) => a.nvr === 'nvr-1').length === 1 && idx.backfillRow(rows[1].id).attempts === 0, J(asked))
    check(`an NVR whose ${what}: the row it failed on counts the attempt and waits its back-off`, idx.backfillRow(rows[0].id).attempts === 1 && job.nextTry.get(rows[0].id) === NOW + bf.ERROR_BACKOFF_MS[0], J(idx.backfillRow(rows[0].id)))
    idx.close()
  }
  nowBox.t = NOW
}
{
  // the run flag is on disk, so a restart picks the job back up (roadmap 2b point 3)
  const file = join(DATA, 'resume-state.json')
  const a = makeJob({ stateFile: 'resume-state.json' })
  check('resume: a fresh job is stopped', a.running === false)
  a.start('boss')
  a.stop('boss')
  check('resume: stopping is remembered', JSON.parse(readFileSync(file, 'utf8')).running === false)
  a.start('boss')
  const b = makeJob({ stateFile: 'resume-state.json' })
  check('resume: a new process picks the job back up', b.running === true && b.resume() === true)
  b.stop('boss')
  a.stop('boss')
}
{
  const job = makeJob()
  const st = job.status()
  check('status: the window and its state are reported', st.window.start === '00:00' && st.window.open === true)
  check('status: the counts are there', typeof st.counts.pending === 'number' && typeof st.counts.permanent === 'number' && typeof st.counts.filled === 'number', J(st.counts))
  check('status: the gaps come oldest first (the ones the NVRs lose next)', st.gaps.every((g, i, a) => i === 0 || a[i - 1].fromMs <= g.fromMs))
  check('status: each gap carries its duration and age', st.gaps.length === 0 || (typeof st.gaps[0].durationMs === 'number' && typeof st.gaps[0].ageMs === 'number'))
}
{
  // the fail-safe: told nothing about exports, the job assumes one is running rather than barge in
  const j = new BackfillJob({ index, locations, settings: () => ({ backfill: cfg }), now: () => nowBox.t, stateFile: join(DATA, 'fs.json'), log: () => {} })
  check('fail safe: with no way to see exports the job stands down', j.status().state.mayRun.go === false)
}
{
  // a tick outside the window must not touch an NVR at all
  const leg = fakeLeg()
  const job = makeJob({ leg, cfg: { windowStart: '01:00', windowEnd: '01:01' } })
  job.running = true
  await job.tick()
  check('tick: outside the window nothing is pulled', leg.calls.length === 0)
  check('tick: and it says why', /outside the off-peak window/.test(job.last.what))
  job.stop('test')
  const leg2 = fakeLeg()
  const job2 = makeJob({ leg: leg2, recordingBusy: () => true })
  job2.running = true
  await job2.tick()
  check('tick: while live recording needs the NVRs nothing is pulled', leg2.calls.length === 0 && /live recording/.test(job2.last.what))
  job2.stop('test')
}

// ---- writerSink --------------------------------------------------------------------------------

{
  const w = new SegmentWriter({ root: join(root, 'sink'), nvrId: 'nvr-1', ch: 0 })
  const sink = writerSink(w)
  sink.send('{"type":"started"}')
  sink.send(frame(NOW, true))
  sink.send(frame(NOW + 40, false))
  sink.send(frame(0, true)) // a frame with no usable time
  check('writerSink: text messages are not written anywhere', sink.stats.frames === 2, J(sink.stats))
  check('writerSink: a frame without a time is refused, not stamped with a guess', sink.stats.frames === 2)
  check('writerSink: bufferedAmount is the disk queue, so a slow drive slows the pull', sink.bufferedAmount >= 0)
  await w.close()
  await w.drained()
}

// ---- the routes ----------------------------------------------------------------------------------

{
  const job = initBackfill(makeJob({ stateFile: 'route-state.json' }))
  check('routes: an unrelated path is not ours', (await handleBackfill('GET', '/api/admin/nothing', null, 'boss')) === null)
  check('routes: a non-admin is refused', (await handleBackfill('GET', '/api/admin/backfill', null, 'bob'))[0] === 403)
  check('routes: the wrong method is refused', (await handleBackfill('POST', '/api/admin/backfill', null, 'boss'))[0] === 405)
  check('routes: run refuses GET', (await handleBackfill('GET', '/api/admin/backfill/run', null, 'boss'))[0] === 405)
  const [gs, gb] = await handleBackfill('GET', '/api/admin/backfill', null, 'boss')
  check('routes: GET gives the gaps and the job state', gs === 200 && Array.isArray(gb.gaps) && Array.isArray(gb.permanent) && 'running' in gb, J(Object.keys(gb)))
  const [rs, rb] = await handleBackfill('POST', '/api/admin/backfill/run', null, 'boss')
  check('routes: run starts the job', rs === 200 && rb.running === true && job.running === true)
  const [ss, sb] = await handleBackfill('POST', '/api/admin/backfill/stop', null, 'boss')
  check('routes: stop stops it', ss === 200 && sb.running === false && job.running === false)
  const off = initBackfill(makeJob({ cfg: { enabled: false }, stateFile: 'route-off.json' }))
  check('routes: run refuses while backfill is switched off', (await handleBackfill('POST', '/api/admin/backfill/run', null, 'boss'))[0] === 409)
  off.stop('test')
  job.stop('test')
}

// The backfill settings themselves (DEFAULTS, validation, saving) are tested in
// settings.test.mjs: settings.mjs reaches the SDK through nvr-xml.mjs, so it cannot be imported on
// a machine without the Linux SDK. What this file checks instead is that backfill.mjs carries its
// own copy of the defaults and never needs that import.
check('the module needs no settings import: it carries its own defaults', bf.DEFAULT_BACKFILL.windowStart === '01:00' && bf.DEFAULT_BACKFILL.windowEnd === '05:00' && bf.DEFAULT_BACKFILL.enabled === false)
check('a job given no settings at all still has sane values', new BackfillJob({ index, stateFile: join(DATA, 'noset.json'), log: () => {} }).cfg().nvrRetentionDays === 30)

// the index dependency may be a getter, as server.mjs passes it at start-up (before the index is
// open). It must be resolved on use, not stored raw -- storing the getter made every tick throw
// "this.index.cameras is not a function" and backfill filled nothing (2026-09-25 to 09-27).
{
  const viaGetter = new BackfillJob({ index: () => index, stateFile: join(DATA, 'getter.json'), log: () => {} })
  check('a job given the index as a getter resolves it', viaGetter.index === index && typeof viaGetter.index.cameras === 'function')
  const notOpen = new BackfillJob({ index: () => null, settings: () => ({ backfill: { enabled: true, windowStart: '00:00', windowEnd: '23:59' } }), now: () => Date.now(), stateFile: join(DATA, 'notopen.json'), log: () => {} })
  let threw = false
  try { await notOpen.tick() } catch { threw = true }
  notOpen.stop()
  check('a tick before the index is open no-ops instead of throwing', !threw)
}

index.close()
console.log(`\n${checks - failures} of ${checks} passed`)
if (failures) console.log(`${failures} failed`)
process.exit(failures ? 1 : 0)
