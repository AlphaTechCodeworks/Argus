#!/usr/bin/env node
// A watcher that lives outside the CCTV server, so it can still see when the server cannot.
//
// On 2026-09-26 the server froze for 40 minutes inside a single file call to the NAS, whose SMB
// service had stopped accepting sessions. It logged nothing and alerted nobody, because the logger
// and the alert checker run inside the same process that was frozen: everything that watches for
// trouble was blinded by the trouble. The story was only in the kernel log, found by hand.
//
// So this runs as its own small service. Every 30 seconds it asks the server's /healthz. When that
// fails twice in a row it writes an incident file holding the evidence a person would otherwise
// have to dig for -- what the server process is stuck on, the kernel's storage messages, whether
// the NAS answers -- logs one structured line, and sends the alert the frozen server could not.
//
// It must never hang the way the server did, so it never reads or stats anything on the NAS mount:
// mounts are read from /proc/mounts, and every command it runs has a hard timeout. It does not
// restart anything. A restart while the NAS is still wedged just freezes again, and knowing why is
// worth more than a blind retry; the incident file says what to do.
//
//   node deploy/cctv-healthwatch.mjs            (run by cctv-healthwatch.service)
//   CCTV_WATCH_ONCE=1 node deploy/cctv-healthwatch.mjs   one check, printed, for testing

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { join } from 'node:path'
import { decide, summarise } from './healthwatch-core.mjs'

const URL_HEALTH = process.env.CCTV_WATCH_URL ?? 'https://127.0.0.1:8443/healthz'
const EVERY_MS = Number(process.env.CCTV_WATCH_EVERY_MS ?? 30_000)
const DIR = process.env.CCTV_WATCH_DIR ?? '/var/log/cctv/incidents'
const SETTINGS = process.env.CCTV_SETTINGS ?? '/var/lib/private/cctv/settings.json'

/** Runs a command with a hard timeout; never throws, always returns text. */
function run(cmd, args, ms = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (err, out, errOut) => {
      if (err && err.killed) return resolve(`(timed out after ${ms} ms)`)
      resolve(String(out || errOut || err?.message || '').trim())
    })
  })
}

/** One health probe: { ok, ms, status, error }. Never throws. */
function probe(timeoutMs = 8000) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const req = request(URL_HEALTH, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      res.resume()
      resolve({ ok: res.statusCode === 200, ms: Date.now() - t0, status: res.statusCode, error: null })
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t0, status: null, error: `no answer within ${timeoutMs} ms` }) })
    req.on('error', (e) => resolve({ ok: false, ms: Date.now() - t0, status: null, error: e.code || e.message }))
    req.end()
  })
}

/** Everything worth knowing when the server has stopped answering. */
async function evidence() {
  const pid = (await run('systemctl', ['show', 'cctv', '-p', 'MainPID', '--value'])).trim()
  const proc = (f) => (pid && pid !== '0' ? run('cat', [`/proc/${pid}/${f}`], 3000) : Promise.resolve(''))
  const mounts = (() => { try { return readFileSync('/proc/mounts', 'utf8').split('\n').filter((l) => /cifs|nfs/.test(l)) } catch { return [] } })()
  const nasHosts = [...new Set(mounts.map((l) => /addr=([\d.]+)/.exec(l)?.[1]).filter(Boolean))]
  const nas = []
  for (const h of nasHosts) {
    const ping = await run('ping', ['-c', '1', '-W', '2', h], 4000)
    const smb = await run('bash', ['-c', `timeout 3 bash -c 'echo > /dev/tcp/${h}/445' && echo open || echo closed`], 5000)
    nas.push({ host: h, ping: /1 received|1 packets received/.test(ping) ? 'answers' : 'no answer', smb445: smb.includes('open') ? 'open' : 'closed' })
  }
  const dmesg = await run('dmesg', ['-T'], 5000)
  return {
    service: (await run('systemctl', ['is-active', 'cctv'])).trim(),
    pid,
    processState: (await run('ps', ['-o', 'stat=', '-p', pid || '1'])).trim(),
    blockedIn: (await proc('wchan')).trim(),
    kernelStack: (await proc('stack')).split('\n').slice(0, 8),
    networkMounts: mounts,
    nas,
    kernelStorageMessages: dmesg.split('\n').filter((l) => /cifs|smb|nfs|hung_task|blocked for more than/i.test(l)).slice(-15),
    recentServerLog: (await run('journalctl', ['-u', 'cctv', '--since', '-10min', '--no-pager', '-o', 'short-iso'], 8000))
      .split('\n').filter((l) => !/ProcChannelState|m_bLoginSuccess/.test(l)).slice(-25)
  }
}

/** The ntfy topic from the app's own settings, if one is set. */
function ntfyTopic() {
  try {
    const s = JSON.parse(readFileSync(SETTINGS, 'utf8'))
    return s?.alerts?.ntfy?.topic || s?.alerts?.topic || null
  } catch {
    return null
  }
}

function notify(title, body) {
  const topic = ntfyTopic()
  if (!topic) return Promise.resolve('no ntfy topic set')
  return new Promise((resolve) => {
    const req = request(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', timeout: 8000, headers: { Title: title, Priority: 'high', Tags: 'rotating_light' } },
      (res) => { res.resume(); resolve(`sent (${res.statusCode})`) })
    req.on('timeout', () => { req.destroy(); resolve('send timed out') })
    req.on('error', (e) => resolve(`send failed: ${e.code || e.message}`))
    req.end(body)
  })
}

const log = (event, fields) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }))

let state = { fails: 0, open: null, lastAlertAt: 0 }

async function tick() {
  const p = await probe()
  const d = decide(state, p.ok, Date.now())
  state = d.state
  if (d.action === 'open') {
    const ev = await evidence()
    const incident = { openedAt: new Date().toISOString(), probe: p, summary: summarise(ev), evidence: ev }
    let file = ''
    try {
      mkdirSync(DIR, { recursive: true })
      file = join(DIR, `${incident.openedAt.replace(/[:.]/g, '-')}.json`)
      writeFileSync(file, `${JSON.stringify(incident, null, 2)}\n`, { mode: 0o640 })
    } catch (e) {
      file = `(could not write: ${e.message})`
    }
    const sent = await notify('CCTV server not answering', `${incident.summary}\nDetails: ${file}`)
    log('incident-open', { summary: incident.summary, file, alert: sent, probe: p })
  } else if (d.action === 'close') {
    const sent = await notify('CCTV server answering again', `Recovered after ${Math.round(d.downMs / 1000)} s.`)
    log('incident-close', { downMs: d.downMs, alert: sent })
  } else if (!p.ok) {
    log('probe-failed', { fails: state.fails, probe: p })
  }
  return p
}

if (process.env.CCTV_WATCH_ONCE) {
  const p = await probe()
  // The diagnosis explains a failure; printed for a healthy server it would claim a fault that is
  // not there.
  console.log(JSON.stringify({ probe: p, summary: p.ok ? 'The server is answering its health check.' : summarise(await evidence()) }, null, 2))
} else {
  log('start', { url: URL_HEALTH, everyMs: EVERY_MS, dir: DIR })
  for (;;) {
    try { await tick() } catch (e) { log('watcher-error', { error: e.message }) }
    await new Promise((r) => setTimeout(r, EVERY_MS))
  }
}
