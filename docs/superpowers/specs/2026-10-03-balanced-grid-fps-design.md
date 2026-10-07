# Balanced grid FPS — design

**Goal:** let a remote viewer pin every camera in the live grid to one chosen, uniform frame
rate, so the grid looks even and the uplink is shared equally across tiles, instead of each camera
running at its own native rate.

**Approved choices (owner, 3 Oct 2026):** a **fixed even rate** (the fast cameras are capped down
to match; a camera slower than the pick keeps its own rate — frames cannot be invented), chosen
from **a live control** on the grid rather than a fixed server default.

## Why

A remote viewer already sits on one LEVEL for all their tiles (adaptive-live.mjs), and the uplink
budget already shares fairly *between people*. But at the top level ("full") a grid sub-stream
passes through at the camera's own configured frame rate (adaptive-live.mjs `#passes`), so on a
good link a 20 fps camera sits next to a 12 fps one and the grid looks uneven. This adds a
per-viewer choice to convert every grid tile to one target fps, uniform across the grid.

## The control (client)

- A small `<select>` in the live page header, **remote viewers only** (local-network viewers get
  the cameras' own streams untouched, so the control is hidden for them — gate on the same
  "remote" signal the page already has, e.g. from `/api/me` or the live socket hello).
- Options: **Auto** (today's behaviour — native per-camera rate at full, the level system
  otherwise) and **4 / 8 / 10 / 15 fps**. Default **Auto**.
- Remembered per browser in `localStorage` (`cctv.gridFps`), like the Satellite/Names toggles.
  Read defensively (try/catch), absent ⇒ Auto.
- Applies to the **grid only**. Full screen (Live HD, the main stream) keeps its own path and is
  not affected.
- Changing it re-applies live to the open grid without a full page reload (tells the server the
  new target; tiles move at the next keyframe like any level change).

## Carrying the choice to the server (protocol)

- The chosen grid fps is a **per-viewer** value (one per browser session), sent over the existing
  live-mux WebSocket — either in the socket hello/first message or as its own small control
  message when it changes. One value per viewer, not per channel: every sub tile of that viewer
  uses it.
- The server stores it on the viewer's adaptive-live state. It is advisory input to the
  conversion target, never a security or access decision.

## Applying it (server, adaptive-live.mjs + phone-live.mjs)

- Today a sub-stream the current level "would only pass through" stays on the camera's own stream
  (`#passes`). With a grid fps chosen, a sub tile instead takes a **conversion targeted at that
  fps** — the conversion pipeline already drops frames to a target (phone-live.mjs `keepEveryFor`
  / `steadyRate`), so this reuses it: the target becomes `min(level fps if capped, chosen fps)`,
  and at the "full" level the chosen fps replaces "every frame".
- Every grid tile of the viewer uses the **same** target fps, so the tiles are identical and the
  uplink divides evenly across them.
- A camera whose native rate is **below** the chosen fps is left on its own stream (no conversion
  can raise it); it simply runs slower, which is honest and unavoidable.

## Interaction with the existing level / budget system (the load-bearing rule)

- The chosen fps is a **ceiling, not a floor.** The adaptive controller still owns degradation:
  if the viewer's link cannot carry the chosen fps across the grid (video piles up past QUEUE_S,
  or the WAN budget steps this viewer down), the whole viewer still steps down to a lower level as
  it does today — uniform across tiles at that lower rate — and climbs back to the chosen fps when
  the link recovers.
- So the control sets the uniform target; the safety behaviour (no stalls, fair sharing between
  people) is unchanged. The chosen fps never raises a viewer above what the controller allows.
- "Auto" = exactly today's behaviour (native pass-through at full, level fps when capped).

## Out of scope

- Per-camera (as opposed to per-viewer) fps choices in the grid.
- Changing the main-stream / full-screen (Live HD) path.
- Any change for local-network viewers (their streams stay untouched).
- A server-wide default fps setting (the control is per-browser; Auto is the default).

## Testing

- phone-live / conversion: a chosen target fps produces that rate from a faster source
  (`keepEveryFor` math), and a slower source is left alone.
- adaptive-live: with a grid fps set, a sub tile that would pass through at full instead takes the
  conversion at the chosen fps; every one of a viewer's sub tiles gets the same target; the main
  stream is unaffected; "Auto" reproduces the pass-through behaviour exactly.
- The chosen fps is a ceiling: a viewer stepped down by backpressure/budget goes below it and
  returns to it on recovery (the controller still decides).
- client: the control is hidden for a local viewer and shown for a remote one; the choice persists
  in localStorage and survives a reload; a corrupt/absent value reads as Auto.
- protocol: the value reaches the server's viewer state from the socket; changing it live re-targets
  the open grid without a reload.
