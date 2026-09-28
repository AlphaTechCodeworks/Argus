# Line crossing drawn in Argus — design

Date: 2026-09-27. Owner: Mike. Status: approved in chat ("yes", 2026-09-27).

## Goal

An admin draws line-crossing ("tripwire") lines on a camera's live picture in Argus. Argus writes
them into the **camera's own** line-crossing detection through the NVR; the camera's AI does the
detecting. A crossing then shows up in Argus within seconds as an event, sends a phone alert, keeps
the footage around it, and carries a snapshot.

Owner decisions (chat, 2026-09-27):
- Draw lines in the app; the camera detects (not server-side video analysis).
- On a crossing: event on the timeline/Alarms page, phone alert within seconds, footage kept,
  snapshot of what crossed.
- Phone alerts: ntfy now; browser (Web Push) notifications in a later phase.
- First live test: nvr-2 camera 3 "Maingate Roadway" (IP619E5W-28-S4, no person/vehicle filter).

Not in this phase: intrusion zones (queryPerimeter/editPerimeter, same camera feature with polygons),
Web Push, server-side detection, person/vehicle class read from the NVR.

## Verified facts (read-only research, 2026-09-27)

Sources: nvr-2's own web client (static files, `tripwireAlarmCfg.js`, `smartEvent.js`,
`canvas.passline.js`) and 9 read-only queries against nvr-2 through the app's `transparent()`
(answers saved as test fixtures, see Testing).

- **Capability:** `queryNodeList` with `<requireField><supportTripwire/>…</requireField>` gives
  `supportTripwire` per channel. All 25 configured nvr-2 cameras say `true`, including IP619E5W-28-S4
  and IP679E5W-Z. `querySystemCaps` `localTargetDectMaxCount=0`: the NVR cannot detect on a camera's
  behalf, so only `supportTripwire` cameras get lines. Other NVRs: decided per channel by the same
  query, never by model.
- **Read:** `queryTripwire`, request `<condition><chlId>{…}</chlId></condition><requireField><param/><trigger/></requireField>`.
  Answer `content>chl@id,@scheduleGuid` with `param` and `trigger` (shapes below).
- **Write:** `editTripwire` (seen only in the web client; never sent yet). The web client builds
  the whole block every time (`getSaveData`, tripwireAlarmCfg.js ≈35310):
  `<content><chl id scheduleGuid><param>switch, alarmHoldTime unit="s", [sensitivity],
  [objectFilter car/person/[motor] {switch, sensitivity, [min/maxDetectTarget]}], [autoTrack],
  line list {direction, startPoint X/Y, endPoint X/Y}, [triggerAudio if true], [triggerWhiteLight if true],
  [saveTargetPicture, saveSourcePicture]</param><trigger>sysRec chls, alarmOut alarmOuts, preset presets,
  snapSwitch, msgPushSwitch, buzzerSwitch, popVideoSwitch, emailSwitch, sysAudio@id</trigger></chl></content>`.
- **Lines:** exactly 4 slots per camera (`<line type="list" count="4">`); a slot is unset when all
  four coordinates are 0. Coordinates 0–10000 relative to the picture, origin top-left, Y down.
  Direction per line: `none` (A↔B), `rightortop` (A→B), `leftorbotton` (A←B; firmware spelling).
  A is on the left of the start→end vector as drawn on screen (web client; to be confirmed by the
  test walk). AI models carry an extra `<sensitivity min="0" max="0">0</sensitivity>` per line.
- **Filter by model:** IP6196W: car/person/motor each with switch, sensitivity 1–100 and
  min/maxDetectTarget; CAM-IP6196G: car/person/motor with switch + sensitivity; IP619E5W: none
  (anything crossing counts). The UI is built from what the answer contains.
- **Other settings:** `param>switch` (off on every camera read); `alarmHoldTime` from `holdTimeNote`
  "3,5,10,20,30,60,120" (answer spells the unit attribute `uint`, the web client sends `unit`);
  schedule = `chl@scheduleGuid` from `queryScheduleList` (nvr-2: 24x7, 24x5, 24x2); `triggerAudio`,
  `triggerWhiteLight` (false everywhere); `mutexList` of detections that cannot run together.
- **Trigger block today (all three read):** sysRec on with the camera's own channel, msgPushSwitch on,
  everything else off, sysAudio null GUID.
- **Live alarms:** `queryAlarmStatus` (≈0.1 s, whole NVR in one call) lists currently active alarms:
  `content>intelligents>item` with `intelligentType` (enum includes `tripwire`), `sourceChl@id`,
  `alarmTime` (UTC, "YYYY-MM-DD HH:MM:SS"); motions are listed the same way under `motions`.
- **Today's event lag** (seen − start, motion, 7 days): median 101 s (nvr1) to 1,218 s (value4u);
  the recording-list intake (events.mjs) polls one camera per 5 s tick. Record bits 0x80 and 0x400
  already map to "line crossed" / "tripwire" (event-rules.mjs:73, :76). 0 such events, 0 alarm rules.
- **Notifications:** ntfy and webhooks work; email is a stub. The ntfy topic is empty today.

## Design

### 1. Camera line settings — `cctv/tripwire.mjs` (server)

Follows the existing safe-change pattern (imaging.mjs / streams.mjs / motion-tune.mjs):

- `GET /api/admin/nvrs/:id/channels/:ch/lines` → `{ lines }`: support (cached `queryNodeList`,
  refreshed at most every 10 min), the parsed config (enabled, 4 slots, directions, filter shape and
  values, hold time + choices, schedule + choices from `queryScheduleList`, mutex list, extras),
  the device token, and the last undoable change.
- `POST …/lines` `{ device, seen, change, ack, ackToken, confirm: true }` and
  `{ device, undo: true, seq, ack, ackToken, confirm: true }`.
- Inside the `/api/admin` block of server.mjs (same-origin + JSON checks), admins only.
- Flow: `withNvrLock` → fresh `queryTripwire` → stale check against `seen` (409 if the camera
  changed) → warnings that need acknowledging (ackToken bound to the exact change):
  - turning it on while a `mutexList` detection is on (that detection may switch off);
  - a camera with no person/vehicle filter (anything crossing counts: water, vessels, shadows);
  - a hold time under 10 s (a crossing could fall between two alarm checks);
  - a line shorter than 5 % of the picture, or start = end (refused, not warned).
- Build the body exactly as the web client does (element order and names above), every value taken
  from the fresh read except what the admin changed. `triggerAudio` and `triggerWhiteLight` are never
  sent (the web client leaves them out when false), and a change is refused if the fresh read shows
  either one true — the floodlight and sirens are worked by hand only. Coordinates are integers
  0–10000.
- Write-ahead log line (full before-state) to `DATA_DIR/tripwire-changes.log` before sending; send;
  read back at 1.5 / 3 / 6 s; compare **every** field of the answer, including those the web client
  does not send (sysSnap, popMsgSwitch, manualAudio/LightSwitch, per-line sensitivity): each changed
  field gets "as asked" / "not applied", each unasked difference is listed as a side effect; a result
  line goes to the log.
- Undo: only the newest change, only while the camera still shows what it left (as imaging.mjs).
- Enabled cameras are remembered in `DATA_DIR/lines-on.json` (`{ "<nvr>/<ch>": true }`), updated
  from every read and write; the alarm watcher uses it.

### 2. Drawing — `cctv/public/lines-panel.js` (browser)

- A **Lines** button beside **Picture** in the full-size Live view, for admins, shown only when the
  camera reports support (from the GET).
- An overlay canvas over the letterboxed live picture, using colour-check-ui.js's tested maths
  (`pictureRect`, `clientToPicture`, `pictureToOverlay`). Pinch-zoom is paused while drawing.
- Four numbered line slots: draw by drag, move either end by dragging, a magnifier while dragging,
  clear a slot. Each line shows its A and B sides and an arrow at the midpoint; tapping the arrow
  cycles A→B, B→A, both.
- Settings beside it: on/off, person/car/bike switches and sensitivity (only those the camera has),
  hold time (the camera's choices), schedule (the NVR's list; never edited here).
- Save → the same confirm/acknowledge dialog as the Picture panel → result per field → the camera's
  stored lines are redrawn from the read-back. Undo last change.
- An "Alert my phone for this camera" switch (default on) that adds/removes the camera in the
  "Line crossing" alarm rule (section 5).

### 3. Crossings within seconds — `cctv/alarm-watch.mjs` (server)

- Every 5 s, for each NVR that has at least one camera in `lines-on.json` and is online: one
  `queryAlarmStatus` (a read through `transparent()`: the XML lane, the read breaker and the busy
  refusals all apply; a refusal skips that tick).
- Each `intelligents` item with `intelligentType` `tripwire` becomes an event:
  `{ nvr, ch, type: 'line-crossing', subtype: 'tripwire', startMs: alarmTime (UTC), source: 'alarm-status' }`
  through `addEvent` (the unique key nvr/ch/type/subtype/start dedups repeated sightings of the same
  active alarm; later sightings extend its end), then the alarm notifier.
- The existing recording-list intake keeps running; a line-crossing file it finds whose start lies
  within 30 s of an existing line-crossing event of that camera extends that event instead of adding
  a second one.

### 4. Event kind

- New kind `line-crossing` ("Line crossing", confirmed) in public/alarms-view.js `EVENT_KINDS`.
- Record bits 0x0080 and 0x0400 map to `line-crossing` (subtypes "line crossed", "tripwire")
  instead of `ai`. (No stored `ai` events or rules exist, so nothing to migrate.)
- Alarm rules can then select it like any other type.

### 5. What a crossing does

- **Event** on the timeline and Alarms page (existing).
- **Phone alert** (ntfy): an alarm rule "Line crossing" (type `line-crossing`, notify on,
  priority high, quiet gap 30 s per camera) whose cameras are those switched on in the Lines panel.
  The message: camera name, local time, and a link to the event in Argus (a `publicUrl` setting,
  default https://cctv.jfl.gripe). No picture is uploaded to ntfy (site images stay on the server).
  The ntfy topic: a random private name generated and saved in settings when the first camera is
  switched on, shown in the Lines panel with how to subscribe in the ntfy app.
- **Footage kept:** each new line-crossing event creates a bookmark from 30 s before to 60 s after
  (alarms.mjs `bookmarkAlarm`, user "system"); a crossing whose window overlaps the camera's previous
  automatic bookmark extends it instead of adding another. Bookmarked stretches are never thinned.
- **Snapshot:** `cctv/event-snapshot.mjs` waits (up to 3 min) until Argus's own recording covers
  the event start + 1 s, reads the keyframe at or after it (rec-reader.mjs), and has ffmpeg turn it
  into a JPEG (≤1280 wide) at `DATA_DIR/event-snaps/<eventId>.jpg`, removed with the event.
  `GET /api/events/:id/snapshot` needs the playback right for that camera. Shown on the Alarms page
  and at the alert's link. Works on every camera type (it does not depend on the camera's own
  target picture).

### 6. Phase 2 (separate spec later)

Browser (Web Push) notifications; optionally the camera's own target picture and person/vehicle
class via `searchSmartTarget`; intrusion zones.

## Safety

- Only admins change camera settings; every write is confirmed, logged before sending, read back
  and undoable. Nothing else in the camera's detection or linkage is changed on purpose, and any
  difference found on read-back is shown.
- The camera's audio/white-light triggers and NVR relay outputs are never switched on (floodlight by
  hand only).
- The alarm watcher is read-only and costs one small query per NVR per 5 s, only on NVRs with lines.
- First live write: Maingate Roadway only, read back field by field, then one test walk.

## Testing

- Fixtures: the captured answers `queryTripwire` ch 1/3/4, `queryNodeList`, `queryScheduleList`,
  `queryAlarmStatus` (copied to `cctv/test/fixtures/lines/`).
- Pure tests: parse each fixture; build the edit body for each model (element order as the web
  client, values echoed, changed fields only); refusals (audio/white light on, zero-length line);
  warnings; read-back comparison (as asked / not applied / side effects); coordinate conversion and
  the A/B side + direction maths; alarm-status parsing (tripwire items, UTC times, channel ids);
  dedup/merge with the recording-list intake; the new event kind and rule matching; bookmark
  merging; the snapshot pipeline with a small recorded sample (server test run).
- Live: one write to Maingate Roadway, full read-back, a test walk across the line → event within
  seconds, ntfy alert, bookmark, snapshot.
