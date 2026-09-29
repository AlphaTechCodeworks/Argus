# Stream rights (Live HD, Playback SD/HD) — design

Date: 2026-09-29. Owner: Mike. Status: approved by the owner (feature), with the design rulings of the
completeness review (scratchpad `stream-rights/map-critic.md`, section c), the controller's
amendments A1-A5 below, and the Decisions D1-D14 taken on the plan review (D9 and D10
confirmed by the controller 2026-09-29). Branch `stream-rights` (worktree `TVT-CCTV-streams`, based on master 119c43e).
All paths are under `cctv/` unless they say otherwise; line numbers are at 119c43e.

## Goal

The access editor (Users & audit -> Edit access) sets, per user and per site or camera:

| Tick (editor label) | Stored action | What it allows |
|---|---|---|
| **Live** | `live` (exists) | The live grid, on the camera's sub-stream. |
| **Live HD** | `live-hd` (new) | Full screen at full quality: the camera's main stream. Without it, full screen stays on the sub-stream. |
| **Playback SD** | `playback-nvr` (exists) | The NVR's own recordings, on the NVR's sub-stream copy. |
| **Playback HD** | `playback-server` (exists) | Argus's own recordings (whatever stream the recorder kept, normally main). |
| **Export** | `export` + formats (exists) | As now: clips from Argus's recordings in the ticked formats. |

It is enforced on the server, so no edited link, crafted message or indirect path (stand-ins, the HD-only
switch, stills) hands main-stream pictures to someone without the right. Default deny. Anyone who has
Live today keeps HD (the migration copies Live to Live HD), so nothing changes for existing live access.
One narrowing is deliberate and named in the migration's audit row: an account whose Playback SD
reaches cameras its Live does not (live `n1/0`, playback-nvr `n1`) gets the NVR's recordings and event
pictures there in SD only, since HD there now needs Live HD or Playback HD (section 3.2). Production has
one account today (the admin), so no viewer is affected at deploy; the migration must still be exact.

Controller amendments (binding):
- **A1.** `cctv/events.mjs` and `cctv/test/events.test.mjs` are not modified (another session has work
  on them). Nothing in this design needs them: the event snapshot is served by `event-snapshot.mjs`
  (server.mjs:606-609), and `canSee` (server.mjs:595) is unchanged. No follow-up is left in events.mjs.
- **A2.** The migration shadow file `rights.v2.json` is used, with the rule: Live HD = shadow ∩ Live
  when a shadow exists, else Live (section 3.3). Applied per account, which refines the literal rule:
  an account the shadow does not hold, or one made after the shadow was written, gets Live (ruling D9;
  for the controller to confirm).
- **A3.** Out of scope: the outage-buffer pause switch, and any live-stutter fix. Edits to
  `live-attach.mjs` and `live-mux.mjs` are kept small and self-contained (the waiting logic lives in a
  new module, `live-wait.mjs`); `public/playout.js` is not touched.
- **A4.** Protocol additions are backward compatible with pages left open across the deploy (section 4.6).
- **A5.** Commits end with exactly one trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
  on branch `stream-rights` only; never pushed, merged or deployed by the implementer.

## Decisions

Taken after the plan review (scratchpad `stream-rights/plan-review-security.md`, `plan-review-plan.md`).
Each is carried into the sections named. A line starting "Ruling:" is where this design keeps its own
answer instead of the reviewer's, with the reason.

- **D1. "May see main" is asked from the session as it is at that moment** (security F1). server.mjs
  hands `connectPlayback` an `allowedMain` that reads the session again on every call
  (`currentUser(req)`, then `mayHd` with the account's role now), never the `who` built at the upgrade:
  a demoted admin's switch minutes later is not waved through. The session asks it when the 4 s run
  out and **again after `StopPlayBack`**, before it says `{type:'stream'}`, calls `onMain` or opens
  main; a no then is a refusal, in words about the right ("Playing this camera in HD from the NVR
  needs Playback HD or Live HD.", F1). `onMain` re-tracks the socket and runs a sweep at once
  (sections 2.2, 2.5).
- **D2. A camera marked HD-only is still tried in SD for a viewer who cannot switch** (security F2).
  Only a viewer who may see main goes straight to main on a marked camera. Anyone else opens on SD: an
  SD frame clears the mark, and with no SD frame after `SD_REFUSE_MS` (6 s) of the NVR playing the
  session is refused with neutral words ("No SD recording of this camera came from the NVR (it may keep
  this camera only in HD) …"), on a marked camera only: on an unmarked one it says `{type:'end'}`
  after 8 s, as for any gap (F1). An older release's `[ch, …]` marks were written by the faulty rule and
  are not read, so each such camera is tried in SD once more (section 2.4).
  Ruling: 6 s, not longer: `playback.mjs` tells the page the recording ended after 8 s without a frame
  (`IDLE_END_MS`), so a longer wait would show "end of recording" instead of the reason.
- **D3. The shadow is written before rights.json and never holds Live HD that rights.json has not got**
  (security F3). Three writes: the shadow with each account's Live HD cut to old ∩ new, then
  rights.json, then the shadow as the new rows. A shadow that cannot be written refuses the save
  before rights.json is touched (section 3.3).
- **D4. A picture older than its event's row is not served, whole or as the SD copy** (security F4): it
  belonged to an earlier event with the same id, maybe of another camera (section 2.3 S1). Nor is a
  picture taken again after it was looked at, or an SD copy of any picture but the one there now (F3).
- **D5. The SD copies have their own one-at-a-time ffmpeg queue, and a copy that failed is not tried
  again for 5 minutes** (security F6), so they never delay the picture of a new crossing.
  Ruling: no per-user cap on SD copies. A viewer can only ask for pictures of cameras they may play
  back, the queue runs one copy at a time at the lowest CPU priority and never holds back new event
  pictures, and each copy is made once and kept; a cap would add per-user state for no protection.
- **D6. The migration names the accounts whose Playback SD reaches beyond their Live** (security F7),
  in its audit row and console line. No right is added: default deny stands (sections 1.2, 3.4, 6, 8).
- **D7. Rule 7 has a stated exception: event stills follow the still rule** (security F8): either
  playback right shows the picture, full size only with `mayHd` (sections 1.2, 1.3, 8, help text).
- **D8. A rights.json from a newer release is never rewritten** (security F9, plan 5). The editor's
  save and `saveRights` are refused (409). An account added or removed (users-api, adduser.mjs) takes
  out only that account's row from the file as it is, keeping its version and every right this release
  does not know, and says so in the audit.
  Ruling: neither of the reviewers' two options. Refusing account changes would leave a removed name's
  row for the next account of that name, and rewriting as version 2 drops the newer release's rights;
  removing one row needs no understanding of the rest (section 3.1).
- **D9. A2 is applied per account.** Ruling: the shadow restores the Live HD of the accounts it holds
  (cut to their Live now); an account it does not hold, or one made after it was written, was never
  given or refused Live HD by this release and had HD in practice under the older one, so it gets Live,
  as in a first upgrade. Applying the shadow to them would silently take HD from people nobody chose to
  limit. Confirmed by the controller 2026-09-29.
- **D10. A4 and old pages: two bounded retry paths remain, accepted.** Ruling: an old `/live` tile
  refused `'hd not allowed'` retries with its back-off capped at 8 s, and an old mux tile on a held sub
  lets its stall watchdog reopen it; both are exactly today's handling of `'not allowed'` and a stalled
  stream, cost one small message each, touch no stream, and cannot happen at deploy: production's only
  account is an admin, who is never refused HD or sent a wait notice. Every other old-page path ends
  (section 4.6). Confirmed by the controller 2026-09-29.
- **D11. Wait notices after a stand-in ends, and "held" only when this sub-stream is held** (security
  F10, plan 10). Live HD taken away while a stand-in runs starts the wait notices on that socket or
  channel. The NVR being at its sub-stream limit counts as "held" for the first notice only (the tile's
  request is not in the worker's list yet); later notices say "held" only when the worker holds this
  sub-stream, so a camera the NVR refuses outright shows "SD stream not available" (section 4.1).
- **D12. An admin's camera lists are built without a rights check per camera** (plan 11), as the old
  route was (section 2.3 C1, C2).
- **D13. The playback page's words for `'hd not allowed'` cover both refusals** (plan 12): the main
  stream asked for without the right, and no SD recording (section 5).
- **D14.** The review's `'refused'` wait reason (map-critic Q9) has no source: the worker does not
  report a refused sub-stream. The 15 s `'unavailable'` rule stands in for it (section 4.1).

### After the final reviews (2026-09-29)

Two fix rounds after the branch's final reviews narrowed the behaviour below; the sections named say
it where it applies. Each is the code as committed (ledger: "Fix round after the final reviews" and
"Fix round 2").
- **F1. The SD refusal is for a camera marked HD only** (controller's ruling). On an unmarked camera
  no frame is no footage there (the camera off that day, a motion-only schedule, before the NVR's
  retention): the session says `{type:'end'}` after `IDLE_END_MS` (8 s), as for any gap, never a 1008
  refusal, which the camera wall keeps for the tile's life (D2, P4, 2.4, 4.2). The D1 refusal (the
  right gone during `StopPlayBack`) stays a refusal on any camera, since the SD playback is already
  stopped; its words are about the right, not "No SD recording" (P4).
- **F2. The upgrade fails closed** (controller's ruling). A row that already carries a `live-hd` key
  keeps its own list, cut to its Live; a shadow that is there but cannot be used gives Live HD to
  nobody and is named in the audit row and on the console, with the accounts to give it back to
  (3.1-3.3, section 6).
- **F3. Event pictures are served only as the picture that was looked at** (controller's ruling and
  review). An SD copy bears its picture's time and is served only while that picture is there; a
  picture is read through one handle whose time must be the one looked at (S1).

### After the merge with live-smooth (2026-09-29)

- **M1. A remote main is asked again at every move between streams.** live-smooth's level changes
  put a remote full-size view's main on other streams at the camera's keyframes: another viewer's
  conversion of that main, level full's (at most 2, else level 15's until one is free), the camera's
  own. Each is main-stream pictures handed out again, so adaptive-live asks first (`mayMain` from
  live-attach.mjs: Live and Live HD from the session and the account's role now, as the access watch
  asks), when the move is decided and again when it goes over (up to 10 s later). A no: not moved,
  nothing more sent, the socket closed 1008 with the watch's reason ('hd not allowed' when only Live
  HD went). A sub-stream's streams never carry the main and are not asked (L5). A remote viewer's
  stand-in is the main's keyframes only, inside L3's Live HD branch, and its end line says
  "Live HD was taken away" when its handle is closed.

## 1. The rights model

### 1.1 Actions

`ACTIONS = ['live', 'live-hd', 'playback-server', 'playback-nvr', 'export', 'admin']` (rights.mjs:45:
`live-hd` inserted after `live`, nothing renamed or reordered). No action id is renamed: Playback SD
stays `playback-nvr` and Playback HD stays `playback-server` in storage, checks and tests; only the
editor's labels change. That keeps playback lossless on rollback.

### 1.2 The rules

1. **Default deny** (unchanged): `can()` is true only for an explicit grant, or for an admin.
2. **Live HD counts only with Live.** In `can()` (rights.mjs:351-352), after the `covers` check:
   `if (action === 'live-hd' && !covers(rights.grants.live, nvr, ch)) return false`. A stray `live-hd`
   target (hand-edited, a stale shadow) grants nothing. Every existing `live` check stays as it is.
   Admins return true earlier (rights.mjs:348), so admins and `CCTV_AUTH=off` always have HD.
3. **`canAny(who, 'live-hd')`** also needs a non-empty `live` list (coarse, like the rest of `canAny`).
4. **`sitesFor`** (rights.mjs:391) leaves `live-hd` out of its "any grant touches this NVR" test, so a
   `live-hd`-only row never reveals a site's name or status.
5. **The may-see-main helper**, next to `canPlayServer`/`canPlayNvr` (rights.mjs:396-416):

   `mayHd(who, nvrId, ch) = can(who, 'live-hd', {nvr, ch}) || can(who, 'playback-server', {nvr, ch})`

   It is the one definition of "may see a main-stream picture of this camera" for **recorded or still**
   pictures: NVR playback at main (with `playback-nvr`), and the full-size event snapshot. **Live main
   uses `live-hd` alone** (Playback HD does not open live full screen at full quality).
6. **NVR main-stream playback** = `playback-nvr` AND `mayHd`. There is no new stored action. After the
   migration every existing viewer (Live `*` + Playback SD `*`) holds Live HD, so keeps NVR HD. A
   Playback-SD-only row never gets main. Where a row's Playback SD reaches cameras its Live does not,
   those cameras lose NVR HD and full-size event pictures (default deny; the migration names such
   accounts, D6). NVR legs inside a server playback keep today's rule (`playback-server` AND
   `playback-nvr`), which already includes an HD right.
7. **Playback HD never reaches the NVR**, and **Playback SD never plays Argus's recordings** (the
   owner's source-based definition; unchanged). One exception, kept from today (ruling Q13, D7): event
   stills are made from Argus's recordings and follow the still rule, not the source rule: either
   playback right shows an event's picture, at full size only with `mayHd` (Live HD or Playback HD),
   else the SD copy (S1).

### 1.3 What each right lets through

| Picture | Needs |
|---|---|
| Live sub-stream (grid, map popup, phone list, full screen without HD) | `live` |
| Live main stream (full screen, direct `stream=0`, the stand-in for a cold/held/refused sub, the phone stand-in conversion) | `live` and `live-hd` |
| NVR playback, sub | `playback-nvr` |
| NVR playback, main (`stream=0`, a camera the NVR keeps only in HD, the 4 s switch) | `playback-nvr` and `mayHd`, asked from the session at that moment (D1) |
| Server playback (every command: seek, scrub, speeds, reverse, fit, original, conversion) | `playback-server` |
| NVR legs inside server playback | `playback-server` and `playback-nvr` |
| Event snapshot, full (<=1280 wide, from main) | a playback right and `mayHd` (never a picture older than its event) |
| Event snapshot, SD copy (<=704 wide) | a playback right (never made from a picture older than its event) |
| Export (pack, MP4, stills) | `export` + format (as now; always the recording's full quality) |
| Metadata (lists, timelines, searches, health, maps) | as now (section 2, "unchanged" rows) |

## 2. Enforcement

One row per surface found by the four maps and the review. "Refusal" is what the client receives.

### 2.1 Server: live

| # | Surface | Where | Picture | Check | Refusal |
|---|---|---|---|---|---|
| L0 | `/live?stream=` parse | server.mjs:1011 | n/a | `streamType = streamParam(get('stream'))`: absent = 1, exactly `'0'`/`'1'`, anything else NaN (new `stream-param.mjs`). `Number('')`, `'0.0'`, `'0x0'`, `'-0'`, `'+0'`, `'0e5'`, `'%200'`, `'%0A0'`, `'0b0'`, `'0o0'` all used to be main. `stream=1&stream=0`: `get` takes the first. | NaN: 1008 `'bad channel or stream'` (live-attach.mjs:56-59, after the live check) |
| L1 | `/live` and `/live-mux` `{op:'sub',stream}`: direct stream | live-attach.mjs:49-59 | main if `streamType !== 1` (a raw `"stream":-0` passes the channel check, live-mux.mjs:91, and is main) | `live` first (as now, :50; live-mux-server.test.mjs:676 expects `live` asked first), validation, then `if (streamType !== 1 && !can(who,'live-hd',{nvr,ch}))` | 1008 `'hd not allowed'` (a mux channel gets `{"op":"end","id":N,"code":1008,"reason":"hd not allowed"}`); nothing tracked, no stream touched |
| L2 | Tracking of live sockets and channels | live-attach.mjs:63 | n/a | `actions: streamType === 1 ? ['live'] : ['live', 'live-hd']` | the sweep closes 1008 `'hd not allowed'` when only Live HD failed, `'not allowed'` when Live failed (section 2.5) |
| L3 | Sub-bridge stand-in (cold, held or refused sub; local, phone and remote) | live-attach.mjs:73-77, sub-bridge.mjs:30-76 | main on a sub socket (a full-resolution keyframe even for 2 s) | `can(who,'live-hd',{nvr,ch})`. **With it:** as today, plus the bridge is tracked as a handle `{readyState:1, on:(e,f)=>ws.on(e,f), close}` with `['live','live-hd']`, whose `close` ends the bridge (`bridge.end('rights')`) and starts the wait notices on the socket or channel, which stays on its sub-stream (D11). **Without it:** no `nvr.getStream(ch, 0)` at all (in non-worker mode that call starts a LivePlay; in worker mode it creates a HubStream), no `bridgeSub`; the viewer is sent wait notices (section 4.1) until its sub-stream's first frame | no picture until the sub comes; wait notices |
| L4 | Phone stand-in conversion `<nvr>/<ch>/0/standin` | live-attach.mjs:32-38 | main converted, 1280 wide | reached only through L3's HD branch | as L3 |
| L5 | Phone thinned stream and adaptive (remote) conversions | live-attach.mjs:80-90, adaptive-live.mjs:105-121, phone-live.mjs:196-207 | the requested type, converted | keys include the stream type: covered by L1. The remote viewer's stand-in is L3 (it happens before adaptive attach). After the merge with live-smooth (M1): a remote main moved to another stream at a level change asks Live and Live HD again first | as L1/L3; M1: closed 1008 with the access watch's reason |
| L6 | Warm-ups | server.mjs:1020-1032 | sub, no viewer | none needed | n/a |
| L7 | Worker, hub, sub-cap | nvr-worker.mjs, stream-hub.mjs, sub-cap.mjs | scheduling only | none (no user known there); `subHeld`/`subFull` (nvrs.mjs:667-674) feed the wait notice | n/a |

### 2.2 Server: playback

| # | Surface | Where | Picture | Check | Refusal |
|---|---|---|---|---|---|
| P1 | `/playback` upgrade gate | server.mjs:985 | either | unchanged: either playback right | 1008 `'not allowed'` |
| P2 | NVR playback stream parse | rec-playback.mjs:223-231; playback.mjs:785 | n/a | parsed **once** in `connectPlayback` with `streamParam`; `main = stream === 0`. playback.mjs stops reading `stream` from the URL: `nvr.playback.connect(ws, url, { main, allowMain, onMain })` | NaN: 1008 `'bad parameters'` |
| P3 | NVR playback asked for main | rec-playback.mjs:229-240 | main | `main && !mayHd(who, nvr, ch)`; the `allowedMain` server.mjs hands in reads the session again on every call (D1) | `{type:'error', message:'Playing this camera in HD from the NVR needs Playback HD or Live HD.'}`, then 1008 `'hd not allowed'`; no NVR session |
| P4 | NVR camera known to be HD-only, and the 4 s switch | playback.mjs:419-446, 703-707, 724-740, 783-794 | main on a sub socket | known HD-only: main at once only if `allowMain()`; anyone else opens on SD (a mark can be wrong; an SD frame clears it). No SD frame after 4 s of the NVR playing: the switch runs only if `allowMain()`, asked then **and again after `StopPlayBack`**, before `{type:'stream'}`, `onMain` or the main open (a right removed meanwhile counts, D1); a viewer without it is refused after `SD_REFUSE_MS` (6 s) of playing on a camera marked HD only (`noSdAction`, hd-only.mjs, D2), and on any other camera gets `{type:'end'}` after 8 s without a frame, as for any gap (F1). The switch itself is fixed first (section 2.4) | on a marked camera `{type:'error', message:'No SD recording of this camera came from the NVR (it may keep this camera only in HD). Playing it in HD needs Playback HD or Live HD.'}`, then 1008 `'hd not allowed'`; the right gone during `StopPlayBack` (D1): `{type:'error', message:'Playing this camera in HD from the NVR needs Playback HD or Live HD.'}`, then 1008 `'hd not allowed'` |
| P5 | Tracking of `/playback` sockets | server.mjs:992-993 | n/a | from what `connectPlayback` decided (never a second read of the URL): NVR sub `['playback-nvr']`; NVR main `['playback-nvr', ['live-hd','playback-server']]` (an any-of group, section 2.5); server `['playback-server']`, with legs `['playback-server','playback-nvr']`. An NVR session that switches to main is tracked again with the main list and swept at once (`onMain`: `watch.track`, then `watch.sweepSoon()`) | the sweep: `'hd not allowed'` if only the HD group failed |
| P6 | Server playback (`src=auto`) and every command in it | rec-playback.mjs:243-272, 306-391 and the commands | as recorded (normally main) | unchanged: `playback-server` | a rights refusal becomes `{type:'error', message:'You may not play back this camera from the server\'s recordings.'}` then **1008** `'not allowed'` (was 1011, rec-playback.mjs:258-262); "no index" or "no footage" stays 1011 `'server recordings not available'` |
| P7 | NVR legs in server playback | rec-playback.mjs:271, rec-fallback.mjs:131-276 | NVR main | unchanged: legs only with `playback-nvr` (the session already holds `playback-server`, so `mayHd` is true). rec-fallback passes `{ main: stream === 0, allowMain: () => true }` explicitly | n/a |
| P8 | The H.265 converter-full message | rec-playback.mjs:731 | n/a | says `or choose "SD (NVR)"` only when the viewer may (the session has legs) | text only |
| P9 | Timeline, `/api/playback/recordings`, `/now`, `/dates`, `/motion` | rec-api.mjs:29; server.mjs:912-921, 996-1004 | metadata | unchanged (`/now` and `/dates` keep `canPlayAnyOn`; the page skips them without Playback SD) | as now |
| P10 | Backfill, recorder stream choice | backfill.mjs:786, recorder.mjs:307-330 | server-internal | none (backfill reaches NVR main through rec-fallback with `allowMain` true: it is the server's own copy) | n/a |

### 2.3 Server: pictures, lists and the rights API

| # | Surface | Where | Picture | Check | Refusal |
|---|---|---|---|---|---|
| S1 | Event snapshot `GET /api/events/:id/snapshot` | event-snapshot.mjs:287-308 | still from main, <=1280 wide | gate unchanged: either playback right on the event's camera (:299). A stored picture older than the event's row (`seen_ms`, set once at insert: an earlier event's picture under a reused id, the rule takeSnapshot already uses) is not this event's: 404 whole and as a copy (D4). Then `mayHd(who, nvr, ch)`: the full JPEG; otherwise the **SD copy** `<id>-sd.jpg`, at most 704 wide, made on first request from the stored JPEG through a one-at-a-time ffmpeg queue of its own (never ahead of or behind a new event's picture), stamped with the full one's time and served only while it bears the time of the picture there now (else made again); a copy of a picture taken again or removed while it was made is not kept; a copy that failed is not tried again for `SD_RETRY_MS`, 5 min (D5). The picture, whole or for its copy, is read through one handle whose time must be the one the D4 look saw: one taken again in between is 404 (F3). Never the full bytes as a fallback | a copy that cannot be made: 404 (as for a missing picture). Every 200 is `cache-control: private, no-store` (was `private, max-age=300`: the browser cache handed one user's picture to the next user of the same browser, M3) |
| S2 | Snapshot housekeeping | event-snapshot.mjs:311-360 | n/a | `forgetSnapshots` removes `<id>.jpg` and `<id>-sd.jpg`; `sweepSnapshots` matches `^(\d{1,15})(-sd)?\.jpg$` | n/a |
| X1 | Exports (pack, MP4, stills) | export-api.mjs:21, 32-35; export-job.mjs:320 | as recorded | unchanged (owner: "as now"); the editor says "Exports are always the full-quality recording" | as now |
| C1 | `GET /api/cameras` | server.mjs:871 | metadata | filter unchanged (`live`); each camera gains `hd` (`can(who,'live-hd',…)`) and `playback` (either playback right). Built by `liveCameras(who, list)` in rights.mjs; an admin (`who.admin`) gets every camera with every flag, without a check per camera, as the old route did (D12) | n/a |
| C2 | `GET /api/cameras?for=playback` (new) | server.mjs:871 | metadata | cameras with either playback right, each with `sd` (`playback-nvr`), `hd` (`playback-server`), `nvrHd` (`sd && mayHd`), `legs` (`sd && hd`). Built by `playbackCameras(who, list)`; an admin as in C1 | n/a |
| R1 | `/api/sites` (`sitesFor`) | rights.mjs:384-393 | metadata | `live-hd` left out of the any-grant test | n/a |
| R2 | `canSee` (events, alarms, bookmarks, links, OSD, maps, health) | server.mjs:595 | metadata | unchanged (`live-hd` needs `live`, so it adds no visibility) | n/a |
| R3 | `POST /api/admin/rights` | rights.mjs:445-474 | n/a | before the compare-and-swap: a body whose `rights.grants['live-hd']` is not an array is an editor from before this release; a store read from a newer file (version > 2) is not written (`saveRights` refuses it too) | 409 `{error, outdated: true}` (no `stale` key); 409 `{error, newer: true}` |
| R4 | `readRights` / `migrateRights` / `writeStore` / `forgetRights` | rights.mjs:115-131, 179-196, 207-220, 262-271 | n/a | version 2, the upgrade, the shadow written first, the backup, the audit row; a newer file: an account removed or made again takes out only its own row (section 3) | n/a |
| R5 | `/api/rights/me` | rights.mjs:32, 420, 436-440 | metadata | never reachable (handleRights runs only inside the admin block, server.mjs:652, 688); removed from `ROUTES` and the header. Pages learn rights from C1/C2 | n/a |
| R6 | The rights-change audit detail | rights.mjs:467-473, audit.mjs:21 | n/a | diff first, then the full row (section 6) | n/a |

Surfaces checked and left unchanged (metadata, admin-only, or no picture leaves the server):
`/api/me` (server.mjs:597); admin picture tools and `/api/admin/*` (server.mjs:652-653); camera addresses
(server.mjs:617-623, admin); motion search (`/motion`, JSON hits only; its scan-only SD-to-HD retry,
motion.mjs:236-242, sends no picture); push alerts (alert-send.mjs:63-118, text and a sign-in link, never
the snapshot); bookmarks (bookmarks.mjs:279-292); the map's plan image (maps.mjs:189-218, an
admin-uploaded plan, not a camera picture); health (health-view.mjs:32-54); static files (server.mjs:484-503;
`DATA_DIR` is outside `public`); the NVR's own capture (`snapshots.mjs`, a CLI script, never served); the
four upgradeable sockets are `/live`, `/live-mux`, `/playback` and `/motion` only (server.mjs:1064).

### 2.4 The HD-only switch, fixed (M1, M2)

Today `#watch` (playback.mjs:703-707) switches a `stream=1` session to main when no frame came 4 s after
`openedAt`, and `markHdOnly` (:737) writes the camera into `data/hd-only.json` for good. Two faults
turn a slow open into a false permanent mark: `openedAt` is 0 until the open finishes (:472, :557), so
any 500 ms tick while `SetPlayDataCallBack` waits in the NVR lane switches at once (the wall opens many
tiles together, so this happens with no crafting); and a session paused at open and resumed later
(the wall does both, wall.js:399, 454-457) switches before its first resumed frame.

The fix (new pure module `hd-only.mjs`, used by playback.mjs), landed on its own before any right
depends on it (plan Task 4):
- `SdWait` counts only the time the NVR was really playing the session (started, not paused by the
  viewer, the NVR running), and starts again from zero on every resume while no frame has come. The
  switch is asked only after 4 s of that.
- A camera is marked HD-only only after **main frames actually arrived** after a switch, not at the
  switch.
- An SD frame on a camera clears its mark (a false mark heals itself). That can happen: a viewer who
  may not see main is opened on SD even on a marked camera (D2), and every mark is re-tested (below).
- Each mark carries its time. `hd-only.json` becomes `{ "<nvr>": { "<ch>": markedAtMs } }`; a mark
  older than 7 days is treated as absent, so the camera is tried in SD once more (and marked again
  if it is still HD-only). An older release's array form (`{ "<nvr>": [ch, …] }`) was written by the
  faulty rule, so it is not read: each of those cameras is tried in SD once more. An older release
  reading the new form sees no HD-only cameras and relearns them with its own 4 s rule (harmless).
- A first SD frame later than 4 s of playing still counts as "no SD" for a viewer who may see main
  (today's rule, now counted fairly); such a mark heals as above.

Then the rights (plan Task 5, P4): the switch needs `allowMain()`, asked when the 4 s run out and
again once the SD playback has stopped (D1); a viewer without it waits for SD up to `SD_REFUSE_MS`
(6 s of playing) and is then refused (`noSdAction`, D2) on a camera marked HD only. On an unmarked
camera no frame is no footage there: the session says `{type:'end'}` after 8 s, as it always did for a
gap, until a viewer who may see main plays the camera and marks it (F1).

### 2.5 The access watch (access-watch.mjs)

- **Any-of needs.** An entry in `actions` may be an array meaning "any one of these":
  `['playback-nvr', ['live-hd', 'playback-server']]`. `track` copies nested arrays.
- **Reasons.** A socket whose session is gone closes 1008 `'signed out'` (as now). Otherwise, when every
  failing need is an HD need (`'live-hd'`, or a group containing `'live-hd'`), it closes 1008
  `'hd not allowed'`; else 1008 `'not allowed'`. Live main with Live removed fails `live` too, so it
  says `'not allowed'`.
- **HD taken away while watching:** a live main socket or channel closes `'hd not allowed'` (the page
  falls back to its sub-stream); a running stand-in ends in place through its tracked handle, the sub
  socket or channel stays, and gets wait notices while its sub-stream has no picture (D11); NVR
  playback at main closes `'hd not allowed'`; an NVR session in the middle of its switch to main asks
  again after `StopPlayBack` and is refused (D1); server playback is unaffected (Playback HD is its
  source right). No in-place main-to-sub switch on one socket.

## 3. Migration v1 -> v2 (rights.mjs)

### 3.1 Reading

`readRights` reads `raw.version` (today it is thrown away, rights.mjs:130). A missing or non-integer
version counts as 1. Files are handled as follows:

| On disk | Result | Written back? |
|---|---|---|
| no file | `migrateRights()`: admins `{admin:true}`; viewers `live`, `live-hd`, `playback-nvr` on `'*'`; version 2 | yes (as today, only with accounts), plus the shadow |
| unparseable JSON | nobody has stored rights (deny, logged), as today | never |
| `users` not a plain object | nobody has stored rights, as today | never |
| version 1 (or missing, or not a whole number: `"2"`, `2.5`) with a plain `users` | upgraded (3.2); a row that already carries a `live-hd` key keeps its own list, cut to Live (F2) | yes, once (3.4) |
| version 2 | as stored | no |
| version > 2 | read as far as version 2 understands it (unknown actions dropped in memory), a warning logged and audited once per process | never rewritten: editor saves and `saveRights` refused (R3); an account removed or made again (users-api, adduser.mjs) takes out only its own row from the file as it is (version and unknown rights kept), audited (D8) |

### 3.2 The rule

For every account row in a version 1 file, after `cleanRights`, the first rule that applies:
- when a shadow is there but cannot be used (3.3): `live-hd = []` for every account (an admin keeps
  everything: admin is the role), F2;
- when the row already carries a `live-hd` key (a version 2 file whose version was mangled into a
  string or a fraction, read as version 1): `live-hd = intersect(its own list, live)`, a value that is
  not a list being `[]`, as a version 2 read gives it; never widened by Live or by the shadow, F2;
- when the shadow (3.3) holds this account and the account was not created after the shadow was
  written (`users.json` `since` > shadow `writtenAt`): `live-hd = intersect(shadow live-hd, live)`;
- otherwise: `live-hd = live`, target for target.

(A2 applied per account, ruling D9.) Nothing else is stored differently, but one right is read
differently from now on: NVR HD playback and full-size event pictures need `mayHd`. So a row whose
`playback-nvr` covers a camera that neither its new `live-hd` nor its `playback-server` covers (a
site's cameras are covered only by the site or `'*'`) gets SD there. The upgrade lists such accounts
(admins excepted: they have every right) in its audit row and console line (D6, section 6).

`intersect(a, b)` is the set of targets covering exactly the cameras both lists cover:
`'*' ∩ x = x`; `'n1' ∩ 'n1/3' = 'n1/3'`; `'n1' ∩ 'n1' = 'n1'`; `'n1/3' ∩ 'n1/3' = 'n1/3'`; different NVRs
or cameras give nothing. Playback, export, formats and admin are untouched. The rule depends only on the
file and the shadow, so running it twice gives the same rows (idempotent); a crash half way leaves a
version 1 file that upgrades the same way next time.

### 3.3 The shadow `data/rights.v2.json`

Every version 2 write (`writeStore`: editor save, account add/remove, `migrateRights`, the upgrade
itself) also writes `{ "version": 2, "writtenAt": <ms>, "users": { "<name>": [<live-hd targets>] } }`,
0600, temp file and rename. It must never hold Live HD that rights.json has not got, or a save that
failed half way, then a rollback and a return, would give back HD that was taken away or never given
(D3). So a save with the rows it changes (`before`) writes three times: the shadow with each account's
Live HD cut to `intersect(old, new)`; then rights.json; then the shadow as the new rows. A shadow that
cannot be written refuses the save, before rights.json is touched (the editor gets the error; the
upgrade and `migrateRights` fall back to memory as for any write failure); the last write failing is
logged and leaves the cut shadow, which errs on the side of less. The upgrade and a first file write
the shadow once, before rights.json: a crash between the two repeats them with the same result. An
older release never reads or writes it.

A shadow that is there but cannot be used is not "no shadow", which would give every account Live HD
= Live, back to every account it had been taken from (F2). Unusable: it cannot be read, is not JSON or
not an object, its `users` is not an object, or its `writtenAt` is not a time in the Date range
(±8.64e15 ms) or is before 2026 (the shadow came with this release; an earlier time, 0 or a wrong clock,
would make every account with `since` count as made after it). The upgrade then gives every account
`live-hd: []`, keeps a copy of its bytes as `rights.v2.json.unreadable`, and leaves the file itself in
its place until the new shadow (no Live HD for anyone) is renamed over it: there is never a moment
without a shadow, which a crash, or `adduser.mjs` upgrading at the same moment, would find beside a
version 1 file. If the copy cannot be kept, or the file could not be read at all, nothing is written
and the rights come from memory with Live HD for nobody. An account's entry that is not a list holds no
Live HD (it is still remembered).

Why: an older release that writes rights.json (an editor save, an account added or removed,
`adduser.mjs`) drops `live-hd` and writes version 1. Without the shadow, rolling forward again would
copy Live to Live HD for everyone and silently give back every HD removal made before the rollback.
With it, an account keeps the HD it had (limited to its Live as it is now); an account created under
the older release, which never had Live HD set by anyone, gets Live HD = Live exactly as a first
upgrade does.

### 3.4 Writing back, backup, audit

The upgrade runs inside `readRights` (the pattern `migrateRights` already uses), then:
1. writes the original bytes to `data/rights.v1.json` (0600), replacing an older backup: it is always
   the file this upgrade replaced;
2. `writeStore({ version: 2, users })` (fires the saved hooks: one harmless sweep; the file cache reads
   the new file next time);
3. one console line and one audit row (section 6);
4. if a write fails, the upgraded rights are used in memory (a read-only data folder degrades to "same
   as before"), and the upgrade is tried again on the next read.

`adduser.mjs` and the users API reach `readRights` too; whichever process reads first upgrades.

### 3.5 Rollback behaviour

| Step | Result |
|---|---|
| This release -> older release | the older release ignores `version` and drops `live-hd`: everyone with Live gets HD (the old behaviour; it has no HD gate). Playback SD/HD are exact (same ids). |
| Older release writes | rights.json becomes version 1 without `live-hd`; the shadow stays. |
| Older -> this release again | the version 1 file is upgraded with the shadow (3.2): HD removals made before the rollback survive; a camera given Live under the older release gets HD only if the shadow had HD there. |
| Manual restore | copy `rights.v1.json` back over rights.json (it upgrades again on the next read). |

### 3.6 Editors open across the deploy

Every row's `seen` token changes at deploy (the row gains a key), so without a guard an old editor's
first save would get 409 `stale`, and its "Reopen" (audit.js:464) would then fetch a fresh token and
post a row without `live-hd`, which `cleanRights` would store as `live-hd: []`: that person would lose
HD everywhere. So the POST refuses any body without `grants['live-hd']` as an array, checked before the
compare-and-swap: an old editor's first save gets 409 `{ error: 'This page is from an older version of
Argus: reload it (the access was not saved)', outdated: true }`, never `stale`. The old page shows it as
"Not saved: …" (audit.js:140-145, 464), with no reopen loop.

## 4. Wire protocol changes

### 4.1 `/live` and `/live-mux`

- **Wait notice** (server -> client, text, a JSON object): on `/live` `{"op":"wait","why":W}`; on a mux
  channel `{"op":"wait","id":N,"why":W}` through a new `MuxChannel.notice(obj)` (live-mux.mjs), because
  `MuxChannel.send` drops anything that is not a `Uint8Array` (:173). Sent at once when a viewer
  without Live HD is attached to a sub-stream that has no picture yet, then every 4 s (below the
  client's 8 s watchdog) until the sub-stream's first frame or the socket closes. `W` is `'held'`
  (the worker holds this sub-stream back at the NVR's limit, `nvr.subHeld(ch)`; for the first notice
  only, also the NVR being at its limit, `nvr.subFull()`, since the tile's request is not in the
  worker's list yet), `'starting'`, or `'unavailable'` (15 s after the tile opened and still nothing,
  not held: the NVR has not sent this camera's sub-stream, e.g. value4u cameras 19-29, which therefore
  never read "held" while other tiles fill the limit, D11). On `/live` the notice is sent only where no
  bridge is running: in the no-stand-in branch, or after a stand-in has ended because Live HD was taken
  away (its handle's close starts them; the ended bridge's `send` wrapper passes straight through). Any
  send through a running bridge ends the stand-in (sub-bridge.mjs:69-72). (The review suggested
  `'refused'` "when the worker reports it"; no such report exists, so the timing rule stands in, D14.)
- **Close reason** `'hd not allowed'` (code 1008): main refused at attach, or Live HD removed while a
  main socket or channel was open. On a mux channel it is the usual `end` message.
- **`stream`** on `/live` is parsed strictly (L0).

### 4.2 `/playback`

- `stream` parsed strictly (absent = 1; `'0'`, `'1'`; else 1008 `'bad parameters'`), for NVR and server
  sessions alike.
- An NVR session asked for main without the right: `{type:'error', message}` then 1008
  `'hd not allowed'`, at once. One that gets no SD frame on a camera marked HD only, and whose viewer
  may not see main: the same after 6 s of the NVR playing (D2); on an unmarked camera `{type:'end'}`
  after 8 s without a frame, as for any gap (F1). `{type:'stream', stream:0}` is sent only to a session
  that may see main, asked at that moment (D1); the right gone by the second ask is the same refusal,
  in words about the right.
- Server playback refused for rights: `{type:'error', message}` then 1008 `'not allowed'` (was 1011).
- `nvr.playback.connect(ws, url, { main, allowMain, onMain })` (internal API, playback.mjs) returns
  `{ main }` or `null` (bad parameters; the socket is closing). `allowMain` is a function asked each
  time; server.mjs's reads the session then.

### 4.3 Access watch closes

1008 `'hd not allowed'` joins `'not allowed'` and `'signed out'` (section 2.5).

### 4.4 HTTP

| API | Change |
|---|---|
| `GET /api/cameras` | each camera gains `hd: boolean` and `playback: boolean` |
| `GET /api/cameras?for=playback` | new: cameras with either playback right, each with `sd`, `hd`, `nvrHd`, `legs` |
| `GET /api/admin/rights` | `actions` gains `'live-hd'`; every row's `grants` gains `'live-hd'` |
| `POST /api/admin/rights` | the body must carry `grants['live-hd']` (else 409 `outdated`); refused with 409 `newer` while the file on disk is from a newer release |
| `GET /api/rights/me` | removed (it was never reachable) |
| `GET /api/events/:id/snapshot` | the SD copy for viewers without an HD right; 404 for a picture older than its event, or taken again while it was asked for (F3); `cache-control: private, no-store` |

### 4.5 Internal API names (for the plan)

`streamParam(raw)`, `HD_NOT_ALLOWED`, `HD_ASK_MESSAGE`, `HD_ONLY_MESSAGE` (stream-param.mjs);
`mayHd`, `liveCameras`, `playbackCameras`, `intersectTargets`, `rightsChangeDetail`, `RIGHTS_V1_BACKUP`,
`RIGHTS_SHADOW`, `writeStore(store, before)`, `forgetInNewer` (rights.mjs); `waitForSub` (with `held`,
`full`, `since`), `waitWhy`, `WAIT_NOTICE_MS`, `SD_UNAVAILABLE_MS` (live-wait.mjs); `NVR_MAIN_ACTIONS`
(rec-playback.mjs); `SdWait`, `hdOnlyStore`, `SD_FALLBACK_MS`, `HD_ONLY_RETEST_MS`, `SD_REFUSE_MS`,
`noSdAction` (hd-only.mjs); `sdSnapshot(ev)`, `sdPath`, `sdArgs`, `SD_WIDTH`, `SD_RETRY_MS`
(event-snapshot.mjs).

### 4.6 Pages open across the deploy (A4)

Production has one account, an admin, and admins are never refused HD or sent a wait notice, so no page
open at deploy meets any of the new messages. The protocol is still safe for an old page: nothing new
makes it crash or loop faster than it does today. Two paths do retry, and are accepted as they are
(ruling D10): both are today's own handling (of `'not allowed'`, and of a stalled stream), bounded by
the page's back-off or watchdog, and neither touches a stream:
- a wait notice is a JSON object: an old `/live` tile counts it as activity and drops it
  (`new Uint8Array('{…}')` is empty; digits would not be, which is why it is always an object); an old
  mux page ignores the unknown op (`control()` handles `end` only) and falls back to its 8 s stall
  watchdog, which reopens the channel: today's behaviour for a stalled stream (retry path 1);
- `'hd not allowed'` reaches an old tile as any close: it retries with its back-off capped at 8 s, one
  small message each, refused before any stream is touched — the same as today's `'not allowed'`
  (retry path 2);
- an old editor cannot strip Live HD (3.6); its Rights table shows `live-hd` as a raw column;
- an old playback page reads 1008 `'not allowed'` with its existing message (pb-sources.js:233-237);
  for 1008 `'hd not allowed'` it shows the server's `{type:'error'}` words sent just before the close
  (its close handler adds nothing for a reason it does not know, playback.js:648-650) and does not
  reopen;
- the new `hd`/`playback` fields in `/api/cameras` are ignored by old pages (the grid diff compares
  only `online`, `name`, `remote`).

## 5. Client behaviour per page

- **Live grid (viewer.js, live-tile.js, live-mux.js):** tiles ask for sub, as now. A tile that gets a
  wait notice shows "Waiting for room at the NVR (SD streams)", "Starting…" or "SD stream not available
  from the NVR", and counts the notice as activity, so its stall watchdog does not churn. The first
  frame clears it.
- **Full screen (viewer.js openSingle/upgradeToMain):** upgrades to main only if
  `cam.hd !== false && !cam.remote && !noMain.has(key)`; otherwise it stays on sub and shows an **SD**
  badge beside the name (its title: "Full screen at full quality needs Live HD on this camera"). A main
  layer refused `'hd not allowed'` before its first frame is dropped (the sub stays); after it (the sub
  already closed), the tile falls back to the sub-stream in place, once, with "(SD: full quality needs
  Live HD)" appended to the name — never a retry loop. When a camera's `hd` flips in `/api/cameras`, the full-size view is rebuilt. The **Recordings**
  link shows only when `cam.playback !== false`.
- **Phone (list and full screen):** the same rules; the server never makes the stand-in conversion for
  a viewer without Live HD.
- **Map popup (map.js:842), motion tuning (motion-tune.js:62):** sub only; the wait notice applies.
- **Camera wall (wall.js):** the camera list is `/api/cameras?for=playback`. Each tile plays from what
  its camera's rights allow: a camera with Playback HD only always uses the server's recordings (an
  error on the tile when the server has none); one with Playback SD only always uses the NVR's
  sub-stream; with both, the wall's Quality choice decides. The Quality menu offers only choices that
  some chosen camera allows (HD first when no chosen camera has SD). A tile refused 1008 shows the
  reason and stops asking (1008 is final).
- **Playback page (playback.js, pb-sources.js):** the camera list is `/api/cameras?for=playback`, and
  each camera's `sd`/`hd`/`nvrHd` shape the page: no "HD" in NVR mode without `nvrHd` (the socket asks
  `stream=1`); no "SD (NVR)" in the server menu without `sd`; without `sd` no NVR mode at all (a day
  with no server footage says so), no NVR-side loads (`/now`, `/dates`, `/recordings`), no NAS-outage
  fallback to the NVR and no motion search. `{type:'stream'}` no longer changes the viewer's own choice,
  so a camera marked HD-only does not make later cameras ask for main (the Quality menu shows "HD" while
  that camera plays on main, and goes back to what the next socket asks for when it opens). 1008
  `'hd not allowed'` shows "Playing this from the NVR needs its HD stream here, which needs Playback HD or
  Live HD on this camera. An admin can give you either." and stops: one text for both refusals (main
  asked for without the right, after a rights change inside the 30 s list refresh; and no SD recording),
  since the server's own `{type:'error'}` words and the close can reach the page in either order (D13).
- **Alarms page (alarms.js):** unchanged; the server picks the full or SD picture.
- **Sign-in page (login.js):** clears the browser's `argus-stills` cache (stills.js keeps 480-wide
  stills per camera, not per user) so the next user of the browser starts clean.
- **Access editor (audit.js, access-model.js, audit.html, style.css):** five tick columns in the owner's
  order — Live, Live HD, Playback SD, Playback HD, Export — under a two-row header built from the model
  ("Live: Grid | HD", "Playback: SD | HD", "Export"), the full names in each box's `aria-label` and
  `title`. Ticking Live HD also ticks Live on that target; unticking Live also unticks Live HD; unticking
  Live HD leaves Live. A Live HD tick where Live is off (only from stored data) is noted "no effect
  without Live" with a warning. At 560 px and below the tick columns are 44 px, the dialog is
  `calc(100vw - 16px)` wide with 10 px padding, and the per-box notes move into the row header. The
  Rights table uses the labels (Live, Live HD, Playback SD, Playback HD, Export) and becomes one card
  per user on phones. Help text (Task 12) says what each tick means, that Live is the camera's
  sub-stream as the NVR is set, that event pictures need either playback right and are full size only
  with Live HD or Playback HD (D7), that exports are always full quality, and that Live HD limits what
  Argus shows, not what the network allows.

## 6. Audit entries

- **Migration** (once per upgrade): `{ user: 'system', action: 'rights-change', target: '*', detail:
  'rights.json upgraded from version 1 to 2: Live HD given wherever Live was granted for N account(s)
  (a, b); Live HD restored from rights.v2.json (written <ISO>) for M account(s) (c); K account(s) (d)
  have Playback SD on cameras without Live HD or Playback HD: there the NVR's recordings and event
  pictures are now SD only; the stored playback, export and admin rights are unchanged; the old file is
  kept as rights.v1.json' }` (each clause only when it has names; D6). Two more clauses (F2): first of
  all, for a shadow that cannot be used, `rights.v2.json could not be used (<why>) and a copy of it is
  kept as rights.v2.json.unreadable, so Live HD was given to nobody; re-grant it in the access editor
  (Users & audit, Edit access) to whoever should have it: N account(s) with Live have none now (a, b)`
  (or `no account but an admin has Live`), logged as a warning; and `Live HD kept as the file had it
  (cut to Live) for N account(s) (…)`, with `(the file said version "2")` after `version 1` when the
  file's own version field was there but not a whole number. In the audit row the names are cut to 8
  then "and K more" (the 500-character cap cuts names, never a clause's instruction); the console line
  is the same text with every name.
  A newer file: `'rights.json is version V, newer than this release (2): read as far as version 2
  understands it; editor saves refused, and an account removed or made again takes out only its own
  row'`, once per process; and for each such removal `{ user: 'system', action: 'rights-change',
  target: <name>, detail: 'rights.json (version V, from a newer release): the row of <name> removed with
  the account; the rest kept as it was' }` (D8).
- **Rights change** (every editor save): diff first, so the 500-character cap (audit.mjs:21) cuts the
  summary, never the change: `<roleNote><added live-hd: n1; removed live-hd: n1/3; added formats: mp4 |
  no changes> | now: live=… live-hd=… playback-server=… playback-nvr=… export=… formats=…`. The role
  note (`admin; `, `made admin; `, `admin removed; `) stays first; action keys stay machine keys.
- **NVR playback** (per session, as now): the detail says `nvr sub playback from <ISO>` or `nvr main
  playback from <ISO>`; a switch adds `nvr main (switched: no SD recording) playback from <ISO>`. No
  per-socket audit of live HD (a console line is enough).

## 7. Out of scope

- The outage-buffer Pause/Resume switch (dropped) and any live-stutter fix (A3).
- `events.mjs` and its test (A1).
- An SD-size conversion stand-in for Live-only viewers; a downscaled conversion of HD-only NVR cameras
  for SD-only viewers (both cost a conversion slot per viewer; later, if the owner asks).
- Export changes: exports stay "as now" (full quality; stills not scaled). The playback page's export
  and bookmark dialogs still list `/api/cameras` (live) cameras (a side finding, not a stream right).
- Access outside Argus: anyone with LAN reach and the NVR's or cameras' own credentials can pull main
  directly. Argus does not help (addresses are admin-only), but cannot prevent it.
- `user-add`/`user-change`/`user-remove`/`server-restart`/`machine-reboot` audit rows stored as
  `'other'`, and `'live-view'` never written (existing, unrelated).
- Timeline thumbnails (not built); if built, they follow the still rule (S1).

## 8. Notes for the owner (to say with the release)

1. Nothing changes for anyone's live view today: everyone with Live gets Live HD. The one narrowing: an
   account whose Playback SD covers cameras its Live does not now plays the NVR's recordings and sees
   event pictures there in SD (HD there needs Live HD or Playback HD). The upgrade's audit row names
   such accounts; on production (one admin) there are none.
2. A viewer given Live without Live HD sees nothing on a camera whose sub-stream is not running until it
   starts. On value4u, cameras 19-29 (the NVR refuses their sub-streams) and tiles beyond its 15
   sub-stream limit show "SD stream not available" or "Waiting for room" to such a viewer. Fixes: give
   those cameras Live HD, or correct the NVR's sub-stream settings (Sites > Sub-streams).
3. Live follows the stream, not a resolution: a camera whose sub-stream is set high shows that under Live.
4. Playback HD is Argus's copy, which is near live (the file being written plays) and is only SD for a
   camera recorded on its sub-stream.
5. Export is always the full-quality recording, whatever else is ticked.
6. Live HD limits what Argus shows, not what the network allows (section 7).
7. Cameras falsely marked "HD only" on the NVR (a slow NVR, the wall opening paused) are no longer
   marked that way; old marks are tried in SD again at once, a viewer without HD on a marked camera is
   still tried in SD (an SD picture clears the mark), and every mark is re-tested weekly. A viewer who
   may not see main is told after 6 s of trying that a camera marked HD only has no SD recording; on
   a camera not marked, no picture from the NVR is read as no footage there (the page moves on), until
   someone who may see main plays that camera and it is marked.
8. Event pictures (Alarms) follow their own rule, as today: either playback right shows them, at full
   size only with Live HD or Playback HD, otherwise a smaller copy (up to 704 wide).
9. A rights.json written by a newer release after a rollback is never rewritten by this one: access
   edits are refused until that release is back, and adding or removing an account only removes that
   account's row.

## 9. Test strategy

Plain-node tests printing PASS/FAIL, run from the repo root. Windows runs everything that does not load
the native SDK (koffi) or ffmpeg; the rest runs on the private server copy (plan, Appendix A).

- **Pure and route tests (Windows):** `rights.test.mjs` (actions, the AND rule, `canAny`, `sitesFor`,
  `mayHd`, the v1->v2 upgrade with and without shadow, idempotence, missing version, unreadable and
  nonsense files not written, the audit row naming Playback SD beyond Live, version 3: read-only for the
  editor and `saveRights`, an account's removal takes out its row only; the shadow written first: a
  shadow that cannot be written refuses the save, and a failed rights.json write leaves the shadow cut
  to old ∩ new; `intersectTargets`, the outdated and newer 409s, the diff-first detail,
  `/api/rights/me` gone, `liveCameras`/`playbackCameras` and the admin short cut, source pins on
  server.mjs); `access-model.test.mjs` (a stored Live HD list survives the three-column editor, then the
  five columns); `access-watch.test.mjs` (any-of groups, the three reasons, HD removed closes main but
  not sub, ends a running stand-in on a socket and on a mux channel, both keep their sub-stream and get
  wait notices from then on; pins: `/playback`'s `allowedMain` from the session, `onMain` re-tracks and
  sweeps); `live-mux-server.test.mjs` (L0-L5 through `attachLive`: main refused before tracking, a raw
  `"stream":-0` on a channel refused as main, no `getStream(ch,0)` without HD, no phone stand-in, remote
  gets no raw main, tracked actions, wait notices on `/live` and on a mux channel, "held" at first only
  when the NVR is full); `live-wait.test.mjs` (held/full, since); `stream-param.test.mjs` (every string
  that used to parse as main); `rec-playback.test.mjs` (the parse cases, SD-only refused main, SD+Live
  HD and SD+Playback HD allowed, `{main, allowMain, onMain}` handed to the NVR, `allowMain` asked anew
  each call, tracking actions, server refusal 1008 vs 1011, audit details); `hd-only.test.mjs`
  (`SdWait` counts running time only and restarts on resume; the store's expiry, old arrays not
  trusted, mark/unmark; `noSdAction` and `SD_REFUSE_MS`; source pins over playback.mjs: the running
  count, the unmark on an SD frame, no mark at the switch, the gate in `#watch`, the second ask after
  `StopPlayBack`, a marked camera tried in SD without the right, no `stream` read from the URL);
  `event-snapshot.test.mjs` (full vs SD by right, the SD copy's ffmpeg arguments and input, 404 and
  never full on failure, a failed copy not retried at once, a picture older than its event refused whole
  and as a copy, the SD queue apart, cached SD reused and remade when stale, `no-store`, sweep and forget
  remove `-sd`); client tests `live-tile.test.mjs`, `live-mux-client.test.mjs`, `grid-diff.test.mjs`,
  `pb-sources.test.mjs`, `audit.test.mjs`.
- **Server copy (koffi / ffmpeg):** `playback-busy.test.mjs` and `playback-search.test.mjs` (updated
  `connect` calls), `playback-hd-switch.test.mjs` (new; first without rights, then with them: a
  `SetPlayDataCallBack` stalled past 500 ms does not switch; a session paused at open and resumed
  switches only after 4 s of running; without `allowMain` the session is refused 1008 `'hd not allowed'`
  after 6 s of playing on a marked camera, and says `{type:'end'}` after 8 s on an unmarked one; with it
  the client gets `{type:'stream'}` and `onMain` runs, `allowMain` asked twice; a right gone during
  `StopPlayBack` ends in a refusal with no `{type:'stream'}`; a marked camera opens on main only with
  `allowMain`, and on SD without it; no HD-only mark is written before main frames);
  `event-snapshot-ffmpeg.test.mjs` (the SD copy really is at most 704 wide);
  `transcode-ffmpeg.test.mjs`, `playback-dates.test.mjs`, `rec-timeline.test.mjs`,
  `rec-fallback.test.mjs` (real PlaybackSession part), `users-api.test.mjs`; then the whole suite.
- **Known environmental failures:** on Windows, `rec-fallback.test.mjs` "16x during a leg" (2 checks, a
  known test bug fixed on branch `rec-fallback-16x-flake`, not merged) and `rec-timeline.test.mjs`
  "load ../playback.mjs" (koffi); on the server copy `sps.test.mjs` and `substreams.test.mjs` (`/work`
  fixtures absent). Nothing else may fail.
- **Manual (after deploy, by the owner or with his OK):** an admin's full screen still upgrades to main;
  a test viewer with Live only: grid on sub, full screen stays SD with the badge, `stream=0` in a crafted
  URL is refused; Playback SD only: NVR SD plays, "HD" not offered, a crafted `stream=0` refused.

## 10. Files

New: `cctv/stream-param.mjs`, `cctv/live-wait.mjs`, `cctv/hd-only.mjs`, tests `stream-param.test.mjs`,
`live-wait.test.mjs`, `hd-only.test.mjs`, `playback-hd-switch.test.mjs`.
Changed (server): `rights.mjs`, `access-watch.mjs`, `live-attach.mjs`, `live-mux.mjs` (`notice` and the
protocol comment only), `sub-bridge.mjs` (one log line), `server.mjs` (`/api/cameras`, `/live` parse,
`/playback`: may-see-main from the session, tracking, a sweep on the switch), `rec-playback.mjs`,
`playback.mjs`, `rec-fallback.mjs` (one call), `event-snapshot.mjs`.
Changed (client): `live-tile.js`, `live-mux.js`, `viewer.js`, `grid-diff.js`, `login.js`, `pb-sources.js`,
`playback.js`, `wall.js`, `access-model.js`, `audit.js`, `audit.html`, `style.css`.
Changed (tests' own calls): `playback-busy.test.mjs`, `playback-search.test.mjs` (`connect` with its
decision).
Docs: `CHANGELOG.md`. Not touched: `events.mjs`, `events.test.mjs`, `public/playout.js`, `users-api.mjs`,
`adduser.mjs` (their `forgetRights` calls get the newer-file behaviour from rights.mjs).
