# Playback from server recordings (phase 3: fast playback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development where subagents are allowed) to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins play back cameras from the server's own recordings over the existing `/playback` WebSocket and browser player. The first picture appears in under 0.5 s. Dragging the playhead shows keyframes. 2× and 4× send every frame; 8× to 32× and reverse send keyframes only. The timeline for a day comes from the database in one request. The NVR is used only for stretches the server lacks, and those show in another colour. When the setting is on, recent minutes are served from RAM. With the flag off, with no recordings, or for non-admins, everything behaves exactly as it does today.

**Architecture:** Playback runs in the main process and reads the segment files directly. The workers are not involved, except for a new message that announces the segment file currently being written. `rec-reader.mjs` turns a segment back into frames. It splits the Annex B bytes into access units, marks keyframes from the `.idx` offsets and gives each frame a time. Those times come from the `.idx` keyframe times, smoothed, with the frames spaced evenly between keyframes. `rec-index.mjs` gains the lookups playback needs (at, next, prev, first, and a merged day timeline) and an in-memory entry for each open segment. `rec-playback.mjs` decides per socket whether playback comes from the server or the NVR. For server playback it runs a `ServerPlayback` session. That session paces frames on the server as `playback.mjs` does. It bursts the frames from the keyframe up to the requested time, then plays at 1×, 2× or 4× with all frames, or at 8× to 32× and in reverse with keyframes only. It seeks and scrubs on the open socket using generation numbers. It follows the open segment up to the newest frame. For stretches the server lacks, `rec-fallback.mjs` runs the existing NVR `PlaybackSession` through a proxy WebSocket as an "NVR leg". The leg converts the NVR's clock to the server's, and the browser still sees one stream. The page asks `/api/playback/timeline` for server ranges. It still asks the NVR's `/api/playback/recordings` in the background for events and for stretches only the NVR has. It draws the two sources in different colours. "Recent footage in RAM" is met by the OS file cache (ZFS ARC on the R540): each segment is read once as soon as it closes, which keeps it cached. The Settings page shows how much RAM each choice needs.

**Tech Stack:** Node 24 ESM, `fs/promises` reads (no new dependency), `node:sqlite` (rec-index), `ws`, WebCodecs in the browser (existing `player.js`/`playout.js`), plain `node` tests in `cctv/test`.

**Spec:** `docs/superpowers/specs/2026-09-24-server-recording-design.md`, sections Goal, Architecture, Playback, Access.

## Rulings (decisions this plan makes)
- **R1. Time base.** Server footage is stamped with the server's clock: the recorder stamps each frame with the time it arrived at the worker. The NVR stamps footage with its own clock, and nvr1 runs about 3 min 40 s fast. `clock()` in `playback.mjs` gains `skewMs` (NVR clock minus server clock, set to 0 when under 2 s, because DD_TIME has 1 s resolution). In server mode the page and the socket work only in server time, and NVR ranges and NVR-leg frames are converted by `-skewMs`. When |skew| > 5 s the page shows a hint that the time printed on the picture differs by that much.
- **R2. No change to the recording format.** The spec fixes the `.idx` format ([offset, tsMs] per keyframe), and recordings already exist in it. Frame boundaries come from Annex B parsing. The rule for where a new access unit starts is below; keyframes are the units whose start offset is an `.idx` offset. Frame times are interpolated between keyframe times. The keyframe times are arrival times and jitter by up to 0.45 s because the NVR sends in bursts. So they are first smoothed with a line fit per run of the file's `.idx`, which keeps 2×/4× playback from speeding up and slowing down from one GOP to the next. A per-frame time index was rejected: it would change phase 2's writer while phase 2 is being built, and existing files would have none.
- **R3. "Recent footage in RAM" = OS file cache (page cache / ZFS ARC), warmed on close; no in-process ring.**
  - The option rejected: an in-process ring.
    - In the main process, it would need every recorded frame sent over IPC from the workers: about 187 Mbit/s at full scale, all the time, even when nobody watches.
    - In a worker, it would need a second, request-driven frame path over IPC, and a worker restart would lose it.
    - Either way it duplicates what the kernel already caches, and it counts against the Node heap and RSS (10 min × 56 cameras ≈ 14 GB).
  - What is built instead:
    1. Playback can read the segment that is still being written (R4). That covers the newest minute, which is the one the index does not yet list.
    2. With `memory.recentMinutes > 0`, each finished segment is read once as soon as it is reported. The data is still in cache at that point, so the read never touches the disk and costs a memcpy of about 23 MB/s at full scale. The second access promotes the pages: to the active list in the Linux page cache, and from MRU to MFU in the ZFS ARC. Promoted pages outlive streaming reads of old footage, such as exports and other playbacks.
  - The Settings page shows the RAM each choice needs. It is calculated from the recording cameras' real bytes per minute, next to the server's available memory.
  - Setting 0 turns the warming off; the kernel still caches as it likes.
- **R4. The open segment is playable.** When a writer opens a file, the worker sends a new message `{t:'segopen'}`. The parent keeps these entries in memory only; they are not written to the database. The reader follows the growing file and holds back the last, possibly incomplete, frame.
- **R5. Timeline.**
  - One database request per day: `GET /api/playback/timeline?nvr&ch&from&to`. It gives server ranges, recorder gaps, codec, `now`, `tzOffsetMs` and `skewMs`, and never calls the NVR.
  - The page still requests the NVR's `/api/playback/recordings` in the background. It needs it for events (which the NVR supplies until events move to the database in a later plan) and for stretches only the NVR has. The page never waits for it. If the NVR is busy or offline, the page works from the server timeline alone.
- **R6. Mode per day.** Server mode is used when all of these hold:
  - the timeline is `available`;
  - that day has server footage;
  - the browser can decode the recording's codec;
  - the viewer has not chosen "SD (NVR)".

  Otherwise the page runs today's path exactly: same URLs, no `src` parameter, same speeds. H.265 server footage on a PC that cannot decode H.265 (such as this i7-3770) therefore falls back to the NVR's SD playback, with a message.
- **R7. NVR fallback inside the one socket.**
  - The server session runs NVR legs itself, through a proxy WebSocket around the existing `nvr.playback.connect`, so the browser gets one stream in server time.
  - Gaps under 3 s play straight through (the pacer re-anchors, as today). Gaps of 3 to 30 s are jumped. Gaps of 30 s or more play from the NVR when its coverage (a cached search) has them; otherwise they are jumped.
  - Legs run forward only and at most 8×, which is what the NVR session accepts. Reverse and scrubbing use server footage only.
- **R8. Seek and scrub on the open socket.** The client sends `{seek:T, gen}` and `{scrub:T, gen}` instead of opening a new socket, which saves the TLS and WebSocket handshake. Frames belong to the newest `gen` announced by `started` or `scrub`. The browser drops anything older.
- **R9. Speeds.**
  - Server mode offers −32, −16, −8, −4, −2, −1, 1, 2, 4, 8, 16 and 32.
  - Speeds of 1 to 4 send all frames. Speeds of 8 or more, and all reverse speeds, send keyframes only, at most 8 keyframes per second of wall time. Keyframes are skipped evenly to stay under that limit, which bounds bandwidth and decode load.
  - Reverse and scrubbing put the player in "stills" mode, which shows each frame as soon as it is decoded. The server paces reverse.
  - At speeds above 1×, reaching the newest frame drops the speed to 1× and follows the growing file.
- **R10. Scrubbing = dragging the playhead.** Pressing within 8 px of the playhead, or on its triangle, scrubs. Dragging anywhere else on the track still pans, as today. Releasing plays from there.
- **R11. The 0.5 s start budget.**
  - Server side, from the socket opening or a seek to the first frame sent: under 150 ms from cached files (tested).
  - The frames from the keyframe up to T go out at once. The browser decodes them but does not show them; the decoded keyframe is drawn at once as a poster.
  - Across seeks the decoder stays configured (`decoder.reset()` + `configure(sameConfig)`, with no `isConfigSupported` round trip).
  - While frames are being skipped, the player's decode-queue limit rises so the burst is not dropped.
  - The page's D overlay shows the measured start time.
- **R12. Synced multi-camera playback is not built.** The current playback page has one camera and one canvas. The protocol supports it later: everything is in server time, and every socket takes `{seek, gen}`, `{speed}` and `{pause}`, so one master clock can drive N sockets.
- **R13. Access.** `canPlayServer(who, nvrId, ch)` returns true only when `who.admin` (which includes `CCTV_AUTH=off`). Non-admins keep today's NVR playback unchanged. This hook is the only place per-user rights will change later.
- **R14. Server playback works while the NVR is offline.** The WebSocket's "NVR offline" refusal stays for NVR sessions only.
- **R15. No silent change of time base.** If a `src=auto` socket turns out not to be eligible (a race), the server sends `{type:'error'}` and closes it. It does not silently start an NVR session in NVR time.
- **R16. Deletion during playback.** Housekeeping may delete a file that is playing. There is no locking: an open handle keeps reading, and a file that no longer opens (ENOENT) is skipped to the next segment.
- **R17. Server footage is the main stream (HD) only**, because the recorder records only that. SD is an NVR-only choice.

## Global Constraints
- **No transcoding.** Frames go out exactly as stored, and playback opens recordings read-only (`'r'`). Header width and height are 0 for server footage; the browser takes the size from the SPS.
- **No NVR contact from tests.** Tests use fake `nvr.playback` objects (`connect`, `recordings`, `clock`), the fake SDK where needed, `*.invalid` hosts and temporary directories. Never change NVR or camera settings.
- **Never deploy.** Do not restart services, touch Docker or touch production; this Windows PC runs production. Deploying to the test server is the owner's step, after the plan.
- **Tests run only in the lab.**
  - Upload the code: `bash "C:/Users/mike/AppData/Local/Temp/claude/C--Users-mike-Downloads-websdk3-2/ad5da1d1-45c4-4db7-bba1-df7d8d07b073/scratchpad/imaging/lab.sh" code`
  - Then run: `bash ".../lab.sh" sh "cd app && node cctv/test/<name>.test.mjs"`
  - After each code upload, restore the disk helper: `bash ".../lab.sh" putfile C:/Users/mike/Downloads/websdk3.2/TVT-CCTV/deploy/cctv-disk-helper app/deploy/cctv-disk-helper`
  - Finish every task by running ALL `cctv/test/*.test.mjs`: sps needs `../frames`, substreams needs `../fx/substream`, and disks needs the helper restored as above.
- **Test first.** For every task: write the tests → run (fail) → implement → run (pass) → run all suites.
- **Back up before editing.** Copy the original of any existing file into `C:\Users\mike\AppData\Local\Temp\claude\C--Users-mike-Downloads-websdk3-2\ad5da1d1-45c4-4db7-bba1-df7d8d07b073\scratchpad\playback\orig\` (same relative path, e.g. `...\orig\cctv\playback.mjs`) unless a copy is already there.
- **Tools.** Write files with the Write/Edit tools; Git Bash heredocs mangle backslashes. No git commits. No subagents unless the owner allows them.
- **Unchanged paths.**
  - `CCTV_LIVE_WORKER` unset: `recIndex()` is null, the timeline is `available:false`, and sockets without `src=auto` go straight to `nvr.playback.connect`.
  - The NVR `PlaybackSession` in `playback.mjs` stays as it is. The only change there is the `clock()` addition in Task 2.
- **Disk priority.** Playback reads are bounded: one read in flight per session, at most 4 MB per read, and read-ahead of 3 s of footage × |speed| or 16 MB. Recording writes are never waited on.
- **Worker changes are additive.** The only one is the `segopen` message.

## Wire protocol (additions; backward compatible)
```
WS /playback?nvr=ID&ch=N&stream=S&start=T&src=auto
   src=auto: server recordings first (admin, CCTV_LIVE_WORKER=on, camera has recordings); all times server clock.
   without src: exactly today's NVR playback (NVR clock).
 client -> server  {"speed": s}   s in ±1,2,4,8,16,32 (NVR legs: capped at 8, reverse not allowed)
                   {"pause": bool}
                   {"seek": T, "gen": n}      reposition; frames of older gens are dropped by the browser
                   {"scrub": T, "gen": n}     one keyframe at or before T (server footage only), then paused
 server -> client  {"type":"started","gen":n,"at":T,"from":keyTs,"src":"server"|"nvr"}   before the first frame of gen n
                   {"type":"scrub","gen":n,"at":keyTs} | {"type":"scrub","gen":n,"none":true}
                   {"type":"source","src":"server"|"nvr","from":ms,"to":ms|null}         switch while playing
                   {"type":"mode","stills":bool}      stills: show each frame when decoded (reverse, scrub)
                   {"type":"speed","speed":1,"reason":"newest"}
                   {"type":"notice","message":...}    e.g. "Skipped 12:03:10–12:05:40: not recorded"
                   {"type":"end","newest"?:true,"reverse"?:true} {"type":"error","message":...} {"type":"stream","stream":0}
 binary            the /live wire format (server.mjs header): flags bit0 key, codec, w=0, h=0, ts µs (server clock)
GET /api/playback/timeline?nvr=ID&ch=N&from=ms&to=ms   (to - from <= 48 h)
   -> { available:false } | { available:true, now, tzOffsetMs|null, skewMs, firstMs, codec:'h264'|'h265',
                              ranges:[[s,e]], gaps:[[s,e,reason]] }
GET /api/playback/now  -> { now, tzOffsetMs, skewMs }   (skewMs added)
```

## File map
| File | Responsibility |
|---|---|
| `cctv/rec-reader.mjs` (new) | Segment files back to frames: access-unit split, `.idx` lookups, GOP and keyframe reads, smoothed frame times, growing files |
| `cctv/rec-index.mjs` (modify) | `at/next/prev/first/timeline/recentOf`; in-memory open segments `noteOpen/noteClosed/dropOpen/openOf` |
| `cctv/segment-writer.mjs`, `recorder.mjs`, `worker-ipc.mjs`, `worker-supervisor.mjs`, `nvrs.mjs` (modify) | `'open'` event → `{t:'segopen'}` → `index.noteOpen`; closed → `noteClosed`; worker (re)start → `dropOpen`; warm on close (Task 6) |
| `cctv/playback.mjs` (modify `clock()` only) | `skewMs`, `lastClock()` |
| `cctv/rec-access.mjs` (new) | `canPlayServer(who, nvrId, ch)`: the per-camera permission hook (admins for now) |
| `cctv/rec-api.mjs` (new) | `timelineApi()` for `GET /api/playback/timeline` |
| `cctv/rec-playback.mjs` (new) | `connectPlayback()` (server vs NVR per socket), `ServerPlayback` session (pacing, speeds, reverse, seek, scrub, open-file follow) |
| `cctv/rec-fallback.mjs` (new) | `nvrCoverage()` (cached NVR search in server time), `startLeg()` (NVR session through a proxy ws, clock conversion) |
| `cctv/server.mjs` (modify) | timeline route; `/playback` → `connectPlayback` with `who`; offline refusal only for NVR sessions; RAM estimate for Settings |
| `cctv/public/pb-sources.js` (new) | Pure page logic: merge sources, stretch lookups, mode choice, scrub throttle |
| `cctv/public/player.js` (modify) | `skipUntil()` with poster, `setStills()`, `seekReset()` |
| `cctv/public/playback.js`, `playback.html`, `style.css` (modify) | Server mode: timeline colours, socket commands, scrub, speeds, messages |
| `cctv/rec-cache.mjs` (new) | File-cache warming on segment close; RAM estimate |
| `cctv/settings-api.mjs`, `public/settings.js`, `public/settings.html`, `settings.mjs` (comment) (modify) | RAM shown per choice |
| tests (new): `rec-reader`, `rec-timeline`, `rec-playback`, `rec-fallback`, `pb-sources`, `rec-cache`; `player.test.mjs` extended | |

---

### Task 1: Segment reader (frames and times back from the files)
**Files:** create `cctv/rec-reader.mjs`, test `cctv/test/rec-reader.test.mjs`. It does not import `sdk.mjs`, because that loads koffi. It defines `CODEC = { h264: 0, h265: 1 }` itself, matching sdk.mjs.

**Interfaces (produces):**
- `codecOfPath(path) → 0|1` (from `.h264` / `.h265`).
- `splitUnits(buf, codec, { final = true, keyOffsets = null, base = 0 }) → { units: [{ start, end, isKey }], used }`.
  - With `final: false`, the last unit is held back: `used` is its start, so a growing file never yields a partial frame.
  - `isKey` is true when `base + start` is in `keyOffsets` (the `.idx` offsets). Without `keyOffsets`, a unit is a keyframe if it contains an H.264 type 5 or H.265 type 16–21 NAL unit.
  - A new unit starts at the first of these NAL units after a VCL NAL has been seen:
    - H.264 (`t = b & 0x1f`): 6 SEI, 7 SPS, 8 PPS, 9 AUD, 14–18, or a VCL NAL (1–5) whose first_mb_in_slice == 0 (top bit of the byte after the header).
    - H.265 (`t = (b >> 1) & 0x3f`): 32–35, 39 (prefix SEI), 41–44, 48–55, or a VCL NAL (0–31) with first_slice_segment_in_pic_flag (top bit of the byte after the 2-byte header).
    - Suffix SEI (40), EOS, EOB and FD stay with the current unit.
- `keyAtOrBefore(rows, t) → k` (−1 when t is before the first row) and `keyAtOrAfter(rows, t) → k` (−1 when after the last). Binary search.
- `smoothKeyTimes(rows) → number[]`:
  - Split the rows into runs wherever a step is under 0.5× or over 1.5× the file's median step (a gap, or a change of GOP length).
  - In each run of 4 or more rows, fit a least-squares line t ≈ a + b·k. Use the fitted time where |t_k − fit_k| < 500 ms; otherwise keep t_k.
  - Runs shorter than 4 rows keep their raw times.
- `class SegmentReader`:
  - `constructor({ path, endMs = null, growing = false, fs = fsp })`.
  - `async open()` reads `.idx` and `fstat`. It ignores rows whose offset ≥ size or that are partial, and throws with the `e.code` of the failure (ENOENT).
  - Properties: `rows`, `times` (smoothed), `codec`.
  - `async gop(k) → [{ buf, isKey, ts }]` reads the bytes from `rows[k].offset` to `rows[k+1].offset`, or to the end of the file for the last GOP.
  - `async keyframe(k) → { buf, ts }` reads in 256 KB chunks until the next unit starts.
  - `async refresh() → boolean`: for a growing file, re-reads the `.idx` tail and the size; true if something new arrived.
  - `close()`.
- Frame times within GOP k (n frames, T = smoothed times): `ts_i = T_k + i · (T_{k+1} − T_k) / n`. For the last GOP:
  - Closed file: step = `(endMs − T_k) / (n − 1)`. If that differs from the previous GOP's step by more than 50%, use the previous GOP's step.
  - Growing file: the previous GOP's step, or 40 ms when there is none.

**Tests (write first):**
- `splitUnits`:
  - Synthetic H.264: SPS+PPS+IDR is one unit. A 2-slice P picture, where the second slice has first_mb ≠ 0, is one unit. SEI and AUD start a unit.
  - Synthetic H.265: VPS/SPS/PPS/prefix SEI/IDR is one unit. A suffix SEI stays with its picture. TRAIL with the first-slice flag starts a unit.
- Round trip, synthetic. Three minutes of frames at 25 fps with a key every 50 frames, written by the real `SegmentWriter` into a temp dir. `SegmentReader` over each segment returns exactly the same buffers (`Buffer.equals`) with the same key flags. The frame count matches.
- Round trip, real clip. Uses `../set/nvr1-13.bin` or `CCTV_TEST_CLIP` when present, and SKIPs otherwise (as `segment-writer.test.mjs` does). Same equality check.
- `keyAtOrBefore` / `keyAtOrAfter`: before the first row, exact hits, between rows, after the last row.
- `smoothKeyTimes`:
  - Keys every 2000 ms with ±300 ms jitter: smoothed times are within 40 ms of the truth.
  - A 60 s gap splits the run, and the times on either side of it are not pulled.
  - Variable GOP (random 2–10 s): residuals over 500 ms keep the raw times.
- Frame times: they increase strictly within and across GOPs. Every frame's time is within one frame interval of the true time used when writing.
- `keyframe(k)` returns exactly the keyframe unit. It is tested with a 900 KB keyframe, which needs several 256 KB chunk reads.
- Growing file: a writer keeps writing in the background. `refresh()` sees the new rows. No partial frame is ever returned, which is checked against the originals. An `.idx` row whose data has not been written yet is not used.
- A partial last `.idx` row is ignored. A missing file throws with `code === 'ENOENT'`.
- Speed: splitting a 30 MB segment takes under 300 ms in the lab. The time is logged.

**Sketch:**
```js
const START_264 = new Set([6, 7, 8, 9, 14, 15, 16, 17, 18])
const START_265 = new Set([32, 33, 34, 35, 39, 41, 42, 43, 44, 48, 49, 50, 51, 52, 53, 54, 55])
export function splitUnits(buf, codec, { final = true, keyOffsets = null, base = 0 } = {}) {
  const units = []
  let cur = null
  let sawVcl = false
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue
    const h = buf[i + 2] === 1 ? i + 3 : buf[i + 2] === 0 && buf[i + 3] === 1 ? i + 4 : -1
    if (h < 0 || h + 2 >= buf.length) continue
    let vcl, first, begins
    if (codec === 1) {
      const t = (buf[h] >> 1) & 0x3f
      vcl = t < 32; first = vcl && (buf[h + 2] & 0x80) !== 0; begins = START_265.has(t)
    } else {
      const t = buf[h] & 0x1f
      vcl = t >= 1 && t <= 5; first = vcl && (buf[h + 1] & 0x80) !== 0; begins = START_264.has(t)
    }
    if (!cur || (sawVcl && (begins || first))) {
      if (cur) cur.end = i
      cur = { start: i, end: buf.length, isKey: keyOffsets ? keyOffsets.has(base + i) : false }
      units.push(cur)
      sawVcl = false
    }
    if (!keyOffsets && isKeyNal(buf[h], codec)) cur.isKey = true // H.264 type 5, H.265 16-21 anywhere in the unit
    if (vcl) sawVcl = true
    i = h
  }
  if (!final && units.length) return { units: units.slice(0, -1), used: units.at(-1).start }
  return { units, used: buf.length }
}
```
- [ ] tests first → run (fail) → implement → run (pass) → all suites.

### Task 2: Index lookups, open segments, access hook, timeline API
**Files:**
- Modify:
  - `cctv/rec-index.mjs`
  - `cctv/segment-writer.mjs` (`'open'` event)
  - `cctv/recorder.mjs` (send `segopen`)
  - `cctv/worker-ipc.mjs` (`MSG.SEGOPEN = 'segopen'`)
  - `cctv/worker-supervisor.mjs` (forward `SEGOPEN` to `onRecording`)
  - `cctv/nvrs.mjs` (`onRecording`: `segopen` → `index.noteOpen`; `segment` → `index.addSegment` + `noteClosed(path)`; `recoverFor` → `index.dropOpen(nvrId)` first)
  - `cctv/playback.mjs` (`clock()` only)
  - `cctv/server.mjs` (timeline route before the generic `/api/playback/` branch)
- Create `cctv/rec-access.mjs` and `cctv/rec-api.mjs`.
- Test: `cctv/test/rec-timeline.test.mjs`.

**Interfaces:**
- rec-index. A segment is `{ nvr, ch, path, startMs, endMs, bytes, keyframes, loc, open? }`.
  - `at(nvr, ch, t)`: `start_ms <= t AND end_ms >= t ORDER BY start_ms DESC LIMIT 1`, else the open segment when `t >= open.startMs`.
  - `next(nvr, ch, afterStartMs)`: first row with `start_ms > ?`, else the open segment when it starts later.
  - `prev(nvr, ch, beforeStartMs)`: last row with `start_ms < ?`.
  - `first(nvr, ch)`: the oldest segment.
  - All four are served by the existing `segments_cam` index.
  - `timeline(nvr, ch, fromMs, toMs, now) → { ranges, gaps, codec }`:
    - `ranges` merges segments within 2000 ms (JOIN_MS) of each other and clips them to [from, to]. The open segment counts as [startMs, now].
    - `gaps` are the rows of the gaps table as `[fromMs, toMs, reason]`.
    - `codec` is the extension of the newest segment.
  - `noteOpen({ nvr, ch, path, startMs, loc })`, `noteClosed(path)`, `dropOpen(nvr)`, `openOf(nvr, ch)`. These live in memory only.
- segment-writer: emits `'open'` with `{ path, startMs }` once both files have been created (the end of `#doOpen`). It does not emit when the open fails.
- recorder: `w.on('open', (o) => this.send({ t: 'segopen', nvr: this.nvrId, ch: cam.ch, ...o, loc: loc.id }))`.
- playback.mjs `clock()`:
  - Returns `{ now, tzOffsetMs, skewMs }`, where `skewMs = now − Date.now()`, set to 0 when |skew| < 2000.
  - Also stores it: `lastClock() → { tzOffsetMs, skewMs, at } | null` on the object `createPlayback` returns.
  - `/api/playback/now` therefore also carries `skewMs`, which old pages ignore.
- `rec-access.mjs`: `export function canPlayServer(who, nvrId, ch) { return Boolean(who?.admin) }`. It carries a comment that per-user rights replace the body later.
- `rec-api.mjs`: `timelineApi({ nvr, params, who, index, now = Date.now() }) → [status, body]`.
  - 404 for an unknown NVR.
  - 400 for a bad `ch`, `from` or `to`, when `to <= from`, or when the span is over 48 h.
  - `{ available:false }` when `index` is null, when `canPlayServer` refuses, or when `index.first()` is null.
  - Otherwise `{ available:true, now, tzOffsetMs: nvr.playback.lastClock()?.tzOffsetMs ?? null, skewMs: …?? 0, firstMs, codec, ranges, gaps }`.
  - Never calls the NVR.
- server.mjs:
  ```js
  if (pathname === '/api/playback/timeline') {
    const who = { user, admin: AUTH_OFF || auth.isAdmin(user) }
    const [status, body] = timelineApi({ nvr: nvrs.get(url.searchParams.get('nvr') ?? ''), params: url.searchParams, who, index: recIndex() })
    return sendJson(res, status, body)
  }
  ```
  This goes before `if (pathname.startsWith('/api/playback/'))`.

**Tests (write first):**
- Index on a temp DB:
  - `at`, `next`, `prev`, `first`, including t equal to a start or an end, and no match.
  - A `-2` suffix file in the same minute is ordered by `start_ms`.
- `timeline`:
  - Three contiguous segments (40 ms apart) plus one after a 5-minute gap give 2 ranges.
  - Clipped to the window.
  - Gap rows come with their reasons.
  - Codec comes from the extension.
- Open segments:
  - After `noteOpen`, `at(t ≥ startMs)` returns the open one with `open:true`, and `timeline` extends to `now`.
  - The matching `segment` clears it.
  - `dropOpen('w1')` clears only that NVR's entries.
- Writer and recorder: `SegmentWriter` emits `open` with the real path after creating the files, and not when `mkdir` fails (slow or failing fs fake as in `segment-writer.test.mjs`). A `Recorder` with a fake stream sends `{t:'segopen', nvr, ch, path, startMs, loc}`.
- `canPlayServer`: true for `{admin:true}`, false for `{admin:false}`, `null` and `undefined`.
- `timelineApi`:
  - 404, 400 cases, 48 h cap.
  - `index` null (flag off) gives `available:false`; a non-admin gives `available:false`; a camera without segments gives `available:false`.
  - An admin gets ranges, gaps, `now`, `firstMs` and `codec`.
  - With an offline NVR whose `playback.clock` throws when called, the answer is still 200 and the fake saw no call.
- `clock()` (fake NVR as in `playback-busy.test.mjs`): gives `skewMs`, and 0 when the difference is under 2 s. `lastClock()` is set after a call.
- [ ] tests first → implement → pass → all suites.

### Task 3: Server playback session (from disk)
**Files:**
- Create `cctv/rec-playback.mjs`.
- Modify `cctv/server.mjs`, WebSocket connection:
  ```js
  const nvr = nvrs.get(url.searchParams.get('nvr') ?? '')
  if (!nvr) return ws.close(1013, 'unknown NVR')
  if (url.pathname === '/playback') {
    const user = currentUser(req)
    return connectPlayback({ nvr, ws, url, who: { user, admin: AUTH_OFF || auth.isAdmin(user) }, index: recIndex() })
  }
  if (!nvr.online) return ws.close(1013, 'NVR offline')   // /live and /motion as before
  ```
- Test `cctv/test/rec-playback.test.mjs`.

**Interfaces:**
- `connectPlayback({ nvr, ws, url, who, index, allowed = canPlayServer, legs = defaultLegs, opts = {} })`:
  - Without `src=auto`: `if (!nvr.online) ws.close(1013, 'NVR offline'); else nvr.playback.connect(ws, url)`. This is today's behaviour, unchanged.
  - With `src=auto`:
    - Not eligible (no index, not allowed, `index.first(nvr.id, ch)` null): send `{type:'error', message:'Server recordings are not available here; reload the page.'}` and close with 1011 (R15).
    - Eligible: `new ServerPlayback({ ws, nvr, ch, start, stream, index, legs, ...opts })`.
  - Bad parameters close with 1008, as today.
- `ServerPlayback`. Options, all injectable for tests: `fs`, `now`, `tickMs = 15`, `readAheadMs = 3000`, `maxQueueBytes = 16 MB`, `pauseAbove = 8 MB`, `resumeBelow = 1 MB`, `gapMs = 3000`, `maxKeysPerS = 8`, `tailPollMs = 200`, `legs` (Task 4; `null` means gaps are jumped).
- `encodeDiskFrame(buf, isKey, codec, tsMs) → Buffer`: the same 16-byte layout as sdk.mjs `encodeFrame`, with width and height 0.

**Behaviour:**
1. **Seek (and start, with gen 0).**
   - Clear the queue, abort the reader (its gen check after each await) and close any leg.
   - Find `seg = index.at(t) ?? index.next(t)`. No server footage at t → Task 4 (in Task 3: jump to `seg.startMs` with a `notice`; nothing at all → `{type:'end'}`).
   - Open a `SegmentReader` and find `k = keyAtOrBefore(rows, t)`.
   - Send `{type:'started', gen, at:t, from:times[k], src:'server'}`.
   - Queue GOP k and the following frames. The pacer anchor is `{ wall: now, media: t }`, so frames before t are due at once: that burst is the preroll.
2. **Pacing (every 15 ms).**
   - `mediaNow = anchor.media + (now − anchor.wall) × speed`.
   - Forward: frames with `ts ≤ mediaNow` go out. Reverse: frames with `ts ≥ mediaNow`.
   - When the head of the queue is more than `gapMs` away in the playing direction, re-anchor on it.
   - The pacer stops while paused. On resume, `anchor = null` and playback continues from the next queued frame.
3. **Read-ahead.** The reader runs one read at a time while the queued footage is under `readAheadMs × |speed|`, the queue is under `maxQueueBytes` and `ws.bufferedAmount < pauseAbove`. After the socket goes over that, it waits until `ws.bufferedAmount < resumeBelow`.
4. **Keyframe mode** (`|speed| ≥ 8` or `speed < 0`).
   - The reader emits `keyframe(k)` only. It skips keyframes so that consecutive ones sent are at least `|speed| × 1000 / maxKeysPerS` ms of footage apart.
   - Reverse walks the rows backwards, and at the start of a file moves to `index.prev(nvr, ch, seg.startMs)`.
   - Reverse and scrub send `{type:'mode', stills:true}` first. Returning to forward sends `stills:false`.
   - A speed change keeps the position: the queue is cut at `mediaNow` and the reader restarts there in the new mode. When switching from keyframes to all frames, it restarts at the next keyframe at or after `mediaNow`, so no preroll is needed.
5. **Segment crossing.** At the end of a file, continue with `index.next(nvr, ch, seg.startMs)` without a message. The files are contiguous, so the timestamps simply carry on.
6. **Open segment.** At the tail of a growing file, `refresh()` every 200 ms. When the file closes, `noteClosed` has already made it a normal row and `next()` gives the new open file.
   - Reaching the newest frame at a speed above 1× → `{type:'speed', speed:1, reason:'newest'}`, and playback carries on at 1×.
   - Reverse reaching the first segment → `{type:'end', reverse:true}`.
7. **Scrub (R8).**
   - `{scrub:T, gen}` sets paused, clears the queue and aborts the reader.
   - `seg = index.at(T)`; with none → `{type:'scrub', gen, none:true}`.
   - Otherwise send `{type:'scrub', gen, at:times[k]}` and the keyframe, but only if `gen` is still current, so the latest scrub wins.
   - Parsed `.idx` files are kept in an LRU of 64 per session.
8. **Errors.**
   - ENOENT or EACCES while opening or reading a segment: skip to the next one and log once per session.
   - A reader exception does not crash the session: it sends `{type:'error'}` and closes with 1011.
9. **Close.** Clear timers, close file handles, abort the reader. Log one line: `[nvr] server playback chN from ISO: index a ms, idx b ms, first frame c ms`.

**Tests (write first).** Test setup:
- A temp location with 4 minutes of synthetic H.264 at 25 fps, GOP 50, and ±300 ms jitter on the key times, written by `SegmentWriter`.
- A temp `openRecIndex` holding them.
- The fake ws from `playback-busy.test.mjs`, extended to record binary sends as `{ key, codec, tsMs, len }`.

Cases:
- No `src=auto`, whatever the index, the user or the recordings: the fake `nvr.playback.connect` gets the same ws and url, and nothing else is sent. The same with `nvr.online = false` closes with 1013 'NVR offline', as server.mjs does today.
- `src=auto` but not eligible: error + 1011 (R15).
- Start at T mid-GOP:
  - The first text message is `started` with `gen 0`, `at T` and `from ≤ T`.
  - The first binary is a keyframe with ts = from.
  - All frames before T arrive within 50 ms of the first one.
  - Connect to first binary is under 150 ms.
- Frames are byte-equal to the originals, the codec byte is right, and ts increase.
- Pacing:
  - Over 1.0 s of wall time at 1×, 1.0 s ± 15% of footage goes out.
  - At 2× and 4×, all frames go out (none skipped) and the footage advances ×2 and ×4 ± 15%.
- 8×, 16× and 32×: only keyframes, at most 8 per wall second (the 32× case skips every 2nd key of a 2 s GOP), ts increasing.
- −4×: `mode stills:true`, then keyframes with ts decreasing, paced. At the first segment: `end reverse`.
- Pause: no binary for 300 ms. Resume continues from the next frame, with no gap in the sequence.
- `{seek:T2, gen:1}`: after `started gen 1`, every frame has ts ≥ keyAtOrBefore(T2). Nothing from the old position arrives after the message.
- 10 scrubs within 30 ms (gen 2 to 11): the last message is `scrub gen 11` followed by one keyframe, never more than one read in flight (fs fake counts), and no scrub reply with an older gen after gen 11's.
- A scrub over a time with no server footage gives `none:true`.
- Across 3 segments: every original frame is delivered once, in order.
- A 10 s gap between segments is jumped (the pacer re-anchors). With `legs:null`, a 60 s gap is jumped with a `notice`.
- A growing file (a writer still writing in the test): playback at 1× keeps receiving new frames as they are written. At 4×, reaching the newest frame sends `speed 1 newest`.
- A segment unlinked and removed from the index after lookup: skipped, no crash, playback continues with the next one.
- With `bufferedAmount` forced to 9 MB, the reader stops (fs fake read count stays flat). At 0.5 MB it resumes.
- `ws.close()` clears the timers and closes the handles (fs fake open count back to 0).

**Sketch:**
```js
#pace() {
  if (this.closed || this.paused || this.leg || this.queue.length === 0) return
  const now = this.now()
  const dir = Math.sign(this.speed)
  this.anchor ??= { wall: now, media: this.startAt ?? this.queue[0].ts } // startAt = the seek target: earlier frames are the preroll
  this.startAt = null
  let media = this.anchor.media + (now - this.anchor.wall) * this.speed
  const head = this.queue[0].ts
  if (dir * (head - media) > this.gapMs) (this.anchor = { wall: now, media: head }), (media = head) // a gap: jump
  while (this.queue.length && dir * (this.queue[0].ts - media) <= 0) this.#deliver(this.queue.shift())
  this.#fill()
}
```
- [ ] tests first → implement → pass → all suites.

### Task 4: NVR fallback legs
**Files:** create `cctv/rec-fallback.mjs`; modify `cctv/rec-playback.mjs` (use legs at a start without server footage and at gaps of 30 s or more; `defaultLegs` = the real `rec-fallback.mjs`); test `cctv/test/rec-fallback.test.mjs`.

**Interfaces:**
- `nvrCoverage(nvr, ch, fromMs, toMs, { now, ttlTodayMs = 60_000, ttlPastMs = 600_000 }) → Promise<{ ranges: [[s,e]], reason? }>` (server time):
  - tz and skew come from `nvr.playback.lastClock()`. If there is none, it calls `nvr.playback.clock()`, but only when `nvr.online && !nvr.degraded`.
  - It calls `nvr.playback.recordings(ch, date)` for each NVR-local date overlapping [from + skew, to + skew]. Results are cached per (nvr, ch, date).
  - Ranges come back shifted by −skewMs.
  - When the NVR is offline, degraded or busy (`NvrBusy`), or throws, the answer is `{ ranges: [], reason }`.
- `startLeg({ nvr, ch, fromMs, toMs, stream, speed, paused, skewMs, real }) → { command(obj), close(), done: Promise<{ reason }> }`:
  - It builds a proxy ws, `{ OPEN:1, readyState, get bufferedAmount() { return real.bufferedAmount }, send, on, close }`, and calls `nvr.playback.connect(proxy, new URL(\`ws://x/playback?nvr=${id}&ch=${ch}&stream=${stream}&start=${fromMs + skewMs}\`))`.
  - Binary messages from the NVR session: ts is rewritten to `ts − skewMs·1000` (int64 at offset 8, in a copy) and forwarded to `real`. The first frame with converted ts ≥ `toMs` ends the leg and is not forwarded.
  - JSON messages:
    - `started` → `{type:'source', src:'nvr', from:fromMs, to:toMs}`. After a seek it becomes `{type:'started', gen, at, src:'nvr'}` instead.
    - `stream` → forwarded as is.
    - `end` or `error` → ends the leg with that reason.
  - `command()` forwards `{speed}` (capped at 8) and `{pause}` to the NVR session's message handler.
  - `close()` fires the proxy's `close` handler, which is how the NVR session stops and frees its login. After that, nothing from the leg is forwarded.
- ServerPlayback with legs:
  - At a start or seek where there is no server footage at T: take the coverage for [T, next server start, or T + 6 h]. When it covers T, or starts before the next server start, and the NVR is online, start a leg over that stretch (a `started` with `src:'nvr'`). Otherwise jump to the next server segment with a `notice`.
  - When the reader meets a gap of 30 s or more going forward: do the same for [gapStart, gapEnd]. The coverage is prefetched once the reader is within 10 s of the gap.
  - During a leg the pacer is idle. The reader has already opened the next server segment and read its first GOP, so the switch back is instant.
  - When the leg ends: close it and continue from disk at the next segment, with `{type:'source', src:'server'}`.
  - A seek or scrub during a leg closes the leg first.
  - Reverse, scrub and keyframe speeds never start a leg. A leg at 16× or 32× runs at 8×.

**Tests (write first).** Fake NVR: `playback.connect(ws, url)` records the url and emits frames stamped in NVR time (skew +220 s, as nvr1 is about 3 min 40 s fast) through `ws.send`, paced by a timer. It answers `ws.on('message')` commands. `recordings()` counts its calls. `lastClock()` returns tz and skew.

Cases:
- Starting at T before the first server segment S (NVR covers T): `connect` gets `start = T + 220000`. The browser gets `started src nvr` and frames with ts converted to server time (within 1 ms). At S, the leg's ws is closed (the fake sees `close`) and `source server` arrives, followed by disk frames from S. No frame is delivered twice or out of order across the switch.
- `{pause}` and `{speed:4}` during a leg reach the fake. `{speed:16}` reaches it as 8.
- The leg fails ('No recording at this time'), or the NVR is offline, or `recordings` throws `NvrBusy`: a `notice`, then disk at S. No hang.
- A 10 s server gap is jumped without calling `recordings`. A 90 s gap covered by the NVR plays as a leg, then returns to disk.
- A seek during a leg: the leg is closed before `started gen 1`, and nothing from the leg arrives after that message.
- Coverage cache: two coverage calls for the same day within 60 s make one `recordings()` call. A past day is cached for 10 min.
- A scrub over NVR-only time gives `scrub none`. Reverse into NVR-only time gives `end reverse` (no leg).
- [ ] tests first → implement → pass → all suites.

### Task 5: Playback page, server first
**Files:** create `cctv/public/pb-sources.js`; modify `cctv/public/playback.js`, `cctv/public/player.js`, `cctv/public/playback.html` (legend "NVR only", "server gap"; speed options filled by the script), `cctv/public/style.css` (`--tl-nvr`, `--tl-gap`, light and dark); tests `cctv/test/pb-sources.test.mjs` (new) and `cctv/test/player.test.mjs` (new cases; the stand-in `VideoDecoder` gains `reset()`).

**Interfaces:**
- `pb-sources.js` (pure, no DOM):
  - `shift(ranges, ms)`
  - `mergeSources(server, nvr, { minMs = 2000 }) → [{ s, e, src }]`: NVR ranges minus server ranges. NVR slivers under `minMs` are dropped, since they are clock jitter.
  - `stretchAt(list, t)`, `recordedFrom(list, t)`, `nextStretch(list, t)`
  - `pickMode({ timeline, h265, quality }) → { mode: 'server'|'nvr', why }` (R6)
  - `class ScrubThrottle { constructor(send, { timeoutMs = 300, now, setTimer }); push(t); ack(gen); cancel() }`: one scrub in flight, the latest position wins, and a lost reply frees the slot after `timeoutMs`.
- `player.js`:
  - `skipUntil(tsMs)`:
    - Decoded frames with ts < tsMs are closed without being shown, and are not counted as dropped.
    - The first of them is drawn once as a poster, without calling `onFrame`.
    - While frames are being skipped, the decode-queue limit is `MAX_PREROLL_FRAMES = 300`.
  - `setStills(on)`: each decoded frame is drawn at once, `onFrame(ts)` is called and the queue is not used. Turning it off resets the clock anchor.
  - `seekReset()`: close the queued frames, `clock.reset()`, clear what is held, and `decoder.reset()` + `decoder.configure(this.config)` (the config is saved by `#configure`), then `needKey = true`. No `isConfigSupported` call.
- `playback.js`, server mode (`state.mode === 'server'`):
  - **Loading a day:** `GET /api/playback/timeline?nvr&ch&from=dayStart&to=dayStart+DAY`, then `pickMode`. In NVR mode, everything runs exactly as today.
  - **Server mode, time and dates:**
    - `state.nvrNow = timeline.now`. `state.tz = timeline.tzOffsetMs ?? −new Date().getTimezoneOffset()·60000`. `state.skew = timeline.skewMs`.
    - The date picker's minimum is the earlier of the dates of `firstMs` and the NVR's first date.
  - **Server mode, drawing:**
    - Server ranges are drawn at once in `--tl-rec`.
    - The NVR's `/recordings` is requested without blocking. When it answers, NVR-only stretches are drawn in `--tl-nvr` and its events in `--tl-evt`. If the NVR is busy or offline, the retry is quiet and no message covers the video.
    - Gaps are drawn as a thin `--tl-gap` strip, with the reason in the hover label.
  - **Server mode, the socket:** `src=auto` on the first open. After that, `send({seek:T, gen: ++gen})` while the socket is open.
    - Binary frames are ignored until `started` with the current gen arrives. `started` → `player.skipUntil(at)`.
    - `mode` → `player.setStills()`. `source` → a small "from NVR" badge on the video. `speed` → update the select. `notice` → a message that fades. `end` → as today (newest or end messages).
    - Seeks use `player.seekReset()` instead of `reset()`.
  - **Server mode, controls:**
    - Speed select: −32× … 32× (R9). NVR mode keeps 1 to 8.
    - Quality select: "HD (server)" and "SD (NVR)". Choosing SD switches to NVR mode, converting the position by +skew.
    - A camera or day change that switches mode converts the position by ±skew.
  - **Scrub (R10):**
    - `pointerdown` within 8 px of the playhead starts a scrub: `player.setStills(true)`, then `ScrubThrottle.push(timeAt(x))` on every move.
    - `pointerup` sends `{seek}` and plays, with stills off.
    - Keyboard ←/→ and ±30 s use `{seek}`.
  - **Start:** server mode opens 1 minute back instead of 5, since the open segment is readable.
  - **Clock hint:** when |skew| > 5 s: "Server time. This NVR's clock is 3 min 40 s fast; the time printed on the picture differs."
  - **D overlay:** gains `src server|nvr · start N ms`, measured from the seek to the first frame shown.
  - **Refresh:** today's 60-s refresh uses the timeline request in server mode.

**Tests (write first):**
- `pb-sources.test.mjs`:
  - Merging: server [[10,20],[30,40]] with NVR [[0,50]] gives nvr 0–10, server 10–20, nvr 20–30, server 30–40, nvr 40–50.
  - Skew shift; slivers under 2 s dropped.
  - `stretchAt`, `recordedFrom` and `nextStretch` at the boundaries.
  - `pickMode`:
    - `available:false` → nvr.
    - An empty day → nvr.
    - H.265 on a browser without H.265 → nvr, with a reason naming H.265.
    - quality 'sd-nvr' → nvr.
    - Otherwise → server.
  - `ScrubThrottle` (fake timers): 20 pushes with no ack → 1 send. An ack → the newest position is sent next. No ack for 300 ms → the slot is freed.
- `player.test.mjs`:
  - `skipUntil`: a GOP of 50 fed with skipUntil at frame 30. Frames 1–29 are closed, not shown and not counted as dropped. The keyframe is drawn once as a poster. `onFrame` is first called with frame 30. None is dropped by the decode-queue guard even though all 50 are pushed at once.
  - `setStills(true)`: each decoded frame is drawn at once and `onFrame` is called for it. After `setStills(false)`, the clock anchor is fresh.
  - `seekReset()`: the same decoder object (reset + configure, `env.configs` did not grow), `needKey` true, and no VideoFrame left open.
- Manual (in the trial): old path identical with the flag off (same network requests as today). Server mode with 1 camera: start time in the D overlay, scrub, speeds, reverse.
- [ ] tests first → implement → pass → all suites.

### Task 6: Recent footage in RAM (file-cache warming) and RAM shown in Settings
**Files:**
- Create `cctv/rec-cache.mjs`.
- Modify:
  - `cctv/rec-index.mjs`: `recentOf(nvr, ch, limit)`, newest first.
  - `cctv/nvrs.mjs`: on `segment`, `warmer.onSegment(m)`, created in `startRecording()`.
  - `cctv/settings-api.mjs`: `handleSettings(..., admin, { ramEstimate } = {})`. GET adds `memory: ramEstimate?.() ?? null`.
  - `cctv/server.mjs`: pass `ramEstimate: () => estimateRecentRam({ index: recIndex(), settings: getSettings() })`.
  - `cctv/public/settings.js`: each option reads "2 min (≈ 1.4 GB)", with a line below: "Held in the system's file cache, not by the app; this server has N GB available."
  - `cctv/settings.mjs`: the comment "(setting only for now)" becomes "warms the file cache, rec-cache.mjs".
- Test `cctv/test/rec-cache.test.mjs`.

**Interfaces:**
- `createWarmer({ minutes = () => getSettings().memory.recentMinutes, fs = fsp, now = Date.now, maxPending = 64, chunk = 1 << 20 }) → { onSegment(seg), idle(), stats() }`.
  - When `minutes() > 0`, it reads each finished segment and its `.idx` once, start to end, into one reused 1 MB buffer. Nothing is kept.
  - One file at a time.
  - It skips segments whose `endMs < now − minutes·60 s`.
  - Beyond `maxPending` queued files it drops the oldest and counts it in `stats().dropped`.
  - Errors are counted, never thrown.
- `estimateRecentRam({ index, settings, readMeminfo = () => readFileSync('/proc/meminfo', 'utf8'), choices = RECENT_MINUTES }) → { perMinuteBytes, byMinutes: { 1:…, 2:…, 5:…, 10:… }, cameras: n, memAvailableBytes|null }`.
  - Each camera whose mode is not 'off' contributes the average bytes per minute of its 5 most recent segments: `sum(bytes) / sum(endMs − startMs) · 60000`.
  - A camera with no segments yet is left out and counted in `cameras` only.

**Tests (write first):**
- Minutes 2: a fake fs sees the file and its `.idx` read once each, completely, always into the same Buffer object.
- Minutes 0: no reads.
- A segment older than 2 min is skipped.
- 100 segments queued at once: `maxPending` 64 holds, the oldest are dropped and counted, and at most one file is open at any time.
- A read error is counted and the next file is still warmed.
- Estimate: two recording cameras at 30 MB/min and 12 MB/min give `perMinuteBytes` 42 MB and `byMinutes[2]` 84 MB. An 'off' camera is ignored. A `MemAvailable: 12345678 kB` sample is parsed to bytes. Without `/proc/meminfo` (throws) the value is `null`.
- `handleSettings` GET with a `ramEstimate` fake returns `memory`. Without one it returns `null`, and old callers are unchanged.
- [ ] tests first → implement → pass → all suites.

## After the tasks: test-server trial (the owner deploys; the implementer never deploys)
- [ ] On the test server with `CCTV_LIVE_WORKER=on` and 3–5 cameras recording, as an admin: open Playback. Check the D overlay start time (goal: under 0.5 s on the i5-14500T with UHD 770), scrubbing, 2× and 4× smoothness, 8× to 32×, and reverse.
- [ ] A day before recording began: NVR-only stretches show in the NVR colour and play. Crossing into server footage switches without a jump in the clock.
- [ ] Log in as a viewer, and separately test with the flag off: Playback behaves exactly as before (same requests in the browser's network panel).
- [ ] Recent minutes: play 30 s back from now, and confirm the Settings RAM figures look right.

## Later plans
Events (NVR alarms into the database; the timeline stops needing the NVR's `/recordings`), timeline thumbnails, time-lapse thinning, export (MP4 remux, evidence signing), admin screens for per-user rights (replacing `canPlayServer`), a synced multi-camera playback page, and motion search from server recordings.
