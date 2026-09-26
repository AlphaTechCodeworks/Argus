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
// mounts are read from /proc/mounts, and every command it runs has a hard timeout.
//
// It fixes one fault itself, the one seen twice on 2026-09-26: the server stuck in a call on a
// share whose NAS still answers, because the kernel's SMB session went stale. A person fixed that
// by detaching the share, mounting it again and restarting the server, so it does the same, with
// the evidence written first. Nothing else is restarted blindly: with the NAS really off a remount
// would hang too, and a server stuck on anything else needs someone to know why (healthwatch-core
// recoveryPlan). After three recoveries in an hour it stops and leaves it to a person.
//
//   node deploy/cctv-healthwatch.mjs            (run by cctv-healthwatch.service)
//   CCTV_WATCH_ONCE=1 node deploy/cctv-healthwatch.mjs   one check, printed, for testing

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { join } from 'node:path'
import { FAILS_TO_OPEN, decide, recoveryPlan, summarise, tailscalePlan } from './healthwatch-core.mjs'

const URL_HEALTH = process.env.CCTV_WATCH_URL ?? 'https://127.0.0.1:8443/healthz'
const EVERY_MS = Number(process.env.CCTV_WATCH_EVERY_MS ?? 30_000)
const DIR = process.env.CCTV_WATCH_DIR ?? '/var/log/cctv/incidents'
const SETTINGS = process.env.CCTV_SETTINGS ?? '/var/lib/private/cctv/settings.json'

/**
 * Runs a command with a hard timeout; never throws, always returns text, and always within the
 * timeout: a command stuck in a stale share cannot be killed, and waiting for it to exit would
 * hang the watcher exactly the way the server hung.
 */
function run(cmd, args, ms = 5000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const child = execFile(cmd, args, { timeout: ms, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (err, out, errOut) => {
      if (err && err.killed) return finish(`(timed out after ${ms} ms)`)
      finish(String(out || errOut || err?.message || '').trim())
    })
    child.unref()
    setTimeout(() => finish(`(timed out after ${ms} ms)`), ms + 1000).unref()
  })
}

// ---- the shares themselves ----------------------------------------------------------------------
// The server checks its shares from a child process and reports them in /healthz; one it calls
// "not answering" is stuck where no file call on it returns. The watcher cannot check that more
// cheaply itself: a statfs still answered on 2026-09-26 while every file open on the share hung.
const shareFails = new Map() // mount -> reports in a row of a stuck share on it

function networkMountPoints() {
  try {
    return readFileSync('/proc/mounts', 'utf8').split('\n').filter((l) => /\s(cifs|smb3|nfs4?)\s/.test(l)).map((l) => l.split(' ')[1])
  } catch {
    return []
  }
}

/** Mount points the server has reported stuck `needed` times in a row. */
function stuckShares(shares, needed) {
  const mounts = networkMountPoints()
  const out = []
  for (const m of mounts) {
    const bad = shares.filter((x) => !x.ok && /not answering/.test(x.reason ?? '') && (x.path === m || String(x.path).startsWith(`${m}/`)))
    const n = bad.length ? (shareFails.get(m) ?? 0) + 1 : 0
    shareFails.set(m, n)
    if (bad.length) log('share-stuck', { mount: m, inARow: n, reason: bad[0].reason })
    if (n >= needed) out.push(m)
  }
  return out
}

/** One health probe: { ok, ms, status, error }. Never throws. */
function probe(timeoutMs = 8000) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const req = request(URL_HEALTH, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { if (body.length < 65536) body += c })
      res.on('end', () => {
        let shares = []
        try { shares = JSON.parse(body).shares ?? [] } catch {}
        resolve({ ok: res.statusCode === 200, ms: Date.now() - t0, status: res.statusCode, error: null, shares })
      })
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
const recoveries = [] // times of automatic recoveries
let lastTryAt = 0
const RETRY_MS = 5 * 60_000

/** Detaches and remounts each share, then restarts the server. Returns what each step said. */
async function recover(mounts) {
  const steps = []
  for (const m of mounts) {
    steps.push(['umount', await run('umount', ['-l', '-f', m], 15_000)])
    const unit = (await run('systemd-escape', ['--path', '--suffix=mount', m])).trim()
    steps.push([`restart ${unit}`, await run('systemctl', ['restart', unit], 30_000)])
  }
  steps.push(['kill cctv', await run('systemctl', ['kill', '-s', 'KILL', 'cctv'], 10_000)])
  steps.push(['restart cctv', await run('systemctl', ['restart', 'cctv'], 30_000)])
  return steps.map(([k, v]) => `${k}: ${v || 'ok'}`)
}

/** Recovers if the evidence says a remount cures it. Returns a line for the alert, or ''. */
async function maybeRecover(ev) {
  lastTryAt = Date.now()
  const plan = recoveryPlan(ev, recoveries, Date.now())
  if (!plan.recover) {
    log('no-recovery', { why: plan.why })
    return `Not fixed automatically: ${plan.why}.`
  }
  recoveries.push(Date.now())
  const steps = await recover(plan.mounts)
  log('recovered', { why: plan.why, mounts: plan.mounts, steps })
  return `Fixed automatically: remounted ${plan.mounts.join(', ')} and restarted the server (${plan.why}).`
}

// ---- Tailscale: the public link ----
// On 2026-09-26 tailscaled sat offline for over ten minutes (the public link down from everywhere)
// while the machine's own internet worked; a restart fixed it. Checked each tick, restarted after
// three offline checks in a row (tailscalePlan), at most three times an hour.
let tsState = {}
async function checkTailscale() {
  // turned off on purpose (remote access is the Cloudflare tunnel now): never brought back
  if (!/^enabled/.test((await run('systemctl', ['is-enabled', 'tailscaled'], 5000)).trim())) return
  const out = await run('tailscale', ['status', '--json'], 8000)
  let installed = true
  let online = null
  if (/not found|ENOENT|timed out/i.test(out)) installed = !/not found|ENOENT/i.test(out)
  else {
    try { online = JSON.parse(out)?.Self?.Online === true } catch { online = null }
  }
  const r = tailscalePlan(tsState, { installed, online, now: Date.now() })
  tsState = r.state
  if (online === false) log('tailscale-offline', { fails: tsState.fails })
  if (r.restart) {
    const res = await run('systemctl', ['restart', 'tailscaled'], 30_000)
    log('tailscale-restarted', { why: r.why, result: res || 'ok' })
    await notify('CCTV: public link was down', `Tailscale was offline (${r.why}): restarted it.`)
  } else if (r.why) log('tailscale-no-restart', { why: r.why })
}

async function tick() {
  checkTailscale().catch((e) => log('tailscale-check-error', { error: e.message }))
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
    const action = await maybeRecover(ev)
    const sent = await notify('CCTV server not answering', `${incident.summary}\n${action}\nDetails: ${file}`)
    log('incident-open', { summary: incident.summary, action, file, alert: sent, probe: p })
  } else if (d.action === 'close') {
    const sent = await notify('CCTV server answering again', `Recovered after ${Math.round(d.downMs / 1000)} s.`)
    log('incident-close', { downMs: d.downMs, alert: sent })
  } else if (!p.ok) {
    log('probe-failed', { fails: state.fails, probe: p })
    // still down after a recovery, or one that was not allowed: look again every few minutes
    if (state.open !== null && Date.now() - lastTryAt >= RETRY_MS) {
      const action = await maybeRecover(await evidence())
      if (action.startsWith('Fixed')) await notify('CCTV server: tried again', action)
    }
  }
  if (p.ok && Date.now() - lastTryAt >= RETRY_MS) {
    // the server answers, but a share it records to may be stuck: it no longer freezes the server,
    // so nothing else would notice while recordings have nowhere to go
    const stuck = stuckShares(p.shares ?? [], FAILS_TO_OPEN)
    if (stuck.length) {
      const ev = { ...(await evidence()), shareStuck: stuck }
      const action = await maybeRecover(ev)
      await notify('CCTV: network share stuck', `${stuck.join(', ')} stopped answering; recordings to it were paused.
${action}`)
      for (const m of stuck) shareFails.set(m, 0)
    }
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
