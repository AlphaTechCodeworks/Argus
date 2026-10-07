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
  // a hole whose fill() threw (`throws`, counted by the job) goes after every hole that has not, whatever
  // their deadlines; among those that have, the one that threw least, then the deadline again
  const thrown = (list) => chooseGap(list, { now: NOW, nvrs, retentionMsOf }).row?.id
  check('chooseGap: a hole that has thrown goes after one that has not, though the NVR loses it sooner', thrown([{ ...rows[1], throws: 1 }, rows[0]]) === 1 && thrown([rows[1], { ...rows[0], throws: 1 }]) === 2)
  check('chooseGap: among holes that have thrown, the one that threw least goes first', thrown([{ ...rows[1], throws: 3 }, { ...rows[0], throws: 2 }]) === 1 && thrown([{ ...rows[1], throws: 2 }, { ...rows[0], throws: 2 }]) === 2)
  check('chooseGap: of holes that have not thrown, those of a camera whose fills have go after the others', thrown([{ ...rows[1], camThrows: 1 }, rows[0]]) === 1 && thrown([{ ...rows[1], camThrows: 2 }, { ...rows[0], camThrows: 1 }]) === 1)
  check('chooseGap: ... but before a hole that has thrown itself', thrown([{ ...rows[1], camThrows: 5 }, { ...rows[0], throws: 1 }]) === 2)
  check('chooseGap: a hole that has thrown is still picked when there is no other', thrown([{ ...rows[1], throws: 4 }]) === 2 && thrown([{ ...rows[1], throws: 4 }, { ...rows[0], nextTryMs: NOW + 1000 }]) === 2)
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
    const rows = holes.map(([nvr, ch, days], i) => {
      const from = NOW - days * DAY
      idx.addSegment({ nvr, ch, path: join(fairRoot, `${n}-${nvr}-${ch}-${i}a.h264`), startMs: from - 10 * MIN, endMs: from, bytes: 1000, keyframes: 10, loc: 'L1' })
      idx.addSegment({ nvr, ch, path: join(fairRoot, `${n}-${nvr}-${ch}-${i}b.h264`), startMs: from + 3 * MIN, endMs: from + 13 * MIN, bytes: 1000, keyframes: 10, loc: 'L1' })
      return idx.backfillNote({ nvr, ch, fromMs: from, toMs: from + 3 * MIN, reason: null, kind: 'unknown' }, NOW)
    })
    const good = fakeLeg()
    const pulls = []
    const leg = (o) => {
      pulls.push({ nvr: o.nvr.id, ch: o.ch, atMs: nowBox.t - NOW, fromMs: o.fromMs })
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

  // ---- a pull that THROWS part-way (2026-10 code audit, H2, and its reviews) ----------------------
  //
  // fill() returns from every failure it knows of. When it throws instead (here: the index refusing a
  // write after the footage was pulled) none of what it does for a failed try has happened: the hole,
  // still the oldest, was first in the pick again. These run the job as its timer does -- the armed
  // callback itself: tick(), and what the timer does when it throws -- on the simulated clock, which
  // moves by the wait armed each time. `each(i)` is called after callback i, before the clock moves.
  // Returns whether the job was still armed when the time was up (false: a callback armed nothing).
  const runArmed = async (job, forMs, each = () => {}) => {
    const until = nowBox.t + forMs
    let armedToTheEnd = true
    job.resume()
    for (let i = 0; job.timer && nowBox.t < until; i++) {
      // (a run that needs more callbacks than this is a job that spins, or a block that should move its clock faster)
      if (i >= 20_000) throw new Error(`runArmed: ${i} callbacks and the time is not up (${Math.round((until - nowBox.t) / MIN)} min to go)`)
      const armed = job.timer
      const fire = armed._onTimeout // (clearTimeout takes it off the timer)
      clearTimeout(armed)
      await fire()
      each(i, armed)
      if (!job.timer || job.timer === armed) {
        armedToTheEnd = false // nothing was armed: the job has ended
        break
      }
      nowBox.t += job.timer._idleTimeout
    }
    job.stop('test')
    return armedToTheEnd
  }
  /** Makes `idx[method]` throw when `when(...args)` says so, as an index that refuses a write does. Returns how often it did (`fired`). */
  const refusing = (idx, method, when, message = 'the index refused the write') => {
    const real = idx[method].bind(idx)
    const fault = { fired: 0 }
    idx[method] = (...a) => {
      if (when(...a)) {
        fault.fired++
        throw new Error(message)
      }
      return real(...a)
    }
    return fault
  }
  /** A segment a backfill pull is putting into the index (the ones a test writes itself have no source). */
  const pulled = (s) => String(s.source ?? '').startsWith('backfill:')
  /** Runs `fn` with console.warn collected into the list it returns (the timer's failures are warned). */
  const warnings = async (fn, warn = null) => {
    const said = []
    const realWarn = console.warn
    console.warn = warn ? (...a) => warn(said, a.join(' ')) : (...a) => said.push(a.join(' '))
    try {
      await fn()
    } finally {
      console.warn = realWarn
    }
    return said
  }
  /** One more 3-minute hole on an index that is already in use (as setup makes them). */
  const addHole = (idx, nvr, ch, days) => {
    const from = NOW - days * DAY
    idx.addSegment({ nvr, ch, path: join(fairRoot, `late-${n}-${nvr}-${ch}a.h264`), startMs: from - 10 * MIN, endMs: from, bytes: 1000, keyframes: 10, loc: 'L1' })
    idx.addSegment({ nvr, ch, path: join(fairRoot, `late-${n}-${nvr}-${ch}b.h264`), startMs: from + 3 * MIN, endMs: from + 13 * MIN, bytes: 1000, keyframes: 10, loc: 'L1' })
    return idx.backfillNote({ nvr, ch, fromMs: from, toMs: from + 3 * MIN, reason: null, kind: 'unknown' }, NOW)
  }
  const ERR = bf.ERROR_BACKOFF_MS
  const LADDER = [5, 10, 20, 40, 80, 120, 120, 120].map((m) => m * MIN) // the error ladder's steps
  /** Each gap at least its step of the ladder, and no more than `slack` over it (ticks are 30 s apart). */
  const onLadder = (gaps, steps = LADDER, slack = 2 * MIN) => gaps.length > 0 && gaps.every((g, i) => g >= steps[i] && g < steps[i] + slack)
  const gapsOf = (at) => at.slice(1).map((t, i) => t - at[i])

  {
    // The oldest hole's pull always throws; a fillable hole on the same NVR, one on another.
    nowBox.t = NOW
    const { idx, rows, job, pulls } = setup([['nvr-1', 1, 20], ['nvr-1', 2, 19], ['nvr-2', 3, 18]])
    refusing(idx, 'addSegment', (s) => s.ch === 1)
    let first = null
    const said = await warnings(() =>
      runArmed(job, 3 * HOUR, (i) => {
        if (i === 0) first = { what: job.last.what, failure: job.status().state.lastFailure, holeUntil: job.nextTry.get(rows[0].id), nvrUntil: job.nvrBackoff.get('nvr-1'), armedMs: job.timer?._idleTimeout }
      })
    )
    const on = (ch) => pulls.filter((p) => p.ch === ch)
    check('a pull that throws: the oldest hole is pulled first, and the job goes on a tick later', pulls[0]?.ch === 1 && pulls[0].atMs === 0 && first?.armedMs === job.tickMs, `${J(pulls.slice(0, 2))} armed ${first?.armedMs}`)
    check('a pull that throws: the hole and its NVR each wait the first step of a ladder of their own', first?.nvrUntil === NOW + ERR[0] && first?.holeUntil === NOW + ERR[0], `NVR ${(first?.nvrUntil - NOW) / MIN} min, hole ${(first?.holeUntil - NOW) / MIN} min`)
    check('a pull that throws: what the job is doing names the hole, the fault and both waits', first?.what === 'nvr-1/2: the fill failed part-way (the index refused the write); that hole is left alone for 5 min and nvr-1 for 5 min; the next run is in 30 s', first?.what)
    check('a pull that throws: so does the journal, with where it was thrown from', said[0]?.startsWith(`[backfill] ${first?.what}\n`) && /\n\s+at /.test(said[0]), said[0]?.split('\n').slice(0, 3).join(' / '))
    check('a pull that throws: the last failure in the status says which hole and how many times', J(first?.failure) === J({ at: NOW, message: 'the index refused the write', inARow: 1, hole: 'nvr-1/2', holeThrows: 1 }), J(first?.failure))
    check('a pull that throws: the next pull is on the other NVR, a tick later', pulls[1]?.nvr === 'nvr-2' && pulls[1].atMs < 2 * MIN && idx.backfillRow(rows[2].id).state === 'filled', J(pulls.slice(0, 3)))
    const second = pulls.find((p) => p.nvr === 'nvr-1' && p.atMs > 0)
    check('a pull that throws: nothing is pulled from its NVR until that has rested', second != null && second.atMs >= ERR[0] && second.atMs < ERR[0] + MIN, J(pulls.slice(0, 4)))
    // (both holes are due then: the one that threw is the older, and still goes after the other)
    check('a pull that throws: when its NVR is asked again the OTHER hole on it goes first, and is filled', second?.ch === 2 && on(2).length === 1 && idx.backfillRow(rows[1].id).state === 'filled', J(pulls.slice(0, 4)))
    // the hole itself, with nothing else left to pull: 5, 10, 20, 40, 80 min apart
    check('a pull that throws: the hole is still tried, each time after a longer wait', on(1).length === 6 && onLadder(gapsOf(on(1).map((p) => p.atMs))), J(on(1).map((p) => p.atMs / MIN)))
    check('a pull that throws: every throw is counted, in memory and in the status (the ledger was not written)', on(1).length > 1 && job.pullThrows.get(rows[0].id) === on(1).length && job.status().state.errors === on(1).length && job.status().state.lastFailure?.holeThrows === on(1).length && idx.backfillRow(rows[0].id).state === 'pending' && idx.backfillRow(rows[0].id).attempts === 0, `${job.pullThrows.get(rows[0].id)} throws, ${J(job.status().state.lastFailure)}, ${J(idx.backfillRow(rows[0].id))}`)
    idx.close()
  }
  {
    // TWO holes that always throw, both older than a hole that fills, all on one NVR. Timing alone (the
    // second repair: a hole waits twice its NVR's rest) let the two take turns for good: whenever the
    // NVR had rested, one of them was due again, and older. 0 pulls of the good hole in 7 days. A hole
    // that has thrown goes after every hole that has not, whatever their ages.
    nowBox.t = NOW
    const { idx, rows, job, pulls } = setup([['nvr-1', 1, 20], ['nvr-1', 4, 19.5], ['nvr-1', 2, 19]])
    refusing(idx, 'addSegment', (s) => s.ch !== 2 && pulled(s))
    await warnings(() => runArmed(job, 3 * HOUR))
    const chs = pulls.map((p) => p.ch)
    const good = pulls.find((p) => p.ch === 2)
    check('two holes that always throw, older than one that fills: each is tried once, then the good one', J(chs.slice(0, 3)) === J([1, 4, 2]), J(chs))
    check('  ... as soon as the NVR has rested from the two throws (5 and 10 min), and it is filled', good?.atMs >= 15 * MIN && good.atMs < 16 * MIN && idx.backfillRow(rows[2].id).state === 'filled', `${good?.atMs / MIN} min, ${idx.backfillRow(rows[2].id).state}`)
    const rest = chs.slice(3)
    check('  ... and the two that throw then take turns, each still tried', rest.length >= 4 && rest.every((c, i) => c !== 2 && (i === 0 || c !== rest[i - 1])), J(rest))
    idx.close()
  }
  {
    // A CAMERA whose holes all throw (it has five here: the three noted and the stretches between
    // them, which the scan finds), older than ten holes of other cameras that fill. Tried hole by hole,
    // the camera's five would rest the NVR 5, 10, 20, 40 and 80 minutes before the first of the ten
    // was pulled, and a camera has dozens of holes. After one throw the camera's other holes go after
    // those of cameras that have not thrown.
    nowBox.t = NOW
    const { idx, rows, job, pulls } = setup([['nvr-1', 1, 20], ['nvr-1', 1, 19.9], ['nvr-1', 1, 19.8], ...Array.from({ length: 10 }, (_, i) => ['nvr-1', i + 2, 19 - i / 10])])
    refusing(idx, 'addSegment', (s) => s.ch === 1 && pulled(s))
    await warnings(() => runArmed(job, 3 * HOUR))
    const chs = pulls.map((p) => p.ch)
    const filled = rows.slice(3).filter((r) => idx.backfillRow(r.id).state === 'filled').length
    const lastGood = pulls.findLast((p) => p.ch !== 1)
    check('a camera whose holes all throw, ten holes of other cameras behind it: one throw, then the ten', chs[0] === 1 && chs.slice(1, 11).every((c) => c !== 1) && new Set(chs.slice(1, 11)).size === 10, J(chs.slice(0, 14)))
    check('  ... all ten filled, from the moment the NVR has rested from that one throw', filled === 10 && pulls[1]?.atMs >= ERR[0] && pulls[1].atMs < ERR[0] + MIN && lastGood?.atMs < 15 * MIN, `${filled} filled, between ${pulls[1]?.atMs / MIN} and ${lastGood?.atMs / MIN} min`)
    // (its other holes are tried once the ten are done, each one before any is tried twice)
    const after = pulls.slice(11)
    const ids = new Set(after.slice(0, 4).map((p) => p.fromMs))
    check('  ... and the camera\'s own holes are still tried after them, a different one each time', after.length >= 4 && after.every((p) => p.ch === 1) && ids.size === 4, J(after.map((p) => [p.ch, p.atMs / MIN])))
    idx.close()
  }
  {
    // ... also when the hole that has not thrown is far down the ledger: the pick reads a page of rows
    // at a time and used to stop at the first page with a hole it could pull
    nowBox.t = NOW
    // (three pages of rows: the oldest hole on the first, 1,100 that are waiting, and a hole that can
    // be pulled among those of the second page, so that "reads on" and "reads to the end" differ)
    const { idx, rows, job } = setup([['nvr-1', 1, 25]])
    const waiting = []
    for (let i = 0; i < 2 * bf.PICK_PAGE + 100; i++) waiting.push(idx.backfillNote({ nvr: 'nvr-1', ch: 40, fromMs: NOW - 20 * DAY + i * MIN, toMs: NOW - 20 * DAY + i * MIN + 30_000, reason: null, kind: 'unknown' }, NOW).id)
    for (const id of waiting) job.nextTry.set(id, NOW + DAY)
    const far = addHole(idx, 'nvr-1', 2, 20 - (bf.PICK_PAGE + 200.5) / 1440) // between the 700th and the 701st of them
    let pages = 0
    const page = idx.backfillPendingPage.bind(idx)
    idx.backfillPendingPage = (o) => (pages++, page(o))
    const picked = async () => {
      pages = 0
      const got = await job.pick(NOW)
      return `${got.row?.id === rows[0].id ? 'the oldest' : got.row?.id === far.id ? 'the far one' : got.row?.id} after ${pages} page(s)`
    }
    const plain = await picked()
    check('the pick: the oldest hole it can pull, found on the first page, ends the reading there', plain === 'the oldest after 1 page(s)', plain)
    job.pullThrows.set(rows[0].id, 1)
    const afterThrow = await picked()
    check('the pick: once that hole has thrown it reads on, takes a hole that has not, and stops at that one\'s page', afterThrow === 'the far one after 2 page(s)', afterThrow)
    job.pullThrows.delete(rows[0].id)
    job.camThrows.set('nvr-1/1', 1)
    const afterCamera = await picked()
    check('the pick: the same when it is the hole\'s camera that has thrown, and not the hole', afterCamera === 'the far one after 2 page(s)', afterCamera)
    // both have thrown: no page ends the reading, the one that threw less goes first, then the older
    job.camThrows.clear()
    job.pullThrows.set(rows[0].id, 2)
    job.pullThrows.set(far.id, 1)
    const fewer = await picked()
    job.pullThrows.set(far.id, 2)
    const older = await picked()
    job.pullThrows.delete(far.id)
    job.pullThrows.delete(rows[0].id)
    job.camThrows.set('nvr-1/1', 2)
    job.camThrows.set('nvr-1/2', 1)
    const fewerByCamera = await picked()
    check('the pick: of two holes that have thrown, on different pages, the one that threw less; with as many, the older', fewer === 'the far one after 3 page(s)' && older === 'the oldest after 3 page(s)', `${fewer} | ${older}`)
    check('the pick: ... and of two whose cameras have, the one whose camera threw less', fewerByCamera === 'the far one after 3 page(s)', fewerByCamera)
    job.camThrows.clear()
    // the place at the back is for a while, not for good: the holes of a camera that threw have
    // theirs by age again 20 hours after the throw (40 after a second, up to 8 days), the hole that
    // threw twice as long after it
    const LAST = bf.THROWN_LAST_MS[0]
    job.camThrows.set('nvr-1/1', 1)
    job.camThrowAt.set('nvr-1/1', NOW - LAST + 1)
    const camNotYet = await picked()
    job.camThrowAt.set('nvr-1/1', NOW - LAST)
    const camLapsed = await picked()
    job.camThrows.set('nvr-1/1', 2)
    const camTwice = await picked()
    job.camThrowAt.set('nvr-1/1', NOW - 2 * LAST)
    const camTwiceLapsed = await picked()
    job.camThrows.set('nvr-1/1', 30)
    job.camThrowAt.set('nvr-1/1', NOW - 8 * DAY + 1)
    const camMany = await picked()
    job.camThrowAt.set('nvr-1/1', NOW - 8 * DAY)
    const camManyLapsed = await picked()
    check('the pick: the holes of a camera that threw go last for 20 hours, then have their place by age again', LAST === 20 * HOUR && camNotYet === 'the far one after 2 page(s)' && camLapsed === 'the oldest after 1 page(s)', `${camNotYet} | ${camLapsed}`)
    check('the pick: ... twice as long after a second throw, and never longer than 8 days', camTwice === 'the far one after 2 page(s)' && camTwiceLapsed === 'the oldest after 1 page(s)' && camMany === 'the far one after 2 page(s)' && camManyLapsed === 'the oldest after 1 page(s)', `${camTwice} | ${camTwiceLapsed} | ${camMany} | ${camManyLapsed}`)
    job.camThrows.clear()
    job.camThrowAt.clear()
    job.pullThrows.set(rows[0].id, 1)
    job.pullThrowAt.set(rows[0].id, NOW - 2 * LAST + 1)
    const notYet = await picked()
    job.pullThrowAt.set(rows[0].id, NOW - 2 * LAST)
    const lapsed = await picked()
    job.pullThrows.set(rows[0].id, 2)
    const twice = await picked()
    job.pullThrowAt.set(rows[0].id, NOW - 4 * LAST)
    const twiceLapsed = await picked()
    check('the pick: the hole that threw goes last for twice as long as that: 40 hours, 80 after a second throw', notYet === 'the far one after 2 page(s)' && lapsed === 'the oldest after 1 page(s)' && twice === 'the far one after 2 page(s)' && twiceLapsed === 'the oldest after 1 page(s)', `${notYet} | ${lapsed} | ${twice} | ${twiceLapsed}`)
    job.pullThrows.delete(rows[0].id)
    job.pullThrowAt.delete(rows[0].id)
    // a camera's wait after a throw holds every hole of the camera, also one with no wait of its own
    job.camBackoff.set('nvr-1/1', NOW + 1)
    const camWaits = await picked()
    job.camBackoff.set('nvr-1/1', NOW)
    const camWaited = await picked()
    check('the pick: a hole whose camera is waiting after a throw is not picked until that wait is over', camWaits === 'the far one after 2 page(s)' && camWaited === 'the oldest after 1 page(s)', `${camWaits} | ${camWaited}`)
    job.camBackoff.clear()
    job.pullThrows.set(rows[0].id, 1)
    job.nextTry.set(far.id, NOW + DAY)
    const alone = await picked()
    check('the pick: with nothing else to pull, the hole that has thrown is still picked', alone === 'the oldest after 3 page(s)', alone)
    idx.close()
  }
  {
    // Two holes of one camera, the older always throwing (fifth review). Once a second hole of the
    // camera has also thrown, camThrows runs a step ahead of the bad hole's own count, so the hole's
    // 2x lapse and the camera's 1x lapse end at the same moment; without holding the hole for the
    // camera's 2x lapse the bad hole (the camera's oldest) is picked first every time, throws, and
    // its siblings never get a turn. Driven at the pick: counts and their times set by hand.
    nowBox.t = NOW
    const { idx, rows, job } = setup([['nvr-1', 1, 20], ['nvr-1', 1, 19], ['nvr-1', 2, 18]])
    const [bad, sibling] = rows
    const H = bf.THROWN_LAST_MS[0] // 20 h, the lapse's first step (the pick's order runs on THIS, not the minute ladder)
    const at = async (hrs) => (await job.pick(NOW + hrs * (H / 20))).row?.id
    // the bad hole has thrown once; a sibling of its camera has thrown too, so the camera's count is 2
    job.pullThrows.set(bad.id, 1)
    job.pullThrowAt.set(bad.id, NOW)
    job.camThrows.set('nvr-1/1', 2)
    job.camThrowAt.set('nvr-1/1', NOW)
    // own 2x lapse = 2*backoffMs(1) = 40 h; the camera's handed (1x) lapse = backoffMs(2) = 40 h, so
    // both end at 40 h; the camera's 2x lapse = 80 h now holds the bad hole past that.
    const held = await at(41)
    const freed = await at(81)
    check('two holes of one camera, the older throwing: while the camera\'s longer lapse runs the sibling leads, not the bad hole', held === sibling.id, `picked ${held === sibling.id ? 'the sibling' : held === bad.id ? 'the bad hole' : held} at +41 h`)
    check('  ... and once that lapse is over too the bad hole takes its place by age again', freed === bad.id, `picked ${freed === bad.id ? 'the bad hole' : freed} at +81 h`)
    // one count deeper (the hole 2, the camera 3): own 2x = 80 h, camera 1x = 80 h, camera 2x = 160 h
    job.pullThrows.set(bad.id, 2)
    job.camThrows.set('nvr-1/1', 3)
    const held2 = await at(81)
    check('  ... the same one count deeper (hole 2, camera 3): the sibling still leads while the camera\'s 2x lapse runs', held2 === sibling.id, `picked ${held2 === sibling.id ? 'the sibling' : held2} at +81 h`)
    idx.close()
  }
  for (const [what, always] of [['one write refused, once', false], ['one hole that always throws', true]]) {
    // The place at the back is for a while, not for good. A standing backlog (a hole of another camera
    // due at every tick, one pulled an hour, for two days) and camera 2 with the two oldest holes in
    // the ledger; the pull of the older one throws. With the place at the back lasting until footage
    // of that camera got into the index, neither hole was pulled again while the backlog stood: they
    // aged out on the NVR, the second never asked for.
    //   20 hours on, the camera's other hole has its place by age again: pulled next, and filled;
    //   40 hours on, the hole that threw has: pulled next, and filled, unless it throws again.
    nowBox.t = NOW
    const { idx, rows, job, pulls } = setup([['nvr-1', 1, 20], ['nvr-1', 1, 20 - 23 / 1440], ...Array.from({ length: 50 }, (_, i) => ['nvr-1', i + 2, 10 - i / 100])])
    job.settings = () => ({ backfill: { ...cfg, restSeconds: 3600 } })
    let refused = 0
    refusing(idx, 'addSegment', (s) => s.ch === 1 && pulled(s) && s.startMs < rows[0].toMs && (always || refused++ === 0))
    const said = await warnings(() => runArmed(job, 45 * HOUR))
    const ours = pulls.filter((p) => p.ch === 1).map((p) => [p.fromMs === rows[0].fromMs ? 'the older' : 'the other', p.atMs / HOUR])
    const others = pulls.filter((p) => p.ch !== 1)
    if (always) {
      // its second throw: the camera's count started again when the other hole was filled, the hole's
      // own did not, so the wait is the hole's (its second step), counted, like its place at the
      // back, from this throw and not from the first
      const second = NOW + pulls.filter((p) => p.ch === 1)[2]?.atMs
      check('one hole that always throws: at its second throw it waits its own second step (10 min), though its camera\'s count is back at 1', job.nextTry.get(rows[0].id) === second + bf.backoffMs(2, ERR) && job.camBackoff.get('nvr-1/1') === second + ERR[0] && job.camThrows.get('nvr-1/1') === 1 && /that hole is left alone for 10 min and nvr-1 for 5 min/.test(said[1] ?? ''), `hole ${(job.nextTry.get(rows[0].id) - second) / MIN} min, camera ${(job.camBackoff.get('nvr-1/1') - second) / MIN} min; ${said[1]?.split('\n')[0]}`)
      check('  ... and the times kept for the place at the back are those of this throw', job.pullThrowAt.get(rows[0].id) === second && job.camThrowAt.get('nvr-1/1') === second, `hole ${(job.pullThrowAt.get(rows[0].id) - NOW) / HOUR} h, camera ${(job.camThrowAt.get('nvr-1/1') - NOW) / HOUR} h`)
    }
    check(`${what}, behind a standing backlog: the hole is pulled once, then the backlog goes on (a hole an hour)`, ours[0]?.[0] === 'the older' && ours[0][1] === 0 && others.length >= 40 && others.filter((p) => p.atMs < 20 * HOUR).length >= 18, `${J(ours)}, ${others.length} of other cameras`)
    check(`  ... 20 hours on, the camera's other hole has its place again: it is the next one pulled, and is filled`, ours[1]?.[0] === 'the other' && ours[1][1] >= 20 && ours[1][1] < 21.2 && idx.backfillRow(rows[1].id).state === 'filled', `${J(ours)} ${idx.backfillRow(rows[1].id).state}`)
    check(`  ... 40 hours on, so has the hole that threw: pulled next${always ? ', throws again, and is at the back for twice as long' : ', and filled'}`, ours.length === 3 && ours[2][0] === 'the older' && ours[2][1] >= 40 && ours[2][1] < 41.3 && (always ? idx.backfillRow(rows[0].id).state === 'pending' && job.pullThrows.get(rows[0].id) === 2 : idx.backfillRow(rows[0].id).state === 'filled' && !job.pullThrows.has(rows[0].id) && !job.pullThrowAt.has(rows[0].id)), `${J(ours)} ${idx.backfillRow(rows[0].id).state}, throws ${job.pullThrows.get(rows[0].id)}`)
    idx.close()
  }
  {
    // A camera whose every pull throws waits on a ladder of its own. Its holes are many, each new to
    // the pick, and with no wait for the camera one of them was pulled, and threw, whenever nothing
    // else was due: every 7.5 minutes all night while a few good fills kept the NVR's count at one,
    // each pull leaving files the index does not know. Here: camera 2 has eight holes; a hole of
    // another camera turns up every 6 minutes and is filled.
    nowBox.t = NOW
    const { idx, job, pulls } = setup(Array.from({ length: 8 }, (_, i) => ['nvr-1', 1, 20 - (i * 23) / 1440]))
    refusing(idx, 'addSegment', (s) => s.ch === 1 && pulled(s))
    const turnedUp = []
    const said = await warnings(() =>
      runArmed(job, 3 * HOUR, () => {
        while (turnedUp.length * 6 * MIN <= nowBox.t - NOW) turnedUp.push(addHole(idx, 'nvr-1', 100 + turnedUp.length, 5 - turnedUp.length / 100))
      })
    )
    const bad = pulls.filter((p) => p.ch === 1)
    const filled = turnedUp.filter((r) => idx.backfillRow(r.id).state === 'filled').length
    check('a camera whose pulls all throw, other holes turning up all the while: it is asked again only after 5, 10, 20, 40, 80 min', bad.length === 6 && gapsOf(bad.map((p) => p.atMs)).every((g, i) => g >= LADDER[i] && g < LADDER[i] + 8 * MIN), J(bad.map((p) => p.atMs / MIN)))
    check('  ... a different hole of it each time, and the count that sets the wait is the camera\'s (kept with the time of its last throw)', new Set(bad.map((p) => p.fromMs)).size === 6 && job.camThrows.get('nvr-1/1') === 6 && job.camThrowAt.get('nvr-1/1') === NOW + bad.at(-1).atMs && [...job.pullThrows.values()].every((n) => n === 1), `${new Set(bad.map((p) => p.fromMs)).size} holes, camera ${job.camThrows.get('nvr-1/1')}, holes ${J([...job.pullThrows.values()])}`)
    check('  ... while the holes that turned up were filled', turnedUp.length >= 29 && filled >= turnedUp.length - 2, `${filled} of ${turnedUp.length}`)
    // (the wait it reports for the hole is the one that holds it: its camera's, 20 min at the third throw, not its own 5)
    const third = said[2]?.split(String.fromCharCode(10))[0]
    check('  ... and the third throw says how long that hole is in fact left alone: its camera\'s wait', third === '[backfill] nvr-1/2: the fill failed part-way (the index refused the write); that hole is left alone for 20 min and nvr-1 for 5 min; the next run is in 30 s', third)
    idx.close()
  }
  {
    // What clears which count. A fill() that returns clears the hole's own count, whatever it returns
    // with. It does not clear the camera's or the NVR's unless footage got into the index: here the
    // camera's first pull throws and its later ones play nothing (a failure fill() returns).
    nowBox.t = NOW
    const plays = fakeLeg()
    const nothing = fakeLeg({ silent: true })
    let legs = 0
    const { idx, rows, job, pulls } = setup([['nvr-1', 1, 20], ['nvr-1', 1, 20 - 23 / 1440]], { legOf: () => (legs++ === 0 ? plays : nothing) })
    refusing(idx, 'addSegment', pulled)
    const seen = []
    await warnings(() =>
      runArmed(job, 9 * MIN, () => {
        if (pulls.length > seen.length) seen.push({ hole: job.pullThrows.get(rows[0].id) ?? 0, camera: job.camThrows.get('nvr-1/1') ?? 0, nvr: job.nvrThrows.get('nvr-1') ?? 0 })
      })
    )
    check('a pull that throws, then two of the same camera that play nothing: after the throw each count is 1', pulls.length === 3 && J(seen[0]) === J({ hole: 1, camera: 1, nvr: 1 }), `${pulls.length} pulls, ${J(seen)}`)
    check('  ... the other hole playing nothing leaves all three as they are', J(seen[1]) === J({ hole: 1, camera: 1, nvr: 1 }) && pulls[1]?.fromMs === rows[1].fromMs, J(seen))
    check('  ... the hole that threw, playing nothing itself, clears its own count and neither of the others', J(seen[2]) === J({ hole: 0, camera: 1, nvr: 1 }) && pulls[2]?.fromMs === rows[0].fromMs && !job.pullThrowAt.has(rows[0].id) && job.camThrowAt.has('nvr-1/1') && job.camBackoff.has('nvr-1/1'), J(seen))
    idx.close()
  }
  {
    // ... and footage in the index means the whole pull's: with the second segment of every pull
    // refused, the first one getting in clears nothing, and the NVR's ladder climbs
    nowBox.t = NOW
    const plays = fakeLeg()
    let segment = 0
    const { idx, job, pulls } = setup([['nvr-1', 1, 20], ['nvr-1', 2, 19.9], ['nvr-1', 3, 19.8], ['nvr-1', 4, 19.7]], {
      legOf: () => (o) => {
        segment = 0
        return plays(o)
      }
    })
    const fault = refusing(idx, 'addSegment', (s) => pulled(s) && ++segment === 2)
    await warnings(() => runArmed(job, 36 * MIN))
    check('the second segment of every pull refused: the first getting in does not start the NVR\'s count again (5, 10, 20 min)', pulls.length === 4 && fault.fired === 4 && onLadder(gapsOf(pulls.map((p) => p.atMs))) && J(pulls.map((p) => p.ch)) === J([1, 2, 3, 4]) && job.nvrThrows.get('nvr-1') === 4, `${J(pulls.map((p) => [p.ch, p.atMs / MIN]))}, refused ${fault.fired}, the NVR's count ${job.nvrThrows.get('nvr-1')}`)
    idx.close()
  }
  {
    // ... and it is the footage that counts, not whether the hole got shorter: a pull whose footage
    // all lies before the hole is a failed try for the hole (report 9), and still shows that this end
    // can index footage of that camera from that NVR
    nowBox.t = NOW
    const { idx, rows, job, pulls } = setup([['nvr-1', 1, 20]], { legOf: () => fakeLeg({ span: (from) => [from - 3 * MIN, from - MIN] }) })
    job.nvrThrows.set('nvr-1', 3)
    job.camThrows.set('nvr-1/1', 2)
    job.camThrowAt.set('nvr-1/1', NOW - MIN)
    job.camBackoff.set('nvr-1/1', NOW - 1)
    job.pullThrows.set(rows[0].id, 2)
    job.pullThrowAt.set(rows[0].id, NOW - MIN)
    await warnings(() => runArmed(job, 1))
    check('a pull that indexed footage and did not shorten the hole: a failed try for the hole, and every count is cleared', pulls.length === 1 && idx.backfillRow(rows[0].id).attempts === 1 && idx.backfillRow(rows[0].id).state === 'pending' && job.nvrThrows.size === 0 && job.camThrows.size === 0 && job.camThrowAt.size === 0 && job.camBackoff.size === 0 && job.pullThrows.size === 0 && job.pullThrowAt.size === 0, `${J(idx.backfillRow(rows[0].id))}; nvr ${job.nvrThrows.size}, camera ${job.camThrows.size}/${job.camThrowAt.size}/${job.camBackoff.size}, hole ${job.pullThrows.size}/${job.pullThrowAt.size}`)
    idx.close()
  }
  {
    // a run that fails before any pull, on a job whose last failure was a pull that threw: it is said
    // as a failed run, and the status does not name the hole of the earlier one
    nowBox.t = NOW
    const { idx, job } = setup([['nvr-1', 1, 20]])
    let refusedOnce = 0
    refusing(idx, 'addSegment', (s) => pulled(s) && refusedOnce++ === 0)
    const scan = job.scan.bind(job)
    let scans = 0
    job.scan = async (o) => {
      if (++scans === 2) throw new Error('the index is busy')
      return scan(o)
    }
    const failures = []
    const said = await warnings(() => runArmed(job, MIN, () => failures.push(job.status().state.lastFailure)))
    check('a pull that throws, then a run that fails before any pull: the second is said as a failed run', said.length === 2 && /^\[backfill\] nvr-1\/2: the fill failed part-way/.test(said[0]) && said[1] === '[backfill] a run failed (the index is busy); trying again in 60 s', J(said.map((l) => l.split('\n')[0])))
    check('  ... and the status names the hole for the first only', failures[0]?.hole === 'nvr-1/2' && failures[0].holeThrows === 1 && J(failures[1]) === J({ at: NOW + 30_000, message: 'the index is busy', inARow: 2, hole: null, holeThrows: null }), J(failures.slice(0, 2)))
    idx.close()
  }
  {
    // The fault is at this end: every pull throws, on every NVR. The first repair waited a flat five
    // minutes each time (the count it read is one fill() writes, and fill() had thrown): 24 pulls per
    // NVR in two hours, each leaving files the index does not know. Each NVR on its own ladder: 5.
    nowBox.t = NOW
    const { idx, job, pulls } = setup([['nvr-1', 1, 20], ['nvr-1', 2, 19], ['nvr-2', 3, 18], ['nvr-2', 4, 17]])
    refusing(idx, 'addSegment', pulled)
    let armedToTheEnd = false
    await warnings(async () => (armedToTheEnd = await runArmed(job, 2 * HOUR)))
    for (const nvr of ['nvr-1', 'nvr-2']) {
      const at = pulls.filter((p) => p.nvr === nvr).map((p) => p.atMs)
      check(`every pull throws: ${nvr} is asked again only after 5, 10, 20, 40 min`, at.length === 5 && onLadder(gapsOf(at)), J(at.map((t) => t / MIN)))
      const chs = pulls.filter((p) => p.nvr === nvr).map((p) => p.ch)
      check(`every pull throws: ${nvr}'s two holes take turns`, chs.length === 5 && chs.every((c, i) => i === 0 || c !== chs[i - 1]), J(chs))
    }
    check('every pull throws: the job is still armed when the two hours are up, and has counted each one', armedToTheEnd === true && pulls.length === 10 && job.status().state.errors === pulls.length && job.status().state.lastFailure?.message === 'the index refused the write', `armed to the end ${armedToTheEnd}, ${J(job.status().state)}`)
    idx.close()
  }
  {
    // ... and on, past where the ladder ends: two holes, every pull throwing, 16 hours. The NVR is
    // asked every two hours from then (not less often, not more), still for each hole in turn. Then a
    // hole that can be filled turns up: it is pulled the next time the NVR is asked, before either.
    nowBox.t = NOW
    const { idx, job, pulls } = setup([['nvr-1', 1, 20], ['nvr-1', 2, 19]])
    refusing(idx, 'addSegment', (s) => s.ch <= 2 && pulled(s))
    let late = null
    let pullsThen = 0
    await warnings(() =>
      runArmed(job, 16 * HOUR, () => {
        if (late || nowBox.t - NOW < 12 * HOUR) return
        late = addHole(idx, 'nvr-1', 9, 5)
        pullsThen = pulls.length
      })
    )
    const before = pulls.slice(0, pullsThen)
    check('every pull throws, for 12 hours: the NVR is asked after 5, 10, 20, 40, 80 min and then every 2 hours', before.length === 10 && onLadder(gapsOf(before.map((p) => p.atMs)), [...LADDER, 120 * MIN]), J(before.map((p) => p.atMs / MIN)))
    check('  ... for each of its two holes in turn, all the way', before.every((p, i) => p.ch === (i % 2 ? 2 : 1)), J(before.map((p) => p.ch)))
    check('  ... and a hole that can be filled, turning up then, is the next one pulled, and is filled', late != null && pulls[pullsThen]?.ch === 9 && idx.backfillRow(late.id).state === 'filled', J(pulls.slice(pullsThen).map((p) => [p.ch, p.atMs / MIN])))
    idx.close()
  }
  {
    // Only footage that got into the index starts an NVR's count again. A fill() that returns with a
    // failure of its own (the NVR played nothing for that hole) says nothing about whether this end
    // can index: with every pulled segment refused and every other hole playing nothing, the count was
    // cleared at each of those and the NVR was pulled every five minutes, all day (232 pulls in 24 h
    // against 16), each one leaving files the index does not know.
    nowBox.t = NOW
    const { idx, job, pulls } = setup(Array.from({ length: 12 }, (_, i) => ['nvr-1', i + 1, 20 - i / 10]), { legOf: (nvr, ch) => (ch % 2 ? null : fakeLeg({ silent: true })) })
    refusing(idx, 'addSegment', pulled)
    const threw = []
    await warnings(() =>
      runArmed(job, 2 * HOUR, () => {
        const f = job.status().state.lastFailure
        if (f && f.at !== threw.at(-1)) threw.push(f.at)
      })
    )
    check('every pulled segment refused, every other hole playing nothing: the pulls that throw stay on the NVR\'s ladder', threw.length >= 4 && threw.length <= 6 && gapsOf(threw).every((g, i) => g >= LADDER[i]), `${J(threw.map((t) => (t - NOW) / MIN))}, ${pulls.length} pulls in all`)
    check('  ... while the holes that play nothing are still asked for in between', pulls.some((p) => p.ch % 2 === 0), J(pulls.map((p) => p.ch)))
    idx.close()
  }
  {
    // ... and only on THAT NVR: another NVR's holes filling says nothing about this one
    nowBox.t = NOW
    const { idx, rows, job, pulls } = setup([['nvr-1', 1, 20], ['nvr-1', 2, 19], ['nvr-2', 3, 18]])
    refusing(idx, 'addSegment', (s) => s.nvr === 'nvr-1' && pulled(s))
    let afterOther = null
    await warnings(() =>
      runArmed(job, 2 * HOUR, (i) => {
        if (i === 1) afterOther = { last: pulls.at(-1)?.nvr, state: idx.backfillRow(rows[2].id).state, count: job.nvrThrows.get('nvr-1'), camera: job.camThrows.get('nvr-1/1') }
      })
    )
    const at = pulls.filter((p) => p.nvr === 'nvr-1').map((p) => p.atMs)
    check('one NVR throwing, another filling: the fill on the other leaves this one\'s count, and its camera\'s, as they are', J(afterOther) === J({ last: 'nvr-2', state: 'filled', count: 1, camera: 1 }), J(afterOther))
    check('  ... so this one is still asked again only after 5, 10, 20, 40 min', at.length === 5 && onLadder(gapsOf(at)), J(at.map((t) => t / MIN)))
    idx.close()
  }
  {
    // a hole that had failed before: the throws count on top of the tries in the ledger
    nowBox.t = NOW
    const { idx, rows, job } = setup([['nvr-1', 1, 20]])
    idx.backfillSet(rows[0].id, { attempts: 2 })
    refusing(idx, 'addSegment', (s) => s.ch === 1)
    await warnings(() => runArmed(job, 1))
    check('a pull that throws on a hole with 2 failed tries: the hole waits as for its third, its NVR as for its first', job.nextTry.get(rows[0].id) === NOW + bf.backoffMs(3, ERR) && job.nvrBackoff.get('nvr-1') === NOW + ERR[0], `hole ${(job.nextTry.get(rows[0].id) - NOW) / MIN} min, NVR ${(job.nvrBackoff.get('nvr-1') - NOW) / MIN} min`)
    idx.close()
  }
  {
    // a pull that threw once and then goes through: the counts start again, for the hole and its NVR
    nowBox.t = NOW
    const { idx, rows, job, pulls } = setup([['nvr-1', 1, 20]])
    let refusals = 0
    refusing(idx, 'addSegment', () => refusals++ === 0)
    let afterFirst = null
    await warnings(() =>
      runArmed(job, HOUR, (i) => {
        if (i === 0) afterFirst = [job.pullThrows.get(rows[0].id), job.nvrThrows.get('nvr-1'), job.camThrows.get('nvr-1/1')]
      })
    )
    check('a pull that threw once and then goes through: the hole is filled at its second pull, after its wait', pulls.length === 2 && pulls[1].atMs >= ERR[0] && pulls[1].atMs < ERR[0] + MIN && idx.backfillRow(rows[0].id).state === 'filled', `${J(pulls)} ${J(idx.backfillRow(rows[0].id))}`)
    check('  and the throws counted for it, for its camera and for its NVR start again', J(afterFirst) === J([1, 1, 1]) && !job.pullThrows.has(rows[0].id) && !job.nvrThrows.has('nvr-1') && !job.camThrows.has('nvr-1/1'), `${J(afterFirst)} then ${job.pullThrows.get(rows[0].id)}, ${job.nvrThrows.get('nvr-1')}, ${job.camThrows.get('nvr-1/1')}`)
    idx.close()
  }
  {
    // The waits count from when the pull threw, not from when the tick began: a pull takes minutes
    // (12 here, on the clock), and a rest counted from before it was over before it began. The hole
    // that threw is not the next pull, and nothing is pulled from its NVR for five minutes after.
    nowBox.t = NOW
    const TOOK = 12 * MIN
    const plays = fakeLeg()
    const slowly = () => (o) => {
      nowBox.t += TOOK
      return plays(o)
    }
    const { idx, rows, job, pulls } = setup([['nvr-1', 1, 20], ['nvr-1', 2, 19]], { legOf: slowly })
    refusing(idx, 'addSegment', (s) => s.ch === 1 && pulled(s))
    let first = null
    await warnings(() =>
      runArmed(job, HOUR, (i) => {
        if (i === 0) first = { hole: job.nextTry.get(rows[0].id) - NOW, nvr: job.nvrBackoff.get('nvr-1') - NOW, what: job.last.what }
      })
    )
    check('a pull that took 12 minutes and then threw: the hole and its NVR wait from when it threw', first?.hole === TOOK + ERR[0] && first?.nvr === TOOK + ERR[0] && /left alone for 5 min and nvr-1 for 5 min/.test(first?.what ?? ''), `hole ${first?.hole / MIN} min, NVR ${first?.nvr / MIN} min after the tick began; ${first?.what}`)
    check('  ... so the next pull from that NVR is five minutes after the throw, and of its other hole', pulls[1]?.ch === 2 && pulls[1].atMs >= TOOK + ERR[0] && pulls[1].atMs < TOOK + ERR[0] + MIN, J(pulls.slice(0, 3).map((p) => [p.ch, p.atMs / MIN])))
    idx.close()
  }
  {
    // (the waits fill() sets itself count from the end of the leg as well: a refusal after 12 minutes)
    nowBox.t = NOW
    const TOOK = 12 * MIN
    const refuses = fakeLeg({ refuse: true })
    const { idx, rows, job } = setup([['nvr-1', 1, 20]], {
      legOf: () => (o) => {
        nowBox.t += TOOK
        return refuses(o)
      }
    })
    await warnings(() => runArmed(job, 1))
    const long = NOW + TOOK + bf.REFUSED_BACKOFF_MS[0]
    check('a refusal that took 12 minutes to come: the hole and the NVR stand down from when it came', job.nextTry.get(rows[0].id) === long && job.nvrBackoff.get('nvr-1') === long && idx.backfillRow(rows[0].id).attempts === 1, `hole ${(job.nextTry.get(rows[0].id) - NOW) / MIN} min, NVR ${(job.nvrBackoff.get('nvr-1') - NOW) / MIN} min`)
    idx.close()
  }
  {
    // the ledger refuses the write of a failed try (the NVR's search failed, the hole's fourth): the
    // wait fill() had worked out stands for the NVR, and is not cut to a first step. (The hole's is
    // the same either way here: the throw is counted on the same ladder.)
    nowBox.t = NOW
    const { idx, rows, job } = setup([['nvr-1', 1, 20]], {
      coverage: async () => {
        throw new Error('no answer')
      }
    })
    idx.backfillSet(rows[0].id, { attempts: 3 })
    refusing(idx, 'backfillSet', (id, fields) => id === rows[0].id && fields.lastError != null, 'the ledger refused the write')
    let armed = null
    let what = null
    await warnings(() =>
      runArmed(job, 1, () => {
        armed = job.timer?._idleTimeout
        what = job.last.what
      })
    )
    check('the ledger refuses a failed try: the back-off that try earned still stands for its NVR', job.nvrBackoff.get('nvr-1') === NOW + bf.backoffMs(4, ERR) && job.nextTry.get(rows[0].id) === NOW + bf.backoffMs(4, ERR), `hole ${(job.nextTry.get(rows[0].id) - NOW) / MIN} min, NVR ${(job.nvrBackoff.get('nvr-1') - NOW) / MIN} min`)
    check('  the waits it reports are the ones that stand', what === 'nvr-1/2: the fill failed part-way (the ledger refused the write); that hole is left alone for 40 min and nvr-1 for 40 min; the next run is in 30 s', what)
    check('  and the job goes on', armed === job.tickMs && job.status().state.lastFailure?.message === 'the ledger refused the write', `armed ${armed}, ${J(job.status().state.lastFailure)}`)
    idx.close()
  }
  {
    // the same for a search the NVR turned away (the long ladder, and the hole's own wait this time:
    // the throw alone would give it five minutes)
    nowBox.t = NOW
    const { idx, rows, job } = setup([['nvr-1', 1, 20]], { coverage: async () => ({ ranges: [], reason: 'the NVR is busy with other playback' }) })
    const fault = refusing(idx, 'backfillSet', (id, fields) => fields.lastError != null, 'the ledger refused the write')
    await warnings(() => runArmed(job, 1))
    // (that the write did throw is part of the check: the same wait is set when nothing goes wrong)
    check('the ledger refuses the note of a search turned away: the hole still waits the long ladder\'s first step', fault.fired === 1 && job.status().state.lastFailure?.message === 'the ledger refused the write' && idx.backfillRow(rows[0].id).attempts === 0 && job.nextTry.get(rows[0].id) === NOW + bf.REFUSED_BACKOFF_MS[0], `the write threw ${fault.fired}x; hole ${(job.nextTry.get(rows[0].id) - NOW) / MIN} min; ${J(job.status().state.lastFailure)}`)
    idx.close()
  }
  {
    // ... and after a refusal by the NVR in the leg: its long wait is the one that must not be lost
    nowBox.t = NOW
    const { idx, rows, job } = setup([['nvr-1', 1, 20], ['nvr-1', 2, 19]], { legOf: () => fakeLeg({ refuse: true }) })
    const fault = refusing(idx, 'backfillSet', (id, fields) => fields.lastError != null, 'the ledger refused the write')
    await warnings(() => runArmed(job, 1))
    const long = NOW + bf.REFUSED_BACKOFF_MS[0]
    check('the ledger refuses the note of a refusal: the hole and the whole NVR still stand down for the refusal\'s wait', fault.fired === 1 && job.status().state.lastFailure?.message === 'the ledger refused the write' && idx.backfillRow(rows[0].id).attempts === 0 && job.nextTry.get(rows[0].id) === long && job.nvrBackoff.get('nvr-1') === long, `the write threw ${fault.fired}x; hole ${(job.nextTry.get(rows[0].id) - NOW) / MIN} min, NVR ${(job.nvrBackoff.get('nvr-1') - NOW) / MIN} min`)
    idx.close()
  }
  {
    // the stack goes into the journal for the first failure in a row only: a fault that stays is a
    // line each time, not a stack each time
    nowBox.t = NOW
    const { idx, job } = setup([['nvr-1', 1, 20]])
    let scans = 0
    job.scan = async () => {
      if (++scans <= 3) throw new Error(`the index is busy (${scans})`)
    }
    const said = await warnings(() => runArmed(job, 5 * MIN))
    check('three failed runs in a row, then one that completes: three lines, the first with its stack, the others without', scans >= 4 && said.length === 3 && /\n\s+at /.test(said[0]) && !said[1].includes('\n') && !said[2].includes('\n') && said[2] === '[backfill] a run failed (the index is busy (3)); trying again in 120 s', J(said.map((l) => l.split('\n')[0])))
    idx.close()
  }
  {
    // a job stopped while the pull that throws was running: nothing arms it again, and what it says
    // names the hole and that the job is stopped, not when the next run is
    nowBox.t = NOW
    const { idx, job } = setup([['nvr-1', 1, 20]])
    refusing(idx, 'addSegment', (s) => pulled(s) && (job.stop('test'), true))
    let armed
    const said = await warnings(() => runArmed(job, HOUR, (i, was) => (armed = job.timer === was || job.timer === null ? 'nothing' : 'a timer')))
    check('stopped during a pull that throws: not armed again, and it says so', armed === 'nothing' && job.running === false && said.length === 1 && /^\[backfill\] nvr-1\/2: the fill failed part-way \(the index refused the write\); that hole is left alone for 5 min and nvr-1 for 5 min; the job is stopped\n/.test(said[0]), `${armed} armed; ${said[0]?.split('\n')[0]}`)
    idx.close()
  }
  {
    // nothing that goes wrong while a failed run is noted may end the job: here the journal throws once,
    // and the job says, the one more time it tries, that the failed run could not be recorded
    nowBox.t = NOW
    const { idx, job } = setup([['nvr-1', 1, 20]])
    job.scan = async () => {
      throw new Error('the index is busy')
    }
    job.resume()
    const armed = job.timer
    const fire = armed._onTimeout
    clearTimeout(armed)
    let rejected = null
    let calls = 0
    const said = await warnings(
      () => fire().catch((e) => (rejected = e)),
      (list, line) => {
        if (++calls === 1) throw new Error('the journal was busy')
        list.push(line)
      }
    )
    const st = job.status().state
    check('a failed run the journal refuses once: the timer\'s callback does not reject, and the next tick is armed', rejected === null && job.timer != null && job.timer !== armed && job.timer._idleTimeout === job.tickMs, `${String(rejected?.message ?? rejected)}, armed ${job.timer?._idleTimeout}`)
    check('  the failure is in the status, and the journal is told what it missed', st.errors === 1 && st.lastFailure?.message === 'the index is busy' && st.lastFailure.hole === null && J(said) === J(['[backfill] a failed run could not be recorded: the journal was busy']), `${J(st.lastFailure)} | ${J(said)}`)
    job.stop('test')
    idx.close()
  }
  {
    // ... and a journal that throws every time
    nowBox.t = NOW
    const { idx, job } = setup([['nvr-1', 1, 20]])
    job.scan = async () => {
      throw new Error('the index is busy')
    }
    job.resume()
    const armed = job.timer
    const fire = armed._onTimeout
    clearTimeout(armed)
    let rejected = null
    await warnings(
      () => fire().catch((e) => (rejected = e)),
      () => {
        throw new Error('the journal is closed')
      }
    )
    check('a failed run that cannot be logged at all: the callback does not reject, and the next tick is armed all the same', rejected === null && job.timer != null && job.timer !== armed && job.timer._idleTimeout === job.tickMs && job.status().state.errors === 1, `${String(rejected?.message ?? rejected)}, armed ${job.timer?._idleTimeout}`)
    job.stop('test')
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

// A tick that throws must not end the job. tick() arms the next one only on the paths it returns from,
// and the timer's catch only logged: one failure (the scan, the pick or a pull throwing) left a job that
// read as running and never ran again until someone stopped and started it, while the holes it could
// have filled aged out on the NVR (2026-10 code audit, H2).
{
  const pause = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (pred, ms = 5000) => {
    const t0 = Date.now()
    while (!pred() && Date.now() - t0 < ms) await pause(5)
    return pred()
  }
  const warned = [] // (the first line of each: the first failure in a row is logged with its stack)
  const realWarn = console.warn
  console.warn = (...a) => warned.push(a.join(' ').split('\n')[0])
  try {
    // the first scan throws, the ones after it find nothing to do
    let scans = 0
    const job = makeJob({ stateFile: 'rearm.json', extra: { tickMs: 20 } })
    job.scan = async () => {
      if (++scans === 1) throw new Error('the index is busy')
    }
    job.pick = async () => ({ row: null, why: 'nothing to fill' })
    job.start('test')
    await until(() => scans >= 3)
    check('a tick that throws is tried again: the job goes on running', scans >= 3, `${scans} scans`)
    const st = job.status().state
    check('  the failure is counted and logged', st.errors === 1 && warned.some((l) => /a run failed \(the index is busy\); trying again in/.test(l)), `${J(st)} | ${warned.join(' | ')}`)
    check('  and stays in the job state after later runs have written over what it is doing', st.what === 'nothing to fill' && st.lastFailure?.message === 'the index is busy' && st.lastFailure.inARow === 1 && st.lastFailure.at === NOW && st.failsInARow === 0, J(st))
    job.stop('test')
    const stoppedAt = scans
    await pause(120)
    check('  a stopped job stays stopped', scans === stoppedAt && job.timer === null, `${scans} vs ${stoppedAt}`)

    // every scan throws: the wait each tick was armed with doubles from one tick up to ten, and stays there
    // (the timer that is running a tick is still job.timer inside it; a wait of 0 reads as 1 ms)
    const waits = []
    const broken = makeJob({ stateFile: 'rearm-broken.json', extra: { tickMs: 20 } })
    broken.scan = async () => {
      waits.push(broken.timer?._idleTimeout)
      throw new Error('still broken')
    }
    broken.start('test')
    await until(() => waits.length >= 7)
    broken.stop('test')
    check('a fault that stays: each wait twice the last, from one tick up to ten ticks, then ten', J(waits.slice(0, 7)) === J([1, 20, 40, 80, 160, 200, 200]), J(waits))
    check('  and each failure is counted, with how many in a row', broken.status().state.errors === waits.length && broken.status().state.lastFailure?.inARow === waits.length && broken.status().state.failsInARow === waits.length, J(broken.status().state))

    // a run that completes starts the count again: fail, fail, a good run, fail, fail
    const seq = []
    const mixed = makeJob({ stateFile: 'rearm-mixed.json', extra: { tickMs: 20 } })
    mixed.scan = async () => {
      seq.push(mixed.timer?._idleTimeout)
      if (seq.length !== 3) throw new Error(`fault ${seq.length}`)
    }
    mixed.pick = async () => ({ row: null, why: 'nothing to fill' })
    mixed.start('test')
    await until(() => seq.length >= 5)
    mixed.stop('test')
    check('a run that completes starts the count again: waits of 1, 2 ticks, the ordinary tick, then 1 tick again', J(seq.slice(0, 5)) === J([1, 20, 40, 20, 20]), J(seq))

    // stopped while the failing tick was running: nothing arms it again, and it does not say it will try
    let late = 0
    const before = warned.length
    const stopping = makeJob({ stateFile: 'rearm-stop.json', extra: { tickMs: 20 } })
    stopping.scan = async () => {
      late++
      stopping.stop('test')
      throw new Error('failed while stopping')
    }
    stopping.start('test')
    await until(() => late >= 1 && warned.length > before)
    await pause(150)
    const said = warned.slice(before).join(' | ')
    check('a job stopped during the tick that failed is not started again by the failure', late === 1 && stopping.running === false && stopping.timer === null, `${late} scans, running ${stopping.running}, timer ${stopping.timer === null ? 'none' : 'armed'}`)
    check('  and it says the job is stopped, not that it will try again', /failed while stopping/.test(said) && /the job is stopped/.test(said) && !/trying again/.test(said), said)

    // (a pull that throws part-way is with the other "one stuck row" cases above, on a clock that moves)
  } finally {
    console.warn = realWarn
  }
}

index.close()
console.log(`\n${checks - failures} of ${checks} passed`)
if (failures) console.log(`${failures} failed`)
process.exit(failures ? 1 : 0)
