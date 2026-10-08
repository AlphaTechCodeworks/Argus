# Playback performance work — 8 October 2026

Status: first validated batch deployed in release `20261008-201130-review`: queued read-ahead, truthful decoder preference labels and queue diagnostics. Experimental paused-memory cap remains disabled. Structural work below is outstanding; this is not a claim that every architectural improvement is complete.

## Repeatable measurements

Baseline: Git commit `8002ca0`. Candidate: the working tree based on that commit.
Same Node runtime, fixture, dimensions, frame count and timing for both runs. Browser/GPU allocations and production throughput are not inferred from these fixtures.

| Fix | Before | After | Measured difference | Measurement boundary |
|---|---:|---:|---:|---|
| Paused 3840×2160 decoded-frame retention | 90 frames | 8 frames | 91.1% fewer retained frames | Real player with a mock WebCodecs decoder; frames counted, not GPU memory sampled |
| Corresponding 8-bit YUV420 image estimate | 1,067.9 MiB | 94.9 MiB | 973.0 MiB lower | Calculated from retained frames × pixels × 1.5; excludes alignment, decoder surfaces and other caches |
| Running decoded-frame retention | 45 frames | 45 frames | Unchanged | Running jitter buffer deliberately preserved |
| Simultaneous read-ahead requests completed | 1 of 16 | 16 of 16 | 15 additional requests completed | Mock storage, simultaneous requests within the queue limit; not a disk-speed benchmark |
| Read-ahead concurrent storage reads | 1 | 1 | Unchanged | Shared 1 MiB scratch buffer; bounded pending queue of 32 |
| Repeated requests for the same pending path | Deduplicated/dropped | Deduplicated | No duplicate read | Verified with duplicate submissions |
| Retrying a failed read-ahead request | Path marked completed before success | Retry succeeds | Retryability restored | Injected storage-open failure |

Reproduce the default with `node cctv/test/player-memory-benchmark.mjs`, the experimental cap with `node cctv/test/player-memory-benchmark.mjs --paused-cap`, and prefetch with `node cctv/test/read-ahead.test.mjs`. The latter also exercises the old busy guard to produce its baseline result. **The memory reduction is an opt-in experiment; production operator views do not enable it.**

### Memory fix and tradeoff

`public/player.js` exposes an optional paused image budget, tested using a conservative four-byte-per-coded-pixel estimate and 256 MiB. It is disabled by default because of the chronology tradeoff below. The estimate is a budget model, not an allocator guarantee. The existing 90-frame maximum still applies to smaller pictures. Very large frames retain at least two frames. Running playback retains its existing clock buffer.

When frames continue arriving after a pause, the paused queue can discard older decoded frames sooner. This bounds memory but can advance the first resumed picture. Exact frame-preserving pause requires server flow control plus a bounded compressed-packet queue; this patch does not implement that redesign. No recording file is modified.

### Read-ahead fix and tradeoff

`rec-playback.mjs` previously returned immediately whenever the global warmer was busy. Concurrent viewers therefore missed prefetch. `read-ahead.mjs` retains a bounded, deduplicated queue and processes it serially. Only successful paths enter the completion cache. The queue does not accelerate individual reads, and it can create additional total background I/O because previously discarded requests now run. No unbounded concurrency is introduced.

### Diagnostic accuracy

The decoder overlay now says **hardware preferred**, rather than **hardware**. `prefer-hardware` is a WebCodecs configuration preference, not evidence of the actual decoder backend. No performance gain is claimed for this correction.

## Validation

Windows player, burst, maximum-frame-rate and speed suites: 4 suites passed. Two additional Windows suites had CRLF-sensitive source assertions; line-ending normalization restores their assertions without changing expected behavior. Those 2 suites now pass.

Linux staging recording playback, waits, player, bursts, rewind, clock and read-ahead tests: **7 suites passed, 0 failures**, 143.2 seconds. These fixtures check behavior; they are not 1,000-camera throughput tests.

Final Windows player/burst/rewind/clock/presence/session validation: **6 suites passed, 0 failures**. Linux account suites: **5 suites passed, 0 failures**. Real HTTP staging tests passed admin-only user sign-out, refusal of self-sign-out through the admin action, immediate old-cookie invalidation, fresh login, LAN/Web metadata, mandatory password replacement after reset and session replacement. Fake accounts and isolated temporary data were used; no production user was kicked or had a password changed during tests.

Users & access now lists recent authenticated sessions with LAN/Web and IP address. A shared shell heartbeat runs every 30 seconds; inactive sessions expire from the list after 120 seconds. An administrator's Sign out user action invalidates all existing cookies and closes tracked WebSockets. Passwords and permissions are preserved. A new login remains allowed. Current-user sign-out uses the sidebar rather than the admin action.

Paused-memory and read-ahead measurements are deliberately not reported as production FPS or seek-time improvements. Browser diagnostics now expose queued decoded frames, estimated image storage and decoder queue length under the D shortcut for repeatable future measurements.

## Production observations, not before/after speed claims

The server exposes 8 logical CPUs and approximately 17.6 GiB RAM. Its DRM PCI IDs are `15ad:0405`, a VMware virtual graphics device. The existence of `/dev/dri/renderD128` and FFmpeg's list of compiled hardware APIs does not prove a usable media decoder/encoder. NVIDIA tooling was not found in the inspected environment. GPU passthrough or a supported media device must be established before enabling hardware conversion.

Browser baseline: Lawrence, PW Exit, 8 October, NVR source, 1×; overlay reported H.264 3200×1800, 1,000 ms buffer, 19,208 ms startup and 1 displayed fps in the sampled interval. This single session has not been a controlled repeated experiment and must not be represented as a universal playback speed or a candidate regression. Its cause needs separate investigation. Screenshot saved as `playback-baseline.png` in the task artifacts.

## Remaining work and measurement gates

| Priority | Area / root cause | Required change | Acceptance measurement |
|---|---|---|---|
| High | SQLite `DatabaseSync` and WAL commits/checkpoints on playback's server thread | Dedicated metadata writer/reader worker API; bounded requests, deadlines, batch writes and monitored checkpoints | Event-loop p95/p99; query p50/p95/p99; insert throughput and WAL size under representative ingest plus playback |
| High | Running decoded buffers scale with resolution and independent viewers | Shared client decode admission budget; controlled FPS/quality policy, preserving the requested main stream where available | Real browser CPU/GPU memory, rendered fps, longest freeze and dropped-frame ratios for 1/4/9 main streams |
| High | Remote resizing/keyframe paths select software conversion | Capability-tested GPU decode → scale → encode pipeline, software fallback and admission limits | Same clip/quality: CPU time, wall time, output bitrate, first-frame latency and concurrent capacity; hardware prerequisite currently unverified |
| High | NVR-source seek opens a new playback session | Investigate SDK-supported in-session seeking and reliable command sequencing | 30 identical seek targets; cold/warm median and p95 first-picture time; no stale frames |
| High | Archive grows by camera-minutes | Preserve `(nvr,ch,start_ms)` index and keyset pagination; partition metadata/recording services by site when measurements require it | Query plans and timings at 100/500/1,000-camera equivalent archives; bounded result sizes |
| High | Paused decoded-frame cap trades memory for retained chronology | Compressed-packet pause buffering with upstream acknowledgement | Frame-by-frame pause/resume correctness, bounded memory and no continuous decoding while paused |
| Medium | Prefetch queue lacks user-activity priorities/cancellation | Session-aware priorities, canceled obsolete seeks, per-storage bandwidth limits | Bytes read versus used; seek p95 during recording and NAS contention; queue fairness |
| Medium | Reader cache is 64 readers per session, not a process-wide byte budget | Shared immutable keyframe metadata cache, byte accounting and safe reader leases | File descriptors, heap/RSS, cache hit ratio and seek p95 across 16/64 viewers |
| Medium | Reverse/high-speed playback uses keyframes | Keep keyframe scanning explicit; optional GOP decode/reorder for smooth reverse | Review coverage, seek responsiveness and resource cost at −1×/2×/4×/8×/16× |
| Medium | Timeline uses recording ranges/events but no universal thumbnail pyramid | Background low-resolution thumbnail sprites at multiple time scales, permission-aware cache | Scrub-to-preview p95, thumbnail hit rate and generation I/O; no full-resolution decode per pointer move |
| Medium | Canvas 2D rendering shares UI thread work | Benchmark worker decoder + OffscreenCanvas; consider WebGPU only when measured beneficial | Main-thread long tasks, GPU upload/composition time and dropped frames at identical stream settings |
| Medium | Multi-camera playback already exists; sync quality needs measuring | Explicit master clock, drift metrics, generation-wide seeks and per-camera missing-footage state | Camera-pair presentation drift p95/max across gaps, speed changes and slow sources |
| Medium | Fixed remote fit ceiling plus adaptive clocks | Rate ladder with hysteresis, capacity telemetry and no destructive quality oscillation | Stall seconds/minute and quality under shaped bandwidth, jitter and packet-loss profiles |
| Medium | Replay/index telemetry lacks one consolidated performance report | Export reproducible test metadata and source/decoder/queue/storage timing summaries | Reports include codec, dimensions, source, visibility, warm/cold state and percentile sample counts |
| Medium | Enterprise capacity and fault isolation | Site recording workers, storage pools, central catalog, quota/admission rules, backup restore and failover drills | Recording loss, recovery time and playback behavior under worker/NAS/site failures |
| Low | Operator workflow | Preserve existing keyboard shortcuts/bookmarks/events; add saved investigation workspaces and clear source/quality badges | Task timings and keyboard completion tests; accessibility checks |

No deadlock, memory leak or race is declared proven solely from static inspection. Existing seek-generation guards, decoder/frame cleanup, bounded transport queues, parameterized indexed lookups, shared conversions, stale-response tokens and hidden-live-tab release should be preserved.

## Scale assumptions

At one segment per minute, continuous recording produces 4.32/21.6/43.2 million segment rows over 30 days for 100/500/1,000 cameras. Actual counts depend on recording schedule, gaps and segment duration. At 4 Mbit/s per camera, aggregate input is 0.4/2/4 Gbit/s and 30-day video volume is approximately 129.6/648/1,296 TB, before overhead/replication. Camera count alone is not a decoder-capacity target: only active operator views should decode.

## Enterprise feature direction

Prioritize synchronized investigations, searchable event/object metadata, evidence packages with integrity manifests, privacy masks, retention holds, saved multi-monitor workspaces and site federation. Existing bookmarks, event navigation, motion search, exports and multi-camera playback should be extended rather than duplicated.

References: [WebCodecs](https://www.w3.org/TR/webcodecs/), [SQLite WAL](https://www.sqlite.org/wal.html), [NVIDIA decoder capabilities](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvdec-application-note/index.html), [Intel VPL](https://www.intel.com/content/www/us/en/developer/tools/vpl/overview.html), [Milestone playback](https://doc.milestonesys.com/xprotect/xprotect-smart-client/2026r1/en/viewing-and-recordings.html), [Nx enterprise](https://www.networkoptix.com/gen-6-enterprise), [Avigilon Appearance Search](https://docs.avigilon.com/bundle/unity-video-player-8-0/page/using/appearance-search.htm), [Genetec export](https://techdocs.genetec.com/r/en-US/Security-Center-User-Guide-5.13/Video-export).
