# GUI redesign — design

**Date:** 2026-09-26
**Status:** approved direction (UniFi Protect), spec awaiting review

## Why

The owner's verdict: the interface looks unprofessional and DIY. The causes are measurable:

- 13 pages share one 1,322-line `style.css` containing **69 distinct hard-coded colours** — no palette,
  so every page drifts.
- **10 flat tabs** in the header, repeated by hand in every page's HTML. The copies had already
  drifted apart: a duplicate Storage tab, and Audit/Storage present on some pages and not others.
- Each page grew its own component vocabulary (`.pb-` 138 rules, `.map-` 89, `.ip-` 76, `.st-` 62,
  `.wall-` 43, `.se-` 41 …), so the same button or panel looks different page to page.

It will be used everywhere — desktop, laptop, tablet, phone — and is now reachable from the internet,
so it is also the face the system shows to anyone who opens it.

## Direction

Modelled on **UniFi Protect**: a calm dark interface, one accent colour, generous consistent spacing,
and every page assembled from the same small set of parts. Colour carries meaning (status) rather
than decoration.

No framework. Plain HTML, CSS and ES modules, as the rest of the codebase is.

## Stages

Each stage deploys on its own and leaves every page working.

1. **Foundation + shell** (this spec, in detail): tokens, base styles, components, and a shared
   navigation shell that every page uses.
2. **Live and Playback** — the daily screens, rebuilt on the foundation.
3. **Admin pages** — Settings, Sites, Health, Storage, Audit, Alarms.
4. **Map and Wall.**

Stages 2–4 get their own short plans once stage 1 has landed; they are listed here so the foundation
is designed for them.

Before stage 2 rebuilds anything, a mockup of the new Live screen is shown to the owner for a yes or no.

## 1. Tokens — `public/css/tokens.css`

Every colour, size and radius in the app comes from these. A hard-coded colour outside this file is a
bug, and a test enforces it (see Testing).

**Surfaces** (darkest to lightest)
| token | value | use |
|---|---|---|
| `--bg` | `#111315` | page background |
| `--surface-1` | `#181a1d` | sidebar, panels |
| `--surface-2` | `#202327` | cards, inputs, table headers |
| `--surface-3` | `#2a2e33` | hover, selected rows |
| `--border` | `#2f3338` | dividers, input borders |

**Text**
| token | value | use |
|---|---|---|
| `--text` | `#e8eaed` | body text |
| `--text-muted` | `#9aa0a6` | labels, secondary |
| `--text-faint` | `#6b7178` | hints, disabled |

**Accent and status** — status colours are used only for status, never decoration.
| token | value | use |
|---|---|---|
| `--accent` | `#3b82f6` | primary buttons, active nav, focus, links |
| `--ok` | `#22c55e` | recording, online, healthy |
| `--warn` | `#f59e0b` | degraded, attention |
| `--bad` | `#ef4444` | offline, failed, danger actions |

Each status colour also has a `-soft` variant (the same hue at ~15 % alpha) for badge backgrounds.

**Type** — `system-ui` stack. Sizes: 12 (meta), 13 (dense UI, tables), 14 (body), 16 (section
titles), 20 (page titles), 28 (big figures on cards). Weights 400 / 500 / 600 only.

**Spacing** — a 4px scale: `--s1` 4, `--s2` 8, `--s3` 12, `--s4` 16, `--s5` 24, `--s6` 32.

**Radius** — `--r-sm` 6px (inputs, buttons, badges), `--r-md` 10px (cards, panels, video tiles).

**Motion** — 120ms ease for hover/press; none under `prefers-reduced-motion`.

## 2. Base — `public/css/base.css`

Reset, body background and type, focus ring (2px `--accent`, offset 2px, visible on keyboard focus
only), scrollbars styled to the surfaces, and a visually-hidden utility for labels.

## 3. Components — `public/css/components.css`

One definition each. Page CSS may position them but not restyle them.

- **Buttons**: `.btn` (secondary, surface-2), `.btn-primary` (accent), `.btn-danger` (bad), `.btn-ghost`
  (no background); sizes default (32px high) and `.btn-sm` (28px); `.btn-icon` square. Disabled and
  busy states.
- **Panel / card**: `.panel` (surface-1, radius-md, padding s5) with an optional `.panel-head`
  (title + actions on one row). `.card` for the stat cards on Health/Storage: label, big figure,
  meta line, and a status edge.
- **Forms**: `.field` = label above control, help text below; `.field-row` lays fields in a
  responsive grid whose columns are sized to content, never stretched across the page. Inputs,
  selects, checkboxes, toggles and segmented controls share heights and borders.
- **Tables**: `.table` — surface-2 header, 13px, row hover, numeric columns right-aligned; scrolls
  inside its own container on narrow screens rather than widening the page.
- **Status badge**: `.badge` + `.badge-ok/-warn/-bad/-neutral` — soft background, coloured text, a dot.
- **Empty state**: icon, one sentence, optional action — replacing today's plain text notices.
- **Dialog**: one modal style (surface-1, radius-md, title / body / actions).
- **Toast**: for "saved", "failed", replacing inline status spans that shift layout.
- **Disclosure**: `.more` for folded-away explanations.

## 4. Shell — navigation

**Structure.** Items grouped, with the admin group hidden from non-admins:

- *Watch*: Live, Playback, Wall, Map
- *Monitor*: Alarms, Health
- *Admin*: Sites, Settings, Storage, Audit

**Layouts by width**
- ≥ 1200px: left sidebar, 232px, icon + label, grouped with small group headings. Build badge and
  the signed-in user with Sign out at the foot.
- 700–1199px: icon rail, 64px, labels as tooltips; expands on demand.
- < 700px: bottom bar with Live, Playback, Alarms, Health and a *More* sheet for the rest; the page
  header shows the page title.

**One source of truth.** A pure module `public/nav-model.js` defines the items, groups, icons and
which require admin; `public/shell.js` renders the shell into a `<div id="shell">` placeholder on
every page and marks the current item. This removes the thirteen hand-copied `<nav>` blocks — the
source of the duplicate and missing tabs — and absorbs `admin-tabs.js`.

Page content sits in a `<main>` with a consistent page header: title, optional subtitle, and page
actions on the right.

**Icons.** A small inline SVG set (about 16, one stroke width), in `public/icons.js`. No icon font,
no external request.

## 5. File layout

```
public/css/tokens.css
public/css/base.css
public/css/components.css
public/css/shell.css
public/css/pages/<page>.css      one per page, positioning only
public/nav-model.js              pure, tested
public/shell.js                  renders the shell
public/icons.js
```

`style.css` is retired page by page as each is moved across; until then it is still loaded by pages
not yet migrated, so nothing breaks mid-way.

## Error handling and honesty

The existing rule stands everywhere: a figure that was not read shows "not available", never 0.
Empty states say *why* something is empty ("No cameras on this site yet", "Nothing recorded at this
time") rather than showing a blank area. Failed saves show a toast that says what failed and leaves
the form as the user left it.

## Testing

- `test/nav-model.test.mjs` (plain node, Windows-safe): the right items for admin and non-admin,
  grouping, the current item for every page path, no duplicates, every item's page exists.
- `test/tokens.test.mjs`: scans the new CSS files and fails on any hard-coded colour outside
  `tokens.css` — the rule that stops the 69-colour drift coming back.
- Existing page tests (`health-page`, `smart-view`, `osd-overlay`, `grid-view`, …) must still pass;
  the pure render modules are not being rewritten, only restyled.
- Visual check of every migrated page in a real browser at 1400, 900 and 375px wide, on the
  production server behind the preflight instance, before each deploy.
- No feature may disappear: each page's controls are listed before migration and checked after.

## Out of scope

- Changing what any page does. This is presentation and navigation only.
- Light mode. The tokens make it possible later; nobody has asked for it.
- The evidence pack player (`pack-player.html`), which is self-contained by design and travels with
  exported evidence.
