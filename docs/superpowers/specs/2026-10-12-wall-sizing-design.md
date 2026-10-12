# Wall sizing: decoder budget + best-size recommendation — design

- Date: 2026-10-12
- Status: DRAFT (revised after review 2026-10-12) — build gated on a memory-breakdown probe (Phase 1); decisions flagged in "Decisions to confirm"
- Area: Argus live wall (`cctv/public/viewer.js`, `wall-thin.js`, `wall-profile.js`, `player.js`, `cctv/wall-tolerance.mjs`, `sicex.mjs`, `telemetry.mjs`)
- Author: Claude (Opus 4.8) with Mike

## Why

Measured on the test PC against prod on 2026-10-12 (apsi cohort, engine on):

| wall | live tiles | % frames shown | decoder hold (median / p90) | notes |
|---|---|---|---|---|
| 16 (4×4) | 5 | 33% | low / 0.7 s | comfortable |
| 36 (6×6) | 13 | 38% | 94 ms / ~2 s | mostly smooth; slow tail = NVR clumping |
| 100 (10×10) | 8 | 26% | 2.7 s / 4.5 s | overloaded; **crashed the browser on one open** |

Two problems surfaced, both about the *viewing PC's* limits, not the server:

1. **Crash on open.** A 10×10 spins up ~100 video decoders at once; the startup surge (decoders + buffers, ~5 GB Chrome in older readings) can blow the tab before `wallThin` has anything to thin. A crash shows nothing — strictly worse than a smaller or degraded wall. **Caveat (unverified):** *what* exactly consumes that memory — the decoders, the ~100 canvases, socket buffers, or the page — has not been measured. Confirming it is Phase 1 below; the design assumes decoders dominate and must be checked before building.
2. **No steer to the right size.** The operator can pick a layout the screen can't handle. The app already *measures* per-screen performance (`wallProfile`) and *warns*, but never recommends a size, and nothing bounds resource use at open.

What already works and is NOT changing: `wallThin` gracefully degrades a running wall under load by showing the quiet tiles as stills while the busy ones stay live — **every camera stays on screen**. That behaviour stays.

## Goals

- Stop a large wall from crashing the browser on open, on any PC, **without ever removing a camera from the wall**.
- Reduce the resident RAM of a large wall (a consequence of the same mechanism).
- Recommend the best layout size for *this* screen, from data the app already collects — advisory only.
- Everything behind SICE-X switches, measured against the holdout, fully reversible. Honour the owner's rules: no fixed wall-size limits, layouts never removed, operator stays in control, core owns the evidence.

## Non-goals (explicitly out of scope)

- **Auto-shrinking a working wall / removing cameras automatically.** On a security wall, silently dropping cameras risks an operator missing an incident on a camera that vanished. We degrade frame *rate* (stills), never remove cameras.
- **Fixing the NVR/SDK frame-clumping tail** (the ~2 s p90 at 6×6). That originates upstream (see `frame-gaps.mjs`); separate work.
- **A standalone "decoder-teardown-for-stills" feature.** Subsumed here: the decoder budget covers it.
- **Server-side ingress reduction for thinned tiles** — having the server send keyframes-only for stills, cutting the ~45 Mbps / ~2,000 fps a big wall receives. Worthwhile but a separate server-side change; this spec is a client-decode fix and leaves ingress unchanged.

## The core idea: a per-screen decoder budget

Today every tile — live or still — holds its own persistent `VideoDecoder`, buffers and socket (`player.js setKeysOnly()` only flips a flag; it does not close the decoder). So N tiles = N decoders, regardless of thinning. That is both the open-time surge and the steady-state RAM.

The budget inverts this: **a screen keeps full decoders only for the tiles it can decode (its live set); every other tile is a still backed by a cheap shared path, not a persistent per-tile decoder.**

- The live budget = the largest live-tile count at which the screen's decoder keeps up — derived from telemetry by raising/lowering the count until the decoder hold (`decMs`) stays under a target (e.g. p90 ≤ ~400 ms), **not** a vague "capacity". On the measurements so far that is ~5 on the weak test PC, more on the control-room PC. The existing per-screen figures feed this but need this sharper definition: today's governor parks at counts that are still 2–4 s behind (see "Why"), so "what it currently keeps live" is not itself a safe budget.
- This **extends the existing `wallThin` governor rather than adding a second one.** `wallThin` already chooses *which* tiles are live (busiest by bitrate/motion); the budget is the *cap* on how many it keeps live, and the new part is that a non-live tile loses its **decoder**, not just its frame rate. One governor, one live set — no two systems fighting over selection.
- Still tiles: no persistent per-tile decoder (how their picture is produced is the freshness decision below).
- Promotion (still → live): build a full decoder for that tile (reusing the existing `player.js` reset+reconfigure path used for seeks), wait for the next keyframe, resume motion. The delay is **a GOP interval** (could be 2–4 s where keyframes are sparse), not instant; hysteresis bounds how *often* promotions happen, not how long each takes. Acceptable for a tile the operator did not single out.

Consequences, from this one mechanism:

- **Crash-safe open (Feature A):** peak decoders during open is bounded to ~budget + pool, never 100. Tiles open in waves — the live set first, the rest come up as stills. Every camera still appears, over a few seconds.
- **RAM reduction (Feature B):** steady state holds ~budget full decoders instead of N. On a 10×10 with a budget of ~8, that is ~8 decoders instead of 100. (How much total RAM that actually saves depends on the Phase-1 breakdown — if canvases/sockets dominate, the saving is smaller than the decoder count suggests.)

**What this does NOT reduce:** network and server load. A still keeps its socket open (to stay ready and, if refreshed, to catch keyframes), so the server still pushes all ~N substreams and the client still receives frames it mostly discards (~45 Mbps / ~2,000 fps arriving on a 10×10, unchanged). The larger efficiency win — having the *server* send keyframes-only for thinned tiles — is a separate server-side change (see Non-goals); this is a client-decode fix only.

### Still-tile picture freshness — decision

A still tile has no persistent decoder, so its picture has to come from somewhere. Options, simplest first:

- **Frozen snapshot (proposed default):** on demotion, grab the last frame to a static image, close the decoder, show the image; no refresh until promoted. Lowest RAM, simplest, robust. Cost: the picture is stale until the tile goes live again — acceptable because thinned tiles are, by definition, the quiet ones, and any tile the operator cares about is promoted.
- **Per-tile timed refresh:** keep the still frozen, but every few seconds briefly re-open *that tile's own* decoder, decode one keyframe, snapshot, close. Fresher pictures, more open/close churn, still bounded decoders.
- **Shared decoder pool (NOT recommended):** a pool of 2–4 decoders round-robins all stills. Rejected on review: a `VideoDecoder` is bound to one stream's config, so each refresh needs a `reset()`+`configure()` for that tile's SPS/PPS/resolution — dozens of reconfigures per cycle across a few decoders is heavy and can stall. The earlier draft proposed this; it is the riskiest option, not the simplest.

Proposed: **frozen snapshot** to start (prove the budget + crash fix with the fewest moving parts), add **per-tile timed refresh** only if stale stills prove a problem in use.

### Staggered open

Extend the existing open-concurrency throttle (`MAX_OPENING` in the wall) so that: the governor decides the initial live set from the screen's learned capacity *before* opening; live tiles open first (throttled), still tiles attach as snapshots without spinning a full decoder. This keeps the peak bounded from the first moment, which is where the crash happens.

## Feature C: best-size recommendation (advisory)

`wallProfile` already records, per browser, the share of frames drawn at each tile count, and the picker shows e.g. "6×6 · 81% shown". Extend it to compute a recommendation:

- **Best size** = the largest layout whose measured % shown on this screen clears the "fine" tolerance (`wall-tolerance.mjs`, default ≥ 80%).
- Show it in the layout picker: "Recommended for this screen: 5×5" plus a star on that option. Keep the existing "poor" warning on layouts below the poor threshold.
- **Cold start** (a screen with no data yet): recommend conservatively (a safe default size) and refine as data arrives; never block larger choices.
- **Applying it:** a screen with **no saved layout choice** opens at its recommended size; a screen where someone already chose a layout keeps that choice. Never forces, never removes layouts. *(Decision 2 — see below.)*

## Rules compliance

- No fixed wall-size limits: the budget and recommendation are *measured per screen*, not hard-coded caps; larger layouts remain selectable.
- Layouts never removed; cameras never removed from a chosen wall (stills, not drops).
- Operator in control: recommendation is advisory; staggered open changes *timing*, not *which* cameras.
- Switch-off-able: new SICE-X modules (below); with them off, the wall behaves exactly as today.
- Core owns the evidence: capacity/profile data stays server- and browser-side as now.

## SICE-X integration

Two new module switches in `sicex.mjs` `MODULES` (default on, holdout off, per-site opt-out, per-browser localStorage override — same pattern as the existing six):

- `decoderBudget` — the budget mechanism (Features A+B): bounds full decoders to the screen's capacity; stills via shared pool; staggered open.
- `sizeAdvice` — the best-size recommendation and picker starring (Feature C).

Both participate in the holdout A/B: the apsi cohort gets them, the holdout runs today's behaviour, and the experience score (`qoe.js`) says whether they help before they are trusted.

## Measurement / how we'll know it helped

- `telemetry.mjs` already carries per-tile `in`/`fps`/`decMs`/`skip` and the walls table. Add, per big-wall session: peak concurrent full decoders, open-to-first-frame for the live set, and promotion latency.
- **The two benefits are measured differently — this matters.** Crash-prevention and RAM are **not** visible to the holdout A/B: a crashed browser sends no telemetry, and RAM is not in telemetry. They are judged by the **Phase-1 probe repeated after the build** — open a 10×10 on the weak test PC and confirm no crash, peak decoders ≈ budget, and resident RAM materially lower (browser task manager, before/after). The holdout cohort score (`qoe.js`) only tells us the *rest* of the experience (smoothness/startup) did not regress — apsi should stay ≥ holdout.
- For `sizeAdvice`: the recommended size scores ≥ tolerance on the screens that accept it.

## Edge cases

- Single camera / small grids (≤ budget): no change — all tiles live, no stills, no staggering needed.
- Promotion churn: hysteresis — a tile must be "wanted live" for a few seconds before a full decoder is built, and "not wanted" for a few seconds before it drops back to a still. Prevents thrash on flickering motion.
- A still that is clicked/opened full-size: promote immediately (user intent overrides hysteresis).
- Codec variation (H.264 sub vs H.265 main, resolution): decode cost per tile varies, but the budget is derived from *measured* draw capacity, which already reflects it. HEVC-without-hardware screens simply get a smaller budget.
- Playback / fast-forward walls: the budget applies the same; the existing ahead/clock logic is unaffected.

## Testing (TDD)

- Pure unit tests for: budget sizing from a capacity figure; still/live selection + hysteresis state machine; recommendation = largest size clearing tolerance (incl. cold-start and all-poor cases); shared-pool round-robin scheduling. These must not load the native SDK `.so` (run on Windows; full suite stays CI/Linux-only).
- Player tests for: close-on-demote frees the decoder; promote rebuilds via the seek reset+reconfigure path and resumes on the next keyframe; snapshot shown while no decoder.
- A replay/integration check that peak concurrent decoders stays ≤ budget + pool while opening a large wall.

## Rollout / deploy

- As of 2026-10-12 **prod == branch HEAD** (the Codex branding is now on the branch too), so a **normal full deploy from the branch is clean and preferred**. The surgical overlay (copy current release → new, overlay only changed files, switch symlink, restart; rollback = flip the symlink back) is the **fallback for when branch and prod have diverged again** — this repo has concurrent sessions committing to the branch, so check `git diff` of the changed files against the running release before deploying.
- Ship `decoderBudget` and `sizeAdvice` behind their switches, default on for apsi, and watch the holdout comparison before calling it proven.

## Phasing (recommendation)

1. **Let the holdout gather** (in flight). The measure-first question — is the engine helping at all? — is unanswered until the 1-in-2 holdout accrues data on a representative wall left open. Nothing below is built before there is a read on that.
2. **Phase 1 — memory-breakdown probe (spike, no feature code).** Open a 10×10 on the weak test PC and measure what actually consumes memory (decoders vs the ~100 canvases vs socket buffers vs the page) and what precedes the crash. This **confirms or redirects the design's premise** that decoders are the culprit. Output is an answer, not code. **Do not build Feature A+B until this confirms it.**
3. **If the probe confirms it: Feature A+B (`decoderBudget`)** — removes the crash and cuts RAM; highest value.
4. Then **Feature C (`sizeAdvice`)** — advisory, cheap, reuses existing data.

## Decisions to confirm (Mike)

0. **Build is gated on Phase 1.** Feature A+B is not built until the memory-breakdown probe confirms decoders are what crashes the wall / holds the RAM. If the probe says otherwise, this spec is redirected first.
1. **Crash guard mechanism** — proposed: **staggered/budgeted open** (keeps every camera, bounds peak decoders). Alternative was a hard size cap that removes cameras (rejected here as unsafe for a security wall). Confirm staggered, or ask for the cap/both.
2. **Recommendation application** — proposed: **mark it always + default only screens with no saved choice** to the recommended size. Alternative: mark only, never change any default. Confirm which.
3. **Still freshness** — proposed (revised): **frozen snapshot** to start; add per-tile timed refresh later only if stale stills bite. The earlier shared-pool idea is rejected as too complex (see that section). Confirm.
