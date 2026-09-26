// Reports (reports.mjs, report-worker.mjs): the counting against a real SQLite database in memory,
// the report put together from it, the daily summary's words, and when the summary goes out.
//   node cctv/test/reports.test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { countWindow } from '../report-worker.mjs'
import { composeReport, gapKind, periodWindow, startDailySummary, storageSummary, summaryText } from '../reports.mjs'
import { useSiteOffset } from '../site-time.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
useSiteOffset(() => -240) // the site: UTC-4
const H = 3_600_000
const D0 = Date.UTC(2026, 8, 25, 4) // the site's 25th starts at 04:00 UTC

// ---- the counting (a real database) ----
const db = new DatabaseSync(':memory:')
db.exec(`CREATE TABLE segments (path TEXT PRIMARY KEY, nvr TEXT, ch INTEGER, start_ms INTEGER, end_ms INTEGER, bytes INTEGER, keyframes INTEGER, loc TEXT);
CREATE INDEX segments_start ON segments (start_ms);
CREATE TABLE gaps (id INTEGER PRIMARY KEY, nvr TEXT, ch INTEGER, from_ms INTEGER, to_ms INTEGER, reason TEXT);
CREATE TABLE events (id INTEGER PRIMARY KEY, nvr TEXT, ch INTEGER, type TEXT, start_ms INTEGER);`)
const seg = db.prepare('INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
// camera n1/0: the whole day in one-hour pieces, plus one piece that ends exactly as the day starts
for (let h = 0; h < 24; h++) seg.run(`a${h}`, 'n1', 0, D0 + h * H, D0 + (h + 1) * H, 1000, 'L')
seg.run('a-early', 'n1', 0, D0 - H / 2, D0, 999, 'L')
// camera n1/1: 12 hours, then offline for the rest of the day and beyond
for (let h = 0; h < 12; h++) seg.run(`b${h}`, 'n1', 1, D0 + h * H, D0 + (h + 1) * H, 500, 'L')
db.prepare('INSERT INTO gaps (nvr, ch, from_ms, to_ms, reason) VALUES (?, ?, ?, ?, ?)').run('n1', 1, D0 + 12 * H, D0 + 30 * H, 'camera offline')
const ev = db.prepare('INSERT INTO events (nvr, ch, type, start_ms) VALUES (?, ?, ?, ?)')
for (let i = 0; i < 5; i++) ev.run('n1', 0, 'motion', D0 + i * H)
ev.run('n1', 0, 'motion', D0 + 25 * H) // the next day: not counted
const counts = countWindow(db, D0, D0 + 24 * H)
const c0 = counts.coverage.find((r) => r.ch === 0)
const c1 = counts.coverage.find((r) => r.ch === 1)
check('coverage: a camera recorded all day counts 24 h', c0.ms === 24 * H && c0.segments === 24, JSON.stringify(c0))
check('coverage: the other camera 12 h', c1.ms === 12 * H)
const g1 = counts.gaps.find((g) => g.ch === 1)
check('a gap running past the window counts only its part inside it', g1.ms === 12 * H && g1.reason === 'camera offline', JSON.stringify(g1))
check('events inside the window only', counts.events.find((e) => e.ch === 0).n === 5)

// ---- the report ----
const cams = [
  { nvr: 'n1', ch: 0, site: 'Main site', name: 'Gate', recording: true, online: true },
  { nvr: 'n1', ch: 1, site: 'Main site', name: 'Yard', recording: true, online: false },
  { nvr: 'n1', ch: 2, site: 'Main site', name: 'Office', recording: false },
  { nvr: 'n1', ch: 3, site: 'Main site', name: 'Camera 4', configured: false }
]
const history = { 'loc-nas': [{ ms: D0 - 2 * 86_400_000, usedBytes: 4000e9, totalBytes: 16000e9 }, { ms: D0 + 23 * H, usedBytes: 4200e9, totalBytes: 16000e9 }] }
const alerts = [{ at: D0 + H, event: 'opened', title: 'Recording stopped' }, { at: D0 + 2 * H, event: 'cleared', title: 'Recording stopped' }]
const rep = composeReport({ counts, cameras: cams, fromMs: D0, toMs: D0 + 24 * H, storageHistory: history, alerts, label: 'Yesterday (2026-09-25)' })
check('empty channel slots are left out', rep.cameras.length === 3)
check('a camera the server does not record has no share', rep.cameras.find((r) => r.ch === 2).recordedShare === null)
check('recorded share across recorded cameras: (24 + 12) / 48 = 75%', Math.abs(rep.summary.recordedShare - 0.75) < 1e-9, String(rep.summary.recordedShare))
check('complete and poor counted', rep.summary.complete === 1 && rep.summary.poor === 1)
check('the worst camera first', rep.worst[0].name === 'Yard')
check('gaps grouped by kind', rep.summary.gapByKind['camera offline'] === 12 * H)
check('only alerts that opened are counted', rep.summary.alertsByKind['Recording stopped'] === 1)
check('storage: growth a day and days left', Math.round(rep.storage[0].daysLeft) > 100 && rep.storage[0].perDayBytes > 0, JSON.stringify(rep.storage[0]))
check('gap reasons put in plain groups', gapKind('refused by the NVR (error 31)') === 'refused by the NVR' && gapKind('service down') === 'server restarting or down' && gapKind('no video from the NVR') === 'no video from the NVR')
const text = summaryText(rep)
check('the summary gives the share, the camera to look at and why footage is missing', /75% of the time recorded/.test(text) && /Main site 2 Yard 50%/.test(text) && /12 h camera offline/.test(text) && /5 motion/.test(text), text)
check('storage in the summary', /Storage: 26% full, about \d+ days left/.test(text), text)
check('an empty storage history: nothing to say', storageSummary({}, 0, 1).length === 0)

// ---- the periods, on the site's calendar ----
const now = Date.UTC(2026, 8, 26, 15) // 11:00 on site, the 26th
const y = periodWindow('yesterday', now)
check('yesterday: the site\'s 25th, 04:00 to 04:00 UTC', y.fromMs === D0 && y.toMs === D0 + 24 * H && /2026-09-25/.test(y.label))
check('today so far: from the site\'s midnight', periodWindow('today', now).fromMs === D0 + 24 * H)
check('7 days by default', periodWindow('nonsense', now).fromMs === now - 7 * 86_400_000)

// ---- the daily summary goes out once, at 07:00 site time ----
{
  const dir = mkdtempSync(join(tmpdir(), 'argus-report-'))
  let t = Date.UTC(2026, 8, 26, 10, 30) // 06:30 on site
  const sent = []
  const opts = { dataDir: dir, buildYesterday: async () => rep, deliver: async (a, k) => sent.push({ a, k }), now: () => t, everyMs: 1e9, log: () => {} }
  const d = startDailySummary(opts)
  await d.tick()
  check('before 07:00: nothing sent', sent.length === 0)
  t = Date.UTC(2026, 8, 26, 11, 1) // 07:01
  await d.tick()
  check('at 07:00: yesterday\'s summary, as a quiet report', sent.length === 1 && sent[0].k === 'report' && /75%/.test(sent[0].a[0].detail))
  await d.tick()
  check('only once a day', sent.length === 1)
  const again = startDailySummary(opts)
  await again.tick()
  check('... even after a restart (the day is kept on disk)', sent.length === 1)
  t += 86_400_000
  await again.tick()
  check('the next day: sent again', sent.length === 2)
  d.stop()
  again.stop()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
