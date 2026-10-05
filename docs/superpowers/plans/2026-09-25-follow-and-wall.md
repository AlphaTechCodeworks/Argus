# Following someone, and seeing every camera at one moment

**Goal:** make an investigation quick. Two features on shared foundations:

1. **Follow camera to camera** — while watching, the cameras that adjoin this one are offered beside the picture, each at the same moment. Click one and you are there, at that instant, still playing. You walk the site as the person did.
2. **Every camera at one moment** — "show me 14:00 to 14:10 everywhere", as a grid on one timeline, so you can see where someone went without opening cameras one at a time.

**Why these two together:** both need the same thing — several cameras positioned at one shared moment in server time — so building them apart would mean building it twice.

**Important:** the cameras here are **not** smart. There is no person or vehicle detection to lean on. These features work purely on time and on which camera adjoins which, which is exactly why they are worth building: they give an investigator speed without needing anything from the cameras.

## Global Constraints

- **Server time throughout.** Each NVR's clock differs (nvr1 runs about 220 s fast); `pb-sources.js` already converts with `-skewMs`. Two cameras on different NVRs must line up on screen, which is the entire point — a follow that lands 220 s out is worse than no follow.
- **The viewing PC is the limit, not the server.** Each tile decodes in the browser. Expect about 4 HD or 9 SD tiles on a decent PC; this PC cannot decode H.265 at all. Choose sub-streams for grid tiles and say plainly when a tile cannot be shown.
- **Do not add load to the NVRs.** Everything comes from the server's own recordings where it has them. One pull per camera, as now.
- No new npm dependencies. Pure logic goes in modules testable under plain `node`, as `pb-view.js` and `pb-sources.js` are.
- British spelling, sentence case, comments explaining *why*.

---

## Task 1: Which camera adjoins which

**Files:** create `cctv/camera-links.mjs`, its API in `cctv/settings-api.mjs` or its own route, a small editor in the page, tests in `cctv/test/`.

The data: for each camera, a list of neighbours, each with a label describing where it leads ("through the front door", "into the yard"). Stored beside the other app data, versioned like `user-prefs.mjs` does so two people editing cannot silently overwrite each other.

The editor: the site map already exists (`maps.json`, `cctv/public/map.html`) with cameras placed on it. Adding links there — pick a camera, then pick the cameras it leads to — is far better than a list of dropdowns, because the spatial relationship is the whole idea.

**Sensible first guess:** offer the nearest few cameras on the same map as suggested neighbours, so an install is useful before anyone has drawn a single link. Suggestions must be visibly suggestions, not silently treated as fact.

---

## Task 2: Several cameras at one moment

**Files:** create `cctv/public/wall.html` and `wall.js`, plus a pure module for the shared clock; reuse `pb-view.js`, `pb-transport.js`, `pb-sources.js`, `player.js`.

One clock drives every tile. Play, pause, seek, speed and the shuttle move them all together. The timeline shows a lane per camera so you can see which cameras have footage at a moment, and where the gaps are.

Tiles come from the server's recordings. A camera with nothing at that moment says so rather than showing black.

Reuse the playback page's controls rather than writing a second set that drifts from the first.

---

## Task 3: The follow strip on the playback page

**Files:** modify `cctv/public/playback.html`, `playback.js`, `style.css`.

Beside the picture, the neighbouring cameras, each a small live-updating thumbnail at the moment on screen, labelled with where it leads. Click one and the main view switches to it, keeping the moment and carrying on playing — the switch already preserves time, so this is mostly presentation.

A "back" step matters: following someone is trial and error, and going back to the previous camera and moment must be one click.
