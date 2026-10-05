# Server recording (long-term storage) — design

Date: 2026-09-24. Status: approved in discussion, awaiting review of this document.

## Goal
**Main goal: every user connects to the server, not to the NVRs.** The server pulls each camera's
stream from the NVR once and shares it with every viewer (live, recording, playback), freeing NVR
bandwidth. Direct NVR access (web page, TVT apps) stays possible for admins; the owner manages that.

The VMS server also becomes the main long-term store for all cameras (6–12 months, best quality).
The NVRs keep recording as a backup. Video is stored exactly as the cameras send it: no
re-encoding on the server. Playback must be very fast.

## Scale and hardware
- 56 cameras (nvr1 + nvr-2: 48, Solus: 8). Sum of main-stream caps ≈ 187 Mbit/s (≈ 2 TB/day
  worst case; real use lower).
- Target server (not bought yet): Dell PowerEdge R540, 12 × 3.5" bays, HBA330 (not a PERC in RAID
  mode), 12 × 24–26 TB enterprise CMR drives (never SMR; e.g. Toshiba MG11 24 TB, WD Ultrastar
  HC590 26 TB), 64 GB ECC RAM (4 × 16 GB), 2 mirrored boot SSDs, dual PSU, UPS with shutdown
  signal, iDRAC Enterprise.
- Ubuntu 26.04 LTS, ZFS: one 12-wide RAIDZ2 vdev, ashift=12, recordsize=1M, compression=lz4,
  atime=off, no dedup/snapshots; keep ≥ 15% free. ≈ 155–165 TB for video.
- Full 24/7 at full rate fills that in ~2½–3 months; the space-saving settings make 6–12 months fit.
- Until the R540 arrives: develop and test on the test PC with 3–5 cameras.

## Architecture
- **Recorder process per NVR** (child processes of the main app): own TVT SDK session, records the
  main stream of every camera set to record, receives the NVR's motion/AI alarm events. A slow or
  crashed NVR/recorder affects only its own recordings; crashed recorders restart automatically.
- **Storage layout:** `/rec/<nvr>/<ch>/<date>/<hour>/<HH-MM>.h265|.h264` — 1-minute segments as
  received, each with a keyframe index (byte offset + timestamp per keyframe).
- **Database** (small, on the SSDs): segments, gaps, events, thinning state; the timeline reads
  only this.
- **Housekeeping job** (every few minutes + nightly): thinning, retention, low-space deletion.
- **Main app:** playback and export from the files, NVR fallback, settings and storage pages.
- **Core (not later): one pull per camera.** The per-NVR process owns the only SDK session to its NVR.
  The main stream is pulled once, recorded, and fanned out to every full-size viewer. The sub stream
  is pulled once per camera only while at least one user has it on screen. Playback reads the
  server's disk; the NVR is used only for stretches the server lacks. Each NVR therefore sends each
  stream once, however many users watch. This also cures the cross-NVR SDK stalls.
- **Later option:** record a camera directly over RTSP instead of through the NVR, per camera.

## Settings (per camera unless noted; all switchable)
| Setting | Options | Default |
|---|---|---|
| Recording mode | 24/7 · motion only · AI events only (people/vehicles) · AI where supported, else motion | 24/7 |
| Event pre/post time | seconds before / after | 10 / 20 |
| Full video kept for | days | 30 |
| After that | time-lapse + event clips · keep everything · delete | time-lapse + event clips |
| Time-lapse interval | one picture every N s | 10 s |
| Total retention (global, per-camera override) | up to 12 months | 6 months |
| Recent footage in RAM (global) | off · 1 · 2 · 5 · 10 min (RAM shown) | 2 min |
| Timeline thumbnails (global) | off · 1/min · 1 per 5 min | off |
| Longer keyframe interval (camera setting) | Apply/Undo like the Picture panel, storage effect shown | off |
| H.264 → H.265 (camera setting) | Apply/Undo, storage effect shown | off |

Camera-side settings change only on the user's click, with Undo.

## Playback (goal: start < 0.5 s, instant scrubbing)
- Server first; NVR only for stretches the server doesn't have (shown in another colour).
- Read from disk and stream over the existing WebSocket/player; the browser decodes with hardware.
- Start: seek via the index to the keyframe before the requested time; the browser skips forward.
- Scrubbing: keyframes only while dragging; play on release.
- Speeds: 2×/4× all frames; 8×–32× keyframes; reverse via keyframes.
- Timeline (recorded / gaps / events / time-lapse) from the database, one request per day.
- Multi-camera synced playback; recent minutes served from RAM when enabled.

## Retention and space
- Thinning: nightly, old 1-minute files are rewritten keeping only keyframes every N s; minutes
  with an event (plus pre/post) stay whole. Byte copy only.
- Low space: below 15% free, delete oldest first (camera furthest past its target). Footage inside a
  camera's "full video" period is deleted only below 5% free, with a warning.
- Storage page: used/free, days per camera, predicted days, drive health (SMART, zpool status),
  warnings when targets can't be met.

## Storage locations (Settings)
- A list of locations, each with type (internal ZFS pool · external disk · network share: iSCSI, NFS, SMB),
  path, space limit and role (main · overflow · archive). Per-camera choice or automatic.
- Health per location: mounted, writable, free space, write speed. Each location holds a marker file;
  without it the location is not written (never fill an empty mount point).
- A location disappearing (USB unplugged, network down): switch to the next location at once and warn.
- **Prepare a USB/eSATA drive** (admins only):
  - lists only drives that are not the system disk, not part of a pool, and not mounted;
  - shows model, serial, size, and existing partitions and what is on them;
  - a red warning: "Everything on this drive will be erased and cannot be recovered";
  - the admin must type the drive's serial number to confirm;
  - then: wipe the partition table, one GPT partition, format XFS (ext4 as an option), mount by UUID,
    write the marker file, add it as a location. Progress and result are shown; nothing happens
    without that confirmation.
- Recommended formats: SAS disk shelf → ZFS; single USB/eSATA → XFS; iSCSI → XFS on the server;
  NFS/SMB → formatted by the NAS.

## Export
- Plain MP4 (remux, no re-encode, seconds).
- Optional **Evidence export (signed)** tick box: SHA-256 of the file signed with the server's key;
  signature + metadata (camera, time range, exporting user) saved alongside; a "verify clip" check.

## Access
- Per-user rights: which cameras each user may play back and export. Admin screens come later;
  until then only admins can play back/export server recordings. Permission checks exist from day one.

## Errors
- Camera silent: retry with the stall rules; gap on the timeline; NVR used for that stretch.
- Event feed lost: logged; that camera keeps everything (no thinning) until it's back.
- Disk full/failing: Storage page warning (email alerts later); ZFS keeps recording during resilver.
- Power loss: at most seconds lost; UPS shuts down cleanly.
- Disk priority: recording writes before playback/export reads.

## Testing
- Offline: segmenting, index, seeking, thinning, deletion, signing/verification with recorded clips and a
  fake SDK.
- Test PC: 3–5 cameras for several days; measure real storage per day and NVR outgoing-bandwidth
  headroom (nvr1 reports a 256 Mbit/s limit; recording adds ≈ 95 Mbit/s per NVR).
- R540: full run when it arrives.

## Out of scope (for now)
Admin screens for per-user rights, email alerts, direct RTSP recording, server-side analytics, blocking
direct NVR logins (owner manages).
