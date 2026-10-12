# Wall sizing: decoder budget + best-size recommendation — design

- Date: 2026-10-12
- Status: DRAFT — for Mike's review (two decisions flagged, see "Decisions to confirm")
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

1. **Crash on open.** A 10×10 spins up ~100 video decoders at once; the startup surge (decoders + buffers, ~5 GB Chrome in older readings) can blow the tab before `wallThin` has anything to thin. A crash shows nothing — strictly worse than a smaller or degraded wall.
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

## The core idea: a per-screen decoder budget

Today every tile — live or still — holds its own persistent `VideoDecoder`, buffers and socket (`player.js setKeysOnly()` only flips a flag; it does not close the decoder). So N tiles = N decoders, regardless of thinning. That is both the open-time surge and the steady-state RAM.

The budget inverts this: **a screen keeps full decoders only for the tiles it can decode (its live set); every other tile is a still backed by a cheap shared path, not a persistent per-tile decoder.**

- The live budget = the screen's learned decode capacity (already tracked by `wallThin`/`wallProfile`; roughly "tiles it can draw at rate", e.g. ~5 on the weak test PC, more on the control-room PC).
- Live tiles: full decoder, as now. Chosen by the existing `wallThin` governor (busiest by bitrate/motion).
- Still tiles: show a **frozen snapshot** of their last frame; a small **shared decoder pool** cycles through them decoding one keyframe every few seconds to keep the picture current. No persistent per-tile decoder.
- Promotion (still → live): build a full decoder for that tile (reusing the existing `player.js` reset+reconfigure path used for seeks), wait for the next keyframe, resume motion. Small delay (≤ ~1 s) on promotion — acceptable, and bounded by hysteresis.

Consequences, from this one mechanism:

- **Crash-safe open (Feature A):** peak decoders during open is bounded to ~budget + pool, never 100. Tiles open in waves — the live set first, the rest come up as stills. Every camera still appears, over a few seconds.
- **RAM reduction (Feature B):** steady state holds ~budget full decoders instead of N. On a 10×10 with a budget of ~8, that is ~8 decoders + a small pool instead of 100.

### Still-tile picture freshness — decision

Two ways to keep a still current, trading RAM for staleness:

- **Shared pool refresh (recommended):** a pool of M transient decoders (M small, e.g. 2–4) round-robins the still tiles, decoding one keyframe each, so every still refreshes every few seconds. Bounded decoders, pictures stay reasonably current.
- **Frozen snapshot only:** close the decoder, keep the last frame as a static image, never refresh until promoted. Lowest RAM, but a still goes stale (a camera that changes won't update). Worse for a security wall.

Proposed: shared pool refresh, with refresh interval following the screen's spare capacity (fewer live tiles → faster still refresh). Fall back to frozen snapshot only if even the pool is over budget.

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
- Success looks like: **no crash on open at 10×10 on a weak PC**; peak decoders ≈ budget; a 10×10's resident RAM materially lower (measured in the browser task manager, since RAM is not in telemetry); the recommendation's chosen size scoring ≥ tolerance; and the apsi cohort's experience score ≥ holdout.

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

- Same surgical overlay as the holdout-fraction deploy: prod diverges from this branch (Codex branding lives only on prod), so **never** a blanket `push.sh`; copy current release → new, overlay only the changed files (rebasing any `public/` file onto the current release first), switch symlink, restart. One restart. Rollback = flip the symlink back.
- Ship `decoderBudget` and `sizeAdvice` behind their switches, default on for apsi, and watch the holdout comparison before calling it proven.

## Phasing (recommendation)

1. **First, let the holdout gather.** The core measure-first question — is the engine helping at all? — is still unanswered because the holdout is data-starved. Set it to 1-in-2 and leave a representative wall open for a few days before building either feature.
2. Then **Feature A+B (`decoderBudget`)** — it removes a hard failure (the crash) and cuts RAM; highest value.
3. Then **Feature C (`sizeAdvice`)** — advisory, cheap, reuses existing data.

## Decisions to confirm (Mike)

1. **Crash guard mechanism** — proposed: **staggered/budgeted open** (keeps every camera, bounds peak decoders). Alternative was a hard size cap that removes cameras (rejected here as unsafe for a security wall). Confirm staggered, or ask for the cap/both.
2. **Recommendation application** — proposed: **mark it always + default only screens with no saved choice** to the recommended size. Alternative: mark only, never change any default. Confirm which.
3. **Still freshness** — proposed: shared decoder pool refresh (current pictures, bounded decoders) over frozen-snapshot-only (lowest RAM, stale). Confirm.
