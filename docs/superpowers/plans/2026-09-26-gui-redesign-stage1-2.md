# GUI Redesign — Stage 1 (foundation, shell, themes) and Stage 2 (Live) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ten-tab header with a UniFi Protect–style shell (grouped sidebar, icon rail, phone bottom bar, dark default with a light toggle) on every page, and rebuild the Live screen as camera cards with the name under the picture.

**Architecture:** New CSS lives in `cctv/public/css/` (tokens, base, components, shell) and loads before the old `style.css`, which keeps styling page bodies until later stages retire it. A pure `nav-model.js` and `theme.js` hold all decisions and are tested with plain node; `shell.js` renders the sidebar at runtime and wraps the page's existing content in `<div class="app-main">`, so no page's own markup needs restructuring in stage 1. `theme-boot.js` is a classic render-blocking script that sets the theme before first paint.

**Tech Stack:** Plain HTML, CSS custom properties, ES modules, Node 24 test scripts using the repo's `check(name, ok, extra)` helper. No framework, no build step.

**Spec:** `docs/superpowers/specs/2026-09-26-gui-redesign-design.md`

## Scope note

The spec also lists dialog, toast and disclosure components. Nothing in stages 1–2 uses them, so they are built with the admin pages in stage 3, where they are first needed.

## Global Constraints

- No framework and no new dependency. Plain HTML/CSS/ES modules.
- Every colour in `cctv/public/css/*.css` comes from `tokens.css`; a hard-coded colour anywhere else under `css/` fails `test/css-tokens.test.mjs`.
- Dark is the default theme; light is `[data-theme="light"]` on `<html>`. Choice stored in `localStorage` key `cctv.theme`, every access in try/catch.
- Nav groups exactly: Watch (Live `/`, Playback `/playback.html`, Wall `/wall.html`, Map `/map.html`), Monitor (Alarms `/alarms.html`, Health `/health.html`), Admin (Sites `/sites.html`, Settings `/settings.html`, Storage `/storage.html`, Audit `/audit.html`). Admin group only for admins.
- Breakpoints: sidebar 232px at ≥1200px; icon rail 64px at 700–1199px; bottom bar below 700px with Live, Playback, Alarms, Health, More.
- Pages out of scope for the shell: `login.html`, `pack-player.html`, `colour-check-demo.html`.
- No page may lose a control. Stage 1 changes presentation and navigation only.
- Tests must run on Windows with `node cctv/test/<name>.test.mjs` (no SDK import).
- Comments explain why, in plain English, full sentences, matching the codebase.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Deploy only after the preflight: start the server on the production box on spare ports with `CCTV_AUTH=off` and its own data dir, load the pages in the browser, check the error log is empty. Then `bash deploy/push.sh --linux cctv@192.168.2.115 --code-only`, then check live error count and cameras recording.

---

### Task 1: Tokens, base styles, and the colour-drift test

**Files:**
- Create: `cctv/public/css/tokens.css`
- Create: `cctv/public/css/base.css`
- Test: `cctv/test/css-tokens.test.mjs`

**Interfaces:**
- Produces: CSS custom properties `--bg --surface-1 --surface-2 --surface-3 --surface-hover --border --text --text-muted --text-faint --accent --accent-soft --on-accent --ok --ok-soft --warn --warn-soft --bad --bad-soft --video-bg --s1..--s6 --r-sm --r-md --r-lg --fs-meta --fs-dense --fs-body --fs-section --fs-title --fs-figure --shadow --t-fast`, in dark on `:root` and light on `:root[data-theme="light"]`.

- [ ] **Step 1: Write the failing test**

```js
// cctv/test/css-tokens.test.mjs
// The redesign's one hard rule: every colour comes from tokens.css. The old style.css reached 69
// distinct hard-coded colours, which is why no two pages looked alike. This fails the build the
// moment a new stylesheet under css/ writes a colour of its own.
//   node cctv/test/css-tokens.test.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const dir = join(import.meta.dirname, '..', 'public', 'css')
check('the css folder exists', existsSync(dir))
const files = existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.css')) : []
check('tokens.css exists', files.includes('tokens.css'))

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g
for (const f of files) {
  if (f === 'tokens.css') continue
  const text = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const hits = text.match(COLOUR) ?? []
  check(`${f} takes every colour from the tokens`, hits.length === 0, hits.slice(0, 3).join(' '))
}

const tokens = existsSync(join(dir, 'tokens.css')) ? readFileSync(join(dir, 'tokens.css'), 'utf8') : ''
for (const t of ['--bg', '--surface-1', '--surface-2', '--surface-3', '--border', '--text', '--text-muted', '--text-faint', '--accent', '--ok', '--warn', '--bad', '--video-bg']) {
  check(`dark defines ${t}`, new RegExp(`:root\\s*{[^}]*${t}\\s*:`).test(tokens))
}
check('a light theme exists', /:root\[data-theme="light"\]\s*{/.test(tokens))
for (const t of ['--bg', '--surface-1', '--text', '--border', '--accent']) {
  check(`light overrides ${t}`, new RegExp(`\\[data-theme="light"\\]\\s*{[^}]*${t}\\s*:`).test(tokens))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node cctv/test/css-tokens.test.mjs`
Expected: FAIL on `the css folder exists` and `tokens.css exists`.

- [ ] **Step 3: Write `tokens.css`**

```css
/* The palette, type, spacing and shape of the whole app. Every colour anywhere under css/ comes
   from here, and test/css-tokens.test.mjs fails the moment one does not -- the old style.css had
   drifted to 69 distinct colours, which is most of why no two pages looked like the same product.
   Dark is the default; the light theme overrides surfaces and text only, so status colours mean
   the same thing in both. */
:root {
  color-scheme: dark;
  --bg: #0e1012;
  --surface-1: #121417;
  --surface-2: #181b1f;
  --surface-3: #1d2530;
  --surface-hover: #1c1f24;
  --border: #22262b;
  --text: #eceef1;
  --text-muted: #9aa0a8;
  --text-faint: #5d636b;
  --accent: #3b82f6;
  --accent-strong: #5b9bff;
  --accent-soft: rgba(59, 130, 246, 0.15);
  --on-accent: #ffffff;
  --ok: #22c55e;
  --ok-soft: rgba(34, 197, 94, 0.15);
  --warn: #f59e0b;
  --warn-soft: rgba(245, 158, 11, 0.15);
  --bad: #ef4444;
  --bad-soft: rgba(239, 68, 68, 0.15);
  /* video is black in both themes: only the card around a picture changes */
  --video-bg: #000000;
  --scrim: rgba(0, 0, 0, 0.55);
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  --focus: #5b9bff;

  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;
  --r-sm: 6px; --r-md: 10px; --r-lg: 14px;
  --fs-meta: 12px; --fs-dense: 13px; --fs-body: 14px; --fs-section: 16px; --fs-title: 24px; --fs-figure: 28px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --t-fast: 120ms ease;
  --shell-w: 232px; --rail-w: 64px; --bar-h: 64px;
}

:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f4f5f7;
  --surface-1: #ffffff;
  --surface-2: #f7f8fa;
  --surface-3: #eaf1ff;
  --surface-hover: #eef0f3;
  --border: #e3e6ea;
  --text: #16181b;
  --text-muted: #4b5260;
  --text-faint: #8a919c;
  --accent: #1e56d6;
  --accent-strong: #1e56d6;
  --accent-soft: rgba(30, 86, 214, 0.1);
  --shadow: 0 1px 3px rgba(16, 24, 40, 0.08);
  --focus: #1e56d6;
}

@media (prefers-reduced-motion: reduce) { :root { --t-fast: 0ms linear; } }
```

- [ ] **Step 4: Write `base.css`**

```css
/* The ground every page stands on: background, type, focus and scrollbars. Loaded after tokens and
   before the old style.css, so pages not yet rebuilt still get their own rules on top. */
html { background: var(--bg); }
body { font: var(--fs-body)/1.45 var(--font); color: var(--text); background: var(--bg); }
/* A focus ring only for the keyboard: a ring on every mouse click is the look of an unfinished
   page, and none at all locks keyboard users out. */
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
:focus:not(:focus-visible) { outline: none; }
* { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
```

- [ ] **Step 5: Run the test**

Run: `node cctv/test/css-tokens.test.mjs`
Expected: `all passed`.

- [ ] **Step 6: Commit**

```bash
git add cctv/public/css/tokens.css cctv/public/css/base.css cctv/test/css-tokens.test.mjs
git commit -m "Redesign: one palette, dark and light, and a test that keeps it one"
```

---

### Task 2: Components

**Files:**
- Create: `cctv/public/css/components.css`
- Test: `cctv/test/css-tokens.test.mjs` (existing — must still pass)

**Interfaces:**
- Consumes: tokens from Task 1.
- Produces: classes `.btn .btn-primary .btn-danger .btn-ghost .btn-sm .btn-icon`, `.panel .panel-head`, `.card .card-label .card-figure .card-meta`, `.field .field-row .field-help .field-check`, `.seg .seg-label`, `.input` (also applied to bare `input/select` inside `.field`), `.seg` with `button[aria-pressed="true"]`, `.pills` with `button[aria-pressed="true"]`, `.table-wrap .table`, `.badge .badge-ok .badge-warn .badge-bad .badge-neutral`, `.empty`, `.page-head .page-title .page-sub .page-actions`, `.statusbar .stat .stat-dot`.

- [ ] **Step 1: Write `components.css`**

```css
/* The parts every page is built from, defined once. Page stylesheets may place them but not
   restyle them -- that rule is what stops each page drifting into its own look again. */

/* ---- buttons ---- */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--s2); height: 32px; padding: 0 var(--s3);
  border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); color: var(--text);
  font: 500 var(--fs-dense)/1 var(--font); cursor: pointer; transition: background var(--t-fast), border-color var(--t-fast); }
.btn:hover { background: var(--surface-hover); }
.btn:disabled, .btn[aria-busy="true"] { opacity: 0.5; cursor: default; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn-primary:hover { background: var(--accent-strong); }
.btn-danger { background: var(--bad-soft); border-color: transparent; color: var(--bad); }
.btn-ghost { background: none; border-color: transparent; color: var(--text-muted); }
.btn-ghost:hover { color: var(--text); background: var(--surface-hover); }
.btn-sm { height: 28px; padding: 0 var(--s2); }
.btn-icon { width: 32px; padding: 0; }
.btn svg, .btn-icon svg { width: 18px; height: 18px; }

/* ---- segmented control and pills ---- */
.seg { display: inline-flex; padding: 2px; gap: 2px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm); }
.seg button { border: 0; background: none; color: var(--text-muted); font: 500 var(--fs-meta)/1 var(--font); padding: 6px 10px; border-radius: 4px; cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--surface-3); color: var(--text); }
.pills { display: flex; flex-wrap: wrap; gap: var(--s1); }
.pills button { border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted); font: 500 var(--fs-dense)/1 var(--font);
  padding: 7px 14px; border-radius: 999px; cursor: pointer; }
.pills button[aria-pressed="true"] { background: var(--text); color: var(--bg); border-color: var(--text); }

/* ---- panels and cards ---- */
.panel { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--s5); box-shadow: var(--shadow); }
.panel-head { display: flex; align-items: center; gap: var(--s3); margin: 0 0 var(--s4); }
.panel-head h2 { font-size: var(--fs-section); font-weight: 600; margin: 0; }
.panel-head > :last-child { margin-left: auto; }
.card { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--s4); }
.card-label { color: var(--text-muted); font-size: var(--fs-meta); }
.card-figure { font-size: var(--fs-figure); font-weight: 600; margin: 2px 0; }
.card-meta { color: var(--text-faint); font-size: var(--fs-meta); }

/* ---- forms ---- */
.field { display: flex; flex-direction: column; gap: var(--s1); font-size: var(--fs-dense); color: var(--text-muted); min-width: 0; }
.field-row { display: flex; flex-wrap: wrap; gap: var(--s3) var(--s4); align-items: flex-end; }
.field-help { color: var(--text-faint); font-size: var(--fs-meta); }
.input, .field input:not([type="checkbox"]):not([type="radio"]), .field select, .field textarea {
  height: 34px; padding: 0 var(--s3); background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
  border-radius: var(--r-sm); font: var(--fs-body) var(--font); max-width: 22rem; }
.field textarea { height: auto; padding: var(--s2) var(--s3); }

/* a checkbox sits beside its words, on the same line */
.field-check { display: inline-flex; align-items: center; gap: var(--s2); font-size: var(--fs-dense); color: var(--text-muted); cursor: pointer; }
.seg .seg-label { padding: 6px 8px; font-size: var(--fs-meta); color: var(--text-muted); font-variant-numeric: tabular-nums; }

/* ---- tables ---- */
/* scrolls inside its own box on a narrow screen instead of dragging the whole page sideways */
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--r-md); }
.table { width: 100%; border-collapse: collapse; font-size: var(--fs-dense); }
.table th { background: var(--surface-2); color: var(--text-muted); font-weight: 500; text-align: left; padding: var(--s2) var(--s3); white-space: nowrap; }
.table td { padding: var(--s2) var(--s3); border-top: 1px solid var(--border); }
.table tr:hover td { background: var(--surface-hover); }
.table .num { text-align: right; font-variant-numeric: tabular-nums; }

/* ---- status ---- */
.badge { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-meta); font-weight: 500; border-radius: 999px; padding: 2px 9px; }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge-ok { color: var(--ok); background: var(--ok-soft); }
.badge-warn { color: var(--warn); background: var(--warn-soft); }
.badge-bad { color: var(--bad); background: var(--bad-soft); }
.badge-neutral { color: var(--text-muted); background: var(--surface-2); }
.statusbar { display: flex; flex-wrap: wrap; gap: var(--s2); }
.stat { display: inline-flex; align-items: center; gap: var(--s2); padding: 7px 12px; border-radius: var(--r-md);
  background: var(--surface-1); border: 1px solid var(--border); font-size: var(--fs-dense); font-weight: 500; }
.stat-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); }
.stat-dot.ok { background: var(--ok); } .stat-dot.warn { background: var(--warn); } .stat-dot.bad { background: var(--bad); }

/* ---- page header ---- */
.page-head { display: flex; align-items: flex-end; flex-wrap: wrap; gap: var(--s3) var(--s4); padding: var(--s5) var(--s5) var(--s4); }
.page-title { font-size: var(--fs-title); font-weight: 600; letter-spacing: -0.02em; margin: 0; line-height: 1.15; }
.page-sub { color: var(--text-muted); font-size: var(--fs-dense); margin-top: 2px; }
.page-actions { margin-left: auto; display: flex; align-items: center; flex-wrap: wrap; gap: var(--s2); }

/* ---- empty state ---- */
.empty { display: grid; place-items: center; gap: var(--s2); padding: var(--s6); color: var(--text-faint); text-align: center; }
```

- [ ] **Step 2: Run the colour test**

Run: `node cctv/test/css-tokens.test.mjs`
Expected: `all passed` (components.css uses only tokens).

- [ ] **Step 3: Commit**

```bash
git add cctv/public/css/components.css
git commit -m "Redesign: one set of buttons, panels, forms, tables and badges"
```

---

### Task 3: Navigation model and theme logic (pure, tested)

**Files:**
- Create: `cctv/public/nav-model.js`
- Create: `cctv/public/theme.js`
- Test: `cctv/test/nav-model.test.mjs`

**Interfaces:**
- Produces:
  - `NAV_GROUPS: { id: string, label: string, adminOnly: boolean, items: { id, label, href, icon }[] }[]`
  - `navFor({ admin: boolean }) -> same shape, admin group removed when admin is false`
  - `currentId(pathname: string) -> string|null` (`'/'` and `'/index.html'` → `'live'`)
  - `PHONE_BAR: string[]` = `['live','playback','alarms','health']`
  - `nextTheme(t: 'dark'|'light') -> 'dark'|'light'`
  - `readTheme(storage) -> 'dark'|'light'` (default `'dark'`, never throws)
  - `saveTheme(storage, t) -> boolean` (never throws)

- [ ] **Step 1: Write the failing test**

```js
// cctv/test/nav-model.test.mjs
//   node cctv/test/nav-model.test.mjs
// The navigation used to be ten links copied by hand into every page, and the copies had drifted:
// a duplicate Storage tab on one page, Audit missing from another. One model now decides it.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { NAV_GROUPS, PHONE_BAR, currentId, navFor } from '../public/nav-model.js'
import { nextTheme, readTheme, saveTheme } from '../public/theme.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const ids = (groups) => groups.flatMap((g) => g.items.map((i) => i.id))
check('three groups in order', NAV_GROUPS.map((g) => g.id).join() === 'watch,monitor,admin')
check('watch holds live, playback, wall, map', ids([NAV_GROUPS[0]]).join() === 'live,playback,wall,map')
check('monitor holds alarms, health', ids([NAV_GROUPS[1]]).join() === 'alarms,health')
check('admin holds sites, settings, storage, audit', ids([NAV_GROUPS[2]]).join() === 'sites,settings,storage,audit')
check('no item appears twice', new Set(ids(NAV_GROUPS)).size === ids(NAV_GROUPS).length)
check('only the admin group is admin-only', NAV_GROUPS.filter((g) => g.adminOnly).map((g) => g.id).join() === 'admin')

check('an admin sees all ten', ids(navFor({ admin: true })).length === 10)
check('a viewer never sees the admin pages', !ids(navFor({ admin: false })).some((i) => ['sites', 'settings', 'storage', 'audit'].includes(i)))
check('an unknown user is treated as a viewer', ids(navFor({})).length === 6)

check('/ is live', currentId('/') === 'live')
check('/index.html is live', currentId('/index.html') === 'live')
check('/playback.html is playback', currentId('/playback.html') === 'playback')
check('/settings.html is settings', currentId('/settings.html') === 'settings')
check('a query string does not confuse it', currentId('/health.html?x=1') === 'health')
check('an unknown page marks nothing', currentId('/login.html') === null)

const pub = join(import.meta.dirname, '..', 'public')
for (const i of NAV_GROUPS.flatMap((g) => g.items)) {
  const file = i.href === '/' ? 'index.html' : i.href.slice(1)
  check(`${i.label} points at a page that exists`, existsSync(join(pub, file)), file)
}
check('the phone bar is the four used most', PHONE_BAR.join() === 'live,playback,alarms,health')
check('every phone-bar item is a real item', PHONE_BAR.every((p) => ids(NAV_GROUPS).includes(p)))

// themes
const mem = (init = {}) => { const m = { ...init }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v) }, m } }
check('dark by default', readTheme(mem()) === 'dark')
check('a saved light is read back', readTheme(mem({ 'cctv.theme': 'light' })) === 'light')
check('rubbish in storage means dark', readTheme(mem({ 'cctv.theme': 'purple' })) === 'dark')
const broken = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
check('a blocked store means dark, not a crash', readTheme(broken) === 'dark')
check('no store at all means dark', readTheme(null) === 'dark')
check('the toggle flips', nextTheme('dark') === 'light' && nextTheme('light') === 'dark')
const s = mem()
check('saving works', saveTheme(s, 'light') === true && s.m['cctv.theme'] === 'light')
check('saving to a blocked store says so rather than throwing', saveTheme(broken, 'light') === false)
check('saving nonsense is refused', saveTheme(mem(), 'purple') === false)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node cctv/test/nav-model.test.mjs`
Expected: FAIL — `Cannot find module '../public/nav-model.js'`.

- [ ] **Step 3: Write `nav-model.js`**

```js
// Where every page lives and who may see it, in one place.
//
// The ten links used to be typed out by hand in every page's HTML, and the copies drifted: one page
// grew a duplicate Storage tab, another lost Audit. Pure and DOM-free, so the rules are tested with
// plain node; shell.js does the drawing.

/** Grouped as the sidebar shows them. `icon` names a symbol in icons.js. */
export const NAV_GROUPS = Object.freeze([
  { id: 'watch', label: 'Watch', adminOnly: false, items: [
    { id: 'live', label: 'Live', href: '/', icon: 'live' },
    { id: 'playback', label: 'Playback', href: '/playback.html', icon: 'playback' },
    { id: 'wall', label: 'Wall', href: '/wall.html', icon: 'wall' },
    { id: 'map', label: 'Map', href: '/map.html', icon: 'map' }
  ] },
  { id: 'monitor', label: 'Monitor', adminOnly: false, items: [
    { id: 'alarms', label: 'Alarms', href: '/alarms.html', icon: 'bell' },
    { id: 'health', label: 'Health', href: '/health.html', icon: 'pulse' }
  ] },
  { id: 'admin', label: 'Admin', adminOnly: true, items: [
    { id: 'sites', label: 'Sites', href: '/sites.html', icon: 'site' },
    { id: 'settings', label: 'Settings', href: '/settings.html', icon: 'cog' },
    { id: 'storage', label: 'Storage', href: '/storage.html', icon: 'disk' },
    { id: 'audit', label: 'Audit', href: '/audit.html', icon: 'list' }
  ] }
])

/** The four a phone shows along the bottom; everything else is under More. */
export const PHONE_BAR = Object.freeze(['live', 'playback', 'alarms', 'health'])

/**
 * The groups this person may see. Hiding the admin pages grants and takes nothing -- every route
 * behind them checks rights for itself -- it only spares a viewer links to pages that would refuse
 * them. Anyone not positively an admin is treated as a viewer.
 */
export function navFor({ admin = false } = {}) {
  return NAV_GROUPS.filter((g) => !g.adminOnly || admin === true)
}

/** Which item a page path belongs to, or null for pages outside the navigation. */
export function currentId(pathname) {
  const path = String(pathname ?? '').split(/[?#]/)[0]
  const p = path === '/index.html' ? '/' : path
  for (const g of NAV_GROUPS) for (const i of g.items) if (i.href === p) return i.id
  return null
}
```

- [ ] **Step 4: Write `theme.js`**

```js
// Dark or light, remembered per browser. Pure apart from the storage it is handed, so the rules are
// tested without a browser. Every storage call is guarded: a private window or blocked site data
// makes localStorage throw, and a theme preference is never worth breaking a page over.
export const THEME_KEY = 'cctv.theme'
const THEMES = ['dark', 'light']

/** The saved theme, or dark. Never throws. */
export function readTheme(storage) {
  try {
    const v = storage?.getItem(THEME_KEY)
    return THEMES.includes(v) ? v : 'dark'
  } catch {
    return 'dark'
  }
}

/** Saves a theme; false when it could not be stored or is not a theme. Never throws. */
export function saveTheme(storage, theme) {
  if (!THEMES.includes(theme)) return false
  try {
    storage.setItem(THEME_KEY, theme)
    return true
  } catch {
    return false
  }
}

export const nextTheme = (t) => (t === 'light' ? 'dark' : 'light')
```

- [ ] **Step 5: Run the test**

Run: `node cctv/test/nav-model.test.mjs`
Expected: `all passed`.

- [ ] **Step 6: Commit**

```bash
git add cctv/public/nav-model.js cctv/public/theme.js cctv/test/nav-model.test.mjs
git commit -m "Redesign: one navigation model, and the theme rules, both tested"
```

---

### Task 4: Icons, the shell, and first-paint theme

**Files:**
- Create: `cctv/public/icons.js`
- Create: `cctv/public/theme-boot.js`
- Create: `cctv/public/shell.js`
- Create: `cctv/public/css/shell.css`
- Test: `cctv/test/css-tokens.test.mjs` (must still pass), `cctv/test/nav-model.test.mjs`

**Interfaces:**
- Consumes: `NAV_GROUPS`, `navFor`, `currentId`, `PHONE_BAR` (Task 3); `readTheme`, `saveTheme`, `nextTheme`, `THEME_KEY` (Task 3); `GET /api/me` → `{ user, admin, build: { version, release } }`; `POST /api/logout`.
- Produces: `icon(name: string) -> string` (inline SVG markup); `mountShell() -> Promise<void>`; DOM: `<aside class="app-shell">` first in `<body>`, the page's other body children moved into `<div class="app-main">`, `body.has-shell`, `html[data-theme]`.

- [ ] **Step 1: Write `icons.js`**

```js
// The app's icons, drawn inline. One stroke width and one size so they read as a set; no icon
// font and no request to anywhere else, because this app is opened from outside the network.
const P = {
  live: '<rect x="3" y="5" width="13" height="14" rx="2.5"/><path d="M16 10l5-3v10l-5-3"/>',
  playback: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  wall: '<rect x="3" y="4" width="8" height="7" rx="2"/><rect x="13" y="4" width="8" height="7" rx="2"/><rect x="3" y="13" width="8" height="7" rx="2"/><rect x="13" y="13" width="8" height="7" rx="2"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/>',
  bell: '<path d="M6 16V11a6 6 0 1112 0v5l2 2H4l2-2zM10 20a2 2 0 004 0"/>',
  pulse: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  site: '<path d="M4 20V9l8-5 8 5v11M9 20v-6h6v6"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  disk: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  out: '<path d="M15 4h4v16h-4M10 17l5-5-5-5M15 12H3"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'
}
export const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] ?? ''}</svg>`
```

- [ ] **Step 2: Write `theme-boot.js`** (classic script, loaded in `<head>` without `defer`)

```js
// Sets the theme before the page paints, so a light-theme user never sees a flash of dark. It is a
// plain script rather than a module because modules run after first paint, which is exactly the
// flash this exists to prevent. Duplicates theme.js's key and rule on purpose: it cannot import.
try {
  if (localStorage.getItem('cctv.theme') === 'light') document.documentElement.dataset.theme = 'light'
} catch {}
```

- [ ] **Step 3: Write `shell.js`**

```js
// The frame around every page: the grouped sidebar on a desktop, an icon rail on a tablet, a bar
// along the bottom on a phone, and the theme switch.
//
// It works on the page as it stands: the page's own content is moved into <div class="app-main">
// and the shell goes beside it, so no page's markup had to be restructured to adopt it. It replaces
// the ten hand-copied header links and admin-tabs.js.
import { PHONE_BAR, currentId, navFor } from './nav-model.js'
import { icon } from './icons.js'
import { nextTheme, readTheme, saveTheme } from './theme.js'

const store = (() => { try { return window.localStorage } catch { return null } })()
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function applyTheme(t) {
  if (t === 'light') document.documentElement.dataset.theme = 'light'
  else delete document.documentElement.dataset.theme
}

function link(item, here, cls = '') {
  const on = item.id === here
  return `<a class="${cls}" href="${item.href}"${on ? ' aria-current="page"' : ''} title="${esc(item.label)}">${icon(item.icon)}<span>${esc(item.label)}</span></a>`
}

export async function mountShell() {
  if (document.body.classList.contains('has-shell')) return
  let me = {}
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' })
    if (r.ok) me = await r.json()
  } catch {
    // Not knowing who this is shows the viewer's navigation, which is the harmless way to be wrong.
  }
  const groups = navFor({ admin: me.admin === true })
  const here = currentId(location.pathname)
  const theme = readTheme(store)
  applyTheme(theme)

  // the page's own content, moved as it is into the main column
  const main = document.createElement('div')
  main.className = 'app-main'
  for (const n of [...document.body.childNodes]) if (!(n.nodeType === 1 && n.tagName === 'SCRIPT')) main.appendChild(n)

  const side = document.createElement('aside')
  side.className = 'app-shell'
  side.setAttribute('aria-label', 'Main')
  const version = me.build?.version ? esc(me.build.version) : ''
  side.innerHTML = `
    <a class="shell-brand" href="/"><span class="shell-logo">${icon('live')}</span><span>CCTV</span></a>
    <nav class="shell-nav">
      ${groups.map((g) => `<div class="shell-group"><div class="shell-group-label">${esc(g.label)}</div>${g.items.map((i) => link(i, here)).join('')}</div>`).join('')}
    </nav>
    <div class="shell-foot">
      <button type="button" class="shell-theme btn-ghost" data-theme-toggle title="Switch between dark and light">${icon(theme === 'light' ? 'moon' : 'sun')}<span>${theme === 'light' ? 'Dark theme' : 'Light theme'}</span></button>
      <div class="shell-user"><span class="shell-avatar">${esc((me.user ?? '?').slice(0, 1).toUpperCase())}</span>
        <span class="shell-who">${esc(me.user ?? '')}<small>${me.admin ? 'Administrator' : 'Viewer'}${version ? ` · ${version}` : ''}</small></span>
        <button type="button" class="btn-ghost btn-icon" data-sign-out title="Sign out" aria-label="Sign out">${icon('out')}</button></div>
    </div>`

  // the phone bar: the four used most, then More for everything else
  const all = groups.flatMap((g) => g.items)
  const bar = document.createElement('nav')
  bar.className = 'shell-bar'
  bar.setAttribute('aria-label', 'Main')
  const inBar = all.filter((i) => PHONE_BAR.includes(i.id))
  const rest = all.filter((i) => !PHONE_BAR.includes(i.id))
  bar.innerHTML = inBar.map((i) => link(i, here)).join('') +
    `<button type="button" class="shell-more-btn${rest.some((i) => i.id === here) ? ' on' : ''}" aria-expanded="false">${icon('more')}<span>More</span></button>`
  const sheet = document.createElement('div')
  sheet.className = 'shell-sheet'
  sheet.hidden = true
  sheet.innerHTML = rest.map((i) => link(i, here)).join('') +
    `<button type="button" class="shell-theme" data-theme-toggle>${icon(theme === 'light' ? 'moon' : 'sun')}<span>${theme === 'light' ? 'Dark theme' : 'Light theme'}</span></button>` +
    `<button type="button" data-sign-out>${icon('out')}<span>Sign out</span></button>`

  document.body.prepend(side)
  side.after(main)
  document.body.append(bar, sheet)
  document.body.classList.add('has-shell')

  const moreBtn = bar.querySelector('.shell-more-btn')
  moreBtn.addEventListener('click', () => {
    sheet.hidden = !sheet.hidden
    moreBtn.setAttribute('aria-expanded', String(!sheet.hidden))
  })
  for (const b of document.querySelectorAll('[data-theme-toggle]')) {
    b.addEventListener('click', () => {
      const t = nextTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
      applyTheme(t)
      saveTheme(store, t)
      for (const x of document.querySelectorAll('[data-theme-toggle]')) {
        x.innerHTML = `${icon(t === 'light' ? 'moon' : 'sun')}<span>${t === 'light' ? 'Dark theme' : 'Light theme'}</span>`
      }
    })
  }
  for (const b of document.querySelectorAll('[data-sign-out]')) {
    b.addEventListener('click', async () => {
      try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
      location.href = '/login.html'
    })
  }
}

mountShell()
```

- [ ] **Step 4: Write `css/shell.css`**

```css
/* The frame: sidebar, rail, phone bar. Pages keep their own layout inside .app-main. */
body.has-shell { display: grid; grid-template-columns: var(--shell-w) minmax(0, 1fr); min-height: 100vh; margin: 0; }
body.has-shell .app-main { display: flex; flex-direction: column; min-width: 0; min-height: 100vh; }

.app-shell { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; padding: var(--s4) var(--s3);
  background: var(--surface-1); border-right: 1px solid var(--border); overflow-y: auto; }
.shell-brand { display: flex; align-items: center; gap: var(--s3); padding: 2px var(--s2) var(--s5); color: var(--text);
  font-weight: 600; font-size: var(--fs-section); text-decoration: none; }
.shell-logo { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; background: var(--accent); color: var(--on-accent); }
.shell-logo .icon { width: 18px; height: 18px; }
.shell-group-label { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-faint);
  padding: var(--s4) var(--s3) var(--s2); }
.shell-nav a { display: flex; align-items: center; gap: var(--s3); padding: 9px var(--s3); border-radius: 9px; color: var(--text-muted);
  font-weight: 500; text-decoration: none; transition: background var(--t-fast), color var(--t-fast); }
.shell-nav a:hover { background: var(--surface-hover); color: var(--text); }
.shell-nav a[aria-current="page"] { background: var(--surface-3); color: var(--text); }
.shell-nav a[aria-current="page"] .icon { color: var(--accent-strong); }
.shell-nav .icon, .shell-foot .icon { width: 18px; height: 18px; flex: none; }
.shell-foot { margin-top: auto; padding-top: var(--s3); border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: var(--s2); }
.shell-theme { display: flex; align-items: center; gap: var(--s3); padding: var(--s2) var(--s3); border: 0; background: none;
  color: var(--text-muted); font: 500 var(--fs-dense) var(--font); border-radius: var(--r-sm); cursor: pointer; text-align: left; }
.shell-theme:hover { background: var(--surface-hover); color: var(--text); }
.shell-user { display: flex; align-items: center; gap: var(--s2); padding: var(--s1) var(--s2); }
.shell-avatar { width: 32px; height: 32px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2);
  font-weight: 600; font-size: var(--fs-dense); }
.shell-who { flex: 1; min-width: 0; font-size: var(--fs-dense); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shell-who small { display: block; color: var(--text-faint); font-size: 11px; }
.shell-bar, .shell-sheet { display: none; }

/* the old page header's brand and tab strip are replaced by the shell */
body.has-shell header .brand h1, body.has-shell header nav.tabs, body.has-shell header .account { display: none; }

/* tablet: an icon rail; labels live in the tooltips */
@media (max-width: 1199px) {
  body.has-shell { grid-template-columns: var(--rail-w) minmax(0, 1fr); }
  .app-shell { padding: var(--s4) var(--s2); align-items: center; }
  .shell-brand span:last-child, .shell-nav a span, .shell-group-label, .shell-theme span, .shell-who { display: none; }
  .shell-brand { padding: 0 0 var(--s4); }
  .shell-nav a { justify-content: center; width: 44px; height: 44px; padding: 0; }
  .shell-group + .shell-group { border-top: 1px solid var(--border); margin-top: var(--s2); padding-top: var(--s2); }
  .shell-foot { align-items: center; }
  .shell-user { flex-direction: column; }
}

/* phone: content full width, a bar along the bottom */
@media (max-width: 699px) {
  body.has-shell { grid-template-columns: minmax(0, 1fr); padding-bottom: calc(var(--bar-h) + env(safe-area-inset-bottom)); }
  .app-shell { display: none; }
  .shell-bar { display: grid; grid-template-columns: repeat(5, 1fr); position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
    height: calc(var(--bar-h) + env(safe-area-inset-bottom)); padding: var(--s2) 0 env(safe-area-inset-bottom);
    background: var(--surface-1); border-top: 1px solid var(--border); }
  .shell-bar a, .shell-bar button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
    border: 0; background: none; color: var(--text-faint); font: 500 10.5px var(--font); text-decoration: none; cursor: pointer; }
  .shell-bar [aria-current="page"], .shell-bar .on { color: var(--accent-strong); }
  .shell-bar .icon { width: 22px; height: 22px; }
  .shell-sheet { position: fixed; left: var(--s3); right: var(--s3); bottom: calc(var(--bar-h) + var(--s2) + env(safe-area-inset-bottom)); z-index: 51;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--s2); box-shadow: var(--shadow); }
  .shell-sheet:not([hidden]) { display: grid; }
  .shell-sheet a, .shell-sheet button { display: flex; align-items: center; gap: var(--s3); padding: var(--s3); border: 0; background: none;
    color: var(--text); font: 500 var(--fs-body) var(--font); text-decoration: none; border-radius: var(--r-sm); cursor: pointer; text-align: left; }
  .shell-sheet .icon { width: 20px; height: 20px; color: var(--text-muted); }
}
```

- [ ] **Step 5: Run tests**

Run: `node cctv/test/css-tokens.test.mjs && node cctv/test/nav-model.test.mjs && node --check cctv/public/shell.js && node --check cctv/public/icons.js`
Expected: both `all passed`; no syntax errors.

- [ ] **Step 6: Commit**

```bash
git add cctv/public/icons.js cctv/public/theme-boot.js cctv/public/shell.js cctv/public/css/shell.css
git commit -m "Redesign: the shell -- sidebar, rail, phone bar, and a dark/light switch"
```

---

### Task 5: Put every page in the shell

**Files:**
- Modify: `cctv/public/{index,playback,wall,map,alarms,health,sites,settings,storage,audit}.html` — `<head>` and the header nav
- Delete: `cctv/public/admin-tabs.js` (the shell does its job)
- Modify: `cctv/public/style.css` — body layout rules that fight the shell
- Test: `cctv/test/pages-shell.test.mjs`

**Interfaces:**
- Consumes: `theme-boot.js`, `css/tokens.css`, `css/base.css`, `css/components.css`, `css/shell.css`, `shell.js`.

- [ ] **Step 1: Write the failing test**

```js
// cctv/test/pages-shell.test.mjs
// Every page in the navigation carries the shell, loads the new stylesheets before the old one,
// sets its theme before painting, and no longer carries its own copy of the tabs.
//   node cctv/test/pages-shell.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAV_GROUPS } from '../public/nav-model.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const pub = join(import.meta.dirname, '..', 'public')
for (const i of NAV_GROUPS.flatMap((g) => g.items)) {
  const file = i.href === '/' ? 'index.html' : i.href.slice(1)
  const html = readFileSync(join(pub, file), 'utf8')
  const pos = (s) => html.indexOf(s)
  check(`${file}: theme set before paint`, pos('src="theme-boot.js"') > 0 && pos('src="theme-boot.js"') < pos('</head>') && !/theme-boot\.js"[^>]*\b(defer|async|type="module")/.test(html))
  for (const css of ['css/tokens.css', 'css/base.css', 'css/components.css', 'css/shell.css']) check(`${file}: loads ${css}`, pos(`href="${css}"`) > 0)
  check(`${file}: new styles load before style.css`, pos('href="css/shell.css"') < pos('href="style.css"') || pos('href="style.css"') < 0)
  check(`${file}: runs the shell`, /<script type="module" src="shell\.js"><\/script>/.test(html))
  check(`${file}: no hand-copied tabs left`, !/<nav class="tabs"/.test(html))
  check(`${file}: admin-tabs.js is gone`, !html.includes('admin-tabs.js'))
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node cctv/test/pages-shell.test.mjs`
Expected: many FAILs (no page loads the shell yet).

- [ ] **Step 3: Edit the ten pages with a script** (one mechanical change, applied the same way to every page)

```js
// run once: node -e "<this>" from the repo root
const fs = require('fs'), path = require('path')
const pub = 'cctv/public'
const pages = ['index', 'playback', 'wall', 'map', 'alarms', 'health', 'sites', 'settings', 'storage', 'audit']
const HEAD = '  <script src="theme-boot.js"></script>\n' +
  '  <link rel="stylesheet" href="css/tokens.css" />\n  <link rel="stylesheet" href="css/base.css" />\n' +
  '  <link rel="stylesheet" href="css/components.css" />\n  <link rel="stylesheet" href="css/shell.css" />\n'
for (const p of pages) {
  const f = path.join(pub, `${p}.html`)
  let h = fs.readFileSync(f, 'utf8')
  if (!h.includes('theme-boot.js')) {
    // before the first stylesheet, so the old style.css still wins where a page relies on it
    const i = h.indexOf('<link rel="stylesheet"')
    h = h.slice(0, i) + HEAD.trimStart() + '  ' + h.slice(i)
  }
  h = h.replace(/\s*<nav class="tabs"[\s\S]*?<\/nav>/, '')
  h = h.replace(/\s*<script type="module" src="admin-tabs\.js"><\/script>/g, '')
  if (!h.includes('src="shell.js"')) h = h.replace('</body>', '  <script type="module" src="shell.js"></script>\n</body>')
  fs.writeFileSync(f, h)
  console.log('updated', p)
}
```

Then delete `cctv/public/admin-tabs.js`.

- [ ] **Step 4: Stop `style.css` fighting the shell**

In `cctv/public/style.css`, the `html, body { height: 100%; }` and `body { display: flex; flex-direction: column; }` rules make body the page's flex column. With the shell, that job belongs to `.app-main`. Append:

```css
/* In the shell, body is the two-column frame and .app-main is the page's own column. The rules above
   made body that column; these hand the job over without editing every page. */
body.has-shell { display: grid; height: auto; }
body.has-shell .app-main > header { background: none; border-bottom: 1px solid var(--border); }
```

- [ ] **Step 5: Run the tests**

Run: `node cctv/test/pages-shell.test.mjs && node cctv/test/nav-model.test.mjs && node cctv/test/css-tokens.test.mjs && node cctv/test/health-page.test.mjs`
Expected: all `all passed`.

- [ ] **Step 6: Preflight and look at every page**

Start the preflight instance on the production box (see Global Constraints). In the browser, open each of the ten pages at 1400, 900 and 375px wide and confirm: the sidebar/rail/bar appears, the current page is highlighted, the page's own controls are all still present and working, the theme toggle switches and survives a reload, and Sign out works. Check `grep -iE "Error:|not a function" out.log` is empty.

- [ ] **Step 7: Commit and deploy**

```bash
git add -A cctv/public cctv/test/pages-shell.test.mjs
git commit -m "Redesign: every page inside the new shell; the ten copied tab strips are gone"
bash deploy/push.sh --linux cctv@192.168.2.115 --code-only
```

Then confirm on the live server: service active, zero errors in the last three minutes, cameras recording unchanged.

---

### Task 6: The Live screen

**Files:**
- Modify: `cctv/public/index.html` — header becomes page head + toolbar
- Modify: `cctv/public/viewer.js` — status strip and site pills
- Modify: `cctv/public/live-tile.js:19` — `TILE_HTML` puts the label under the picture
- Create: `cctv/public/css/pages/live.css`
- Test: `cctv/test/live-tile.test.mjs` (existing — must pass), `cctv/test/grid-view.test.mjs`, new `cctv/test/live-summary.test.mjs`

**Interfaces:**
- Consumes: components from Task 2.
- Produces: `liveSummary(cameras: {online: boolean, recording?: boolean}[]) -> { total, online, offline, recording }` in new `cctv/public/live-summary.js`.

- [ ] **Step 1: Write the failing test**

```js
// cctv/test/live-summary.test.mjs
//   node cctv/test/live-summary.test.mjs
import { liveSummary } from '../public/live-summary.js'
let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const s = liveSummary([{ online: true, recording: true }, { online: true, recording: false }, { online: false }, { online: true }])
check('counts every camera', s.total === 4)
check('counts online and offline', s.online === 3 && s.offline === 1, JSON.stringify(s))
// recording is only claimed where it is known; a camera whose state was not reported is not counted
check('counts only cameras known to be recording', s.recording === 1)
check('an empty list is all zeros, not a crash', JSON.stringify(liveSummary([])) === '{"total":0,"online":0,"offline":0,"recording":null}')
check('recording is null when nothing reports it, never 0', liveSummary([{ online: true }]).recording === null)
check('rubbish in is not a crash', liveSummary(null).total === 0)
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node cctv/test/live-summary.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `live-summary.js`**

```js
// The line of counts above the camera grid: how many are online, offline and recording. The live
// list does not always know whether a camera is recording, and "0 recording" on a site that is
// recording perfectly well would be a false alarm -- so recording is null until something reports it.
export function liveSummary(cameras) {
  const list = Array.isArray(cameras) ? cameras : []
  const online = list.filter((c) => c?.online === true).length
  const known = list.filter((c) => typeof c?.recording === 'boolean')
  return {
    total: list.length,
    online,
    offline: list.length - online,
    recording: known.length ? known.filter((c) => c.recording).length : null
  }
}
```

- [ ] **Step 4: Run it**

Run: `node cctv/test/live-summary.test.mjs`
Expected: `all passed`.

- [ ] **Step 5: Put the name under the picture**

In `cctv/public/live-tile.js:19` change `TILE_HTML` to wrap the picture layers so the label sits below them:

```js
export const TILE_HTML = '<div class="tile-pic"><canvas></canvas><canvas class="osd"></canvas><pre class="stats"></pre></div><div class="label"><span class="dot dot-off" title="No video: nothing is arriving from this camera"></span><span class="name"></span><span class="status"></span></div>'
```

Then grep `live-tile.js`, `viewer.js`, `grid-drag.js` and `image-panel.js` for every selector that assumes the canvas is a direct child of `.tile` (`tile.querySelector('canvas')`, `:scope > canvas`, `.tile > canvas`, `.tile canvas`) and confirm each still finds the right element — `querySelector('canvas')` still returns the video canvas first. Run `node cctv/test/live-tile.test.mjs`; it must pass.

- [ ] **Step 6: Write `css/pages/live.css`**

```css
/* The Live screen: cameras as cards with their name underneath the picture rather than printed
   over the video, which was the single biggest thing making the old grid look home-made. */
#grid { gap: var(--s4); padding: 0 var(--s5) var(--s5); background: none; }
#grid .tile { display: flex; flex-direction: column; background: var(--surface-1); border: 1px solid var(--border);
  border-radius: var(--r-lg); overflow: hidden; box-shadow: var(--shadow); }
#grid .tile .tile-pic { position: relative; flex: 1; min-height: 0; background: var(--video-bg); }
#grid .tile .tile-pic canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
#grid .tile .label { position: static; display: flex; align-items: center; gap: var(--s2); padding: 9px var(--s3);
  background: none; font-size: var(--fs-dense); color: var(--text); text-shadow: none; }
#grid .tile .label .name { font-weight: 600; }
#grid .tile .label .status { margin-left: auto; color: var(--text-faint); font-size: var(--fs-meta); }
.live-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s3); padding: 0 var(--s5) var(--s4); }
.live-toolbar .sp { flex: 1; }
@media (max-width: 699px) {
  .page-head, .live-toolbar { padding-left: var(--s4); padding-right: var(--s4); }
  #grid { padding: 0 var(--s3) var(--s4); gap: var(--s3); }
}
```

Add `<link rel="stylesheet" href="css/pages/live.css" />` to `index.html` after `style.css` (page CSS is allowed to override old rules; it must still use only tokens — the colour test covers it).

- [ ] **Step 7: Rebuild the Live header**

In `index.html`, replace the contents of `<header>` (keeping every element id, because `viewer.js` looks them up by id) with:

```html
<header class="live-head">
  <div class="page-head">
    <div><h1 class="page-title">Live</h1><div class="page-sub" id="liveSub"></div></div>
    <div class="page-actions">
      <div class="pills" id="sitePills" role="group" aria-label="Site"></div>
      <label id="siteLabel" class="visually-hidden">Site <select id="site"><option value="">All sites</option></select></label>
    </div>
  </div>
  <div class="live-toolbar">
    <div class="statusbar" id="liveStats"></div>
    <span class="sp"></span>
    <label class="field">Layout
      <select id="layout">
        <optgroup label="Grid"><option value="g1">1</option><option value="g2">2 × 2</option><option value="g3" selected>3 × 3</option><option value="g4">4 × 4</option><option value="g5">5 × 5</option><option value="g6">6 × 6</option><option value="g8">8 × 8</option></optgroup>
        <optgroup label="Featured"><option value="1+5">1 large + 5</option><option value="1+7">1 large + 7</option><option value="1+12">1 large (centre) + 12</option><option value="2+8">2 large + 8</option></optgroup>
      </select>
    </label>
    <label class="field-check"><input id="hideOffline" type="checkbox" checked /> Hide offline</label>
    <label class="field-check"><input id="smooth" type="checkbox" /> Smooth</label>
    <button id="resetOrder" class="btn btn-sm" type="button" hidden>Reset order</button>
    <div class="seg"><button id="prev" type="button" aria-label="Previous page">‹</button><span id="page" class="seg-label">1 / 1</span><button id="next" type="button" aria-label="Next page">›</button></div>
    <button id="fullscreen" class="btn btn-icon" type="button" title="Full screen (F)" aria-label="Full screen"></button>
  </div>
</header>
```

Keep any other header children (for example `#orderNote`, `#build`) that `viewer.js` references — check with `grep -oE "getElementById\\('[^']+'\\)" viewer.js`.

In `viewer.js`, after the camera list loads and whenever it refreshes:
- fill `#liveStats` from `liveSummary(cameras)` as `.stat` items (online/offline always; recording only when not null), each with a `.stat-dot` of class `ok`/`bad`/`warn`;
- set `#liveSub` to the selected site name (or "All sites") and today's date;
- render one `<button aria-pressed>` per option of `#site` into `#sitePills`; a click sets `siteSelect.value` and dispatches `change` on it, so the existing site logic is reused unchanged; hide `#sitePills` when there is only one site;
- put `icon('full')` into `#fullscreen`.

- [ ] **Step 8: Run all affected tests**

Run: `node cctv/test/live-summary.test.mjs && node cctv/test/live-tile.test.mjs && node cctv/test/grid-view.test.mjs && node cctv/test/css-tokens.test.mjs && node cctv/test/pages-shell.test.mjs`
Expected: all `all passed`.

- [ ] **Step 9: Preflight and look**

On the preflight instance, open Live at 1400, 900 and 375px, dark and light. Confirm: cards with the name under the picture; site pills switch sites; layout, hide offline, smooth, paging, drag-to-reorder, full screen, double-click to a single camera, and the picture panel all still work. On the real server after deploy, confirm live video actually plays in the cards.

- [ ] **Step 10: Commit and deploy**

```bash
git add -A cctv/public cctv/test/live-summary.test.mjs
git commit -m "Redesign: the Live screen -- camera cards, site pills and a status line"
bash deploy/push.sh --linux cctv@192.168.2.115 --code-only
```

Then confirm on the live server: zero errors, cameras recording unchanged, public URL answering.
