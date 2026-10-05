# Recorder (phase 2: settings, storage locations, recording, retention) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server records chosen cameras' main streams into 1-minute files with a keyframe index on configurable storage locations, deletes by retention and free space, and has a Settings tab for all of it, including preparing a USB drive (wipe + XFS, with a warning and serial confirmation).

**Architecture:** Settings live in `data/settings.json` (server-validated). Storage locations are folders with a marker file; `storage.mjs` reports health and picks the write location. The recorder runs inside each NVR's live worker (phase 1): for each recording camera it `want`s the main stream in-process and `segment-writer.mjs` writes `<loc>/<nvr>/<ch>/<YYYY-MM-DD>/<HH>/<HH-MM>.<h264|h265>` plus `.idx` (keyframe offsets). The main process keeps a `node:sqlite` index (`data/recordings.db`) of segments/gaps/events fed by worker messages. `housekeeping.mjs` deletes by retention and free space. Disk preparation runs a fixed root helper script via a narrow sudo rule.

**Tech Stack:** Node 24 ESM, `node:sqlite` (built in, no new dependency), existing live worker IPC, bash helper for disk prep (`sgdisk`/`wipefs`/`mkfs.xfs`), plain `node` tests in `cctv/test`.

**Spec:** `docs/superpowers/specs/2026-09-24-server-recording-design.md`

## Global Constraints
- No transcoding: bytes written exactly as received from the SDK (Annex B), frames never altered.
- Never change NVR/camera settings. Tests never contact NVRs (fake SDK, `*.invalid` hosts).
- Never deploy to production (Docker on 192.168.2.33). Test server only: `bash deploy/push.sh --code-only --distro Ubuntu-24.04`.
- Tests only in the lab (`scratchpad/imaging/lab.sh code`, then `lab.sh sh 'cd app && node cctv/test/<x>.test.mjs'`); all existing suites stay green.
- Recording is OFF by default for every camera; nothing records until an admin turns it on in Settings.
- Disk wiping: admins only; only disks that are not the system disk, not mounted, not in a pool/RAID/LVM; typed serial must match; a server-side re-check immediately before wiping. Never wipe from tests (tests use a loop-device-free dry-run mode).
- Write files with Write/Edit tools; no git commits unless asked.
- Defaults from the spec: full video 30 days; total retention 6 months; low-space threshold 15% free, hard floor 5%; recent footage in RAM 2 min (setting only in this phase); pre/post event 10/20 s (setting only in this phase).

## File map
| File | Responsibility |
|---|---|
| `cctv/settings.mjs` (new) | Load/validate/save `data/settings.json`; defaults; per-camera overrides |
| `cctv/storage.mjs` (new) | Locations (marker file, health: mounted, writable, free, speed), pick write location, failover |
| `deploy/cctv-disk-helper` (new, root) + sudoers rule via `deploy/install-ubuntu.sh` | `list` (JSON of candidate disks) and `prepare <dev> <serial> <fs>` |
| `cctv/disks.mjs` (new) | Calls the helper, parses output, exposes the API |
| `cctv/segment-writer.mjs` (new) | Per-camera 1-minute segment files + `.idx`, rollover on minute/keyframe, fsync on close |
| `cctv/recorder.mjs` (new, used inside the worker) | Which cameras record (from settings), taps main streams, feeds writers, reports segments to the parent |
| `cctv/rec-index.mjs` (new) | `node:sqlite` index: segments, gaps; queries by camera/time |
| `cctv/housekeeping.mjs` (new) | Retention + low-space deletion (oldest first) |
| `cctv/settings-api.mjs` (new) | `/api/admin/settings`, `/api/admin/storage`, `/api/admin/disks` routes |
| `cctv/public/settings.html`, `settings.js` (new) + nav link | Settings tab: Recording, Storage locations, Prepare USB drive, Memory/thumbnail options |
| tests: `settings.test.mjs`, `storage.test.mjs`, `segment-writer.test.mjs`, `recorder.test.mjs`, `housekeeping.test.mjs`, `disks.test.mjs` | |

---

### Task 1: Settings store + API + Settings tab (Recording section)
**Files:** create `cctv/settings.mjs`, `cctv/settings-api.mjs`, `cctv/public/settings.html`, `cctv/public/settings.js`; modify `cctv/server.mjs` (route + nav link in the other pages' top bar), test `cctv/test/settings.test.mjs`.
**Interfaces (produces):**
- `getSettings() → Settings`, `saveSettings(patch, user) → Settings` (throws `HttpError(400)` on invalid), `cameraRecording(nvrId, ch) → { mode: 'off'|'continuous'|'motion'|'ai'|'ai-or-motion', fullDays, after: 'timelapse'|'keep'|'delete', timelapseS, retentionDays, locationId: string|null }`.
- Settings shape: `{ recording: { defaults: {mode:'off', fullDays:30, after:'timelapse', timelapseS:10, retentionDays:183, preS:10, postS:20}, cameras: { "<nvr>/<ch>": {partial overrides} } }, memory: { recentMinutes: 2 }, thumbnails: 'off'|'1m'|'5m', storage: { locations: [], lowFreePct: 15, floorFreePct: 5 } }`.
- Routes (admin, same-origin JSON like existing admin routes): `GET/POST /api/admin/settings`.
- Page: sections Recording (defaults + per-camera table with mode/fullDays/after/retention), Memory, Thumbnails, Storage (Task 2), Prepare USB drive (Task 3).
**Tests (write first):** defaults when file missing; invalid values rejected (mode not in list, fullDays>retentionDays, retentionDays>366, timelapseS<1); per-camera override merges over defaults; file written atomically (temp + rename) with mode 0600; GET/POST round-trip through the route handler with a fake admin.
- [ ] write tests → run (fail) → implement → run (pass) → run all suites.

### Task 2: Storage locations and health
**Files:** create `cctv/storage.mjs`; modify `cctv/settings-api.mjs` (`GET /api/admin/storage`, `POST` add/remove/set role), `public/settings.js` (Storage section); test `cctv/test/storage.test.mjs`.
**Interfaces:** `listLocations() → [{id, path, type:'internal'|'usb'|'network', role:'main'|'overflow'|'archive', limitGB|null, health:{ok, reason, marker, writable, freeBytes, totalBytes, writeMBps}}]`; `addLocation({path,type,role,limitGB})` creates `<path>/.cctv-recordings` marker (JSON with id and created time) only if the folder exists, is empty or already has the marker, and is on a different filesystem than `/` (checked via `stat().dev` vs `/`), unless `type:'internal'` and the admin ticks "same disk as the system" (warning); `pickLocation(camKey) → location|null` (camera's own location if healthy, else main, else overflow; never one without a marker); `onChange(cb)` fires when health changes (checked every 30 s).
**Tests:** marker required; empty mount point (marker missing) is never picked; failover main→overflow when main unhealthy or below floor; free-space math; write-speed probe uses a small temp file and cleans up; all using temp dirs.
- [ ] tests first → implement → pass → all suites.

### Task 3: Prepare USB drive (helper + API + UI)
**Files:** create `deploy/cctv-disk-helper` (bash, root), modify `deploy/install-ubuntu.sh` (install helper to `/usr/local/sbin/`, install `xfsprogs gdisk`, sudoers `/etc/sudoers.d/cctv-disk` allowing the service user to run only that helper), create `cctv/disks.mjs`, extend `settings-api.mjs` (`GET /api/admin/disks`, `POST /api/admin/disks/prepare {dev, serial, fs:'xfs'|'ext4'}`), `public/settings.js` (list, red warning, type-serial confirm, progress); test `cctv/test/disks.test.mjs`.
**Helper contract:** `cctv-disk-helper list` → JSON `[{dev:'/dev/sdb', model, serial, sizeBytes, tran:'usb'|'sata'|…, partitions:[{dev, fstype, label, sizeBytes, mountpoint}], eligible:bool, why}]` from `lsblk -J -b -o NAME,PATH,MODEL,SERIAL,SIZE,TRAN,TYPE,FSTYPE,LABEL,MOUNTPOINTS,PKNAME`; ineligible if it holds `/`, any mountpoint, is a ZFS/LVM/md member, or is the disk of the running system. `cctv-disk-helper prepare <dev> <serial> <xfs|ext4>`: re-checks eligibility and that the serial matches, then `wipefs -a`, `sgdisk -Z -n1:0:0 -t1:8300`, `mkfs.xfs -f -L cctv-rec` (or `mkfs.ext4 -F -L cctv-rec`), creates `/srv/cctv-rec/<serial>`, adds an fstab line by UUID with `nofail,x-systemd.device-timeout=10s`, mounts, `chown` to the service user, writes the marker; prints JSON progress lines. `CCTV_DISK_DRYRUN=1` prints the commands instead of running them (tests use this; tests never run the real helper against a device).
**Tests:** `disks.mjs` parses a saved `lsblk -J` sample (system disk ineligible, a USB disk eligible, a mounted disk ineligible); serial mismatch → 400 and helper not called; non-admin → 403; dry-run command list exact.
- [ ] tests first → implement → pass → all suites.

### Task 4: Segment writer
**Files:** create `cctv/segment-writer.mjs`, test `cctv/test/segment-writer.test.mjs`.
**Interfaces:** `new SegmentWriter({ root, nvrId, ch, codec })`; `write(frameBuf, { isKey, ts })` (frameBuf = SDK payload after the 16-byte wire header); rolls over to a new file at the first keyframe at or after each minute boundary (file named by the minute of its first frame, UTC); `.idx` = binary rows `[uint64 offset, int64 tsMs]` per keyframe; `close()` fsyncs and returns `{ path, startMs, endMs, bytes, keyframes }`; emits `segment` with that object on every rollover; first file only starts at a keyframe; codec change closes the segment.
**Tests:** feed the real clip `set/nvr1-13.bin` frames (split by the harness's frame list or synthetic frames with key flags): files roll at minute boundaries on keyframes, bytes concatenated equal the input frames exactly, `.idx` offsets point at keyframe starts, ffprobe of a segment decodes (lab has ffmpeg).
- [ ] tests first → implement → pass.

### Task 5: Recorder in the worker + index in the parent
**Files:** create `cctv/recorder.mjs`, `cctv/rec-index.mjs`; modify `cctv/nvr-worker.mjs` (start recorder; IPC `segment` messages), `cctv/worker-supervisor.mjs` / `nvrs.mjs` (forward `segment` to rec-index; send settings changes to the worker as `settings` message); tests `cctv/test/recorder.test.mjs`.
**Interfaces:** worker ← `{t:'settings', recording:{...}, location:{path}|null}`; worker → `{t:'segment', nvr, ch, path, startMs, endMs, bytes, keyframes}` and `{t:'recgap', nvr, ch, fromMs, toMs, reason}`; `recIndex.addSegment(seg)`, `recIndex.segments(nvr, ch, fromMs, toMs)`, `recIndex.oldest(limit)`, `recIndex.remove(path)`; recording uses `nvr.getStream(ch, 0).add(recTap)` inside the worker so recording and live share one pull.
Only `mode:'continuous'` records in this phase (motion/AI modes are accepted in settings and treated as continuous with a log note until phase 3 adds events).
**Tests:** fake SDK worker with recording on for one camera writes segments into a temp location and the parent index receives them; turning recording off stops the writer and closes the segment; location unhealthy → writer switches to the failover location and a `recgap` is reported if frames were lost; live viewers unaffected.
- [ ] tests first → implement → pass → all suites.

### Task 6: Housekeeping (retention + low space)
**Files:** create `cctv/housekeeping.mjs`; wire a 5-minute timer in `server.mjs` (flag `CCTV_LIVE_WORKER=on` only); test `cctv/test/housekeeping.test.mjs`.
**Rules:** delete segments older than the camera's `retentionDays`; when a location's free space < `lowFreePct`, delete oldest segments first (camera furthest past its full-days target first), but never segments inside a camera's `fullDays` unless free < `floorFreePct` (then log a warning); delete `.idx` with its segment; remove from the index; remove empty folders.
**Tests:** temp dirs with synthetic segments + fake free-space function: retention deletes, low-space order, floor protection, warnings.
- [ ] tests first → implement → pass → all suites.

### Task 7: Test-server trial
- [ ] Deploy; `lsblk` shows the USB drive only after the owner runs `wsl --mount \\.\PHYSICALDRIVEN --bare` on the test PC (owner action).
- [ ] Owner prepares the drive in Settings → Prepare USB drive (the wipe is the owner's click, never ours).
- [ ] Owner turns recording on for 3–5 cameras; after 30 min check segment files, index rows, bytes/day per camera, and that live view is unchanged.
- [ ] Report real storage per camera per day to the owner.

## Later plans
Phase 3: events (motion/AI from NVR alarms) + time-lapse thinning. Phase 4: playback from disk (fast seek, scrubbing, speeds, RAM cache, thumbnails) with NVR fallback. Phase 5: export (MP4 remux, evidence signing), per-user rights.
