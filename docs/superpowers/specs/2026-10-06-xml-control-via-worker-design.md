# NVR settings through the worker's login — design

Date: 2026-10-06. Status: built on branch `xml-control-via-worker`; not deployed.

## Goal

Keep an NVR's settings pages and background checks working when the NVR refuses the server's
second login.

The server holds two sessions per NVR: the live worker's (video and recording) and the main
process's (the "control login": settings, disk and clock checks, playback, searches). On
2026-10-06 shad (P2P, NVR6216-P16-V3) accepted the worker's login and refused the control login
with "NVR busy" from 13:20 UTC onwards. Its record matches g-port's, which accepts both, and the
control login had been in overnight, so the likely cause is the NVR's connection slots filling up
with the site's own viewers during the day. That was not confirmed: seeing the NVR's user list
needs the login that is refused.

While the control login is out, every settings page for that NVR says "offline", and its disk
health and clock drift are not checked.

## Scope

In, while the control login is down and the worker's login is up:

- every command sent with `transparent()` (`nvr-xml.mjs`), whichever module asks: disk health,
  clock, imaging, lens, OSD, streams and sub-streams, tripwire, event settings, probe, and the
  modules that are handed `transparent` rather than importing it;
- reboot and shutdown (`power()`).

Out:

- NVR playback, recording search and motion search (`playback.mjs`, `motion.mjs`, `events.mjs`
  searches, `backfill.mjs`). They hold SDK handles and stream frames; they keep needing the
  control login and keep saying the NVR is offline. Playback of server-recorded footage is
  unaffected, as today.
- Freeing a slot on the NVR. If the worker's login is refused as well, nothing here helps.
- Any change for an NVR whose control login is up.
- The camera-detail read behind the localhost export (`camera-export.mjs`). It is a heavy read that runs unattended every night; a slow one on a borrowed session would hold up the process that records. It keeps needing the control login.

## Approach

`transparent()` and `power()` stay the one place a command leaves the main process. Their queue,
process-wide turn, read breaker, full-queue refusal and 90 s cap are unchanged. One exception: a borrowed command passes the process-wide turn on as soon as it is handed to the worker, because that turn guards this process's SDK, which the command never enters. Only the last
step differs: with no control session, the command is handed to that NVR's worker, which sends
it on its own login and returns the answer.

```
caller -> transparent(nvr, ...)            main process, unchanged queueing
            |- control login up   -> NET_SDK.TransparentConfig(nvr.userId, ...)   as today
            '- borrowing          -> worker.request({ op: 'xml', ... })
                                       worker: transparent(workerNvr, ...) on its own login
                                       -> reply { ok, text } or { ok: false, error }
```

The worker already holds a full `Nvr` and already calls `transparent()` for its own
`queryOnlineChlList` read, so the call it makes is one it makes today. It goes through the
worker's own lane, so it cannot overlap that worker's other SDK calls to the NVR (overlapping
calls have corrupted the heap).

## When the main process borrows

`nvr.borrowing` is true when all of these hold:

- the control login is not up;
- it has failed at least once since it was last up, or since the process started (so a normal
  start, where a slow P2P login is still in progress, borrows nothing);
- the worker is `ready` and reports `status: 'online'`;
- `CCTV_XML_VIA_WORKER` is not `off` (default on; the switch is there to turn the feature off on
  prod without a deploy).

The control login keeps retrying on its present schedule (every 60 s). When it gets in,
`borrowing` turns false and the next command goes out on it. Nothing is migrated: a command
already handed to the worker finishes there.

## Session identity

Callers read settings, let the user edit, then write, and pass the session generation (`gen`) so
a write is refused if the NVR session changed in between. A borrowed session needs the same
guard.

- `nvr.xmlGen` replaces `nvr.gen` for XML callers. It is a string: `own:<gen>` on the control
  login, `worker:<spawnedAt>:<workerGen>` while borrowing.
- The worker reports its `nvr.gen` in every STATS message; the supervisor already knows
  `spawnedAt`.
- A request carries the generation the caller holds. The main process refuses it before sending
  if it no longer matches `nvr.xmlGen`; the worker refuses it if its own `gen` has moved on. Both
  say "reconnected; nothing was sent", as today.
- A change of path counts as a change of session: a page that read on the control login and
  writes after the fallback began is told to reload. That is deliberate. It is rare and it is the
  safe answer.

## Online checks

Two getters on `Nvr`:

- `xmlOnline`: `online || borrowing`.
- `xmlDegraded`: as `degraded`, with `xmlOnline` in place of `online`, and with the worker's late
  SDK calls counted when borrowing.

Each of the roughly 40 `!nvr.online`, `nvr.userId < 0` and `nvr.degraded` checks outside
`nvrs.mjs` is sorted into one of two groups:

- guards a path that only uses `transparent()` or `power()`: switch to
  `xmlOnline` / `xmlDegraded`;
- guards playback, search, live or backfill: leave alone.

`requireOnline()` in `nvr-xml.mjs`, the shared guard several settings routes use, moves to
`xmlOnline` with them. The plan lists every check with its group; none is left to judgement
during the build.

## Messages

Two additions to `worker-ipc.mjs`, the first request/reply pair in the protocol:

- `REQ` (parent to worker): `{ t, id, op, gen, ... }`, with `op` one of
  - `xml`: `url`, `xml`, `tag`, `outBytes`;
  - `power`: `action` (`reboot` or `shutdown`).
- `RES` (worker to parent): `{ t, id, ok: true, text }` for `xml`, `{ ..., accepted }` for
  `power`; or `{ t, id, ok: false, error: { message, name, status,
  extra } }` (`extra` carries the retry hint).

The supervisor gains `request(msg, { timeoutMs })`, which returns a promise, and rejects every
pending request when the child exits or is restarted.

## Failures

| Case | What the caller gets |
|---|---|
| Worker not ready, or its login drops before sending | "is offline" / "reconnected; nothing was sent" (nothing was sent) |
| Worker's `transparent()` refuses (its SDK stuck, its breaker open) | the same 503 with its retry hint, passed through |
| The NVR does not answer in time | the worker's timeout error, passed through; counts towards the main process's read breaker as a timeout does today |
| No reply within the cap plus 5 s (95 s) | a timeout error |
| Worker exits or is restarted with the request in flight | for a read: an error, try again. For a write or a power command: "the connection was lost; the change may or may not have been made", the same uncertainty a timed-out write carries today |
| Control login returns mid-request | the request finishes on the worker; later ones use the control login |

A request the worker is still running when the main process gives up is not cancelled (an SDK
call cannot be). The worker's own cap releases its queue.

## Load on the worker

The worker records live video, so settings traffic must not hold it up.

- Requests run at the worker lane's normal priority, below stream starts made for a viewer, as
  `transparent()` already does.
- The main process sends one request per NVR at a time (its per-NVR queue already guarantees
  this), so the worker never has a backlog of them.
- The worker's watchdog treats a stuck borrowed call like any other stuck call: it restarts the
  worker. That is the existing behaviour for its own XML read. It does mean a hung settings call
  on a borrowed session costs a few seconds of recording on that NVR, where today it would cost
  none. Accepted, because the alternative is no settings at all; recorded here so it is not a
  surprise.
- A settings call that is slow but not hung (past the SDK's 20 s budget, as the large encode reads can be over P2P) makes the worker hold back new stream starts until it returns, and viewers' new streams for 60 s after. Recording already running is not interrupted. This is new for a borrowing NVR: before, the same slow call sat in the main process. Accepted for calls an admin makes; it is why the unattended camera-detail read is not borrowed.

## What the user sees

- Settings pages for a borrowing NVR work as normal.
- The Health page's NVR panel shows one extra line for it: "Settings are going through the video
  login; the NVR is refusing a second one." Playback and search for that NVR still report it
  offline, with the existing wording.
- No new alert. The existing `nvr-refusing` and `nvr-login` alerts are unchanged.

## Testing

All with the fake SDK; nothing reaches an NVR.

- `nvr-xml`: with a stand-in worker, a command goes to the worker when borrowing and to the SDK
  when not; the queue, the turn, the breaker and the full-queue refusal behave the same on both
  paths; a generation mismatch is refused before anything is sent.
- `worker-supervisor`: `request()` resolves on the matching reply, times out, and rejects every
  pending request on exit and on restart.
- `nvr-worker`: each `op` runs on the worker's login and answers; a stale `gen` is refused; a
  request arriving during shutdown is refused.
- `Nvr`: `borrowing` is false at a clean start, true after one failed control login with the
  worker online, false again when the control login returns, false with the switch off.
- One wiring check per module moved to `xmlOnline`, so a later edit cannot quietly move it back.
- A check that `playback.mjs` and `motion.mjs` still gate on `online`.

On prod, after deploy: shad's Health panel shows the new line, its disk health and clock drift
read "checked" within 10 minutes, and one settings page (sub-streams) opens and saves.

## Not decided here

Whether to drop the control login for every NVR and log in only when playback needs it (approach
C). It would halve the sessions the server holds, but it is a separate, larger change.
