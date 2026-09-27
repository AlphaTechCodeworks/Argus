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
  const fn = ({ ch, fromMs, toMs, real, skewMs }) => {
    calls.push({ ch, fromMs, toMs, skewMs })
    const done = (async () => {
      if (behaviour.refuse) return { reason: 'error', message: 'refused: resource limit reached', frames: 0 }
      if (behaviour.silent) return { reason: 'end', frames: 0 }
      for (let t = fromMs; t < toMs; t += 1000) real.send(frame(t, true))
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
  const s = job.scan()
  check('scan: the hole is found and written to the ledger', s.found === 1 && s.added === 1, J(s))
  const rows = index.backfillList({ state: 'pending' })
  check('scan: the ledger row carries the recorder reason', rows.length === 1 && rows[0].reason === 'refused by the NVR (no reason given)' && rows[0].kind === 'recorder', J(rows))
  check('scan: seeing it again adds nothing', job.scan().added === 0)
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
  job.scan()
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
  job.scan()
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
  job.scan()
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
  const s = job.scan()
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
  job.scan()
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
  job.scan()
  const row = index.backfillList({ state: 'pending' }).find((r) => r.ch === 9)
  await job.fill(row)
  check('chunking: only one bounded piece is pulled per turn', leg.calls.length === 1 && leg.calls[0].toMs - leg.calls[0].fromMs === MIN, J(leg.calls))
  const after = index.backfillRow(row.id)
  check('chunking: the row stays pending with what is left noted', after.state === 'pending' && /left/.test(after.note ?? ''), J(after))
  await job.fill(index.backfillRow(row.id))
  check('chunking: the next turn carries on where the footage now ends', leg.calls.length === 2 && leg.calls[1].fromMs >= leg.calls[0].toMs - 2000 && leg.calls[1].fromMs > leg.calls[0].fromMs, J(leg.calls))
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
