# Playback redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the playback controls with the design agreed from the mockup: a big clock you can type into, a zoomable two-lane timeline showing where footage came from, a spring-back shuttle for seeking, frame stepping, one-click speeds, snapshots, and a seamless join when the NVR fills a gap.

**Architecture:** The awkward part of `public/playback.js` is that its maths and its DOM are tangled, so nothing can be tested without a browser. This plan pulls the maths into two pure modules — `pb-view.js` (the zoom/pan window, ticks, lane layout) and `pb-transport.js` (shuttle rate, speeds, frame step) — each fully unit-tested the way `pb-sources.js` already is, then rewires the page to use them. The seamless NVR handover is server-side and lands last, because it is the only part that cannot be proven without real footage.

**Tech Stack:** Plain ES modules, no framework, no new dependencies. Tests are plain node scripts in `cctv/test/` using the existing `check()` helper.

**Spec:** the agreed mockup at `scratchpad/mockup/cctv-mockup.html`, and phase 2 of `docs/superpowers/plans/2026-09-25-roadmap.md`.

## Global Constraints

- **No new npm dependencies.**
- **Pure modules import nothing from the DOM.** `pb-view.js` and `pb-transport.js` must run under plain `node` so their tests work on any machine.
- **Server playback only for the new speeds.** The NVR's own playback cannot do reverse or speeds above 8×; at those, behaviour falls back to what the page does today. Never send a speed the NVR session will reject.
- **Times on screen are the server's clock.** NVR times are converted with `-skewMs` exactly as `pb-sources.js` already does. Never show two different time bases in one view.
- **Tests must be timezone-independent** — derive expected clock strings with the same formatter rather than hard-coding them. (This bit us in the health page tests.)
- **Copy style:** sentence case, plain words, no exclamation marks.
- **Tests run with** `node cctv/test/<file>.test.mjs`. Anything importing `nvrs.mjs` needs the native SDK and will only run on the server.

---

### Task 1: The view window (zoom, pan, ticks, lanes)

Everything about *what part of the day is on screen and where things sit in it*. Pure.

**Files:**
- Create: `cctv/public/pb-view.js`
- Test: `cctv/test/pb-view.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const DAY_S = 86400`
  - `export function makeView({ spanS, startS, minSpanS, maxSpanS })` → `{ spanS, startS, endS }` clamped
  - `export function zoomAt(view, factor, atS)` → a new view, keeping `atS` under the same pixel
  - `export function panBy(view, deltaFraction)` → a new view
  - `export function follow(view, atS, { edge })` → a new view that keeps `atS` in sight, or the same view
  - `export function tickStep(spanS)` → the seconds between labels
  - `export function ticks(view)` → `[{ s, label }]`
  - `export function fmtClock(s, { ms })` → `"09:34:48"` or `"09:34:48.199"`
  - `export function laneBoxes(view, ranges)` → `[{ leftPct, widthPct, kind, from, to }]` clipped to the view
  - `export function spanLabel(spanS)` → `"1 h"`, `"48 min"`, `"30 s"`

- [ ] **Step 1: Write the failing test**

Create `cctv/test/pb-view.test.mjs`. Cover at least:
- `makeView` clamps `spanS` to `[minSpanS, maxSpanS]` and `startS` so the window never leaves the day; a full-day span pins `startS` to 0.
- `zoomAt` keeps the second under the pointer fixed: after `zoomAt(v, 0.5, t)`, the fraction `(t - startS) / spanS` is unchanged (within rounding).
- `zoomAt` at the very start and very end of the day still produces a valid window (this is where naive maths goes out of range).
- `zoomAt` cannot zoom past `minSpanS` or `maxSpanS`.
- `panBy` moves by a fraction of the span and clamps at both ends.
- `follow` returns the same object when `atS` is comfortably inside, and re-centres when it is past `edge` (default 0.9).
- `tickStep` picks a step giving at most 8 labels, from the ladder `1, 5, 10, 30, 60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200`.
- `ticks` labels seconds below a minute span (`09:34:50`) and minutes above (`09:35`), and every tick is inside the view.
- `fmtClock` pads correctly and shows milliseconds only when asked.
- `laneBoxes` clips a range that starts before the view and one that ends after it; drops ranges entirely outside; gives a visible minimum width to a range narrower than 0.1 % so a one-second gap is still clickable.

- [ ] **Step 2: Run it and see it fail**

Run: `node cctv/test/pb-view.test.mjs` — expect `Cannot find module`.

- [ ] **Step 3: Implement `pb-view.js`**

Keep every function pure and returning new objects. Clamp in one place (`makeView`) and have `zoomAt`/`panBy`/`follow` route through it, so there is one definition of "a valid window".

- [ ] **Step 4: Run it and see it pass**

- [ ] **Step 5: Commit**

```bash
git add cctv/public/pb-view.js cctv/test/pb-view.test.mjs
git commit -m "feat(playback): pure view window — zoom, pan, ticks and lane layout"
```

---

### Task 2: Transport (shuttle, speeds, frame step)

Everything about *how fast and which way time moves*. Pure.

**Files:**
- Create: `cctv/public/pb-transport.js`
- Test: `cctv/test/pb-transport.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const SPEEDS` — `[0.25, 0.5, 1, 2, 4, 8, 16]`
  - `export function shuttleRate(position, { dead })` → a signed speed from `SPEEDS`, or 0 inside the dead zone. `position` is -1…1.
  - `export function shuttleLabel(rate)` → `"paused"`, `"▶ 4×"`, `"◀ 2×"`
  - `export function allowedSpeeds(mode)` → what this source can do (`'server'` all of `SPEEDS` and reverse; `'nvr'` only 1–8 forward)
  - `export function clampSpeed(speed, mode)` → the nearest speed the source allows, and whether it had to change
  - `export function frameStep(currentS, direction, fps)` → the next second to show
  - `export function needsKeyframesOnly(rate)` → true at 8× and above, and for any reverse rate

- [ ] **Step 1: Write the failing test**

Cover:
- the dead zone: `|position| < dead` gives 0 and the label `paused`
- the far ends give ±16×, the middle-ish gives small speeds, and every result is a member of `SPEEDS`
- symmetry: `shuttleRate(-p)` is the negative of `shuttleRate(p)`
- `allowedSpeeds('nvr')` excludes reverse and anything above 8
- `clampSpeed(16, 'nvr')` gives 8 and reports that it changed; `clampSpeed(-2, 'nvr')` gives 1 and reports a change; `clampSpeed(4, 'server')` is unchanged
- `frameStep` moves by `1/fps` and never goes below 0
- `needsKeyframesOnly` is true at 8× and 16× and for every reverse rate, false at 1–4× forward

- [ ] **Step 2: Run it and see it fail**

- [ ] **Step 3: Implement `pb-transport.js`**

- [ ] **Step 4: Run it and see it pass**

- [ ] **Step 5: Commit**

```bash
git add cctv/public/pb-transport.js cctv/test/pb-transport.test.mjs
git commit -m "feat(playback): pure transport — shuttle, speeds and frame step"
```

---

### Task 3: Live grid tile dots

Small and self-contained: a dot on each live tile — green when video is arriving, red when that camera is also being recorded, grey when nothing is coming.

**Files:**
- Modify: `cctv/public/live-tile.js` (state), `cctv/public/style.css` (the dot)
- Test: extend `cctv/test/live-tile.test.mjs`

**Interfaces:**
- Produces: `export function tileDot({ hasVideo, recording, stale })` → `{ className, title }`

- [ ] **Step 1: Add failing tests to `cctv/test/live-tile.test.mjs`**

- video arriving, not recorded → `dot-live`, title "video is arriving"
- video arriving and recorded → `dot-rec`, title mentions recording
- no video → `dot-off`, title says nothing is arriving
- stale (video stopped arriving recently) → `dot-off`, not `dot-live`

- [ ] **Step 2: Run and see it fail**
- [ ] **Step 3: Implement `tileDot`, render it on each tile, add the CSS**
- [ ] **Step 4: Run and see it pass**
- [ ] **Step 5: Commit**

---

### Task 4: Rewire the playback page

The DOM work: new control bar, two-lane timeline, overview strip, shuttle, clock you can type into, snapshot, tools. Uses Tasks 1 and 2 for every calculation.

**Files:**
- Modify: `cctv/public/playback.html`, `cctv/public/playback.js`, `cctv/public/style.css`
- Reference: `scratchpad/mockup/cctv-mockup.html` — the agreed layout and interactions

**Steps (each ending in a working page):**

- [ ] **Step 1: Control bar markup** — date arrows, clock button plus hidden input, span label, zoom presets, follow button, overview strip, timeline, ticks row, then speed on the left, transport centred, tools on the right, shuttle below, legend last.
- [ ] **Step 2: Wire the view** — replace the existing zoom handling with `pb-view.js`: wheel zoom centred on the pointer, drag to pan, pinch, double-click to seek, `+` `−` `0`, the overview strip with a draggable window, and follow mode that switches off when you pan.
- [ ] **Step 3: Lanes** — draw recorded stretches by source using `laneBoxes`: server, from-NVR (striped, so it reads without colour), gaps in red with the reason on hover, and a taller motion lane whose blocks jump when clicked. Bookmarks come in phase 3; leave the lane in place.
- [ ] **Step 4: Transport** — the shuttle using `pb-transport.js`, speed buttons, frame step with `,` and `.`, and `clampSpeed` so an NVR leg never receives a speed it will refuse (tell the viewer once when it is clamped).
- [ ] **Step 5: Clock** — click or `T` to type a time; `Enter` seeks, `Escape` cancels; milliseconds appear under a two-minute span.
- [ ] **Step 6: Snapshot** — draw the current frame to a canvas and download it as `<camera> <date> <time>.jpg`.
- [ ] **Step 7: Shortcut list** — `?` opens it; keep it in step with the handlers.
- [ ] **Step 8: Phone layout** — controls wrap with the transport first; check at 375 px wide.
- [ ] **Step 9: Buffering** — show the spinner while seeking, switching camera or changing quality, and hide it on the first frame.

Verify in the browser at each step against the mockup. Commit per step.

---

### Task 5: Seamless server → NVR handover (server side)

**Do this last, and only with the test server available** — it cannot be proven without real footage containing a gap.

**Files:**
- Modify: `cctv/rec-playback.mjs`, `cctv/rec-fallback.mjs`
- Test: `cctv/test/rec-playback.test.mjs`, `cctv/test/rec-fallback.test.mjs`

What changes, per the roadmap:
- Start the NVR leg `legLeadMs` **before** the hole is reached rather than on reaching it, and hold its frames until the boundary timestamp.
- Learn each NVR's start latency (an exponential moving average, lead = p90 + 1 s, capped) instead of one fixed number.
- Keep both decoders alive across the join and swap on a single frame; a 120 ms cross-fade hides the resolution change.
- One clock throughout, so the time on screen never jumps.
- If the leg is late, hold the last frame with "filling from the NVR…" rather than freezing silently.
- A **skip gaps** setting, on by default, for true gaps; under a second, always skipped silently.
- Reverse and speeds above 8× keep today's jump.

Unit-test the timing decisions (when to start, what to hold, which frame is the boundary) with a fake leg. Then prove it on the test server against a camera with a known gap: no visible stall on a LAN NVR, under half a second on a remote one.

---

## Order

Tasks 1, 2 and 3 are independent and can be built at the same time. Task 4 needs 1 and 2. Task 5 needs the test server and should not start until it is back.
