# NVR Settings Through the Worker's Login — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an NVR refuses the main process's control login but its live worker is logged in, send XML settings commands, reboot/shutdown and the camera-detail read through the worker's login.

**Architecture:** `transparent()` and `power()` in `cctv/nvr-xml.mjs` keep their queue, turn, breaker and cap; only the final native call is swapped for a request to the NVR's worker when `nvr.borrowing` is true. The supervisor gains a request/reply channel to the worker (the protocol's first), and the worker answers by calling the same `transparent()` / `power()` / `cameraDetail()` on its own `Nvr`. Callers stop asking `nvr.online` / `nvr.degraded` / `nvr.gen` and ask `xmlOnline(nvr)` / `xmlDegraded(nvr)` / `xmlGen(nvr)` instead.

**Tech Stack:** Node 24 ES modules, `child_process.fork` IPC (`serialization: 'advanced'`), the TVT SDK through koffi (Linux only), standalone test scripts with a `check()` helper (no test framework).

**Spec:** `docs/superpowers/specs/2026-10-06-xml-control-via-worker-design.md`

## Global Constraints

- Scope is XML control only. Do **not** change any `online` / `degraded` / `gen` check in `playback.mjs`, `motion.mjs`, `backfill.mjs`, `rec-playback.mjs`, `rec-fallback.mjs`, `live.mjs`, `recorder.mjs`, `alerts.mjs`, `warm-streams.mjs`, or `events.mjs` `pollable()`.
- No behaviour change for an NVR whose control login is up.
- Kill switch: `CCTV_XML_VIA_WORKER=off` disables borrowing. Default is on. Read it at call time, not at import.
- Borrowing requires all of: control login not up; it has failed at least once since it was last up (or since start); worker `ready` with `status: 'online'`; switch not `off`.
- Request timeout is 95 000 ms (`XML_CAP_MS` 90 000 + 5 000). The camera-detail request uses 200 000 ms.
- Refusal wording stays as today: `"<name> is offline"` and `"<name> reconnected; nothing was sent"`.
- A write or power command lost with the worker reports: `"<name>: the connection was lost; the change may or may not have been made"`.
- Health panel wording, verbatim: `Settings are going through the video login; the NVR is refusing a second one.`
- Match the surrounding code: no semicolons, single quotes, 2-space indent, comments that say why. Copy style for user-facing text: sentence case, plain words, no exclamation marks.
- Tests are standalone scripts run with `node cctv/test/<name>.test.mjs`; exit code 0 and a last line `all passed` mean success.
- **Where tests run.** `worker-requests`, `xml-session`, `xml-online-wiring` and `health-page` tests import no SDK and run on Windows. `nvr-xml`, `camera-poll` and `live-worker` tests load the Linux SDK library and fail at import on Windows. For those, push the branch and read the `cctv app tests` CI job on the draft PR (about 19 minutes). Do not run tests on the production server.
- Commit after every task. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Deploying to production is not part of this plan's tasks; Task 7 stops at a PR and a checklist for Mike.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `cctv/worker-ipc.mjs` | modify | adds `MSG.REQ`, `MSG.RES` |
| `cctv/worker-requests.mjs` | create | the pending-request book: ids, timeouts, replies, fail-all. No I/O, no SDK |
| `cctv/worker-supervisor.mjs` | modify | `request()`, `spawnedAt()`; routes `RES`; fails pending on exit |
| `cctv/nvr-worker.mjs` | modify | answers `REQ` (`xml`, `power`, `detail`); reports `gen` in STATS |
| `cctv/xml-session.mjs` | create | `xmlOnline`, `xmlDegraded`, `xmlGen` helpers. No SDK, so SDK-free modules can import it |
| `cctv/nvrs.mjs` | modify | `controlFailed`, getters `borrowing` / `xmlOnline` / `xmlGen` / `xmlDegraded`; `cameraDetail()` borrows |
| `cctv/nvr-xml.mjs` | modify | `transparent()`, `power()`, `requireOnline()` use the session helpers and the worker path |
| 14 XML caller modules, `events.mjs`, `server.mjs` | modify | online / degraded / gen checks moved to the helpers |
| `cctv/alert-checks.mjs`, `cctv/public/health.js` | modify | `borrowing` reaches the Health panel |
| `cctv/test/worker-requests.test.mjs`, `xml-session.test.mjs`, `xml-online-wiring.test.mjs` | create | new tests |
| `cctv/test/live-worker.test.mjs`, `camera-poll.test.mjs`, `nvr-xml.test.mjs`, `health-page.test.mjs` | modify | added checks |

---

### Task 1: The request book and the two new messages

**Files:**
- Modify: `cctv/worker-ipc.mjs`
- Create: `cctv/worker-requests.mjs`
- Test: `cctv/test/worker-requests.test.mjs`

**Interfaces:**
- Produces: `MSG.REQ === 'req'`, `MSG.RES === 'res'`.
- Produces: `REQUEST_TIMEOUT_MS = 95_000`.
- Produces: `makeRequests({ send, timeoutMs? })` returning `{ request(msg, { timeoutMs? }) => Promise<reply>, onReply(m) => boolean, failAll(why) => void, size() => number }`.
  - `send(m)` returns `false` (or throws) when nothing could be sent.
  - A reply is `{ t: 'res', id, ok: true, ...fields }` or `{ t: 'res', id, ok: false, error: { message, name, status, extra } }`.
  - Rejections are `Error`s with `name`: `'SdkTimeout'` (no reply in time), `'WorkerNotReady'` (not sent), `'WorkerLost'` (`failAll`), or the worker's own `error.name`; `status` and `extra` are copied from `error` when present.

- [ ] **Step 1: Write the failing test**

Create `cctv/test/worker-requests.test.mjs`:

```js
// The requests the main process sends to an NVR's live worker and waits on (worker-requests.mjs):
// each gets an id, the reply with that id settles it, a reply that never comes times out, and a
// worker that exits fails every one still waiting. No worker is started; nothing reaches an NVR.
// Run:  node cctv/test/worker-requests.test.mjs
import { setTimeout as sleep } from 'node:timers/promises'
import { MSG } from '../worker-ipc.mjs'
import { REQUEST_TIMEOUT_MS, makeRequests } from '../worker-requests.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const J = (v) => JSON.stringify(v)

check('the messages exist', MSG.REQ === 'req' && MSG.RES === 'res')
check('the default wait is the XML cap plus 5 s', REQUEST_TIMEOUT_MS === 95_000)

{
  const sent = []
  const r = makeRequests({ send: (m) => void sent.push(m) })
  const p1 = r.request({ op: 'xml', url: 'queryTimeCfg' })
  const p2 = r.request({ op: 'power', action: 'reboot' })
  check('a request is sent with its type and an id', sent[0].t === MSG.REQ && sent[0].op === 'xml' && Number.isInteger(sent[0].id), J(sent[0]))
  check('ids differ', sent[0].id !== sent[1].id)
  check('two are waiting', r.size() === 2)
  // replies out of order
  check('a reply is taken', r.onReply({ t: MSG.RES, id: sent[1].id, ok: true, accepted: true }) === true)
  check('the second request got its own reply', (await p2).accepted === true)
  r.onReply({ t: MSG.RES, id: sent[0].id, ok: true, text: '<x/>' })
  check('the first request got its own reply', (await p1).text === '<x/>')
  check('none are waiting', r.size() === 0)
  check('a reply nobody waits for is ignored', r.onReply({ t: MSG.RES, id: 999, ok: true }) === false)
}

{
  const sent = []
  const r = makeRequests({ send: (m) => void sent.push(m) })
  const p = r.request({ op: 'xml' }).catch((e) => e)
  r.onReply({ t: MSG.RES, id: sent[0].id, ok: false, error: { message: 'busy', name: 'Error', status: 503, extra: { retryAfterS: 5 } } })
  const e = await p
  check('a refusal rejects with the message, status and extra', e instanceof Error && e.message === 'busy' && e.status === 503 && e.extra?.retryAfterS === 5, J({ m: e.message, s: e.status, x: e.extra }))
  const q = r.request({ op: 'xml' }).catch((e) => e)
  r.onReply({ t: MSG.RES, id: sent[1].id, ok: false, error: { message: 'late', name: 'SdkTimeout' } })
  check("the worker's error name is kept", (await q).name === 'SdkTimeout')
}

{
  const r = makeRequests({ send: () => {}, timeoutMs: 40 })
  const t0 = Date.now()
  const e = await r.request({ op: 'xml' }).catch((e) => e)
  check('no reply: times out', e.name === 'SdkTimeout' && Date.now() - t0 >= 35, `${e.name} after ${Date.now() - t0} ms`)
  check('a timed-out request is forgotten', r.size() === 0)
  const slow = await r.request({ op: 'detail' }, { timeoutMs: 120 }).catch((e) => ({ e, ms: Date.now() }))
  check('a request can ask for a longer wait', slow.e?.name === 'SdkTimeout')
}

{
  const notSent = makeRequests({ send: () => false })
  const e = await notSent.request({ op: 'xml' }).catch((e) => e)
  check('nothing sent: refused at once', e.name === 'WorkerNotReady' && notSent.size() === 0, e.name)
  const throws = makeRequests({ send: () => { throw new Error('channel closed') } })
  check('a send that throws is the same refusal', (await throws.request({ op: 'xml' }).catch((e) => e)).name === 'WorkerNotReady')
}

{
  const r = makeRequests({ send: () => {} })
  const ps = [r.request({ op: 'xml' }).catch((e) => e), r.request({ op: 'power' }).catch((e) => e)]
  r.failAll('the video connection restarted')
  const [a, b] = await Promise.all(ps)
  check('the worker went: every waiting request fails', a.name === 'WorkerLost' && b.name === 'WorkerLost' && a.message === 'the video connection restarted')
  check('and none are left', r.size() === 0)
  await sleep(10)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node cctv/test/worker-requests.test.mjs`
Expected: FAIL at import with `Cannot find module ... worker-requests.mjs`.

- [ ] **Step 3: Add the messages**

In `cctv/worker-ipc.mjs`, add one comment line above `export const MSG` and extend the object:

```js
// (req / res: parent -> worker, one command to send on the worker's own NVR login, and its answer; worker-requests.mjs)
export const MSG = { WANT: 'want', UNWANT: 'unwant', RESTART: 'restart', STOP: 'stop', READY: 'ready', STATE: 'state', FRAME: 'frame', STATS: 'stats', SETTINGS: 'settings', EVENTS: 'events', SEGOPEN: 'segopen', SEGMENT: 'segment', RECGAP: 'recgap', LINKRESET: 'linkreset', REQ: 'req', RES: 'res' }
```

- [ ] **Step 4: Write the request book**

Create `cctv/worker-requests.mjs`:

```js
// Requests the main process sends to an NVR's live worker and waits on (worker-ipc.mjs REQ / RES).
// Everything else in the protocol is one-way. These exist for an NVR that refuses the main
// process's own login while its worker is logged in (shad, 2026-10-06, at its session limit): the
// command goes out on the worker's login instead (nvr-xml.mjs).
// Only the book-keeping lives here, with no child process in it, so it can be tested by itself:
// worker-supervisor.mjs supplies `send` and feeds the replies in.
import { MSG } from './worker-ipc.mjs'

export const REQUEST_TIMEOUT_MS = 95_000 // nvr-xml.mjs XML_CAP_MS plus 5 s: the worker's own cap comes first

const named = (name, message, more = {}) => Object.assign(new Error(message), { name, ...more })

/**
 * @param {{ send: (m: object) => boolean | void, timeoutMs?: number }} o send: hands a message to
 *   the worker; false (or a throw) means nothing was sent.
 */
export function makeRequests({ send, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const pending = new Map() // id -> { resolve, reject, timer }
  let nextId = 1
  return {
    size: () => pending.size,
    /** Resolves to the worker's reply; rejects with its refusal, a timeout, or the worker going. */
    request(msg, { timeoutMs: wait = timeoutMs } = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(named('SdkTimeout', 'the video connection did not answer in time'))
        }, wait)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        let sent = false
        try {
          sent = send({ ...msg, t: MSG.REQ, id }) !== false
        } catch {
          sent = false
        }
        if (sent) return
        clearTimeout(timer)
        pending.delete(id)
        reject(named('WorkerNotReady', 'the video connection is not ready; nothing was sent'))
      })
    },
    /** A RES message from the worker; false if nobody is waiting for it (it timed out meanwhile). */
    onReply(m) {
      const p = pending.get(m?.id)
      if (!p) return false
      clearTimeout(p.timer)
      pending.delete(m.id)
      if (m.ok) p.resolve(m)
      else p.reject(named(m.error?.name || 'Error', m.error?.message || 'the request failed', { status: m.error?.status ?? undefined, extra: m.error?.extra ?? undefined }))
      return true
    },
    /** The worker exited or was restarted: nothing still waiting will be answered. */
    failAll(why) {
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(named('WorkerLost', why))
      }
      pending.clear()
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node cctv/test/worker-requests.test.mjs`
Expected: every line `PASS`, last line `all passed`.

- [ ] **Step 6: Commit**

```bash
git add cctv/worker-ipc.mjs cctv/worker-requests.mjs cctv/test/worker-requests.test.mjs
git commit -m "Worker: a request book for commands the main process waits on

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The supervisor sends requests; the worker answers them

**Files:**
- Modify: `cctv/worker-supervisor.mjs`
- Modify: `cctv/nvr-worker.mjs`
- Test: `cctv/test/live-worker.test.mjs` (the `// ---- Task 4: supervisor` block)

**Interfaces:**
- Consumes: `makeRequests` and `MSG.REQ` / `MSG.RES` from Task 1.
- Produces, on the object `startWorker()` returns:
  - `request(msg, { timeoutMs? }) => Promise<reply>` — rejects `WorkerNotReady` unless the worker is `ready` and connected;
  - `spawnedAt() => number` — when the current worker process was started (0 if none).
- Produces, in every STATS message: `gen` (integer, the worker's `nvr.gen`).
- Produces, worker request ops (`msg.gen`, when not null, must equal the worker's `nvr.gen` or the reply is `ok: false` with `"<name> reconnected; nothing was sent"`):
  - `{ op: 'xml', url, xml, tag, outBytes, gen }` → `{ ok: true, text }`
  - `{ op: 'power', action: 'reboot' | 'shutdown', gen }` → `{ ok: true, accepted: boolean }`
  - `{ op: 'detail' }` → `{ ok: true, list: object[] }` (what `Nvr.cameraDetail()` returns)
  - anything else → `{ ok: false, error: { message: 'unknown request <op>' } }`

- [ ] **Step 1: Write the failing checks**

In `cctv/test/live-worker.test.mjs`, inside the `// ---- Task 4: supervisor` block, find this line:

```js
  check('supervisor: stats arrive', await until(() => sup.stats() !== null, 7000))
```

Insert directly after it:

```js
  // requests: a command the main process sends on the worker's own NVR login (worker-requests.mjs)
  check('request: STATS carry the session generation', Number.isInteger(sup.stats().gen), JSON.stringify(sup.stats().gen))
  check('request: the supervisor knows when this worker started', sup.spawnedAt() > 0 && sup.spawnedAt() <= Date.now())
  const xmlReq = { op: 'xml', url: 'queryTimeCfg', xml: '<request/>', tag: 'test', outBytes: 1024 }
  const good = await sup.request({ ...xmlReq, gen: sup.stats().gen }).catch((e) => e)
  check('request: an XML command is answered by the worker', good?.ok === true && typeof good.text === 'string', good?.message ?? JSON.stringify(good))
  const stale = await sup.request({ ...xmlReq, gen: sup.stats().gen + 100 }).catch((e) => e)
  check('request: a command from an older session is refused', stale instanceof Error && /reconnected; nothing was sent/.test(stale.message), stale?.message)
  const anyGen = await sup.request({ ...xmlReq, gen: null }).catch((e) => e)
  check('request: no generation named means any session', anyGen?.ok === true)
  const pw = await sup.request({ op: 'power', action: 'reboot', gen: sup.stats().gen }).catch((e) => e)
  check('request: reboot is answered', pw?.ok === true && pw.accepted === true, pw?.message ?? JSON.stringify(pw))
  const det = await sup.request({ op: 'detail' }).catch((e) => e)
  check('request: camera detail is answered with a list', det?.ok === true && Array.isArray(det.list), det?.message ?? JSON.stringify(det))
  const odd = await sup.request({ op: 'nonsense' }).catch((e) => e)
  check('request: an unknown request is refused', odd instanceof Error && /unknown request nonsense/.test(odd.message), odd?.message)
```

In the same block, find:

```js
  await sup.stop()
  check('supervisor: stop ends the worker', last.exitCode !== null || last.signalCode !== null)
```

Insert directly after it:

```js
  const gone = await sup.request(xmlReq).catch((e) => e)
  check('request: refused once the worker has stopped', gone?.name === 'WorkerNotReady', gone?.name)
```

Then, directly above the file's last two lines (`print(failures ? ...` and `process.exit(...)`), add a wiring check for the one path the fake SDK is too fast to exercise:

```js
{
  const { readFileSync } = await import('node:fs')
  const sup = readFileSync(new URL('../worker-supervisor.mjs', import.meta.url), 'utf8')
  const exit = sup.split("c.on('exit'")[1] ?? ''
  check('request: a worker that exits fails the requests still waiting, before anything else', /^[^\n]*\n\s*if \(c === child\) requests\.failAll\(/.test(exit), exit.slice(0, 120))
}
```

- [ ] **Step 2: Verify the checks fail**

This test needs the Linux SDK. Commit the test change alone and push:

```bash
git add cctv/test/live-worker.test.mjs
git commit -m "test: requests to the live worker (failing)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin xml-control-via-worker
gh pr create --draft --base master --title "NVR settings through the worker's login when the control login is refused" --body "Implements docs/superpowers/specs/2026-10-06-xml-control-via-worker-design.md. Draft: in progress.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr checks --watch --interval 30
```

Expected: the `cctv app tests` job fails, and its log for `cctv/test/live-worker.test.mjs` shows `TypeError: sup.spawnedAt is not a function` (or `FAIL  request: STATS carry the session generation`). Any other failing test file is a pre-existing problem: note it and carry on.

- [ ] **Step 3: Supervisor — route replies, fail on exit, expose `request` and `spawnedAt`**

In `cctv/worker-supervisor.mjs`:

Add the import after the `worker-ipc.mjs` import:

```js
import { makeRequests } from './worker-requests.mjs'
```

Inside `startWorker`, directly after the `const hub = new StreamHub(...)` statement, add:

```js
  // commands the main process sends on this worker's NVR login and waits on (worker-requests.mjs)
  const requests = makeRequests({
    send: (m) => {
      if (state !== 'ready' || !child?.connected) return false
      child.send(m)
      return true
    }
  })
```

In the `c.on('message', (m) => {` handler, directly after `if (m?.t === MSG.FRAME) return hub.onMessage(m)`, add:

```js
      if (m?.t === MSG.RES) return void requests.onReply(m)
```

In the `c.on('exit', (code, signal) => {` handler, make this the first statement (before `if (stopping || c !== child) return`):

```js
      if (c === child) requests.failAll('the video connection restarted')
```

In the returned object, after `_child: () => child, // tests`, add:

```js
    /** When the current worker process was started (0: none). Part of a borrowed session's identity (nvrs.mjs xmlGen). */
    spawnedAt: () => child?.spawnedAt ?? 0,
    /** One command for the worker to send on its own NVR login; resolves to its reply (worker-requests.mjs). */
    request: (msg, opts) => requests.request(msg, opts),
```

- [ ] **Step 4: Worker — report `gen`, answer requests**

In `cctv/nvr-worker.mjs`:

After the line `const { Recorder } = await import('./recorder.mjs')`, add:

```js
const { power, transparent } = await import('./nvr-xml.mjs')
```

In the `process.on('message', (m) => {` chain, change the last branch from

```js
  } else if (m?.t === MSG.STOP) shutdown()
```

to

```js
  } else if (m?.t === MSG.REQ) {
    answer(m)
  } else if (m?.t === MSG.STOP) shutdown()
```

Directly after the `process.on('SIGINT', shutdown)` line, add:

```js
/**
 * One command from the main process, sent on this worker's own NVR login because the NVR refuses
 * the main process a second one (nvr-xml.mjs viaWorker). It goes through the same transparent() /
 * power() as any other call here, so it takes this NVR's lane and can never overlap another SDK
 * call to it. `gen`: the session the main process believes it is talking to; null means any.
 */
async function answer(m) {
  const reply = (r) => {
    try {
      if (process.connected) process.send({ t: MSG.RES, id: m.id, ...r })
    } catch {} // (the parent is going: nobody is waiting)
  }
  try {
    if (m.gen != null && m.gen !== nvr.gen) throw new Error(`${nvr.name} reconnected; nothing was sent`)
    if (m.op === 'xml') reply({ ok: true, text: await transparent(nvr, m.url, m.xml, m.tag, { outBytes: m.outBytes }) })
    else if (m.op === 'power') reply({ ok: true, accepted: await power(nvr, m.action === 'shutdown' ? 'shutdown' : 'reboot') })
    else if (m.op === 'detail') reply({ ok: true, list: await nvr.cameraDetail() })
    else throw new Error(`unknown request ${m.op}`)
  } catch (e) {
    reply({ ok: false, error: { message: e?.message ?? String(e), name: e?.name ?? 'Error', status: e?.status ?? null, extra: e?.extra ?? null } })
  }
}
```

In `sendStats`, in the `process.send({ t: MSG.STATS, status: nvr.status, error: nvr.error, ...` object, add `gen: nvr.gen,` directly after `error: nvr.error,`:

```js
    process.send({ t: MSG.STATS, status: nvr.status, error: nvr.error, gen: nvr.gen, streams: nvr.streams.size,
```

(Leave the rest of that long line exactly as it is.)

- [ ] **Step 5: Verify the checks pass**

```bash
git add cctv/worker-supervisor.mjs cctv/nvr-worker.mjs
git commit -m "Worker: answer XML, power and camera-detail requests on its own login

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr checks --watch --interval 30
```

Expected: `cctv/test/live-worker.test.mjs` passes in the job log, including all `request:` lines. `worker-requests.test.mjs` passes.

---

### Task 3: Session helpers and the `Nvr` getters

**Files:**
- Create: `cctv/xml-session.mjs`
- Modify: `cctv/nvrs.mjs`
- Test: `cctv/test/xml-session.test.mjs` (new, runs on Windows), `cctv/test/camera-poll.test.mjs` (Linux)

**Interfaces:**
- Consumes: `worker.spawnedAt()` and STATS `gen` from Task 2; STATS `sdk.late` (already sent).
- Produces, from `cctv/xml-session.mjs`:
  - `xmlOnline(nvr) => boolean` — `nvr.xmlOnline` if defined, else `nvr.online`
  - `xmlDegraded(nvr) => boolean` — `nvr.xmlDegraded` if defined, else `nvr.degraded`
  - `xmlGen(nvr) => string | number` — `nvr.xmlGen` if defined, else `nvr.gen`
- Produces, on `Nvr`:
  - `controlFailed: boolean`
  - `get borrowing(): boolean`
  - `get xmlOnline(): boolean` — `online || borrowing`
  - `get xmlGen(): string` — `` `own:${gen}` `` or `` `worker:${spawnedAt}:${workerGen}` ``
  - `get xmlDegraded(): boolean`

The fallbacks exist because the tests of the XML modules use plain-object stand-ins with `online` / `gen` / `degraded` fields; such an object knows nothing about borrowing and is judged by its plain fields.

- [ ] **Step 1: Write the failing helper test**

Create `cctv/test/xml-session.test.mjs`:

```js
// Which session an XML command would go out on (xml-session.mjs): an Nvr answers for itself
// (xmlOnline / xmlDegraded / xmlGen: the control login, or the worker's while borrowing); an object
// that does not know about borrowing, like the stand-ins in the settings tests, is judged by its
// plain online / degraded / gen. No SDK is loaded.
// Run:  node cctv/test/xml-session.test.mjs
import { readFileSync } from 'node:fs'
import { xmlDegraded, xmlGen, xmlOnline } from '../xml-session.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const plain = { online: true, degraded: false, gen: 3 }
check('a plain object: its own online', xmlOnline(plain) === true && xmlOnline({ online: false }) === false)
check('a plain object: its own degraded', xmlDegraded(plain) === false && xmlDegraded({ degraded: true }) === true)
check('a plain object: its own gen', xmlGen(plain) === 3)

const borrowing = { online: false, degraded: true, gen: 3, xmlOnline: true, xmlDegraded: false, xmlGen: 'worker:111:4' }
check('an NVR that borrows: online for XML though its control login is down', xmlOnline(borrowing) === true)
check('an NVR that borrows: not degraded though its control login is', xmlDegraded(borrowing) === false)
check("an NVR that borrows: the worker's session", xmlGen(borrowing) === 'worker:111:4')

const down = { online: false, degraded: true, gen: 3, xmlOnline: false, xmlDegraded: true, xmlGen: 'own:3' }
check('an NVR that cannot borrow: offline', xmlOnline(down) === false && xmlDegraded(down) === true && xmlGen(down) === 'own:3')
check('nothing at all: offline, not a throw', xmlOnline(undefined) === false && xmlDegraded(null) === false && xmlGen(undefined) === undefined)

// alarm-watch.mjs and the modules handed `transparent` must be able to import this without the SDK
const src = readFileSync(new URL('../xml-session.mjs', import.meta.url), 'utf8')
check('the module imports nothing', !/^\s*import\s/m.test(src))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node cctv/test/xml-session.test.mjs`
Expected: FAIL at import with `Cannot find module ... xml-session.mjs`.

- [ ] **Step 3: Write the helpers**

Create `cctv/xml-session.mjs`:

```js
// Which NVR session an XML command (nvr-xml.mjs transparent / power) would go out on.
// Usually the main process's own "control" login. An NVR that refuses that login while its live
// worker is logged in lends the worker's instead (nvrs.mjs Nvr borrowing; shad, 2026-10-06), so the
// settings modules ask these rather than nvr.online / nvr.degraded / nvr.gen, which speak for the
// control login alone and are still what playback and searches must ask.
// An object that does not know about borrowing (the stand-ins in the settings tests) is judged by
// its plain fields. Imports nothing: modules that must load without the SDK use it too.

/** Whether an XML command can be sent to this NVR at all. */
export const xmlOnline = (nvr) => Boolean(nvr?.xmlOnline ?? nvr?.online)
/** Whether the session it would use is busy or recovering. */
export const xmlDegraded = (nvr) => Boolean(nvr?.xmlDegraded ?? nvr?.degraded)
/** That session's identity: a caller that read on one must not write on another. */
export const xmlGen = (nvr) => nvr?.xmlGen ?? nvr?.gen
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node cctv/test/xml-session.test.mjs`
Expected: `all passed`.

- [ ] **Step 5: Write the failing `Nvr` checks**

In `cctv/test/camera-poll.test.mjs`, find the block that ends with:

```js
  check('both logins up: health sees the camera online', cam(allCameras({ anyLogin: true }), 0) === true)
  nvrs.delete(nvr.id)
}
```

Insert directly after that closing `}`:

```js
// Borrowing: the NVR refuses the control login while the worker is logged in, so XML commands go
// out on the worker's login (nvr-xml.mjs). No await in this block: the STATS timer above rewrites
// `stats` every 100 ms, and everything is put back before anything else can look.
{
  const was = { status: nvr.status, failed: nvr.controlFailed, stats, spawnedAt: nvr.worker.spawnedAt }
  nvr.worker.spawnedAt = () => 111
  stats = { ...stats, status: 'online', gen: 4, sdk: { late: 0 } }
  check('borrowing: not while the control login is up', nvr.borrowing === false && nvr.xmlOnline === true && nvr.xmlGen === `own:${nvr.gen}`, nvr.xmlGen)
  nvr.status = 'offline'
  nvr.controlFailed = false
  check('borrowing: not before the control login has failed once (a normal start)', nvr.borrowing === false && nvr.xmlOnline === false)
  nvr.controlFailed = true
  check('borrowing: control login refused, worker logged in', nvr.borrowing === true && nvr.xmlOnline === true)
  check("borrowing: the session is the worker's", nvr.xmlGen === 'worker:111:4', nvr.xmlGen)
  check('borrowing: not degraded just because the control login is down', nvr.degraded === true && nvr.xmlDegraded === false)
  stats = { ...stats, sdk: { late: 1 } }
  check("borrowing: degraded while the worker's SDK calls are late", nvr.xmlDegraded === true)
  stats = { ...stats, sdk: { late: 0 }, gen: 5 }
  check('borrowing: a worker relogin is a new session', nvr.xmlGen === 'worker:111:5', nvr.xmlGen)
  process.env.CCTV_XML_VIA_WORKER = 'off'
  check('borrowing: switched off', nvr.borrowing === false && nvr.xmlOnline === false && nvr.xmlGen === `own:${nvr.gen}`)
  delete process.env.CCTV_XML_VIA_WORKER
  stats = { ...stats, status: 'offline' }
  check('borrowing: not while the worker is logged out', nvr.borrowing === false)
  stats = { ...stats, status: 'online', gen: undefined }
  check('borrowing: not from a worker too old to report its session', nvr.borrowing === false)
  nvr.status = was.status
  nvr.controlFailed = was.failed
  stats = was.stats
  nvr.worker.spawnedAt = was.spawnedAt
}
```

Then find the line `await nvr.stop()` near the end of the file and insert directly after it:

```js
// a control login that fails is remembered (127.0.0.1:1 refuses the connection: nothing reaches an NVR)
{
  const down = new Nvr({ id: 'p2', site: 'T', name: 'P2', host: '127.0.0.1', port: 1, user: 'u', password: 'p' })
  check('a new NVR has not failed yet', down.controlFailed === false)
  check('a failed control login is remembered', await until(() => down.controlFailed === true, 10_000))
  await down.stop()
}
```

- [ ] **Step 6: Add the getters to `Nvr`**

In `cctv/nvrs.mjs`:

In the constructor, directly after `this.gen = 0 // session generation: results from an older session are ignored`, add:

```js
    this.controlFailed = false // this login has failed since it was last up (or since the start): see borrowing
```

In `#connect()`, in the success branch, directly after `this.error = ''` (the one that follows `this.status = 'online'`), add:

```js
          this.controlFailed = false
```

In `#connect()`, in the failure path, directly after `this.status = 'offline'` (the one that follows `this.error = why`), add:

```js
        this.controlFailed = true
```

Directly after the `get degraded() { ... }` getter, add:

```js
  /** The worker's STATS while it is ready, logged in and reports its session; else null. */
  get #workerSession() {
    const s = this.worker?.state() === 'ready' ? this.worker.stats() : null
    return s?.status === 'online' && Number.isInteger(s.gen) ? s : null
  }

  /**
   * XML commands go out on the worker's login: this process's own (control) login is down and has
   * failed at least once since it was last up, while the worker is logged in. An NVR at its session
   * limit lets one of the two in (shad, 2026-10-06, for most of a day). "Failed once" keeps a normal
   * start out of it: a slow P2P login is still in progress then, not refused. This login keeps
   * retrying and takes over again when it gets in. CCTV_XML_VIA_WORKER=off turns it off (read here,
   * not at import, so the service's env file can change it at a restart and the tests can too).
   */
  get borrowing() {
    return process.env.CCTV_XML_VIA_WORKER !== 'off' && !this.online && this.controlFailed && this.#workerSession !== null
  }

  /** An XML command can be sent: on this login, or on the worker's (xml-session.mjs). */
  get xmlOnline() {
    return this.online || this.borrowing
  }

  /**
   * The session an XML command would use. A page that read its settings on one session is refused
   * a write on another (nvr-xml.mjs transparent), and a change of path counts as a change of session.
   */
  get xmlGen() {
    const s = this.borrowing ? this.#workerSession : null
    return s ? `worker:${this.worker.spawnedAt?.() ?? 0}:${s.gen}` : `own:${this.gen}`
  }

  /** As degraded, for the session an XML command would use. */
  get xmlDegraded() {
    if (!this.borrowing) return this.degraded
    return (this.#workerSession?.sdk?.late ?? 0) > 0 || sdkStuck()
  }
```

- [ ] **Step 7: Verify**

```bash
node cctv/test/xml-session.test.mjs
git add cctv/xml-session.mjs cctv/nvrs.mjs cctv/test/xml-session.test.mjs cctv/test/camera-poll.test.mjs
git commit -m "Nvr: borrow the worker's login for XML while the control login is refused

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr checks --watch --interval 30
```

Expected: `xml-session.test.mjs` prints `all passed` locally; in CI, `camera-poll.test.mjs` passes with every `borrowing:` line and `a failed control login is remembered`.

---

### Task 4: `transparent()`, `power()` and `requireOnline()` use the borrowed session

**Files:**
- Modify: `cctv/nvr-xml.mjs`
- Test: `cctv/test/nvr-xml.test.mjs` (Linux)

**Interfaces:**
- Consumes: `xmlOnline`, `xmlDegraded`, `xmlGen` (Task 3); `nvr.borrowing`, `nvr.worker.request()`, `nvr.worker.stats().gen` (Tasks 2–3).
- Produces: `transparent(nvr, url, xml, tag, { gen = xmlGen(nvr), outBytes })` — unchanged signature; `gen` now compared with `xmlGen(nvr)`.
- Produces: errors from the worker path carry `viaWorker === true`. A worker refusal with a `status` becomes an `HttpError` with the same `status`, message and `extra`.

- [ ] **Step 1: Write the failing checks**

In `cctv/test/nvr-xml.test.mjs`, directly above the last two lines (`print(failures ? ...` and `process.exit(...)`), add:

```js
// ---- borrowing: the control login is refused, the command goes out on the worker's login.
// Same queue, same refusals; the native call in this process is never made.
{
  let native = 0
  _test.setCall(async () => {
    native++
    throw new Error('the SDK must not be called while borrowing')
  })
  _test.setNow(null)
  const sent = []
  let reply = (m) => ({ ok: true, text: `<answer for="${m.url}"/>` })
  const w = fakeNvr('xw')
  Object.assign(w, {
    online: false, userId: -1, borrowing: true, xmlOnline: true, xmlDegraded: false, xmlGen: 'worker:111:5',
    worker: {
      stats: () => ({ gen: 5 }),
      request: async (m) => {
        sent.push(m)
        const r = reply(m)
        if (r instanceof Error) throw r
        return r
      }
    }
  })
  const text = await transparent(w, 'queryTimeCfg', '<request/>', 'clock', { outBytes: 2048 })
  check('borrowing: the answer is the worker\'s', text === '<answer for="queryTimeCfg"/>', text)
  check('borrowing: the worker got the whole command and its own session generation', sent.length === 1 && sent[0].op === 'xml' && sent[0].url === 'queryTimeCfg' && sent[0].xml === '<request/>' && sent[0].tag === 'clock' && sent[0].outBytes === 2048 && sent[0].gen === 5, JSON.stringify(sent[0]))
  check('borrowing: nothing went to the SDK here', native === 0)

  const stale = await transparent(w, 'queryTimeCfg', '<request/>', 'clock', { gen: 'own:1' }).catch((e) => e)
  check('borrowing: a caller holding the control login\'s session is refused, nothing sent', stale instanceof Error && /reconnected; nothing was sent/.test(stale.message) && sent.length === 1, stale?.message)

  reply = () => Object.assign(new Error('Too many NVR settings requests at once'), { status: 503, extra: { retryAfterS: 5 } })
  const busy = await transparent(w, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  check("borrowing: the worker's own refusal comes through as the same HTTP error", busy instanceof HttpError && busy.status === 503 && busy.extra?.retryAfterS === 5, `${busy?.status} ${JSON.stringify(busy?.extra)}`)

  reply = () => Object.assign(new Error('the video connection restarted'), { name: 'WorkerLost' })
  const lostWrite = await transparent(w, 'editTimeCfg', '<request/>', 'clock write').catch((e) => e)
  check('borrowing: a change lost with the worker says it may have been made', /NVR xw: the connection was lost; the change may or may not have been made/.test(lostWrite?.message), lostWrite?.message)
  const lostRead = await transparent(w, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  check('borrowing: a read lost with the worker says try again', /NVR xw: the connection was lost; try again/.test(lostRead?.message), lostRead?.message)

  reply = () => Object.assign(new Error('the video connection did not answer in time'), { name: 'SdkTimeout' })
  const late = await transparent(w, 'queryTimeCfg', '<request/>', 'clock').catch((e) => e)
  check('borrowing: a timeout is a timeout', late?.name === 'SdkTimeout')
  reply = () => ({ ok: true, text: 'after' })
  const after = await Promise.race([transparent(w, 'queryTimeCfg', '<request/>', 'clock'), sleep(3000).then(() => 'stuck')])
  check('borrowing: a timeout does not hold the queue (no native call is left running here)', after === 'after', after)

  // the control login comes back: the next command uses it
  Object.assign(w, { online: true, userId: 9, borrowing: false, xmlGen: 'own:2' })
  const before = sent.length
  _test.setCall(async (_opts, userId, _xml, _url, outBuf, _size, len) => {
    native = userId
    return answer(outBuf, len)
  })
  await transparent(w, 'queryTimeCfg', '<request/>', 'clock')
  check('borrowing ended: the command goes out on the control login', native === 9 && sent.length === before)
  _test.setCall(null)
}
```

Check the top of the file's import of `nvr-xml.mjs`: it already brings in `HttpError`, `_test` and `transparent`. No import change is needed.

- [ ] **Step 2: Verify the checks fail**

```bash
git add cctv/test/nvr-xml.test.mjs
git commit -m "test: XML commands on a borrowed session (failing)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr checks --watch --interval 30
```

Expected: `cctv/test/nvr-xml.test.mjs` fails; the first new line reads `FAIL  borrowing: the answer is the worker's` or the script throws `NVR xw is offline`.

- [ ] **Step 3: Import the helpers and move `requireOnline`**

In `cctv/nvr-xml.mjs`, after the `import { kid, parseXml } from './xml.mjs'` line, add:

```js
import { xmlDegraded, xmlGen, xmlOnline } from './xml-session.mjs'
```

Replace `requireOnline` with:

```js
/** Refuses (409) unless an XML command can be sent to the NVR and its session is not recovering. */
export function requireOnline(nvr) {
  if (!xmlOnline(nvr)) throw new HttpError(409, `${nvr.name} is ${nvr.status}; try again when it is online`)
  if (xmlDegraded(nvr)) throw new HttpError(409, `${nvr.name} is busy or recovering; try again in a minute`)
}
```

- [ ] **Step 4: Add the worker path**

Directly above the `/** Sends one command and returns the answer. ...` comment of `transparent`, add:

```js
/** No session of this process's own to send on (the worker's is borrowed, or there is none). */
const noOwnSession = (nvr) => nvr.borrowing !== true && nvr.userId < 0

/**
 * The same command on the worker's login (nvrs.mjs Nvr borrowing): the NVR refuses this process a
 * second one. The worker runs it through its own transparent() / power(), on its own lane. Errors
 * are marked viaWorker: no native call of this process is left running behind them, so the queue is
 * released at once even after a timeout. `write`: a change or a power command, whose loss with the
 * worker leaves it unknown whether the NVR acted.
 */
async function viaWorker(nvr, req, write) {
  try {
    return await nvr.worker.request({ ...req, gen: nvr.worker.stats()?.gen ?? null })
  } catch (e) {
    const err = e?.status ? new HttpError(e.status, e.message, e.extra ?? undefined) : e instanceof Error ? e : new Error(String(e))
    if (err.name === 'WorkerLost') err.message = write ? `${nvr.name}: the connection was lost; the change may or may not have been made` : `${nvr.name}: the connection was lost; try again`
    err.viaWorker = true
    throw err
  }
}
```

- [ ] **Step 5: Change `transparent()`**

Change its signature and first line from

```js
export async function transparent(nvr, url, xml, tag, { gen = nvr.gen, outBytes = 256 * 1024 } = {}) {
  if (!nvr.online || nvr.userId < 0) throw new Error(`${nvr.name} is offline`)
```

to

```js
export async function transparent(nvr, url, xml, tag, { gen = xmlGen(nvr), outBytes = 256 * 1024 } = {}) {
  if (!xmlOnline(nvr) || noOwnSession(nvr) === (nvr.borrowing !== true)) throw new Error(`${nvr.name} is offline`)
```

That second condition reads: "not borrowing and no session of its own". Write it plainly instead:

```js
export async function transparent(nvr, url, xml, tag, { gen = xmlGen(nvr), outBytes = 256 * 1024 } = {}) {
  if (!xmlOnline(nvr) || noOwnSession(nvr)) throw new Error(`${nvr.name} is offline`)
```

(Use this second form. `noOwnSession` is already false while borrowing.)

Directly above the line `let ok` add:

```js
  let text = null // the answer when it came from the worker (nothing is written to `out` then)
```

Inside the `nvr.lane.run(async () => { ... })` body, replace

```js
        // the session as it is when the call really starts (a relogin may have happened while queued)
        const userId = nvr.userId
        if (userId < 0 || nvr.gen !== gen || nvr.stopped) throw new Error(`${nvr.name} reconnected; nothing was sent`)
        sentAt = Date.now()
        return call({ nvr: nvr.id, tag, onLate: release }, userId, xml, url, out, out.length, len)
```

with

```js
        // the session as it is when the call really starts: a relogin may have happened while it was
        // queued, or the path may have changed between this login and the worker's
        const borrowed = nvr.borrowing === true
        const userId = nvr.userId
        if ((!borrowed && userId < 0) || xmlGen(nvr) !== gen || nvr.stopped) throw new Error(`${nvr.name} reconnected; nothing was sent`)
        sentAt = Date.now()
        if (borrowed) {
          text = String((await viaWorker(nvr, { op: 'xml', url, xml, tag, outBytes }, !read)).text ?? '')
          return true
        }
        return call({ nvr: nvr.id, tag, onLate: release }, userId, xml, url, out, out.length, len)
```

In the `catch (e)` block below it, replace

```js
    if (e?.name !== 'SdkTimeout') release()
```

with

```js
    // (a call that went to the worker leaves no native call running here, timed out or not)
    if (e?.name !== 'SdkTimeout' || e.viaWorker) release()
```

After the line `if (!ok) throw new Error(...)` and before the `// some answers end with stray NUL bytes` comment, add:

```js
  if (text !== null) return text
```

- [ ] **Step 6: Change `power()`**

Replace its body up to and including the `sdkCallT` line so that the function reads:

```js
export async function power(nvr, action) {
  if (!xmlOnline(nvr) || noOwnSession(nvr)) throw new Error(`${nvr.name} is offline`)
  const fn = action === 'shutdown' ? NET_SDK.ShutDownDVR : NET_SDK.RebootDVR
  const gen = xmlGen(nvr)
  return nvr.lane.run(
    async () => {
      const passTurn = await takeTurn()
      try {
        const borrowed = nvr.borrowing === true
        const userId = nvr.userId
        if ((!borrowed && userId < 0) || xmlGen(nvr) !== gen || nvr.stopped) throw new Error(`${nvr.name} reconnected; nothing was sent`)
        if (borrowed) return Boolean((await viaWorker(nvr, { op: 'power', action }, true)).accepted)
        return Boolean(await sdkCallT({ nvr: nvr.id, tag: action }, fn, userId))
      } finally {
        passTurn()
      }
    },
    { priority: PRIORITY.HIGH }
  )
}
```

Update the doc comment's first sentence above it from "on its control login" to "on its control login, or the worker's while that is borrowed".

- [ ] **Step 7: Verify**

```bash
git add cctv/nvr-xml.mjs
git commit -m "XML: send on the worker's login while the control login is refused

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr checks --watch --interval 30
```

Expected: `cctv/test/nvr-xml.test.mjs` passes with every `borrowing` line; every earlier line in that file still passes (the stand-ins without `xmlGen` fall back to their numeric `gen`).

---

### Task 5: Move the callers' checks; borrow the camera-detail read

**Files:**
- Modify: `cctv/imaging.mjs`, `lens.mjs`, `streams.mjs`, `substreams.mjs`, `tripwire.mjs`, `osd.mjs`, `nvr-clock.mjs`, `nvr-log.mjs`, `nvr-netstatus.mjs`, `nvr-probe.mjs`, `relays.mjs`, `alarm-watch.mjs`, `nvr-disks.mjs`, `camera-export.mjs`
- Modify: `cctv/events.mjs` (two route checks only), `cctv/server.mjs` (two route checks only), `cctv/nvrs.mjs` (`cameraDetail`)
- Test: `cctv/test/xml-online-wiring.test.mjs` (new, runs on Windows)

**Interfaces:**
- Consumes: `xmlOnline` / `xmlDegraded` / `xmlGen` from `cctv/xml-session.mjs`; `nvr.borrowing`; `nvr.worker.request({ op: 'detail' }, { timeoutMs })`.
- Produces: no new names. After this task none of the 14 modules reads `nvr.online`, `nvr.degraded` or `nvr.gen`.

- [ ] **Step 1: Write the failing wiring test**

Create `cctv/test/xml-online-wiring.test.mjs`:

```js
// Which modules ask "can an XML command be sent" (xml-session.mjs: the control login, or the
// worker's while it is borrowed) and which still ask for the control login itself. The settings
// modules must use the helpers, or an NVR that refuses the control login shows "offline" on their
// pages again; playback and searches must not, because they hold SDK handles on this process's
// own login and cannot be borrowed. Reads the sources only.
// Run:  node cctv/test/xml-online-wiring.test.mjs
import { readFileSync } from 'node:fs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const lines = (f, re) => src(f).split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l)).map(([n]) => n)

const XML_MODULES = ['imaging', 'lens', 'streams', 'substreams', 'tripwire', 'osd', 'nvr-clock', 'nvr-log', 'nvr-netstatus', 'nvr-probe', 'relays', 'alarm-watch', 'nvr-disks', 'camera-export']
for (const m of XML_MODULES) {
  const f = `${m}.mjs`
  const left = lines(f, /\bnvr\??\.(online|degraded|gen)\b/)
  check(`${f}: asks the XML session, not the control login`, left.length === 0, left.length ? `lines ${left.join(', ')}` : '')
  check(`${f}: imports the helpers it uses`, /from '\.\/xml-session\.mjs'/.test(src(f)))
  const used = ['xmlOnline', 'xmlDegraded', 'xmlGen'].filter((h) => new RegExp(`\\b${h}\\(`).test(src(f)))
  const imported = (/import \{([^}]*)\} from '\.\/xml-session\.mjs'/.exec(src(f))?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  check(`${f}: imports exactly those`, used.slice().sort().join() === imported.slice().sort().join(), `uses ${used.join(' ')}; imports ${imported.join(' ')}`)
}

// the two admin routes in events.mjs that only send XML
const ev = src('events.mjs')
check('events.mjs: the probe route asks the XML session', /if \(!xmlOnline\(nvr\)\) return \[409[^\n]*\n\s*const run = await probeEvents/.test(ev))
check('events.mjs: the motion-tune route asks the XML session', /if \(!xmlOnline\(nvr\)\) return \[409[^\n]*\n\s*const ch = Number\(tune\[2\]\)/.test(ev))
check('events.mjs: the search poll still needs the control login', /export function pollable[\s\S]{0,200}if \(!nvr\.online\)/.test(ev) && /if \(nvr\.degraded\) return \{ ok: false/.test(ev))

// server.mjs: the disks route and the power route
const sv = src('server.mjs')
check('server.mjs: the NVR disks route asks the XML session', /if \(!xmlOnline\(nvr\)\) return sendJson\(res, 409[^\n]*\n\s*try \{\n\s*if \(url\.searchParams\.get\('discover'\)\)/.test(sv))
check('server.mjs: the power route asks the XML session', /if \(body\.confirm !== true\)[^\n]*\n\s*if \(!xmlOnline\(nvr\)\) return sendJson\(res, 409/.test(sv))
check('server.mjs: playback still needs the control login', /if \(!nvr\.online\) return ws\.close\(1013, 'NVR offline'\)/.test(sv))

// and the ones that must stay on the control login
for (const f of ['playback.mjs', 'motion.mjs', 'backfill.mjs', 'rec-playback.mjs', 'rec-fallback.mjs']) {
  check(`${f}: does not use the XML session helpers`, !/xml-session\.mjs/.test(src(f)))
}
check('playback.mjs: its route still needs the control login', /if \(!nvr\.online\) return \[503/.test(src('playback.mjs')))

// the camera-detail read
check('nvrs.mjs: camera detail is asked of the worker while borrowing', /async cameraDetail\(\) \{\n\s*if \(this\.borrowing\)[\s\S]{0,300}op: 'detail'/.test(src('nvrs.mjs')))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node cctv/test/xml-online-wiring.test.mjs`
Expected: many `FAIL` lines (one per module with its line numbers), last line `N failed`.

- [ ] **Step 3: Rename in the 14 modules**

Run from the repository root (Git Bash):

```bash
cd cctv
for f in imaging lens streams substreams tripwire osd nvr-clock nvr-log nvr-netstatus nvr-probe relays alarm-watch nvr-disks camera-export; do
  sed -i -E 's/\bnvr\??\.online\b/xmlOnline(nvr)/g; s/\bnvr\.degraded\b/xmlDegraded(nvr)/g; s/\bnvr\.gen\b/xmlGen(nvr)/g' "$f.mjs"
done
cd ..
git diff --stat
```

Expected `git diff --stat`: exactly those 14 files, with these line counts changed — imaging 5, lens 5, streams 11, substreams 8, tripwire 5, osd 1, nvr-clock 2, nvr-log 1, nvr-netstatus 3, nvr-probe 2, relays 1, alarm-watch 1, nvr-disks 1, camera-export 2. If a count differs, read that file's diff before going on: a line may hold two matches, which is fine, but a match inside a longer name is not (there were none when this plan was written).

Read the whole diff once (`git diff cctv/`). Every changed line must still be valid JavaScript and mean the same thing with the helper in place of the property. Two to look at by eye:

- `substreams.mjs`: `` `stopped: ${nvr.name} is ${xmlOnline(nvr) ? 'busy or reconnected' : 'offline'}` ``
- `camera-export.mjs`: `nvrOnline: xmlOnline(nvr)` in the `base` object, and `if (!xmlOnline(nvr)) {` under it.

- [ ] **Step 4: Add the imports**

Add one import line to each module, directly after its last existing `import` statement, naming exactly the helpers that file now calls:

| File | Import line |
|---|---|
| `imaging.mjs` | `import { xmlDegraded, xmlGen, xmlOnline } from './xml-session.mjs'` |
| `lens.mjs` | `import { xmlDegraded, xmlGen } from './xml-session.mjs'` |
| `streams.mjs` | `import { xmlDegraded, xmlGen } from './xml-session.mjs'` |
| `substreams.mjs` | `import { xmlDegraded, xmlGen, xmlOnline } from './xml-session.mjs'` |
| `tripwire.mjs` | `import { xmlDegraded, xmlGen, xmlOnline } from './xml-session.mjs'` |
| `osd.mjs` | `import { xmlOnline } from './xml-session.mjs'` |
| `nvr-clock.mjs` | `import { xmlOnline } from './xml-session.mjs'` |
| `nvr-log.mjs` | `import { xmlOnline } from './xml-session.mjs'` |
| `nvr-netstatus.mjs` | `import { xmlDegraded, xmlGen, xmlOnline } from './xml-session.mjs'` |
| `nvr-probe.mjs` | `import { xmlOnline } from './xml-session.mjs'` |
| `relays.mjs` | `import { xmlOnline } from './xml-session.mjs'` |
| `alarm-watch.mjs` | `import { xmlDegraded, xmlOnline } from './xml-session.mjs'` |
| `nvr-disks.mjs` | `import { xmlOnline } from './xml-session.mjs'` |
| `camera-export.mjs` | `import { xmlOnline } from './xml-session.mjs'` |

`alarm-watch.mjs` carries a comment saying it does not import `nvr-xml.mjs` because that loads the native SDK. `xml-session.mjs` imports nothing, so this import keeps that promise; add `// (xml-session.mjs imports nothing: still no SDK here)` at the end of its import line.

- [ ] **Step 5: The two routes in `events.mjs`**

Add after the last `import` in `cctv/events.mjs`:

```js
import { xmlOnline } from './xml-session.mjs'
```

In the `if (probe) {` route, change

```js
    if (!nvr.online) return [409, { error: `${nvr.name ?? nvr.id} is offline` }]
    const run = await probeEvents(nvr, query)
```

to

```js
    if (!xmlOnline(nvr)) return [409, { error: `${nvr.name ?? nvr.id} is offline` }]
    const run = await probeEvents(nvr, query)
```

In the `if (tune) {` route, change

```js
    if (!nvr.online) return [409, { error: `${nvr.name ?? nvr.id} is offline` }]
    const ch = Number(tune[2])
```

to

```js
    if (!xmlOnline(nvr)) return [409, { error: `${nvr.name ?? nvr.id} is offline` }]
    const ch = Number(tune[2])
```

Leave `pollable()` and every other `nvr.online` in the file alone: those gate recording searches.

- [ ] **Step 6: The two routes in `server.mjs`**

Add to the imports of `cctv/server.mjs`, next to the other local imports:

```js
import { xmlOnline } from './xml-session.mjs'
```

In the NVR disks route, change

```js
      if (!nvr.online) return sendJson(res, 409, { error: `${nvr.name} is ${nvr.status}; try again when it is online` })
      try {
        if (url.searchParams.get('discover')) {
```

to

```js
      if (!xmlOnline(nvr)) return sendJson(res, 409, { error: `${nvr.name} is ${nvr.status}; try again when it is online` })
      try {
        if (url.searchParams.get('discover')) {
```

In the power route, change

```js
      if (!nvr.online || nvr.userId < 0) return sendJson(res, 409, { error: `${nvr.name} is ${nvr.status}; try again when it is online` })
```

to

```js
      if (!xmlOnline(nvr)) return sendJson(res, 409, { error: `${nvr.name} is ${nvr.status}; try again when it is online` })
```

(`power()` itself refuses when there is no session to send on.) Leave the playback WebSocket's `if (!nvr.online) return ws.close(1013, 'NVR offline')` alone.

- [ ] **Step 7: `cameraDetail()` borrows**

In `cctv/nvrs.mjs`, change the start of `cameraDetail()` from

```js
  async cameraDetail() {
    const cams = await this.#queryChannelsFull()
```

to

```js
  async cameraDetail() {
    if (this.borrowing) {
      // this login is refused: the worker reads it on its own (its cameraDetail runs this same code
      // there). Three reads over a slow link, so a longer wait than a single command's.
      try {
        return (await this.worker.request({ op: 'detail' }, { timeoutMs: 200_000 })).list ?? []
      } catch {
        return [] // as an NVR that did not answer
      }
    }
    const cams = await this.#queryChannelsFull()
```

In the doc comment above it, change "Runs on this process's own login (the control login when a worker holds the video)." to "Runs on this process's own login (the control login when a worker holds the video), or is asked of the worker while that login is refused (borrowing)."

- [ ] **Step 8: Run the wiring test and the Windows-runnable module tests**

```bash
node cctv/test/xml-online-wiring.test.mjs
node cctv/test/xml-session.test.mjs
node cctv/test/alarm-watch.test.mjs
node cctv/test/relays.test.mjs
node cctv/test/nvr-log.test.mjs
node cctv/test/nvr-netstatus.test.mjs
```

Expected: the first two print `all passed`. The other four either print `all passed` or fail at import with a koffi / shared-library error; that error means the test needs Linux and is checked in CI in the next step. Any `FAIL` line is a real regression: fix it before committing.

- [ ] **Step 9: Commit and verify in CI**

```bash
git add cctv/
git commit -m "Settings modules ask the XML session, not the control login

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr checks --watch --interval 30
```

Expected: the job passes. In its log, these files pass: `imaging`, `lens`, `streams`, `tripwire-route`, `tripwire-xml`, `osd`, `nvr-clock`, `nvr-log`, `nvr-netstatus`, `probe`, `relays`, `alarm-watch`, `alarm-watch-wiring`, `nvr-disks`, `xml-online-wiring`. (`substreams.test.mjs` is skipped by CI: it reads lab captures that are not in the repo.)

---

### Task 6: The Health panel says so

**Files:**
- Modify: `cctv/server.mjs` (`listNvrs`), `cctv/alert-checks.mjs`, `cctv/public/health.js`
- Test: `cctv/test/health-page.test.mjs`, `cctv/test/alert-checks.test.mjs`

**Interfaces:**
- Consumes: `nvr.borrowing` (Task 3).
- Produces: each NVR in the health snapshot carries `borrowing: boolean`; `renderHealth(...).nvrPanels[i].status` for a borrowing NVR is `{ value: 'Online', state: 'warn', note: 'Settings are going through the video login; the NVR is refusing a second one.' }`.

- [ ] **Step 1: Write the failing checks**

In `cctv/test/health-page.test.mjs`, directly above its final summary lines, add:

```js
// ---- an NVR whose settings go through the worker's login (the control login is refused)
{
  const [p] = renderHealth(nvrWith({ borrowing: true, lastContactMs: 800 })).nvrPanels
  check('borrowing: the panel says online, as a warning', p.status.value === 'Online' && p.status.state === 'warn', JSON.stringify(p.status))
  check('borrowing: and why', p.status.note === 'Settings are going through the video login; the NVR is refusing a second one.', p.status.note)
  const [q] = renderHealth(nvrWith({ borrowing: false, lastContactMs: 800 })).nvrPanels
  check('not borrowing: the panel is as before', q.status.value === 'Online' && q.status.state === 'ok')
  const [r] = renderHealth(nvrWith({ borrowing: true, online: false, status: 'offline' })).nvrPanels
  check('offline wins over borrowing', r.status.value === 'Offline' && r.status.state === 'bad')
}
```

In `cctv/test/alert-checks.test.mjs`, open the file and find the first test that builds a snapshot from a `listNvrs` stub (search for `listNvrs:`). Directly above the file's final summary lines add a block that reuses that test's way of building the snapshot. The file's helper for this is whatever function that first test calls with its `deps`; call it the same way:

```js
// ---- borrowing reaches the snapshot
{
  const src = (await import('node:fs')).readFileSync(new URL('../alert-checks.mjs', import.meta.url), 'utf8')
  check('the snapshot carries borrowing', /borrowing: Boolean\(n\.borrowing\)/.test(src))
  const sv = (await import('node:fs')).readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check('listNvrs reports borrowing', /refusalsLast10Min: refusalsOf\(n\),\n\s*borrowing: n\.borrowing/.test(sv))
}
```

- [ ] **Step 2: Run them to verify they fail**

```bash
node cctv/test/health-page.test.mjs
node cctv/test/alert-checks.test.mjs
```

Expected: `FAIL  borrowing: the panel says online, as a warning`, `FAIL  borrowing: and why`, `FAIL  the snapshot carries borrowing`, `FAIL  listNvrs reports borrowing`. (If `alert-checks.test.mjs` fails at import with a shared-library error instead, it needs Linux: rely on CI in Step 5.)

- [ ] **Step 3: Carry `borrowing` to the snapshot**

In `cctv/server.mjs`, in `listNvrs`, change

```js
      refusalsLast10Min: refusalsOf(n)
    })),
```

to

```js
      refusalsLast10Min: refusalsOf(n),
      borrowing: n.borrowing
    })),
```

In `cctv/alert-checks.mjs`, in the `nvrs: deps.listNvrs().map((n) => ({` object, directly after the `cooling: Boolean(n.cooling),` line, add:

```js
      // settings go out on the worker's login: the NVR refuses the main process a second one
      borrowing: Boolean(n.borrowing),
```

- [ ] **Step 4: Show it on the panel**

In `cctv/public/health.js`, in `nvrPanel`, change the end of the `status` expression from

```js
      : n.cooling
        ? { value: 'Online, slow', state: 'warn', note: 'calls to it are overdue; new streams and playbacks are held back' }
        : { value: 'Online', state: 'ok', note: `last contact ${ago(n.lastContactMs)}` }
```

to

```js
      : n.cooling
        ? { value: 'Online, slow', state: 'warn', note: 'calls to it are overdue; new streams and playbacks are held back' }
        : n.borrowing
          ? // video and settings work; playback from the NVR and searches of it do not, until it lets a second login in
            { value: 'Online', state: 'warn', note: 'Settings are going through the video login; the NVR is refusing a second one.' }
          : { value: 'Online', state: 'ok', note: `last contact ${ago(n.lastContactMs)}` }
```

- [ ] **Step 5: Verify and commit**

```bash
node cctv/test/health-page.test.mjs
node cctv/test/alert-checks.test.mjs
git add cctv/server.mjs cctv/alert-checks.mjs cctv/public/health.js cctv/test/health-page.test.mjs cctv/test/alert-checks.test.mjs
git commit -m "Health: say when an NVR's settings go through the video login

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr checks --watch --interval 30
```

Expected: `health-page.test.mjs` prints `all passed` locally; the CI job passes.

---

### Task 7: Whole-suite check, PR ready, hand-over for deploy

**Files:**
- Modify: `docs/superpowers/specs/2026-10-06-xml-control-via-worker-design.md` (status line only)

- [ ] **Step 1: Read the whole CI run**

```bash
gh pr checks
gh run view --log $(gh run list --branch xml-control-via-worker --workflow cctv-tests.yml -L 1 --json databaseId -q '.[0].databaseId') | grep -E "FAIL |failed$|known failing" | head -40
```

Expected: the job is `pass`; no `FAIL ` lines except inside the two files CI lists as known failing (`rec-playback-wait`, `live-mux-socket`). Any other failure is this branch's: fix it under the task that owns the file, with a new commit.

- [ ] **Step 2: Confirm scope by diff**

```bash
git fetch origin
git diff --stat origin/master...HEAD -- cctv | tail -40
git diff origin/master...HEAD -- cctv/playback.mjs cctv/motion.mjs cctv/backfill.mjs cctv/rec-playback.mjs cctv/rec-fallback.mjs cctv/live.mjs cctv/recorder.mjs cctv/alerts.mjs cctv/warm-streams.mjs | head
```

Expected: the second command prints nothing. Those files are out of scope.

- [ ] **Step 3: Mark the spec and the PR**

Change the spec's second line to:

```
Date: 2026-10-06. Status: built on branch `xml-control-via-worker`; not deployed.
```

```bash
git add docs/superpowers/specs/2026-10-06-xml-control-via-worker-design.md
git commit -m "Spec: built, not deployed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr ready
```

Edit the PR body (`gh pr edit --body-file -`) to say, in this order: what was wrong (shad refuses the control login while its worker is logged in, so every settings page said offline); what changes (XML commands, reboot/shutdown and the camera-detail read go through the worker's login while that lasts); what does not (NVR playback and searches still need the control login); the kill switch (`CCTV_XML_VIA_WORKER=off` in `/etc/cctv/cctv.env`, then restart); and the one accepted risk (a settings call that hangs on a borrowed session makes that NVR's worker restart, costing a few seconds of its recording). End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 4: Stop and hand over**

Do not merge or deploy. Report to Mike that the PR is ready, and give him this post-deploy checklist from the spec:

1. Health → shad's panel reads `Online` with the note `Settings are going through the video login; the NVR is refusing a second one.` (Only while shad is still refusing the control login; if it has let it in, the panel is plain `Online` and there is nothing to borrow.)
2. Within 10 minutes of the restart, shad's `Disks read` field shows a time, not "not available".
3. Open shad's sub-stream settings page: it loads. Save it unchanged: it reports success.
4. shad's NVR playback still says the NVR is offline. That is expected.
5. `journalctl -u cctv.service --since "-15 min" | grep -E "worker shad.*(TransparentConfig|exited)"` shows the worker making XML calls and no `exited` line.
6. If anything looks wrong: add `CCTV_XML_VIA_WORKER=off` to `/etc/cctv/cctv.env` and `sudo systemctl restart cctv`.
