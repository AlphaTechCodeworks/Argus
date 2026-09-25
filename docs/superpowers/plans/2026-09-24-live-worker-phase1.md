# Live worker (phase 1: one pull per camera, one process per NVR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live video for each NVR comes from its own child process holding that NVR's only video login; the main app fans each stream out to every viewer, so each NVR sends each stream once and a slow NVR can no longer freeze the others.

**Architecture:** `nvr-worker.mjs` is a forked child per NVR that reuses the existing `Nvr` and `LiveStream` classes unchanged; the parent asks it for streams ("want"/"unwant") and it forwards the frames of each stream over IPC through a fake WebSocket ("tap"). In the parent, `stream-hub.mjs` gives the server the same `getStream(ch, type) → { add(ws), remove(ws) }` interface it uses today, with its own GOP replay and slow-client handling. `worker-supervisor.mjs` forks, watches and restarts workers. Behind the flag `CCTV_LIVE_WORKER=on`; off = today's behaviour.

**Tech Stack:** Node 24 ESM, `child_process.fork` with `serialization: 'advanced'` (Buffers cross IPC without base64), koffi + TVT SDK (inside the worker only), plain `node` test scripts in `cctv/test/*.test.mjs` run in the lab.

**Spec:** `docs/superpowers/specs/2026-09-24-server-recording-design.md` (sections Goal, Architecture "Core: one pull per camera").

## Global Constraints

- No server transcoding: frames are forwarded byte-for-byte.
- Never change NVR/camera settings. Never contact NVRs from tests (fake `NET_SDK` only; hosts `*.invalid`).
- Never deploy to production (Docker on 192.168.2.33). Deploy only to the test server: `bash deploy/push.sh --code-only --distro Ubuntu-24.04`.
- Tests run in the lab, never on this PC: `bash <scratchpad>/imaging/lab.sh code` then `bash <scratchpad>/imaging/lab.sh sh 'cd app && node cctv/test/<name>.test.mjs'`. All 18 existing suites must stay green (sps needs `../frames`, substreams needs `../fx/substream`).
- Write files with the Write/Edit tools (Git Bash heredocs mangle backslashes).
- Do not commit or push to git unless the owner asks.
- Flag: `CCTV_LIVE_WORKER=on` enables the worker path; unset = unchanged behaviour.
- Phase 1 keeps a second, control-only login in the main process for picture settings, sub-stream settings and NVR playback (no video on it). Phase 2 (recording) moves those behind the worker too.

## File map

| File | Responsibility |
|---|---|
| `cctv/worker-ipc.mjs` (new) | Message shapes and helpers shared by parent and worker |
| `cctv/stream-hub.mjs` (new) | Parent side: `HubStream` fan-out (GOP replay, slow clients, linger) and `StreamHub` per NVR |
| `cctv/nvr-worker.mjs` (new) | Child entry: one `Nvr`, want/unwant, taps that forward frames |
| `cctv/worker-supervisor.mjs` (new) | Forks one worker per NVR, restarts on exit with back-off, routes messages to hubs |
| `cctv/nvrs.mjs` (modify `getStream`, `startNvrs`, `stopNvrs`) | Delegate live streams to the hub when the flag is on |
| `cctv/server.mjs` (modify `/healthz`) | Report worker state |
| `cctv/test/stream-hub.test.mjs`, `cctv/test/live-worker.test.mjs` (new) | Tests |

---

### Task 1: IPC messages

**Files:**
- Create: `cctv/worker-ipc.mjs`
- Test: `cctv/test/stream-hub.test.mjs` (first section)

**Interfaces:**
- Produces:
  - `MSG` constants: `WANT='want'`, `UNWANT='unwant'`, `FRAME='frame'`, `STATE='state'`, `STATS='stats'`, `STOP='stop'`, `READY='ready'`.
  - `want(ch, type) → { t: 'want', ch, type }`, `unwant(ch, type)`, `frameMsg(key, buf, isKey) → { t: 'frame', key, buf, isKey: boolean }`, `streamKey(ch, type) → "ch:type"`.

- [ ] **Step 1: Write the failing test**

```js
// cctv/test/stream-hub.test.mjs
import { MSG, streamKey, want, unwant, frameMsg } from '../worker-ipc.mjs'
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`) }
check('streamKey', streamKey(18, 0) === '18:0')
check('want/unwant', JSON.stringify(want(3, 1)) === '{"t":"want","ch":3,"type":1}' && unwant(3, 1).t === MSG.UNWANT)
const b = Buffer.from([1, 2, 3])
const f = frameMsg('3:1', b, true)
check('frame keeps the Buffer and the key flag', f.t === MSG.FRAME && f.key === '3:1' && f.buf === b && f.isKey === true)
```

- [ ] **Step 2: Run it in the lab; expect FAIL** (`Cannot find module '../worker-ipc.mjs'`).

- [ ] **Step 3: Implement**

```js
// cctv/worker-ipc.mjs
// Messages between the main process and an NVR worker (child_process.fork, serialization 'advanced',
// so Buffers cross as bytes). Parent -> worker: want/unwant/stop. Worker -> parent: ready/state/frame/stats.
export const MSG = { WANT: 'want', UNWANT: 'unwant', STOP: 'stop', READY: 'ready', STATE: 'state', FRAME: 'frame', STATS: 'stats' }
export const streamKey = (ch, type) => `${ch}:${type}`
export const want = (ch, type) => ({ t: MSG.WANT, ch, type })
export const unwant = (ch, type) => ({ t: MSG.UNWANT, ch, type })
/** A packed frame (live.mjs encodeFrame wire format) for stream `key`. */
export const frameMsg = (key, buf, isKey) => ({ t: MSG.FRAME, key, buf, isKey })
```

- [ ] **Step 4: Run in the lab; expect the three checks to PASS.**

---

### Task 2: HubStream fan-out in the parent

**Files:**
- Create: `cctv/stream-hub.mjs`
- Test: `cctv/test/stream-hub.test.mjs` (append)

**Interfaces:**
- Consumes: `MSG`, `streamKey`, `want`, `unwant` from Task 1.
- Produces:
  - `class HubStream { constructor(hub, ch, type); add(ws); remove(ws); onFrame(buf, isKey); reset(); clients: Set }`
  - `class StreamHub { constructor(nvrId, send: (msg) => void, { stopDelayMs }); getStream(ch, type): HubStream; onMessage(msg); onWorkerRestart(); streams: Map }`
- Behaviour copied from `live.mjs` `LiveStream.add/remove/#send` (lines 176-205, 156-170): GOP replay to new viewers; `waitForKey` until a keyframe; skip to next keyframe when `ws.bufferedAmount > MAX_CLIENT_BUFFER` (4 MiB); GOP capped at 400 frames; after the last viewer leaves, `unwant` is sent after `STOP_DELAY_MS` (main 10 s, sub 30 s); a new viewer inside that window cancels it.

- [ ] **Step 1: Write the failing tests** (append)

```js
import { StreamHub } from '../stream-hub.mjs'
const sent = []
const hub = new StreamHub('n1', (m) => sent.push(m), { stopDelayMs: { 0: 50, 1: 50 } })
const fakeWs = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, got: [], send(b) { this.got.push(b) } })
const a = fakeWs()
const s = hub.getStream(18, 0)
s.add(a)
check('first viewer asks the worker once', sent.filter((m) => m.t === 'want').length === 1 && sent[0].ch === 18 && sent[0].type === 0)
hub.getStream(18, 0).add(fakeWs())
check('second viewer: same stream, no second want', hub.getStream(18, 0) === s && sent.filter((m) => m.t === 'want').length === 1)
const P = (k) => Buffer.from([k ? 1 : 0, 9])
s.onFrame(P(false), false)
check('no keyframe yet: nothing sent (waitForKey)', a.got.length === 0)
s.onFrame(P(true), true); s.onFrame(P(false), false)
check('keyframe then delta reach the viewer', a.got.length === 2)
const late = fakeWs(); s.add(late)
check('late viewer gets the GOP replayed at once', late.got.length === 2)
const slow = fakeWs(); s.add(slow); slow.bufferedAmount = 5 * 1024 * 1024
s.onFrame(P(false), false)
check('slow viewer skips to the next keyframe', slow.got.length === 2)
for (const w of [...s.clients]) s.remove(w)
await new Promise((r) => setTimeout(r, 80))
check('unwant after the linger', sent.at(-1).t === 'unwant')
hub.onMessage({ t: 'frame', key: '18:0', buf: P(true), isKey: true })
check('frames for an unwanted stream are ignored', true)
hub.onWorkerRestart()
check('worker restart: viewers wait for a keyframe again', [...hub.streams.values()].every((x) => x.gop.length === 0))
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run in the lab; expect FAIL** (missing module).

- [ ] **Step 3: Implement**

```js
// cctv/stream-hub.mjs
// Parent side of the live worker: one HubStream per camera stream, fanned out to every viewer.
// The worker sends each stream once; everything per-viewer (GOP replay, slow sockets) happens here.
import { MSG, streamKey, want, unwant } from './worker-ipc.mjs'

const MAX_GOP_FRAMES = 400
const MAX_CLIENT_BUFFER = 4 * 1024 * 1024
const STOP_DELAY_MS = { 0: 10_000, 1: 30_000 }

export class HubStream {
  constructor(hub, ch, type) {
    this.hub = hub
    this.ch = ch
    this.type = type
    this.key = streamKey(ch, type)
    this.clients = new Set()
    this.gop = []
    this.stopTimer = null
    this.wanted = false
  }

  add(ws) {
    clearTimeout(this.stopTimer)
    this.stopTimer = null
    this.clients.add(ws)
    if (!this.wanted) {
      this.wanted = true
      this.hub.send(want(this.ch, this.type))
    }
    if (this.gop.length > 0) for (const msg of this.gop) ws.send(msg)
    else ws.waitForKey = true
  }

  remove(ws) {
    this.clients.delete(ws)
    if (this.clients.size > 0) return
    clearTimeout(this.stopTimer)
    this.stopTimer = setTimeout(() => {
      this.wanted = false
      this.gop = []
      this.hub.send(unwant(this.ch, this.type))
      this.hub.streams.delete(this.key)
    }, this.hub.stopDelayMs[this.type] ?? 10_000)
  }

  onFrame(buf, isKey) {
    if (isKey) this.gop = [buf]
    else if (this.gop.length >= MAX_GOP_FRAMES) this.gop = []
    else if (this.gop.length > 0) this.gop.push(buf)
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue
      if (ws.bufferedAmount > MAX_CLIENT_BUFFER) ws.waitForKey = true
      if (ws.waitForKey) {
        if (!isKey) continue
        ws.waitForKey = false
      }
      ws.send(buf)
    }
  }

  /** The worker restarted: old reference frames are useless to decoders. */
  reset() {
    this.gop = []
    for (const ws of this.clients) ws.waitForKey = true
  }
}

export class StreamHub {
  constructor(nvrId, send, { stopDelayMs = STOP_DELAY_MS } = {}) {
    this.nvrId = nvrId
    this.send = send
    this.stopDelayMs = stopDelayMs
    this.streams = new Map()
  }

  getStream(ch, type) {
    const key = streamKey(ch, type)
    let s = this.streams.get(key)
    if (!s) this.streams.set(key, (s = new HubStream(this, ch, type)))
    return s
  }

  onMessage(msg) {
    if (msg?.t !== MSG.FRAME) return
    this.streams.get(msg.key)?.onFrame(msg.buf, msg.isKey)
  }

  /** After a worker restart: reset every stream and ask again for the ones still watched. */
  onWorkerRestart() {
    for (const s of this.streams.values()) {
      s.reset()
      if (s.wanted) this.send(want(s.ch, s.type))
    }
  }
}
```

- [ ] **Step 4: Run in the lab; expect all checks PASS.**

---

### Task 3: The NVR worker process

**Files:**
- Create: `cctv/nvr-worker.mjs`
- Test: `cctv/test/live-worker.test.mjs`

**Interfaces:**
- Consumes: `Nvr` from `nvrs.mjs` (constructor takes the NVR config entry; `start()`, `stop()`, `getStream(ch, type)`), `LiveStream.add/remove` (unchanged), Task 1 messages.
- Produces: a process started with `fork('cctv/nvr-worker.mjs', [], { serialization: 'advanced', env: { ..., CCTV_WORKER_NVR: '<nvr id>' } })` that:
  - on start reads its NVR entry from `readConfig()` by `CCTV_WORKER_NVR`, runs `nvr.start()`, sends `{ t: 'ready' }` and every 5 s `{ t: 'stats', status: nvr.status, sdk: sdkStats() }`;
  - on `want`: creates one tap per key and calls `nvr.getStream(ch, type).add(tap)`; on `unwant`: `stream.remove(tap)`;
  - on `stop` or parent disconnect: `await nvr.stop()`, then `process.kill(process.pid, 'SIGKILL')` (same reason as server.mjs shutdown);
  - runs its own `watchdog.mjs` (SIGKILL of the worker only).
- A tap is `{ OPEN: 1, readyState: 1, bufferedAmount: 0, send(buf) { process.send(frameMsg(key, buf, buf[0] === 1)) } }` (byte 0 of the wire header is the keyframe flag, see `sdk.mjs` `encodeFrame`).
- For tests, `CCTV_WORKER_FAKE_SDK=1` makes the worker load the fake SDK from `test/fake-sdk.mjs` (extract the fake `NET_SDK` already used in `test/cooling.test.mjs` into that file; `sdk.mjs` must expose a way to replace `NET_SDK` for tests — follow whatever hook `cooling.test.mjs` uses, and reuse it).

- [ ] **Step 1: Write the failing test**

```js
// cctv/test/live-worker.test.mjs
import { fork } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const data = mkdtempSync(join(tmpdir(), 'cctv-worker-'))
writeFileSync(join(data, 'nvrs.json'), JSON.stringify({ nvrs: [{ id: 'w1', site: 'T', name: 'W1', host: 'w1.invalid', port: 6036, user: 'u', password: 'p' }] }))
const child = fork(new URL('../nvr-worker.mjs', import.meta.url), [], { serialization: 'advanced', env: { ...process.env, DATA_DIR: data, CCTV_WORKER_NVR: 'w1', CCTV_WORKER_FAKE_SDK: '1' } })
const got = []
child.on('message', (m) => got.push(m))
const until = async (pred, ms = 8000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)) ; return pred() }
check('worker says ready', await until(() => got.some((m) => m.t === 'ready')))
child.send({ t: 'want', ch: 2, type: 1 })
check('frames arrive for the wanted stream', await until(() => got.some((m) => m.t === 'frame' && m.key === '2:1')))
check('frames are Buffers with the key flag', got.find((m) => m.t === 'frame')?.buf instanceof Uint8Array)
child.send({ t: 'unwant', ch: 2, type: 1 })
child.send({ t: 'stop' })
check('worker exits on stop', await until(() => child.exitCode !== null || child.signalCode !== null))
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run in the lab; expect FAIL** (missing `nvr-worker.mjs`).

- [ ] **Step 3: Implement `cctv/nvr-worker.mjs`**

```js
// One NVR's live video in its own process: its SDK, its lanes and its watchdog, so a slow or
// crashing NVR cannot hold up another NVR's video. Started by worker-supervisor.mjs.
import { MSG, frameMsg, streamKey } from './worker-ipc.mjs'

if (process.env.CCTV_WORKER_FAKE_SDK === '1') await import('./test/fake-sdk.mjs') // installs the fake NET_SDK
const { Nvr, readConfig } = await import('./nvrs.mjs')
const { sdkStats } = await import('./sdk.mjs')
await import('./watchdog.mjs')

const id = process.env.CCTV_WORKER_NVR
const cfg = readConfig().nvrs.find((n) => n.id === id)
if (!cfg) {
  console.error(`[worker] no NVR ${id} in the config`)
  process.exit(2)
}
const nvr = new Nvr(cfg)
const taps = new Map() // key -> { tap, stream }

const tapFor = (key) => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, send: (buf) => process.send?.(frameMsg(key, buf, buf[0] === 1)) })

process.on('message', (m) => {
  if (m?.t === MSG.WANT) {
    const key = streamKey(m.ch, m.type)
    if (taps.has(key)) return
    const stream = nvr.getStream(m.ch, m.type)
    const tap = tapFor(key)
    stream.add(tap)
    taps.set(key, { tap, stream })
  } else if (m?.t === MSG.UNWANT) {
    const key = streamKey(m.ch, m.type)
    const t = taps.get(key)
    if (t) t.stream.remove(t.tap)
    taps.delete(key)
  } else if (m?.t === MSG.STOP) shutdown()
})
process.on('disconnect', shutdown)

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await Promise.race([nvr.stop().catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
  process.kill(process.pid, 'SIGKILL')
}

await nvr.start()
process.send?.({ t: MSG.READY })
setInterval(() => process.send?.({ t: MSG.STATS, status: nvr.status, sdk: sdkStats() }), 5000).unref()
```

Note for the implementer: check the real `Nvr` constructor and start method names in `nvrs.mjs` (around line 328) and adapt the three lines that use them; if `nvrs.mjs` starts every NVR at import time, move that into `startNvrs()` only (it already is — verify) so importing it in the worker starts nothing by itself.

- [ ] **Step 4: Run in the lab; expect all checks PASS; rerun `sdk-guards`, `cooling`, `playback-busy` (must stay green).**

---

### Task 4: Supervisor (fork, restart, route)

**Files:**
- Create: `cctv/worker-supervisor.mjs`
- Test: `cctv/test/live-worker.test.mjs` (append)

**Interfaces:**
- Consumes: `StreamHub` (Task 2), `nvr-worker.mjs` (Task 3).
- Produces:
  - `startWorker(nvrId) → { hub: StreamHub, state(): 'starting'|'ready'|'restarting', stats(): object|null, stop(): Promise<void> }`
  - Restart on unexpected exit after 2 s, 5 s, 15 s, 60 s (reset to 2 s after 5 min healthy); calls `hub.onWorkerRestart()` once the new worker says ready.
  - Logs `[worker nvr-2] exited (signal SIGKILL), restarting in 5 s`.

- [ ] **Step 1: Failing test** (append): start a supervisor for `w1` with the fake SDK, add a fake ws to `hub.getStream(2, 1)`, wait for frames on the ws, then `child.kill('SIGKILL')` via a test hook `sup._child()`, check `state()` goes `restarting` then `ready` and frames reach the same ws again after a keyframe; finally `await sup.stop()` and check the child has exited.

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement**

```js
// cctv/worker-supervisor.mjs
// Starts and watches one live worker per NVR; the hub keeps viewers connected across restarts.
import { fork } from 'node:child_process'
import { StreamHub } from './stream-hub.mjs'
import { MSG } from './worker-ipc.mjs'

const BACKOFF_MS = [2000, 5000, 15_000, 60_000]
const HEALTHY_MS = 5 * 60_000

export function startWorker(nvrId, { env = {} } = {}) {
  let child = null
  let state = 'starting'
  let stats = null
  let tries = 0
  let readyAt = 0
  let stopping = false
  let timer = null
  const hub = new StreamHub(nvrId, (m) => child?.connected && child.send(m))

  const spawn = () => {
    state = state === 'starting' ? 'starting' : 'restarting'
    child = fork(new URL('./nvr-worker.mjs', import.meta.url), [], { serialization: 'advanced', env: { ...process.env, ...env, CCTV_WORKER_NVR: nvrId } })
    child.on('message', (m) => {
      if (m?.t === MSG.FRAME) return hub.onMessage(m)
      if (m?.t === MSG.READY) {
        const again = state === 'restarting'
        state = 'ready'
        readyAt = Date.now()
        if (again) hub.onWorkerRestart()
        else for (const s of hub.streams.values()) if (s.wanted) child.send({ t: MSG.WANT, ch: s.ch, type: s.type })
      } else if (m?.t === MSG.STATS) stats = m
    })
    child.on('exit', (code, signal) => {
      if (stopping) return
      if (Date.now() - readyAt > HEALTHY_MS) tries = 0
      const delay = BACKOFF_MS[Math.min(tries++, BACKOFF_MS.length - 1)]
      console.warn(`[worker ${nvrId}] exited (${signal ? `signal ${signal}` : `code ${code}`}), restarting in ${delay / 1000} s`)
      state = 'restarting'
      for (const s of hub.streams.values()) s.reset()
      timer = setTimeout(spawn, delay)
    })
  }
  spawn()

  return {
    hub,
    state: () => state,
    stats: () => stats,
    _child: () => child,
    async stop() {
      stopping = true
      clearTimeout(timer)
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      const gone = new Promise((r) => child.once('exit', r))
      child.send({ t: MSG.STOP })
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    },
  }
}
```

- [ ] **Step 4: Run; expect PASS.**

---

### Task 5: Wire into the app behind `CCTV_LIVE_WORKER=on`

**Files:**
- Modify: `cctv/nvrs.mjs` (`getStream` ~line 554, `startNvrs`, `stopNvrs` ~line 690, `allCameras` unchanged)
- Modify: `cctv/server.mjs` (`/healthz`)
- Test: `cctv/test/live-worker.test.mjs` (append)

**Interfaces:**
- `Nvr.getStream(ch, type)`: when the flag is on, returns `this.worker.hub.getStream(ch, type)` (same `add/remove` contract the WebSocket handler at `server.mjs:322` already uses), and the parent's `Nvr` never calls `NET_SDK.LivePlay`.
- `startNvrs()`: with the flag on, also `nvr.worker = startWorker(nvr.id)` per NVR; `stopNvrs()` awaits `nvr.worker.stop()`.
- `checkStalled` in the parent does nothing for streams that live in a worker (the worker runs its own).
- `/healthz` adds `workers: { <id>: { state, status, late, inFlight } }` from `stats()`.

- [ ] **Step 1: Failing test:** with the flag on and the fake SDK, import `nvrs.mjs`, `startNvrs()`, call `nvrs.get('w1').getStream(2, 1).add(ws)`, check frames reach `ws`, and check (via the fake SDK's call log in the PARENT) that no `LivePlay` ran in the parent.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement the four modifications above.**
- [ ] **Step 4: Run all 18 suites + the 2 new ones in the lab; all PASS. With the flag unset, `cooling` and `sdk-guards` must pass unchanged (proves the old path is intact).**

---

### Task 6: Trial on the test server

**Files:**
- Modify: `/etc/cctv/cctv.env` on the test server only (add `CCTV_LIVE_WORKER=on`) — via `lab.sh sh`, then `systemctl restart cctv`.

- [ ] **Step 1:** `bash deploy/push.sh --code-only --distro Ubuntu-24.04`; confirm `OK: CCTV <release> is running`.
- [ ] **Step 2:** enable the flag, restart, check `/healthz` shows three workers `ready`.
- [ ] **Step 3:** on the test PC browser: grid + a full-size view on each NVR; confirm pictures and that a second browser watching the same camera does not add a second `LivePlay` for it in the journal trace (`journalctl -u cctv | grep 'NET_SDK_LivePlay nvr1/19:main'` shows one start).
- [ ] **Step 4:** kill one worker (`pkill -f 'CCTV_WORKER_NVR=nvr-2'` is not reliable — use the worker PID from `ps -eo pid,args | grep nvr-worker`) and confirm the other NVRs' video keeps playing and nvr-2 comes back within ~5 s.
- [ ] **Step 5:** leave it for a few hours; compare stall and watchdog counts with the morning of 2026-09-24 (`journalctl -u cctv --since ... | grep -c 'stalled, restarting'`, and `grep -c 'watchdog'`). Report to the owner. Rollback = remove the flag and restart.

---

## Later plans (not in this plan)
- Phase 2: recorder (segments + index + database) inside the worker, housekeeping, storage page.
- Phase 3: playback from server disk (fast seek, scrubbing, speeds, RAM cache, thumbnails), NVR fallback.
- Phase 4: export (MP4 remux, evidence signing), per-user rights checks, recording settings page.
