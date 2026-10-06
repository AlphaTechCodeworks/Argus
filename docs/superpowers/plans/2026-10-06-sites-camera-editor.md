# Camera settings on Sites — inline editor with live preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Implementation notes (deviations from the base assumptions)

The plan was drafted against the `maptiles` tree, which carried another session's
uncommitted work. Built instead on `origin/master` (what prod runs), which forced three
adjustments — all implemented and tested:

- **Task 1:** `camerasForNvr` lives in `camera-choice.js` (an existing, committed,
  camera-picker module), not a new `sites-model.js` (that file exists only in the other
  session's uncommitted tree). The test imports it from `camera-choice.js`.
- **Task 3:** `sites.js` imports `camerasForNvr`/`cameraLabel` from `camera-choice.js`.
  Master's `render()` rebuilds the whole list every 5 s and lacked the "skip while a
  dropdown is open" guard, so that guard was added here (`if (sitesEl.querySelector('details[open]')) return`).
- **Task 4:** moving the Lines panel out of `viewer.js` made one source-scan assertion in
  `lines-panel.test.mjs` stale; it now checks `camera-editor.js` instead. Pre-existing Node
  failures in `playout`/`player-rewind`/`frame-trace` are unrelated (they fail on `origin/master` too).

**Goal:** Move the per-camera Picture / OSD / Lines settings out of the live full-size view into an inline editor on the Sites page, opened from a per-NVR camera dropdown and backed by a live main-stream preview.

**Architecture:** A new `camera-editor.js` re-hosts the existing panel classes (`ImagePanel`, `OsdPanel`, `LinesPanel`) beside a single main-stream `LiveTile` preview, one camera and one active panel at a time. `sites.js` adds a per-NVR `<details>` camera dropdown that mounts the editor. `viewer.js` loses the three settings buttons and becomes view-only.

**Tech Stack:** Vanilla ES modules (browser), Node's plain-script tests (`check()` helper, run with `node cctv/test/<file>.test.mjs`). No framework, no build step.

**Spec:** `docs/superpowers/specs/2026-10-06-sites-camera-editor-design.md`

## Global Constraints

- Admin-only. The Sites page is already admin-gated; add no new access path for non-admins.
- Never ship or alter `bin/linux/libdvrnetsdk.so` (the CPU-patched SDK, sha256 starts `7d27765ac5f69c5a`). Deploy with `bash deploy/push.sh --linux cctv@192.168.1.232 --code-only`; verify that sha256 after deploy.
- Working tree is CRLF (git autocrlf). Every source-scan test must `.replace(/\r\n/g, '\n')` before matching.
- Follow existing patterns: plain-script tests with a `check(name, ok, extra)` helper ending in `process.exit(failures ? 1 : 0)`; the local `el(tag, props, ...kids)` DOM helper; reuse `cameraLabel` from `camera-choice.js`.
- Reuse, do not duplicate: `TILE_HTML` (`live-tile.js`), `isLocalHost` (`device.js`), `cameraLabel` (`camera-choice.js`).
- One editor open on the page at a time; one of Picture/OSD/Lines active at a time (OSD and Lines both draw on the live picture). Switching guards unsent changes with the panel's own `confirmDiscard()`.

---

## File Structure

- Create `cctv/public/camera-editor.js` — the editor: preview tile + tabbed panels. Exports `openCameraEditor`.
- Modify `cctv/public/sites-model.js` — add the pure `camerasForNvr(cameras, nvrId)`.
- Modify `cctv/public/sites.js` — per-NVR Cameras `<details>` dropdown; mount/close the editor; fetch `/api/cameras`.
- Modify `cctv/public/viewer.js` — remove the Picture/Lines/OSD buttons and their now-unused helpers; view-only.
- Modify `cctv/public/style.css` — editor, tab, chip and dropdown styles.
- Create `cctv/test/sites-cameras.test.mjs` — `camerasForNvr` unit test.
- Create `cctv/test/camera-editor.test.mjs` — source-scan of `camera-editor.js` and `sites.js` wiring.
- Create `cctv/test/viewer-viewonly.test.mjs` — source-scan asserting the settings UI is gone from `viewer.js`.

---

### Task 1: `camerasForNvr` model helper

**Files:**
- Modify: `cctv/public/sites-model.js`
- Test: `cctv/test/sites-cameras.test.mjs`

**Interfaces:**
- Produces: `camerasForNvr(cameras: Array<{nvr,ch,name,online,remote?}>, nvrId: string) => Array` — the cameras whose `nvr === nvrId`, ascending by `ch`, input not mutated.

- [ ] **Step 1: Write the failing test**

Create `cctv/test/sites-cameras.test.mjs`:

```js
// The Sites camera dropdown groups /api/cameras by NVR, in channel order.
//   node cctv/test/sites-cameras.test.mjs
import { camerasForNvr } from '../public/sites-model.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const cams = [
  { nvr: 'a', ch: 5, name: 'Gate', online: true },
  { nvr: 'b', ch: 1, name: 'Yard', online: true },
  { nvr: 'a', ch: 2, name: 'Dock', online: false }
]
const a = camerasForNvr(cams, 'a')
check('only that NVR, in channel order', a.map((c) => c.ch).join(',') === '2,5', a.map((c) => c.ch).join(','))
check('does not mutate the input order', cams[0].ch === 5)
check('unknown NVR -> empty', camerasForNvr(cams, 'z').length === 0)
check('missing list -> empty', camerasForNvr(undefined, 'a').length === 0)
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cctv/test/sites-cameras.test.mjs`
Expected: FAIL — `camerasForNvr` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `cctv/public/sites-model.js`:

```js
/** The cameras of one NVR, ascending by channel. `cameras` is the /api/cameras list. */
export function camerasForNvr(cameras, nvrId) {
  return (cameras ?? []).filter((c) => c.nvr === nvrId).sort((a, b) => a.ch - b.ch)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node cctv/test/sites-cameras.test.mjs`
Expected: PASS — all passed.

- [ ] **Step 5: Commit**

```bash
git add cctv/public/sites-model.js cctv/test/sites-cameras.test.mjs
git commit -m "feat: camerasForNvr helper for the Sites camera dropdown"
```

---

### Task 2: `camera-editor.js` — preview + tabbed panels

**Files:**
- Create: `cctv/public/camera-editor.js`
- Test: `cctv/test/camera-editor.test.mjs`

**Interfaces:**
- Consumes: `ImagePanel` (`{ getPlayer, waitForMain }`, `.open(cam)`, `.el`, `.close()`, `.confirmDiscard()`), `OsdPanel`/`LinesPanel` (`(host, cam, { liveEl, onClose })`, `.open()`, `.close()`, `.confirmDiscard()`), `linesSupportAsker()` (`lines-panel.js`), `LiveTile`/`MAIN_STREAM`/`TILE_HTML` (`live-tile.js`), `isLocalHost` (`device.js`), `cameraLabel` (`camera-choice.js`).
- Produces: `openCameraEditor(mountEl: HTMLElement, cam: {nvr,ch,name,site,remote?,online?}, { onClose?: () => void }) => { cam, close(): void, confirmDiscard(): boolean }`.

- [ ] **Step 1: Write the failing source-scan test**

Create `cctv/test/camera-editor.test.mjs`:

```js
// Pins down the Sites camera editor's wiring without a browser: it re-hosts the
// three panels beside one main-stream preview, one active at a time, and sites.js
// mounts it from a per-NVR camera dropdown.
//   node cctv/test/camera-editor.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const read = (f) => readFileSync(join(import.meta.dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n')

const ed = read('camera-editor.js')
check('exports openCameraEditor', /export function openCameraEditor\(/.test(ed))
check('imports the three panels', /from '\.\/image-panel\.js'/.test(ed) && /from '\.\/osd-panel\.js'/.test(ed) && /from '\.\/lines-panel\.js'/.test(ed))
check('preview is a main-stream LiveTile built from TILE_HTML', /TILE_HTML/.test(ed) && /new LiveTile\(tileEl, cam, MAIN_STREAM\)/.test(ed))
check('Picture panel gets getPlayer + waitForMain', /new ImagePanel\(\{ getPlayer, waitForMain \}\)/.test(ed))
check('OSD and Lines overlay the preview via liveEl', /new OsdPanel\(osdBody, cam, \{ liveEl/.test(ed) && /new LinesPanel\(linesBody, cam, \{ liveEl/.test(ed))
check('switching tabs guards unsent changes', /if \(!confirmDiscard\(\)\) return/.test(ed))
check('Lines tab hidden until the NVR supports line crossing', /linesSupported\(cam\)\.then/.test(ed))
check('close tears down the preview and the editor DOM', /preview\.close\(\)/.test(ed) && /root\.remove\(\)/.test(ed))

const sites = read('sites.js')
check('sites.js imports the editor', /from '\.\/camera-editor\.js'/.test(sites))
check('sites.js groups cameras per NVR', /camerasForNvr\(/.test(sites))
check('sites.js fetches the camera list', /\/api\/cameras/.test(sites))
check('sites.js has a per-NVR Cameras dropdown', /st-cameras/.test(sites))
check('sites.js keeps one editor at a time, guarded', /confirmDiscard\(\)/.test(sites))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cctv/test/camera-editor.test.mjs`
Expected: FAIL — `camera-editor.js` does not exist (and the sites.js checks fail; they pass in Task 3).

- [ ] **Step 3: Write the editor**

Create `cctv/public/camera-editor.js`:

```js
// The camera settings editor on the Sites page: a live preview beside the
// Picture / OSD / Lines panels, for one camera at a time. It re-hosts the panels
// the live full-size view used to show (image-panel.js, osd-panel.js,
// lines-panel.js). Only one of the three is active at once — OSD and Lines both
// draw on the live picture — exactly as the full-size view enforced. The preview
// is one main-stream LiveTile (live-tile.js); on a camera the NVR will not give
// HD (or a browser without H.265), the tile drops to its sub stream on its own
// and the panels measure that instead.
import { ImagePanel } from './image-panel.js'
import { OsdPanel } from './osd-panel.js'
import { LinesPanel, linesSupportAsker } from './lines-panel.js'
import { LiveTile, MAIN_STREAM, TILE_HTML } from './live-tile.js'
import { isLocalHost } from './device.js'
import { cameraLabel } from './camera-choice.js'

const REMOTE_PAGE = !isLocalHost()
const linesSupported = linesSupportAsker()

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag)
  Object.assign(n, props)
  for (const k of kids) if (k != null && k !== false) n.append(k)
  return n
}

/**
 * Open the camera editor inside `mountEl` for `cam`
 * ({ nvr, ch, name, site, remote, online }). Only one editor should be open on
 * the page at once; the caller closes any previous one (guard with confirmDiscard).
 * @returns {{ cam: object, close: () => void, confirmDiscard: () => boolean }}
 */
export function openCameraEditor(mountEl, cam, { onClose = null } = {}) {
  // preview: one main-stream tile, shared by all three tabs
  const tileEl = el('div', { className: 'tile ce-tile' })
  tileEl.innerHTML = TILE_HTML
  tileEl.querySelector('.name').textContent = cameraLabel(cam)
  const preview = new LiveTile(tileEl, cam, MAIN_STREAM)
  // the contract image-panel.js / osd-panel.js / lines-panel.js expect from the view
  const getPlayer = () => {
    const p = preview.player
    if (!p || !p.videoWidth || tileEl.classList.contains('pending')) return null
    return { player: p, stream: preview.streamType === MAIN_STREAM ? 'main' : 'sub', remote: Boolean(cam.remote) && REMOTE_PAGE }
  }
  const waitForMain = async (ms) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const v = getPlayer()
      if (v?.stream === 'main' || (cam.remote && REMOTE_PAGE)) return v
      await new Promise((r) => setTimeout(r, 200))
    }
    return getPlayer()
  }
  const liveEl = () => getPlayer()?.player?.canvas ?? null

  // the three tab bodies and the one shared Picture panel
  const picBody = el('div', { className: 'ce-body' })
  const osdBody = el('div', { className: 'ce-body', hidden: true })
  const linesBody = el('div', { className: 'ce-body', hidden: true })
  const image = new ImagePanel({ getPlayer, waitForMain })

  let active = null // 'pic' | 'osd' | 'lines'
  let osd = null
  let lines = null

  // close whatever is active (its DOM goes). Never prompts — guard with confirmDiscard first.
  function closeActive() {
    if (active === 'pic') image.close()
    else if (active === 'osd') { osd?.close(); osd = null }
    else if (active === 'lines') { lines?.close(); lines = null }
    active = null
  }

  function openPanel(key) {
    if (key === 'pic') { image.open(cam); picBody.append(image.el) }
    else if (key === 'osd') { osd = new OsdPanel(osdBody, cam, { liveEl, onClose: () => { osd = null } }); osd.open() }
    else if (key === 'lines') { lines = new LinesPanel(linesBody, cam, { liveEl, onClose: () => { lines = null } }); lines.open() }
    active = key
  }

  // the unsent changes of the active panel (there is only ever one)
  function confirmDiscard() {
    if (active === 'pic') return image.confirmDiscard()
    if (active === 'osd') return osd ? osd.confirmDiscard() : true
    if (active === 'lines') return lines ? lines.confirmDiscard() : true
    return true
  }

  const tabs = [
    { key: 'pic', label: 'Picture', body: picBody },
    { key: 'osd', label: 'OSD', body: osdBody },
    { key: 'lines', label: 'Lines', body: linesBody }
  ]
  const tabBar = el('div', { className: 'ce-tabs', role: 'tablist' })
  for (const t of tabs) {
    t.btn = el('button', { type: 'button', className: 'ce-tab', textContent: t.label })
    t.btn.setAttribute('role', 'tab')
    t.btn.setAttribute('aria-selected', 'false')
    if (t.key === 'lines') t.btn.hidden = true // shown only when the NVR supports line crossing
    t.btn.addEventListener('click', () => select(t.key))
    tabBar.append(t.btn)
  }

  function select(key) {
    if (key === active) return
    if (!confirmDiscard()) return // keep the current tab; its changes are unsent
    closeActive()
    for (const t of tabs) {
      const on = t.key === key
      t.body.hidden = !on
      t.btn.setAttribute('aria-selected', String(on))
    }
    openPanel(key)
  }

  linesSupported(cam).then((ok) => { if (ok) tabs.find((t) => t.key === 'lines').btn.hidden = false }).catch(() => {})

  const root = el('div', { className: 'ce-editor' },
    el('div', { className: 'ce-preview' }, tileEl),
    el('div', { className: 'ce-panels' }, tabBar, picBody, osdBody, linesBody))
  mountEl.append(root)

  // start on Picture
  for (const t of tabs) { t.body.hidden = t.key !== 'pic'; t.btn.setAttribute('aria-selected', String(t.key === 'pic')) }
  openPanel('pic')

  function close() {
    closeActive()
    preview.close()
    root.remove()
    onClose?.()
  }

  return { cam, close, confirmDiscard }
}
```

- [ ] **Step 4: Run test (editor checks pass; sites.js checks still fail)**

Run: `node cctv/test/camera-editor.test.mjs`
Expected: the eight `camera-editor.js` checks PASS; the five `sites.js` checks FAIL (Task 3 adds them). This is expected mid-plan.

- [ ] **Step 5: Commit**

```bash
git add cctv/public/camera-editor.js cctv/test/camera-editor.test.mjs
git commit -m "feat: camera-editor.js — preview + Picture/OSD/Lines tabs"
```

---

### Task 3: Wire the editor into the Sites page

**Files:**
- Modify: `cctv/public/sites.js`
- Test: `cctv/test/camera-editor.test.mjs` (the sites.js checks from Task 2 now pass)

**Interfaces:**
- Consumes: `openCameraEditor` (Task 2), `camerasForNvr` (Task 1), `cameraLabel` (`camera-choice.js`), the file's existing `api`, `el`, and `render`.
- Produces: a per-NVR `<details class="st-cameras">` dropdown; module state `openEditor` and `closeEditor()` enforcing one editor at a time.

- [ ] **Step 1: Add imports and editor state**

In `cctv/public/sites.js`, extend the existing imports and the `sites-model` import, and add module state near the other `let` declarations (after `let editing = null`):

```js
import { openCameraEditor } from './camera-editor.js'
import { cameraLabel } from './camera-choice.js'
```

Change the existing `sites-model` import to add `camerasForNvr`:

```js
import { connectionState, matchesNvr, camerasForNvr } from './sites-model.js'
```

Add state and helpers:

```js
let cameraList = null // /api/cameras, fetched once when a dropdown first opens
async function allCameras() {
  if (!cameraList) cameraList = await api('GET', '/api/cameras').catch(() => [])
  return cameraList
}

let openEditor = null // { chip, mount, handle } — one camera editor on the page at a time
/** Close the open editor, asking first when it has unsent changes. Returns false if kept open. */
function closeEditor() {
  if (!openEditor) return true
  if (!openEditor.handle.confirmDiscard()) return false
  openEditor.chip.setAttribute('aria-pressed', 'false')
  openEditor.handle.close()
  openEditor = null
  return true
}
```

- [ ] **Step 2: Add the per-NVR dropdown builder**

Add a `camerasPanel(n)` function (near `render`):

```js
/** The per-NVR camera dropdown: chips of its cameras; a chip opens the inline editor. */
function camerasPanel(n) {
  const body = el('div', { className: 'st-cameras-body' })
  const mount = el('div', { className: 'st-cameras-editor' })
  const d = el('details', { className: 'st-cameras' }, el('summary', { className: 'st-cameras-sum' }, `Cameras (${n.cameras ?? 0})`), body, mount)
  let built = false
  d.addEventListener('toggle', async () => {
    if (!d.open || built) return
    built = true
    const cams = camerasForNvr(await allCameras(), n.id)
    if (!cams.length) { body.append(el('p', { className: 'st-meta', textContent: 'No cameras reported for this NVR.' })); return }
    for (const cam of cams) {
      const chip = el('button', { type: 'button', className: `st-cam-chip${cam.online === false ? ' st-cam-off' : ''}`, textContent: cameraLabel(cam) })
      chip.setAttribute('aria-pressed', 'false')
      chip.addEventListener('click', () => {
        if (openEditor?.chip === chip) { closeEditor(); return } // click the open chip to close
        if (!closeEditor()) return // another editor had unsent changes and was kept
        chip.setAttribute('aria-pressed', 'true')
        openEditor = { chip, mount, handle: openCameraEditor(mount, cam, { onClose: () => { openEditor = null } }) }
      })
      body.append(chip)
    }
  })
  // collapsing the dropdown closes its editor; unsent changes are asked about first
  d.querySelector('summary').addEventListener('click', (e) => {
    if (d.open && openEditor && openEditor.mount === mount && !closeEditor()) e.preventDefault()
  })
  return d
}
```

- [ ] **Step 3: Include the dropdown under each NVR row**

In `render()`, the per-site `rows` are built with `list.map((n) => { … return row })`. Change that `.map(` to `.flatMap(` and return the row paired with its dropdown. Find the `return row` at the end of the row builder and replace it with:

```js
      return [row, camerasPanel(n)]
```

(The `const rows = list.map(` becomes `const rows = list.flatMap(`. The row-reuse short-circuit `if (previous?.dataset.signature === rowSignature) return previous` becomes `if (previous?.dataset.signature === rowSignature) return [previous, camerasPanel(n)]`. `render()` already bails out while any `<details>` is open, so an active editor is never torn down by a re-render.)

- [ ] **Step 4: Run the source-scan test to verify sites.js wiring**

Run: `node cctv/test/camera-editor.test.mjs`
Expected: PASS — all checks, including the five `sites.js` ones, now pass.

- [ ] **Step 5: Commit**

```bash
git add cctv/public/sites.js
git commit -m "feat: per-NVR camera dropdown opens the inline editor on Sites"
```

---

### Task 4: Make the live full-size view view-only

**Files:**
- Modify: `cctv/public/viewer.js`
- Test: `cctv/test/viewer-viewonly.test.mjs`

**Interfaces:**
- Produces: a `viewer.js` with no `ImagePanel`/`OsdPanel`/`LinesPanel` imports, no `imagePanel`/`linesPanel`/`osdPanel` state, and no `pic-toggle`/`lines-toggle`/`osd-toggle` buttons. The grid, full-size view, fullscreen, stepping and zoom are unchanged.

- [ ] **Step 1: Write the failing source-scan test**

Create `cctv/test/viewer-viewonly.test.mjs`:

```js
// The live full-size view is view-only: camera settings now live on Sites
// (camera-editor.js), so viewer.js must not carry the Picture/OSD/Lines panels.
//   node cctv/test/viewer-viewonly.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const src = readFileSync(join(import.meta.dirname, '..', 'public', 'viewer.js'), 'utf8').replace(/\r\n/g, '\n')

check('no Picture/Lines/OSD toggle buttons', !/pic-toggle|lines-toggle|osd-toggle/.test(src))
check('the settings panels are no longer imported', !/image-panel\.js|osd-panel\.js|lines-panel\.js/.test(src))
check('no panel singletons remain', !/\bimagePanel\b|\blinesPanel\b|\bosdPanel\b/.test(src))
check('no shownPlayer/waitForMain helpers remain', !/\bshownPlayer\b|\bwaitForMain\b/.test(src))
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cctv/test/viewer-viewonly.test.mjs`
Expected: FAIL — all four identifiers are still present.

- [ ] **Step 3: Remove the settings UI and helpers**

Edit `cctv/public/viewer.js` (line numbers from the current `map-tile-proxy`/`master` source; match on the code, not the number):

1. Delete the three imports (currently lines 9–11):
   ```js
   import { ImagePanel } from './image-panel.js'
   import { LinesPanel, linesSupportAsker } from './lines-panel.js'
   import { OsdPanel } from './osd-panel.js'
   ```
2. Delete `shownPlayer` (the `const shownPlayer = () => { … }` block) and `waitForMain` (the `const waitForMain = async (ms) => { … }` block).
3. Delete the `imagePanel` singleton (`const imagePanel = new ImagePanel({ … })`).
4. Delete the Lines/OSD state and helpers: `let linesPanel = null`, `const linesSupported = linesSupportAsker()`, `const linesDiscard = …`, `let osdPanel = null`, `const osdDiscard = …` (and their surrounding comment lines).
5. In the `keep`/`kept` line (currently ~236), drop the panel els:
   ```js
   const kept = keep ? [overlay].filter((n) => n?.parentNode === grid) : []
   ```
6. Where `const panelOpen = imagePanel.key === single` appears (~404), replace with:
   ```js
   const panelOpen = false
   ```
7. Delete the entire `if (isAdmin) { … }` block that builds the `pic`, `lines` and `osd` buttons (currently ~704–789). Keep the `Recordings` link above it. Keep `overlay.querySelector('.name').after(links)` after it.
8. The overlay click handler (~794–796):
   ```js
   overlay.addEventListener('click', () => {
     closeSingle()
   })
   ```
9. In `attachZoom`, the `busy` option (~803):
   ```js
   busy: () => false,
   ```
10. Delete the panel re-parenting lines (~824–831): the `if (imagePanel.key === single) grid.append(imagePanel.el) else imagePanel.close()` and the matching `linesPanel`/`osdPanel` blocks.
11. Delete the teardown lines (~864–866): `imagePanel.close()`, `linesPanel?.close()`, `osdPanel?.close()`.
12. In the `before` line (~1007):
    ```js
    const before = [overlay].find((n) => n?.parentNode === grid) ?? null
    ```
13. The Escape handlers (~1268–1276): delete the `if (e.key === 'Escape' && linesPanel) { … }` and `if (e.key === 'Escape' && osdPanel) { … }` blocks, and simplify the last to:
    ```js
    if (e.key === 'Escape' && single !== null && !document.fullscreenElement) closeSingle()
    ```
14. The stepping guard (~1498):
    ```js
    openSingle(next, { stepping: true })
    ```
15. The flick guard (~1528): delete the line `if (linesPanel || osdPanel) return (t0 = null)`.

After editing, grep to confirm nothing is left behind:

Run: `grep -nE "imagePanel|linesPanel|osdPanel|shownPlayer|waitForMain|linesSupported|pic-toggle|lines-toggle|osd-toggle|image-panel\.js|osd-panel\.js|lines-panel\.js" cctv/public/viewer.js`
Expected: no matches.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node cctv/test/viewer-viewonly.test.mjs`
Expected: PASS.

Also run the existing viewer-related tests to confirm nothing else broke (pick the ones that import or scan `viewer.js`):

Run: `node cctv/test/pinch-zoom.test.mjs`
Expected: PASS (zoom still attaches; `busy` is now `() => false`).

- [ ] **Step 5: Commit**

```bash
git add cctv/public/viewer.js cctv/test/viewer-viewonly.test.mjs
git commit -m "refactor: live full-size view is view-only; camera settings moved to Sites"
```

---

### Task 5: Styles for the editor and dropdown

**Files:**
- Modify: `cctv/public/style.css`

**Interfaces:**
- Consumes: the class names emitted by Tasks 2–3 (`ce-editor`, `ce-preview`, `ce-tile`, `ce-panels`, `ce-tabs`, `ce-tab`, `ce-body`, `st-cameras`, `st-cameras-sum`, `st-cameras-body`, `st-cameras-editor`, `st-cam-chip`, `st-cam-off`).

- [ ] **Step 1: Add the styles**

Append to `cctv/public/style.css` (uses the app's existing custom properties — `--muted`, `--line`/border tokens already used elsewhere in this file; if a token name differs, match the neighbouring rules):

```css
/* Sites: per-NVR camera dropdown and the inline settings editor (camera-editor.js) */
.st-cameras { margin: 4px 0 8px; }
.st-cameras-sum { cursor: pointer; font-size: 13px; color: var(--muted); padding: 4px 0; }
.st-cameras-body { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 0; }
.st-cam-chip { font-size: 13px; padding: 5px 10px; border-radius: 8px; }
.st-cam-chip[aria-pressed="true"] { outline: 2px solid currentColor; }
.st-cam-off { opacity: 0.55; }
.st-cameras-editor:empty { display: none; }

.ce-editor { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; padding: 8px 0; }
.ce-preview { flex: 1 1 280px; min-width: 240px; }
.ce-tile { aspect-ratio: 16 / 9; width: 100%; background: #141414; border-radius: 8px; overflow: hidden; position: relative; }
.ce-panels { flex: 1 1 320px; min-width: 280px; }
.ce-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line, rgba(128,128,128,.3)); margin-bottom: 12px; }
.ce-tab { font-size: 14px; padding: 7px 12px; background: none; border: 0; border-bottom: 2px solid transparent; }
.ce-tab[aria-selected="true"] { border-bottom-color: currentColor; }
.ce-body[hidden] { display: none; }

@media (max-width: 640px) {
  .ce-editor { flex-direction: column; }
}
```

- [ ] **Step 2: Verify the CSS tokens test still passes**

Run: `node cctv/test/css-tokens.test.mjs`
Expected: PASS (no disallowed tokens introduced). If it flags a hardcoded colour, swap `#141414` for the project's video-surface token used by the grid tiles.

- [ ] **Step 3: Commit**

```bash
git add cctv/public/style.css
git commit -m "style: camera editor, tabs and per-NVR dropdown on Sites"
```

---

## Manual verification (after Task 5)

1. `bash deploy/push.sh --linux cctv@192.168.1.232 --code-only`, then
   `ssh cctv@192.168.1.232 sha256sum /opt/cctv/current/bin/linux/libdvrnetsdk.so` → starts `7d27765ac5f69c5a`.
2. On the Sites page as an admin: expand an online NVR's Cameras dropdown, pick a camera. The preview shows (main on the LAN), and the Picture tab loads.
3. Make a small Picture change (e.g. brightness) → Apply → watch it land in the preview. Run Auto adjust once.
4. OSD tab: move the name/clock; confirm the overlay tracks the live picture. Lines tab appears only on an NVR that supports line crossing; draw and save a line there.
5. Switch to another camera with an unsent change pending → the discard prompt fires. Collapse the dropdown with a change pending → same.
6. Open the live full-size view → confirm there are no Picture/OSD/Lines buttons and the view, fullscreen, stepping and zoom all still work.

---

## Self-Review

**Spec coverage:**
- Scope (Picture/OSD/Lines move; Sub-streams and map FOV untouched) → Tasks 2–4; Sub-streams/map code is never touched.
- Camera dropdown from `/api/cameras` grouped by NVR → Tasks 1, 3.
- Inline editor, preview left / tabs right, one at a time → Task 2.
- Full-size view view-only → Task 4.
- Edge cases (offline preview, Lines gating, discard guard, phone stacking) → Task 2 (`getPlayer` null-safe, `linesSupported`, `confirmDiscard`), Task 5 (media query).
- Testing (source-scan + manual) → Tasks 1–4 tests + Manual verification.

**Placeholder scan:** none — every step has concrete code or an exact edit list.

**Type consistency:** `openCameraEditor(mountEl, cam, { onClose })` returns `{ cam, close, confirmDiscard }`, used that way in `sites.js` (`openEditor.handle.confirmDiscard()`, `.close()`). `camerasForNvr(cameras, nvrId)` signature matches its test and its `sites.js` call. Panel methods used (`open`, `close`, `confirmDiscard`) match `image-panel.js`/`osd-panel.js`/`lines-panel.js`.
