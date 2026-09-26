// Reports: how the recording went over a day, a week or a month, per camera and in total -- how much
// of the time each camera was recorded, the gaps and why (camera offline, the NVR refusing, the server
// down), events per camera, storage use and how long it lasts, health alerts. Built from what the
// server already keeps (the recordings index, storage-history.json, alerts.jsonl); nothing new is
// recorded for it.
//
//   GET /api/admin/reports?period=today|yesterday|week|month   (admins)
//
// The counting runs in its own thread (report-worker.mjs). The daily summary goes out through the
// alert channels (ntfy, webhooks) at 07:00 site time, once a day (startDailySummary).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { siteDate, siteDayStart, siteMinutesOfDay } from './site-time.mjs'

export const PERIODS = ['today', 'yesterday', 'week', 'month']
const DAY = 86_400_000
const FULL = 0.99 // recorded this share of the time or more: "complete"
const POOR = 0.9 // under this: listed as a camera to look at

/** The window a period covers, on the site's calendar. */
export function periodWindow(period, now = Date.now()) {
  const today = siteDate(now)
  const todayStart = siteDayStart(today)
  switch (period) {
    case 'today':
      return { fromMs: todayStart, toMs: now, label: 'Today so far' }
    case 'yesterday':
      return { fromMs: todayStart - DAY, toMs: todayStart, label: `Yesterday (${siteDate(todayStart - DAY)})` }
    case 'month':
      return { fromMs: now - 30 * DAY, toMs: now, label: 'The last 30 days' }
    default:
      return { fromMs: now - 7 * DAY, toMs: now, label: 'The last 7 days' }
  }
}

/** The counts for a window, from report-worker.mjs in its own thread. */
export function countInThread(dbFile, fromMs, toMs, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./report-worker.mjs', import.meta.url), { workerData: { dbFile, fromMs, toMs } })
    const timer = setTimeout(() => {
      w.terminate()
      reject(new Error('the report took too long'))
    }, timeoutMs)
    w.once('message', (m) => {
      clearTimeout(timer)
      w.terminate()
      if (m?.error) reject(new Error(m.error))
      else resolve(m)
    })
    w.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

const isOffline = (reason) => /offline/i.test(reason)
const isRefused = (reason) => /refus/i.test(reason)
const isServer = (reason) => /service down|worker restarted|server/i.test(reason)
/** A gap's reason in a few words, grouped for the totals. */
export function gapKind(reason) {
  if (isOffline(reason)) return 'camera offline'
  if (isRefused(reason)) return 'refused by the NVR'
  if (isServer(reason)) return 'server restarting or down'
  if (/no video/i.test(reason)) return 'no video from the NVR'
  if (/storage|disk|location|share|full/i.test(reason)) return 'nowhere to record'
  return reason ? 'other' : 'unknown'
}

/**
 * The report, from the counts and what else the server keeps. Pure (tests drive it).
 * @param {{ counts: { coverage: object[], gaps: object[], events: object[] }, cameras: object[],
 *   fromMs: number, toMs: number, storageHistory?: object, alerts?: object[] }} o
 */
export function composeReport({ counts, cameras, fromMs, toMs, storageHistory = {}, alerts = [], label = '' }) {
  const span = Math.max(1, toMs - fromMs)
  const key = (nvr, ch) => `${nvr}/${ch}`
  const cov = new Map(counts.coverage.map((r) => [key(r.nvr, r.ch), r]))
  const gapsOf = new Map()
  for (const g of counts.gaps) {
    const k = key(g.nvr, g.ch)
    if (!gapsOf.has(k)) gapsOf.set(k, [])
    gapsOf.get(k).push(g)
  }
  const eventsOf = new Map()
  for (const e of counts.events) {
    const k = key(e.nvr, e.ch)
    if (!eventsOf.has(k)) eventsOf.set(k, {})
    eventsOf.get(k)[e.type] = (eventsOf.get(k)[e.type] ?? 0) + e.n
  }

  const rows = []
  for (const c of cameras) {
    if (c.configured === false) continue // an empty channel slot on the NVR
    const k = key(c.nvr, c.ch)
    const recordedMs = Math.min(span, Math.max(0, cov.get(k)?.ms ?? 0))
    const gaps = {}
    for (const g of gapsOf.get(k) ?? []) {
      const kind = gapKind(g.reason)
      gaps[kind] = (gaps[kind] ?? 0) + Math.max(0, g.ms ?? 0)
    }
    const events = eventsOf.get(k) ?? {}
    rows.push({
      key: k,
      nvr: c.nvr,
      ch: c.ch,
      site: c.site,
      nvrName: c.nvrName,
      name: c.name,
      online: c.online !== false,
      recording: c.recording !== false,
      recordedMs,
      recordedShare: c.recording === false ? null : recordedMs / span,
      bytes: cov.get(k)?.bytes ?? 0,
      gaps,
      gapMs: Object.values(gaps).reduce((a, b) => a + b, 0),
      offlineMs: gaps['camera offline'] ?? 0,
      events,
      eventCount: Object.values(events).reduce((a, b) => a + b, 0)
    })
  }

  const recorded = rows.filter((r) => r.recordedShare !== null)
  const share = recorded.length ? recorded.reduce((a, r) => a + r.recordedMs, 0) / (recorded.length * span) : null
  const gapByKind = {}
  for (const r of rows) for (const [k, ms] of Object.entries(r.gaps)) gapByKind[k] = (gapByKind[k] ?? 0) + ms
  const eventsByType = {}
  for (const r of rows) for (const [t, n] of Object.entries(r.events)) eventsByType[t] = (eventsByType[t] ?? 0) + n
  const alertsByKind = {}
  for (const a of alerts) {
    if (a.event === 'cleared') continue
    const at = Number(a.at ?? a.ms ?? a.openedMs ?? a.time ?? Date.parse(a.openedAt ?? a.date ?? ''))
    if (Number.isFinite(at) && (at < fromMs || at >= toMs)) continue
    const k = a.title ?? a.kind ?? a.key ?? 'alert'
    alertsByKind[k] = (alertsByKind[k] ?? 0) + 1
  }

  return {
    label,
    fromMs,
    toMs,
    summary: {
      cameras: rows.length,
      recordedCameras: recorded.length,
      recordedShare: share,
      complete: recorded.filter((r) => r.recordedShare >= FULL).length,
      mostly: recorded.filter((r) => r.recordedShare >= POOR && r.recordedShare < FULL).length,
      poor: recorded.filter((r) => r.recordedShare < POOR).length,
      gapByKind,
      eventsByType,
      bytes: rows.reduce((a, r) => a + r.bytes, 0),
      alertsByKind
    },
    worst: [...recorded].sort((a, b) => a.recordedShare - b.recordedShare).slice(0, 10),
    mostOffline: rows.filter((r) => r.offlineMs > 0).sort((a, b) => b.offlineMs - a.offlineMs).slice(0, 10),
    cameras: rows,
    storage: storageSummary(storageHistory, fromMs, toMs)
  }
}

/** Per storage location: used, size, growth over the window and how long the free space lasts. */
export function storageSummary(history, fromMs, toMs) {
  const out = []
  for (const [loc, samples] of Object.entries(history ?? {})) {
    const all = [...samples].sort((a, b) => a.ms - b.ms)
    const last = all.at(-1)
    if (!last) continue
    // the growth rate over up to the last 7 days, whatever period the report covers: how long the
    // space lasts does not depend on whether you are looking at a day or a month
    const first = all.find((s) => s.ms >= last.ms - 7 * DAY) ?? all[0]
    const days = (last.ms - first.ms) / DAY
    const perDay = days >= 0.5 ? (last.usedBytes - first.usedBytes) / days : null
    const free = Number.isFinite(last.totalBytes) ? last.totalBytes - last.usedBytes : null
    out.push({
      location: loc,
      usedBytes: last.usedBytes,
      totalBytes: last.totalBytes ?? null,
      usedShare: Number.isFinite(last.totalBytes) && last.totalBytes > 0 ? last.usedBytes / last.totalBytes : null,
      perDayBytes: perDay,
      daysLeft: perDay > 0 && free !== null ? free / perDay : null,
      at: last.ms
    })
  }
  return out
}

const pctText = (x) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(x >= 0.995 && x < 1 ? 1 : 0)}%`)
const hoursText = (ms) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(ms >= 36_000_000 ? 0 : 1)} h` : `${Math.round(ms / 60_000)} min`)
const camText = (r) => `${r.site} ${r.ch + 1} ${r.name}`

/** The daily summary in a few lines (ntfy, webhooks). */
export function summaryText(rep) {
  const s = rep.summary
  const lines = []
  if (s.recordedShare === null) lines.push(`${rep.label}: no camera is set to be recorded by the server.`)
  else lines.push(`${rep.label}: ${pctText(s.recordedShare)} of the time recorded across ${s.recordedCameras} cameras (${s.complete} complete, ${s.mostly} mostly, ${s.poor} under 90%).`)
  if (s.poor > 0) lines.push(`To look at: ${rep.worst.filter((r) => r.recordedShare < POOR).slice(0, 5).map((r) => `${camText(r)} ${pctText(r.recordedShare)}`).join(', ')}.`)
  const gaps = Object.entries(s.gapByKind).filter(([, ms]) => ms >= 60_000).sort((a, b) => b[1] - a[1])
  if (gaps.length) lines.push(`Not recorded: ${gaps.map(([k, ms]) => `${hoursText(ms)} ${k}`).join(', ')}.`)
  const ev = Object.entries(s.eventsByType).sort((a, b) => b[1] - a[1])
  if (ev.length) lines.push(`Events: ${ev.map(([t, n]) => `${n.toLocaleString('en-GB')} ${t}`).join(', ')}.`)
  for (const st of rep.storage) {
    const bits = [st.usedShare === null ? null : `${pctText(st.usedShare)} full`, st.daysLeft === null ? null : `about ${Math.round(st.daysLeft)} days left`].filter(Boolean)
    if (bits.length) lines.push(`Storage: ${bits.join(', ')}.`)
  }
  const al = Object.values(s.alertsByKind).reduce((a, b) => a + b, 0)
  if (al) lines.push(`${al} health alert${al === 1 ? '' : 's'}.`)
  return lines.join('\n')
}

/**
 * The daily summary: once a day, at or after `at` (site time), yesterday's report goes out through
 * the alert channels. The day it last went out is kept in DATA_DIR, so a restart does not send it twice.
 * @param {{ dataDir: string, buildYesterday: () => Promise<object>, deliver: (alerts: object[], kind: string) => Promise<any>,
 *   enabled?: () => boolean, at?: string, now?: () => number, everyMs?: number, log?: Function }} o
 */
export function startDailySummary({ dataDir, buildYesterday, deliver, enabled = () => true, at = '07:00', now = Date.now, everyMs = 60_000, log = console.log }) {
  const file = join(dataDir, 'daily-summary.json')
  const [h, m] = at.split(':').map(Number)
  const sentFor = () => {
    try {
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).date ?? null : null
    } catch {
      return null
    }
  }
  let busy = false
  const tick = async () => {
    const t = now()
    const today = siteDate(t)
    if (busy || !enabled() || siteMinutesOfDay(t) < h * 60 + m || sentFor() === today) return
    busy = true
    try {
      const rep = await buildYesterday()
      await deliver([{ key: `daily-report:${today}`, kind: 'report', title: 'Yesterday on the cameras', detail: summaryText(rep), severity: 'low' }], 'report')
      writeFileSync(file, `${JSON.stringify({ date: today, sentAt: new Date(t).toISOString() })}\n`)
      log(`[reports] daily summary sent for ${siteDate(t - DAY)}`)
    } catch (e) {
      log(`[reports] daily summary not sent: ${e.message}`)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(tick, everyMs)
  timer.unref?.()
  return { tick, stop: () => clearInterval(timer) }
}
