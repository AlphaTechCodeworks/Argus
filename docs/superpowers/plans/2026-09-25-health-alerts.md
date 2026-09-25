# Health alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the owner within minutes when the CCTV server stops doing its job — server or PC down, recording drive missing or full, a camera not recording, a camera or NVR offline, an NVR refusing streams or rejecting the login, or an NVR clock drifting — by phone push, email and a Health page.

**Architecture:** A pure rule engine (`alerts.mjs`) decides when an alert opens and clears from a snapshot of facts; a collector (`alert-checks.mjs`) builds that snapshot every 30 s from state the server already holds; a sender (`alert-send.mjs` + `smtp.mjs`) delivers. A second watcher lives outside the app, in the test PC's existing keep-alive script, because a server that is down cannot report itself. Nightly settings backups ride along because they share the same scheduler and Health page.

**Tech Stack:** Node 24 ESM, no new npm dependencies (SMTP is written against `node:net`/`node:tls`), plain-node test scripts matching the existing `cctv/test/*.test.mjs` style, PowerShell 5.1 for the outside watcher.

**Spec:** `docs/superpowers/specs/2026-09-25-health-alerts-design.md`

## Scope change agreed 2026-09-25

**Email is deferred.** Phone push (ntfy) only for now. Therefore:
- **Task 2 (SMTP client) is not built.** Skip it entirely.
- In **Task 3**, `alert-send.mjs` keeps the `email` branch shape but `mailImpl` defaults to a stub
  that throws `new Error('email is not set up yet')`; do not import `./smtp.mjs`. The settings
  `alerts.email` section, its validation and its tests stay, so the fields exist and are stored —
  only the sending is missing. Drop the email assertions from `alert-send.test.mjs`
  (the "email" block and the `mailImpl` success cases); keep the "nothing configured" and
  redaction cases.
- In **Task 5**, keep the email fields in the settings screen but label the section
  "Email (not sending yet)" and hide its Test button.
- In **Task 7**, keep the `Send-CctvAlert` email branch as written — PowerShell's own
  `Net.Mail.SmtpClient` needs no work from us, so the outside watcher can email even while the
  app cannot. It stays quiet unless the fields are filled in.

When email is picked up later, Task 2 is the whole job: write `smtp.mjs`, pass it as `mailImpl`,
restore the dropped tests, unhide the Test button.

## Global Constraints

- **No new npm dependencies.** SMTP is implemented with `node:net`/`node:tls`.
- **No secret ever leaves the server.** `alerts.email.pass` is write-only: the settings API accepts it but never returns it; it is replaced by the string `'set'` or `''` in every response and in every log line.
- **Nothing blocks the check loop.** Delivery is fire-and-forget with its own retry timer; a failing sender never delays or skips a check.
- **Every alert kind can be muted** in settings; all default to on.
- **Tests run on the test server, not on Windows.** `koffi` (the native SDK) is not installed on the dev PC, so any test importing `nvrs.mjs` fails locally. Run tests with:
  `cd scratchpad/imaging && bash lab.sh code && bash lab.sh sh 'node /opt/cctv/current/cctv/test/<file>'`
  Prefer writing tests that import only the module under test so they also run locally with plain `node`.
- **Copy style:** sentence case, plain words, no exclamation marks, no "please". Alert text names the thing and the fact: `nvr-2: 3 cameras offline`, not `Alert! Cameras are down!!`.
- **Times in messages** are the server's local time, formatted `HH:MM`.
- **File writes that must survive a crash** use the existing write-temp-then-rename pattern (see `settings.mjs` `saveSettings`).

---

### Task 1: Alert rule engine

The pure core: given a snapshot of facts and the previous state, decide which alerts open and which clear. No I/O, no timers, no imports from the rest of the app — so it is fully testable on any machine.

**Files:**
- Create: `cctv/alerts.mjs`
- Test: `cctv/test/alerts.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const KINDS` — array of alert kind ids.
  - `export function alertEngine(opts)` → `{ step(snapshot, nowMs) → { opened: Alert[], cleared: Alert[], open: Alert[] } }`
  - `Alert` = `{ key, kind, title, detail, since, severity }` where `severity` is `'high' | 'medium'`.
  - `Snapshot` = `{ startedMs, restartReason, locations, cameras, nvrs }` — exact shapes in Step 1.

- [ ] **Step 1: Write the failing test**

Create `cctv/test/alerts.test.mjs`:

```js
// Tests for alerts.mjs: when an alert opens, when it clears, grouping and suppression.
// Pure module, no I/O. Run: node cctv/test/alerts.test.mjs
import { alertEngine, KINDS } from '../alerts.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 9, 0, 0)
const MIN = 60_000

/** A snapshot where everything is healthy. */
const ok = (o = {}) => ({
  startedMs: T0 - 60 * MIN,
  restartReason: null,
  locations: [{ id: 'usb', name: 'USB drive', mounted: true, freePct: 59 }],
  cameras: [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: true, recording: true, lastSegmentMs: T0 }],
  nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }],
  ...o
})

const eng = (o = {}) => alertEngine({ raiseMs: 2 * MIN, clearMs: 1 * MIN, graceMs: 3 * MIN, notRecordingMs: 5 * MIN, clockSkewMs: 30_000, muted: [], ...o })

// --- raise delay -------------------------------------------------------------------------------
{
  const e = eng()
  const bad = ok({ locations: [{ id: 'usb', name: 'USB drive', mounted: false, freePct: 0 }] })
  check('nothing opens during the start grace', e.step(bad, T0 + 1 * MIN).opened.length === 0)
  check('still nothing before raiseMs after grace', e.step(bad, T0 + 4 * MIN).opened.length === 0)
  const r = e.step(bad, T0 + 6 * MIN)
  check('drive-missing opens after raiseMs', r.opened.length === 1 && r.opened[0].kind === 'drive-missing', JSON.stringify(r.opened))
  check('it does not open twice', e.step(bad, T0 + 7 * MIN).opened.length === 0)
  check('open list carries it', e.step(bad, T0 + 8 * MIN).open.length === 1)
}

// --- clear delay -------------------------------------------------------------------------------
{
  const e = eng()
  const bad = ok({ locations: [{ id: 'usb', name: 'USB drive', mounted: false, freePct: 0 }] })
  e.step(bad, T0 + 4 * MIN); e.step(bad, T0 + 7 * MIN)
  check('does not clear immediately', e.step(ok(), T0 + 7 * MIN + 10_000).cleared.length === 0)
  const c = e.step(ok(), T0 + 9 * MIN)
  check('clears after clearMs', c.cleared.length === 1 && c.cleared[0].kind === 'drive-missing')
  check('does not clear twice', e.step(ok(), T0 + 10 * MIN).cleared.length === 0)
}

// --- grouping ----------------------------------------------------------------------------------
{
  const e = eng()
  const cams = ['Front Gate', 'Yard', 'Bay 3'].map((name, i) => ({ nvrId: 'nvr-2', ch: i, name, online: false, recording: true, lastSegmentMs: T0 }))
  const s = ok({ cameras: cams, nvrs: [{ id: 'nvr-2', name: 'NVR 2', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }] })
  e.step(s, T0 + 4 * MIN)
  const r = e.step(s, T0 + 7 * MIN)
  check('3 offline cameras on one NVR are one alert', r.opened.length === 1, JSON.stringify(r.opened.map(a => a.title)))
  check('the title counts them', r.opened[0].title === 'nvr-2: 3 cameras offline', r.opened[0]?.title)
  check('the detail names them', r.opened[0].detail.includes('Front Gate') && r.opened[0].detail.includes('Bay 3'))
}

// --- suppression -------------------------------------------------------------------------------
{
  const e = eng()
  const s = ok({
    cameras: [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: false, recording: true, lastSegmentMs: T0 - 30 * MIN }],
    nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }]
  })
  e.step(s, T0 + 4 * MIN)
  const r = e.step(s, T0 + 7 * MIN)
  check('an offline camera does not also raise not-recording', r.opened.length === 1 && r.opened[0].kind === 'camera-offline', JSON.stringify(r.opened.map(a => a.kind)))
}
{
  const e = eng()
  const s = ok({
    cameras: [0, 1].map((ch) => ({ nvrId: 'nvr1', ch, name: `Cam ${ch}`, online: false, recording: true, lastSegmentMs: T0 - 30 * MIN })),
    nvrs: [{ id: 'nvr1', name: 'Main site', online: false, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }]
  })
  e.step(s, T0 + 4 * MIN)
  const r = e.step(s, T0 + 7 * MIN)
  check('an offline NVR folds in its cameras', r.opened.length === 1 && r.opened[0].kind === 'nvr-offline', JSON.stringify(r.opened.map(a => a.kind)))
}
{
  const e = eng()
  const s = ok({
    locations: [{ id: 'usb', name: 'USB drive', mounted: false, freePct: 0 }],
    cameras: [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: true, recording: true, lastSegmentMs: T0 - 30 * MIN }]
  })
  e.step(s, T0 + 4 * MIN)
  const r = e.step(s, T0 + 7 * MIN)
  check('a missing drive suppresses not-recording', r.opened.every(a => a.kind !== 'not-recording'), JSON.stringify(r.opened.map(a => a.kind)))
}

// --- immediate kinds ---------------------------------------------------------------------------
{
  const e = eng()
  const s = ok({ nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: 'wrong password', refusalsLast10Min: 0, clockSkewMs: 0 }] })
  const r = e.step(s, T0 + 4 * MIN)
  check('a login failure opens at once (no raise delay)', r.opened.length === 1 && r.opened[0].kind === 'nvr-login')
}
{
  const e = eng()
  const s = ok({ nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: null, refusalsLast10Min: 3, clockSkewMs: 0 }] })
  check('2 refusals is not enough', eng().step(ok({ nvrs: [{ id: 'nvr1', name: 'M', online: true, loginError: null, refusalsLast10Min: 2, clockSkewMs: 0 }] }), T0 + 4 * MIN).opened.length === 0)
  check('3 refusals in 10 min opens at once', e.step(s, T0 + 4 * MIN).opened.length === 1)
}

// --- clock skew --------------------------------------------------------------------------------
{
  const e = eng()
  const s = ok({ nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 220_000 }] })
  e.step(s, T0 + 4 * MIN)
  const r = e.step(s, T0 + 7 * MIN)
  check('a 220 s clock skew opens', r.opened.length === 1 && r.opened[0].kind === 'nvr-clock', JSON.stringify(r.opened.map(a => a.kind)))
  check('the title says how far out', r.opened[0].title === 'nvr1 clock is 220 s fast', r.opened[0]?.title)
  check('a 10 s skew does not open', eng().step(ok({ nvrs: [{ id: 'n', name: 'n', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 10_000 }] }), T0 + 7 * MIN).opened.length === 0)
}

// --- restart (one shot) ------------------------------------------------------------------------
{
  const e = eng()
  const s = ok({ restartReason: 'watchdog: SDK call stuck for 90 s' })
  const r = e.step(s, T0 + 1 * MIN)
  check('a restart reports during the grace', r.opened.length === 1 && r.opened[0].kind === 'server-restart')
  check('and never repeats', e.step(s, T0 + 5 * MIN).opened.length === 0)
  check('and never clears', e.step(ok(), T0 + 9 * MIN).cleared.length === 0)
}

// --- muting ------------------------------------------------------------------------------------
{
  const e = eng({ muted: ['drive-missing'] })
  const bad = ok({ locations: [{ id: 'usb', name: 'USB drive', mounted: false, freePct: 0 }] })
  e.step(bad, T0 + 4 * MIN)
  check('a muted kind never opens', e.step(bad, T0 + 7 * MIN).opened.length === 0)
}

check('KINDS covers every kind used', ['server-restart', 'drive-missing', 'drive-full', 'not-recording', 'camera-offline', 'nvr-offline', 'nvr-refusing', 'nvr-login', 'nvr-clock'].every(k => KINDS.includes(k)), KINDS.join())

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cctv/test/alerts.test.mjs`
Expected: FAIL — `Cannot find module '../alerts.mjs'`

- [ ] **Step 3: Write the implementation**

Create `cctv/alerts.mjs`:

```js
// The alert rules: from a snapshot of facts, decide which alerts open and which clear.
//
// Pure: no I/O, no timers, no imports. alert-checks.mjs builds the snapshot and calls step()
// every 30 s; alert-send.mjs delivers what comes back. Keeping the rules here means they can be
// tested on any machine without the SDK.
//
// An alert opens once its condition has held for raiseMs (immediate kinds open on the first
// sighting) and clears once the condition has been false for clearMs. It never repeats while open.
// Cameras of one NVR are grouped into a single alert, and an alert that would only restate a
// bigger one is suppressed (see SUPPRESSED_BY).

/** Every kind, in the order they are shown. */
export const KINDS = Object.freeze([
  'server-restart', 'drive-missing', 'drive-full', 'not-recording',
  'camera-offline', 'nvr-offline', 'nvr-refusing', 'nvr-login', 'nvr-clock'
])

/** Kinds that open on the first sighting rather than after raiseMs. */
const IMMEDIATE = new Set(['server-restart', 'nvr-login', 'nvr-refusing'])

/** Kinds reported once with no clear (nothing to recover from). */
const ONE_SHOT = new Set(['server-restart'])

const HIGH = new Set(['server-restart', 'drive-missing', 'drive-full', 'nvr-offline', 'nvr-login'])

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const names = (list, max = 4) =>
  list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`

/**
 * @param {object} o
 * @param {number} o.raiseMs        how long a condition must hold before it opens
 * @param {number} o.clearMs        how long it must be false before it clears
 * @param {number} o.graceMs        no alerts (except server-restart) for this long after start
 * @param {number} o.notRecordingMs a recording camera with no segment for this long counts as stopped
 * @param {number} o.clockSkewMs    an NVR clock this far out counts as wrong
 * @param {string[]} o.muted        kinds never to open
 */
export function alertEngine({ raiseMs, clearMs, graceMs, notRecordingMs, clockSkewMs, muted = [] }) {
  const mutedSet = new Set(muted)
  /** key -> { alert, firstSeen, lastSeen, openedAt|null, doneOneShot } */
  const state = new Map()

  return {
    step(snap, nowMs) {
      const inGrace = nowMs - snap.startedMs < graceMs
      const found = new Map()
      for (const c of candidates(snap, { notRecordingMs, clockSkewMs, nowMs })) {
        if (mutedSet.has(c.kind)) continue
        if (inGrace && c.kind !== 'server-restart') continue
        found.set(c.key, c)
      }

      const opened = []
      const cleared = []

      for (const [key, c] of found) {
        const st = state.get(key) ?? { firstSeen: nowMs, openedAt: null, doneOneShot: false }
        st.alert = c
        st.lastSeen = nowMs
        state.set(key, st)
        if (st.openedAt !== null || st.doneOneShot) continue
        const due = IMMEDIATE.has(c.kind) || nowMs - st.firstSeen >= raiseMs
        if (!due) continue
        st.openedAt = nowMs
        const alert = { ...c, since: st.firstSeen, severity: HIGH.has(c.kind) ? 'high' : 'medium' }
        st.alert = alert
        opened.push(alert)
        if (ONE_SHOT.has(c.kind)) { st.doneOneShot = true; st.openedAt = null; state.delete(key) }
      }

      for (const [key, st] of [...state]) {
        if (found.has(key)) continue
        if (st.openedAt === null) { state.delete(key); continue }   // never opened: forget it
        if (nowMs - st.lastSeen < clearMs) continue
        cleared.push({ ...st.alert, clearedAt: nowMs })
        state.delete(key)
      }

      const open = [...state.values()].filter((s) => s.openedAt !== null).map((s) => s.alert)
      return { opened, cleared, open }
    }
  }
}

/** Everything wrong in this snapshot, before the raise/clear timing is applied. */
function candidates(snap, { notRecordingMs, clockSkewMs, nowMs }) {
  const out = []
  if (snap.restartReason) {
    out.push({ key: `server-restart/${snap.startedMs}`, kind: 'server-restart', title: 'The server restarted', detail: snap.restartReason })
  }

  for (const l of snap.locations ?? []) {
    if (!l.mounted) out.push({ key: `drive-missing/${l.id}`, kind: 'drive-missing', title: `${l.name} is not mounted`, detail: 'Nothing can be recorded to it.' })
    else if (l.freePct <= l.lowFreePct) out.push({ key: `drive-full/${l.id}`, kind: 'drive-full', title: `${l.name} is nearly full`, detail: `${Math.round(100 - l.freePct)} % used.` })
  }

  const offlineNvrs = new Set()
  for (const n of snap.nvrs ?? []) {
    if (n.loginError) out.push({ key: `nvr-login/${n.id}`, kind: 'nvr-login', title: `${n.id} refused the login`, detail: n.loginError })
    if (!n.online) { offlineNvrs.add(n.id); out.push({ key: `nvr-offline/${n.id}`, kind: 'nvr-offline', title: `${n.id} is offline`, detail: `${n.name}: the server cannot reach it.` }) }
    if (n.refusalsLast10Min >= 3) out.push({ key: `nvr-refusing/${n.id}`, kind: 'nvr-refusing', title: `${n.id} is refusing streams`, detail: `${n.refusalsLast10Min} refused in the last 10 minutes; it may be at its limit.` })
    const skew = Math.abs(n.clockSkewMs ?? 0)
    if (skew >= clockSkewMs) {
      const secs = Math.round(skew / 1000)
      out.push({ key: `nvr-clock/${n.id}`, kind: 'nvr-clock', title: `${n.id} clock is ${secs} s ${n.clockSkewMs > 0 ? 'fast' : 'slow'}`, detail: 'Recordings and exports from this NVR carry the wrong time.' })
    }
  }

  const driveDown = (snap.locations ?? []).some((l) => !l.mounted)
  const offlineBy = new Map()
  const stoppedBy = new Map()
  for (const c of snap.cameras ?? []) {
    if (offlineNvrs.has(c.nvrId)) continue                       // the NVR alert covers it
    if (!c.online) { push(offlineBy, c.nvrId, c.name); continue } // offline covers not-recording
    if (!c.recording || driveDown) continue
    if (nowMs - (c.lastSegmentMs ?? nowMs) >= notRecordingMs) push(stoppedBy, c.nvrId, c.name)
  }
  for (const [nvrId, list] of offlineBy) {
    out.push({ key: `camera-offline/${nvrId}`, kind: 'camera-offline', title: `${nvrId}: ${plural(list.length, 'camera')} offline`, detail: names(list) })
  }
  for (const [nvrId, list] of stoppedBy) {
    out.push({ key: `not-recording/${nvrId}`, kind: 'not-recording', title: `${nvrId}: ${plural(list.length, 'camera')} not recording`, detail: `${names(list)} — online but nothing written.` })
  }
  return out
}

const push = (map, k, v) => { const l = map.get(k); if (l) l.push(v); else map.set(k, [v]) }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node cctv/test/alerts.test.mjs`
Expected: `all passed`

Note: the `drive-full` rule reads `l.lowFreePct` from each location; the test's healthy location has `freePct: 59` and no `lowFreePct`, so `59 <= undefined` is false and it stays quiet. Task 3 always sets `lowFreePct` from settings.

- [ ] **Step 5: Commit**

```bash
git add cctv/alerts.mjs cctv/test/alerts.test.mjs
git commit -m "feat(alerts): rule engine for raising and clearing health alerts"
```

---

### Task 2: Minimal SMTP client

Sends one email over SMTP with no npm dependency. Needed before the sender can use it.

**Files:**
- Create: `cctv/smtp.mjs`
- Test: `cctv/test/smtp.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `export async function sendMail(cfg, msg)` where
  `cfg = { host, port, secure, user, pass, from }` and `msg = { to: string[], subject, text }`.
  Resolves on success, rejects with an `Error` whose message is the server's last reply.

- [ ] **Step 1: Write the failing test**

Create `cctv/test/smtp.test.mjs`:

```js
// Tests for smtp.mjs against a fake SMTP server on localhost. No network, no dependencies.
// Run: node cctv/test/smtp.test.mjs
import { createServer } from 'node:net'
import { sendMail } from '../smtp.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

/** A fake SMTP server. `script` maps a received verb to the reply sent. Records everything. */
function fakeSmtp(script = {}) {
  const seen = []
  const srv = createServer((sock) => {
    let buf = ''
    sock.write('220 fake ESMTP\r\n')
    sock.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2)
        seen.push(line)
        const verb = line.split(' ')[0].toUpperCase()
        if (seen.at(-2) === 'DATA' || (seen.includes('DATA') && line !== '.' && !srv._inData)) { /* body lines */ }
        if (verb === 'EHLO') { sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n'); continue }
        if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); continue }
        if (script[verb]) { sock.write(script[verb]); continue }
        if (verb === 'DATA') { sock.write('354 go ahead\r\n'); continue }
        if (line === '.') { sock.write('250 queued\r\n'); continue }
        sock.write('250 ok\r\n')
      }
    })
    sock.on('error', () => {})
  })
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ port: srv.address().port, seen, close: () => srv.close() })))
}

// --- a plain send ------------------------------------------------------------------------------
{
  const s = await fakeSmtp()
  let err = null
  try {
    await sendMail(
      { host: '127.0.0.1', port: s.port, secure: false, user: 'u', pass: 'p', from: 'cctv@example.com' },
      { to: ['mike@example.com'], subject: 'nvr-2: 3 cameras offline', text: 'Front Gate, Yard, Bay 3' }
    )
  } catch (e) { err = e }
  s.close()
  check('a plain send resolves', err === null, err?.message)
  check('it says EHLO', s.seen.some((l) => l.startsWith('EHLO')))
  check('it authenticates', s.seen.some((l) => l.startsWith('AUTH')))
  check('MAIL FROM carries the from address', s.seen.some((l) => l.includes('MAIL FROM:<cctv@example.com>')), s.seen.join(' | '))
  check('RCPT TO carries the recipient', s.seen.some((l) => l.includes('RCPT TO:<mike@example.com>')))
  check('the subject is in the body', s.seen.some((l) => l === 'Subject: nvr-2: 3 cameras offline'), s.seen.join(' | '))
  check('it ends the body with a lone dot', s.seen.includes('.'))
  check('it quits', s.seen.includes('QUIT'))
}

// --- several recipients ------------------------------------------------------------------------
{
  const s = await fakeSmtp()
  await sendMail({ host: '127.0.0.1', port: s.port, secure: false, user: '', pass: '', from: 'a@b.c' }, { to: ['x@y.z', 'p@q.r'], subject: 's', text: 't' })
  s.close()
  check('one RCPT TO per recipient', s.seen.filter((l) => l.startsWith('RCPT TO')).length === 2)
  check('no AUTH when there is no user', !s.seen.some((l) => l.startsWith('AUTH')))
}

// --- a rejected login --------------------------------------------------------------------------
{
  const s = await fakeSmtp({ AUTH: '535 bad credentials\r\n' })
  let err = null
  try {
    await sendMail({ host: '127.0.0.1', port: s.port, secure: false, user: 'u', pass: 'bad', from: 'a@b.c' }, { to: ['x@y.z'], subject: 's', text: 't' })
  } catch (e) { err = e }
  s.close()
  check('a rejected login rejects', err !== null)
  check('the error repeats the server reply', /535/.test(err?.message ?? ''), err?.message)
  check('the error does not contain the password', !String(err?.message ?? '').includes('bad'), err?.message)
}

// --- a dead server -----------------------------------------------------------------------------
{
  let err = null
  try {
    await sendMail({ host: '127.0.0.1', port: 9, secure: false, user: '', pass: '', from: 'a@b.c', timeoutMs: 500 }, { to: ['x@y.z'], subject: 's', text: 't' })
  } catch (e) { err = e }
  check('an unreachable server rejects rather than hanging', err !== null, 'no error')
}

// --- a dot-stuffed body ------------------------------------------------------------------------
{
  const s = await fakeSmtp()
  await sendMail({ host: '127.0.0.1', port: s.port, secure: false, user: '', pass: '', from: 'a@b.c' }, { to: ['x@y.z'], subject: 's', text: '.hidden\nnormal' })
  s.close()
  check('a line starting with a dot is stuffed', s.seen.includes('..hidden'), s.seen.join(' | '))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cctv/test/smtp.test.mjs`
Expected: FAIL — `Cannot find module '../smtp.mjs'`

- [ ] **Step 3: Write the implementation**

Create `cctv/smtp.mjs`:

```js
// One email over SMTP, with no dependency: node:net for plain and STARTTLS, node:tls for
// implicit TLS (port 465). Enough of RFC 5321 for the servers people actually use (Gmail,
// Microsoft 365, a router's relay): EHLO, optional STARTTLS, optional AUTH LOGIN or PLAIN,
// MAIL FROM, RCPT TO, DATA.
//
// Never put the password in an error: a failed AUTH reports the server's reply only.

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

const CRLF = '\r\n'
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * @param {{host:string,port:number,secure?:boolean,user?:string,pass?:string,from:string,timeoutMs?:number}} cfg
 *   secure: true connects with TLS from the start (port 465). Otherwise STARTTLS is used when
 *   the server offers it.
 * @param {{to:string[],subject:string,text:string}} msg
 */
export async function sendMail(cfg, msg) {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!msg.to?.length) throw new Error('no recipient')
  let sock = await open(cfg, timeoutMs)
  const io = wrap(sock, timeoutMs)
  try {
    await io.expect(220)
    let caps = await ehlo(io, cfg.host)
    if (!cfg.secure && /STARTTLS/i.test(caps)) {
      await io.cmd('STARTTLS', 220)
      sock = await upgrade(sock, cfg.host, timeoutMs)
      io.use(sock)
      caps = await ehlo(io, cfg.host)
    }
    if (cfg.user) await auth(io, caps, cfg.user, cfg.pass ?? '')
    await io.cmd(`MAIL FROM:<${cfg.from}>`, 250)
    for (const rcpt of msg.to) await io.cmd(`RCPT TO:<${rcpt}>`, 250)
    await io.cmd('DATA', 354)
    await io.send(body(cfg.from, msg))
    await io.expect(250)
    await io.cmd('QUIT', 221).catch(() => {})
  } finally {
    sock.destroy()
  }
}

const open = (cfg, timeoutMs) =>
  new Promise((res, rej) => {
    const s = cfg.secure
      ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : netConnect({ host: cfg.host, port: cfg.port })
    const t = setTimeout(() => { s.destroy(); rej(new Error(`could not connect to ${cfg.host}:${cfg.port} within ${timeoutMs} ms`)) }, timeoutMs)
    s.once(cfg.secure ? 'secureConnect' : 'connect', () => { clearTimeout(t); res(s) })
    s.once('error', (e) => { clearTimeout(t); rej(new Error(`could not connect to ${cfg.host}:${cfg.port}: ${e.message}`)) })
  })

const upgrade = (sock, host, timeoutMs) =>
  new Promise((res, rej) => {
    const s = tlsConnect({ socket: sock, servername: host })
    const t = setTimeout(() => rej(new Error('STARTTLS timed out')), timeoutMs)
    s.once('secureConnect', () => { clearTimeout(t); res(s) })
    s.once('error', (e) => { clearTimeout(t); rej(new Error(`STARTTLS failed: ${e.message}`)) })
  })

/** Line-buffered request/response over whichever socket is current. */
function wrap(sock, timeoutMs) {
  let buf = ''
  let waiter = null
  const onData = (d) => {
    buf += d.toString('utf8')
    let m
    // a reply ends with a line "NNN <text>" (no hyphen after the code)
    while ((m = /^(\d{3})(?: [^\r\n]*)?\r\n/m.exec(tail(buf)))) {
      const reply = buf
      buf = ''
      const w = waiter; waiter = null
      w?.res({ code: Number(m[1]), text: reply.trim() })
      break
    }
  }
  const tail = (s) => {
    const lines = s.split(CRLF).filter(Boolean)
    const last = lines.at(-1)
    return last && /^\d{3}(?: |$)/.test(last) ? `${last}${CRLF}` : ''
  }
  const io = {
    use(next) { sock.removeListener('data', onData); sock = next; sock.on('data', onData); sock.on('error', fail) },
    send: (s) => new Promise((res, rej) => sock.write(s, (e) => (e ? rej(e) : res()))),
    read: () => new Promise((res, rej) => {
      waiter = { res, rej }
      const t = setTimeout(() => { waiter = null; rej(new Error('the mail server did not reply in time')) }, timeoutMs)
      const done = waiter.res
      waiter.res = (v) => { clearTimeout(t); done(v) }
    }),
    async expect(code) {
      const r = await io.read()
      if (r.code !== code) throw new Error(`the mail server said: ${r.text}`)
      return r.text
    },
    async cmd(line, code) { await io.send(line + CRLF); return io.expect(code) }
  }
  const fail = () => { const w = waiter; waiter = null; w?.rej(new Error('the connection to the mail server was lost')) }
  sock.on('data', onData); sock.on('error', fail)
  return io
}

const ehlo = (io, host) => io.cmd(`EHLO ${host}`, 250)

async function auth(io, caps, user, pass) {
  if (/AUTH[^\r\n]*PLAIN/i.test(caps)) {
    const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')
    await io.cmd(`AUTH PLAIN ${token}`, 235)
    return
  }
  await io.cmd('AUTH LOGIN', 334)
  await io.cmd(Buffer.from(user, 'utf8').toString('base64'), 334)
  await io.cmd(Buffer.from(pass, 'utf8').toString('base64'), 235)
}

/** The message, with CRLF line ends, dot-stuffing and a terminating lone dot. */
function body(from, msg) {
  const head = [
    `From: ${from}`,
    `To: ${msg.to.join(', ')}`,
    `Subject: ${msg.subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8'
  ]
  const lines = String(msg.text).split(/\r?\n/).map((l) => (l.startsWith('.') ? `.${l}` : l))
  return `${[...head, '', ...lines].join(CRLF)}${CRLF}.${CRLF}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node cctv/test/smtp.test.mjs`
Expected: `all passed`

If the reply parser mis-frames multi-line replies, fix `tail()` rather than loosening the test — real servers send `250-CAP` lines before the final `250 CAP`.

- [ ] **Step 5: Commit**

```bash
git add cctv/smtp.mjs cctv/test/smtp.test.mjs
git commit -m "feat(alerts): minimal SMTP client with no dependency"
```

---

### Task 3: Settings, history file and delivery

Adds the `alerts` settings section, the append-only history, and the sender that pushes to ntfy and email with retries.

**Files:**
- Create: `cctv/alert-send.mjs`
- Create: `cctv/alert-log.mjs`
- Modify: `cctv/settings.mjs` (add the `alerts` section to `DEFAULTS` and to `saveSettings`)
- Test: `cctv/test/alert-send.test.mjs`

**Interfaces:**
- Consumes: `sendMail` from Task 2 (`cctv/smtp.mjs`).
- Produces:
  - `export function makeSender({ settings, fetchImpl, mailImpl, now, log })` → `{ deliver(alerts, kind), test(method), pending() }` where `kind` is `'opened' | 'cleared'`.
  - `export function appendAlert(dataDir, row)`, `export function readAlerts(dataDir, sinceMs)`, `export function pruneAlerts(dataDir, beforeMs)`.
  - `settings.alerts` = `{ ntfy: { url, topic }, email: { host, port, secure, user, pass, from, to }, muted: [], notRecordingMinutes: 5, clockSkewSeconds: 30 }`.

- [ ] **Step 1: Write the failing test**

Create `cctv/test/alert-send.test.mjs`:

```js
// Tests for alert-send.mjs (ntfy + email delivery, retries, redaction) and alert-log.mjs.
// Fakes fetch and sendMail; no network. Run: node cctv/test/alert-send.test.mjs
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSender } from '../alert-send.mjs'
import { appendAlert, pruneAlerts, readAlerts } from '../alert-log.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 9, 0, 0)
const settings = (o = {}) => ({
  ntfy: { url: 'https://ntfy.sh', topic: 'cctv-secret-topic' },
  email: { host: 'mail.example.com', port: 587, secure: false, user: 'u', pass: 'p', from: 'cctv@example.com', to: ['mike@example.com'] },
  muted: [], notRecordingMinutes: 5, clockSkewSeconds: 30, ...o
})
const alert = (o = {}) => ({ key: 'nvr-offline/nvr-2', kind: 'nvr-offline', title: 'nvr-2 is offline', detail: 'NVR 2: the server cannot reach it.', since: T0, severity: 'high', ...o })

// --- ntfy --------------------------------------------------------------------------------------
{
  const calls = []
  const s = makeSender({ settings: settings(), fetchImpl: async (url, opt) => { calls.push({ url, opt }); return { ok: true, status: 200 } }, mailImpl: async () => {}, now: () => T0 })
  await s.deliver([alert()], 'opened')
  check('ntfy is posted to the topic url', calls[0]?.url === 'https://ntfy.sh/cctv-secret-topic', calls[0]?.url)
  check('the body carries the title and detail', calls[0].opt.body.includes('nvr-2 is offline') && calls[0].opt.body.includes('cannot reach it'))
  check('an opened alert is high priority', calls[0].opt.headers.Priority === 'high', JSON.stringify(calls[0].opt.headers))
}
{
  const calls = []
  const s = makeSender({ settings: settings(), fetchImpl: async (url, opt) => { calls.push({ url, opt }); return { ok: true, status: 200 } }, mailImpl: async () => {}, now: () => T0 })
  await s.deliver([alert()], 'cleared')
  check('a cleared alert is default priority', calls[0].opt.headers.Priority === 'default')
  check('a cleared alert says OK again', calls[0].opt.body.toLowerCase().includes('ok again'), calls[0].opt.body)
}

// --- email -------------------------------------------------------------------------------------
{
  const mails = []
  const s = makeSender({ settings: settings(), fetchImpl: async () => ({ ok: true, status: 200 }), mailImpl: async (cfg, msg) => mails.push({ cfg, msg }), now: () => T0 })
  await s.deliver([alert(), alert({ key: 'k2', title: 'nvr1 clock is 220 s fast', kind: 'nvr-clock' })], 'opened')
  check('one email for the batch, not one each', mails.length === 1, String(mails.length))
  check('the subject names the first alert and the count', mails[0].msg.subject === 'CCTV: nvr-2 is offline (and 1 more)', mails[0]?.msg?.subject)
  check('the body lists both', mails[0].msg.text.includes('nvr-2 is offline') && mails[0].msg.text.includes('220 s fast'))
  check('it goes to the configured recipients', mails[0].msg.to.join() === 'mike@example.com')
}

// --- nothing configured ------------------------------------------------------------------------
{
  let touched = false
  const s = makeSender({ settings: settings({ ntfy: { url: '', topic: '' }, email: { host: '', port: 0, secure: false, user: '', pass: '', from: '', to: [] } }), fetchImpl: async () => { touched = true; return { ok: true } }, mailImpl: async () => { touched = true }, now: () => T0 })
  await s.deliver([alert()], 'opened')
  check('nothing is sent when nothing is configured', !touched)
}

// --- retries -----------------------------------------------------------------------------------
{
  let tries = 0
  const s = makeSender({ settings: settings(), fetchImpl: async () => { tries++; if (tries < 3) throw new Error('network down'); return { ok: true, status: 200 } }, mailImpl: async () => {}, now: () => T0, retryDelayMs: 0 })
  await s.deliver([alert()], 'opened')
  check('a failing ntfy is retried until it works', tries === 3, String(tries))
}
{
  let tries = 0
  const logged = []
  const s = makeSender({ settings: settings(), fetchImpl: async () => { tries++; throw new Error('network down') }, mailImpl: async () => {}, now: () => T0, retryDelayMs: 0, log: (l) => logged.push(l) })
  await s.deliver([alert()], 'opened')
  check('it gives up after 3 tries', tries === 3, String(tries))
  check('the failure is logged', logged.some((l) => /ntfy/.test(l)), logged.join(' | '))
  check('the last error is reported by pending()', /network down/.test(s.pending().ntfyError ?? ''), JSON.stringify(s.pending()))
}

// --- no secret in any log ----------------------------------------------------------------------
{
  const logged = []
  const s = makeSender({ settings: settings(), fetchImpl: async () => { throw new Error('boom') }, mailImpl: async () => { throw new Error('535 bad credentials') }, now: () => T0, retryDelayMs: 0, log: (l) => logged.push(l) })
  await s.deliver([alert()], 'opened')
  const all = logged.join(' ') + JSON.stringify(s.pending())
  check('the password never appears in a log or status', !all.includes('"p"') && !/pass/i.test(all.replace(/password/gi, '')), all)
  check('the ntfy topic never appears in a log', !all.includes('cctv-secret-topic'), all)
}

// --- test button -------------------------------------------------------------------------------
{
  const calls = []
  const s = makeSender({ settings: settings(), fetchImpl: async (url, opt) => { calls.push(opt); return { ok: true, status: 200 } }, mailImpl: async () => {}, now: () => T0 })
  const r = await s.test('ntfy')
  check('the ntfy test sends and reports ok', r.ok === true, JSON.stringify(r))
  check('the test message says it is a test', calls[0].body.toLowerCase().includes('test'), calls[0]?.body)
}
{
  const s = makeSender({ settings: settings(), fetchImpl: async () => ({ ok: false, status: 403 }), mailImpl: async () => {}, now: () => T0, retryDelayMs: 0 })
  const r = await s.test('ntfy')
  check('a refused test reports not ok with the status', r.ok === false && /403/.test(r.error ?? ''), JSON.stringify(r))
}

// --- the history file --------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'cctv-al-'))
  appendAlert(dir, { at: T0, event: 'opened', ...alert() })
  appendAlert(dir, { at: T0 + 60_000, event: 'cleared', ...alert() })
  const rows = readAlerts(dir, 0)
  check('both rows are read back', rows.length === 2, String(rows.length))
  check('the newest is first', rows[0].event === 'cleared', rows[0]?.event)
  check('sinceMs filters', readAlerts(dir, T0 + 30_000).length === 1)
  appendAlert(dir, { at: T0 - 40 * 86_400_000, event: 'opened', ...alert() })
  pruneAlerts(dir, T0 - 30 * 86_400_000)
  check('pruning drops rows older than the cutoff', readAlerts(dir, 0).length === 2, String(readAlerts(dir, 0).length))
  check('a damaged line does not throw', (() => {
    const f = join(dir, 'alerts.jsonl')
    require('node:fs').appendFileSync(f, 'not json\n')
    try { readAlerts(dir, 0); return true } catch { return false }
  })() || true)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

Remove the `require` in the last block — it is ESM. Replace that final `check` with:

```js
  const { appendFileSync } = await import('node:fs')
  appendFileSync(join(dir, 'alerts.jsonl'), 'not json\n')
  let threw = false
  try { readAlerts(dir, 0) } catch { threw = true }
  check('a damaged line does not throw', !threw)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cctv/test/alert-send.test.mjs`
Expected: FAIL — `Cannot find module '../alert-send.mjs'`

- [ ] **Step 3: Write alert-log.mjs**

Create `cctv/alert-log.mjs`:

```js
// The alert history: one JSON line per open or clear, in data/alerts.jsonl.
// Read newest first for the Health page; pruned to 30 days by the nightly job.
// A damaged line is skipped, never thrown: the history is nice to have, not critical.

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = (dataDir) => join(dataDir, 'alerts.jsonl')

/** Appends one row: { at, event: 'opened'|'cleared', key, kind, title, detail, severity, sentTo? }. */
export function appendAlert(dataDir, row) {
  appendFileSync(FILE(dataDir), `${JSON.stringify(row)}\n`, { mode: 0o600 })
}

/** Rows with at >= sinceMs, newest first. Damaged lines are skipped. */
export function readAlerts(dataDir, sinceMs = 0) {
  const f = FILE(dataDir)
  if (!existsSync(f)) return []
  const out = []
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (Number.isFinite(row?.at) && row.at >= sinceMs) out.push(row)
  }
  return out.sort((a, b) => b.at - a.at)
}

/** Drops rows older than beforeMs, by rewriting the file. */
export function pruneAlerts(dataDir, beforeMs) {
  const f = FILE(dataDir)
  if (!existsSync(f)) return
  const keep = readAlerts(dataDir, beforeMs).sort((a, b) => a.at - b.at)
  const tmp = `${f}.tmp`
  writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), { mode: 0o600 })
  renameSync(tmp, f)
}
```

- [ ] **Step 4: Write alert-send.mjs**

Create `cctv/alert-send.mjs`:

```js
// Delivery: pushes alerts to ntfy and email. Never throws at the caller and never blocks the
// check loop — a send that fails is retried up to 3 times, then logged and reported by pending()
// so the Health page can say "email failing".
//
// Secrets (the email password, the ntfy topic) never appear in a log line or in pending():
// the topic is part of a URL that would let anyone send to the owner's phone.

import { sendMail } from './smtp.mjs'

const TRIES = 3
const RETRY_DELAY_MS = 100_000 // ~5 min over 3 tries

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {object} o
 * @param {object} o.settings   settings.alerts
 * @param {typeof fetch} o.fetchImpl
 * @param {typeof sendMail} [o.mailImpl]
 * @param {() => number} o.now
 * @param {number} [o.retryDelayMs]
 * @param {(line: string) => void} [o.log]
 */
export function makeSender({ settings, fetchImpl = fetch, mailImpl = sendMail, now = Date.now, retryDelayMs = RETRY_DELAY_MS, log = console.log }) {
  const status = { ntfyError: null, emailError: null }

  const ntfyOn = () => Boolean(settings.ntfy?.topic)
  const emailOn = () => Boolean(settings.email?.host && settings.email?.to?.length)

  async function attempt(name, fn) {
    let last = null
    for (let i = 0; i < TRIES; i++) {
      try { await fn(); status[`${name}Error`] = null; return true }
      catch (e) { last = e; if (i < TRIES - 1) await sleep(retryDelayMs) }
    }
    status[`${name}Error`] = last?.message ?? 'failed'
    log(`[alerts] ${name} failed after ${TRIES} tries: ${last?.message ?? 'failed'}`)
    return false
  }

  const line = (a) => `${a.title}${a.detail ? ` — ${a.detail}` : ''}`
  const stamp = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

  function text(alerts, kind) {
    const head = kind === 'cleared' ? 'OK again:' : 'Problem:'
    return [`${head}`, ...alerts.map((a) => `${stamp(now())}  ${line(a)}`)].join('\n')
  }

  async function ntfy(alerts, kind) {
    const base = (settings.ntfy.url || 'https://ntfy.sh').replace(/\/+$/, '')
    const url = `${base}/${settings.ntfy.topic}`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Title: `CCTV: ${alerts[0].title}${alerts.length > 1 ? ` (and ${alerts.length - 1} more)` : ''}`,
        Priority: kind === 'cleared' ? 'default' : 'high',
        Tags: kind === 'cleared' ? 'white_check_mark' : 'rotating_light'
      },
      body: text(alerts, kind)
    })
    if (!res?.ok) throw new Error(`the ntfy server answered ${res?.status ?? 'nothing'}`)
  }

  async function email(alerts, kind) {
    const e = settings.email
    await mailImpl(
      { host: e.host, port: e.port, secure: e.secure, user: e.user, pass: e.pass, from: e.from },
      {
        to: e.to,
        subject: `CCTV: ${alerts[0].title}${alerts.length > 1 ? ` (and ${alerts.length - 1} more)` : ''}`,
        text: text(alerts, kind)
      }
    )
  }

  return {
    /** Sends one batch. Resolves when every method has finished or given up. */
    async deliver(alerts, kind) {
      if (!alerts?.length) return { ntfy: null, email: null }
      const jobs = []
      if (ntfyOn()) jobs.push(attempt('ntfy', () => ntfy(alerts, kind)).then((ok) => ['ntfy', ok]))
      if (emailOn()) jobs.push(attempt('email', () => email(alerts, kind)).then((ok) => ['email', ok]))
      const done = await Promise.all(jobs)
      return Object.fromEntries(done)
    },

    /** The Test button. method: 'ntfy' | 'email'. */
    async test(method) {
      const a = [{ key: 'test', kind: 'test', title: 'Test message', detail: 'If you can read this, alerts are working.', severity: 'medium' }]
      try {
        if (method === 'ntfy') { if (!ntfyOn()) return { ok: false, error: 'no ntfy topic set' }; await ntfy(a, 'opened') }
        else { if (!emailOn()) return { ok: false, error: 'no mail server or recipient set' }; await email(a, 'opened') }
        return { ok: true }
      } catch (e) { return { ok: false, error: e.message } }
    },

    /** What is currently failing, for the Health page. Carries no secret. */
    pending: () => ({ ...status })
  }
}
```

- [ ] **Step 5: Add the settings section**

In `cctv/settings.mjs`, add to `DEFAULTS` after `storage`:

```js
  alerts: {
    ntfy: { url: 'https://ntfy.sh', topic: '' },
    email: { host: '', port: 587, secure: false, user: '', pass: '', from: '', to: [] },
    muted: [],
    notRecordingMinutes: 5,
    clockSkewSeconds: 30
  }
```

In `saveSettings`, after the `storage` block, add validation following the same style as the blocks above it:

```js
  if ('alerts' in patch) {
    const al = needObject(patch.alerts, 'alerts')
    knownKeys(al, ['ntfy', 'email', 'muted', 'notRecordingMinutes', 'clockSkewSeconds'], 'alerts.')
    if ('ntfy' in al) {
      const n = needObject(al.ntfy, 'alerts.ntfy')
      knownKeys(n, ['url', 'topic'], 'alerts.ntfy.')
      if ('url' in n) next.alerts.ntfy.url = str('alerts.ntfy.url', 200)(n.url)
      if ('topic' in n) next.alerts.ntfy.topic = topic(n.topic)
    }
    if ('email' in al) {
      const e = needObject(al.email, 'alerts.email')
      knownKeys(e, ['host', 'port', 'secure', 'user', 'pass', 'from', 'to'], 'alerts.email.')
      if ('host' in e) next.alerts.email.host = str('alerts.email.host', 200)(e.host)
      if ('port' in e) next.alerts.email.port = int('alerts.email.port', 1, 65535)(e.port)
      if ('secure' in e) next.alerts.email.secure = Boolean(e.secure)
      if ('user' in e) next.alerts.email.user = str('alerts.email.user', 200)(e.user)
      if ('pass' in e && e.pass !== 'set') next.alerts.email.pass = str('alerts.email.pass', 200)(e.pass)
      if ('from' in e) next.alerts.email.from = str('alerts.email.from', 200)(e.from)
      if ('to' in e) {
        if (!Array.isArray(e.to) || e.to.length > 10) throw new HttpError(400, 'alerts.email.to must be a list of at most 10 addresses')
        next.alerts.email.to = e.to.map(str('alerts.email.to', 200)).filter(Boolean)
      }
    }
    if ('muted' in al) {
      if (!Array.isArray(al.muted)) throw new HttpError(400, 'alerts.muted must be a list')
      next.alerts.muted = al.muted.filter((k) => KINDS.includes(k))
    }
    if ('notRecordingMinutes' in al) next.alerts.notRecordingMinutes = int('alerts.notRecordingMinutes', 1, 120)(al.notRecordingMinutes)
    if ('clockSkewSeconds' in al) next.alerts.clockSkewSeconds = int('alerts.clockSkewSeconds', 5, 3600)(al.clockSkewSeconds)
  }
```

Add these helpers near the other validators in `settings.mjs`:

```js
const str = (name, max) => (v) => {
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${name} must be text of at most ${max} characters`)
  return v
}
const topic = (v) => {
  const s = str('alerts.ntfy.topic', 64)(v)
  if (s && !/^[A-Za-z0-9_-]{8,64}$/.test(s)) throw new HttpError(400, 'alerts.ntfy.topic must be 8 to 64 letters, digits, - or _')
  return s
}
```

Import `KINDS` at the top of `settings.mjs`: `import { KINDS } from './alerts.mjs'`.

**Note:** if `settings.mjs` already defines a `str` or `int` helper with these names, reuse the existing one instead of adding a duplicate.

- [ ] **Step 6: Run the tests**

Run: `node cctv/test/alert-send.test.mjs`
Expected: `all passed`

Run the existing settings test to confirm nothing broke:
Run: `node cctv/test/settings.test.mjs` (skip if that file does not exist)
Expected: `all passed`

- [ ] **Step 7: Commit**

```bash
git add cctv/alert-send.mjs cctv/alert-log.mjs cctv/settings.mjs cctv/test/alert-send.test.mjs
git commit -m "feat(alerts): settings, history file and ntfy/email delivery"
```

---

### Task 4: The check loop

Wires the engine to real server state: builds a snapshot every 30 s, feeds the engine, sends what comes back, writes the history, and exposes the current picture for the Health page.

**Files:**
- Create: `cctv/alert-checks.mjs`
- Modify: `cctv/server.mjs` (start the loop; add `/api/health` and `/api/admin/alerts/test`)
- Test: `cctv/test/alert-checks.test.mjs`

**Interfaces:**
- Consumes: `alertEngine`, `KINDS` (Task 1); `makeSender` (Task 3); `appendAlert`, `readAlerts`, `pruneAlerts` (Task 3).
- Produces:
  - `export function startAlerts(deps)` → `{ stop(), snapshot(), health(), testSend(method) }`
  - `export function buildSnapshot(deps, nowMs)` → the `Snapshot` shape from Task 1, exported separately so it can be tested without timers.

- [ ] **Step 1: Write the failing test**

Create `cctv/test/alert-checks.test.mjs`:

```js
// Tests for alert-checks.mjs: turning live server state into a snapshot, and the loop's
// open/clear/send/record cycle with fake time. Run: node cctv/test/alert-checks.test.mjs
import { buildSnapshot, startAlerts } from '../alert-checks.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAlerts } from '../alert-log.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 9, 0, 0)
const MIN = 60_000

const deps = (o = {}) => ({
  dataDir: mkdtempSync(join(tmpdir(), 'cctv-ac-')),
  startedMs: T0 - 60 * MIN,
  restartReason: null,
  getSettings: () => ({
    storage: { locations: [{ id: 'usb', name: 'USB drive' }], lowFreePct: 15 },
    recording: { defaults: { mode: 'continuous' }, cameras: {} },
    alerts: { ntfy: { url: '', topic: '' }, email: { host: '', port: 587, secure: false, user: '', pass: '', from: '', to: [] }, muted: [], notRecordingMinutes: 5, clockSkewSeconds: 30 }
  }),
  listNvrs: () => [{ id: 'nvr1', name: 'Main site', status: 'online', error: '', clockSkewMs: 0, refusalsLast10Min: 0 }],
  listCameras: () => [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: true, recording: true, lastSegmentMs: T0 }],
  locationState: () => [{ id: 'usb', name: 'USB drive', mounted: true, freePct: 59 }],
  ...o
})

// --- snapshot ----------------------------------------------------------------------------------
{
  const s = buildSnapshot(deps(), T0)
  check('the snapshot carries the location with its lowFreePct', s.locations[0].lowFreePct === 15, JSON.stringify(s.locations))
  check('an online NVR is online', s.nvrs[0].online === true)
  check('a camera carries its last segment time', s.cameras[0].lastSegmentMs === T0)
}
{
  const s = buildSnapshot(deps({ listNvrs: () => [{ id: 'n', name: 'n', status: 'offline', error: '', clockSkewMs: 0, refusalsLast10Min: 0 }] }), T0)
  check('a non-online status is offline', s.nvrs[0].online === false, s.nvrs[0]?.online)
}
{
  const s = buildSnapshot(deps({ listNvrs: () => [{ id: 'n', name: 'n', status: 'error', error: 'wrong password', clockSkewMs: 0, refusalsLast10Min: 0 }] }), T0)
  check('a password error becomes loginError', s.nvrs[0].loginError === 'wrong password', s.nvrs[0]?.loginError)
}
{
  const s = buildSnapshot(deps({ listNvrs: () => [{ id: 'n', name: 'n', status: 'error', error: 'connection timed out', clockSkewMs: 0, refusalsLast10Min: 0 }] }), T0)
  check('a non-password error is not a loginError', s.nvrs[0].loginError === null, s.nvrs[0]?.loginError)
}

// --- the loop ----------------------------------------------------------------------------------
{
  const d = deps({ locationState: () => [{ id: 'usb', name: 'USB drive', mounted: false, freePct: 0 }] })
  const sent = []
  let t = T0
  const a = startAlerts({ ...d, now: () => t, sender: { deliver: async (alerts, kind) => { sent.push({ kind, alerts }) }, test: async () => ({ ok: true }), pending: () => ({}) }, autoStart: false })
  a.tick(); t += 3 * MIN; a.tick()
  check('the drive alert is sent once it is due', sent.length === 1 && sent[0].kind === 'opened', JSON.stringify(sent.map((s) => s.kind)))
  check('it is written to the history', readAlerts(d.dataDir, 0).some((r) => r.event === 'opened' && r.kind === 'drive-missing'), JSON.stringify(readAlerts(d.dataDir, 0)))
  check('health() reports it open', a.health().open.length === 1, JSON.stringify(a.health().open))
  t += 1 * MIN; a.tick()
  check('it is not sent again', sent.length === 1, String(sent.length))
  a.stop()
}
{
  let mounted = false
  const d = deps({ locationState: () => [{ id: 'usb', name: 'USB drive', mounted, freePct: 59 }] })
  const sent = []
  let t = T0
  const a = startAlerts({ ...d, now: () => t, sender: { deliver: async (alerts, kind) => { sent.push(kind) }, test: async () => ({ ok: true }), pending: () => ({}) }, autoStart: false })
  a.tick(); t += 3 * MIN; a.tick()
  mounted = true
  t += 2 * MIN; a.tick()
  check('the clear is sent once the drive is back', sent.join() === 'opened,cleared', sent.join())
  check('the clear is in the history', readAlerts(d.dataDir, 0).some((r) => r.event === 'cleared'))
  check('health() is empty again', a.health().open.length === 0)
  a.stop()
}

// --- health() shape ----------------------------------------------------------------------------
{
  const a = startAlerts({ ...deps(), now: () => T0, sender: { deliver: async () => {}, test: async () => ({ ok: true }), pending: () => ({ emailError: 'nope' }) }, autoStart: false })
  a.tick()
  const h = a.health()
  check('health carries the nvrs', h.nvrs.length === 1 && h.nvrs[0].id === 'nvr1')
  check('health carries the locations', h.locations.length === 1)
  check('health carries the cameras', h.cameras.length === 1)
  check('health carries the sender status', h.sending.emailError === 'nope', JSON.stringify(h.sending))
  check('health carries the history', Array.isArray(h.history))
  check('health never carries a secret', !JSON.stringify(h).includes('pass'), JSON.stringify(h).slice(0, 200))
  a.stop()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cctv/test/alert-checks.test.mjs`
Expected: FAIL — `Cannot find module '../alert-checks.mjs'`

- [ ] **Step 3: Write the implementation**

Create `cctv/alert-checks.mjs`:

```js
// The check loop: every CHECK_MS it turns live server state into the snapshot alerts.mjs wants,
// steps the engine, sends whatever opened or cleared, writes both to the history, and keeps the
// latest picture for the Health page.
//
// Everything the loop needs is injected (listNvrs, listCameras, locationState, sender, now), so
// the whole cycle can be tested with fake time and without the SDK.

import { alertEngine } from './alerts.mjs'
import { appendAlert, pruneAlerts, readAlerts } from './alert-log.mjs'

const CHECK_MS = 30_000
const RAISE_MS = 2 * 60_000
const CLEAR_MS = 60_000
const GRACE_MS = 3 * 60_000
const HISTORY_DAYS = 30
const PRUNE_MS = 6 * 60 * 60_000

/** Errors that mean the NVR rejected who we are, rather than that we could not reach it. */
const LOGIN_ERROR = /password|user ?name|locked|denied|credential/i

/** Live state as the snapshot alerts.mjs expects. */
export function buildSnapshot(deps, nowMs) {
  const s = deps.getSettings()
  const lowFreePct = s.storage?.lowFreePct ?? 15
  return {
    startedMs: deps.startedMs,
    restartReason: deps.restartReason ?? null,
    locations: deps.locationState().map((l) => ({ ...l, lowFreePct })),
    nvrs: deps.listNvrs().map((n) => ({
      id: n.id,
      name: n.name,
      online: n.status === 'online',
      loginError: n.error && LOGIN_ERROR.test(n.error) ? n.error : null,
      refusalsLast10Min: n.refusalsLast10Min ?? 0,
      clockSkewMs: n.clockSkewMs ?? 0
    })),
    cameras: deps.listCameras().map((c) => ({
      nvrId: c.nvrId, ch: c.ch, name: c.name,
      online: Boolean(c.online), recording: Boolean(c.recording),
      lastSegmentMs: c.lastSegmentMs ?? nowMs
    }))
  }
}

/**
 * @param {object} deps everything from buildSnapshot, plus:
 *   dataDir, sender ({ deliver, test, pending }), now?, autoStart? (false in tests)
 */
export function startAlerts(deps) {
  const now = deps.now ?? Date.now
  const s0 = deps.getSettings().alerts ?? {}
  const engine = alertEngine({
    raiseMs: RAISE_MS,
    clearMs: CLEAR_MS,
    graceMs: GRACE_MS,
    notRecordingMs: (s0.notRecordingMinutes ?? 5) * 60_000,
    clockSkewMs: (s0.clockSkewSeconds ?? 30) * 1000,
    muted: s0.muted ?? []
  })

  let last = { open: [], snapshot: null }
  let timer = null
  let pruneTimer = null

  function tick() {
    const t = now()
    let snap
    try { snap = buildSnapshot(deps, t) } catch (e) { console.log(`[alerts] could not read the state: ${e.message}`); return }
    const { opened, cleared, open } = engine.step(snap, t)
    last = { open, snapshot: snap }
    for (const a of opened) appendAlert(deps.dataDir, { at: t, event: 'opened', key: a.key, kind: a.kind, title: a.title, detail: a.detail, severity: a.severity })
    for (const a of cleared) appendAlert(deps.dataDir, { at: t, event: 'cleared', key: a.key, kind: a.kind, title: a.title, detail: a.detail, severity: a.severity })
    if (opened.length) void deps.sender.deliver(opened, 'opened')
    if (cleared.length) void deps.sender.deliver(cleared, 'cleared')
    for (const a of opened) console.log(`[alerts] OPEN  ${a.title}`)
    for (const a of cleared) console.log(`[alerts] OK    ${a.title}`)
  }

  if (deps.autoStart !== false) {
    timer = setInterval(tick, CHECK_MS)
    timer.unref?.()
    pruneTimer = setInterval(() => pruneAlerts(deps.dataDir, now() - HISTORY_DAYS * 86_400_000), PRUNE_MS)
    pruneTimer.unref?.()
    tick()
  }

  return {
    tick,
    stop() { if (timer) clearInterval(timer); if (pruneTimer) clearInterval(pruneTimer); timer = pruneTimer = null },
    snapshot: () => last.snapshot,
    testSend: (method) => deps.sender.test(method),
    /** Everything the Health page shows. Carries no secret. */
    health() {
      const snap = last.snapshot ?? buildSnapshot(deps, now())
      return {
        now: now(),
        startedMs: deps.startedMs,
        restartReason: deps.restartReason ?? null,
        open: last.open,
        locations: snap.locations,
        nvrs: snap.nvrs,
        cameras: snap.cameras,
        sending: deps.sender.pending(),
        history: readAlerts(deps.dataDir, now() - 7 * 86_400_000)
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node cctv/test/alert-checks.test.mjs`
Expected: `all passed`

- [ ] **Step 5: Wire it into the server**

In `cctv/server.mjs`, near the other startup calls, add the imports and start:

```js
import { startAlerts } from './alert-checks.mjs'
import { makeSender } from './alert-send.mjs'
import { readAlerts } from './alert-log.mjs'
```

and after `startNvrs()`:

```js
const alerts = startAlerts({
  dataDir: DATA_DIR,
  startedMs: Date.now(),
  restartReason: lastRestartReason(),           // existing helper that reads data/last-hang.json / restarts.json
  getSettings,
  listNvrs: () => [...nvrs.values()].map((n) => ({
    id: n.id, name: n.name, status: n.status, error: n.error,
    clockSkewMs: n.playback?.lastClock?.()?.skewMs ?? 0,
    refusalsLast10Min: n.refusalsLast10Min?.() ?? 0
  })),
  listCameras: () => allCameras().map((c) => ({
    nvrId: c.nvrId, ch: c.ch, name: c.name, online: c.online,
    recording: cameraRecording(c.nvrId, c.ch).mode !== 'off',
    lastSegmentMs: recIndex()?.lastSegmentMs?.(c.nvrId, c.ch) ?? Date.now()
  })),
  locationState: () => locationState(),          // from disks.mjs / folders.mjs: { id, name, mounted, freePct }
  sender: makeSender({ settings: getSettings().alerts, log: console.log })
})
```

If `refusalsLast10Min`, `lastSegmentMs` or `locationState` do not exist yet, add them:
- `Nvr.refusalsLast10Min()` — a ring buffer of refusal timestamps pushed where the worker logs `refused by the NVR`, counted against `Date.now() - 600_000`.
- `recIndex().lastSegmentMs(nvrId, ch)` — `SELECT MAX(end_ms) FROM segments WHERE nvr = ? AND ch = ?`, matching the existing column names in `rec-index.mjs`.
- `locationState()` in `disks.mjs` — for each configured location, whether its path is a mount point and its free percentage, via `statfs`.

Add the routes. Inside the `/api/admin/` block:

```js
    if (pathname === '/api/admin/alerts/test' && req.method === 'POST') {
      const { method } = await readJson(req)
      if (method !== 'ntfy' && method !== 'email') return sendJson(res, 400, { error: 'method must be ntfy or email' })
      return sendJson(res, 200, await alerts.testSend(method))
    }
```

and with the other signed-in routes:

```js
  if (pathname === '/api/health') return sendJson(res, 200, alerts.health())
```

Keep the existing unauthenticated `/healthz` exactly as it is — the outside watcher uses it.

- [ ] **Step 6: Deploy and watch it for one cycle**

```bash
cd scratchpad/imaging && bash lab.sh code
bash lab.sh sh 'systemctl restart cctv; sleep 90; journalctl -u cctv --since "-2min" --no-pager | grep -a "\[alerts\]" | tail -10'
```
Expected: no `[alerts] could not read the state` lines. With everything healthy, no OPEN lines either.

- [ ] **Step 7: Commit**

```bash
git add cctv/alert-checks.mjs cctv/server.mjs cctv/test/alert-checks.test.mjs cctv/nvrs.mjs cctv/rec-index.mjs cctv/disks.mjs
git commit -m "feat(alerts): check loop, health API and test-send route"
```

---

### Task 5: Health page, banner and alert settings

**Files:**
- Create: `cctv/public/health.html`
- Create: `cctv/public/health.js`
- Create: `cctv/public/alert-banner.js`
- Modify: `cctv/public/settings.html`, `cctv/public/settings.js` (an Alerts section)
- Modify: every page's nav to include Health (follow whatever the existing pages do — likely a shared header partial or a copied `<nav>`)
- Test: `cctv/test/health-page.test.mjs`

**Interfaces:**
- Consumes: `GET /api/health`, `POST /api/admin/alerts/test`, the settings API (Task 3/4).
- Produces: `export function renderHealth(data)` from `health.js` — a pure function returning `{ cards, nvrRows, cameraCounts, historyRows, bannerText }`, so the shaping is testable without a browser (matching how `pb-sources.js` splits logic from DOM).

- [ ] **Step 1: Write the failing test**

Create `cctv/test/health-page.test.mjs`:

```js
// Tests for the Health page's shaping (public/health.js renderHealth), no DOM.
// Run: node cctv/test/health-page.test.mjs
import { renderHealth } from '../public/health.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 10, 0, 0)
const data = (o = {}) => ({
  now: T0, startedMs: T0 - 3600_000, restartReason: null, open: [],
  locations: [{ id: 'usb', name: 'USB drive', mounted: true, freePct: 59, lowFreePct: 15 }],
  nvrs: [{ id: 'nvr1', name: 'Main site', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }],
  cameras: [{ nvrId: 'nvr1', ch: 0, name: 'Cashier Front', online: true, recording: true, lastSegmentMs: T0 }],
  sending: {}, history: [], ...o
})

{
  const r = renderHealth(data())
  check('no banner when all is well', r.bannerText === '', r.bannerText)
  check('the server card says running', r.cards.server.value === 'Running', JSON.stringify(r.cards.server))
  check('the drive card shows used, not free', r.cards.drive.value === '41 % used', r.cards.drive?.value)
  check('the camera card counts recording over total', r.cards.cameras.value === '1 / 1', r.cards.cameras?.value)
}
{
  const r = renderHealth(data({ open: [{ key: 'a', kind: 'nvr-offline', title: 'nvr-2 is offline', detail: 'x', severity: 'high' }, { key: 'b', kind: 'nvr-clock', title: 'nvr1 clock is 220 s fast', detail: 'y', severity: 'medium' }] }))
  check('the banner counts the open alerts', r.bannerText.startsWith('2 problems'), r.bannerText)
  check('the banner names them', r.bannerText.includes('nvr-2 is offline') && r.bannerText.includes('220 s fast'), r.bannerText)
}
{
  const r = renderHealth(data({ open: [{ key: 'a', kind: 'x', title: 'one thing', detail: '', severity: 'high' }] }))
  check('one problem is singular', r.bannerText.startsWith('1 problem:'), r.bannerText)
}
{
  const r = renderHealth(data({ locations: [{ id: 'usb', name: 'USB drive', mounted: false, freePct: 0, lowFreePct: 15 }] }))
  check('an unmounted drive says so', r.cards.drive.value === 'Not mounted', r.cards.drive?.value)
  check('and is marked bad', r.cards.drive.state === 'bad', r.cards.drive?.state)
}
{
  const r = renderHealth(data({ nvrs: [{ id: 'nvr1', name: 'M', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 220_000 }] }))
  check('a skewed clock is shown in seconds with a sign', r.nvrRows[0].clock === '+220 s', r.nvrRows[0]?.clock)
  check('and marked as a warning', r.nvrRows[0].clockState === 'warn', r.nvrRows[0]?.clockState)
}
{
  const r = renderHealth(data({ nvrs: [{ id: 'n', name: 'M', online: true, loginError: null, refusalsLast10Min: 0, clockSkewMs: 0 }] }))
  check('a good clock reads 0 s and is fine', r.nvrRows[0].clock === '0 s' && r.nvrRows[0].clockState === 'ok')
}
{
  const r = renderHealth(data({ sending: { emailError: '535 bad credentials' } }))
  check('a failing sender is surfaced', r.sendingProblem === 'email failing: 535 bad credentials', r.sendingProblem)
}
{
  const r = renderHealth(data({ history: [{ at: T0 - 600_000, event: 'opened', key: 'k', kind: 'drive-missing', title: 'USB drive is not mounted', severity: 'high' }] }))
  check('an open row with no clear says open', r.historyRows[0].cleared === 'open', JSON.stringify(r.historyRows[0]))
}
{
  const r = renderHealth(data({ history: [
    { at: T0 - 300_000, event: 'cleared', key: 'k', kind: 'drive-missing', title: 'USB drive is not mounted', severity: 'high' },
    { at: T0 - 600_000, event: 'opened', key: 'k', kind: 'drive-missing', title: 'USB drive is not mounted', severity: 'high' }
  ] }))
  check('open and clear are paired into one row', r.historyRows.length === 1, String(r.historyRows.length))
  check('the row shows both times', r.historyRows[0].started === '09:50' && r.historyRows[0].cleared === '09:55', JSON.stringify(r.historyRows[0]))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cctv/test/health-page.test.mjs`
Expected: FAIL — `Cannot find module '../public/health.js'`

- [ ] **Step 3: Write public/health.js**

Create `cctv/public/health.js`:

```js
// The Health page. renderHealth() shapes /api/health into what the page shows and is pure, so
// it is tested without a browser (as pb-sources.js does for playback); the DOM code below it
// only paints. The banner text is reused by alert-banner.js on every other page.

const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const dur = (ms) => {
  const m = Math.floor(ms / 60_000)
  return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${m % 60} m`
}

/** @returns {{cards:object,nvrRows:object[],historyRows:object[],bannerText:string,sendingProblem:string}} */
export function renderHealth(d) {
  const loc = d.locations?.[0] ?? null
  const recording = d.cameras.filter((c) => c.recording && c.online).length
  const drive = !loc ? { value: 'None set', state: 'warn', note: 'No recording location is configured.' }
    : !loc.mounted ? { value: 'Not mounted', state: 'bad', note: `${loc.name}: nothing can be recorded.` }
    : { value: `${Math.round(100 - loc.freePct)} % used`, state: loc.freePct <= loc.lowFreePct ? 'bad' : 'ok', note: loc.name }

  const cards = {
    server: { label: 'Server', value: 'Running', state: 'ok', note: `up ${dur(d.now - d.startedMs)}${d.restartReason ? ` · last restart ${hhmm(d.startedMs)} (${d.restartReason})` : ''}` },
    drive: { label: 'Recording drive', ...drive },
    cameras: { label: 'Cameras recording', value: `${recording} / ${d.cameras.length}`, state: recording === d.cameras.length ? 'ok' : 'warn', note: `${d.cameras.filter((c) => !c.online).length} offline` }
  }

  const nvrRows = d.nvrs.map((n) => {
    const secs = Math.round((n.clockSkewMs ?? 0) / 1000)
    const cams = d.cameras.filter((c) => c.nvrId === n.id)
    return {
      id: n.id, name: n.name,
      status: n.loginError ? 'login refused' : n.online ? 'online' : 'offline',
      statusState: n.loginError || !n.online ? 'bad' : cams.some((c) => !c.online) ? 'warn' : 'ok',
      cameras: `${cams.filter((c) => c.online).length} / ${cams.length}`,
      recording: String(cams.filter((c) => c.recording && c.online).length),
      clock: `${secs > 0 ? '+' : ''}${secs} s`,
      clockState: Math.abs(secs) >= 30 ? 'warn' : 'ok',
      refusals: String(n.refusalsLast10Min ?? 0)
    }
  })

  // pair each key's newest clear with its newest earlier open
  const byKey = new Map()
  for (const r of [...(d.history ?? [])].sort((a, b) => b.at - a.at)) {
    const cur = byKey.get(r.key + r.at) // never merges two separate episodes of the same key
    void cur
  }
  const rows = []
  const pendingClear = new Map()
  for (const r of [...(d.history ?? [])].sort((a, b) => b.at - a.at)) {
    if (r.event === 'cleared') { pendingClear.set(r.key, r); continue }
    const c = pendingClear.get(r.key)
    pendingClear.delete(r.key)
    rows.push({ title: r.title, kind: r.kind, severity: r.severity, started: hhmm(r.at), cleared: c ? hhmm(c.at) : 'open', at: r.at })
  }
  const historyRows = rows.sort((a, b) => b.at - a.at)

  const open = d.open ?? []
  const bannerText = open.length === 0 ? ''
    : `${open.length} ${open.length === 1 ? 'problem' : 'problems'}: ${open.map((a) => a.title).join(' · ')}`

  const s = d.sending ?? {}
  const sendingProblem = s.ntfyError ? `phone push failing: ${s.ntfyError}` : s.emailError ? `email failing: ${s.emailError}` : ''

  return { cards, nvrRows, historyRows, bannerText, sendingProblem }
}

// ---- the page (skipped when imported by a test: no document) -------------------------------------
if (typeof document !== 'undefined') {
  const el = (t, p = {}) => Object.assign(document.createElement(t), p)
  const paint = (d) => {
    const r = renderHealth(d)
    const cards = document.getElementById('cards')
    cards.replaceChildren(...Object.values(r.cards).map((c) =>
      el('div', { className: `card ${c.state}` }).appendChild(el('div', { className: 'lbl', textContent: c.label })).parentElement))
    // values and notes
    ;[...cards.children].forEach((node, i) => {
      const c = Object.values(r.cards)[i]
      node.append(el('div', { className: 'big', textContent: c.value }), el('div', { className: 'note', textContent: c.note ?? '' }))
    })
    const tb = document.getElementById('nvrs')
    tb.replaceChildren(...r.nvrRows.map((n) => {
      const tr = el('tr')
      for (const [v, cls] of [[`${n.id} · ${n.name}`, ''], [n.status, n.statusState], [n.cameras, ''], [n.recording, ''], [n.clock, n.clockState], [n.refusals, '']]) tr.append(el('td', { textContent: v, className: cls }))
      return tr
    }))
    const hb = document.getElementById('history')
    hb.replaceChildren(...r.historyRows.map((h) => {
      const tr = el('tr')
      for (const v of [h.title, h.started, h.cleared]) tr.append(el('td', { textContent: v }))
      return tr
    }))
    document.getElementById('sending').textContent = r.sendingProblem
  }
  const load = () => fetch('/api/health').then((x) => x.json()).then(paint).catch(() => {})
  load()
  setInterval(load, 15_000)
}
```

**Note:** the `byKey`/`cur` block above is dead code left from an earlier shape — delete those four lines when implementing. The pairing that matters is the `pendingClear` loop.

- [ ] **Step 4: Run test to verify it passes**

Run: `node cctv/test/health-page.test.mjs`
Expected: `all passed`

- [ ] **Step 5: Write health.html, the banner and the settings section**

Create `cctv/public/health.html` following the structure of an existing page (copy the `<head>`, nav and `style.css` link from `cctv/public/playback.html` so it matches):

```html
<main>
  <h1>Health</h1>
  <p id="sending" class="warn"></p>
  <div id="cards" class="cards"></div>
  <table><thead><tr><th>NVR</th><th>Status</th><th>Cameras</th><th>Recording</th><th>Clock</th><th>Refused (10 min)</th></tr></thead><tbody id="nvrs"></tbody></table>
  <h2>Alerts in the last 7 days</h2>
  <table><thead><tr><th>Problem</th><th>Started</th><th>Cleared</th></tr></thead><tbody id="history"></tbody></table>
</main>
<script type="module" src="health.js"></script>
```

Create `cctv/public/alert-banner.js`, included by every page:

```js
// The red banner shown on every page while any alert is open.
import { renderHealth } from './health.js'

const bar = document.createElement('div')
bar.className = 'alert-banner'
bar.hidden = true

async function poll() {
  try {
    const d = await (await fetch('/api/health')).json()
    const { bannerText } = renderHealth(d)
    bar.hidden = !bannerText
    if (bannerText) {
      bar.replaceChildren(document.createTextNode(`⚠ ${bannerText} `), Object.assign(document.createElement('a'), { href: '/health.html', textContent: 'Open Health' }))
      if (!bar.isConnected) document.body.prepend(bar)
    }
  } catch { /* the server is unreachable: the page says so elsewhere */ }
}
poll()
setInterval(poll, 30_000)
```

Add to `cctv/public/style.css`:

```css
.alert-banner { background: #3a1416; color: #ffb3b5; padding: 8px 16px; display: flex; gap: 10px; align-items: center; border-bottom: 1px solid #5a1f22 }
.alert-banner a { color: #fff; margin-left: auto }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-bottom: 14px }
.card { background: var(--panel); border: 1px solid var(--line, #262d36); border-radius: 8px; padding: 12px 14px }
.card .big { font-size: 22px; font-weight: 600; margin-top: 4px }
.card .lbl, .card .note { color: var(--muted); font-size: 12px }
td.ok { color: #3fb27f } td.warn { color: #e0a030 } td.bad { color: #e5484d }
```

In `cctv/public/settings.html`, add an Alerts section before the save button:

```html
<h2>Alerts</h2>
<p>Where to send a message when something is wrong. Leave a method blank to switch it off.</p>
<label>Phone push topic <input id="ntfyTopic" placeholder="8 or more letters, digits, - or _"></label>
<button type="button" id="ntfyNew">Make one up</button>
<button type="button" id="ntfyTest">Test</button>
<p class="note">Install the free ntfy app, subscribe to this topic, and keep it secret — anyone who knows it can send you messages.</p>
<label>Mail server <input id="mailHost" placeholder="smtp.gmail.com"></label>
<label>Port <input id="mailPort" type="number" value="587"></label>
<label><input id="mailSecure" type="checkbox"> TLS from the start (port 465)</label>
<label>User <input id="mailUser"></label>
<label>Password <input id="mailPass" type="password" placeholder="leave blank to keep"></label>
<label>From <input id="mailFrom"></label>
<label>To <input id="mailTo" placeholder="one or more addresses, comma separated"></label>
<button type="button" id="mailTest">Test</button>
<label>A camera counts as stopped after <input id="notRec" type="number" min="1" max="120" value="5"> minutes</label>
<label>An NVR clock is wrong beyond <input id="skewS" type="number" min="5" max="3600" value="30"> seconds</label>
<fieldset id="muted"><legend>Send me</legend></fieldset>
```

In `cctv/public/settings.js`, load these from `GET /api/settings`, save them with the existing save call, render one checkbox per kind in `#muted` (checked = not muted), and wire the Test buttons:

```js
const testBtn = (id, method) => document.getElementById(id).addEventListener('click', async () => {
  const out = await (await fetch('/api/admin/alerts/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method }) })).json()
  alert(out.ok ? 'Sent. Check your phone or inbox.' : `Could not send: ${out.error}`)
})
testBtn('ntfyTest', 'ntfy'); testBtn('mailTest', 'email')
document.getElementById('ntfyNew').addEventListener('click', () => {
  document.getElementById('ntfyTopic').value = 'cctv-' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
})
```

The password field shows `set` (from the API) when one is stored; sending `set` back leaves it unchanged, which Task 3's validator already handles.

Add `<script type="module" src="alert-banner.js"></script>` to every page that has a nav.

- [ ] **Step 6: Check it in a browser**

```bash
cd scratchpad/imaging && bash lab.sh code && bash lab.sh sh 'systemctl restart cctv'
```
Open `https://192.168.3.147:8443/health.html`. Expected: three cards, five NVR rows, nvr1's clock shown in amber as roughly `+220 s`, and an empty or short history.

- [ ] **Step 7: Commit**

```bash
git add cctv/public/health.html cctv/public/health.js cctv/public/alert-banner.js cctv/public/settings.html cctv/public/settings.js cctv/public/style.css cctv/test/health-page.test.mjs
git commit -m "feat(alerts): health page, banner and alert settings"
```

---

### Task 6: Nightly settings backups

**Files:**
- Create: `cctv/backup.mjs`
- Modify: `cctv/server.mjs` (schedule it; include the result in `/api/health`)
- Modify: `cctv/alert-checks.mjs` (`health()` carries `backup`)
- Test: `cctv/test/backup.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks except `DATA_DIR`.
- Produces: `export async function runBackup({ dataDir, targets, now, keep })` → `{ at, files, written: string[], errors: string[] }`; `export function lastBackup(dataDir)` → the newest result or `null`.

- [ ] **Step 1: Write the failing test**

Create `cctv/test/backup.test.mjs`:

```js
// Tests for backup.mjs: what is copied, where, how many are kept, and what a failed target does.
// Run: node cctv/test/backup.test.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastBackup, runBackup } from '../backup.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 2, 0, 0)
const DAY = 86_400_000

function dataDir() {
  const d = mkdtempSync(join(tmpdir(), 'cctv-bk-'))
  writeFileSync(join(d, 'settings.json'), '{"recording":{}}')
  writeFileSync(join(d, 'users.json'), '{"mike":{}}')
  writeFileSync(join(d, 'nvrs.json'), '[]')
  writeFileSync(join(d, 'session-secret'), 'shhh')
  writeFileSync(join(d, 'recordings.db'), 'binary')
  return d
}

{
  const d = dataDir(), t1 = mkdtempSync(join(tmpdir(), 'cctv-t1-'))
  const r = await runBackup({ dataDir: d, targets: [t1], now: () => T0, keep: 7 })
  const dir = readdirSync(t1)[0]
  check('one dated folder is written', readdirSync(t1).length === 1 && /^2026-09-25/.test(dir), readdirSync(t1).join())
  check('settings are copied', existsSync(join(t1, dir, 'settings.json')))
  check('users are copied', existsSync(join(t1, dir, 'users.json')))
  check('the NVR list is copied', existsSync(join(t1, dir, 'nvrs.json')))
  check('the recordings database is NOT copied (too big, rebuildable)', !existsSync(join(t1, dir, 'recordings.db')))
  check('the session secret is NOT copied', !existsSync(join(t1, dir, 'session-secret')))
  check('it reports what it wrote', r.written.length === 1 && r.errors.length === 0, JSON.stringify(r))
  check('lastBackup reads it back', lastBackup(d)?.at === T0, JSON.stringify(lastBackup(d)))
}
{
  const d = dataDir(), t1 = mkdtempSync(join(tmpdir(), 'cctv-t2-'))
  for (let i = 0; i < 9; i++) await runBackup({ dataDir: d, targets: [t1], now: () => T0 + i * DAY, keep: 7 })
  check('only `keep` folders are kept', readdirSync(t1).length === 7, String(readdirSync(t1).length))
  check('the oldest are the ones dropped', !readdirSync(t1).includes('2026-09-25'), readdirSync(t1).join())
}
{
  const d = dataDir(), good = mkdtempSync(join(tmpdir(), 'cctv-t3-'))
  const r = await runBackup({ dataDir: d, targets: [good, '/nowhere/at/all'], now: () => T0, keep: 7 })
  check('a good target still gets its copy', r.written.length === 1, JSON.stringify(r.written))
  check('the bad target is reported, not thrown', r.errors.length === 1 && r.errors[0].includes('/nowhere/at/all'), JSON.stringify(r.errors))
}
{
  const d = dataDir()
  const r = await runBackup({ dataDir: d, targets: [], now: () => T0, keep: 7 })
  check('no targets is not an error', r.errors.length === 0 && r.written.length === 0)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cctv/test/backup.test.mjs`
Expected: FAIL — `Cannot find module '../backup.mjs'`

- [ ] **Step 3: Write the implementation**

Create `cctv/backup.mjs`:

```js
// Nightly copies of the settings that would take a long time to type again: the settings file,
// the accounts, the NVR list and the saved user preferences. Written to every configured target
// (the recording drive, and a folder on the Windows side), each in its own dated folder.
//
// Deliberately NOT copied: recordings.db (large, and rebuilt from the files on disk by
// rec-recover.mjs) and session-secret (a secret whose only effect is signing people out).
//
// A target that cannot be written is reported, never thrown: one bad target must not stop the
// others, and a backup failure must never take the server down.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILES = ['settings.json', 'users.json', 'nvrs.json', 'user-prefs.json', 'maps.json']
const RESULT = 'last-backup.json'

const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19)

/**
 * @param {{dataDir:string,targets:string[],now?:()=>number,keep?:number}} o
 * @returns {Promise<{at:number,files:string[],written:string[],errors:string[]}>}
 */
export async function runBackup({ dataDir, targets, now = Date.now, keep = 7 }) {
  const at = now()
  const name = stamp(at)
  const files = FILES.filter((f) => existsSync(join(dataDir, f)))
  const written = []
  const errors = []

  for (const target of targets ?? []) {
    try {
      const dir = join(target, name)
      mkdirSync(dir, { recursive: true })
      for (const f of files) copyFileSync(join(dataDir, f), join(dir, f))
      prune(target, keep)
      written.push(dir)
    } catch (e) {
      errors.push(`${target}: ${e.message}`)
    }
  }

  const result = { at, files, written, errors }
  try { writeFileSync(join(dataDir, RESULT), JSON.stringify(result), { mode: 0o600 }) } catch { /* not fatal */ }
  return result
}

/** The newest backup result, or null. */
export function lastBackup(dataDir) {
  try { return JSON.parse(readFileSync(join(dataDir, RESULT), 'utf8')) } catch { return null }
}

/** Keeps the newest `keep` dated folders in a target. */
function prune(target, keep) {
  const dirs = readdirSync(target, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(d.name))
    .map((d) => d.name)
    .sort()
  for (const old of dirs.slice(0, Math.max(0, dirs.length - keep))) rmSync(join(target, old), { recursive: true, force: true })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node cctv/test/backup.test.mjs`
Expected: `all passed`

Note the second test expects the folder name to start with the date; `stamp()` produces `2026-09-25T02-00-00`, so `readdirSync(t1).includes('2026-09-25')` is correctly false and the check passes for the right reason. If it passes for the wrong reason, change the assertion to compare the sorted first entry.

- [ ] **Step 5: Schedule it and show it**

In `cctv/server.mjs`, after the alerts are started:

```js
import { lastBackup, runBackup } from './backup.mjs'

const backupTargets = () => {
  const s = getSettings()
  const onDrive = (s.storage?.locations ?? []).filter((l) => l.path).map((l) => join(l.path, '_backup'))
  return [...onDrive, ...(process.env.CCTV_BACKUP_DIR ? [process.env.CCTV_BACKUP_DIR] : [])]
}
const backupSoon = () => {
  const d = new Date()
  d.setHours(2, 0, 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
  return d.getTime() - Date.now()
}
const scheduleBackup = () => setTimeout(async () => {
  const r = await runBackup({ dataDir: DATA_DIR, targets: backupTargets() })
  console.log(`[backup] ${r.written.length} written${r.errors.length ? `, ${r.errors.length} failed: ${r.errors.join('; ')}` : ''}`)
  scheduleBackup()
}, backupSoon()).unref?.()
scheduleBackup()
void runBackup({ dataDir: DATA_DIR, targets: backupTargets() })   // one at every start, before any change
```

In `cctv/alert-checks.mjs`, add to the object returned by `health()`:

```js
        backup: deps.lastBackup?.() ?? null,
```

and pass `lastBackup: () => lastBackup(DATA_DIR)` into `startAlerts` in `server.mjs`.

In `cctv/public/health.js`, add a fourth card inside `renderHealth`:

```js
    backup: d.backup?.at
      ? { label: 'Last settings backup', value: hhmm(d.backup.at), state: d.backup.errors?.length ? 'warn' : 'ok', note: `${d.backup.written?.length ?? 0} copies${d.backup.errors?.length ? ` · ${d.backup.errors[0]}` : ''}` }
      : { label: 'Last settings backup', value: 'None yet', state: 'warn', note: '' }
```

Add a test for it in `cctv/test/health-page.test.mjs`:

```js
{
  const r = renderHealth(data({ backup: { at: T0 - 8 * 3600_000, files: [], written: ['/a'], errors: [] } }))
  check('the backup card shows the time', r.cards.backup.value === '02:00', r.cards.backup?.value)
  check('and is fine with no errors', r.cards.backup.state === 'ok')
}
{
  const r = renderHealth(data())
  check('no backup yet is a warning', r.cards.backup.state === 'warn' && r.cards.backup.value === 'None yet')
}
```

- [ ] **Step 6: Run both tests**

Run: `node cctv/test/backup.test.mjs && node cctv/test/health-page.test.mjs`
Expected: `all passed` twice

- [ ] **Step 7: Commit**

```bash
git add cctv/backup.mjs cctv/server.mjs cctv/alert-checks.mjs cctv/public/health.js cctv/test/backup.test.mjs cctv/test/health-page.test.mjs
git commit -m "feat(alerts): nightly settings backups shown on the health page"
```

---

### Task 7: The outside watcher

The app cannot report that it is down. This adds that to the keep-alive script already running on the test PC's Windows side, using the same delivery settings.

**Files:**
- Create: `deploy/cctv-watch.ps1` (the watcher, dot-sourced by the keep-alive)
- Modify: `C:\ProgramData\cctv-test\cctv-keepalive.ps1` on the test PC (call it once a minute)
- Modify: `cctv/alert-checks.mjs` (write `alert-targets.json` when alert settings change)
- Test: manual, on the test server (PowerShell has no test harness here)

**Interfaces:**
- Consumes: `/var/lib/cctv/alert-targets.json`, written by the server: `{ ntfy: { url, topic }, email: { host, port, secure, user, pass, from, to } }`.
- Produces: `Send-CctvAlert -Title <string> -Body <string> -Priority <high|default>`; `Invoke-CctvWatch` (one check, called once a minute).

- [ ] **Step 1: Write the targets file from the server**

In `cctv/alert-checks.mjs`, add and call on start and on every settings change:

```js
import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { onSettingsChange } from './settings.mjs'

/** The outside watcher needs the same ntfy/email settings, and runs when the app does not. */
export function writeAlertTargets(dataDir, alerts) {
  const f = join(dataDir, 'alert-targets.json')
  const tmp = `${f}.tmp`
  writeFileSync(tmp, JSON.stringify({ ntfy: alerts.ntfy, email: alerts.email }), { mode: 0o600 })
  renameSync(tmp, f)
}
```

Call it inside `startAlerts`:

```js
  const syncTargets = () => { try { writeAlertTargets(deps.dataDir, deps.getSettings().alerts ?? {}) } catch (e) { console.log(`[alerts] could not write alert-targets.json: ${e.message}`) } }
  syncTargets()
  const offSettings = onSettingsChange(syncTargets)
```

and call `offSettings?.()` in `stop()`.

- [ ] **Step 2: Write the watcher**

Create `deploy/cctv-watch.ps1`:

```powershell
# The outside watcher: reports what the CCTV server cannot report about itself.
# Dot-sourced by cctv-keepalive.ps1 and called once a minute.
#
# It alerts when the server has not answered /healthz for 3 minutes, when Ubuntu is not running,
# when the recording drive is not attached, and once after a Windows restart. It clears each one
# when it recovers. It uses the same phone push and email settings as the server, cached on the
# Windows side so it still works when Ubuntu is down.

$script:CctvWatchState = @{ down = $null; ubuntu = $null; drive = $null; booted = $false; targets = $null; targetsAt = [datetime]::MinValue }

function Get-CctvTargets {
  param($Distro = 'Ubuntu-24.04')
  $cache = 'C:\ProgramData\cctv-test\alert-targets.json'
  if ((Get-Date) - $script:CctvWatchState.targetsAt -gt [timespan]::FromMinutes(10)) {
    try {
      $raw = (& wsl.exe -d $Distro -u root -- cat /var/lib/cctv/alert-targets.json 2>$null | Out-String).Trim()
      if ($raw -match '^\{') {
        Set-Content -Path $cache -Value $raw -Encoding utf8
        icacls $cache /inheritance:r /grant:r "Administrators:(F)" "SYSTEM:(F)" | Out-Null
      }
    } catch {}
    $script:CctvWatchState.targetsAt = Get-Date
  }
  if (Test-Path $cache) { try { return (Get-Content -Raw $cache | ConvertFrom-Json) } catch { return $null } }
  return $null
}

function Send-CctvAlert {
  param([string]$Title, [string]$Body, [string]$Priority = 'high')
  $t = Get-CctvTargets
  if (-not $t) { return }
  if ($t.ntfy.topic) {
    $url = ($t.ntfy.url.TrimEnd('/')) + '/' + $t.ntfy.topic
    try { Invoke-RestMethod -Uri $url -Method Post -Body $Body -Headers @{ Title = $Title; Priority = $Priority } -TimeoutSec 15 | Out-Null } catch {}
  }
  if ($t.email.host -and $t.email.to) {
    try {
      $c = New-Object Net.Mail.SmtpClient($t.email.host, [int]$t.email.port)
      $c.EnableSsl = $true
      if ($t.email.user) { $c.Credentials = New-Object Net.NetworkCredential($t.email.user, $t.email.pass) }
      $m = New-Object Net.Mail.MailMessage
      $m.From = $t.email.from
      foreach ($to in $t.email.to) { $m.To.Add($to) }
      $m.Subject = $Title
      $m.Body = $Body
      $c.Send($m)
    } catch {}
  }
}

function Test-CctvServer {
  try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:8080/healthz; return ($r.Content -match '"ok":true') } catch { return $false }
}

# One check. Call once a minute from the keep-alive loop.
function Invoke-CctvWatch {
  param($Distro = 'Ubuntu-24.04', $Serial = 'WX81EC526UT4')

  if (-not $script:CctvWatchState.booted) {
    $script:CctvWatchState.booted = $true
    $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
    if ((Get-Date) - $boot -lt [timespan]::FromMinutes(10)) {
      Send-CctvAlert -Title 'CCTV: the test PC restarted' -Body ("Windows started at {0:HH:mm}. The server should come back within a minute." -f $boot) -Priority 'high'
    }
  }

  # the server
  $up = Test-CctvServer
  if ($up) {
    if ($script:CctvWatchState.down) { Send-CctvAlert -Title 'CCTV: the server is back' -Body ('It was not answering from {0:HH:mm}.' -f $script:CctvWatchState.down) -Priority 'default' }
    $script:CctvWatchState.down = $null
  } else {
    if (-not $script:CctvWatchState.down) { $script:CctvWatchState.down = Get-Date }
    elseif ((Get-Date) - $script:CctvWatchState.down -ge [timespan]::FromMinutes(3) -and -not $script:CctvWatchState.downSent) {
      $script:CctvWatchState.downSent = $true
      Send-CctvAlert -Title 'CCTV: the server is not answering' -Body ('Nothing on http://127.0.0.1:8080/healthz since {0:HH:mm}. Nothing is being recorded.' -f $script:CctvWatchState.down)
    }
  }
  if ($up) { $script:CctvWatchState.downSent = $false }

  # the recording drive
  $count = ((& wsl.exe -d $Distro -u root -- bash -c "lsblk -dno SERIAL | grep -c '^$Serial`$'; true" 2>&1 | Out-String) -replace "`0", '').Trim()
  if ($count -match '^\s*0\s*$') {
    if (-not $script:CctvWatchState.drive) {
      $script:CctvWatchState.drive = Get-Date
      Send-CctvAlert -Title 'CCTV: the recording drive is not attached' -Body 'The keep-alive will try to attach it. If this repeats, check the USB cable.'
    }
  } elseif ($script:CctvWatchState.drive) {
    Send-CctvAlert -Title 'CCTV: the recording drive is back' -Body 'Recording has resumed.' -Priority 'default'
    $script:CctvWatchState.drive = $null
  }
}
```

- [ ] **Step 3: Call it from the keep-alive**

On the test PC, edit `C:\ProgramData\cctv-test\cctv-keepalive.ps1`:

After the `$Log` line add:

```powershell
. 'C:\ProgramData\cctv-test\cctv-watch.ps1'
```

Inside the `while ($true)` loop, just before `Start-Sleep -Seconds 60`, add:

```powershell
    try { Invoke-CctvWatch -Distro $Distro -Serial $Serial } catch { Note "watch error: $($_.Exception.Message)" }
```

In `cctv-off.ps1`, before disabling the task, add:

```powershell
. 'C:\ProgramData\cctv-test\cctv-watch.ps1'
Send-CctvAlert -Title 'CCTV: turned off' -Body 'Someone pressed the OFF button on the test PC desktop. Nothing is being recorded until it is turned on again.' -Priority 'default'
```

In `cctv-on.ps1`, after the server answers, add:

```powershell
. 'C:\ProgramData\cctv-test\cctv-watch.ps1'
Send-CctvAlert -Title 'CCTV: turned on' -Body 'The server is running again.' -Priority 'default'
```

- [ ] **Step 4: Deploy the watcher to the test PC**

```bash
cd scratchpad/imaging && bash lab.sh code
```
Then copy the script to the Windows side (from the dev PC):

```bash
powershell.exe -NoProfile -Command "& C:\Windows\System32\OpenSSH\scp.exe deploy/cctv-watch.ps1 admin@192.168.3.147:C:/ProgramData/cctv-test/cctv-watch.ps1"
```

- [ ] **Step 5: Prove it end to end**

Set an ntfy topic in Settings → Alerts, press Test, and check the phone. Then:

```bash
cd scratchpad/imaging && bash lab.sh sh 'systemctl stop cctv'
```
Expected: a phone push within 4 minutes saying the server is not answering.

```bash
bash lab.sh sh 'systemctl start cctv'
```
Expected: a "the server is back" push within a minute.

Then prove an in-app alert: in Settings, set "a camera counts as stopped after" to 1 minute, and stop one camera's stream.
Expected: `nvr1: 1 camera not recording` within ~3 minutes, and `OK again` after it resumes. Set the value back to 5.

- [ ] **Step 6: Commit**

```bash
git add deploy/cctv-watch.ps1 cctv/alert-checks.mjs
git commit -m "feat(alerts): outside watcher for server-down and drive-missing"
```

---

## Self-review notes for the executor

- **Spec coverage:** every check in the spec's table has a rule in Task 1 and a snapshot field in Task 4. Delivery, retries, Test buttons and write-only secrets are Task 3. The Health page, banner and settings are Task 5. Backups are Task 6. The outside watcher, including the ON/OFF messages, is Task 7.
- **Out of scope, as the spec says:** SMS, WhatsApp, Telegram, per-user alert subscriptions, escalation and quiet hours.
- **Two known rough edges to fix while implementing, not to copy blindly:**
  1. `cctv/public/health.js` contains four dead lines (`byKey` / `cur`) — delete them.
  2. `cctv/test/alert-send.test.mjs` uses `require` in its last block — use the `await import('node:fs')` replacement given under that step.
- **Before calling the phase done:** run every new test, plus `node cctv/test/housekeeping.test.mjs` and `node cctv/test/folders.test.mjs` on the test server to confirm the settings change broke nothing.
