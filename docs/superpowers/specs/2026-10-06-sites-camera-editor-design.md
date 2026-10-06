# Camera settings on Sites — inline editor with live preview

Date: 2026-10-06
Branch: `sites-camera-editor`
Status: design, awaiting review

## Goal

Move the per-camera settings suite out of the live full-size view and into the
Sites page. Each NVR gets a dropdown of its cameras; picking one opens an inline
editor — a live preview beside the existing Picture / OSD / Lines panels — so an
admin edits a camera and watches the change land in one place. The live
full-size view becomes view-only.

This is a re-host of components that already exist. No new server plumbing.

## Scope

In scope (the per-camera panels reached today from the full-size view):

- Picture (`ImagePanel`): imaging, Auto adjust, Colour check, recording-quality
  (main-stream codec / resolution / fps / bitrate) and Lens (mm).
- OSD (`OsdPanel`): the burnt-in name and clock.
- Lines (`LinesPanel`): line-crossing, shown only when the NVR supports it.

Out of scope (unchanged):

- Sub-stream codec/resolution — stays the existing per-NVR "Sub-streams" button
  on Sites (`openSubstreams`).
- The map's field-of-view cone — stays on the map.
- Non-admin access; Sites is admin-only and so is this editor.
- Bulk / multi-camera editing. One camera at a time.

## What exists today (and is reused as-is)

- `GET /api/cameras` → `[{ nvr, site, nvrName, ch, name, online }]`, already
  filtered to what the user may see (all cameras for an admin). Source for the
  per-NVR camera dropdown (group by `nvr`).
- Per-camera settings endpoints (`server.mjs` `CAMERA_ROUTE`):
  `/api/admin/nvrs/:id/channels/:ch/(image|image/profiles|image/schedule|lens|stream|stream/estimate|notes|figures|lines)`.
- `ImagePanel` (`image-panel.js`): `new ImagePanel({ getPlayer, waitForMain, onClose })`.
  Owns its DOM (`this.el`, an `<aside>`); the caller appends it. `open(cam, {opener})`
  re-targets it to a camera; `close()` removes `this.el` and calls `onClose`;
  `requestClose()` / `confirmDiscard()` guard unsaved changes. Measures the live
  picture through `getPlayer()`.
- `LinesPanel` (`lines-panel.js`): `new LinesPanel(host, cam, { liveEl, opener, onClose })`.
  Builds `this.el`, appends to `host`, overlays its drawing on `liveEl`. Created
  fresh per camera. `confirmDiscard()` guards unsaved lines.
- `OsdPanel` (`osd-panel.js`): `new OsdPanel(host, cam, { liveEl, opener, onClose })`.
  Appends `this.el` to `host`; overlays a shield + canvas on the live tile.
- `LiveTile` (`live-tile.js`): `new LiveTile(tileEl, cam, streamType)` where
  `tileEl` contains a `<canvas>`. Exposes `.player` (a `VideoPlayer`),
  `.streamType` (`MAIN_STREAM` 0 / `SUB_STREAM` 1) and `.close()`. Falls back to
  the sub stream when the NVR refuses Live HD (`HD_REFUSED`).
- The `getPlayer` contract (from `viewer.js` `shownPlayer`):
  `{ player, stream: 'main' | 'sub', remote }`.
- `linesSupportAsker()` (`lines-panel.js`): per-camera answer of whether the NVR
  has line-crossing of its own; used to show/hide the Lines tab.

## Architecture

One new module, `cctv/public/camera-editor.js`, owns the editor. `sites.js`
mounts it and nothing more. Boundaries:

- `camera-editor.js` — exports `openCameraEditor(mountEl, cam, { onClose })`,
  returning a handle `{ cam, close(), confirmDiscard() }`. It builds the preview
  tile and the tabbed panel host, instantiates/re-targets the three panels, and
  tears everything down on close. It knows nothing about the Sites list.
- `sites.js` — adds the `Cameras (n) ▾` expander per NVR row, fetches and groups
  `/api/cameras`, renders camera chips, and tracks the single open editor
  (opening another camera first asks the current editor's `confirmDiscard()` and
  closes it). It owns no panel logic.

Only one editor is open at a time across the whole page, so at most one preview
main stream is running — the same resource cost as today's full-size Picture
panel.

### The editor, internally

- Preview: a single `LiveTile(tileEl, cam, MAIN_STREAM)`. `tileEl` is the live
  grid's tile markup (a `.tile` with a `<canvas>`, name and status). If that
  markup is not already produced by a shared helper, extract a small
  `makeTile(cam)` helper so the preview, the grid and the map build identical
  tiles and the OSD/Lines overlays attach exactly as they do now.
- Tabs: Picture / OSD / Lines. Picture is the default.
  - `ImagePanel` is created once per editor open with
    `getPlayer: () => previewPlayer()` and opened on the current camera;
    `previewPlayer()` returns `{ player: tile.player, stream: tile.streamType === MAIN_STREAM ? 'main' : 'sub', remote }`,
    mirroring `shownPlayer`. `waitForMain` mirrors `viewer.js` (wait for the main
    stream to arrive, give up for a remote/no-main camera).
  - `LinesPanel` / `OsdPanel` are created on first open of their tab for the
    current camera, with `host` = that tab's container and `liveEl` = the preview
    tile, exactly as `viewer.js` wires them to the full-size tile today.
- The Lines tab is hidden when the NVR has no line-crossing. The editor holds its
  own `linesSupportAsker()` instance (the `viewer.js` one is removed below) and
  asks it per camera.

### Data flow

1. Admin expands an NVR → `sites.js` fetches `/api/cameras` once (cached),
   filters to that NVR, renders chips (channel + name + online dot).
2. Admin clicks a camera chip → `sites.js` closes any open editor (guarded), then
   `openCameraEditor(rowMount, cam, …)`.
3. The editor starts the preview (main stream) and opens the Picture panel; the
   panels read/write the existing `/channels/:ch/...` endpoints. Changes are shown
   in the preview as the camera applies them (same mechanism as the full-size view
   today).
4. Collapsing the NVR, picking another camera, or leaving the page closes the
   editor after `confirmDiscard()`.

## Live full-size view becomes view-only (`viewer.js`)

Remove, from `viewer.js`:

- The Picture / Lines / OSD buttons in the full-size controls strip and their
  click handlers (`pic-toggle` / `lines-toggle` / `osd-toggle`).
- The module-level `imagePanel` singleton, `linesPanel` / `osdPanel` state, and
  the `shownPlayer` / `waitForMain` / `linesSupported` / discard helpers that only
  the panels used.

Keep everything else: the full-size view, fullscreen, stepping, grid, overlays.
The panel modules (`image-panel.js`, `osd-panel.js`, `lines-panel.js`) are kept —
now imported by `camera-editor.js` instead of `viewer.js`. Before deleting the
helpers, confirm nothing else in `viewer.js` references them.

## Error handling and edge cases

- Offline camera: preview shows the tile's own offline state; Auto adjust /
  Colour check / measurement (which need a live picture) are disabled; settings
  still load and apply (the panels already handle their own busy/offline states).
- Bandwidth-starved P2P site (e.g. Shad): the preview's main stream is as slow to
  first frame as today's full-size Picture panel. Accepted — one camera,
  admin-initiated.
- `/api/cameras` fails: inline error in the dropdown with a retry; the rest of the
  Sites page is unaffected.
- Unsaved changes on switch/collapse/leave: `confirmDiscard()` on the open panel,
  as today.
- Lines unsupported: Lines tab hidden.
- Phone width: preview stacks above the tabs.

## Testing

- Source-scan tests (Node, matching the existing suite; normalise CRLF with
  `.replace(/\r\n/g, '\n')`):
  - `viewer.js` no longer references the three settings buttons / toggles.
  - `camera-editor.js` imports `ImagePanel`, `OsdPanel`, `LinesPanel`, `LiveTile`
    and passes a `getPlayer` to `ImagePanel`.
  - `sites.js` renders the per-NVR Cameras expander and opens the editor.
- Manual pass on a real NVR, one camera end-to-end: Picture + Auto adjust, an OSD
  change, Lines (where supported), each visible in the preview; confirm the
  full-size view no longer shows the three buttons.

## Rollout

Feature branch `sites-camera-editor` off `origin/master`. Deploy with
`deploy/push.sh --linux cctv@192.168.1.232 --code-only`; `libdvrnetsdk.so` is not
shipped (verify its sha256 still starts `7d27765ac5f69c5a` after deploy).
