# Evidence export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Take a stretch of recorded footage from one or more cameras and produce a file the owner can hand to the police or an insurer, which plays on any PC and can be shown not to have been altered.

**Architecture:** Three independent pieces, then the glue. `export-pack.mjs` builds and signs the manifest (pure, so the proof of integrity is fully testable). `mp4.mjs` wraps the recorded frames in an MP4 container without re-encoding them — the footage in the export is bit-for-bit what the camera produced. `export-job.mjs` runs the work in the background with progress. The page gains clip selection and a dialog; a new Exports page lists what has been made.

**Tech Stack:** Node 24, `node:crypto` only (Ed25519 signing, SHA-256, scrypt, AES-GCM). No new npm dependencies, and **no ffmpeg for the video itself** — re-encoding would destroy the evidential value.

**Spec:** phase 4 of `docs/superpowers/plans/2026-09-25-roadmap.md`, and the export design agreed from the Milestone XProtect comparison.

## Global Constraints

- **The video is never re-encoded.** Frames go from the recorded segments into the container untouched. Any change to the pixels makes the export worthless as evidence.
- **The manifest is the proof.** It records a SHA-256 of every file, the camera, the NVR, the time range, each NVR's clock offset at the time, who exported it and when, and is signed with the server's Ed25519 key. Editing one byte of any file must make verification fail.
- **The signing key lives only on the server**, generated on first use, mode 0600, never in a backup that leaves the machine, never in an API answer.
- **Times are stated twice** where an NVR's clock was wrong: the server's time and that NVR's own time, with the offset. nvr1 runs about 220 s fast, and an export that quietly used one or the other could mislead a court.
- **A password encrypts the pack**, it does not merely hide it: AES-256-GCM with a key from scrypt. A wrong password must fail cleanly, not produce rubbish.
- **Exports are bounded**: refuse over 4 hours or over 50 GB in one job, and say why. A job must be cancellable and must not block recording.
- **Per-user rights are checked** through `rec-access.mjs` (`canPlayServer` today), not re-implemented.
- Tests are plain node scripts in `cctv/test/` with the existing `check()` helper, runnable on Windows.

---

### Task 1: The evidence pack — manifest, signing and verification

**Files:** create `cctv/export-pack.mjs`, `cctv/test/export-pack.test.mjs`

**Produces:**
- `ensureKey(dataDir)` → the server's Ed25519 key pair, created on first call
- `buildManifest({ files, clips, exportedBy, exportedAt, notes, clocks })` → the manifest object
- `signManifest(manifest, privateKey)` → `{ manifest, signature, publicKey }`
- `verifyPack(dir)` → `{ ok, problems: [] }` — re-hashes every file and checks the signature
- `encryptFile(src, dest, password)` / `decryptFile(src, dest, password)`

Cover in tests: a good pack verifies; a changed video byte fails; a changed manifest fails; a swapped signature fails; a missing file fails; the wrong password fails cleanly; the key is created once with mode 0600 and the private key never appears in the manifest or the signature output.

---

### Task 2: MP4 without re-encoding

**Files:** create `cctv/mp4.mjs`, `cctv/test/mp4.test.mjs`

Wrap H.264 and H.265 Annex B frames into a fragmented MP4. Read `cctv/public/sps.js` first — it already parses SPS for both codecs and is the reference for width, height and profile.

**Produces:** `writeMp4({ frames, codec, sps, pps, vps, timescale })` → a Buffer or stream, where `frames` are `{ bytes, ptsMs, keyframe }` in order.

Cover in tests: the boxes are well formed and in the right order; the track's codec configuration matches the SPS; the sample table's durations match the frame times; a variable frame rate is preserved; H.265 as well as H.264; an empty input is refused rather than producing a broken file.

Note honestly in the module header what players it was verified against and what it does not support.

---

### Task 3: The export job

**Files:** create `cctv/export-job.mjs`, `cctv/export-api.mjs`; modify `cctv/server.mjs`; tests alongside

Reads the segments for each camera and range through `rec-reader.mjs`, trims to the requested times at keyframe boundaries, writes the chosen format, builds and signs the manifest, and reports progress. Formats: `pack` (the original segments plus the manifest plus a single-file HTML player), `mp4`, `stills`. Enforces the limits, is cancellable, and writes to a working folder then renames so a half-made export is never offered.

API: `GET /api/exports`, `POST /api/exports` (start), `GET /api/exports/:id` (progress), `GET /api/exports/:id/download`, `DELETE /api/exports/:id`.

---

### Task 4: The player in the pack

**Files:** create `cctv/public/pack-player.html` (a single self-contained file copied into every pack)

Opens from the file system with no install, verifies the signature in the browser with WebCrypto, shows the manifest, plays each clip, and states clearly whether verification passed. It must say plainly when a file has been altered.

---

### Task 5: Clip selection and the dialog

**Files:** modify `cctv/public/playback.html`, `playback.js`, `style.css`; create `cctv/public/exports.html`, `exports.js`

Timeline handles, typed times, `[` and `]`; the dialog from the mockup (cameras, format, name, notes, password, burn-in, and the clock-offset warning); progress in the header; and an Exports page listing what has been made, with download and delete.

---

## Order

Tasks 1 and 2 are independent and can be built at the same time. Task 3 needs both. Tasks 4 and 5 need Task 3's API shape but not its internals.
