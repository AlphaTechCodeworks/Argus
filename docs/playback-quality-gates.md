# Playback quality release gates

Operator priority: smooth playback, responsive timeline, seeking, UI responsiveness, scalability, then resource efficiency. A resource optimization that worsens the first four is rejected.

The experimental paused-frame cap is disabled: fewer retained surfaces alone is not a playback improvement. Exact pause/resume chronology is a required acceptance test before it can be considered.

## Measurement protocol

Use the same machine, browser version, camera/clip, codec, decoded dimensions, source, playback speed, network profile and foreground state in baseline and candidate runs. Record other active views. Report sample count and cold/warm state. Compare alternating baseline/candidate runs rather than one favorable run.

Measure seek command to the first correct target frame, not merely a keyframe poster. Run at least 30 seek targets per source and report median/p95/max; target p95 below 200 ms where the source permits it. Report NVR, local server recording, network storage and converted playback separately. An unavailable GOP, SDK session startup or cold remote storage is a measured limitation, not a reason to report an inaccurate success.

Frame pacing: record decoded and presented frame timestamps, wall presentation times, dropped/late frames, maximum uninterrupted freeze and inter-frame error against the source cadence. A 25 fps camera should have consistent 40 ms media intervals; the timeline should independently remain responsive at the display refresh rate. Average FPS alone cannot demonstrate absence of micro-stutters.

UI: measure pointer input to timeline paint, requestAnimationFrame intervals and long tasks. At 60 Hz use a 16.7 ms frame budget; no main-thread long tasks attributable to archive reads, thumbnail work or metadata processing. Include zoom, pan, scrub, keyboard controls and background loading.

Synchronization: use a shared reference clock and measure actual frame-presentation drift across cameras, including gaps, reconnects and speed changes. Do not infer synchronization from equal requested seek times.

Long-run tests: at least two hours initially, then overnight; record heap, decoded surfaces, process RSS, descriptors, reader/cache occupancy, queues and memory after repeated seek/source changes and teardown.

Archive tests: 100/500/1,000-camera equivalent metadata sets; real footage throughput is a separate ingest test. Report row counts, query plans, query latency, event-loop delay, storage service time and contention with recording, thumbnails, housekeeping and backfill.

## Changes to investigate, with honest impact estimates

| Change / cause | Smoothness impact | Seek impact | CPU impact | GPU impact | Complexity |
|---|---|---|---|---|---|
| Move synchronous SQLite writes, queries and checkpoints away from the playback service thread | Expected to remove stalls caused by database work; must measure event-loop p99 | Expected to reduce contention spikes, not necessarily indexed lookup time | Similar work plus worker messaging | None directly | High: consistency, ownership, cancellation and shutdown |
| Prioritized storage scheduler; foreground seeks/frames before thumbnails and prefetch | Expected to reduce starvation and segment-boundary stalls under contention | Expected to improve loaded-system p95 | Small scheduler overhead | None directly | Medium–High: per-store fairness and deadlines |
| Shared immutable keyframe-index cache with byte budget and safe leases | Expected to reduce file-open/index parsing stalls | Expected warm-seek improvement; no cold-I/O guarantee | Lower repeated parsing; cache bookkeeping | None directly | Medium |
| Warm GOPs/thumbnail pyramid with explicit background I/O budget | Expected neutral playback impact if admission is correct | Faster visual scrub previews; exact seek still requires decoding | More background work, less interactive work | Optional thumbnail worker load | High |
| Off-main-thread decode/render benchmark using worker WebCodecs + OffscreenCanvas | Expected fewer UI-thread hitches where rendering is the cause | May reduce UI delay; decoder setup unchanged | Work moves threads; total CPU may stay similar | Backend-dependent; must profile copies/upload | High |
| Hardware decode → scale → encode for remote fit | Expected more stable conversion under CPU load, subject to GPU capacity | May reduce conversion/preroll latency | Expected lower conversion CPU, unquantified | Higher media-engine utilization | High; usable GPU is unverified on current VM |
| Predictable decoder and conversion admission; no silent SD downgrade | Prevents oversubscription, but a capacity refusal must be explicit | Neutral for admitted streams | Bounded | Bounded | Medium–High |
| Decode GOPs and reverse decoded frames instead of only showing keyframes | Can improve slow reverse motion, at substantial resource cost | Requires GOP prefetch and cache; may worsen cold seek | Higher decode work | Higher media/surface load | High |
| Shared multi-camera presentation clock with coordinated seek generations | Expected reduced drift and no stale-seek frames | Faster coherent perceived seek if all streams ready | Small scheduling overhead | More simultaneous surfaces | High |

These are directional estimates, not measured percentage gains. Ship only after the relevant gates pass. No dropped-frame, seek-speed, zero-stutter or enterprise-scale claim is made without its corresponding measurements. Do not change source codec, recording quality, timeline detail or normal playback frame retention merely to improve a resource number.
