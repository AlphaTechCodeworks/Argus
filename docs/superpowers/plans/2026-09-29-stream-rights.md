# Stream Rights (Live HD, Playback SD/HD) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user, per-site/per-camera stream rights in the access editor (Live, Live HD, Playback SD, Playback HD, Export), enforced on the server so no link, message or indirect path hands main-stream pictures to someone without the right, with a migration that keeps everyone's live access as it is (spec 3.2 names the one narrowing: Playback SD beyond Live).

**Architecture:** rights.mjs gains one stored action, `live-hd` (counts only with `live`), a single "may see main" helper `mayHd` (Live HD or Playback HD) for recorded and still pictures, and a version 2 file with a shadow (written before rights.json) for safe rollback. Every place that hands out main-stream pictures asks it: `attachLive` (direct main, the sub-bridge stand-in, which is replaced by wait notices for viewers without Live HD), `connectPlayback` and the NVR `PlaybackSession` (main, HD-only cameras, the 4 s switch, fixed first in Task 4 and asked from the session as it is at that moment), and the event snapshot (an SD copy for viewers without HD). The access watch learns "any of" needs and the `'hd not allowed'` reason; the pages learn per-camera flags from `/api/cameras` and only offer what the server will play; the editor gets five columns.

**Tech Stack:** Node ESM (`.mjs`), `ws`, the TVT SDK through koffi (playback.mjs only), ffmpeg (event snapshot), plain browser JS modules; tests are plain node scripts printing `PASS`/`FAIL` lines.

**Spec:** `docs/superpowers/specs/2026-09-29-stream-rights-design.md` (read it first: section 2 is the enforcement table every task implements rows of).

## Global Constraints

- Repo root for every command: `C:\Users\mike\Downloads\websdk3.2\TVT-CCTV-streams` (git worktree, branch `stream-rights`). Tests run with `node cctv/test/<name>.test.mjs` from there.
- Line numbers are at 119c43e. After an earlier task has edited a file (rights.mjs, rights.test.mjs, access-watch.test.mjs, server.mjs, playback.mjs, hd-only.mjs, pb-sources.js and its test are edited by more than one task), find the place by the text quoted with the number, never by the number alone; a step that says "replace lines A-B" also quotes the first and last of them.
- Default deny. Every decision is made on the server, on parsed values (never on the raw query text), before anything is started or attached.
- Action ids are unchanged: `live`, `playback-server` (label "Playback HD"), `playback-nvr` (label "Playback SD"), `export`, `admin`; only `live-hd` is added, right after `live`: `ACTIONS = ['live', 'live-hd', 'playback-server', 'playback-nvr', 'export', 'admin']`.
- `can(who, 'live-hd', t)` is true only where `live` also covers the camera (admins always). Live main needs `live-hd`; recorded or still main needs `mayHd` = `live-hd` OR `playback-server`; NVR main needs `playback-nvr` AND `mayHd`.
- Close reasons, exact strings: `'hd not allowed'` (1008, new), `'not allowed'` (1008), `'signed out'` (1008), `'bad parameters'` (1008, `/playback`), `'bad channel or stream'` (1008, live). Server playback refused for rights is 1008 `'not allowed'` (was 1011); "no index / no footage" stays 1011.
- Wait notice: always a JSON object sent as text: `{"op":"wait","why":W}` on `/live`, `{"op":"wait","id":N,"why":W}` on `/live-mux`; `W` is `'held'`, `'starting'` or `'unavailable'`; sent at once and every 4000 ms until the sub-stream's first frame; never through a sub-bridge.
- **A1:** never modify `cctv/events.mjs` or `cctv/test/events.test.mjs`.
- **A3:** keep edits to `cctv/live-attach.mjs` and `cctv/live-mux.mjs` small and self-contained (the waiting logic lives in the new `cctv/live-wait.mjs`); never touch `cctv/public/playout.js`. No outage-buffer pause switch, no stutter fixes.
- **A4:** every protocol addition is safe for pages loaded before the deploy (spec 4.6): wait notices are JSON objects, new ops are ignorable, new fields are additive.
- **A5:** commit on branch `stream-rights` only; never push, merge or deploy. Every commit message ends with exactly one trailer line, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (use `git commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`).
- Pure modules never import `sdk.mjs` (koffi is blocked on this Windows PC). Tests that load koffi or run ffmpeg run on the private server copy (Appendix A), one suite at a time at the lowest priority. Never touch the test server 192.168.3.147; never load-test production; never print NVR credentials.
- Code style as the repo: ESM `.mjs`, no semicolons, 2-space indent, comments that say why, no new npm dependencies. Words on screen are plain English.
- Known failures, and nothing else may fail: on Windows `rec-fallback.test.mjs` "16x during a leg" (2 checks; test bug fixed on the unmerged branch `rec-fallback-16x-flake`) and `rec-timeline.test.mjs` "load ../playback.mjs" (koffi); `users-api.test.mjs` and `camera-poll.test.mjs` do not run on Windows (they need `build/lib`); on the server copy `sps.test.mjs` and `substreams.test.mjs` (`/work` fixtures absent). `rec-playback.test.mjs` "growing, 16x: keyframes, then speed 1 newest…" is timing-sensitive on Windows (failed once in four runs while this plan was checked, unrelated to rights): rerun once before investigating.
- This plan's code was applied to scratch copies of the tree while it was written and again after the review: Tasks 1a and 1b on their own onto 119c43e (their tests failed as Step 2 says, then passed, with the regressions they name); Task 4 on its own (its pins failed, then passed); and Tasks 1-11 together, where every one of the 137 Windows test files gave the same result as before the review (all pass but the known failures above), and playback.mjs, server.mjs and the client pages parse. The server-copy tests (`playback-hd-switch`, `playback-busy`, `playback-search`, `event-snapshot-ffmpeg`) were only parsed, not run: run them as their tasks say.
- Interface names and signatures every task uses: Appendix B.

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `cctv/rights.mjs` | the model: `live-hd`, the AND rule, `mayHd`, POST guard, diff-first audit (1a); v1->v2 upgrade, shadow written first, backup, newer file left alone (1b); camera-list helpers (7) | 1a, 1b, 7 |
| `cctv/stream-param.mjs` (new) | `streamParam`, the HD refusal reason and messages | 2 |
| `cctv/access-watch.mjs` | any-of needs, `'hd not allowed'` | 2 |
| `cctv/live-wait.mjs` (new) | wait notices for a viewer without a stand-in | 3 |
| `cctv/live-attach.mjs`, `cctv/live-mux.mjs`, `cctv/sub-bridge.mjs` | L1-L4 (small edits) | 3 |
| `cctv/rec-playback.mjs`, `cctv/rec-fallback.mjs` | P2, P3, P5-P8 | 5 |
| `cctv/playback.mjs` | the fixed switch (4); `connect(ws, url, opts)`, the switch asks the viewer's right, twice (5) | 4, 5 |
| `cctv/hd-only.mjs` (new) | `SdWait`, the HD-only store with expiry (4); `noSdAction`, `SD_REFUSE_MS` (5) | 4, 5 |
| `cctv/event-snapshot.mjs` | S1, S2 (the SD copy on its own queue; a picture older than its event refused) | 6 |
| `cctv/server.mjs` | `/live` parse (3), `/playback`: may-see-main from the session, tracking, a sweep on the switch (5), `/api/cameras` (7) | 3, 5, 7 |
| `cctv/public/live-tile.js`, `live-mux.js`, `viewer.js`, `grid-diff.js`, `login.js`, `style.css` | live pages | 8 |
| `cctv/public/pb-sources.js`, `playback.js` | playback page | 9 |
| `cctv/public/pb-sources.js`, `wall.js` | camera wall | 10 |
| `cctv/public/access-model.js`, `audit.js`, `audit.html`, `style.css` | the editor | 1a (GRANTABLE only), 11 |
| `CHANGELOG.md`, `cctv/public/audit.html` help text | docs | 12 |

---

### Task 1a: The rights model — Live HD (only with Live), `mayHd`, the editor keeps Live HD, the outdated-editor 409

Nothing enforces `live-hd` until Task 3, so this task changes no one's pictures; it adds the action, its rules and the editor's guard. The file format (version 2, the shadow) is Task 1b.

**Files:**
- Modify: `cctv/rights.mjs` (header :1-32, `ACTIONS` :44-45, `migrateRights` doc :174 and row :187, `can` :330 and after :352, `canAny` after :372, `sitesFor` :391, after `canPlayNvr` :404-405, `ROUTES` and `handleRights` :420-480)
- Modify: `cctv/public/access-model.js:27-28` and `:299` only (so the three-column editor keeps `live-hd` on save until Task 11)
- Test: `cctv/test/rights.test.mjs`, `cctv/test/access-model.test.mjs` (Windows)
- Regression (Windows): `access-watch`, `rec-playback`, `event-snapshot`, `export-scope`, `export-job`, `audit`, `live-mux-server`; (server copy) `users-api`

**Interfaces:**
- Consumes: nothing new (existing `can`, `covers`, `cleanRights`, `saveRights`, `audit`, `loadUsers`).
- Produces (rights.mjs):
  ```
  export const ACTIONS = Object.freeze(['live', 'live-hd', 'playback-server', 'playback-nvr', 'export', 'admin'])
  export const mayHd = (who, nvrId: string, ch: number) => boolean
  export function intersectTargets(a: string[], b: string[]): string[]
  export function rightsChangeDetail(before: row, after: row): string
  handleRights POST: 409 { error, outdated: true } (no grants['live-hd'] array) | as before
  ```
  `can(who, 'live-hd', t)` is true only where `live` covers the camera too (admins always). `/api/rights/me` is no longer handled (`handleRights` returns `null` for it). `migrateRights` (no rights.json yet) gives a viewer `live-hd: ['*']`.

- [ ] **Step 1: Update and add the tests**

(a) `cctv/test/rights.test.mjs`, after line 45 (`const SAM = …`), add:
```js
const J = JSON.stringify
// a POST body's rights as a current editor sends them: every grantable list present, live-hd included
// (a body without it is an editor page from before Live HD, refused 409 outdated)
const v2 = (rights = {}) => ({ ...rights, grants: { 'live-hd': [], ...(rights.grants ?? {}) } })
const auditRowsAll = () => readFileSync(join(DATA, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
```
(`v2` is the editor's body shape from this release on: every list, `live-hd` included.)

(b) In the first block ("the migration"), after the check `'a viewer keeps NVR playback everywhere, as before'` (line 65), add:
```js
  check('a viewer keeps full screen at full quality everywhere (Live HD *), as before', store.users.jo.grants['live-hd']?.join() === '*')
```

(c) In "the route" block: line 234, replace `b1.actions.length === 5` with `b1.actions.length === 6 && b1.actions[1] === 'live-hd'`. Wrap the `rights:` object of every admin POST in `v2(...)`:
- line 251: `rights: v2({ grants: { live: ['n1'] }, formats: ['pack'] })`
- line 253: `rights: v2()`
- line 277: `rights: v2({ grants: { live: ['n9'] } })`
- line 281: `rights: v2({ grants: { live: ['n9'] } })`
- line 286: `rights: v2()`
- line 289: `rights: v2({ grants: { live: ['n1', 'n9'] }, formats: ['pack'] })`
- line 313: `rights: v2({ admin: true })`
- line 318: `rights: v2({ admin: true, grants: { live: ['nvr1'] } })`
- line 322: `rights: v2({ admin: false })`
- line 328: `rights: v2({ grants: { live: ['nvr2'] } })`
- line 401: `rights: v2({ grants: { live: ['*'] } })`

(Lines 239, 244 and 247 are refused 403 before the body is read: unchanged.)

(d) Replace lines 260-264 (the three `/api/rights/me` checks, from `const [s9, b9] = …` through `check('/api/rights/me with no session: 401', …)`) with:
```js
  check('/api/rights/me is not handled any more (it was never reachable: handleRights runs inside the admin block)', (await R.handleRights('GET', '/api/rights/me', json({}), VIEWER)) === null)
```

(e) Append these blocks just before the final `console.log(failures ? …)`:
```js
// ---- Live HD (stream rights, 2026-09-29) ------------------------------------------------------------------
{
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' }, sam: { hash: 'x', role: 'viewer' } })
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1/0', 'n2'] } })
  check('live-hd: allowed where Live covers the camera too', R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 0 }) === true)
  check('live-hd: refused where Live does not, whatever live-hd says (it counts only with Live)', R.can(VIEWER, 'live-hd', { nvr: 'n2', ch: 0 }) === false)
  check('live-hd: refused on a camera of a Live site it does not list', R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 1 }) === false)
  check('live-hd: an admin always', R.can(ADMIN, 'live-hd', { nvr: 'n9', ch: 9 }) === true)
  R.saveRights('jo', { grants: { 'live-hd': ['*'] } })
  check('canAny(live-hd) with no Live at all: false', R.canAny(VIEWER, 'live-hd') === false)
  check('Live HD alone reveals no site (sitesFor)', R.sitesFor(VIEWER, [{ id: 'n1', site: 'S', name: 'N', status: 'online' }]).length === 0)
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1'] } })
  check('canAny(live-hd) with Live: true', R.canAny(VIEWER, 'live-hd') === true)
}
// mayHd: the one rule for a recorded or still picture from the main stream
{
  R.saveRights('jo', { grants: { 'playback-nvr': ['n1'] } })
  check('mayHd: Playback SD alone may not see main', R.mayHd(VIEWER, 'n1', 0) === false)
  R.saveRights('jo', { grants: { 'playback-nvr': ['n1'], live: ['n1'], 'live-hd': ['n1/0'] } })
  check('mayHd: Live HD on that camera may, not on the next one', R.mayHd(VIEWER, 'n1', 0) === true && R.mayHd(VIEWER, 'n1', 1) === false)
  R.saveRights('jo', { grants: { 'playback-server': ['n1/1'] } })
  check('mayHd: Playback HD on that camera may', R.mayHd(VIEWER, 'n1', 1) === true && R.mayHd(VIEWER, 'n1', 0) === false)
  check('mayHd: no session, a junk channel or no NVR: refused; an admin: allowed', R.mayHd(null, 'n1', 1) === false && R.mayHd(VIEWER, 'n1', -1) === false && R.mayHd(VIEWER, '', 1) === false && R.mayHd(ADMIN, 'n1', 7) === true)
}
// intersectTargets: the cameras two grant lists both cover
{
  const I = R.intersectTargets
  check("intersect: '*' with anything is that thing", J(I(['*'], ['n1', 'n2/3'])) === J(['n1', 'n2/3']) && J(I(['n1/0'], ['*'])) === J(['n1/0']))
  check('intersect: a site with one of its cameras is the camera', J(I(['n1'], ['n1/3'])) === J(['n1/3']) && J(I(['n1/3'], ['n1'])) === J(['n1/3']))
  check('intersect: the same site or camera is itself', J(I(['n1', 'n2/4'], ['n1', 'n2/4'])) === J(['n1', 'n2/4']))
  check('intersect: other sites or cameras give nothing (n1 is not n10)', J(I(['n1', 'n2/1'], ['n3', 'n2/2', 'n10'])) === '[]')
  check('intersect: nothing on either side is nothing', J(I([], ['*'])) === '[]' && J(I(['*'], [])) === '[]' && J(I(undefined, ['*'])) === '[]')
}

// ---- editors from before Live HD, and the diff-first audit detail -----------------------------------------
{
  const lastRightsRow = (user) => auditRowsAll().filter((r) => r.action === 'rights-change' && r.target === user).at(-1)
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' } })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 2, users: {} }))
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1'] } })
  const seen = R.rightsToken(R.rightsOf('jo'))
  const [s, b] = await R.handleRights('POST', '/api/admin/rights', async () => ({ user: 'jo', rights: { grants: { live: ['n1'] } }, seen }), ADMIN)
  check('an editor from before Live HD (no live-hd list): 409 outdated, never stale (no reopen loop)', s === 409 && b.outdated === true && !('stale' in b) && /reload/i.test(b.error), J(b))
  check('... and the stored row keeps its Live HD', J(R.rightsOf('jo').grants['live-hd']) === J(['n1']))
  const [s2] = await R.handleRights('POST', '/api/admin/rights', async () => ({ user: 'jo', rights: v2({ grants: { live: ['n1'] } }), seen }), ADMIN)
  check('with the live-hd list: saved, and the audit row starts with the change', s2 === 200 && /^removed live-hd: n1 \| now: live=n1 live-hd=none /.test(lastRightsRow('jo').detail), lastRightsRow('jo')?.detail)
  check('rightsChangeDetail: nothing changed says so', R.rightsChangeDetail(R.rightsOf('jo'), R.rightsOf('jo')).startsWith('no changes | now: '))
  check('rightsChangeDetail: formats too', /added formats: mp4/.test(R.rightsChangeDetail(R.rightsOf('jo'), { ...R.rightsOf('jo'), formats: ['mp4'] })))
}
```

(f) `cctv/test/access-model.test.mjs`: insert just before its final `console.log(failures ? …)`:
```js
// ---- a stored Live HD list survives a save (stream rights): the editor never drops it ---------------------
check('Live HD kept through the editor: fromRow then toRow gives the same list', J(M.toRow(M.fromRow(row({ live: ['nvr1'], 'live-hd': ['nvr1'] }), tree)).grants['live-hd']) === J(['nvr1']))
```

- [ ] **Step 2: Run them to see them fail**

Run: `node cctv/test/rights.test.mjs`
Expected: `FAIL` on the migration's Live HD check, `GET as admin …` (five actions), `/api/rights/me is not handled any more`, and the `live-hd:` checks that expect `true`; then the run stops with `TypeError: R.mayHd is not a function`.
Run: `node cctv/test/access-model.test.mjs`
Expected: `FAIL  Live HD kept through the editor: fromRow then toRow gives the same list` (and `1 FAILED`).

- [ ] **Step 3: Implement in `cctv/rights.mjs`**

(a) Replace the header, lines 1-32 (from `// Per-user rights:` through the `GET  /api/rights/me` line), with:
```js
// Per-user rights: who may watch live, watch live at full quality, play back from the NVR or from this
// server, export (and in which formats), and administer. Granted per site (a whole NVR) or per camera.
//
// This is the security layer, so it is written to one rule: DEFAULT DENY. can() returns true only
// when a grant explicitly says so. Anything unexpected — a missing file, a corrupt row, an unknown
// action, a user with no row at all, a target that will not parse — is a refusal, never a shrug.
//
// Two things this module deliberately does NOT do:
//   - It never reads a role, a user id or a rights list out of a request body. The caller passes
//     the `who` that server.mjs built from the signed session cookie; everything else is hostile.
//   - It never grants by accident. The only reason can() ever returns true without a stored grant
//     is admin: the account's role in users.json (rightsOf), or `who.admin` from the session (see
//     honourSessionAdmin below), which is how an install with no rights file yet, and CCTV_AUTH=off
//     development, keep working. Admin is stored nowhere else: an admin flag in a row is ignored.
//
// The actions, with the access editor's names: live (Live: the grid, on the camera's sub-stream),
// live-hd (Live HD: full screen at full quality, the main stream; it counts only where live covers
// the camera too), playback-nvr (Playback SD: the NVR's own recordings), playback-server (Playback HD:
// this server's own recordings), export (with its formats). mayHd below is the one rule for a
// recorded or still picture from the main stream: Live HD or Playback HD on the camera.
//
// Storage: data/rights.json, written 0600 by temp-file-and-rename like settings.mjs.
//
//   { version: 1, users: { alice: { admin: false, grants: { live: ['*'], 'live-hd': ['nvr1'],
//     'playback-server': ['nvr1', 'nvr2/3'], 'playback-nvr': [], export: ['nvr1/0'] }, formats: ['pack'] } } }
//
// A target in a grant list is one of:
//   '*'        every camera on every NVR ("site-wide" in the plan's words)
//   'nvr1'     every camera on that one NVR
//   'nvr1/3'   channel 3 of that NVR, and nothing else
//
//   GET  /api/admin/rights            -> { users, actions, formats, admins }; each user's row
//                                         carries `seen`, a token of it right now
//   POST /api/admin/rights            { user, rights, seen } -> { user, rights }
//                                         409 { error, stale: true } when `seen` is missing or does
//                                         not match: a stale editor screen must not silently put back
//                                         access someone else already took away while it sat open;
//                                         409 { error, outdated: true } when rights.grants['live-hd']
//                                         is missing: an editor page from before Live HD would store
//                                         it empty
// The pages learn what they may do per camera from /api/cameras (liveCameras, playbackCameras), not
// from their rights row.
```

(b) Lines 44-45 (the `ACTIONS` doc line and the constant) become:
```js
/** The six things a person can be allowed to do. Anything not in here is refused outright. */
export const ACTIONS = Object.freeze(['live', 'live-hd', 'playback-server', 'playback-nvr', 'export', 'admin'])
```

(c) In `migrateRights`: the doc line 174 (` *   - a viewer gets live and NVR playback everywhere, which is what viewers have always had,`) becomes two lines:
```js
 *   - a viewer gets live, full screen at full quality (live-hd) and NVR playback everywhere,
 *     which is what viewers have always had,
```
and line 187 becomes:
```js
        : { ...emptyRights(), grants: { ...emptyGrants(), live: ['*'], 'live-hd': ['*'], 'playback-nvr': ['*'] } }
```

(d) In `can`: the JSDoc `@param` action union (line 330) becomes `'live'|'live-hd'|'playback-server'|'playback-nvr'|'export'|'admin'`, and after line 352 (`if (!covers(rights.grants[action], nvr, ch)) return false`) add:
```js
  // Live HD is an add-on to Live on the same camera, never a way in by itself: a stray live-hd target
  // (hand-edited, restored from the shadow) grants nothing where Live does not cover the camera too
  if (action === 'live-hd' && !covers(rights.grants.live, nvr, ch)) return false
```

(e) In `canAny`, after `if (list.length === 0) return false` (line 372) add:
```js
  if (action === 'live-hd' && rights.grants.live.length === 0) return false // HD counts only with Live
```

(f) In `sitesFor`, replace line 391 with:
```js
    // Live HD alone shows nothing (it counts only with Live), so it reveals no site either
    .filter((s) => GRANTABLE.some((a) => a !== 'live-hd' && (grants[a] ?? []).some((t) => onNvr(t, s.id))))
```

(g) After `canPlayNvr` (lines 404-405) add:
```js
/**
 * May this person see a recorded or still picture from this camera's main stream: Live HD or Playback
 * HD on it. The one rule for the NVR's main stream in playback (with playback-nvr, rec-playback.mjs)
 * and the full-size event picture (event-snapshot.mjs). Live main asks live-hd alone (live-attach.mjs):
 * Playback HD does not open full screen live.
 */
export const mayHd = (who, nvrId, ch) => {
  const t = { nvr: isString(nvrId) && nvrId ? nvrId : null, ch: Number.isInteger(ch) && ch >= 0 ? ch : null }
  return can(who, 'live-hd', t) || can(who, 'playback-server', t)
}

/** The one target covering exactly the cameras both cover, or null: '*' ∩ x = x, 'n1' ∩ 'n1/3' = 'n1/3'. */
function meet(a, b) {
  if (a === '*') return b
  if (b === '*') return a
  const nvrA = a.includes('/') ? a.slice(0, a.indexOf('/')) : a
  const nvrB = b.includes('/') ? b.slice(0, b.indexOf('/')) : b
  if (nvrA !== nvrB) return null
  if (!a.includes('/')) return b
  if (!b.includes('/')) return a
  return a === b ? a : null
}

/**
 * The cameras two grant lists both cover, as a grant list (sorted, each target once): what an upgrade
 * after a rollback restores of the Live HD the shadow remembers, limited to the Live there is now
 * (upgradeToV2), and what the shadow's first write keeps (writeStore).
 */
export function intersectTargets(a, b) {
  const out = new Set()
  for (const x of a ?? []) for (const y of b ?? []) {
    const m = meet(x, y)
    if (m) out.add(m)
  }
  return [...out].sort()
}
```

(h) Replace lines 420-480 (from `const ROUTES = {` through the closing `}` of `handleRights`; the `useRights(can)` lines after it stay) with:
```js
const ROUTES = { '/api/admin/rights': ['GET', 'POST'] }

/**
 * The detail of a rights-change audit row: what changed first, then the whole row, so the audit's
 * 500-character cut (audit.mjs) takes the summary and never the change. The role note comes first:
 * an unchanged "admin" reads the same for someone always an admin and someone just now demoted
 * (rights.admin is false either way once they are out), so a role change says so explicitly.
 */
export function rightsChangeDetail(before, after) {
  const roleNote = before.admin === after.admin ? (after.admin ? 'admin; ' : '') : after.admin ? 'made admin; ' : 'admin removed; '
  const changes = []
  const diff = (label, was, now) => {
    const added = now.filter((t) => !was.includes(t))
    const removed = was.filter((t) => !now.includes(t))
    if (added.length) changes.push(`added ${label}: ${added.join('|')}`)
    if (removed.length) changes.push(`removed ${label}: ${removed.join('|')}`)
  }
  for (const a of GRANTABLE) diff(a, before.grants?.[a] ?? [], after.grants?.[a] ?? [])
  diff('formats', before.formats ?? [], after.formats ?? [])
  const now = `${GRANTABLE.map((a) => `${a}=${after.grants[a].join('|') || 'none'}`).join(' ')} formats=${after.formats.join('|') || 'none'}`
  return `${roleNote}${changes.length ? changes.join('; ') : 'no changes'} | now: ${now}`
}

/**
 * @param {string} method
 * @param {string} pathname
 * @param {() => Promise<object>} readJson the request's JSON object body
 * @param {{user?:string, admin?:boolean}|null} who the session user, from server.mjs
 * @returns {Promise<[number, any, object?] | null>} null when the path is not one of these routes
 */
export async function handleRights(method, pathname, readJson, who) {
  const methods = ROUTES[pathname]
  if (!methods) return null
  if (!methods.includes(method)) return [405, { error: 'Method not allowed' }, { allow: methods.join(', ') }]

  const name = isString(who) ? who : isString(who?.user) ? who.user : null
  if (!can(who, 'admin')) return [403, { error: 'Only admins can change rights' }]
  if (method === 'GET') return [200, { users: listRights(), actions: ACTIONS, formats: FORMATS, admins: adminList() }]

  try {
    const body = await readJson()
    // The name comes from the body because an admin is editing somebody else. The *authority* to
    // do so came from the session above, which is the part that must never be client-supplied.
    const user = String(body?.user ?? '')
    // An editor page opened before Live HD existed knows four rights: its row would store live-hd
    // empty, taking full screen at full quality from that person everywhere, and its "Reopen" after
    // the stale refusal below would do exactly that. So a body without the live-hd list is refused
    // first, without the `stale` flag: that page is told to reload, not offered a reopen.
    if (!Array.isArray(body?.rights?.grants?.['live-hd'])) {
      return [409, { error: 'This page is from an older version of Argus: reload it (the access was not saved)', outdated: true }]
    }
    // Compare-and-swap (STALE EDITOR): the access editor's GET handed out this row's `seen` token.
    // If it does not match the row as it is right now, somebody else changed this person's access
    // while the editor sat open, and saving the whole row it opened with would silently put that
    // change back. A missing token fails the same `!==` compare. Only checked for an account that
    // exists: for one that does not, saveRights below gives the clearer "no account" 400.
    const before = rightsOf(user)
    if (Object.hasOwn(loadUsers(), user) && body?.seen !== rightsToken(before)) {
      return [409, { error: 'Someone changed this person\'s access since you opened it; reopen to see it', stale: true }]
    }
    const rights = saveRights(user, body?.rights)
    // "Who gave them permission" is the first question after "who did it", so a rights change is
    // itself an audited event: the stored row (not what was posted), the change first.
    audit(DATA_DIR, { user: name ?? 'dev', action: 'rights-change', target: user, detail: rightsChangeDetail(before, rights) })
    return [200, { user, rights }]
  } catch (e) {
    // Everything that can go wrong here is the caller's fault (unknown account, bad name, bad
    // JSON, the last-admin rule), so 400 with the reason. Nothing else is leaked.
    return [400, { error: e?.message ?? 'bad request' }]
  }
}
```

- [ ] **Step 4: Keep the three-column editor from dropping Live HD (`cctv/public/access-model.js`)**

Lines 27-28 (`GRANTABLE`'s doc line and the constant) become:
```js
/** The per-camera rights rights.mjs knows ('admin' is the account's role, not a grant). Live HD has no
 * column of its own until the five-column editor; its list is kept as stored, so a save never takes it. */
export const GRANTABLE = Object.freeze(['live', 'live-hd', 'playback-server', 'playback-nvr', 'export'])
```
Line 299:
```js
const KEPT_LABELS = { live: 'Live', 'live-hd': 'Live HD', 'playback-server': 'Playback (server)', 'playback-nvr': 'Playback (NVR)', export: 'Export' }
```

- [ ] **Step 5: Run the tests**

Run: `node cctv/test/rights.test.mjs` and `node cctv/test/access-model.test.mjs`
Expected: every line `PASS`, last line `all passed`.
Then run, one after another: `node cctv/test/access-watch.test.mjs`, `node cctv/test/rec-playback.test.mjs`, `node cctv/test/event-snapshot.test.mjs`, `node cctv/test/export-scope.test.mjs`, `node cctv/test/export-job.test.mjs`, `node cctv/test/audit.test.mjs`, `node cctv/test/live-mux-server.test.mjs`.
Expected: each ends `all passed` (export-job: `All passed`; rec-playback prints one `SKIP`).
On the server copy (Appendix A, steps b and c): `bash /tmp/stream-rights-test/run-tests.sh cctv/test/users-api.test.mjs` — expected `rc=0 fails=0`.

- [ ] **Step 6: Commit**

```bash
git add cctv/rights.mjs cctv/public/access-model.js cctv/test/rights.test.mjs cctv/test/access-model.test.mjs
git commit -m "Rights: Live HD (counts only with Live), mayHd, the editor keeps Live HD, an editor from before it is refused 409 outdated, diff-first audit detail" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---


### Task 1b: rights.json version 2 — the upgrade (Live HD = Live), the shadow written first, the backup, a newer file left as it is

Line numbers below are at 119c43e; Task 1a changed `rights.mjs` and `rights.test.mjs` above them, so find each place by the text quoted.

**Files:**
- Modify: `cctv/rights.mjs` (the header's storage lines, imports :35, `RIGHTS_FILE`/`VERSION` :41-42, `readRights` :115-131, `writeStore` :207-220, `saveRights` :239-253, `forgetRights` :262-271, `handleRights` POST)
- Test: `cctv/test/rights.test.mjs` (Windows)
- Regression: as Task 1a

**Interfaces:**
- Consumes: `intersectTargets`, the `v2` and `auditRowsAll` test helpers (Task 1a).
- Produces (rights.mjs):
  ```
  export const RIGHTS_V1_BACKUP: string            // DATA_DIR/rights.v1.json
  export const RIGHTS_SHADOW: string               // DATA_DIR/rights.v2.json
  loadRights() -> { version: 2, users, newer?: number }   // newer: the on-disk version when > 2
  writeStore(store, before?)   // the shadow first (cut to old ∩ new), rights.json, the shadow again; throws on a store with `newer`
  saveRights on a newer file: throws (status 409); forgetRights on a newer file: takes out that row only
  handleRights POST: 409 { error, newer: true } while rights.json is from a newer release
  ```

- [ ] **Step 1: Add the tests (`cctv/test/rights.test.mjs`)**

(a) Line 7, the fs import, gains `mkdirSync` and `rmSync`:
```js
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
```

(b) In "the migration" block, after Task 1a's check `'a viewer keeps full screen at full quality everywhere (Live HD *), as before'`, add:
```js
  check('rights.json is written as version 2', JSON.parse(readFileSync(R.RIGHTS_FILE, 'utf8')).version === 2)
  check('...with its shadow: every account\'s Live HD', JSON.parse(readFileSync(R.RIGHTS_SHADOW, 'utf8')).users.jo.join() === '*')
```

(c) Append these blocks just before the final `console.log(failures ? …)` (after Task 1a's blocks):
```js
// ---- rights.json version 1 -> 2 -----------------------------------------------------------------------
{
  const disk = () => JSON.parse(readFileSync(R.RIGHTS_FILE, 'utf8'))
  const systemRows = () => auditRowsAll().filter((r) => r.user === 'system' && r.action === 'rights-change')
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' }, sam: { hash: 'x', role: 'viewer' } })
  rmSync(R.RIGHTS_SHADOW, { force: true })
  const v1 = JSON.stringify({ version: 1, users: { jo: { grants: { live: ['n1', 'n2/3'], 'playback-nvr': ['*'] } }, sam: { grants: { 'playback-server': ['n1'] } } } })
  writeFileSync(R.RIGHTS_FILE, v1)
  const before = systemRows().length
  check('upgrade: Live HD wherever Live is', R.can(VIEWER, 'live-hd', { nvr: 'n2', ch: 3 }) === true && J(R.rightsOf('jo').grants['live-hd']) === J(['n1', 'n2/3']))
  check('upgrade: nothing else changes (playback, export, formats)', J(R.rightsOf('jo').grants['playback-nvr']) === J(['*']) && J(R.rightsOf('sam').grants['playback-server']) === J(['n1']) && R.rightsOf('sam').grants['live-hd'].length === 0)
  check('upgrade: written back as version 2', disk().version === 2 && J(disk().users.jo.grants['live-hd']) === J(['n1', 'n2/3']))
  check('upgrade: the file it replaced is kept byte for byte as rights.v1.json', readFileSync(R.RIGHTS_V1_BACKUP, 'utf8') === v1)
  check('upgrade: one system audit row saying what it did', systemRows().length === before + 1 && /upgraded from version 1 to 2/.test(systemRows().at(-1).detail) && /jo/.test(systemRows().at(-1).detail), systemRows().at(-1)?.detail)
  check('upgrade: ... it names who has Playback SD beyond Live (there the NVR\'s HD now needs Live HD or Playback HD), and only them', /; 1 account\(s\) \(jo\) have Playback SD on cameras without Live/.test(systemRows().at(-1).detail) && /the stored playback, export and admin rights are unchanged/.test(systemRows().at(-1).detail), systemRows().at(-1)?.detail)
  check('upgrade: the shadow now holds every account\'s Live HD', J(JSON.parse(readFileSync(R.RIGHTS_SHADOW, 'utf8')).users.jo) === J(['n1', 'n2/3']))
  R.loadRights()
  R.loadRights()
  check('upgrade: a version 2 file is never upgraded again', systemRows().length === before + 1)

  rmSync(R.RIGHTS_SHADOW, { force: true })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ users: { jo: { grants: { live: ['n4'] } } } }))
  check('a file with no version is upgraded as version 1', J(R.rightsOf('jo').grants['live-hd']) === J(['n4']) && disk().version === 2)

  writeFileSync(R.RIGHTS_FILE, '{ not json')
  R.loadRights()
  check('an unreadable file is left as it is (never written over)', readFileSync(R.RIGHTS_FILE, 'utf8') === '{ not json')
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 1, users: ['jo'] }))
  R.loadRights()
  check('a file whose users is not an object is left as it is', disk().version === 1 && Array.isArray(disk().users))

  const v3 = JSON.stringify({ version: 3, users: { jo: { grants: { live: ['n1'], 'live-hd': ['n1'], 'live-4k': ['n1'] } }, sam: { grants: { 'live-4k': ['n2'] } } } })
  writeFileSync(R.RIGHTS_FILE, v3)
  check('version 3: read as far as version 2 understands it', R.can(VIEWER, 'live-hd', { nvr: 'n1', ch: 0 }) === true && !('live-4k' in R.rightsOf('jo').grants))
  check('version 3: not written, not upgraded', readFileSync(R.RIGHTS_FILE, 'utf8') === v3)
  check('version 3: reported once (one system audit row)', systemRows().filter((r) => /version 3, newer/.test(r.detail)).length === 1)
  const [s3, b3] = await R.handleRights('POST', '/api/admin/rights', async () => ({ user: 'jo', rights: v2({ grants: { live: ['n2'] } }), seen: R.rightsToken(R.rightsOf('jo')) }), ADMIN)
  check('version 3: an editor save is refused 409 newer, nothing written', s3 === 409 && b3.newer === true && !b3.stale && readFileSync(R.RIGHTS_FILE, 'utf8') === v3, J(b3))
  check('version 3: saveRights refuses as well (never rewritten as version 2)', threw(() => R.saveRights('jo', { grants: { live: ['n2'] } }))?.status === 409 && readFileSync(R.RIGHTS_FILE, 'utf8') === v3)
  const rows3 = systemRows().length
  check('version 3: an account removed (or made again) takes out its own row only; the version and what this release does not know stay', R.forgetRights('sam') === true && disk().version === 3 && !('sam' in disk().users) && J(disk().users.jo.grants['live-4k']) === J(['n1']), J(disk()))
  check('... and says so in the audit', systemRows().length === rows3 + 1 && /version 3, from a newer release\): the row of sam removed/.test(systemRows().at(-1).detail), systemRows().at(-1)?.detail)
}

// ---- a rollback and back: the shadow keeps the Live HD taken away before it -------------------------------
{
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' }, sam: { hash: 'x', role: 'viewer' } })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 2, users: {} }))
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1/0'] } }) // HD on one camera only
  // an older release rewrites the file: version 1, live-hd dropped; it also gave jo Live on n2, and sam Live
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 1, users: { jo: { grants: { live: ['n1', 'n2'] } }, sam: { grants: { live: ['n5'] } } } }))
  check('back again: an account the shadow remembers keeps the Live HD it had, not all of its Live', J(R.rightsOf('jo').grants['live-hd']) === J(['n1/0']))
  check('... a camera given Live meanwhile gets no HD (default deny)', R.can(VIEWER, 'live-hd', { nvr: 'n2', ch: 0 }) === false && R.can(VIEWER, 'live', { nvr: 'n2', ch: 0 }) === true)
  check('... an account the shadow does not know gets Live HD = Live, as a first upgrade', J(R.rightsOf('sam').grants['live-hd']) === J(['n5']))
  check('... the audit row says which were restored', /restored from rights\.v2\.json/.test(auditRowsAll().filter((r) => r.user === 'system').at(-1).detail))
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1'] } })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 1, users: { jo: { grants: { live: ['n1/2'] } } } }))
  check('back again: the remembered HD is cut to the Live there is now (shadow ∩ live)', J(R.rightsOf('jo').grants['live-hd']) === J(['n1/2']))
  // a name removed and made again while the older release ran is a new person
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': [] } })
  const sh = JSON.parse(readFileSync(R.RIGHTS_SHADOW, 'utf8'))
  writeFileSync(R.RIGHTS_SHADOW, JSON.stringify({ ...sh, writtenAt: Date.now() - 60_000 }))
  auth.saveUsers({ ...auth.loadUsers(), jo: { hash: 'y', role: 'viewer', since: Date.now() } })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 1, users: { jo: { grants: { live: ['n1'] } } } }))
  check('an account made after the shadow was written is not given the old holder\'s Live HD', J(R.rightsOf('jo').grants['live-hd']) === J(['n1']))
}

// ---- the shadow never holds Live HD that rights.json has not got (written first, cut to old and new) --------
{
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' } })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 2, users: {} }))
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1/0'] } })
  const shadowHd = () => JSON.parse(readFileSync(R.RIGHTS_SHADOW, 'utf8')).users.jo
  const was = readFileSync(R.RIGHTS_FILE, 'utf8')
  // rights.json cannot be written (a folder where its temp file goes): the save fails after the shadow's first write
  const blocker = `${R.RIGHTS_FILE}.tmp-${process.pid}`
  mkdirSync(blocker)
  const e1 = threw(() => R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1'] } }))
  check('a grant that could not be saved: refused, rights.json as it was', e1 !== null && readFileSync(R.RIGHTS_FILE, 'utf8') === was, e1?.message)
  check('... and the shadow holds only the Live HD the old and the new row both have, never the grant', J(shadowHd()) === J(['n1/0']), J(shadowHd()))
  rmSync(blocker, { recursive: true, force: true })
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1'] } })
  check('saved: the shadow holds the new Live HD', J(shadowHd()) === J(['n1']))
  // the shadow cannot be written (a folder in its place): refused before rights.json is touched
  const now = readFileSync(R.RIGHTS_FILE, 'utf8')
  rmSync(R.RIGHTS_SHADOW, { force: true })
  mkdirSync(R.RIGHTS_SHADOW)
  const e2 = threw(() => R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': [] } }))
  check('a shadow that cannot be written: the save is refused, rights.json as it was', e2 !== null && /rights\.v2\.json/.test(e2.message) && readFileSync(R.RIGHTS_FILE, 'utf8') === now, e2?.message)
  const [s4, b4] = await R.handleRights('POST', '/api/admin/rights', async () => ({ user: 'jo', rights: v2({ grants: { live: ['n1'] } }), seen: R.rightsToken(R.rightsOf('jo')) }), ADMIN)
  check('... through the editor: an error, and nothing saved', s4 === 400 && /rights\.v2\.json/.test(b4.error) && J(R.rightsOf('jo').grants['live-hd']) === J(['n1']), J(b4))
  rmSync(R.RIGHTS_SHADOW, { recursive: true, force: true })
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `node cctv/test/rights.test.mjs`
Expected: `FAIL  rights.json is written as version 2`, then the run stops with `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string … Received undefined` (`R.RIGHTS_SHADOW` does not exist yet).

- [ ] **Step 3: Implement in `cctv/rights.mjs`**

(a) In the header (Task 1a's), replace the two storage-example lines (`//   { version: 1, users: { alice: …` and the line under it) and the blank `//` line after them with:
```js
//   { version: 2, users: { alice: { admin: false, grants: { live: ['*'], 'live-hd': ['nvr1'],
//     'playback-server': ['nvr1', 'nvr2/3'], 'playback-nvr': [], export: ['nvr1/0'] }, formats: ['pack'] } } }
//
// A version 1 file (before Live HD) is upgraded when first read: Live HD wherever Live is, except for
// an account the shadow data/rights.v2.json remembers (upgradeToV2). The file replaced is kept as
// data/rights.v1.json. A file from a newer release is read as far as this one understands it and
// never rewritten: the access editor's saves are refused, and an account removed or made again takes
// out only its own row (forgetInNewer).
//
```
and the header's line `//                                         it empty` (the end of the `outdated` note) becomes two lines:
```js
//                                         it empty; 409 { error, newer: true } when rights.json is
//                                         from a newer release
```

(b) Line 35, the fs import, gains `rmSync`:
```js
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
```

(c) Lines 41-42 (`export const RIGHTS_FILE = …` and `const VERSION = 1`) become:
```js
export const RIGHTS_FILE = join(DATA_DIR, 'rights.json')
/** The version 1 file an upgrade replaced, byte for byte: a manual rollback is a copy back. */
export const RIGHTS_V1_BACKUP = join(DATA_DIR, 'rights.v1.json')
/** Every account's Live HD as this version last wrote it: what an upgrade after a rollback restores. */
export const RIGHTS_SHADOW = join(DATA_DIR, 'rights.v2.json')
const VERSION = 2
```

(d) Replace `readRights` (lines 115-131, from `function readRights() {` to its closing `}`) with the reader, the newer-file note, the shadow and the upgrade:
```js
function readRights() {
  if (!existsSync(RIGHTS_FILE)) return migrateRights()
  let text
  let raw
  try {
    text = readFileSync(RIGHTS_FILE, 'utf8')
    raw = JSON.parse(text)
  } catch (e) {
    console.error(`[rights] ${RIGHTS_FILE} is unreadable (${e.message}); nobody has stored rights until it is fixed`)
    return { version: VERSION, users: Object.create(null) }
  }
  // A null prototype, deliberately: with an ordinary object, looking up the user name
  // "constructor" or "toString" would find something on Object.prototype and hand can() a
  // "rights row" that is really a function. Default deny has to mean deny for every name.
  const users = Object.create(null)
  const plain = raw?.users !== null && typeof raw?.users === 'object' && !Array.isArray(raw.users)
  const src = plain ? raw.users : {}
  for (const [name, row] of Object.entries(src)) if (isString(name) && name && name !== '__proto__') users[name] = cleanRights(row)
  // a missing or odd version is 1: the files before Live HD, tests and hand edits leave it out
  const from = Number.isInteger(raw?.version) && raw.version >= 1 ? raw.version : 1
  if (from > VERSION) {
    noteNewer(from)
    return { version: VERSION, users, newer: from }
  }
  // Never a file whose users is not an object: that stays on disk for a human to fix, and denies.
  if (from < VERSION && plain) return upgradeToV2(users, text, from)
  return { version: VERSION, users }
}

let newerNoted = 0 // the newer on-disk version this process has already reported
function noteNewer(from) {
  if (newerNoted === from) return
  newerNoted = from
  const detail = `rights.json is version ${from}, newer than this release (${VERSION}): read as far as version ${VERSION} understands it; editor saves refused, and an account removed or made again takes out only its own row`
  console.warn(`[rights] ${detail}`)
  audit(DATA_DIR, { user: 'system', action: 'rights-change', target: '*', detail })
}

/** The shadow as { writtenAt, users: { name: [targets] } }, or null (none, or unreadable: logged). */
function readShadow() {
  if (!existsSync(RIGHTS_SHADOW)) return null
  try {
    const raw = JSON.parse(readFileSync(RIGHTS_SHADOW, 'utf8'))
    if (!Number.isFinite(raw?.writtenAt) || !raw.users || typeof raw.users !== 'object' || Array.isArray(raw.users)) throw new Error('not a rights shadow')
    const users = Object.create(null)
    for (const [name, list] of Object.entries(raw.users)) {
      if (!isString(name) || !name || name === '__proto__' || !Array.isArray(list)) continue
      users[name] = [...new Set(list.map(cleanTarget).filter(Boolean))].sort()
    }
    return { writtenAt: raw.writtenAt, users }
  } catch (e) {
    console.error(`[rights] ${RIGHTS_SHADOW} is unreadable (${e.message}); upgrading as if there were none`)
    return null
  }
}

/**
 * Every account's Live HD, beside rights.json: an older release never touches this file. With
 * `before` (the rows as they were), each account's list is cut to what the old row had too
 * (writeStore's first write: the shadow never holds Live HD that rights.json has not got yet).
 * @throws {Error} when it cannot be written
 */
function writeShadow(users, before = null) {
  const hd = (name) => (before ? intersectTargets(before[name]?.grants?.['live-hd'], users[name].grants['live-hd']) : users[name].grants['live-hd'])
  const shadow = { version: VERSION, writtenAt: Date.now(), users: Object.fromEntries(Object.keys(users).sort().map((n) => [n, hd(n)])) }
  const tmp = `${RIGHTS_SHADOW}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, `${JSON.stringify(shadow, null, 1)}\n`, { mode: 0o600 })
    renameSync(tmp, RIGHTS_SHADOW)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {}
    throw new Error(`could not write rights.v2.json (${e.code ?? e.message})`)
  }
}

/** Whether a grant list covers every camera of target t: '*' covers all, a site all of its cameras. */
const coversAll = (list, t) => list.includes('*') || list.includes(t) || (t.includes('/') && list.includes(t.slice(0, t.indexOf('/'))))

/** "a, b, c", or the first eight "and 3 more": names in an audit row, which is cut at 500 characters. */
const someNames = (list) => (list.length > 8 ? `${list.slice(0, 8).join(', ')} and ${list.length - 8} more` : list.join(', '))

/**
 * A version 1 file (before Live HD) as version 2: Live HD wherever Live is, which is what everyone
 * with Live has always had (full screen went to the main stream for anyone who could open the grid).
 * An account the shadow remembers gets the Live HD it had when this version last wrote the file,
 * limited to its Live as it is now: without that, an older release writing the file (an editor save,
 * an account added or removed) and this one coming back would give Live HD back to everyone it had
 * been taken from. An account made after the shadow was written (users.json `since`) is a new person
 * and gets Live HD = Live, as in any first upgrade. Written back once, with the file it replaced kept
 * as rights.v1.json and one audit row; if that cannot be written, the upgraded rights are used from
 * memory and the upgrade is tried again on the next read.
 *
 * Not quite nothing changes: an account whose Playback SD reaches cameras its Live does not (live
 * n1/0, playback-nvr n1) played the NVR's HD stream and saw full-size event pictures there, which now
 * need Live HD or Playback HD (mayHd). They are not given (default deny); the audit row names them.
 */
function upgradeToV2(users, text, from) {
  const shadow = readShadow()
  const accounts = loadUsers()
  const restored = []
  const copied = []
  const sdOnly = []
  for (const name of Object.keys(users).sort()) {
    const row = users[name]
    const since = Object.hasOwn(accounts, name) ? accounts[name]?.since : undefined
    const remembered = shadow !== null && Object.hasOwn(shadow.users, name) && !(Number.isFinite(since) && since > shadow.writtenAt)
    row.grants['live-hd'] = remembered ? intersectTargets(shadow.users[name], row.grants.live) : [...row.grants.live]
    ;(remembered ? restored : copied).push(name)
    const hd = [...row.grants['live-hd'], ...row.grants['playback-server']]
    if (Object.hasOwn(accounts, name) && accounts[name]?.role !== 'admin' && row.grants['playback-nvr'].some((t) => !coversAll(hd, t))) sdOnly.push(name)
  }
  const store = { version: VERSION, users }
  try {
    const tmp = `${RIGHTS_V1_BACKUP}.tmp-${process.pid}`
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, RIGHTS_V1_BACKUP)
    writeStore(store)
  } catch (e) {
    console.error(`[rights] could not write the upgraded ${RIGHTS_FILE} (${e.message}); using it upgraded from memory`)
    return store
  }
  const said = []
  if (copied.length) said.push(`Live HD given wherever Live was granted for ${copied.length} account(s) (${someNames(copied)})`)
  if (restored.length) said.push(`Live HD restored from rights.v2.json (written ${new Date(shadow.writtenAt).toISOString()}) for ${restored.length} account(s) (${someNames(restored)})`)
  if (!said.length) said.push('no account had rights stored')
  if (sdOnly.length) said.push(`${sdOnly.length} account(s) (${someNames(sdOnly)}) have Playback SD on cameras without Live: there the NVR's recordings and event pictures are now SD only (HD needs Live HD or Playback HD)`)
  const detail = `rights.json upgraded from version ${from} to ${VERSION}: ${said.join('; ')}; the stored playback, export and admin rights are unchanged; the old file is kept as rights.v1.json`
  console.log(`[rights] ${detail}`)
  audit(DATA_DIR, { user: 'system', action: 'rights-change', target: '*', detail })
  return store
}
```

(e) Replace `writeStore` (lines 207-220, from `function writeStore(store) {` to its closing `}`) with:
```js
const saved = () => {
  for (const fn of savedHooks) {
    try {
      fn()
    } catch (e) {
      console.error(`[rights] a listener for saved rights failed: ${e.message}`)
    }
  }
}

/**
 * Writes rights.json and the shadow beside it (every account's Live HD: what an upgrade after a
 * rollback restores, upgradeToV2). The shadow must never hold Live HD that rights.json has not got,
 * or a save that failed half way, then a rollback and a return, would give back HD that was taken
 * away or never given. So, given the rows as they were (`before`): first the shadow with each
 * account's Live HD cut to what the old row had too, then rights.json, then the shadow as the new
 * rows. A shadow that cannot be written refuses the save before rights.json is touched; the last
 * write failing leaves the cut shadow, which errs on the side of less. Without `before` (a first
 * file, or the upgrade itself, which a crash repeats with the same result) the shadow is the new rows.
 * @param {{ version: number, users: object, newer?: number }} store
 * @param {object|null} [before] the rows before this change
 * @throws {Error} a store read from a newer release's file (it would lose what this one does not know)
 */
function writeStore(store, before = null) {
  if (store.newer) throw new Error(`rights.json is version ${store.newer}, from a newer release: this one does not rewrite it`)
  mkdirSync(dirname(RIGHTS_FILE), { recursive: true })
  writeShadow(store.users, before)
  const tmp = `${RIGHTS_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify({ version: VERSION, users: store.users }, null, 1)}\n`, { mode: 0o600 })
  renameSync(tmp, RIGHTS_FILE)
  rightsCache.forget()
  if (before) {
    try {
      writeShadow(store.users)
    } catch (e) {
      console.error(`[rights] ${e.message}; it keeps the Live HD the old and the new rows both have`)
    }
  }
  saved()
}

/**
 * forgetRights on a rights.json from a newer release: only that account's row is taken out, and the
 * file is written back as it was otherwise (its version, and every right this release does not know).
 * Rewriting it as version 2 would drop those; leaving the row would hand it to the next account of
 * that name. Audited, since the newer release will read a file this one changed.
 */
function forgetInNewer(name) {
  const raw = JSON.parse(readFileSync(RIGHTS_FILE, 'utf8'))
  if (!raw?.users || typeof raw.users !== 'object' || Array.isArray(raw.users) || !Object.hasOwn(raw.users, name)) return false
  delete raw.users[name]
  const tmp = `${RIGHTS_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(raw, null, 1)}\n`, { mode: 0o600 })
  renameSync(tmp, RIGHTS_FILE)
  rightsCache.forget()
  audit(DATA_DIR, { user: 'system', action: 'rights-change', target: name, detail: `rights.json (version ${raw.version}, from a newer release): the row of ${name} removed with the account; the rest kept as it was` })
  saved()
  return true
}
```

(f) In `saveRights`: after `const store = loadRights()` add
```js
  if (store.newer) throw bad(409, `rights.json was written by a newer version of Argus (version ${store.newer}); this version will not change it`)
```
and replace its last two store lines (`store.users = Object.assign(rowsOfAccounts(…), { [name]: row })` and `writeStore(store)`) with:
```js
  const before = store.users
  store.users = Object.assign(rowsOfAccounts(store.users, accounts), { [name]: row })
  writeStore(store, before)
```

(g) In `forgetRights`: after `if (!Object.hasOwn(store.users, name)) return false` add
```js
  if (store.newer) return forgetInNewer(name)
  const before = store.users
```
and its `writeStore(store)` becomes `writeStore(store, before)`.

(h) In `handleRights` (Task 1a's), between the `outdated` refusal and the `// Compare-and-swap (STALE EDITOR)` comment, add:
```js
    // rights.json from a newer release: saving here would drop every right this version does not know
    const newer = loadRights().newer
    if (newer) return [409, { error: `rights.json was written by a newer version of Argus (version ${newer}); this version will not change it`, newer: true }]
```

- [ ] **Step 4: Run the tests**

Run: `node cctv/test/rights.test.mjs` — expected `all passed` (the upgrade's console lines, one "unreadable" line for the junk file and one "newer than this release" warning are expected output).
Then the regressions of Task 1a Step 5, Windows and server copy — expected as there.

- [ ] **Step 5: Commit**

```bash
git add cctv/rights.mjs cctv/test/rights.test.mjs
git commit -m "Rights v2: rights.json upgraded once (Live HD = Live, or as the shadow remembers it), the shadow written before rights.json, a backup, a newer file never rewritten" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---


### Task 2: The shared stream vocabulary (`stream-param.mjs`) and the access watch's any-of needs and reasons

**Files:**
- Create: `cctv/stream-param.mjs`
- Create: `cctv/test/stream-param.test.mjs` (Windows)
- Modify: `cctv/access-watch.mjs:1-16` (header), `:35-68` (`sweep`), `:86-100` (`track`)
- Test: `cctv/test/access-watch.test.mjs` (Windows; a new section (g))

**Interfaces:**
- Consumes: nothing from Tasks 1a and 1b.
- Produces:
  ```
  // cctv/stream-param.mjs
  export const MAIN = 0
  export const SUB = 1
  export const HD_NOT_ALLOWED = 'hd not allowed'
  export const HD_ASK_MESSAGE = 'Playing this camera in HD from the NVR needs Playback HD or Live HD.'
  export const HD_ONLY_MESSAGE = 'No SD recording of this camera came from the NVR (it may keep this camera only in HD). Playing it in HD needs Playback HD or Live HD.'
  export function streamParam(raw: string|null|undefined): 0 | 1 | NaN
  // cctv/access-watch.mjs
  track(ws, req, { actions: Array<string | string[]>, nvr, ch })   // an array entry = any one of these
  // sweep closes 1008 'signed out' | 'hd not allowed' (only HD needs failed) | 'not allowed'
  ```

- [ ] **Step 1: Write the failing test `cctv/test/stream-param.test.mjs`**

```js
// The stream a /live or /playback URL asks for (stream-param.mjs): parsed once, strictly, because
// Number() read '', ' ', '0.0', '0x0', '-0' and more as 0, the main stream. Pure: runs anywhere.
//   node cctv/test/stream-param.test.mjs
import { HD_ASK_MESSAGE, HD_NOT_ALLOWED, HD_ONLY_MESSAGE, MAIN, SUB, streamParam } from '../stream-param.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
// what the servers read: URLSearchParams.get, as server.mjs and rec-playback.mjs do
const q = (s) => new URL(`ws://x/live?nvr=n&ch=1${s}`).searchParams.get('stream')

check('absent: the sub-stream (as always)', streamParam(q('')) === SUB && streamParam(null) === SUB && streamParam(undefined) === SUB)
check('exactly 0 and exactly 1', streamParam(q('&stream=0')) === MAIN && streamParam(q('&stream=1')) === SUB && MAIN === 0 && SUB === 1)
const MAIN_TO_NUMBER = ['&stream=', '&stream=%20', '&stream=0.0', '&stream=0x0', '&stream=0b0', '&stream=0o0', '&stream=0e5', '&stream=-0', '&stream=%2B0', '&stream=%0A0', '&stream=%200', '&stream=00']
check('each of these was the main stream to Number() (the loophole)', MAIN_TO_NUMBER.every((s) => Number(q(s)) === 0), MAIN_TO_NUMBER.filter((s) => Number(q(s)) !== 0).join(' '))
const loose = [...MAIN_TO_NUMBER, '&stream=01', '&stream=2', '&stream=main', '&stream=1.0'].filter((s) => !Number.isNaN(streamParam(q(s))))
check('... and each is no stream at all now (NaN, which every caller refuses)', loose.length === 0, loose.join(' '))
check('repeated: the first one counts (URLSearchParams.get)', streamParam(q('&stream=1&stream=0')) === SUB && streamParam(q('&stream=0&stream=1')) === MAIN)
check('NaN never passes a [0, 1] check', ![0, 1].includes(streamParam('x')))
check('the refusal reason and the two messages', HD_NOT_ALLOWED === 'hd not allowed' && /Playback HD or Live HD/.test(HD_ASK_MESSAGE) && /No SD recording/.test(HD_ONLY_MESSAGE) && /only in HD/.test(HD_ONLY_MESSAGE))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Add section (g) to `cctv/test/access-watch.test.mjs`**

Insert just before `// ---- server.mjs wiring (source shape: importing server.mjs starts the NVRs)`:
```js
// ---- (g) needs any one of which will do, and why a socket is closed (stream rights) -----------------
{
  let allowed = {}
  const g = accessWatch({ currentUser: (r) => r.user, isAdmin: () => false, can: (who, a) => allowed[a] === true, every: () => null })
  const ann = { user: 'ann' }
  const nvrMain = new FakeWs()
  g.track(nvrMain, ann, { actions: ['playback-nvr', ['live-hd', 'playback-server']], nvr: 'n', ch: 1 })
  const liveMain = new FakeWs()
  g.track(liveMain, ann, { actions: ['live', 'live-hd'], nvr: 'n', ch: 1 })
  const sub = new FakeWs()
  g.track(sub, ann, { actions: ['live'], nvr: 'n', ch: 1 })
  allowed = { live: true, 'playback-nvr': true, 'playback-server': true }
  g.sweep()
  check('(g) an any-of group is met by one of its actions (Playback HD for the NVR\'s main stream)', nvrMain.closedWith === null)
  check('(g) Live HD gone, Live kept: the live main socket closes 1008 "hd not allowed"', liveMain.closedWith?.code === 1008 && liveMain.closedWith.reason === 'hd not allowed', J(liveMain.closedWith))
  check('(g) ... the sub-stream socket stays', sub.closedWith === null)
  allowed = { live: true, 'playback-nvr': true }
  g.sweep()
  check('(g) neither action of the group: the NVR main socket closes "hd not allowed"', nvrMain.closedWith?.reason === 'hd not allowed', J(nvrMain.closedWith))
  const both = new FakeWs()
  g.track(both, ann, { actions: ['playback-nvr', ['live-hd', 'playback-server']], nvr: 'n', ch: 1 })
  allowed = {}
  g.sweep()
  check('(g) a plain need gone as well: "not allowed", not "hd not allowed"', both.closedWith?.reason === 'not allowed' && sub.closedWith?.reason === 'not allowed', J([both.closedWith, sub.closedWith]))
  const gone = new FakeWs()
  g.track(gone, { user: null }, { actions: ['live', 'live-hd'], nvr: 'n', ch: 1 })
  g.sweep()
  check('(g) no session: "signed out", whatever the needs', gone.closedWith?.reason === 'signed out')
  const group = ['live-hd', 'playback-server']
  const kept = new FakeWs()
  g.track(kept, ann, { actions: ['playback-nvr', group], nvr: 'n', ch: 1 })
  group.pop() // the caller changing its array afterwards
  allowed = { 'playback-nvr': true, 'playback-server': true }
  g.sweep()
  check('(g) track keeps its own copy of a group', kept.closedWith === null)
  await tick()
}
```

- [ ] **Step 3: Run both to see them fail**

Run: `node cctv/test/stream-param.test.mjs`
Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/cctv/stream-param.mjs'`.
Run: `node cctv/test/access-watch.test.mjs`
Expected: `FAIL  (g) an any-of group is met …` and the reason checks FAIL (`'not allowed'` is said for everything).

- [ ] **Step 4: Create `cctv/stream-param.mjs`**

```js
// The stream a /live or /playback URL asks for, parsed once for every decision made on it, and how a
// refusal of the main stream is said on every socket.
//
// Number(url.searchParams.get('stream') ?? 1) read '', ' ', '0.0', '0x0', '0b0', '0o0', '0e5', '-0',
// '+0', '\n0' and '00' all as 0: the main stream. A rights check written against the text
// ('=== "0"') could be walked round with any of them while the number still asked for main. So:
// absent is the sub-stream, exactly '0' or '1' is that stream, and anything else is no stream at all
// (NaN), which every caller refuses. (Of repeated parameters, searchParams.get takes the first.)
//
// A main stream refused for want of Live HD (or Playback HD, for a recording) closes 1008 with
// HD_NOT_ALLOWED: the pages tell it apart from 'not allowed' and drop to the sub-stream, or say
// so, instead of trying again.
export const MAIN = 0
export const SUB = 1
export const HD_NOT_ALLOWED = 'hd not allowed'
/** NVR playback of the main stream, asked for without Live HD or Playback HD on the camera. */
export const HD_ASK_MESSAGE = 'Playing this camera in HD from the NVR needs Playback HD or Live HD.'
/** NVR playback that got no SD frame (the camera may be recorded in HD only), for someone who may not see main. */
export const HD_ONLY_MESSAGE = 'No SD recording of this camera came from the NVR (it may keep this camera only in HD). Playing it in HD needs Playback HD or Live HD.'

/**
 * @param {string|null|undefined} raw url.searchParams.get('stream')
 * @returns {number} MAIN, SUB, or NaN for anything else
 */
export function streamParam(raw) {
  if (raw === null || raw === undefined) return SUB
  if (raw === '0') return MAIN
  if (raw === '1') return SUB
  return Number.NaN
}
```

- [ ] **Step 5: Change `cctv/access-watch.mjs`**

(a) Header: after line 14 (`// /live-mux channel's close is an "end" for that one tile; the page's other tiles carry on.`) add:
```js
//
// A need is an action, or a list of actions any one of which will do: the NVR's main stream in
// playback needs playback-nvr and one of Live HD or Playback HD, ['playback-nvr', ['live-hd',
// 'playback-server']]. When only the full-quality needs fail (Live HD, or a group Live HD can meet),
// the close says 'hd not allowed' (stream-param.mjs): the page drops to the sub-stream instead of
// asking for the main stream again. Anything else failing is 'not allowed'.
```
and add the import after the header:
```js
import { HD_NOT_ALLOWED } from './stream-param.mjs'
```
(b) Before `export function accessWatch` add:
```js
/** A need about full quality only: Live HD, or a group that Live HD can meet. */
const isHdNeed = (need) => need === 'live-hd' || (Array.isArray(need) && need.includes('live-hd'))
```
(c) In `sweep`, replace lines 50-66 (the `for` loop) with:
```js
    for (const [ws, e] of [...open]) {
      const who = whoOf(e.req)
      // every need it was opened with must still be met; a check that throws is a no (default deny)
      const may = (action) => {
        try {
          return can(who, action, { nvr: e.nvr, ch: e.ch }) === true
        } catch {
          return false
        }
      }
      const meets = (need) => (Array.isArray(need) ? need.some(may) : may(need))
      // each need asked once (a check that throws counts once too)
      const failing = who ? e.actions.filter((need) => !meets(need)) : e.actions
      if (who && failing.length === 0) continue
      open.delete(ws)
      closed++
      // only the full-quality needs failing: the page drops to the sub-stream rather than retrying
      const reason = !who ? 'signed out' : failing.every(isHdNeed) ? HD_NOT_ALLOWED : 'not allowed'
      try {
        ws.close(1008, reason)
      } catch {}
    }
```
(d) In `track`, the JSDoc `@param` becomes `{ actions: Array<string|string[]>, nvr: string, ch: number }} what the rights it needs on that camera, every one of them (a list inside: any one of those)`, and line 97 becomes:
```js
      open.set(ws, { req, actions: actions.map((a) => (Array.isArray(a) ? [...a] : a)), nvr, ch })
```

- [ ] **Step 6: Run the tests**

Run: `node cctv/test/stream-param.test.mjs` — expected `all passed`.
Run: `node cctv/test/access-watch.test.mjs` — expected `all passed` (the (f) check "nothing closed is left in the watch" still counts 1: section (g) uses its own watch).
Run: `node cctv/test/live-mux-server.test.mjs` — expected `all passed` (unchanged).

- [ ] **Step 7: Commit**

```bash
git add cctv/stream-param.mjs cctv/test/stream-param.test.mjs cctv/access-watch.mjs cctv/test/access-watch.test.mjs
git commit -m "Stream parse in one place; the access watch: any-of needs and the 'hd not allowed' reason" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Live HD on the server — main refused, no stand-in without it, wait notices

**Files:**
- Create: `cctv/live-wait.mjs`
- Create: `cctv/test/live-wait.test.mjs` (Windows)
- Modify: `cctv/live-attach.mjs` (header :1-11, imports :12-15, :40-77)
- Modify: `cctv/live-mux.mjs:25-33` (protocol comment), after `:218` (`notice`)
- Modify: `cctv/sub-bridge.mjs:51` (one log wording)
- Modify: `cctv/server.mjs:1006-1014` (`/live` parse) and the imports (after line 124)
- Test: `cctv/test/live-mux-server.test.mjs` (Windows), `cctv/test/access-watch.test.mjs` (Windows)

**Interfaces:**
- Consumes: `streamParam`, `HD_NOT_ALLOWED` (Task 2); `can(who, 'live-hd', …)` (Task 1a); any-of reasons in the watch (Task 2).
- Produces:
  ```
  // cctv/live-wait.mjs
  export const WAIT_NOTICE_MS = 4000
  export const SD_UNAVAILABLE_MS = 15_000
  export const waitWhy = ({ held: boolean, waitedMs: number }) => 'held'|'starting'|'unavailable'
  export function waitForSub(ws, { stream, held: () => boolean, full?: () => boolean, everyMs?, every?, clear?, now?, since? }): () => void
  //   full (the NVR at its limit) counts as held for the first notice only; since: when the tile opened
  // cctv/live-mux.mjs
  MuxChannel.notice(obj: object): void     // text {...obj, id} on the page's socket
  // cctv/live-attach.mjs
  liveAttacher({ can, currentUser, adaptiveLive, phoneLive, track?, waitTimers? })
  //   main without live-hd: close(1008, 'hd not allowed'); tracks ['live'] (sub) or ['live','live-hd'] (main);
  //   a stand-in is tracked as its own handle with ['live','live-hd']; closing that handle (Live HD taken
  //   away) ends the stand-in and starts the wait notices
  ```

- [ ] **Step 1: Write the failing test `cctv/test/live-wait.test.mjs`**

```js
// Wait notices (live-wait.mjs): what a viewer without Live HD is told while its sub-stream has no
// picture yet, instead of being shown the main stream meanwhile. Fake socket and timers; pure.
//   node cctv/test/live-wait.test.mjs
import { SD_UNAVAILABLE_MS, WAIT_NOTICE_MS, waitForSub, waitWhy } from '../live-wait.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const fakeTimers = () => {
  const list = []
  return { list, every: (fn, ms) => { const t = { fn, ms, cleared: false }; list.push(t); return t }, clear: (t) => { t.cleared = true } }
}

check('why: held beats everything', waitWhy({ held: true, waitedMs: 99_999 }) === 'held')
check('why: starting, then unavailable after 15 s', waitWhy({ held: false, waitedMs: SD_UNAVAILABLE_MS - 1 }) === 'starting' && waitWhy({ held: false, waitedMs: SD_UNAVAILABLE_MS }) === 'unavailable' && SD_UNAVAILABLE_MS === 15_000)
check('every 4 s: under the tile\'s 8 s stall watchdog', WAIT_NOTICE_MS === 4000)
{
  let t = 0
  const timers = fakeTimers()
  const ws = { OPEN: 1, readyState: 1, sent: [], closes: [], send(d) { this.sent.push(d) }, on(e, f) { if (e === 'close') this.closes.push(f) } }
  const stream = { gop: [] }
  let held = false
  waitForSub(ws, { stream, held: () => held, every: timers.every, clear: timers.clear, now: () => t })
  const whys = () => ws.sent.map((d) => JSON.parse(d).why).join()
  check('a /live socket: a JSON object as text, at once', typeof ws.sent[0] === 'string' && ws.sent[0] === '{"op":"wait","why":"starting"}', ws.sent[0])
  check('... and a timer every 4 s', timers.list.length === 1 && timers.list[0].ms === WAIT_NOTICE_MS)
  t = 4000
  timers.list[0].fn()
  held = true
  t = 8000
  timers.list[0].fn()
  held = false
  t = 20_000
  timers.list[0].fn()
  check('each notice says why as it is then', whys() === 'starting,starting,held,unavailable', whys())
  stream.gop.push('keyframe')
  timers.list[0].fn()
  check('the sub-stream\'s first frame stops it', ws.sent.length === 4 && timers.list[0].cleared)
}
{
  const timers = fakeTimers()
  const notes = []
  const ch = { OPEN: 1, readyState: 1, sent: [], closes: [], send(d) { this.sent.push(d) }, notice(m) { notes.push(m) }, on(e, f) { if (e === 'close') this.closes.push(f) } }
  waitForSub(ch, { stream: { gop: [] }, held: () => false, every: timers.every, clear: timers.clear, now: () => 0 })
  check('a mux channel: through notice() (its send carries frames only), never send()', notes.length === 1 && notes[0].op === 'wait' && notes[0].why === 'starting' && ch.sent.length === 0)
  for (const f of ch.closes) f()
  check('closing the socket stops it', timers.list[0].cleared === true)
  ch.readyState = 3
  timers.list[0].fn()
  check('nothing is sent on a closed socket', notes.length === 1)
}
{
  const timers = fakeTimers()
  const ws = { OPEN: 1, readyState: 1, sent: [], send(d) { this.sent.push(d) }, on() {} }
  waitForSub(ws, { stream: { gop: ['keyframe'] }, held: () => false, every: timers.every, clear: timers.clear, now: () => 0 })
  check('a sub-stream already playing: nothing sent, no timer', ws.sent.length === 0 && timers.list.length === 0)
}

{
  // the NVR at its limit, but this sub-stream not held by it (the NVR refused it outright)
  let t = 0
  const timers = fakeTimers()
  const ws = { OPEN: 1, readyState: 1, sent: [], send(d) { this.sent.push(d) }, on() {} }
  waitForSub(ws, { stream: { gop: [] }, held: () => false, full: () => true, every: timers.every, clear: timers.clear, now: () => t })
  t = 4000
  timers.list[0].fn()
  t = 16_000
  timers.list[0].fn()
  const whys = ws.sent.map((d) => JSON.parse(d).why).join()
  check('the NVR full counts as held for the first notice only (value4u refusing 19-29 while others fill its limit)', whys === 'held,starting,unavailable', whys)
}
{
  const timers = fakeTimers()
  const ws = { OPEN: 1, readyState: 1, sent: [], send(d) { this.sent.push(d) }, on() {} }
  waitForSub(ws, { stream: { gop: [] }, held: () => false, since: 0, every: timers.every, clear: timers.clear, now: () => 20_000 })
  check('since: the 15 s counted from when the tile opened (a stand-in that ended later)', JSON.parse(ws.sent[0]).why === 'unavailable')
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Add the live-attach checks to `cctv/test/live-mux-server.test.mjs`**

(a) In the block `// ---- live-attach.mjs: one viewer's live video, …`, the last check's expected JSON (currently `'{"actions":["live"],"nvr":"n1","ch":3}'`, `base` is `streamType: 0`) becomes:
```js
  check('... let in: tracked with the live rights of the main stream (Live, Live HD) on its camera and its own request; refused (rights, offline, bad channel): not', tracked.length === 1 && tracked[0].w === inWs && tracked[0].r === inReq && JSON.stringify(tracked[0].what) === '{"actions":["live","live-hd"],"nvr":"n1","ch":3}', JSON.stringify(tracked.map((t) => t.what)))
```
(b) Insert a new block just before `// ---- server.mjs wiring (source shape: importing server.mjs starts the NVRs) ----`:
```js
// ---- live-attach.mjs: Live HD (stream rights) ----
{
  const mkStream = (gop) => ({ gop, viewers: new Set(), add(w) { this.viewers.add(w) }, remove(w) { this.viewers.delete(w) } })
  const mkNvr = ({ held = false, full = false } = {}) => ({
    id: 'n1', liveOnline: true, streams: new Map(),
    subHeld: (ch) => held && ch === 3, subFull: () => full, mainPlaying: () => true,
    codecSeen: new Map([['3:0', { codec: 'h265' }], ['3:1', { codec: 'h264' }]]),
    getStream(ch, type) {
      const k = `${ch}/${type}`
      if (!this.streams.has(k)) this.streams.set(k, mkStream(type === 1 ? [] : [frame(true)]))
      return this.streams.get(k)
    }
  })
  const fakeWs = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, closedWith: null, handlers: {}, sent: [], send(d) { this.sent.push(d) }, on(e, f) { (this.handlers[e] ??= []).push(f); return this }, close(code, reason) { this.closedWith = { code, reason }; this.readyState = 3 } })
  const texts = (w) => w.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d))
  const req = (addr = '192.168.1.20', ua = 'Desktop') => ({ socket: { remoteAddress: addr }, headers: { 'user-agent': ua, cookie: 'c=1' } })
  let rights = { live: true }
  const asked = []
  const tracked = []
  const adaptive = { calls: [], attach(key, o) { this.calls.push(o) } }
  const phone = { calls: [], attach(key, stream, type, ws, opts) { this.calls.push({ key, type, opts }); return true }, detach() {}, room: () => 16, has: () => false }
  const timers = []
  const waitTimers = { every: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t }, clear: (t) => { t.cleared = true }, now: () => 0 }
  const attach = liveAttacher({ can: (who, action) => { asked.push(action); return rights[action] === true }, currentUser: () => 'ann', adaptiveLive: adaptive, phoneLive: phone, track: (w, r, what) => tracked.push({ w, what }), waitTimers })
  const run = (o = {}, r = req()) => { const w = fakeWs(); const nvr = o.nvr ?? mkNvr(); attach(w, r, { nvr, who: { user: 'ann' }, ch: 3, streamType: 1, clientH265: true, phone15: false, ...o }); return { w, nvr } }

  let x = run({ streamType: 0 })
  check('Live HD: the main stream without it is 1008 "hd not allowed", Live asked first', x.w.closedWith?.code === 1008 && x.w.closedWith.reason === 'hd not allowed' && asked.join() === 'live,live-hd', asked.join())
  check('... nothing tracked, no stream touched', tracked.length === 0 && x.nvr.streams.size === 0)
  rights = { 'live-hd': true }
  x = run({ streamType: 0 })
  check('... Live HD without Live: "not allowed" (HD is an add-on)', x.w.closedWith?.reason === 'not allowed')
  rights = { live: true, 'live-hd': true }
  x = run({ streamType: 0 })
  check('... with both: the main stream, tracked for Live and Live HD', x.nvr.getStream(3, 0).viewers.has(x.w) && JSON.stringify(tracked.at(-1).what) === '{"actions":["live","live-hd"],"nvr":"n1","ch":3}', JSON.stringify(tracked.at(-1)?.what))
  x = run({ streamType: Number.NaN })
  check('... no stream at all (stream-param.mjs NaN): "bad channel or stream"', x.w.closedWith?.reason === 'bad channel or stream')

  // the stand-in for a sub-stream with no picture yet
  tracked.length = 0
  x = run()
  const stand = [...x.nvr.getStream(3, 0).viewers]
  check('cold sub with Live HD: the main stream stands in; the stand-in is tracked apart, for Live and Live HD', stand.length === 1 && stand[0].background === true && tracked.length === 2 && JSON.stringify(tracked[1].what.actions) === '["live","live-hd"]' && tracked[1].w !== x.w)
  tracked[1].w.close(1008, 'hd not allowed') // what the watch does when Live HD goes
  check('... closing that handle ends the stand-in only: the viewer stays on its sub-stream', x.nvr.getStream(3, 0).viewers.size === 0 && x.w.closedWith === null && x.nvr.getStream(3, 1).viewers.has(x.w))
  rights = { live: true }
  tracked.length = 0
  timers.length = 0
  x = run()
  check('cold sub without Live HD: the main stream is never asked for (asking starts it)', !x.nvr.streams.has('3/0') && x.nvr.getStream(3, 1).viewers.has(x.w))
  check('... the tile is told at once: {"op":"wait","why":"starting"}', JSON.stringify(texts(x.w)) === '[{"op":"wait","why":"starting"}]', JSON.stringify(texts(x.w)))
  check('... again every 4 s', timers.length === 1 && timers[0].ms === 4000)
  timers[0].fn()
  check('... repeated', texts(x.w).length === 2)
  x.nvr.getStream(3, 1).gop.push(frame(true))
  timers[0].fn()
  check('... until the sub-stream has a picture', texts(x.w).length === 2 && timers[0].cleared === true)
  check('... tracked for Live only (nothing of the main stream to watch)', tracked.length === 1 && JSON.stringify(tracked[0].what.actions) === '["live"]')
  x = run({ nvr: mkNvr({ held: true }) })
  check('held at the NVR\'s sub-stream limit: "held"', texts(x.w)[0]?.why === 'held')
  timers.length = 0
  x = run({ nvr: mkNvr({ full: true }) })
  timers[0].fn()
  check('the NVR full, this sub-stream not held by it (value4u refuses 19-29 outright): "held" at once, not after', JSON.stringify(texts(x.w).map((t) => t.why)) === '["held","starting"]', JSON.stringify(texts(x.w)))
  x = run({ nvr: mkNvr({ held: true }), phone15: true, clientH265: false }, req('192.168.1.30', 'Mozilla/5.0 (iPhone)'))
  check('held, a phone: no converted stand-in either (no /standin conversion, no main)', !phone.calls.some((c) => c.key === 'n1/3/0/standin') && !x.nvr.streams.has('3/0'))
  adaptive.calls.length = 0
  x = run({}, req('127.0.0.1'))
  check('a remote viewer: adaptive-live on its own sub-stream, no raw main before it', adaptive.calls.length === 1 && adaptive.calls[0].type === 1 && !x.nvr.streams.has('3/0') && texts(x.w)[0]?.op === 'wait')
  // on a mux channel the notice goes through the channel, with its id
  const m = setup({ attach: (channel, s) => attach(channel, req(), { nvr: mkNvr(), who: { user: 'ann' }, ch: s.ch, streamType: s.stream, clientH265: true, phone15: false }) })
  m.ws.msg(sub(8))
  check('a mux channel without Live HD: {"op":"wait","why":"starting","id":8} on the page\'s socket', JSON.stringify(m.ws.texts()) === '[{"op":"wait","why":"starting","id":8}]', JSON.stringify(m.ws.texts()))
  m.ws.msg(sub(9, { stream: 0 }))
  check('... the main stream asked on a channel: "end" 1008 "hd not allowed" for that id, the socket stays', m.ws.texts().some((t) => t.op === 'end' && t.id === 9 && t.code === 1008 && t.reason === 'hd not allowed') && m.ws.readyState === 1)
  m.ws.msg('{"op":"sub","id":10,"nvr":"n1","ch":3,"stream":-0}') // raw text: JSON.stringify writes -0 as 0
  check('... "stream":-0 passes the channel check as 0: the main stream all the same, "hd not allowed"', m.ws.texts().some((t) => t.op === 'end' && t.id === 10 && t.code === 1008 && t.reason === 'hd not allowed'), JSON.stringify(m.ws.texts()))
}
```
(c) In the `// ---- server.mjs wiring` block add:
```js
  check('/live parses its stream once, strictly (stream-param.mjs)', /streamType: streamParam\(url\.searchParams\.get\('stream'\)\)/.test(src) && !/Number\(url\.searchParams\.get\('stream'\)/.test(src))
```

- [ ] **Step 3: Update `cctv/test/access-watch.test.mjs` for Live HD, and add section (h)**

(a) Line 13 (Alice may watch her two cameras at full quality, as the upgrade gives everyone with Live; her tiles below are main-stream tiles, `streamType: 0`):
```js
const ALICE = { live: ['nvr-2/5', 'nvr-2/6'], 'live-hd': ['nvr-2/5', 'nvr-2/6'], 'playback-server': ['nvr-2/5'], 'playback-nvr': ['nvr-2/5'] }
```
(a2) Line 114 keeps Live HD on the camera she keeps (section (c) opens a main-stream tile of it next):
```js
rights.saveRights('alice', { grants: { live: ['nvr-2/6'], 'live-hd': ['nvr-2/6'] } })
```
(b) Insert just before `// ---- server.mjs wiring (source shape: …)` (after section (g) from Task 2):
```js
// ---- (h) Live HD taken away, Live kept: the main stream goes, the sub-stream stays (real rights) -------
{
  const mk = (gop) => ({ gop, viewers: new Set(), add(w) { this.viewers.add(w) }, remove(w) { this.viewers.delete(w) } })
  const cams = new Map()
  // ch 5's sub-stream is not running (cold): with Live HD its main stream stands in
  const NVR2 = { id: 'nvr-2', liveOnline: true, getStream(ch, type) { const k = `${ch}/${type}`; if (!cams.has(k)) cams.set(k, mk(type === 1 && ch === 5 ? [] : [frame()])); return cams.get(k) } }
  rights.saveRights('alice', { grants: ALICE })
  const hreq = reqWith(auth.createSession('alice'))
  const attachAs = (ch, streamType) => { const ws = new FakeWs(); attachLive(ws, hreq, { nvr: NVR2, who: whoOf('alice'), ch, streamType, clientH265: true, phone15: false }); return ws }
  const main6 = attachAs(6, 0)
  const sub6 = attachAs(6, 1)
  const cold5 = attachAs(5, 1)
  // and a page's /live-mux channel on the same cold sub-stream
  const page2 = new FakeWs()
  serveMux(page2, {
    session: () => currentUser(hreq),
    attach: (channel, sub, user) => attachLive(channel, hreq, { nvr: NVR2, who: whoOf(user), ch: sub.ch, streamType: sub.stream, clientH265: true, phone15: false }),
    log: () => {}
  })
  page2.msg({ op: 'sub', id: 21, nvr: 'nvr-2', ch: 5, stream: 1 })
  await tick()
  check('(h) with Live HD: the main stream plays, and a cold sub-stream (a socket, a mux channel) is shown the main stream meanwhile, no wait notice', cams.get('6/0').viewers.has(main6) && cams.get('5/0').viewers.size === 2 && cold5.texts().length === 0 && page2.texts().length === 0, J(page2.texts()))
  rights.saveRights('alice', { grants: { ...ALICE, 'live-hd': [] } })
  await tick()
  await tick()
  check('(h) Live HD taken away: the main socket closes 1008 "hd not allowed"', main6.closedWith?.code === 1008 && main6.closedWith.reason === 'hd not allowed', J(main6.closedWith))
  check('(h) ... the sub-stream socket stays open', sub6.closedWith === null && cams.get('6/1').viewers.has(sub6))
  check('(h) ... both stand-ins end; the socket and the mux channel stay on their own sub-stream', cams.get('5/0').viewers.size === 0 && cold5.closedWith === null && cams.get('5/1').viewers.has(cold5) && cams.get('5/1').viewers.size === 2 && !page2.texts().some((t) => t.op === 'end'), J(page2.texts()))
  check('(h) ... and each is told why it waits from then on, as a tile without Live HD is (live-wait.mjs)', J(cold5.texts()) === '[{"op":"wait","why":"starting"}]' && J(page2.texts()) === '[{"op":"wait","why":"starting","id":21}]', J([cold5.texts(), page2.texts()]))
  rights.saveRights('alice', { grants: { live: [] } })
  await tick()
  await tick()
  check('(h) Live taken away too: the rest close "not allowed"', sub6.closedWith?.reason === 'not allowed' && cold5.closedWith?.reason === 'not allowed' && page2.texts().some((t) => t.op === 'end' && t.id === 21 && t.reason === 'not allowed'), J(page2.texts()))
}
```

- [ ] **Step 4: Run to see them fail**

Run: `node cctv/test/live-wait.test.mjs` — expected `ERR_MODULE_NOT_FOUND … live-wait.mjs`.
Run: `node cctv/test/live-mux-server.test.mjs` — expected FAIL on the tracked-actions check, the Live HD block and the server.mjs parse check.
Run: `node cctv/test/access-watch.test.mjs` — expected FAIL on the (h) checks (Task 2 left `'not allowed'` for everything a tile's main stream needs, and nothing tells a tile why it waits yet).

- [ ] **Step 5: Create `cctv/live-wait.mjs`**

```js
// A viewer without Live HD whose sub-stream has no picture yet (cold, held at the NVR's sub-stream
// limit, or never sent by the NVR) is not shown the main stream meanwhile (live-attach.mjs): the
// stand-in is main-stream pictures, a full-resolution keyframe even when it lasts two seconds. Its
// tile would then show nothing, for minutes at the NVR's limit, and its stall watchdog
// (live-tile.js, 8 s) would drop and reopen it over and over. So it is told why it waits, at once
// and every WAIT_NOTICE_MS until the sub-stream's first frame or the socket closes: a JSON object as
// text, {"op":"wait","why":W} on a /live socket, {"op":"wait","id":N,"why":W} on a /live-mux
// channel (MuxChannel.notice: a channel's send carries frames only). W is 'held' (the NVR holds this
// sub-stream back at its limit, nvrs.mjs subHeld), 'starting', or 'unavailable' (not held, and
// nothing SD_UNAVAILABLE_MS after the tile opened: the NVR does not send this camera's sub-stream, as
// value4u refuses cameras 19-29). Always an object: a pre-release /live tile turns a text into
// new Uint8Array(text), empty for an object (it counts as activity and is dropped) but a zero-filled
// array for a text of digits.
//
// Only for a socket with no stand-in running: on one with a bridge (sub-bridge.mjs) any send ends the
// stand-in. Pure (no SDK); the timers are injectable for the tests.
export const WAIT_NOTICE_MS = 4000
export const SD_UNAVAILABLE_MS = 15_000

/** @returns {'held'|'starting'|'unavailable'} */
export const waitWhy = ({ held, waitedMs }) => (held ? 'held' : waitedMs >= SD_UNAVAILABLE_MS ? 'unavailable' : 'starting')

/**
 * Tells the viewer on `ws` why its sub-stream shows nothing yet, until it does.
 * @param {object} ws the viewer's /live socket or mux channel (send, notice?, readyState, OPEN, on)
 * @param {{ stream: { gop: any[] }, held: () => boolean, full?: () => boolean, everyMs?: number,
 *   every?: typeof setInterval, clear?: typeof clearInterval, now?: () => number, since?: number }} o
 *   stream: the sub-stream it waits for; held: whether the NVR holds this one back at its limit, asked
 *   at each notice; full: whether the NVR is at its limit, which counts as held for the first notice
 *   only (the tile's request is not in the worker's list yet, and will be held); after that a camera
 *   the NVR refuses outright is not called held while other tiles fill the limit; since: when the
 *   tile opened (the 15 s are counted from then)
 * @returns {() => void} stops the notices
 */
export function waitForSub(ws, { stream, held, full = () => false, everyMs = WAIT_NOTICE_MS, every = setInterval, clear = clearInterval, now = Date.now, since = now() }) {
  let timer = null
  let first = true
  const stop = () => {
    if (timer !== null) clear(timer)
    timer = null
  }
  const open = () => ws.readyState === (ws.OPEN ?? 1)
  const say = () => {
    if (!open() || stream.gop?.length > 0) return stop()
    const isHeld = held() === true || (first && full() === true)
    first = false
    const msg = { op: 'wait', why: waitWhy({ held: isHeld, waitedMs: now() - since }) }
    if (typeof ws.notice === 'function') ws.notice(msg)
    else ws.send(JSON.stringify(msg))
  }
  say()
  if (open() && !(stream.gop?.length > 0)) {
    timer = every(say, everyMs)
    timer?.unref?.()
  }
  ws.on?.('close', stop)
  return stop
}
```

- [ ] **Step 6: `MuxChannel.notice` and the protocol comment in `cctv/live-mux.mjs`**

(a) In the header, after the `end` lines (30-32) add:
```js
//     TEXT    {"op":"wait","id":N,"why":"held"|"starting"|"unavailable"}: channel N's sub-stream has
//             no picture yet, and this viewer is shown no main stream meanwhile (no Live HD,
//             live-wait.mjs); repeated every 4 s until its first frame. A page that does not know
//             the op ignores it. 1008 "hd not allowed" in an "end": the main stream refused for want
//             of Live HD (live-attach.mjs, access-watch.mjs).
```
(b) After `close(code, reason)` (line 218) add:
```js
  /** A note for this channel's tile, as text with its id (live-wait.mjs): send() carries frames only. */
  notice(obj) {
    if (!this.#open || this.#mux.ws.readyState !== OPEN) return
    this.#mux.sendText({ ...obj, id: this.id })
  }
```

- [ ] **Step 7: `cctv/live-attach.mjs`**

(a) Header: after line 8 (`… losing the live right to that camera, the account or the session ends it too.`) add:
```js
// Live HD (rights.mjs) decides every main-stream picture here: the main stream asked for directly
// (refused 1008 'hd not allowed' without it), and the main stream standing in for a sub-stream that
// has no picture yet (none without it: the viewer is told why it waits instead, live-wait.mjs).
```
(b) Imports (lines 12-15) become:
```js
import { createHash } from 'node:crypto'
import { isRemoteAddress } from './adaptive-live.mjs'
import { waitForSub } from './live-wait.mjs'
import { isPhoneRequest } from './phone-live.mjs'
import { HD_NOT_ALLOWED } from './stream-param.mjs'
import { bridgeSub } from './sub-bridge.mjs'
```
(c) Replace lines 40-77 (the `liveAttacher` JSDoc through the end of the stand-in `if`) with:
```js
/**
 * The stand-in as the access watch sees it (access-watch.mjs): Live HD taken away ends the main
 * stream's pictures on this socket and nothing else; the viewer stays on its own sub-stream and, while
 * that has no picture yet, is told why it waits from then on (wait: live-wait.mjs; the bridge's send
 * passes straight through once it has ended). It leaves the watch when the socket closes.
 */
const standInHandle = (ws, bridge, wait) => ({
  readyState: 1,
  on: (event, fn) => ws.on?.(event, fn),
  close: () => {
    bridge.end('rights')
    wait()
  }
})

/**
 * @param {{ can: Function, currentUser: (req: object) => string|null,
 *   adaptiveLive: { attach: Function }, phoneLive: { attach: Function }, track?: Function,
 *   waitTimers?: { every?: Function, clear?: Function, now?: () => number } }} o
 *   can: rights.mjs can; currentUser: the request's signed-in user; track: access-watch.mjs's, which
 *   asks the rights again while the socket or channel is open; waitTimers: live-wait.mjs's timers (tests)
 * @returns {(ws: object, req: object, o: { nvr: object, who: object, ch: number, streamType: number,
 *   clientH265: boolean, phone15: boolean }) => void} attachLive
 */
export function liveAttacher({ can, currentUser, adaptiveLive, phoneLive, track = () => {}, waitTimers = {} }) {
  return function attachLive(ws, req, { nvr, who, ch, streamType, clientH265, phone15 }) {
    if (!can(who, 'live', { nvr: nvr.id, ch })) return ws.close(1008, 'not allowed')
    // live video: with a live worker, the worker's own login decides (it polls the camera list)
    if (!nvr.liveOnline) {
      ws.close(1013, 'NVR offline')
      return
    }
    if (!Number.isInteger(ch) || ch < 0 || ![0, 1].includes(streamType)) {
      ws.close(1008, 'bad channel or stream')
      return
    }
    // Live HD: the main stream is full quality -- and so is anything that is not the sub-stream. Its
    // own reason, so the page drops to the sub-stream instead of asking again.
    const hd = () => can(who, 'live-hd', { nvr: nvr.id, ch })
    if (streamType !== 1 && !hd()) return ws.close(1008, HD_NOT_ALLOWED)
    // let in: the same question again for as long as it is open, from the session as it is then.
    // Every path below (sub-bridge, adaptive, phone, the stream itself) ends with this socket or
    // channel closing, which is how it leaves the watch.
    track(ws, req, { actions: streamType === 1 ? ['live'] : ['live', 'live-hd'], nvr: nvr.id, ch })
    const stream = nvr.getStream(ch, streamType)
    const remote = isRemoteAddress(req.socket.remoteAddress)
    const phone = !remote && phone15 && isPhoneRequest(req.headers)
    // held back at the NVR's sub-stream limit (nvrs.mjs subHeld): no picture of its own until there
    // is room. A tile's first request is not in the worker's list yet: with the NVR at its limit, a
    // sub-stream not running yet will be held (subFull)
    const held = streamType === 1 && (nvr.subHeld?.(ch) === true || (!(stream.gop?.length > 0) && nvr.subFull?.() === true))
    // A sub-stream that is not running yet (cold, refused by the NVR, or held at its limit): the
    // camera's main stream meanwhile, until the sub-stream's own first frame (sub-bridge.mjs). Those
    // are main-stream pictures -- a full-resolution keyframe even for two seconds -- so only with
    // Live HD, and watched for it apart from the socket. Without it the main stream is not even asked
    // for (asking starts it), and the tile is told why it waits (live-wait.mjs): held when the NVR
    // holds this sub-stream back (or, for the first notice, is at its limit: the `held` above), counted
    // from now.
    const since = (waitTimers.now ?? Date.now)()
    const wait = () => waitForSub(ws, { stream, held: () => nvr.subHeld?.(ch) === true, full: () => nvr.subFull?.() === true, since, ...waitTimers })
    if (streamType === 1 && !(stream.gop?.length > 0)) {
      if (hd()) {
        const main = nvr.getStream(ch, 0)
        const log = held ? (line) => console.log(`[${nvr.id}/${ch + 1}] sub-stream held at the NVR's limit: ${line}`) : undefined
        const bridge = bridgeSub(ws, { sub: stream, main: standIn(nvr, ch, main, { phone, held, clientH265, phoneLive }), clientH265, log })
        if (bridge) track(standInHandle(ws, bridge, wait), req, { actions: ['live', 'live-hd'], nvr: nvr.id, ch })
      } else {
        wait()
      }
    }
```
(Lines 78-93, adaptive, phone and the plain path, are unchanged.)

- [ ] **Step 8: `cctv/sub-bridge.mjs:51` says why the stand-in ended**

```js
    if (sent) log(`${sent} frames of the main stream shown ${why === 'sub' ? 'until the sub-stream came' : why === 'rights' ? 'until Live HD was taken away' : 'until the tile closed'}`)
```

- [ ] **Step 9: `cctv/server.mjs`: `/live` parses its stream once**

After line 124 (`import { can, canPlayAnyOn, … } from './rights.mjs'`) add:
```js
import { streamParam } from './stream-param.mjs'
```
Replace lines 1006-1014 (the `/live` call) with:
```js
  // /live (a missing ch reads as 0, a missing stream as 1, as always; stream-param.mjs: anything but
  // exactly 0 or 1 is no stream, which attachLive refuses -- '', '0.0' and the like were main)
  attachLive(ws, req, {
    nvr,
    who,
    ch: target.ch,
    streamType: streamParam(url.searchParams.get('stream')),
    clientH265: url.searchParams.get('h265') === '1',
    phone15: url.searchParams.get('fps') === '15'
  })
```

- [ ] **Step 10: Run the tests**

Run, one after another: `node cctv/test/live-wait.test.mjs`, `node cctv/test/live-mux-server.test.mjs`, `node cctv/test/access-watch.test.mjs`, `node cctv/test/sub-bridge.test.mjs`, `node cctv/test/adaptive-live.test.mjs`, `node cctv/test/phone-live.test.mjs`, `node cctv/test/stream-hub.test.mjs`.
Expected: each ends `all passed`.
Server copy (Appendix A b, c; it needs `build/lib`): `bash /tmp/stream-rights-test/run-tests.sh cctv/test/camera-poll.test.mjs cctv/test/live-worker.test.mjs` — expected two `rc=0 fails=0` lines (their server.mjs pins on `liveAttacher(` still hold).

- [ ] **Step 11: Commit**

```bash
git add cctv/live-wait.mjs cctv/test/live-wait.test.mjs cctv/live-attach.mjs cctv/live-mux.mjs cctv/sub-bridge.mjs cctv/server.mjs cctv/test/live-mux-server.test.mjs cctv/test/access-watch.test.mjs
git commit -m "Live HD on the server: main refused without it, no main stand-in without it (wait notices instead), the stand-in watched for it, strict /live stream parse" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The HD-only switch fixed — running time only, restarted on play, marked after main frames, healed by SD, old marks re-tested, re-tested weekly

A bug fix before any right depends on it (M1, M2 in the completeness review, map-critic): after this task the switch still happens for every viewer, as today, but only when the NVR really played 4 s without an SD frame, and a camera is marked only when main frames came. Task 5 then gates the switch on the viewer's rights.

**Files:**
- Create: `cctv/hd-only.mjs`
- Create: `cctv/test/hd-only.test.mjs` (Windows)
- Create: `cctv/test/playback-hd-switch.test.mjs` (server copy: it loads playback.mjs, which loads koffi)
- Modify: `cctv/playback.mjs` (imports :39-46, `:67` SD_FALLBACK_MS goes, `:419-446` the store, the `PlaybackSession` constructor `:472`, `#onFrame` `:583`, `#updateNvr` `:669`, `#watch` `:705-707`, `#switchToMain` `:724-740`, the returned object `:813-814`)
- Regression: `cctv/test/rec-fallback.test.mjs`, `cctv/test/rec-playback.test.mjs` (Windows); `playback-busy`, `playback-search`, `playback-dates`, `rec-fallback` (server copy: they load playback.mjs)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```
  // cctv/hd-only.mjs
  export const SD_FALLBACK_MS = 4000
  export const HD_ONLY_RETEST_MS = 604_800_000   // 7 days
  export class SdWait { constructor(limitMs = SD_FALLBACK_MS); tick(now: number, running: boolean): boolean; restart(): void; ms: number }
  export function hdOnlyStore({ file, nvrId, now? = Date.now, retestMs? = HD_ONLY_RETEST_MS, log? })
    -> { has(ch): boolean, mark(ch): void, unmark(ch): void }   // an older release's [ch, …] list is not read
  // cctv/playback.mjs: createPlayback(nvr) still returns { …, isHdOnly(ch), markHdOnly(ch) }
  ```

- [ ] **Step 1: Write the failing test `cctv/test/hd-only.test.mjs`**

```js
// The NVR's cameras recorded in HD only (hd-only.mjs): the 4 s wait for an SD frame that finds them,
// counted only while the NVR is really playing, and the list of them, which a slow NVR must not be
// able to fill for good. Temp folder only; pure (no SDK), so it runs anywhere.
//   node cctv/test/hd-only.test.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HD_ONLY_RETEST_MS, SD_FALLBACK_MS, SdWait, hdOnlyStore } from '../hd-only.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

check('4 s for an SD picture, a week before a mark is tried again', SD_FALLBACK_MS === 4000 && HD_ONLY_RETEST_MS === 7 * 24 * 3_600_000)
{
  const w = new SdWait()
  check('not started (the open waits in the NVR lane): never over, however long', [0, 500, 5000, 60_000].every((t) => w.tick(t, false) === false))
  check('started: the first tick only starts the count', w.tick(100_000, true) === false)
  check('... 3.5 s of playing is not enough', w.tick(103_500, true) === false)
  check('... 4 s is', w.tick(104_000, true) === true)
  const p = new SdWait()
  p.tick(0, true)
  p.tick(2000, true)
  p.tick(2500, false)
  p.tick(60_000, false) // paused by the viewer for a minute
  check('paused: the count stands still', p.tick(60_500, true) === false && p.ms === 2000, String(p.ms))
  p.restart()
  check('restart (played again with no frame yet): from zero', p.ms === 0 && p.tick(61_000, true) === false && p.tick(64_500, true) === false && p.tick(65_000, true) === true)
}
{
  const dir = mkdtempSync(join(tmpdir(), 'hd-only-'))
  const file = join(dir, 'hd-only.json')
  let t = 1_000_000
  writeFileSync(file, JSON.stringify({ n1: [2, 5], other: { 7: 123 } }))
  const s = hdOnlyStore({ file, nvrId: 'n1', now: () => t })
  check('an older release\'s list ([ch, …], written by the faulty rule) is not trusted: each camera is tried in SD again', !s.has(2) && !s.has(5) && !s.has(3))
  s.mark(3)
  s.mark(5)
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  check('marks are saved with their time; other NVRs are kept as they were', disk.n1['3'] === t && disk.n1['5'] === t && !('2' in disk.n1) && disk.other['7'] === 123, JSON.stringify(disk))
  s.unmark(5)
  check('unmark (an SD frame came): gone, and saved', !s.has(5) && !('5' in JSON.parse(readFileSync(file, 'utf8')).n1))
  t += HD_ONLY_RETEST_MS
  check('a week on: not trusted any more (the camera is tried in SD again)', !s.has(3))
  s.mark(2)
  check('... marked again when main frames come again', s.has(2))
  const again = hdOnlyStore({ file, nvrId: 'n1', now: () => t })
  check('read back by a new process: the same marks, with their times', again.has(2) && !again.has(3) && !again.has(5))
  const junk = join(dir, 'junk.json')
  writeFileSync(junk, 'not json')
  const j = hdOnlyStore({ file: junk, nvrId: 'n1', now: () => t })
  j.mark(1)
  check('an unreadable file: no marks, and marking still works', j.has(1) && !j.has(0))
  const logs = []
  const bad = hdOnlyStore({ file: join(dir, 'no-such-dir', 'x.json'), nvrId: 'n1', now: () => t, log: (l) => logs.push(l) })
  bad.mark(4)
  check('a file that cannot be written: kept in memory, said once, no throw', bad.has(4) && logs.length === 1)
}

// ---- playback.mjs uses it (read as text: playback.mjs loads the SDK, which this PC cannot) ---------------
{
  const src = readFileSync(new URL('../playback.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  check('playback.mjs: the wait counts only while the NVR plays the started session', /const running = this\.openedAt > 0 && this\.nvrRunning && !this\.paused\n\s*if \(!this\.gotFrames && !this\.mainStream && this\.sdWait\.tick\(Date\.now\(\), running\)\)/.test(src))
  check('playback.mjs: ... from zero again when played again before any frame', /if \(!this\.gotFrames\) this\.sdWait\.restart\(\)/.test(src))
  check('playback.mjs: the first SD frame clears a mark, the first main frame after a switch sets it', /if \(!this\.mainStream\) hdOnly\.unmark\(this\.ch\)\n\s*else if \(this\.markOnFrames\) \{/.test(src))
  check('playback.mjs: a switch alone marks nothing', !/markHdOnly\(this\.ch\)/.test(src) && /this\.markOnFrames = true/.test(src))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run it to see it fail**

Run: `node cctv/test/hd-only.test.mjs`
Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/cctv/hd-only.mjs'`.

- [ ] **Step 3: Create `cctv/hd-only.mjs`**

```js
// The NVR's cameras recorded in HD only, and the wait for an SD picture that finds them
// (playback.mjs). Pure apart from its one file; no SDK, so it is tested on any machine.
//
// An NVR playback asked for the sub-stream that gets no frame goes over to the main stream after
// SD_FALLBACK_MS, and the camera is remembered (DATA_DIR/hd-only.json) so the next playback asks for
// main at once. Two faults let a slow NVR mark cameras for good: the 4 s were counted from before the
// session had even started (openedAt was 0 until the NVR answered, so a tile waiting its turn in the
// NVR's lane "timed out" at the first 500 ms tick), and a session paused while it opened (the camera
// wall opens its tiles paused) switched at the first tick after play. A false mark sends every later
// playback of that camera to the main stream, and would keep a viewer who may not see main from it
// (stream rights). So: SdWait counts only the time the NVR was really playing and starts again at
// each resume; a camera is marked only when main frames came after a switch; an SD frame clears a
// mark; and a mark is trusted for HD_ONLY_RETEST_MS, then the camera is tried in SD again.
//
// hd-only.json: { "<nvr>": { "<ch>": markedAtMs } }. An older release wrote { "<nvr>": [ch, …] } by
// the faulty rule above: those are not trusted (dropped when read), so each camera is tried in SD
// once more. (An older release reading the new form sees no HD-only cameras and learns them again
// with its own rule: harmless.)
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export const SD_FALLBACK_MS = 4000
export const HD_ONLY_RETEST_MS = 7 * 24 * 3_600_000

/** One session's wait for its first SD frame, counting only the time the NVR was playing it. */
export class SdWait {
  constructor(limitMs = SD_FALLBACK_MS) {
    this.limitMs = limitMs
    this.ms = 0 // playing time counted so far
    this.at = null // when the count last moved (null: not counting)
  }

  /**
   * Every watch tick (playback.mjs, 500 ms). running: the session has started, the viewer has not
   * paused it and the NVR is playing it.
   * @returns {boolean} the limit is reached with no SD frame
   */
  tick(now, running) {
    if (!running) {
      this.at = null
      return false
    }
    if (this.at !== null) this.ms += Math.max(0, now - this.at)
    this.at = now
    return this.ms >= this.limitMs
  }

  /** From zero again: played again before any frame came, or a new playback of the same session. */
  restart() {
    this.ms = 0
    this.at = null
  }
}

/**
 * One NVR's HD-only cameras, kept in `file` beside every other NVR's.
 * @param {{ file: string, nvrId: string, now?: () => number, retestMs?: number, log?: (line: string) => void }} o
 * @returns {{ has: (ch: number) => boolean, mark: (ch: number) => void, unmark: (ch: number) => void }}
 */
export function hdOnlyStore({ file, nvrId, now = Date.now, retestMs = HD_ONLY_RETEST_MS, log = console.warn }) {
  const readAll = () => {
    try {
      const all = JSON.parse(readFileSync(file, 'utf8'))
      return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
    } catch {
      return {}
    }
  }
  const marks = new Map() // ch -> markedAtMs
  const mine = readAll()[nvrId]
  // An older release's list ([ch, …]) was written by the faulty rule: not trusted, so not read (each of
  // those cameras is tried in SD once more, and marked again if it really records HD only)
  if (mine && typeof mine === 'object' && !Array.isArray(mine)) {
    for (const [k, at] of Object.entries(mine)) if (/^\d{1,3}$/.test(k) && Number.isFinite(at)) marks.set(Number(k), at)
  }
  const save = () => {
    try {
      const all = readAll()
      all[nvrId] = Object.fromEntries([...marks].sort((a, b) => a[0] - b[0]).map(([ch, at]) => [String(ch), at]))
      const tmp = `${file}.tmp-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify(all)}\n`, { mode: 0o600 })
      renameSync(tmp, file)
    } catch (e) {
      log(`[${nvrId}] could not save the HD-only list: ${e.message}`)
    }
  }
  return {
    /** Recorded in HD only, as last seen, and not so long ago that it is time to try SD again. */
    has: (ch) => marks.has(ch) && now() - marks.get(ch) < retestMs,
    /** Main frames came where SD did not: HD only, as of now. */
    mark(ch) {
      marks.set(ch, now())
      save()
    },
    /** An SD frame came: not HD only (a mark from a slow NVR, or one past its re-test). */
    unmark(ch) {
      if (marks.delete(ch)) save()
    }
  }
}
```

- [ ] **Step 4: Run it**

Run: `node cctv/test/hd-only.test.mjs`
Expected: the `SdWait` and store checks `PASS`; the four `playback.mjs:` checks `FAIL` (`4 failed`): playback.mjs is changed in Step 7.

- [ ] **Step 5: Write the server-copy test `cctv/test/playback-hd-switch.test.mjs`**

```js
// The NVR playback session's switch to the main stream (playback.mjs PlaybackSession, hd-only.mjs):
// a camera the NVR records in HD only is found by "no SD frame in 4 s of the NVR playing". The 4 s
// used to be counted from before the session had started (openedAt 0 until the NVR answered) and
// through a pause at open, so a slow NVR or the camera wall marked cameras HD-only for good. Fake
// NVRs whose lane answers each SDK job without running it (as playback-busy.test.mjs): nothing
// reaches an NVR, but playback.mjs loads koffi, so this runs on the server copy.
//   node cctv/test/playback-hd-switch.test.mjs        (on the server copy)
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pb-hd-switch-'))
const pb = await import('../playback.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const HD_FILE = join(process.env.DATA_DIR, 'hd-only.json')
const marked = (id, ch) => existsSync(HD_FILE) && String(ch) in (JSON.parse(readFileSync(HD_FILE, 'utf8'))[id] ?? {})

/**
 * A fake NVR. Its lane answers each job in turn from `answers` (then true) without running it: the
 * clock read, PlayBackByTimeEx (a handle), SetPlayDataCallBack, then stops and controls. `slow` holds
 * the answer to job number `slow.job` for `slow.ms` (a tile waiting behind others in the NVR's lane).
 */
const fakeNvr = (id, answers, slow = null) => {
  let n = 0
  const nvr = {
    id, name: `NVR ${id}`, userId: 7, online: true, degraded: false, jobs: 0,
    lane: {
      run: async () => {
        const k = n++
        nvr.jobs++
        if (slow && k === slow.job) await sleep(slow.ms)
        return k < answers.length ? answers[k] : true
      }
    },
    sessions: { acquire: async () => ({ userId: 9, release() {} }) }
  }
  nvr.playback = pb.createPlayback(nvr)
  return nvr
}
/** A fake browser WebSocket for /playback: the JSON it is sent, and how it was closed. */
const fakeWs = () => {
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [], closedWith: null, handlers: {} }
  ws.send = (m) => typeof m === 'string' && ws.sent.push(JSON.parse(m))
  ws.on = (event, fn) => (ws.handlers[event] = fn)
  ws.close = (code, reason) => {
    if (ws.readyState !== 1) return
    ws.readyState = 3
    ws.closedWith = { code, reason }
    ws.handlers.close?.()
  }
  ws.command = (obj) => ws.handlers.message(Buffer.from(JSON.stringify(obj)), false)
  return ws
}
const url = (id) => new URL(`ws://x/playback?nvr=${id}&ch=0&start=${Date.now() - 3_600_000}`)
const types = (ws) => ws.sent.map((m) => m.type).join()
const until = async (pred, ms) => {
  const t = Date.now()
  while (!pred() && Date.now() - t < ms) await sleep(50)
  return pred()
}

// (M1) the open is slow (its SetPlayDataCallBack waits 1.5 s in the NVR's lane)
{
  const nvr = fakeNvr('pb-slow', [true, 77], { job: 2, ms: 1500 })
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-slow'))
  await sleep(1200)
  check('M1: while the open waits in the NVR lane (500 ms ticks go by), nothing is decided', ws.sent.length === 0 && ws.closedWith === null, types(ws))
  await until(() => ws.sent.some((m) => m.type === 'started'), 3000)
  const startedAt = Date.now()
  await sleep(3000)
  check('... started, and 3 s of playing without a frame: still waiting', ws.closedWith === null && !ws.sent.some((m) => m.type === 'stream'), types(ws))
  await until(() => ws.sent.some((m) => m.type === 'stream'), 3000)
  check('... 4 s of playing, no SD frame: over to main ({type:"stream", stream:0})', ws.sent.some((m) => m.type === 'stream' && m.stream === 0) && Date.now() - startedAt >= 3500, types(ws))
  check('... not marked HD-only: no main frame has come (a switch alone proves nothing)', !marked('pb-slow', 0))
  ws.close(1000)
}

// (M2) opened paused (the camera wall opens its tiles paused), played 5 s later
{
  const nvr = fakeNvr('pb-paused', [true, 78])
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-paused'))
  ws.command({ pause: true })
  await until(() => ws.sent.some((m) => m.type === 'started'), 3000)
  await sleep(5000)
  check('M2: paused from the start, 5 s: nothing decided (a paused NVR sends no frames)', ws.closedWith === null && !ws.sent.some((m) => m.type === 'stream'), types(ws))
  ws.command({ pause: false })
  await sleep(3000)
  check('... played: 3 s later still waiting (the count started again at play)', !ws.sent.some((m) => m.type === 'stream'))
  await until(() => ws.sent.some((m) => m.type === 'stream'), 3000)
  check('... then over to main, after 4 s of playing', ws.sent.some((m) => m.type === 'stream'))
  ws.close(1000)
}

// a camera the NVR is known to record in HD only (marked through the store, with its time)
{
  const nvr = fakeNvr('pb-known', [true, 81])
  nvr.playback.markHdOnly(0)
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-known'))
  check('known HD-only: main at once, and said ({type:"stream"})', ws.sent[0]?.type === 'stream' && ws.sent[0].stream === 0 && marked('pb-known', 0))
  ws.close(1000)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 6: Run it on the server copy to see it fail**

Appendix A (b) then (c): `bash /tmp/stream-rights-test/run-tests.sh cctv/test/playback-hd-switch.test.mjs`
Expected: `rc=1 fails=…` with `FAIL  M1: while the open waits in the NVR lane …` (today the first 500 ms tick switches at once).

- [ ] **Step 7: Change `cctv/playback.mjs`**

(a) After line 46 (`import { lastHang } from './watchdog.mjs'`, the last import) add:
```js
import { SdWait, hdOnlyStore } from './hd-only.mjs'
```
and delete line 67 (`const SD_FALLBACK_MS = 4000 …`): the limit is hd-only.mjs's, inside `SdWait`.

(b) Replace lines 419-446 — from `// channels found to record no SD stream: skip the SD attempt next time (kept across restarts)` through the end of `markHdOnly` (`  }` after `saveHdOnly()`). Line 418, `const sessions = new Set()`, stays. The replacement:
```js
  // channels found to record no SD stream: asked for main at once next time (hd-only.mjs: marked only
  // once main frames came after a switch, cleared by an SD frame, trusted for a week; kept across restarts)
  const hdOnly = hdOnlyStore({ file: join(DATA_DIR, 'hd-only.json'), nvrId: nvr.id })
```

(c) In the `PlaybackSession` constructor, after `this.openedAt = 0` (line 472) add:
```js
      this.sdWait = new SdWait() // no SD frame in 4 s of the NVR really playing: HD only (hd-only.mjs)
      this.markOnFrames = false // switched to main: marked HD-only when its first frame comes
```

(d) In `#onFrame`, replace `this.gotFrames = true` (line 583) with:
```js
      if (!this.gotFrames) {
        // the first frame: an SD one proves the camera is not HD only (a mark from a slow NVR heals);
        // the first main one after a switch is the proof that it is, and only now is it marked
        if (!this.mainStream) hdOnly.unmark(this.ch)
        else if (this.markOnFrames) {
          this.markOnFrames = false
          hdOnly.mark(this.ch)
        }
      }
      this.gotFrames = true
```

(e) In `#updateNvr`, replace `if (run) this.lastFrameAt = Date.now()` (line 669) with:
```js
      if (run) {
        this.lastFrameAt = Date.now()
        // playing again before any frame came (opened paused, then played): the 4 s for an SD
        // picture start again, rather than having run out while nothing could come
        if (!this.gotFrames) this.sdWait.restart()
      }
```

(f) In `#watch`, replace the first `if` (lines 705-707, `if (!this.gotFrames && !this.mainStream && !this.paused && Date.now() - this.openedAt > SD_FALLBACK_MS) {` … `}`) with:
```js
      // no SD frame after 4 s of the NVR really playing this session (hd-only.mjs SdWait: not before it
      // has started, not while it is paused): this camera records HD only
      const running = this.openedAt > 0 && this.nvrRunning && !this.paused
      if (!this.gotFrames && !this.mainStream && this.sdWait.tick(Date.now(), running)) return this.#switchToMain()
```

(g) In `#switchToMain`, after `this.mainStream = true` (line 727) add:
```js
      // marked HD-only once main frames have come (#onFrame): a switch alone proves nothing
      this.markOnFrames = true
      this.sdWait.restart()
```
and delete the line `markHdOnly(this.ch)` (line 737).

(h) In the object `createPlayback` returns, replace `isHdOnly: (ch) => hdOnly.has(ch),` and `markHdOnly` (lines 813-814) with:
```js
    isHdOnly: (ch) => hdOnly.has(ch),
    markHdOnly: (ch) => hdOnly.mark(ch)
```
(`connect` is unchanged here: it still reads `stream` from the URL, and `hdOnly.has(ch)` is the store's.)

- [ ] **Step 8: Run the tests**

Windows: `node cctv/test/hd-only.test.mjs` (`all passed`), `node --check cctv/playback.mjs` (no output), `node cctv/test/rec-fallback.test.mjs` (only the two known "16x during a leg" FAILs, one `SKIP`), `node cctv/test/rec-playback.test.mjs` (`all passed`, one `SKIP`).
Server copy (Appendix A b, c): `bash /tmp/stream-rights-test/run-tests.sh cctv/test/playback-hd-switch.test.mjs cctv/test/playback-busy.test.mjs cctv/test/playback-search.test.mjs cctv/test/playback-dates.test.mjs cctv/test/rec-fallback.test.mjs` — expected five `rc=0 fails=0` lines.

- [ ] **Step 9: Commit**

```bash
git add cctv/hd-only.mjs cctv/test/hd-only.test.mjs cctv/test/playback-hd-switch.test.mjs cctv/playback.mjs
git commit -m "HD-only NVR cameras: the 4 s count only while the NVR plays, restarted on play, marked after main frames, healed by SD, old marks and week-old marks tried in SD again" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---


### Task 5: NVR playback rights — one stream decision, main only with Live HD or Playback HD (asked each time, from the session as it is then), tracking by what plays

Line numbers below are at 119c43e. Task 4 changed `playback.mjs`, Task 3 `server.mjs` and Tasks 2-3 `access-watch.test.mjs` above the places named: find each place by the text quoted.

**Files:**
- Modify: `cctv/rec-playback.mjs` (header :3-11, imports :99, :183-272, after :391, :730-731)
- Modify: `cctv/playback.mjs` (header :14-19, the imports (Task 4's hd-only line), after the `hdOnly` store (Task 4), the `PlaybackSession` constructor `:449`, `#watch` (Task 4's first `if`), after `#watch`, `#switchToMain` (Task 4's), `connect` `:782-794`)
- Modify: `cctv/hd-only.mjs` (append `SD_REFUSE_MS`, `noSdAction`)
- Modify: `cctv/rec-fallback.mjs:249-252` (the leg's `connect` call)
- Modify: `cctv/server.mjs:114` and `:124` (imports) and `:981-994` (`/playback`)
- Test: `cctv/test/rec-playback.test.mjs`, `cctv/test/access-watch.test.mjs:203` (the pin), `cctv/test/hd-only.test.mjs` (Windows); `cctv/test/playback-hd-switch.test.mjs` (replaced), `cctv/test/playback-busy.test.mjs:75`, `cctv/test/playback-search.test.mjs:274` (server copy)

**Interfaces:**
- Consumes: `mayHd`, `canPlayNvr`, `canPlayServer` (Task 1a); `streamParam`, `MAIN`, `HD_NOT_ALLOWED`, `HD_ASK_MESSAGE`, `HD_ONLY_MESSAGE` (Task 2); any-of needs and `sweepSoon` in the watch (Task 2); `SdWait`, `hdOnlyStore`, `SD_FALLBACK_MS` and Task 4's `#watch`/`#switchToMain` (Task 4).
- Produces:
  ```
  // cctv/rec-playback.mjs
  export const NVR_MAIN_ACTIONS = ['playback-nvr', ['live-hd', 'playback-server']]   // frozen
  export function connectPlayback({ nvr, ws, url, who, index, allowed?, allowedNvr?, allowedMain? = mayHd,
    legs?, remote?, onMain? = () => {}, opts? })
    -> ServerPlayback | { source: 'nvr', main: boolean, actions: Array } | null
  //   allowMain handed to the NVR asks allowedMain again on every call (never an answer kept from the open)
  ServerPlayback#actions (getter): ['playback-server'] | ['playback-server', 'playback-nvr']
  // cctv/playback.mjs (createPlayback(nvr).connect)
  connect(ws, url, { main: boolean, allowMain?: () => boolean = () => false, onMain?: () => void }) -> { main: boolean } | null
  // cctv/hd-only.mjs
  export const SD_REFUSE_MS = 6000
  export function noSdAction({ waitedMs, mayMain }): null | 'switch' | 'refuse'
  // cctv/server.mjs /playback: allowedMain reads the session each call (currentUser(req)); onMain re-tracks and sweeps at once
  ```

- [ ] **Step 1: Update `cctv/test/rec-playback.test.mjs`**

(a) Line 10 import gains `readFileSync`:
```js
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
```
(b) Lines 17-24 (accounts and rights) gain `nvhd`, who may play n1/0 from the NVR and watch it live (the upgrade gives Live HD = Live):
```js
// real rights for the source checks (rights.mjs reads DATA_DIR when first imported): srv may play
// n1/0 back from the server only, nv from the NVR only, both from either; nvhd from the NVR, and may
// watch it live (the version 1 file is upgraded: Live HD wherever Live is, so the NVR's main stream too)
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ srv: { hash: 'x', role: 'viewer' }, nv: { hash: 'x', role: 'viewer' }, both: { hash: 'x', role: 'viewer' }, nvhd: { hash: 'x', role: 'viewer' } }))
writeFileSync(join(process.env.DATA_DIR, 'rights.json'), JSON.stringify({ version: 1, users: {
  srv: { grants: { 'playback-server': ['n1/0'] } },
  nv: { grants: { 'playback-nvr': ['n1/0'] } },
  both: { grants: { 'playback-server': ['n1/0'], 'playback-nvr': ['n1/0'] } },
  nvhd: { grants: { 'playback-nvr': ['n1/0'], live: ['n1/0'] } }
} }))
```
(c) Line 202, the fake NVR's `connect` records what it is told and answers like playback.mjs:
```js
    connect: (ws, url, o) => {
      nvr.connects.push({ ws, url, o })
      return { main: o?.main === true }
    },
```
(d) In the "no src=auto" block, line 316 asks for the sub-stream (the default `stream` of `open` is 0, the main stream):
```js
    const { ws, url } = open(0, T0 + 1000, { nvr, index, who, src: null, stream: 1 })
```
and line 318's check gains `&& nvr.connects[0].o.main === false` before `&& ws.texts.length === 0`.
(e) Replace the "src=auto but not eligible (R15)" cases (lines 367-378) with:
```js
  const cases = [
    ['no index (flag off)', { index: null }],
    ['a camera without recordings', { ch: 9 }]
  ]
  for (const [label, o] of cases) {
    const nvr = fakeNvr()
    const { ws } = open(o.ch ?? 0, T0 + 1000, { nvr, ...o })
    await sleep(30)
    check(`src=auto, ${label}: error + close 1011, no NVR session`, ws.texts.length === 1 && ws.texts[0].type === 'error' && ws.texts[0].message === MSG && ws.closedWith === 1011 && nvr.connects.length === 0 && ws.bins.length === 0, J(ws.texts) + ` ${ws.closedWith}`)
  }
  // a rights refusal is 1008 "not allowed" like every other, with its own words (it was 1011 "not available")
  const refused = [
    ['a non-admin', { who: { user: 'v', admin: false } }],
    ['a viewer allowed NVR playback only', { who: { user: 'nv', admin: false } }],
    ['refused by the access hook', { allowed: () => false }]
  ]
  for (const [label, o] of refused) {
    const nvr = fakeNvr()
    const { ws } = open(0, T0 + 1000, { nvr, ...o })
    await sleep(30)
    check(`src=auto, ${label}: {type:"error"} then 1008 "not allowed", no NVR session`, ws.texts.length === 1 && ws.texts[0].type === 'error' && /may not play back this camera/.test(ws.texts[0].message) && ws.closedWith === 1008 && ws.closeReason === 'not allowed' && nvr.connects.length === 0 && ws.bins.length === 0, J(ws.texts) + ` ${ws.closedWith} ${ws.closeReason}`)
  }
  const looseStream = open(0, T0 + 1000, { extra: '&stream=0.0' })
  check('src=auto with a second, loose stream parameter: the first counts (0), the session runs', looseStream.session !== null)
  looseStream.ws.close(1000)
  const badStream = rp.connectPlayback({ nvr: fakeNvr(), ws: fakeWs(), url: new URL(`ws://x/playback?nvr=n1&ch=0&stream=0.0&start=${T0}&src=auto`), who: ADMIN, index: IDX, legs: null })
  check('src=auto, stream=0.0: bad parameters (stream-param.mjs)', badStream === null)
```
(f) Insert a new block right after the "no src=auto" block (after line 362's closing brace):
```js
// ---- the NVR's main stream: Playback SD and Live HD or Playback HD (stream rights) ------------------
{
  const NV = { user: 'nv', admin: false }
  const NVHD = { user: 'nvhd', admin: false }
  const BOTH = { user: 'both', admin: false }
  const nvrUrl = (q) => new URL(`ws://x/playback?nvr=n1&ch=0&start=${T0 + 1000}${q}`)
  const connect = (who, q, more = {}) => {
    const nvr = fakeNvr()
    const ws = fakeWs()
    const s = rp.connectPlayback({ nvr, ws, url: nvrUrl(q), who, index: IDX, legs: null, ...more })
    return { nvr, ws, s }
  }
  {
    const { nvr, ws, s } = connect(NV, '&stream=0')
    check('NVR main with Playback SD only: {type:"error"} then 1008 "hd not allowed", no NVR session', s === null && ws.texts.length === 1 && ws.texts[0].type === 'error' && /Playback HD or Live HD/.test(ws.texts[0].message) && ws.closedWith === 1008 && ws.closeReason === 'hd not allowed' && nvr.connects.length === 0, `${J(ws.texts)} ${ws.closedWith} ${ws.closeReason}`)
  }
  const loose = ['', '%20', '0.0', '0x0', '0b0', '0o0', '0e5', '-0', '%2B0', '%0A0', '%200', '2'].filter((raw) => {
    const { nvr, ws, s } = connect(NV, `&stream=${raw}`)
    return !(s === null && ws.closedWith === 1008 && ws.closeReason === 'bad parameters' && nvr.connects.length === 0)
  })
  check('NVR playback: every stream value Number() read as 0 (and any other) is "bad parameters", never a session', loose.length === 0, loose.join(' '))
  {
    const { nvr, ws, s } = connect(NV, '&stream=1')
    const o = nvr.connects[0]?.o
    check('NVR sub with Playback SD only: the session is asked for the sub-stream, and may not go over to main', o?.main === false && o.allowMain() === false && typeof o.onMain === 'function' && ws.closedWith === 0 && s?.source === 'nvr' && s.main === false && J(s.actions) === J(['playback-nvr']), J(s))
    const bare = connect(NV, '')
    check('... no stream parameter at all is the sub-stream', bare.nvr.connects[0]?.o.main === false)
    const dup = connect(NV, '&stream=1&stream=0')
    check('... of two stream parameters the first counts', dup.nvr.connects[0]?.o.main === false)
  }
  {
    const { nvr, ws, s } = connect(NVHD, '&stream=0')
    check('NVR main with Playback SD and Live HD: the main stream, watched for the main-stream rights', nvr.connects[0]?.o.main === true && nvr.connects[0].o.allowMain() === true && s?.main === true && J(s.actions) === J(['playback-nvr', ['live-hd', 'playback-server']]) && ws.closedWith === 0, J(s))
    check('... with Playback SD and Playback HD too', connect(BOTH, '&stream=0').s?.main === true)
    check('... a main-stream check that throws is a no', connect(NVHD, '&stream=0', { allowedMain: () => { throw new Error('x') } }).s === null)
    let ok = true
    const flip = connect(NVHD, '&stream=1', { allowedMain: () => ok }).nvr.connects[0].o
    const first = flip.allowMain()
    ok = false
    check('... allowMain asks the hook every time, never an answer kept from the open (server.mjs\'s reads the session then)', first === true && flip.allowMain() === false)
    check('NVR_MAIN_ACTIONS is that list', J(rp.NVR_MAIN_ACTIONS) === J(['playback-nvr', ['live-hd', 'playback-server']]))
  }
  {
    // the session going over to main by itself (a camera the NVR keeps only in HD): the server's
    // re-track hook runs and the switch is audited
    let told = 0
    const { nvr } = connect(NVHD, '&stream=1', { onMain: () => told++ })
    nvr.connects[0].o.onMain()
    const rows = readFileSync(join(process.env.DATA_DIR, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.action === 'playback-view' && r.user === 'nvhd')
    check('onMain: the server\'s hook runs, and the switch is audited', told === 1 && /^nvr main \(switched: no SD recording\) playback from /.test(rows.at(-1)?.detail ?? ''), rows.at(-1)?.detail)
    check('... and the opening said sub', rows.some((r) => /^nvr sub playback from /.test(r.detail)))
  }
  {
    // playback.mjs refusing (bad parameters)
    const nvr = fakeNvr()
    nvr.playback.connect = () => null
    const s = rp.connectPlayback({ nvr, ws: fakeWs(), url: nvrUrl('&stream=1'), who: NV, index: IDX, legs: null })
    check('the NVR side refusing: nothing to track (null)', s === null)
  }
  const asSrv = open(0, T0 + 1000, { who: { user: 'srv', admin: false } })
  const asBoth = open(0, T0 + 1000, { who: BOTH, legs: { coverage: () => ({ ranges: [] }), start() { throw new Error('not in this test') } } })
  check('server playback: watched for Playback HD; with NVR legs, Playback SD too', J(asSrv.session.actions) === J(['playback-server']) && J(asBoth.session.actions) === J(['playback-server', 'playback-nvr']))
  asSrv.ws.close(1000)
  asBoth.ws.close(1000)
}
```

- [ ] **Step 2: Update the pin in `cctv/test/access-watch.test.mjs` (line 203)**

Replace the check `'server.mjs: a /playback socket is tracked with the rights of what it plays'` (line 203) with:
```js
  check('server.mjs: a /playback socket is watched for what connectPlayback decided', /connectPlayback\(\{[^}]*allowedMain, onMain \}\)[\s\S]{0,400}if \(session\) watch\.track\(ws, req, \{ actions: session\.actions, nvr: nvr\.id, ch: target\.ch \}\)/.test(pb.slice(0, 3000)))
  check('server.mjs: an NVR session going over to main is watched for the main-stream rights, and asked at once (a sweep)', /const onMain = \(\) => \{\s*watch\.track\(ws, req, \{ actions: NVR_MAIN_ACTIONS, nvr: nvr\.id, ch: target\.ch \}\)\s*watch\.sweepSoon\(\)\s*\}/.test(pb.slice(0, 3000)))
  check('server.mjs: "may see main" is asked from the session as it is then, not the upgrade\'s who (a demoted admin)', /const allowedMain = \(_who, nvrId, ch\) => \{\s*const u = currentUser\(req\)\s*return Boolean\(u\) && mayHd\(\{ user: u, admin: AUTH_OFF \|\| auth\.isAdmin\(u\) \}, nvrId, ch\)\s*\}/.test(pb.slice(0, 3000)))
```

- [ ] **Step 3: Add the gate's checks to `cctv/test/hd-only.test.mjs`**

Its import becomes:
```js
import { HD_ONLY_RETEST_MS, SD_FALLBACK_MS, SD_REFUSE_MS, SdWait, hdOnlyStore, noSdAction } from '../hd-only.mjs'
```
and insert just before its final `console.log(failures ? …)`:
```js
// ---- no SD frame, for a viewer who may or may not see main (stream rights) --------------------------------
{
  check('SD_REFUSE_MS: longer than the switch, shorter than the "end of recording" notice (IDLE_END_MS, 8 s)', SD_REFUSE_MS === 6000 && SD_REFUSE_MS > SD_FALLBACK_MS && SD_REFUSE_MS < 8000)
  check('noSdAction: wait on under 4 s of playing, whoever it is', noSdAction({ waitedMs: 3999, mayMain: true }) === null && noSdAction({ waitedMs: 3999, mayMain: false }) === null)
  check('... then over to main for a viewer who may see main', noSdAction({ waitedMs: 4000, mayMain: true }) === 'switch')
  check('... anyone else waits longer (nothing to switch to), then is refused', noSdAction({ waitedMs: 5999, mayMain: false }) === null && noSdAction({ waitedMs: 6000, mayMain: false }) === 'refuse')
  const src = readFileSync(new URL('../playback.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const body = (head) => src.slice(src.indexOf(head), src.indexOf('\n    }\n', src.indexOf(head)))
  check('playback.mjs #watch: noSdAction decides, with the right asked now', /this\.sdWait\.tick\(Date\.now\(\), running\)\) \{\n\s*const act = noSdAction\(\{ waitedMs: this\.sdWait\.ms, mayMain: askMain\(this\.allowMain\) \}\)\n\s*if \(act === 'switch'\) return this\.#switchToMain\(\)\n\s*if \(act === 'refuse'\) return this\.#refuseHd\(\)/.test(src))
  const sw = body('async #switchToMain() {')
  const asked = sw.indexOf('if (!askMain(this.allowMain)) {')
  check('playback.mjs #switchToMain: asked again once the SD playback has stopped, before main is said, watched or opened', asked > sw.indexOf('StopPlayBack') && asked < sw.indexOf('this.onMain()') && asked < sw.indexOf("type: 'stream'") && asked < sw.indexOf('this.#open()') && /if \(!askMain\(this\.allowMain\)\) \{\n\s*this\.#refuseHd\(\)\n\s*return this\.#unregister\(\)/.test(sw))
  check('playback.mjs connect: a camera marked HD only goes to main at once only for a viewer who may see main (anyone else is tried in SD)', /const asMain = main \|\| \(hdOnly\.has\(ch\) && askMain\(allowMain\)\)/.test(src))
  check('playback.mjs: the stream is never read from the URL (the caller decides)', !/searchParams\.get\('stream'\)/.test(src))
}
```

- [ ] **Step 4: Replace the server-copy test `cctv/test/playback-hd-switch.test.mjs` (the gate's cases)**

The whole file becomes:
```js
// The NVR playback session's switch to the main stream (playback.mjs PlaybackSession, hd-only.mjs):
// a camera the NVR records in HD only is found by "no SD frame in 4 s of the NVR playing", and only a
// viewer who may see main is switched, asked then and again once the SD playback has stopped; anyone
// else is refused once no SD frame has come in 6 s of playing. The 4 s used to be counted from before
// the session had started (openedAt 0 until the NVR answered) and through a pause at open, so a slow
// NVR or the camera wall marked cameras HD-only for good. Fake NVRs whose lane answers each SDK job
// without running it (as playback-busy.test.mjs): nothing reaches an NVR, but playback.mjs loads
// koffi, so this runs on the server copy. (The fakes send no frames: an SD frame clearing a mark is
// checked in hd-only.test.mjs.)
//   node cctv/test/playback-hd-switch.test.mjs        (on the server copy)
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pb-hd-switch-'))
const pb = await import('../playback.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const HD_FILE = join(process.env.DATA_DIR, 'hd-only.json')
const marked = (id, ch) => existsSync(HD_FILE) && String(ch) in (JSON.parse(readFileSync(HD_FILE, 'utf8'))[id] ?? {})

/**
 * A fake NVR. Its lane answers each job in turn from `answers` (then true) without running it: the
 * clock read, PlayBackByTimeEx (a handle), SetPlayDataCallBack, then stops and controls. `slow` holds
 * the answer to job number `slow.job` for `slow.ms` (a tile waiting behind others in the NVR's lane).
 */
const fakeNvr = (id, answers, slow = null) => {
  let n = 0
  const nvr = {
    id, name: `NVR ${id}`, userId: 7, online: true, degraded: false, jobs: 0,
    lane: {
      run: async () => {
        const k = n++
        nvr.jobs++
        if (slow && k === slow.job) await sleep(slow.ms)
        return k < answers.length ? answers[k] : true
      }
    },
    sessions: { acquire: async () => ({ userId: 9, release() {} }) }
  }
  nvr.playback = pb.createPlayback(nvr)
  return nvr
}
/** A fake browser WebSocket for /playback: the JSON it is sent, and how it was closed. */
const fakeWs = () => {
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [], closedWith: null, handlers: {} }
  ws.send = (m) => typeof m === 'string' && ws.sent.push(JSON.parse(m))
  ws.on = (event, fn) => (ws.handlers[event] = fn)
  ws.close = (code, reason) => {
    if (ws.readyState !== 1) return
    ws.readyState = 3
    ws.closedWith = { code, reason }
    ws.handlers.close?.()
  }
  ws.command = (obj) => ws.handlers.message(Buffer.from(JSON.stringify(obj)), false)
  return ws
}
const url = (id) => new URL(`ws://x/playback?nvr=${id}&ch=0&start=${Date.now() - 3_600_000}`)
const types = (ws) => ws.sent.map((m) => m.type).join()
const until = async (pred, ms) => {
  const t = Date.now()
  while (!pred() && Date.now() - t < ms) await sleep(50)
  return pred()
}

// (M1) the open is slow (its SetPlayDataCallBack waits 1.5 s in the NVR's lane); no right to see main
{
  let asked = 0
  const nvr = fakeNvr('pb-slow', [true, 77], { job: 2, ms: 1500 })
  const ws = fakeWs()
  const r = nvr.playback.connect(ws, url('pb-slow'), { main: false, allowMain: () => { asked++; return false } })
  check('connect: the sub-stream, as asked', r?.main === false)
  await sleep(1200)
  check('M1: while the open waits in the NVR lane (500 ms ticks go by), nothing is decided, nobody asked', ws.sent.length === 0 && ws.closedWith === null && asked === 0, types(ws))
  await until(() => ws.sent.some((m) => m.type === 'started'), 3000)
  const startedAt = Date.now()
  await sleep(5000)
  check('... started, 5 s of playing without a frame: still waiting (nothing to switch to: SD_REFUSE_MS is 6 s)', ws.closedWith === null && !ws.sent.some((m) => m.type === 'stream'), types(ws))
  await until(() => ws.closedWith !== null, 3000)
  check('... 6 s of playing, no SD frame, no right to see main: {type:"error"}, then 1008 "hd not allowed"', ws.closedWith?.code === 1008 && ws.closedWith.reason === 'hd not allowed' && ws.sent.at(-1)?.type === 'error' && /No SD recording/.test(ws.sent.at(-1).message) && asked >= 1 && Date.now() - startedAt >= 5500, `${JSON.stringify(ws.closedWith)} ${types(ws)}`)
  check('... never switched to main, and the camera not marked HD-only', !ws.sent.some((m) => m.type === 'stream') && !marked('pb-slow', 0))
}

// (M2) opened paused (the camera wall opens its tiles paused), played 5 s later
{
  let asked = 0
  const nvr = fakeNvr('pb-paused', [true, 78])
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-paused'), { main: false, allowMain: () => { asked++; return false } })
  ws.command({ pause: true })
  await until(() => ws.sent.some((m) => m.type === 'started'), 3000)
  await sleep(5000)
  check('M2: paused from the start, 5 s: nothing decided (a paused NVR sends no frames)', ws.closedWith === null && asked === 0, types(ws))
  ws.command({ pause: false })
  await sleep(5000)
  check('... played: 5 s later still waiting (the count started again at play)', ws.closedWith === null)
  await until(() => ws.closedWith !== null, 3000)
  check('... then refused as above, after 6 s of playing', ws.closedWith?.reason === 'hd not allowed' && asked >= 1)
}

// a viewer who may see main: switched, told, watched for it (onMain); marked only once main frames come
{
  let asked = 0
  let told = 0
  const nvr = fakeNvr('pb-hd', [true, 79, true, true, true, 80, true])
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-hd'), { main: false, allowMain: () => { asked++; return true }, onMain: () => told++ })
  await until(() => ws.sent.some((m) => m.type === 'stream'), 8000)
  check('allowed: no SD in 4 s of playing, so over to main: {type:"stream", stream:0}', ws.sent.some((m) => m.type === 'stream' && m.stream === 0) && ws.closedWith === null, types(ws))
  check('... asked when the 4 s ran out, and again once the SD playback had stopped', asked === 2, String(asked))
  check('... the caller is told (the server watches it for the main-stream rights at once, and audits it)', told === 1)
  check('... not marked HD-only yet: no main frame has come (a slow NVR is no proof)', !marked('pb-hd', 0))
  ws.close(1000)
}

// allowed when the 4 s ran out, the right gone while the NVR stopped the SD playback: refused, never main
{
  let asked = 0
  let told = 0
  const nvr = fakeNvr('pb-gone', [true, 82])
  const ws = fakeWs()
  nvr.playback.connect(ws, url('pb-gone'), { main: false, allowMain: () => ++asked === 1, onMain: () => told++ })
  await until(() => ws.closedWith !== null, 8000)
  check('the right taken away during the switch: {type:"error"}, 1008 "hd not allowed", no {type:"stream"}, nothing watched for main', ws.closedWith?.reason === 'hd not allowed' && ws.sent.at(-1)?.type === 'error' && !ws.sent.some((m) => m.type === 'stream') && asked === 2 && told === 0, `${JSON.stringify(ws.closedWith)} ${types(ws)} asked ${asked}`)
}

// a camera the NVR is known to record in HD only
{
  const nvr = fakeNvr('pb-known', [true, 81])
  nvr.playback.markHdOnly(0)
  const ok = fakeWs()
  const r = nvr.playback.connect(ok, url('pb-known'), { main: false, allowMain: () => true })
  check('known HD-only, a viewer who may see main: main at once, and said ({type:"stream"})', r?.main === true && ok.sent[0]?.type === 'stream')
  ok.close(1000)
  const bad = fakeWs()
  check('connect without a decision (no main flag) is refused "bad parameters"', nvr.playback.connect(bad, url('pb-known')) === null && bad.closedWith?.reason === 'bad parameters')
}
{
  const nvr = fakeNvr('pb-known-sd', [true, 83])
  nvr.playback.markHdOnly(0)
  const ws = fakeWs()
  const r = nvr.playback.connect(ws, url('pb-known-sd'), { main: false, allowMain: () => false })
  check('known HD-only, no right to see main: tried in SD all the same (a mark can be wrong; an SD frame clears it)', r?.main === false && ws.closedWith === null && !ws.sent.some((m) => m.type === 'stream'), types(ws))
  await until(() => ws.closedWith !== null, 12_000)
  check('... no SD frame in 6 s of playing: refused with words, 1008 "hd not allowed"; the mark stays', ws.closedWith?.reason === 'hd not allowed' && ws.sent.at(-1)?.type === 'error' && nvr.playback.isHdOnly(0), `${JSON.stringify(ws.closedWith)} ${types(ws)}`)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 5: Run to see them fail**

Run: `node cctv/test/rec-playback.test.mjs` — expected: the run stops in the "no src=auto" block with `TypeError: Cannot read properties of undefined (reading 'main')` (the fake NVR is not handed `{ main, … }` yet).
Run: `node cctv/test/access-watch.test.mjs` — expected FAIL on the three `/playback` pins.
Run: `node cctv/test/hd-only.test.mjs` — expected `SyntaxError: The requested module '../hd-only.mjs' does not provide an export named 'SD_REFUSE_MS'`.

- [ ] **Step 6: `cctv/hd-only.mjs`: append the decision for a viewer who may not see main**

At the end of the file add:
```js
// ---- a viewer who may not see main (stream rights) ----------------------------------------------------

/**
 * How long a session that asked for SD waits for an SD frame when its viewer may not see main: longer
 * than the switch (there is nothing to switch to, and a busy NVR can be slow with the first frame),
 * shorter than playback.mjs's IDLE_END_MS (8 s), which would tell the page the recording had ended.
 */
export const SD_REFUSE_MS = 6000

/**
 * What a session that asked for SD does while no SD frame has come (playback.mjs #watch).
 * @param {{ waitedMs: number, mayMain: boolean }} o waitedMs: SdWait.ms, the NVR's playing time so
 *   far; mayMain: this viewer may see main pictures of the camera, asked now
 * @returns {null|'switch'|'refuse'} null: wait on; 'switch': over to main; 'refuse': end the session
 */
export function noSdAction({ waitedMs, mayMain }) {
  if (mayMain) return waitedMs >= SD_FALLBACK_MS ? 'switch' : null
  return waitedMs >= SD_REFUSE_MS ? 'refuse' : null
}
```

- [ ] **Step 7: `cctv/rec-playback.mjs`**

(a) Header lines 3-11 become:
```js
// connectPlayback() decides per socket where playback comes from, and at which quality:
//  - without src=auto: the NVR's own recordings (playback.mjs PlaybackSession, NVR clock), for a viewer
//    who may play them back (rights.mjs playback-nvr; anyone else is closed 1008 "not allowed":
//    playback-server alone never reaches the NVR). Its main stream (stream=0, or a camera the NVR
//    keeps only in HD) is full quality: it also needs Live HD or Playback HD on the camera (mayHd),
//    else {type:'error'} and 1008 "hd not allowed". The stream is read once here (stream-param.mjs)
//    and handed to playback.mjs, which no longer reads it from the URL.
//  - with src=auto: the server's recordings (a ServerPlayback), when CCTV_LIVE_WORKER=on (an index),
//    the viewer may (rights.mjs playback-server; else {type:'error'} and 1008 "not allowed") and the
//    camera has recordings (else {type:'error'} and 1011): never a silent NVR session in another time
//    base (R15). Server playback does not need the NVR: it runs while the NVR is offline (R14). Its
//    gaps are filled from the NVR (legs, below) only for a viewer who may also play the NVR back.
//  What it decided comes back with the rights to watch while it plays (server.mjs, access-watch.mjs).
```
(b) Line 99:
```js
import { canPlayNvr, canPlayServer, mayHd } from './rights.mjs'
import { HD_ASK_MESSAGE, HD_NOT_ALLOWED, MAIN, streamParam } from './stream-param.mjs'
```
(c) Replace lines 183-272 (the `note` doc comment through the end of `connectPlayback`) with:
```js
/**
 * One audit row per playback session opened: who looked at recorded footage, which camera, from
 * when, and whether it came off the server or the NVR, and from the NVR at which quality. Kept tiny
 * and wrapped in its own try even though audit() already swallows everything — nothing about
 * recording an event may ever be the reason somebody cannot watch a camera.
 */
const note = (who, nvr, ch, source, start) => {
  try {
    const n = Number(start)
    audit(DATA_DIR, {
      user: who?.user,
      action: 'playback-view',
      target: `${nvr?.id}/${ch}`,
      detail: `${source} playback from ${Number.isFinite(n) ? new Date(n).toISOString() : String(start)}`
    })
  } catch {}
}

/** What an NVR session on the main stream needs while it is open (access-watch.mjs): the NVR's
 * recordings, and a right to see main -- Live HD or Playback HD, either will do. */
export const NVR_MAIN_ACTIONS = Object.freeze(['playback-nvr', Object.freeze(['live-hd', 'playback-server'])])
const NVR_SUB_ACTIONS = Object.freeze(['playback-nvr'])
const SERVER_REFUSAL = 'You may not play back this camera from the server\'s recordings.'

/**
 * Handles a /playback WebSocket: server recordings (src=auto) or the NVR, see the top.
 * @param {{ nvr: object, ws: object, url: URL, who: {user?: string, admin?: boolean}|null,
 *           index: object|null, allowed?: Function, allowedNvr?: Function, allowedMain?: Function,
 *           legs?: object|null, remote?: boolean, onMain?: () => void, opts?: object }} args
 *   index: rec-index.mjs (null: CCTV_LIVE_WORKER off); allowed, allowedNvr, allowedMain: the access
 *   hooks for the server's recordings, the NVR's and a main-stream picture (rights.mjs canPlayServer,
 *   canPlayNvr, mayHd); remote: the viewer is remote (adaptive-live.mjs isRemoteAddress of the socket;
 *   see the top); onMain: an NVR session went over to the main stream by itself (server.mjs watches
 *   it for the main-stream rights from then on); opts: ServerPlayback options (tests)
 * @returns {ServerPlayback|{ source: 'nvr', main: boolean, actions: Array }|null} what it plays, each
 *   with `actions`, the rights it needs while open; null: refused (the socket is closing)
 */
export function connectPlayback({ nvr, ws, url, who, index, allowed = canPlayServer, allowedNvr = canPlayNvr, allowedMain = mayHd, legs = defaultLegs, remote = false, onMain = () => {}, opts = {} }) {
  const p = url.searchParams
  // a check that throws is a no
  const ask = (check, c) => {
    try {
      return Boolean(check(who, nvr.id, c))
    } catch {
      return false
    }
  }
  // The NVR's own recordings are playback-nvr's. server.mjs lets either playback right open the
  // socket, which can serve either source, so each source asks for its own right here: playback-server
  // alone never reaches the NVR, which may still hold days the server has already let go.
  const nvrAllowed = (c) => ask(allowedNvr, c)
  // One reading of `stream` for every decision below (stream-param.mjs): '', '0.0', '-0' and the like
  // were main to Number() while a check on the text would have called them SD.
  const stream = streamParam(p.get('stream'))
  if (p.get('src') !== 'auto') {
    const rawCh = p.get('ch') ?? ''
    if (!/^\d{1,3}$/.test(rawCh) || Number.isNaN(stream)) {
      ws.close(1008, 'bad parameters')
      return null
    }
    const ch = Number(rawCh)
    if (!nvrAllowed(ch)) {
      ws.close(1008, 'not allowed')
      return null
    }
    // The NVR's main stream is full quality: Playback SD and a right to see main (rights.mjs mayHd).
    // Asked again (allowMain) when the session wants to go over to main by itself (playback.mjs: a
    // camera the NVR records in HD only), so a right taken away meanwhile counts.
    const mayMain = () => ask(allowedMain, ch)
    const main = stream === MAIN
    if (main && !mayMain()) {
      sendJson(ws, { type: 'error', message: HD_ASK_MESSAGE })
      ws.close(1008, HD_NOT_ALLOWED)
      return null
    }
    if (!nvr.online) {
      ws.close(1013, 'NVR offline')
      return null
    }
    const start = p.get('start') ?? ''
    const opened = nvr.playback.connect(ws, url, {
      main,
      allowMain: mayMain,
      onMain: () => {
        note(who, nvr, ch, 'nvr main (switched: no SD recording)', start)
        onMain()
      }
    })
    // refused there (bad parameters): the socket is closing, nothing to watch
    if (!opened) return null
    // who looked at recorded footage, when, and at which quality: the row an investigation asks for.
    // audit() never throws, so it cannot break playback.
    note(who, nvr, ch, opened.main ? 'nvr main' : 'nvr sub', start)
    return { source: 'nvr', main: opened.main, actions: opened.main ? NVR_MAIN_ACTIONS : NVR_SUB_ACTIONS }
  }
  const rawCh = p.get('ch') ?? ''
  const rawStart = p.get('start') ?? ''
  const ch = Number(rawCh)
  const start = Number(rawStart)
  if (!/^\d{1,3}$/.test(rawCh) || Number.isNaN(stream) || rawStart === '' || !Number.isFinite(start)) {
    ws.close(1008, 'bad parameters')
    return null
  }
  // a viewer without the right is told so, and closed 1008 like every other refusal of a right (the
  // pages then stop and say why), not 1011 "not available here", which reads as a fault to retry
  if (!ask(allowed, ch)) {
    sendJson(ws, { type: 'error', message: SERVER_REFUSAL })
    ws.close(1008, 'not allowed')
    return null
  }
  let eligible = false
  try {
    eligible = Boolean(index) && index.first(nvr.id, ch) !== null
  } catch (e) {
    console.warn(`[${nvr.id}] server playback ch${ch + 1}: ${e.message}`)
  }
  if (!eligible) {
    sendJson(ws, { type: 'error', message: 'Server recordings are not available here; reload the page.' })
    ws.close(1011, 'server recordings not available')
    return null
  }
  note(who, nvr, ch, 'server', start)
  // The page tells us what it can decode (&h265=0 when canDecodeH265() said no). Nothing else may
  // switch the conversion on, so H.264 can never reach a client that did not ask for it.
  const clientH265 = clientCanDecodeH265(p)
  // gaps are filled from the NVR's recordings only for someone who may play those back; anyone else
  // has them jumped with a notice (#legsAllowed with no legs)
  // a remote viewer who chose "Original (server)": the recording itself, not the capped conversion
  const original = p.get('original') === '1'
  return new ServerPlayback({ ws, nvr, ch, start, stream, index, legs: nvrAllowed(ch) ? legs : null, clientH265, remote: Boolean(remote), original, ...opts })
}
```
(d) In `class ServerPlayback`, right after the constructor (after line 391) add:
```js
  /** The rights this session needs while it is open (access-watch.mjs): the server's recordings, and
   * the NVR's as well when its gaps are filled from there. */
  get actions() {
    return this.legs ? ['playback-server', 'playback-nvr'] : ['playback-server']
  }
```
(e) Lines 730-731 (the converter-full message: `message:` and the string on the line under it) become one line, offering "SD (NVR)" only to someone who may play it:
```js
          message: `This recording is H.265 and this browser cannot play it. The server can convert it, but it is already converting as many streams as it can. Try again in a few minutes${this.legs ? ', or choose "SD (NVR)"' : ''}.`
```

- [ ] **Step 8: `cctv/playback.mjs`: `connect` takes the decision; the switch asks the viewer's right, and asks again after the SD playback stopped**

(a) Header routes (lines 16-19): the WS line becomes
```js
//   WS  /playback?ch=N&start=T                  -> same binary frames as /live, plus JSON text messages
//        Which stream is decided by the caller (rec-playback.mjs connectPlayback, rec-fallback.mjs):
//        connect(ws, url, { main, allowMain, onMain }); the URL's stream parameter is not read here.
```
and after the `{"type":"stream","stream":0}` line add:
```js
//        A camera found to record no SD goes over to main only for a viewer who may see main
//        (allowMain, asked then); anyone else gets {"type":"error"} and a 1008 "hd not allowed"
//        close once no SD frame has come in 6 s of playing (hd-only.mjs noSdAction).
```

(b) Task 4's import line becomes the first, and the stream-param import follows it:
```js
import { SdWait, hdOnlyStore, noSdAction } from './hd-only.mjs'
import { HD_NOT_ALLOWED, HD_ONLY_MESSAGE } from './stream-param.mjs'
```

(c) After the `hdOnly` store line (Task 4: `const hdOnly = hdOnlyStore({ … })`) add:
```js
  // a viewer's "may see main" hook, asked now (rec-playback.mjs hands in one that reads the session as
  // it is then); one that throws is a no
  const askMain = (allowMain) => {
    try {
      return allowMain() === true
    } catch {
      return false
    }
  }
```

(d) The `PlaybackSession` constructor (line 449) and its first lines:
```js
    /**
     * @param {{ allowMain?: () => boolean, onMain?: () => void }} [rights] allowMain: may this viewer
     *   see main pictures (asked when no SD comes); onMain: told when the session goes over to main
     */
    constructor(ws, ch, mainStream, start, clientH265 = true, { allowMain = () => false, onMain = () => {} } = {}) {
      this.ws = ws
      this.allowMain = allowMain
      this.onMain = onMain
```

(e) In `#watch`, replace Task 4's comment and `if` (from `// no SD frame after 4 s of the NVR really playing this session` through `… running)) return this.#switchToMain()`) with:
```js
      // no SD frame yet, counted only while the NVR really plays this session (hd-only.mjs SdWait: not
      // before it has started, not while it is paused): after SD_FALLBACK_MS over to main for a viewer
      // who may see main, asked now; anyone else is refused after SD_REFUSE_MS (noSdAction)
      const running = this.openedAt > 0 && this.nvrRunning && !this.paused
      if (!this.gotFrames && !this.mainStream && this.sdWait.tick(Date.now(), running)) {
        const act = noSdAction({ waitedMs: this.sdWait.ms, mayMain: askMain(this.allowMain) })
        if (act === 'switch') return this.#switchToMain()
        if (act === 'refuse') return this.#refuseHd()
      }
```
and after `#watch` add:
```js
    /** No SD frame came, and this viewer may not see main: said, and the session ends. */
    #refuseHd() {
      console.log(`[${nvr.id}] playback ch${this.ch + 1}: no SD recording came, and main is not allowed for this viewer`)
      this.send({ type: 'error', message: HD_ONLY_MESSAGE })
      this.close()
      this.ws.close(1008, HD_NOT_ALLOWED)
    }
```

(f) In `#switchToMain`, after `if (this.closed) return this.#unregister()` add:
```js
      // asked again now: the right may have gone while the NVR stopped the SD playback, and the sweep
      // then still saw this socket on the sub-stream (which needs Playback SD alone)
      if (!askMain(this.allowMain)) {
        this.#refuseHd()
        return this.#unregister() // (the SD playback is stopped already: only its login is left)
      }
```
and replace `this.send({ type: 'stream', stream: 0 })` with:
```js
      // watched for the main-stream rights from now on, and audited (rec-playback.mjs, server.mjs)
      try {
        this.onMain()
      } catch (e) {
        console.warn(`[${nvr.id}] playback ch${this.ch + 1}: ${e.message}`)
      }
      this.send({ type: 'stream', stream: 0 })
```

(g) Replace `connect` (lines 782-794, from `/** Handles a /playback WebSocket. */` to its closing `}`) with:
```js
  /**
   * Handles a /playback WebSocket for the NVR's recordings. Which stream was decided by the caller
   * (rec-playback.mjs connectPlayback for a viewer, rec-fallback.mjs for legs and backfill): main
   * asks the NVR for its main stream; allowMain() says whether this viewer may see main pictures,
   * asked for a camera known to record in HD only and again whenever no SD comes (a right taken away
   * meanwhile counts); onMain() is told when the session goes over to main. The URL's own stream
   * parameter is not read: one decision, made once, by the side that knows the rights.
   * @returns {{ main: boolean } | null} what it plays; null when refused (bad parameters: the socket
   *   is closing)
   */
  const connect = (ws, url, { main, allowMain = () => false, onMain = () => {} } = {}) => {
    const ch = Number(url.searchParams.get('ch'))
    const start = Number(url.searchParams.get('start'))
    if (!Number.isInteger(ch) || ch < 0 || typeof main !== 'boolean' || !Number.isFinite(start)) {
      ws.close(1008, 'bad parameters')
      return null
    }
    // A camera known to record in HD only goes to main at once for a viewer who may see main. Anyone
    // else is tried on SD all the same: a mark can be wrong (a slow NVR), an SD frame clears it
    // (#onFrame), and with none after SD_REFUSE_MS of playing the session is refused (#watch)
    const asMain = main || (hdOnly.has(ch) && askMain(allowMain))
    if (asMain && !main) ws.send(JSON.stringify({ type: 'stream', stream: 0 }))
    new PlaybackSession(ws, ch, asMain, start, clientCanDecodeH265(url.searchParams), { allowMain, onMain })
    return { main: asMain }
  }
```

- [ ] **Step 9: `cctv/rec-fallback.mjs`: the leg says what it plays**

Replace lines 249-252 (from the comment `// h265 always said…` through `nvr.playback.connect(proxy, url)`) with:
```js
  // h265 always said, as the page says it: playback.mjs takes a missing one as "can decode", and a leg's
  // raw H.265 sent to a browser without a decoder kills the player ("install HEVC") mid-playback.
  // Only an explicit false converts, so backfill (which stores the NVR's own bytes) never gets H.264.
  const url = new URL(`ws://x/playback?nvr=${encodeURIComponent(nvr.id)}&ch=${Number(ch)}&stream=${Number(stream)}&start=${Math.round(fromMs + skew)}&h265=${h265 === false ? 0 : 1}`)
  try {
    // A leg is part of a server playback, whose viewer holds Playback HD (and Playback SD, or there
    // would be no legs): main pictures are theirs to see. Backfill is this server's own copy.
    nvr.playback.connect(proxy, url, { main: Number(stream) === 0, allowMain: () => true })
```

- [ ] **Step 10: `cctv/server.mjs`: `/playback` asks "may see main" from the session each time, and is watched for what was decided**

Line 114:
```js
import { NVR_MAIN_ACTIONS, connectPlayback } from './rec-playback.mjs'
```
Line 124 gains `mayHd`:
```js
import { can, canPlayAnyOn, handleRights, mayHd, onRightsSaved, sitesFor } from './rights.mjs'
```
Replace lines 981-994 (the `/playback` branch, from `if (url.pathname === '/playback') {` to its closing `}`) with:
```js
  if (url.pathname === '/playback') {
    // server recordings (src=auto) or the NVR as before; the "NVR offline" refusal is for NVR
    // sessions only (server playback runs without the NVR), see rec-playback.mjs. Either playback
    // right opens the socket; connectPlayback asks the right of the source and quality it serves.
    if (!can(who, 'playback-server', target) && !can(who, 'playback-nvr', target)) return ws.close(1008, 'not allowed')
    // May this viewer see main pictures of the camera (rights.mjs mayHd)? Asked at the open, and again
    // whenever the NVR session wants main by itself, which can be minutes later (a wall tile opened
    // paused): from the session as it is then, never the `who` above, which still says admin for
    // someone demoted since
    const allowedMain = (_who, nvrId, ch) => {
      const u = currentUser(req)
      return Boolean(u) && mayHd({ user: u, admin: AUTH_OFF || auth.isAdmin(u) }, nvrId, ch)
    }
    // an NVR session that goes over to the main stream by itself (a camera recorded in HD only) is
    // watched for the main-stream rights from then on (access-watch.mjs replaces its entry), and asked
    // at once rather than at the next sweep, up to SWEEP_MS later
    const onMain = () => {
      watch.track(ws, req, { actions: NVR_MAIN_ACTIONS, nvr: nvr.id, ch: target.ch })
      watch.sweepSoon()
    }
    // remote by live view's rule (live-attach.mjs): the socket's own address, where the Cloudflare
    // tunnel arrives from 127.0.0.1. Its server playback is converted to fit the tunnel.
    const session = connectPlayback({ nvr, ws, url, who, index: recIndex(), remote: isRemoteAddress(req.socket.remoteAddress), allowedMain, onMain })
    // ...and for as long as it is open, the rights of what connectPlayback decided it plays (never a
    // second reading of the URL). A refused socket is closing already and is not watched.
    if (session) watch.track(ws, req, { actions: session.actions, nvr: nvr.id, ch: target.ch })
    return
  }
```

- [ ] **Step 11: The server-copy tests' own `connect` calls**

`cctv/test/playback-busy.test.mjs:75`:
```js
const openPlayback = (nvr, ws) => nvr.playback.connect(ws, new URL(`ws://x/playback?nvr=${nvr.id}&ch=0&stream=0&start=${Date.now() - 3_600_000}`), { main: true, allowMain: () => true })
```
`cctv/test/playback-search.test.mjs:274` (without a decision `connect` now refuses "bad parameters", and this test's three `open()` checks would fail):
```js
    o.playback.connect(ws, new URL(`ws://x/playback?nvr=open&ch=0&stream=0&start=${Date.now() - H}`), { main: true, allowMain: () => true })
```

- [ ] **Step 12: Run the tests**

Windows: `node cctv/test/rec-playback.test.mjs` (`all passed`, one `SKIP`), `node cctv/test/access-watch.test.mjs` (`all passed`), `node cctv/test/hd-only.test.mjs` (`all passed`), `node cctv/test/rec-fallback.test.mjs` (only the two known "16x during a leg" FAILs, one `SKIP`), `node cctv/test/rights.test.mjs` (`all passed`: its `/api/playback/*` pins are unchanged), `node --check cctv/playback.mjs` and `node --check cctv/server.mjs` (no output).
Server copy (Appendix A b, c): `bash /tmp/stream-rights-test/run-tests.sh cctv/test/playback-hd-switch.test.mjs cctv/test/playback-busy.test.mjs cctv/test/playback-search.test.mjs cctv/test/playback-dates.test.mjs cctv/test/transcode-ffmpeg.test.mjs cctv/test/rec-fallback.test.mjs cctv/test/rec-timeline.test.mjs` — expected seven `rc=0 fails=0` lines (`transcode-ffmpeg` calls `connectPlayback` for server playback, whose rights refusal moved before the index check).

- [ ] **Step 13: Commit**

```bash
git add cctv/rec-playback.mjs cctv/playback.mjs cctv/hd-only.mjs cctv/rec-fallback.mjs cctv/server.mjs cctv/test/rec-playback.test.mjs cctv/test/access-watch.test.mjs cctv/test/hd-only.test.mjs cctv/test/playback-hd-switch.test.mjs cctv/test/playback-busy.test.mjs cctv/test/playback-search.test.mjs
git commit -m "NVR playback: stream parsed once, main needs Playback SD and Live HD or Playback HD (asked from the session each time, again after the switch stops SD), SD-only viewers tried in SD on marked cameras, tracking by what plays; server playback rights refusal is 1008" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---


### Task 6: Event snapshots — the SD copy for viewers without HD, never cached

**Files:**
- Modify: `cctv/event-snapshot.mjs` (header :24, imports :35, after :64 `sdPath`, after :84 `sdArgs`, `toJpeg` :88-143, `oneAtATime` :145-151, `snap` :214, new `sdSnapshot`, `handleSnapshot` :278-308, `forgetSnapshots` :310-321, `sweepSnapshots` :332-360)
- Test: `cctv/test/event-snapshot.test.mjs` (Windows), `cctv/test/event-snapshot-ffmpeg.test.mjs` (server copy)

**Interfaces:**
- Consumes: `mayHd` (Task 1a).
- Produces:
  ```
  export const SD_WIDTH = 704
  export function sdPath(eventId): string                 // SNAP_DIR/<id>-sd.jpg
  export function sdArgs(): string[]                      // ffmpeg: JPEG in on stdin, JPEG <= 704 wide out
  export const SD_RETRY_MS = 300_000                      // a copy that failed is not tried again for this long
  export async function sdSnapshot(ev: { id, seenMs? }, deps?: { ffmpeg?, spawn?, platform?, timeoutMs? }): Promise<Buffer>
  //   rejects when the picture is older than the event row (an id used again), or the copy cannot be made
  export async function handleSnapshot(req, res, eventId, who, deps = {})   // deps passed to sdSnapshot (tests)
  // 200 answers: 'cache-control': 'private, no-store'; a picture older than its event row: 404 (whole or SD)
  ```

- [ ] **Step 1: Update and add the tests in `cctv/test/event-snapshot.test.mjs`**

(a) Lines 16-24, accounts and rights, gain erin (NVR playback and live on nvr1: after the upgrade she has Live HD there, as every viewer does):
```js
writeFileSync(join(process.env.DATA_DIR, 'users.json'), JSON.stringify({ alice: { hash: 'x', role: 'admin' }, bob: { hash: 'x', role: 'viewer' }, carol: { hash: 'x', role: 'viewer' }, dave: { hash: 'x', role: 'viewer' }, erin: { hash: 'x', role: 'viewer' } }))
// bob may watch live only; carol may play nvr1/3 back from the server; dave may play all of nvr1 back
// from the NVR; erin may too, and watch nvr1 live (the version 1 file is upgraded: Live HD = Live)
writeFileSync(join(process.env.DATA_DIR, 'rights.json'), JSON.stringify({
  version: 1,
  users: {
    bob: { grants: { live: ['*'] } },
    carol: { grants: { 'playback-server': ['nvr1/3'] } },
    dave: { grants: { 'playback-nvr': ['nvr1'] } },
    erin: { grants: { 'playback-nvr': ['nvr1'], live: ['nvr1'] } }
  }
}))
```
(b) The import (lines 26-29) gains the new names:
```js
const {
  SD_RETRY_MS, SD_WIDTH, SNAP_AFTER_MS, SNAP_DIR, SNAP_LATE_MS, SNAP_POLL_MS, SNAP_WAIT_MS,
  forgetSnapshots, handleSnapshot, sdArgs, sdPath, snapArgs, snapPath, sweepSnapshots, takeSnapshot
} = await import('../event-snapshot.mjs')
```
(c) The route's `call` (lines 340-344, from `const call = async (id, who, method = 'GET') => {` to its closing `}`; line 345, `const alice = …`, stays) hands in a fake ffmpeg for the SD copy, and erin is added after it:
```js
const call = async (id, who, method = 'GET', deps = { spawn: spawnAs('ok'), platform: 'linux' }) => {
  const res = fakeRes()
  await handleSnapshot({ method }, res, id, who, deps)
  return res
}
const erin = { user: 'erin', admin: false }
```
(c2) The route's three events (lines 349-351: `shown`, `other`, `bare`) are made with their `seen` time a minute back (`addEvent`'s second argument): a picture older than its event's row is now refused (Step 4 (g)), and a file written right after its row can carry an mtime a little before it (a coarse file clock). Lines 349-351 become:
```js
// the rows are older than their pictures, as takeSnapshot's always are (it waits for the recording);
// a picture older than its row is an earlier event's (handleSnapshot answers 404)
const SEEN = Date.now() - 60_000
const { event: shown } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0, source: 'test' }, SEEN)
const { event: other } = addEvent({ nvr: 'nvr2', ch: 0, type: 'motion', startMs: T0, source: 'test' }, SEEN)
const { event: bare } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 + 60_000, source: 'test' }, SEEN)
```
(d) Line 358's check (`'  with the security headers, cached privately'`) becomes:
```js
  check('  with the security headers, never cached (the next user of the browser may be allowed less)', a.headers['x-content-type-options'] === 'nosniff' && a.headers['cache-control'] === 'private, no-store')
```
(e) Insert after the route block (before `// ---- pictures go with their events`):
```js
// ---- the full picture or the SD copy, by right (stream rights) --------------------------------------------
{
  const { event: pic } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 + 120_000, source: 'test' }, SEEN)
  const FULL = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200, 9), Buffer.from([0xff, 0xd9])])
  writeFileSync(snapPath(pic.id), FULL)
  const before = procs.length
  const c = await call(pic.id, carol)
  check('Playback HD: the full picture, no ffmpeg', c.status === 200 && Buffer.from(c.body).equals(FULL) && procs.length === before)
  const e = await call(pic.id, erin)
  check('Playback SD with Live HD (every viewer after the upgrade): the full picture', e.status === 200 && Buffer.from(e.body).equals(FULL) && procs.length === before)
  const d = await call(pic.id, dave)
  const p = procs.at(-1)
  check('Playback SD only: the SD copy, made from the stored picture', d.status === 200 && procs.length === before + 1 && p.input.equals(FULL) && Buffer.from(d.body).equals(JPEG), `${d.status} ${procs.length - before}`)
  check('... at most 704 wide, a JPEG from a JPEG (quoted for the filter parser; no shell)', SD_WIDTH === 704 && p.args.includes("scale='min(704,iw)':-2") && p.args.join(' ').includes('-f image2pipe -c:v mjpeg -i pipe:0') && sdArgs().includes("scale='min(704,iw)':-2"), p.args.join(' '))
  check('... kept beside it as <id>-sd.jpg', existsSync(sdPath(pic.id)) && sdPath(pic.id) === join(SNAP_DIR, `${pic.id}-sd.jpg`))
  check('... never cached by the browser', d.headers['cache-control'] === 'private, no-store')
  await call(pic.id, dave)
  check('asked again: the kept copy, no second ffmpeg', procs.length === before + 1)
  const later = new Date(Date.now() + 60_000)
  utimesSync(snapPath(pic.id), later, later) // the full picture taken again (an event id used again)
  await call(pic.id, dave)
  check('the full picture newer than the copy: the copy is made again', procs.length === before + 2)
  const { event: failPic } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 + 180_000, source: 'test' }, SEEN)
  writeFileSync(snapPath(failPic.id), FULL)
  const f = await call(failPic.id, dave, 'GET', { spawn: spawnAs('fail'), platform: 'linux' })
  check('the copy cannot be made: 404, never the full picture', f.status === 404 && !existsSync(sdPath(failPic.id)), String(f.status))
  const f2 = await call(failPic.id, dave)
  check('... asked again at once: 404 without trying again (for SD_RETRY_MS, 5 minutes)', f2.status === 404 && procs.length === before + 3 && SD_RETRY_MS === 300_000)
  check('live only: still 404, and no ffmpeg for it', (await call(pic.id, bob)).status === 404 && procs.length === before + 3)
  // a picture older than its event's row belonged to an earlier event with the same id (SQLite can
  // hand out a deleted newest row's id again), maybe of another camera
  const { event: reused } = addEvent({ nvr: 'nvr1', ch: 3, type: 'motion', startMs: T0 + 240_000, source: 'test' })
  writeFileSync(snapPath(reused.id), FULL)
  const old = new Date(Date.now() - 600_000)
  utimesSync(snapPath(reused.id), old, old)
  check('a picture older than its event (an id used again): 404 whole and as the SD copy, and no copy made of it', (await call(reused.id, carol)).status === 404 && (await call(reused.id, dave)).status === 404 && procs.length === before + 3 && !existsSync(sdPath(reused.id)))
  const src = readFileSync(new URL('../event-snapshot.mjs', import.meta.url), 'utf8')
  check('the SD copies take turns on a queue of their own, never ahead of or behind a new event\'s picture', /sdOneAtATime\(\(\) => toJpeg\(input, sdArgs\(\)/.test(src) && /= await oneAtATime\(\(\) => toJpeg\(found\.key\.buf, snapArgs\(found\.key\.codec\), o\)\)/.test(src))
  check('sdPath refuses what is not an event id', (() => { try { sdPath('../x'); return false } catch { return true } })())
}
```
(f) In the block `// ---- pictures go with their events`, before `const { removed } = await sweepSnapshots()` add:
```js
  writeFileSync(sdPath(424243), JPEG) // an SD copy whose event is gone (its full picture already went)
  writeFileSync(sdPath(other.id), JPEG)
```
and at the end of that block (after the "nothing removed, nothing thrown" check) add:
```js
  check('sweepSnapshots: an SD copy goes with its event, and stays while the event is there', !existsSync(sdPath(424243)) && existsSync(sdPath(other.id)))
  forgetSnapshots([other.id])
  check('forgetSnapshots removes the SD copy with the picture', !existsSync(sdPath(other.id)) && !existsSync(snapPath(other.id)))
```

- [ ] **Step 2: Add the real-ffmpeg check to `cctv/test/event-snapshot-ffmpeg.test.mjs`**

The import (line 14) becomes `const { sdSnapshot, snapPath, takeSnapshot } = await import('../event-snapshot.mjs')`, and before its final `console.log` add:
```js
// ---- the SD copy (stream rights): a 1280-wide picture comes back at most 704 wide ------------------------
{
  const key = testVideo({ size: '1920x1080' })
  const got = await takeSnapshot({ id: 7, nvr: 'nvr1', ch: 0, startMs: T0 }, oneKey(key, '/x/nvr1/0/14-00.h264'))
  const sd = got ? await sdSnapshot({ id: 7 }).catch((e) => e) : null
  check('the SD copy of the 1280x720 picture is 704x396', Buffer.isBuffer(sd) && jpegSize(sd) === '704x396', Buffer.isBuffer(sd) ? jpegSize(sd) : String(sd?.message ?? logs.join(' | ')))
}
```

- [ ] **Step 3: Run to see it fail**

Run: `node cctv/test/event-snapshot.test.mjs`
Expected: `FAIL` on the `no-store` check, then the run stops with `TypeError: sdPath is not a function` in the new block (`sdPath` and `SD_RETRY_MS` are imported as undefined: the test's import is a destructured `await import`).

- [ ] **Step 4: Change `cctv/event-snapshot.mjs`**

(a) Header line 24 becomes:
```js
//   GET /api/events/:id/snapshot -> the JPEG, for a user who may play that camera back (rights.mjs):
//        the picture itself for Live HD or Playback HD on the camera (rights.mjs mayHd: it is from the
//        main stream), else an SD copy at most SD_WIDTH wide, made on first request and kept as
//        <id>-sd.jpg (never the picture itself instead). Never cached by the browser.
```
(b) Line 35:
```js
import { can, mayHd } from './rights.mjs'
```
(c) After `snapPath` (line 64) add:
```js
/** The SD copy's width at most: the sub-streams this site's cameras send (704x396, 704x576). */
export const SD_WIDTH = 704

/** The SD copy of one event's picture, for a viewer without Live HD or Playback HD on the camera. */
export function sdPath(eventId) {
  const id = Number(eventId)
  if (!isEventId(id)) throw new Error(`not an event id: ${eventId}`)
  return join(SNAP_DIR, `${id}-sd.jpg`)
}
```
(d) After `snapArgs` (line 84) add:
```js
/** ffmpeg's arguments for the SD copy: the stored JPEG in on stdin, one JPEG at most SD_WIDTH wide out. */
export function sdArgs() {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-frames:v', '1',
    '-vf', `scale='min(${SD_WIDTH},iw)':-2`,
    '-q:v', '4',
    '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'
  ]
}
```
(e) `toJpeg` takes its arguments from the caller: lines 88-91 become
```js
/** One picture through ffmpeg (args: snapArgs or sdArgs): resolves the JPEG bytes, rejects with why not. */
function toJpeg(input, args, { ffmpeg, spawn, platform, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const { bin, args: wrapped } = niceWrap(ffmpeg, args, { platform, hasIonice: platform === 'linux' })
```
line 94 `proc = spawn(bin, args, …)` becomes `proc = spawn(bin, wrapped, { stdio: ['pipe', 'pipe', 'pipe'] })`, and line 141 `proc.stdin.end(keyBuf)` becomes `proc.stdin.end(input)`. In `snap` (line 214):
```js
      const jpeg = await oneAtATime(() => toJpeg(found.key.buf, snapArgs(found.key.codec), o))
```
(e2) Replace `oneAtATime` (lines 145-151, from the comment `// ffmpeg one at a time: …` to the function's closing `}`) with a queue maker and two queues:
```js
/** A queue of ffmpeg jobs taken one at a time: a burst takes turns rather than starting a process each. */
function turns() {
  let turn = Promise.resolve()
  return (fn) => {
    const run = turn.then(fn)
    turn = run.catch(() => {})
    return run
  }
}
// the pictures of new events
const oneAtATime = turns()
// the SD copies, on a queue of their own: a viewer asking for many of them, or again and again for one
// that fails, never holds back the picture of a crossing seen now
const sdOneAtATime = turns()
```
(f) After `takeSnapshot` (line 276) add:
```js
const sdInFlight = new Map() // event id -> its SD copy being made
/** A copy that could not be made is not tried again for this long (each try is up to SNAP_FFMPEG_MS). */
export const SD_RETRY_MS = 5 * 60_000
const sdFailed = new Map() // `${id}@${the picture's mtime}` -> when making its copy failed

/**
 * The event's stored picture, if it is this event's: one older than the event's row belonged to an
 * earlier event with the same id (SQLite can hand out the id of a deleted newest row again;
 * takeSnapshot takes it afresh), maybe of another camera, and is not shown whole or as a copy.
 * @param {{ id: number, seenMs?: number }} ev an events-db row
 * @returns {import('node:fs').Stats|null}
 */
function pictureOf(ev) {
  const st = statSync(snapPath(ev.id), { throwIfNoEntry: false })
  return st && !(st.mtimeMs < Number(ev.seenMs)) ? st : null
}

/**
 * The SD copy of an event's picture, made the first time it is asked for, on its own one-at-a-time
 * ffmpeg queue, and kept beside the picture (made again when the picture is newer: taken again). Rejects
 * when there is no picture of this event or the copy cannot be made (and then, for SD_RETRY_MS, without
 * trying again): the route then answers 404, never with the picture itself.
 * @param {{ id: number, seenMs?: number }} ev an events-db row
 * @param {{ ffmpeg?: string, spawn?: Function, platform?: string, timeoutMs?: number }} [deps] (tests)
 * @returns {Promise<Buffer>}
 */
export async function sdSnapshot(ev, { ffmpeg = 'ffmpeg', spawn = nodeSpawn, platform = process.platform, timeoutMs = SNAP_FFMPEG_MS } = {}) {
  const id = Number(ev?.id)
  const full = snapPath(id)
  const sd = sdPath(id)
  const fullSt = pictureOf({ id, seenMs: ev?.seenMs })
  if (!fullSt) throw new Error('no picture of this event')
  const sdSt = statSync(sd, { throwIfNoEntry: false })
  if (sdSt && sdSt.mtimeMs >= fullSt.mtimeMs) return readFile(sd)
  const key = `${id}@${fullSt.mtimeMs}`
  if (Date.now() - (sdFailed.get(key) ?? -Infinity) < SD_RETRY_MS) throw new Error('the SD copy could not be made a moment ago')
  if (sdInFlight.has(id)) return sdInFlight.get(id)
  const job = (async () => {
    const input = await readFile(full)
    let jpeg
    try {
      jpeg = await sdOneAtATime(() => toJpeg(input, sdArgs(), { ffmpeg, spawn, platform, timeoutMs }))
    } catch (e) {
      const now = Date.now()
      for (const [k, at] of sdFailed) if (now - at >= SD_RETRY_MS) sdFailed.delete(k)
      sdFailed.set(key, now)
      throw e
    }
    const tmp = `${sd}.${process.pid}.tmp`
    try {
      await writeFile(tmp, jpeg)
      await rename(tmp, sd)
    } catch (e) {
      console.warn(`[snapshot] could not keep the SD copy of event ${id}: ${e.message}`)
    } finally {
      await rm(tmp, { force: true })
    }
    return jpeg
  })().finally(() => sdInFlight.delete(id))
  sdInFlight.set(id, job)
  return job
}
```
(g) Replace `handleSnapshot` (lines 278-308) with:
```js
/**
 * GET /api/events/:id/snapshot: the event's picture, for someone who may play that camera back (from
 * the server or the NVR: the same rule as the /playback socket). Everything else is a bare 404, an
 * event on a camera the user may not see included: that it exists is not theirs to know either. The
 * picture is from the recording, normally the main stream: itself only for someone who may see main
 * pictures of the camera (rights.mjs mayHd: Live HD or Playback HD), the SD copy for anyone else; a
 * picture older than the event's row (an earlier event's, pictureOf) for nobody.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number|string} eventId from the URL
 * @param {{ user: string, admin: boolean }} who from the session (server.mjs), never from the request
 * @param {object} [deps] sdSnapshot's (tests)
 */
export async function handleSnapshot(req, res, eventId, who, deps = {}) {
  const answer = (status, body, headers) => {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
    res.end(body)
  }
  if (req.method !== 'GET') return answer(405, JSON.stringify({ error: 'Method not allowed' }), { 'content-type': 'application/json', allow: 'GET' })
  // no-store: the picture of a crossing seen seconds ago is usually still being taken
  const missing = () => answer(404, JSON.stringify({ error: 'No picture for that event' }), { 'content-type': 'application/json', 'cache-control': 'no-store' })
  const id = Number(eventId)
  if (!isEventId(id)) return missing()
  const ev = getEvent(id)
  const cam = ev ? { nvr: ev.nvr, ch: ev.ch } : null
  if (!cam || !(can(who, 'playback-server', cam) || can(who, 'playback-nvr', cam))) return missing()
  let jpeg
  try {
    if (!mayHd(who, cam.nvr, cam.ch)) jpeg = await sdSnapshot(ev, deps)
    else if (pictureOf(ev)) jpeg = await readFile(snapPath(id))
    else return missing() // not taken (yet, or at all), or an earlier event's picture (pictureOf)
  } catch {
    return missing() // no SD copy: never the picture itself instead
  }
  // no-store: the browser's cache (per browser, not per user) would show it to the next person signed
  // in here, who may be allowed only the SD copy or nothing, and after a right was taken away
  answer(200, jpeg, { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length), 'cache-control': 'private, no-store' })
}
```
(h) `forgetSnapshots`: inside its `try`, after `rmSync(snapPath(id), { force: true })` add `rmSync(sdPath(id), { force: true })`, and its doc comment says "Removes these events' pictures and their SD copies."
(i) `sweepSnapshots`: line 339 becomes `const gone = new Set()`, line 341 becomes
```js
    const m = /^(\d{1,15})(-sd)?\.jpg$/.exec(name) // the picture or its SD copy
```
line 344 `gone.push(Number(m[1]))` becomes `gone.add(Number(m[1]))`, and lines 357-359 become:
```js
  forgetSnapshots([...gone])
  if (gone.size) console.log(`[snapshot] removed the pictures of ${gone.size} event(s) that are gone`)
  return { removed: gone.size }
```

- [ ] **Step 5: Run the tests**

Windows: `node cctv/test/event-snapshot.test.mjs` — expected `all passed`. Also `node cctv/test/alarms-view.test.mjs` — `all passed` (unchanged URL).
Server copy (Appendix A b, c): `bash /tmp/stream-rights-test/run-tests.sh cctv/test/event-snapshot-ffmpeg.test.mjs` — expected `rc=0 fails=0`.

- [ ] **Step 6: Commit**

```bash
git add cctv/event-snapshot.mjs cctv/test/event-snapshot.test.mjs cctv/test/event-snapshot-ffmpeg.test.mjs
git commit -m "Event pictures: full size only with Live HD or Playback HD, an SD copy (704 wide) otherwise, never cached by the browser" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Camera lists carry each camera's rights (`/api/cameras`, `?for=playback`)

**Files:**
- Modify: `cctv/rights.mjs` (after `intersectTargets`, Task 1a)
- Modify: `cctv/server.mjs:124` (import) and `:870-871` (`/api/cameras`)
- Test: `cctv/test/rights.test.mjs` (Windows)

**Interfaces:**
- Consumes: `can`, `mayHd` (Task 1a); server.mjs's rights import as Task 5 left it (with `mayHd`).
- Produces:
  ```
  export function liveCameras(who, cams: Array<{nvr, ch, …}>): Array<{ …cam, hd: boolean, playback: boolean }>
  export function playbackCameras(who, cams): Array<{ …cam, sd: boolean, hd: boolean, nvrHd: boolean, legs: boolean }>
  //   an admin (who.admin): every camera, every flag true, without asking can() per camera
  GET /api/cameras               -> liveCameras(who, allCameras({ live: true }))
  GET /api/cameras?for=playback  -> playbackCameras(who, allCameras({ live: true }))
  ```

- [ ] **Step 1: Write the failing test (append to `cctv/test/rights.test.mjs`, before the final `console.log`)**

```js
// ---- the camera lists the pages read (liveCameras, playbackCameras) ----------------------------------------
{
  auth.saveUsers({ boss: { hash: 'x', role: 'admin' }, jo: { hash: 'x', role: 'viewer' } })
  writeFileSync(R.RIGHTS_FILE, JSON.stringify({ version: 2, users: {} }))
  const CAMS = [{ nvr: 'n1', ch: 0, name: 'A' }, { nvr: 'n1', ch: 1, name: 'B' }, { nvr: 'n2', ch: 0, name: 'C' }]
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1/0'], 'playback-nvr': ['n1/1', 'n2'], 'playback-server': ['n2/0'] } })
  const live = R.liveCameras(VIEWER, CAMS)
  check('liveCameras: only the cameras with Live, their own fields kept', J(live.map((c) => c.name)) === J(['A', 'B']) && live[0].nvr === 'n1' && live[0].ch === 0)
  check('... hd where Live HD is; playback where either playback right is', live[0].hd === true && live[1].hd === false && live[0].playback === false && live[1].playback === true, J(live))
  const pb = R.playbackCameras(VIEWER, CAMS)
  check('playbackCameras: only cameras with a playback right', J(pb.map((c) => c.name)) === J(['B', 'C']))
  check('... Playback SD only: sd; no hd, no NVR HD (no Live HD there), no legs', J([pb[0].sd, pb[0].hd, pb[0].nvrHd, pb[0].legs]) === J([true, false, false, false]))
  check('... SD and HD: every flag (Playback HD may see main; legs need both)', J([pb[1].sd, pb[1].hd, pb[1].nvrHd, pb[1].legs]) === J([true, true, true, true]))
  R.saveRights('jo', { grants: { live: ['n1'], 'live-hd': ['n1'], 'playback-nvr': ['n1'] } })
  check('... SD with Live HD there: NVR HD', R.playbackCameras(VIEWER, CAMS)[0].nvrHd === true)
  check('an admin: every camera, every flag', R.liveCameras(ADMIN, CAMS).every((c) => c.hd && c.playback) && R.liveCameras(ADMIN, CAMS).length === 3 && R.playbackCameras(ADMIN, CAMS).every((c) => c.sd && c.hd && c.nvrHd && c.legs))
  check('no session: nothing', R.liveCameras(null, CAMS).length === 0 && R.playbackCameras(null, CAMS).length === 0)
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check('server.mjs: /api/cameras through liveCameras, ?for=playback through playbackCameras', /pathname === '\/api\/cameras'\) return sendJson\(res, 200, url\.searchParams\.get\('for'\) === 'playback' \? playbackCameras\(who, allCameras\(\{ live: true \}\)\) : liveCameras\(who, allCameras\(\{ live: true \}\)\)\)/.test(src))
  const rsrc = readFileSync(new URL('../rights.mjs', import.meta.url), 'utf8')
  check('an admin\'s lists are made without asking can() per camera (as the old route did)', /export function liveCameras\(who, cams\) \{[^}]*?if \(who\?\.admin === true\) return cams\.map/.test(rsrc) && /export function playbackCameras\(who, cams\) \{\s*if \(who\?\.admin === true\) return cams\.map/.test(rsrc))
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `node cctv/test/rights.test.mjs` — expected the run stops with `TypeError: R.liveCameras is not a function`.

- [ ] **Step 3: Add the helpers to `cctv/rights.mjs` (after `intersectTargets`, Task 1a)**

```js
/**
 * GET /api/cameras for one user: the cameras they may watch live, each with `hd` (Live HD there: full
 * screen at full quality) and `playback` (either playback right there: the full-size view's Recordings
 * link). An admin gets every camera with everything allowed. The pages use these only to not offer
 * what the server would refuse; every stream asks can() again.
 * @param {object} who the session's user
 * @param {Array<{ nvr: string, ch: number }>} cams nvrs.mjs allCameras()
 */
export function liveCameras(who, cams) {
  // an admin (the session says so, as server.mjs built it): everything, without asking can() four
  // times a camera, each a look at the rights file (file-cache.mjs), every 30 s per open page
  if (who?.admin === true) return cams.map((c) => ({ ...c, hd: true, playback: true }))
  const out = []
  for (const c of cams) {
    const t = { nvr: c.nvr, ch: c.ch }
    if (!can(who, 'live', t)) continue
    out.push({ ...c, hd: can(who, 'live-hd', t), playback: can(who, 'playback-nvr', t) || can(who, 'playback-server', t) })
  }
  return out
}

/**
 * GET /api/cameras?for=playback: the cameras they may play back (either right), each with sd (the NVR's
 * copy: Playback SD), hd (the server's recordings: Playback HD), nvrHd (the NVR's main stream: SD and a
 * right to see main, as rec-playback.mjs asks) and legs (the server's gaps filled from the NVR: both).
 * @param {object} who the session's user
 * @param {Array<{ nvr: string, ch: number }>} cams nvrs.mjs allCameras()
 */
export function playbackCameras(who, cams) {
  if (who?.admin === true) return cams.map((c) => ({ ...c, sd: true, hd: true, nvrHd: true, legs: true }))
  const out = []
  for (const c of cams) {
    const t = { nvr: c.nvr, ch: c.ch }
    const sd = can(who, 'playback-nvr', t)
    const hd = can(who, 'playback-server', t)
    if (!sd && !hd) continue
    out.push({ ...c, sd, hd, nvrHd: sd && (hd || can(who, 'live-hd', t)), legs: sd && hd })
  }
  return out
}
```

- [ ] **Step 4: Wire `/api/cameras` in `cctv/server.mjs`**

Line 124 (as Task 5 left it) becomes:
```js
import { can, canPlayAnyOn, handleRights, liveCameras, mayHd, onRightsSaved, playbackCameras, sitesFor } from './rights.mjs'
```
Replace lines 870-871 with:
```js
  // the cameras this user may watch live, each with what it allows (rights.mjs liveCameras: hd, playback);
  // ?for=playback: the ones they may play back instead (playbackCameras: sd, hd, nvrHd, legs). An admin
  // gets every camera with everything allowed.
  if (pathname === '/api/cameras') return sendJson(res, 200, url.searchParams.get('for') === 'playback' ? playbackCameras(who, allCameras({ live: true })) : liveCameras(who, allCameras({ live: true })))
```

- [ ] **Step 5: Run the tests**

Run: `node cctv/test/rights.test.mjs` — expected `all passed`. Also `node cctv/test/map-cameras.test.mjs` and `node cctv/test/bookmarks.test.mjs` — each `all passed` (unchanged).

- [ ] **Step 6: Commit**

```bash
git add cctv/rights.mjs cctv/server.mjs cctv/test/rights.test.mjs
git commit -m "/api/cameras: each camera's hd and playback flags; ?for=playback lists cameras by playback right with sd, hd, nvrHd, legs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: The Live pages — wait notes, SD full screen with its badge, the HD refusal fallback

**Files:**
- Modify: `cctv/public/live-tile.js` (after `:17` exports, constructor JSDoc `:101-111`, `:115` fields, `:137` first-frame status, `connect` `:306-321`, new `#note` and `#hdRefused`)
- Modify: `cctv/public/live-mux.js` (header `:10-14`, `control` `:328-347`)
- Modify: `cctv/public/viewer.js` (`syncSingle` `:344-348`, the Recordings link `:602-608`, `:706-708`, `upgradeToMain` `:743-773`, new `sdBadge`)
- Modify: `cctv/public/grid-diff.js:31-36`, `:51-52`
- Modify: `cctv/public/login.js` (top), `cctv/public/style.css` (after `:762`)
- Test: `cctv/test/live-tile.test.mjs`, `cctv/test/live-mux-client.test.mjs`, `cctv/test/grid-diff.test.mjs` (all Windows)

**Interfaces:**
- Consumes: the wait notice and `'hd not allowed'` close (Task 3); `/api/cameras` `hd` and `playback` (Task 7).
- Produces:
  ```
  // cctv/public/live-tile.js
  export const HD_REFUSED = 'hd not allowed'
  export function waitText(why: string): string
  new LiveTile(tile, cam, streamType, delay, { …, onHdRefused?: () => boolean })   // true: handled by the caller
  // cctv/public/grid-diff.js: diffCameras(...).changed[i].hd: boolean (Live HD flipped)
  ```

- [ ] **Step 1: Write the failing tests**

(a) `cctv/test/live-tile.test.mjs`: line 41's import becomes
```js
const { LiveTile, MAIN_STREAM, NO_VIDEO_MS, STALL_RECONNECT_MS, SUB_STREAM, TILE_HTML, tileDot, waitText } = await import('../public/live-tile.js')
```
and insert before the last `t.close()` (the line above the final `console.log`):
```js
// ---- stream rights: the server's wait notes, and the main stream refused for want of Live HD ----------
{
  const nameEl = { textContent: 'Gate', append(s) { this.textContent += s } }
  const st = el()
  const tileHd = { querySelector: (s) => (s === '.name' ? nameEl : s === '.status' ? st : parts[s]), append() {} }
  const tw = new LiveTile(tileHd, { nvr: 'n1', ch: 7 }, SUB_STREAM, 0, { now: () => now })
  clearTimeout(tw.retry)
  tw.player.push = () => {}
  tw.connect()
  const ww = sockets.at(-1)
  ww.readyState = 1
  ww.onmessage({ data: '{"op":"wait","why":"held"}' })
  check('a wait note: the tile says why it waits', st.textContent === 'Waiting for room at the NVR (SD streams)', st.textContent)
  check('waitText for each reason', waitText('starting') === 'Starting…' && /not available/.test(waitText('unavailable')) && waitText('held') === st.textContent && waitText('anything') === 'Starting…')
  for (let i = 0; i < 5; i++) {
    now += 4000
    ww.onmessage({ data: '{"op":"wait","why":"held"}' })
    tw.updateStatus()
  }
  check('... notes every 4 s count as activity: 20 s on, no "no video" and no reconnect', !ww.closed && st.textContent === 'Waiting for room at the NVR (SD streams)', st.textContent)
  ww.onmessage({ data: 'not json' })
  ww.onmessage({ data: '{"op":"other"}' })
  check('... other text is ignored', !ww.closed && st.textContent === 'Waiting for room at the NVR (SD streams)')
  tw.close()

  const tm = new LiveTile(tileHd, { nvr: 'n1', ch: 8 }, MAIN_STREAM, 0, { now: () => now })
  clearTimeout(tm.retry)
  tm.player.push = () => {}
  tm.connect()
  const wm = sockets.at(-1)
  const before = sockets.length
  wm.readyState = 3
  wm.onclose({ code: 1008, reason: 'hd not allowed' })
  const w2 = sockets.at(-1)
  check('main refused "hd not allowed": the sub-stream at once, on a new socket', sockets.length === before + 1 && tm.streamType === SUB_STREAM && /stream=1/.test(w2.url), w2?.url)
  check('... and the name says so', /SD: full quality needs Live HD/.test(nameEl.textContent), nameEl.textContent)
  w2.readyState = 3
  w2.onclose({ code: 1008, reason: 'hd not allowed' })
  check('... the same close on the sub-stream is an ordinary close: a retry later, not another fallback', tm.streamType === SUB_STREAM && sockets.length === before + 1 && Boolean(tm.retry))
  tm.close()
  let handled = 0
  const tl = new LiveTile(tileHd, { nvr: 'n1', ch: 9 }, MAIN_STREAM, 0, { now: () => now, onHdRefused: () => { handled++; return true } })
  clearTimeout(tl.retry)
  tl.connect()
  const wl = sockets.at(-1)
  const n = sockets.length
  wl.onclose({ code: 1008, reason: 'hd not allowed' })
  check('onHdRefused handling it (viewer.js drops a layer not shown yet): no new socket, no fallback', handled === 1 && sockets.length === n && tl.streamType === MAIN_STREAM)
  tl.close()
}
```
(b) `cctv/test/live-mux-client.test.mjs`: insert before the final `console.log`:
```js
// ---- "wait" from the server (stream rights): handed to that channel's tile as the text it is ----------
{
  reset()
  useMux(true)
  const a = liveSocket(cam(0))
  const b = liveSocket(cam(1))
  const la = track(a)
  const lb = track(b)
  const s = sockets[0]
  s.accept()
  advance(40) // (a sub settles 40 ms before it goes: then both channels are open)
  s.text({ op: 'wait', id: a.id, why: 'held' })
  check('"wait": to that channel only, as the text it is', la.msgs.length === 1 && typeof la.msgs[0] === 'string' && JSON.parse(la.msgs[0]).why === 'held' && lb.msgs.length === 0, JSON.stringify(la.msgs))
  check('... the channel stays open', a.readyState === 1 && la.closes.length === 0)
  s.text({ op: 'wait', id: 424242, why: 'held' })
  s.text({ op: 'wait', why: 'held' })
  check('... one for an unknown id, or with no id, is dropped', la.msgs.length === 1 && lb.msgs.length === 0)
  // a Live tile on a channel: the notes are activity (no stall reconnect), and it says why it waits
  reset()
  useMux(true)
  const el = () => ({ textContent: '', classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c) }, contains(c) { return this.set.has(c) } }, append() {} })
  const parts = { '.status': el(), '.stats': el(), '.name': el(), '.dot': { className: '', title: '' }, canvas: { width: 0, height: 0, getContext: () => ({}) } }
  const t = new LiveTile({ querySelector: (q) => parts[q], append() {} }, { nvr: 'n1', ch: 3 }, SUB_STREAM, 0, { now: () => now })
  clearTimeout(t.retry)
  t.player.push = () => {}
  t.connect()
  sockets[0].accept()
  advance(40)
  for (let i = 0; i < 4; i++) {
    advance(4000)
    sockets[0].text({ op: 'wait', id: t.ws.id, why: 'held' })
    t.updateStatus()
  }
  check('a Live tile on a channel: 16 s of wait notes, no stall reconnect, and it says why', t.ws.readyState === 1 && t.attempts === 0 && parts['.status'].textContent === 'Waiting for room at the NVR (SD streams)', parts['.status'].textContent)
  t.close()
  advance(0)
}
```
(c) `cctv/test/grid-diff.test.mjs`: insert before the final `console.log`:
```js
// ---- Live HD per camera (stream rights) -----------------------------------------------------------------
{
  const d = diffCameras(base(), edit(base(), 1, { hd: true }), view())
  check('hd flipping is a change of that tile, not a rebuild', d.full === false && d.changed.length === 1 && d.changed[0].hd === true && d.changed[0].index === 1)
  check('hd the same: no change', diffCameras(edit(base(), 1, { hd: true }), edit(base(), 1, { hd: true }), view()).changed.length === 0)
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  check('viewer.js: full screen goes to main only with Live HD (and not remote, and not a browser that failed main)', /if \(cam\.hd !== false && !noMain\.has\(single\) && !cam\.remote\) upgradeToMain\(overlay, cam, sub, opts\)/.test(src))
  check('viewer.js: without it, the SD badge', /else if \(cam\.hd === false\) overlay\.querySelector\('\.name'\)\.after\(sdBadge\(\)\)/.test(src))
  check('viewer.js: the full-size view is rebuilt when Live HD flips', /if \(keep && Boolean\(singleCam\?\.hd\) === Boolean\(cam\.hd\)\)/.test(src))
  check('viewer.js: "Recordings" only with a playback right', /if \(cam\.playback !== false\) \{/.test(src))
  check('viewer.js: a main layer refused before it showed goes, the sub-stream stays', /onHdRefused: \(\) => \{\n\s*if \(!layer\.classList\.contains\('pending'\)\) return false/.test(src))
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `node cctv/test/live-tile.test.mjs` — expected `FAIL  a wait note: the tile says why it waits`, then the run stops with `TypeError: waitText is not a function` (the test imports with a destructured `await import`, so a missing export is just undefined).
Run: `node cctv/test/live-mux-client.test.mjs` — expected FAIL on the `"wait"` checks.
Run: `node cctv/test/grid-diff.test.mjs` — expected FAIL on the hd and viewer.js checks.

- [ ] **Step 3: `cctv/public/live-tile.js`**

(a) After line 17 (`export const MAIN_STREAM = 0`) add:
```js
// The server's reason for refusing the main stream (stream-param.mjs): no Live HD on the camera. The
// tile goes over to the sub-stream rather than asking again (the server would refuse it every time).
export const HD_REFUSED = 'hd not allowed'

/** What a tile says while the server tells it its sub-stream has no picture yet (live-wait.mjs). */
export function waitText(why) {
  if (why === 'held') return 'Waiting for room at the NVR (SD streams)'
  if (why === 'unavailable') return 'SD stream not available from the NVR'
  return 'Starting…'
}
```
(b) Constructor JSDoc (`@param … opts`) gains, after `onUnsupported: …`:
```js
   *   onHdRefused: the main stream was refused for want of Live HD; return true when handled
   *   (viewer.js drops a layer not shown yet), else the tile goes over to the sub-stream itself
```
and after `this.closed = false` add:
```js
    this.waiting = false // the server said its sub-stream has no picture yet (a wait note, live-wait.mjs)
```
(c) Line 137 becomes:
```js
        if (this.waiting || /connecting|no video/.test(this.status.textContent)) {
          this.waiting = false
          this.setStatus('LIVE', true)
        }
```
(d) In `connect()`, replace `this.ws.onmessage = …` and `this.ws.onclose = …` (lines 306-321) with:
```js
    this.ws.onmessage = (e) => {
      this.lastDataAt = this.now()
      // a text is a note from the server, never a frame (live-wait.mjs: the sub-stream has no picture
      // yet); it is activity all the same, so the stall watchdog leaves the tile alone
      if (typeof e.data === 'string') return this.#note(e.data)
      this.attempts = 0
      this.onMessage(new Uint8Array(e.data))
    }
    this.ws.onclose = (e) => {
      this.player.reset()
      if (this.closed) return
      // the main stream refused for want of Live HD (at once, or taken away while it played): not
      // asked for again from here, the sub-stream instead
      if (e?.code === 1008 && e.reason === HD_REFUSED && this.streamType === MAIN_STREAM) return this.#hdRefused()
      this.opts.onDisconnect?.()
      this.setStatus('reconnecting…')
      // back off (1, 2, 4, 8 s: reconnectDelay) with jitter, so many tiles don't reconnect in lockstep
      const delay = reconnectDelay(this.attempts) * (0.7 + Math.random() * 0.6)
      this.attempts++
      this.retry = setTimeout(() => this.connect(), delay)
    }
  }

  /** A note from the server: {"op":"wait","why":…} while the sub-stream has no picture yet. */
  #note(text) {
    let m
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    if (m?.op !== 'wait') return
    this.waiting = true
    this.setStatus(waitText(m.why))
  }

  /**
   * The main stream refused for want of Live HD: the caller may handle it (viewer.js: a layer not
   * shown yet simply goes, the sub-stream under it stays); otherwise this tile goes over to the
   * sub-stream at once, for good, and says so.
   */
  #hdRefused() {
    if (this.opts.onHdRefused?.() === true) return
    this.streamType = SUB_STREAM
    // append, don't rewrite: the name element also holds the Recordings link in full screen
    this.tile.querySelector('.name')?.append(' (SD: full quality needs Live HD)')
    this.attempts = 0
    this.connect()
```
(the `}` that closed `connect()` now closes `#hdRefused()`).

- [ ] **Step 4: `cctv/public/live-mux.js`**

(a) Header, after the `{"op":"end",…}` line (13):
```js
//   server -> page, text:   {"op":"wait","id":N,"why":".."} (that channel's sub-stream has no picture yet,
//                           and this viewer is shown no main stream meanwhile: live-wait.mjs). Handed
//                           to the tile as a text message, as a /live socket's tile gets it
```
(b) Replace `control` (lines 328-347) with:
```js
function control(text) {
  let m
  try {
    m = JSON.parse(text)
  } catch {
    return
  }
  if (!Number.isInteger(m?.id)) return
  if (m.op === 'wait') {
    const ch = channels.get(m.id)
    if (!ch) return
    if (ch.opening) opened(ch)
    if (ch.readyState === 1) ch.onmessage?.({ data: text })
    return
  }
  if (m.op !== 'end') return
  const ch = channels.get(m.id)
  if (!ch) {
    // closed here already, and its unsub still waiting to go: the server has let the id go itself
    const i = unsubs.indexOf(m.id)
    if (i >= 0) unsubs.splice(i, 1)
    return
  }
  channels.delete(m.id)
  end(ch, Number.isInteger(m.code) ? m.code : 1011, String(m.reason ?? ''), true)
  flush() // (room for a channel held back by the limit)
  idle()
}
```

- [ ] **Step 5: `cctv/public/viewer.js`**

(a) `syncSingle`, lines 344-348:
```js
    // Live HD given or taken away: the view is built again, upgraded to the main stream or back on the
    // sub-stream with its SD badge (the server's sweep ends a main stream no longer allowed anyway)
    if (keep && Boolean(singleCam?.hd) === Boolean(cam.hd)) {
      for (const t of gridTiles) t.suspend()
      singleCam = cam
    } else openSingle(cam)
```
(b) The Recordings link, lines 602-608:
```js
  const links = document.createElement('span')
  links.className = 'links'
  // Recordings only for someone who may play this camera back (/api/cameras playback)
  if (cam.playback !== false) {
    const link = document.createElement('a')
    link.className = 'pb-link'
    link.href = `/playback.html?nvr=${encodeURIComponent(cam.nvr)}&ch=${cam.ch}`
    link.textContent = 'Recordings'
    link.addEventListener('click', (e) => e.stopPropagation())
    links.append(link)
  }
```
(c) Lines 707-708:
```js
  // full screen at full quality (the main stream) only with Live HD on the camera (/api/cameras hd;
  // the server refuses it anyway); cameras reached through TVT P2P or a VPN stay on the sub stream
  // (the relay has little bandwidth), as do browsers that could not play this main stream
  if (cam.hd !== false && !noMain.has(single) && !cam.remote) upgradeToMain(overlay, cam, sub, opts)
  else if (cam.hd === false) overlay.querySelector('.name').after(sdBadge())
```
(d) Before `function upgradeToMain` add:
```js
/** The full-size view's note that it stays on the sub-stream: no Live HD on this camera. */
function sdBadge() {
  const b = document.createElement('span')
  b.className = 'sd-badge'
  b.textContent = 'SD'
  b.title = 'Full screen at full quality needs Live HD on this camera'
  return b
}
```
(e) In `upgradeToMain`, the `onUnsupported: () => { … }` option gets a trailing comma, and after it add:
```js
    // refused for want of Live HD before it showed anything: this layer goes, the sub-stream under it
    // stays; once shown (its sub-stream closed), the tile goes over to the sub-stream itself (live-tile.js)
    onHdRefused: () => {
      if (!layer.classList.contains('pending')) return false
      main.close()
      layer.remove()
      return true
    }
```

- [ ] **Step 6: `cctv/public/grid-diff.js`, `login.js`, `style.css`**

grid-diff.js lines 31-36 (the doc) end with `online, name, remote, hd (true when that field changed; hd: Live HD given or taken away, which rebuilds the full-size view) }.`; lines 51-52 become:
```js
    const d = { online: was.online !== cam.online, name: was.name !== cam.name, remote: Boolean(was.remote) !== Boolean(cam.remote), hd: Boolean(was.hd) !== Boolean(cam.hd) }
    if (d.online || d.name || d.remote || d.hd) changed.push({ index, cam, ...d })
```
login.js, after `const error = document.getElementById('error')`:
```js
// Whoever signs in next starts with nothing the last user of this browser left behind: the live grid's
// last pictures (stills.js, cache "argus-stills") are kept per camera, not per user, and would show a
// camera this person may not open until its live picture replaced it
try {
  globalThis.caches?.delete('argus-stills').catch(() => {})
} catch {}
```
style.css, after line 762 (`.tile a.pb-link { … }`):
```css
/* the full-size view without Live HD stays on the sub-stream, and says so (viewer.js sdBadge) */
.tile .label .sd-badge { flex: none; margin-left: 6px; padding: 1px 6px; border-radius: 4px; background: rgba(255, 255, 255, .18); color: #fff; font-size: 11px; font-weight: 600; letter-spacing: .04em; }
```

- [ ] **Step 7: Run the tests**

Run: `node cctv/test/live-tile.test.mjs`, `node cctv/test/live-mux-client.test.mjs`, `node cctv/test/grid-diff.test.mjs`, `node cctv/test/map-cameras.test.mjs`, `node cctv/test/pages-shell.test.mjs`.
Expected: each ends `all passed` (or its own "all passed"/"FAILED" summary with no FAIL lines).

- [ ] **Step 8: Commit**

```bash
git add cctv/public/live-tile.js cctv/public/live-mux.js cctv/public/viewer.js cctv/public/grid-diff.js cctv/public/login.js cctv/public/style.css cctv/test/live-tile.test.mjs cctv/test/live-mux-client.test.mjs cctv/test/grid-diff.test.mjs
git commit -m "Live pages: wait notes shown and counted as activity, full screen on SD with a badge without Live HD, a refused main falls back once, Recordings only with a playback right" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The playback page offers only what the camera's rights allow

**Files:**
- Modify: `cctv/public/pb-sources.js` (`pickMode` `:112-137`, `serverQualityOptions` `:145-158`, `refusedMessage` `:227-237`, new `ALL_RIGHTS`, `pbRights`, `nvrQualityOptions`)
- Modify: `cctv/public/playback.js` (import `:29-53`, after `state` `:148-180`, `loadDay` `:336-338`, `loadNvrSide` `:451-453`, `updateModeUi` `:567-596`, `open` `:628-634`, `onStatus` `:676-686`, `watchStart` `:758`, `fallBackToNvr` `:776-777`, the camera list `:2234-2270`, `start` `:2289-2303`)
- Test: `cctv/test/pb-sources.test.mjs` (Windows)

**Interfaces:**
- Consumes: `/api/cameras?for=playback` with `sd`, `hd`, `nvrHd`, `legs` (Task 7); 1008 `'hd not allowed'` (Task 5).
- Produces (pb-sources.js):
  ```
  export const ALL_RIGHTS = { sd: true, hd: true, nvrHd: true, legs: true }   // frozen
  export function pbRights(cam): { sd, hd, nvrHd, legs }
  export function nvrQualityOptions({ nvrHd }): Array<[number, string]>
  export function serverQualityOptions({ remote, nvrLabel?, sd? = true }): Array<[string, string]>
  export function pickMode({ timeline, h265, quality, rights? = ALL_RIGHTS }): { mode: 'server'|'nvr'|'none', … }
  refusedMessage(1008, 'hd not allowed') -> string
  ```

- [ ] **Step 1: Write the failing tests (append to `cctv/test/pb-sources.test.mjs`, before the final `console.log`)**

The import list (lines 8-40) becomes:
```js
import {
  ALL_RIGHTS,
  CONVERTED_SCRUB_TIMEOUT_MS,
  LIVE_MARGIN_MS,
  NVR_REFUSAL_MAX_MS,
  NVR_REFUSAL_RETRY_MS,
  NVR_SPEEDS,
  NvrFallback,
  SCRUB_TIMEOUT_MS,
  SERVER_SPEEDS,
  SERVER_START_TIMEOUT_MS,
  ScrubThrottle,
  convertTime,
  describeSkew,
  fitChange,
  gapAt,
  liveEdge,
  mergeSources,
  nextStretch,
  nvrQualityOptions,
  nvrRetryDelay,
  pbRights,
  pickMode,
  prerollUntil,
  qualityForCam,
  recordedFrom,
  refusedMessage,
  scrubTimeoutMs,
  serverFailed,
  serverQualityOptions,
  serverSocketQuery,
  shift,
  speedFor,
  stretchAt,
  watchesStart
} from '../public/pb-sources.js'
```
Then:
```js
// ---- what this viewer may play of a camera (stream rights) ----------------------------------------------
{
  const J = JSON.stringify
  const all = pbRights(undefined)
  check('pbRights: a camera without flags (an older server) is everything, as before', all.sd && all.hd && all.nvrHd && all.legs)
  const sdOnly = pbRights({ sd: true, hd: false, nvrHd: false, legs: false })
  check('pbRights: the flags as sent', sdOnly.sd === true && sdOnly.hd === false && sdOnly.nvrHd === false && sdOnly.legs === false)
  check('pbRights: NVR HD and legs never without SD, whatever is sent', pbRights({ sd: false, hd: true, nvrHd: true, legs: true }).nvrHd === false && pbRights({ sd: false, hd: true, nvrHd: true, legs: true }).legs === false)
  check('nvrQualityOptions: HD only for someone who may see the NVR\'s main stream', J(nvrQualityOptions({ nvrHd: true })) === J([[1, 'SD (light)'], [0, 'HD']]) && J(nvrQualityOptions({ nvrHd: false })) === J([[1, 'SD (light)']]))
  check('serverQualityOptions: no "SD (NVR)" without Playback SD', J(serverQualityOptions({ remote: false, sd: false })) === J([['server', 'HD (server)']]) && J(serverQualityOptions({ remote: true, sd: false }).map(([v]) => v)) === J(['server', 'original']))
  const tl = { available: true, ranges: [[0, 10]], codec: 'h264' }
  const HD_ONLY = { sd: false, hd: true, nvrHd: false, legs: false }
  check('pickMode, Playback HD only: server playback as usual', pickMode({ timeline: tl, h265: true, quality: 'server', rights: HD_ONLY }).mode === 'server')
  check('... "SD (NVR)" left over from another camera is ignored (the NVR\'s copy is not theirs)', pickMode({ timeline: tl, h265: true, quality: 'sd-nvr', rights: HD_ONLY }).mode === 'server')
  const none = pickMode({ timeline: { available: true, ranges: [] }, h265: true, quality: 'server', rights: HD_ONLY })
  check('... a day with no server footage: "none", saying why (never NVR mode)', none.mode === 'none' && /no recordings of this camera on this day/i.test(none.why), J(none))
  check('... no server recordings at all: "none"', pickMode({ timeline: { available: false }, h265: true, quality: 'server', rights: HD_ONLY }).mode === 'none')
  check('pickMode with Playback SD, or with no rights given: as before', pickMode({ timeline: { available: false }, h265: true, quality: 'server' }).mode === 'nvr' && pickMode({ timeline: tl, h265: true, quality: 'sd-nvr', rights: ALL_RIGHTS }).mode === 'nvr')
  check('refusedMessage: "hd not allowed" says HD is needed here and who can give it (words for both refusals: main asked without the right, and no SD recording)', /HD stream/.test(refusedMessage(1008, 'hd not allowed') ?? '') && /Playback HD or Live HD/.test(refusedMessage(1008, 'hd not allowed') ?? ''))
  // the page (no DOM-free half to run here): where these are used
  const page = readFileSync(new URL('../public/playback.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const fn = (name) => page.slice(page.indexOf(`function ${name}(`), page.indexOf('\n}\n', page.indexOf(`function ${name}(`)))
  check('page: its cameras from /api/cameras?for=playback, at load and every 30 s', /api\('\/api\/cameras\?for=playback'\)/.test(page) && /fetch\('\/api\/cameras\?for=playback'\)/.test(page))
  check('  the day\'s mode is picked with this camera\'s rights (loadDay, start), and "none" is handled', (page.match(/rights: rightsNow\(\)/g) ?? []).length === 2 && /pick\.mode === 'none'/.test(fn('loadDay')))
  check('  the menus come from the rights', /nvrQualityOptions\(\{ nvrHd: r\.nvrHd \}\)/.test(fn('updateModeUi')) && /serverQualityOptions\(\{ remote: state\.remote, sd: r\.sd \}\)/.test(fn('updateModeUi')))
  check('  the NVR socket asks for main only with nvrHd', /stream=\$\{rightsNow\(\)\.nvrHd \? state\.stream : 1\}/.test(fn('open')))
  check('  {type:"stream"} says what plays and leaves the viewer\'s own choice alone', /state\.nvrMain = msg\.stream === 0/.test(fn('onStatus')) && !/state\.stream = msg\.stream/.test(fn('onStatus')))
  check('  without Playback SD: no NVR side, no going over to the NVR', /if \(!rightsNow\(\)\.sd\) return/.test(fn('loadNvrSide')) && /if \(!rightsNow\(\)\.sd \|\| !nvrFallback\.take\(sock\.cam\)\) return false/.test(fn('fallBackToNvr')))
}
```

- [ ] **Step 2: Run to see it fail**

Run: `node cctv/test/pb-sources.test.mjs`
Expected: `SyntaxError: … does not provide an export named 'ALL_RIGHTS'` (or `nvrQualityOptions`).

- [ ] **Step 3: `cctv/public/pb-sources.js`**

(a) Before `pickMode` (line 112) add:
```js
// ---- what this viewer may play of a camera (stream rights) -------------------------------------------
// /api/cameras?for=playback sends, per camera, sd (the NVR's copy: Playback SD), hd (the server's
// recordings: Playback HD), nvrHd (the NVR's main stream: Playback SD with Live HD or Playback HD) and
// legs (the server's gaps from the NVR). The page offers only what the server will play; the server
// decides again every time.

/** Everything, as before these flags: a camera from a server that sends none (an older release). */
export const ALL_RIGHTS = Object.freeze({ sd: true, hd: true, nvrHd: true, legs: true })

/** A camera's playback rights from its /api/cameras?for=playback entry. */
export function pbRights(cam) {
  if (!cam || typeof cam.sd !== 'boolean' || typeof cam.hd !== 'boolean') return ALL_RIGHTS
  return { sd: cam.sd, hd: cam.hd, nvrHd: cam.sd && cam.nvrHd === true, legs: cam.sd && cam.hd && cam.legs === true }
}

/** NVR mode's quality menu: SD, and HD only for someone who may see the NVR's main stream. */
export function nvrQualityOptions({ nvrHd }) {
  return nvrHd ? [[1, 'SD (light)'], [0, 'HD']] : [[1, 'SD (light)']]
}
```
(b) `pickMode` (lines 112-137): its JSDoc gains `rights: pbRights of the camera (default: everything)` and `@returns {{ mode: 'server'|'nvr'|'none', … }}` ('none': no Playback SD and nothing on the server), and its first lines become:
```js
export function pickMode({ timeline, h265, quality, rights = ALL_RIGHTS }) {
  const original = quality === 'original'
  // without Playback SD the NVR's copy is not this viewer's: a day without the server's footage has none
  const none = (why) => ({ mode: 'none', why })
  if (!timeline?.available) return rights.sd ? { mode: 'nvr', why: 'Server recordings are not available for this camera.' } : none('This camera has no recordings on this server that you may play back.')
  if (quality === 'sd-nvr' && rights.sd) return { mode: 'nvr', why: 'SD (NVR) chosen.' }
  if (!timeline.ranges?.length) return rights.sd ? { mode: 'nvr', why: 'The server has no recordings of this camera on this day.' } : none('The server has no recordings of this camera on this day.')
```
(the rest of `pickMode` is unchanged).
(c) `serverQualityOptions` (lines 145-158): JSDoc gains `sd: the viewer may play the NVR's copy (Playback SD); without it "SD (NVR)" is not offered`, and:
```js
export function serverQualityOptions({ remote, nvrLabel = 'SD (NVR)', sd = true }) {
  const options = remote
    ? [['server', 'HD (server, light)'], ['original', 'Original (server)'], ['sd-nvr', nvrLabel]]
    : [['server', 'HD (server)'], ['sd-nvr', nvrLabel]]
  return sd ? options : options.filter(([v]) => v !== 'sd-nvr')
}
```
(d) `refusedMessage`: after the `'not allowed'` line add:
```js
  // (the main stream asked for without the right, or no SD recording came: the server's own words say
  // which, but its error and the close can arrive in either order, so this one covers both)
  if (reason === 'hd not allowed') return 'Playing this from the NVR needs its HD stream here, which needs Playback HD or Live HD on this camera. An admin can give you either.'
```

- [ ] **Step 4: `cctv/public/playback.js`**

(a) The pb-sources import (lines 29-53) gains `nvrQualityOptions,` (after `nextStretch,`) and `pbRights,` (after `nvrRetryDelay,`).
(b) The `state` object gains, after `stream: 1,`:
```js
  nvrMain: false, // the NVR session said it plays its main stream ({type:'stream'}: a camera kept only in HD)
```
and after the object's closing `}` add:
```js
// This viewer's playback cameras, each with what it may play (/api/cameras?for=playback: sd, hd,
// nvrHd, legs; pb-sources.js pbRights), and the rights of the camera shown now. The page offers only
// what the server will play; the server decides again every time.
let playbackCams = []
const rightsNow = () => pbRights(playbackCams.find((c) => c.nvr === state.nvr && c.ch === state.ch))
```
(c) `loadDay`, line 336 and after `lastPick = pick`:
```js
  const pick = pickMode({ timeline: tl, h265: state.h265, quality: qualityForCam(camKey(), state.quality, nvrFallback.used), rights: rightsNow() })
  lastPick = pick
  if (pick.mode === 'none') {
    // without Playback SD a day the server has nothing of has nothing to play (the NVR is not asked)
    leaveServerMode()
    showMessage(pick.why)
    drawTimeline()
    return after?.()
  }
```
(d) `loadNvrSide`, after `clearTimeout(nvrSideTimer)` (line 452):
```js
  // without Playback SD the NVR is not this viewer's to ask (its clock, days and recordings): the
  // timeline's own time zone and skew are used, and there is no NVR-only stretch to draw
  if (!rightsNow().sd) return
```
(e) `updateModeUi`, lines 574-586 become:
```js
  const quality = qualityForCam(camKey(), state.quality, nvrFallback.used)
  const r = rightsNow()
  const kind = state.avail && (server || quality === 'sd-nvr') ? (state.remote ? 'server-remote' : 'server') : 'nvr'
  // rebuilt when the camera's rights change too (another camera, or the list read again)
  const sig = `${kind}|${r.sd}|${r.nvrHd}`
  if (qualitySel.dataset.sig !== sig) {
    if (kind !== 'nvr') setOptions(qualitySel, serverQualityOptions({ remote: state.remote, sd: r.sd }), server ? 'server' : 'sd-nvr')
    else setOptions(qualitySel, nvrQualityOptions({ nvrHd: r.nvrHd }), r.nvrHd ? state.stream : 1)
    qualitySel.dataset.kind = kind
    qualitySel.dataset.sig = sig
  }
  // (NVR mode with no Playback SD is a day with nothing to play: nothing to choose)
  qualitySel.disabled = kind === 'nvr' && !r.sd
  if (kind !== 'nvr') {
    qualitySel.value = !server ? 'sd-nvr' : quality === 'original' && state.remote ? 'original' : 'server'
    // a camera the NVR records in HD only plays HD for "SD (NVR)" ({type:'stream'})
    const label = !server && state.nvrMain ? 'HD (NVR)' : 'SD (NVR)'
    const nvrOpt = [...qualitySel.options].find((o) => o.value === 'sd-nvr')
    if (nvrOpt && nvrOpt.textContent !== label) nvrOpt.textContent = label
  }
  // motion search reads the NVR's copy: only with Playback SD
  const search = document.getElementById('searchToggle')
  if (search) search.hidden = !r.sd
```
(f) `open`, lines 628-634: at the top of the function add `state.nvrMain = false` and the socket URL becomes:
```js
  const sock = new WebSocket(`${proto}://${location.host}/playback?${nvrQ()}&ch=${state.ch}&stream=${rightsNow().nvrHd ? state.stream : 1}&start=${start}&h265=${state.h265 ? 1 : 0}`)
```
(g) `onStatus`, the `'stream'` branch (lines 678-686) becomes:
```js
  if (msg.type === 'stream') {
    // this camera records HD only; the server switched over (only for a viewer who may see main). What
    // plays is shown; the viewer's own choice (state.stream) stays, so the next camera is not asked
    // for main because this one is HD only
    state.nvrMain = msg.stream === 0
    if (qualitySel.dataset.kind !== 'nvr') return updateModeUi() // ("SD (NVR)" chosen: relabelled)
    const hd = [...qualitySel.options].find((o) => o.value === '0')
    if (hd) {
      hd.disabled = false
      qualitySel.value = '0'
    }
  }
```
(h) `watchStart`, line 758:
```js
    if (!fallBackToNvr(sock, slow)) showMessage(rightsNow().sd ? `${slow}: its recordings may be unreachable. Choose "SD (NVR)" to play the NVR's copy.` : `${slow}: its recordings may be unreachable.`)
```
(i) `fallBackToNvr`, line 777:
```js
  // the NVR's copy only for someone who may play it (Playback SD); anyone else keeps the server's message
  if (!rightsNow().sd || !nvrFallback.take(sock.cam)) return false
```
(j) The camera list (lines 2234 and 2264-2271):
```js
const [me, cameras] = await Promise.all([api('/api/me'), api('/api/cameras?for=playback')])
playbackCams = cameras
```
and
```js
setInterval(async () => {
  const list = await fetch('/api/cameras?for=playback').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  if (!Array.isArray(list)) return
  const was = JSON.stringify(rightsNow())
  playbackCams = list
  fillCameraList(list, cameraSel.value || null)
  // this camera's rights changed (given or taken away): the menus follow at once
  if (JSON.stringify(rightsNow()) !== was) updateModeUi()
}, 30_000)
if (!first) {
  showMessage(me.admin ? 'No cameras yet. Add an NVR with: docker exec -it tvt-cctv node cctv/nvr.mjs add' : 'No cameras have been shared with you for playback yet. Ask an admin for access.')
  throw new Error('no cameras')
}
```
(k) `start`: line 2289's `pickMode({ … })` gains `, rights: rightsNow()` inside its object, and just before `const busy = await loadNvrInfo()` add:
```js
  // without Playback SD there is no NVR side: the day says what the server has (pickMode 'none')
  if (!rightsNow().sd) return loadDay(() => {})
```

- [ ] **Step 5: Run the tests**

Run: `node cctv/test/pb-sources.test.mjs` — expected `all passed` (the existing pins: three `qualityForCam(camKey(), state.quality, nvrFallback.used)`, two `refusedMessage` close handlers, `serverQualityOptions({ remote: state.remote` — still hold).
Also: `node cctv/test/pb-transport.test.mjs`, `node cctv/test/pb-view.test.mjs` — `all passed`.

- [ ] **Step 6: Commit**

```bash
git add cctv/public/pb-sources.js cctv/public/playback.js cctv/test/pb-sources.test.mjs
git commit -m "Playback page: cameras by playback right; NVR HD, SD (NVR), NVR mode, motion search and the NAS fallback only where the camera's rights allow" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The camera wall plays each tile from what its camera's rights allow

**Files:**
- Modify: `cctv/public/pb-sources.js` (new `wallQualities`, `wallTileMode`, after `nvrQualityOptions` from Task 9)
- Modify: `cctv/public/wall.js` (import `:22`, `Tile` constructor `:180-182`, `mode()` `:262-265`, `loadDay` `:269-277`, `sock.onclose` `:402-404`, `showPage` `:564`, the tile factory `:578`, new `updateQualityChoices`, the camera list `:1400`)
- Test: `cctv/test/pb-sources.test.mjs` (Windows)

**Interfaces:**
- Consumes: `pbRights`, `refusedMessage` (Task 9); `/api/cameras?for=playback` (Task 7); 1008 refusals (Task 5).
- Produces (pb-sources.js):
  ```
  export function wallQualities(rights: Array<{sd, hd}>, current: 'sd'|'hd'): { options: Array<[string, string]>, value: 'sd'|'hd' }
  export function wallTileMode({ rights, quality, available, codec, h265 }): 'server'|'nvr'
  ```

- [ ] **Step 1: Write the failing tests (append to `cctv/test/pb-sources.test.mjs`, before the final `console.log`; `wallQualities,` and `wallTileMode,` join the import list, in that order just before `watchesStart`)**

```js
// ---- the camera wall (stream rights) -----------------------------------------------------------------------
{
  const J = JSON.stringify
  const SD = { sd: true, hd: false }
  const HD = { sd: false, hd: true }
  const BOTH = { sd: true, hd: true }
  check('wallQualities: nothing chosen yet: both choices, as before', J(wallQualities([], 'sd').options.map(([v]) => v)) === J(['sd', 'hd']))
  check('... only HD-only cameras chosen: HD alone, and chosen', J(wallQualities([HD, HD], 'sd')) === J({ options: [['hd', 'HD (server recordings)']], value: 'hd' }))
  check('... only SD-only cameras: SD alone', J(wallQualities([SD], 'hd')) === J({ options: [['sd', 'SD (NVR sub-streams)']], value: 'sd' }))
  check('... a mix: both, the choice kept', J(wallQualities([SD, HD], 'hd').options.map(([v]) => v)) === J(['sd', 'hd']) && wallQualities([SD, BOTH], 'hd').value === 'hd')
  const tile = (o) => wallTileMode({ quality: 'sd', available: true, codec: 'h264', h265: true, ...o })
  check('wallTileMode: Playback HD only: the server\'s recordings whatever the Quality', tile({ rights: HD }) === 'server' && tile({ rights: HD, available: false }) === 'server')
  check('... Playback SD only: the NVR\'s sub-stream whatever the Quality', tile({ rights: SD, quality: 'hd' }) === 'nvr')
  check('... both: the Quality decides; the server only with its recordings in a codec this browser plays (as before)', tile({ rights: BOTH, quality: 'hd' }) === 'server' && tile({ rights: BOTH }) === 'nvr' && tile({ rights: BOTH, quality: 'hd', codec: 'h265', h265: false }) === 'nvr' && tile({ rights: BOTH, quality: 'hd', available: false }) === 'nvr')
  const wall = readFileSync(new URL('../public/wall.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  check('wall: its cameras from /api/cameras?for=playback', /api\('\/api\/cameras\?for=playback'\)/.test(wall))
  check('wall: each tile knows its camera\'s rights and plays from what they allow', /rights: pbRights\(cam\)/.test(wall) && /return wallTileMode\(\{ rights: this\.rights, /.test(wall))
  check('wall: a 1008 refusal is said on the tile, and final', /if \(e\.code === 1008\) \{\n\s*this\.error = refusedMessage\(e\.code, e\.reason\)/.test(wall))
  check('wall: the Quality menu follows the chosen cameras\' rights', /wallQualities\(rights, state\.quality\)/.test(wall) && /function showPage\(\) \{\n\s*updateQualityChoices\(\)/.test(wall))
}
```

- [ ] **Step 2: Run to see it fail**

Run: `node cctv/test/pb-sources.test.mjs`
Expected: `SyntaxError: … does not provide an export named 'wallQualities'`.

- [ ] **Step 3: `cctv/public/pb-sources.js`: add after `nvrQualityOptions`**

```js
/**
 * The camera wall's Quality menu from the chosen cameras' rights: "SD (NVR sub-streams)" when one of
 * them may play the NVR's copy, "HD (server recordings)" when one may play the server's. The value is
 * the current choice while it is offered, else the first offered (HD for a wall of HD-only cameras).
 * With no camera chosen yet, both, as before.
 * @param {Array<{ sd: boolean, hd: boolean }>} rights
 * @param {'sd'|'hd'} current
 * @returns {{ options: Array<[string, string]>, value: 'sd'|'hd' }}
 */
export function wallQualities(rights, current) {
  const any = (k) => rights.length === 0 || rights.some((r) => r[k])
  const options = [...(any('sd') ? [['sd', 'SD (NVR sub-streams)']] : []), ...(any('hd') ? [['hd', 'HD (server recordings)']] : [])]
  const value = options.some(([v]) => v === current) ? current : (options[0]?.[0] ?? current)
  return { options, value }
}

/**
 * Where one wall tile's pictures come from. Playback HD only: always the server's recordings (the
 * tile says so when there are none); Playback SD only: always the NVR's sub-stream; both: the wall's
 * Quality, the server's only when it has this camera's recordings in a codec this browser plays.
 * @returns {'server'|'nvr'}
 */
export function wallTileMode({ rights, quality, available, codec, h265 }) {
  if (!rights.sd) return 'server'
  if (quality === 'hd' && rights.hd && available && !(codec === 'h265' && !h265)) return 'server'
  return 'nvr'
}
```

- [ ] **Step 4: `cctv/public/wall.js`**

(a) Line 22:
```js
import { describeSkew, mergeSources, pbRights, recordedFrom, refusedMessage, wallQualities, wallTileMode } from './pb-sources.js'
```
(b) `Tile` constructor, after `Object.assign(this, cam)`:
```js
    this.rights ??= pbRights(null) // what this camera may be played from (/api/cameras?for=playback)
```
(c) `mode()` (lines 262-265):
```js
  mode() {
    return wallTileMode({ rights: this.rights, quality: state.quality, available: this.available, codec: this.codec, h265: state.h265 })
  }
```
(d) `loadDay`, after `this.available = tl.available === true`:
```js
      // Playback HD only: the server's recordings or nothing (the NVR's copy is not this viewer's)
      if (!this.available && !this.rights.sd) this.error = 'No recordings of this camera on this server that you may play back.'
```
(e) `sock.onclose`, after `this.ws = null`:
```js
      // refused (the camera's rights, the session): said on the tile, and final -- status() is then
      // 'error', so the tile no longer asks; the refusal would only repeat
      if (e.code === 1008) {
        this.error = refusedMessage(e.code, e.reason) ?? 'The server refused this camera.'
        return
      }
```
(f) Before `function showPage()` add, and make it the first line of `showPage()`:
```js
/**
 * The Quality menu offers what the chosen cameras' rights allow (pb-sources.js wallQualities); a choice
 * no chosen camera allows any more moves to one that is, and the tiles reopen on it.
 */
function updateQualityChoices() {
  const rights = state.cameras.map((key) => pbRights(state.all.find((c) => `${c.nvr}/${c.ch}` === key)))
  const { options, value } = wallQualities(rights, state.quality)
  const sig = options.map(([v]) => v).join()
  if (qualitySel.dataset.sig !== sig) {
    qualitySel.replaceChildren(...options.map(([v, label]) => new Option(label, v)))
    qualitySel.dataset.sig = sig
  }
  qualitySel.value = value
  if (value !== state.quality) {
    state.quality = value
    for (const t of state.tiles) {
      t.close()
      t.position = null
    }
  }
}
```
```js
function showPage() {
  updateQualityChoices()
  const page = pageOf(state.cameras, state.layout, state.page)
```
(g) The tile factory (line 578):
```js
    return new Tile({ nvr, ch, name: cam?.name ?? `Channel ${ch + 1}`, nvrName: cam?.nvrName ?? nvr, site: cam?.site ?? '', rights: pbRights(cam) })
```
(h) Line 1400:
```js
const [me, cameras] = await Promise.all([api('/api/me'), api('/api/cameras?for=playback')])
```

- [ ] **Step 5: Run the tests**

Run: `node cctv/test/pb-sources.test.mjs`, `node cctv/test/wall-clock.test.mjs`, `node cctv/test/grid-view.test.mjs`.
Expected: each `all passed`.

- [ ] **Step 6: Commit**

```bash
git add cctv/public/pb-sources.js cctv/public/wall.js cctv/test/pb-sources.test.mjs
git commit -m "Camera wall: cameras by playback right, each tile from what its rights allow, Quality choices from the chosen cameras, a 1008 refusal final" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: The access editor — five columns, Live HD needs Live, the owner's names, phone layout

**Files:**
- Modify: `cctv/public/access-model.js` (header `:6-21`, `:27-36`, new `COLUMN_TITLES`, `HEAD_ROWS`, `ALSO_ON`, `ALSO_OFF`, `toggle` `:206-220`, `:281-299` (`RANK`, `WORD`, `playbackCell`, `cellsOf`, `KEPT_LABELS`), `keptList` `:302-314`, `view` `:321-353`, `click` doc `:367-370`)
- Modify: `cctv/public/audit.js` (import `:15`, `renderRights` `:106-130`, `paintRights` `:196-210`, `paintAccess` `:284-324`, `drawTree` `:327-390`)
- Modify: `cctv/public/audit.html:52` (the Rights table's class), `:103` (the tree's header)
- Modify: `cctv/public/style.css:1827-1830` and the `@media (max-width: 560px)` block `:1859-1865`
- Test: `cctv/test/access-model.test.mjs`, `cctv/test/rights.test.mjs` (the render block), `cctv/test/audit.test.mjs` (all Windows)

**Interfaces:**
- Consumes: `live-hd` in `GRANTABLE` (Task 1a); `can`'s Live HD only with Live (Task 1a).
- Produces (access-model.js):
  ```
  export const COLUMNS = ['live', 'live-hd', 'playback-nvr', 'playback-server', 'export']
  export const COLUMN_LABELS = { live: 'Live', 'live-hd': 'Live HD', 'playback-nvr': 'Playback SD', 'playback-server': 'Playback HD', export: 'Export' }
  export const COLUMN_TITLES: Record<column, string>
  export const HEAD_ROWS: [[{ text, rowspan?, colspan?, column?, rowhead? }], [...]]
  toggle(state, tree, column, target, on)   // column is one of COLUMNS; live-hd on also ticks live, live off also unticks live-hd
  // audit.js renderRights(d) -> { actions (COLUMNS order), labels, formats, users, admins, note }
  ```

- [ ] **Step 1: Update `cctv/test/access-model.test.mjs`**

(a0) Line 94 (in `'*' ticks everything`) names the columns there are now:
```js
  check('...and nothing in the other columns (Live HD, Playback SD, Playback HD, Export)', v.sites.every((s) => ['live-hd', 'playback-nvr', 'playback-server', 'export'].every((c) => s.cells[c].state === 'off')) && ['live-hd', 'playback-nvr', 'playback-server'].every((c) => v.all[c].state === 'off'))
```
(a) Replace the whole block `// ---- Playback is two rights ---…` (lines 161-192) with:
```js
// ---- five columns, one right each; Live HD needs Live ---------------------------------------------------
{
  check('five columns in the owner\'s order, with their full names and meanings', J(M.COLUMNS) === J(['live', 'live-hd', 'playback-nvr', 'playback-server', 'export']) && J(M.COLUMNS.map((c) => M.COLUMN_LABELS[c])) === J(['Live', 'Live HD', 'Playback SD', 'Playback HD', 'Export']) && M.COLUMNS.every((c) => typeof M.COLUMN_TITLES[c] === 'string' && M.COLUMN_TITLES[c].startsWith(M.COLUMN_LABELS[c])))
  check('the columns are every grantable right, once', J([...M.COLUMNS].sort()) === J([...M.GRANTABLE].sort()))
  const [top, sub] = M.HEAD_ROWS
  check('two header rows: Live (Grid, HD), Playback (SD, HD), Export', J(top.map((h) => h.text)) === J(['Site / camera', 'Live', 'Playback', 'Export']) && J(sub.map((h) => [h.text, h.column])) === J([['Grid', 'live'], ['HD', 'live-hd'], ['SD', 'playback-nvr'], ['HD', 'playback-server']]) && top[0].rowspan === 2 && top[0].rowhead === true && top[1].colspan === 2 && top[2].colspan === 2 && top[3].rowspan === 2 && top[3].column === 'export')
  const hdOn = M.toggle(M.fromRow(row({ live: ['nvr1/3'] }), tree), tree, 'live-hd', 'nvr1', true)
  check('ticking Live HD on a site ticks Live there too (HD needs Live)', J(grantsOf(hdOn)['live-hd']) === J(['nvr1']) && J(grantsOf(hdOn).live) === J(['nvr1']), J(grantsOf(hdOn)))
  const hdCam = M.toggle(M.fromRow(row(), tree), tree, 'live-hd', 'solus/1', true)
  check('... on one camera: Live on that camera only', J(grantsOf(hdCam).live) === J(['solus/1']) && J(grantsOf(hdCam)['live-hd']) === J(['solus/1']))
  const hdAll = M.toggle(M.fromRow(row(), tree), tree, 'live-hd', '*', true)
  check("... on All sites: '*' for both", J(grantsOf(hdAll).live) === J(['*']) && J(grantsOf(hdAll)['live-hd']) === J(['*']))
  const liveOff = M.toggle(hdAll, tree, 'live', 'nvr1/0', false)
  const cam0 = M.view(liveOff, tree).sites.find((s) => s.nvr === 'nvr1').cameras[0]
  check('unticking Live on a camera unticks Live HD there too, and nothing else', cam0.cells['live-hd'].state === 'off' && J(grantsOf(liveOff)['live-hd']) === J(grantsOf(liveOff).live), J(grantsOf(liveOff)))
  const hdOff = M.toggle(hdAll, tree, 'live-hd', 'solus', false)
  check('unticking Live HD leaves Live as it was', J(grantsOf(hdOff).live) === J(['*']) && !grantsOf(hdOff)['live-hd'].includes('*'))
  const pbSd = M.toggle(M.fromRow(row(), tree), tree, 'playback-nvr', 'nvr1', true)
  check('Playback SD is the NVR\'s copy alone, Playback HD the server\'s alone', J(grantsOf(pbSd)['playback-nvr']) === J(['nvr1']) && grantsOf(pbSd)['playback-server'].length === 0 && J(grantsOf(M.toggle(pbSd, tree, 'playback-server', 'nvr1', true))['playback-server']) === J(['nvr1']))
  const stray = M.view(M.fromRow(row({ 'live-hd': ['nvr1/2'] }), tree), tree)
  const cam2 = stray.sites.find((s) => s.nvr === 'nvr1').cameras.find((c) => c.ch === 2)
  check('a stored Live HD tick where Live is not: noted "no effect without Live", and warned about', cam2.cells['live-hd'].state === 'on' && /no effect without Live/.test(cam2.cells['live-hd'].note) && stray.warnings.some((w) => /Live HD is ticked where Live is not/.test(w)), J(cam2.cells))
  check('... none of that for Live HD with Live', M.view(hdOn, tree).warnings.length === 0 && M.view(hdOn, tree).sites.find((s) => s.nvr === 'nvr1').cells['live-hd'].note === '')
  check('a column the editor does not have changes nothing', M.toggle(hdOn, tree, 'playback', 'nvr1', true) === hdOn)
}
```
(b) In the click block (lines 196-207): `M.cellAt(v, 'playback', 'solus')` becomes `M.cellAt(v, 'playback-nvr', 'solus')`, and replace its two Playback checks (lines 202-204) with:
```js
  const pb = M.click(st, tree, 'playback-nvr', 'solus')
  check('a click on a ticked Playback SD box takes it away, and only it', J(grantsOf(pb)['playback-nvr']) === '[]' && J(grantsOf(pb)['playback-server']) === '[]')
  check('a second click gives it back, and only it', J(grantsOf(M.click(pb, tree, 'playback-nvr', 'solus'))['playback-nvr']) === J(['solus']) && J(grantsOf(M.click(pb, tree, 'playback-nvr', 'solus'))['playback-server']) === '[]')
  check('a click on Live HD ticks Live too', J(grantsOf(M.click(st, tree, 'live-hd', 'nvr1/1')).live) === J(['nvr1/0', 'nvr1/1']))
```
(c) Line 218: `J(kept.gone.columns) === J(['Live', 'Playback HD'])`.
(d) The random test (lines 288-310): `columns[rnd(3)]` becomes `columns[rnd(columns.length)]`, and the `want`/compare lines become:
```js
      const want = Object.fromEntries(columns.map((col) => [col, covers(out.grants[col])]))
      for (const col of columns) if ((cells[col].state === 'on') !== want[col]) bad = bad ?? { i, cam: `${n.nvr}/${c.ch}`, col, cell: cells[col], out }
      // the editor keeps Live HD inside Live: never HD on a camera without Live
      if (want['live-hd'] && !want.live) bad = bad ?? { i, cam: `${n.nvr}/${c.ch}`, hdWithoutLive: true, out }
```
and the check's name becomes `'3000 random clicks: every row is already clean, every camera tick matches the row, and Live HD stays inside Live'`.

- [ ] **Step 2: Add the Rights table check to `cctv/test/rights.test.mjs`**

In the block `// ---- the rights screen's render`, after `const r = renderRights(body)`:
```js
  check('the Rights table uses the editor\'s names, in its order', JSON.stringify(r.labels) === JSON.stringify(['Live', 'Live HD', 'Playback SD', 'Playback HD', 'Export']) && JSON.stringify(r.actions) === JSON.stringify(['live', 'live-hd', 'playback-nvr', 'playback-server', 'export']))
  check('... an action it does not know goes last, under its own key', renderRights({ actions: ['live', 'live-4k'], users: [], formats: [] }).labels.join() === 'Live,live-4k')
```

- [ ] **Step 3: Run to see them fail**

Run: `node cctv/test/access-model.test.mjs` — expected FAIL on the five-column checks (`COLUMNS` is still three).
Run: `node cctv/test/rights.test.mjs` — expected FAIL on the two render checks.

- [ ] **Step 4: `cctv/public/access-model.js`**

(a) Header lines 6-21: the row line becomes `// The row is rights.mjs's own: { admin, grants: { live, 'live-hd', 'playback-server', 'playback-nvr', export },` and the third rule becomes:
```js
//   - Live HD counts only with Live on the same camera (rights.mjs can): ticking it ticks Live there
//     too, unticking Live unticks it, and unticking Live HD leaves Live. Every other column is one
//     stored right: Playback SD the NVR's recordings (playback-nvr), Playback HD this server's
//     (playback-server).
```
(b) Replace lines 27-36 (from GRANTABLE's doc comment, two lines since Task 1a, `/** The per-camera rights rights.mjs knows … Live HD has no`, through `const COLUMN_ACTIONS = …`) with:
```js
/** The per-camera rights rights.mjs knows ('admin' is the account's role, not a grant). */
export const GRANTABLE = Object.freeze(['live', 'live-hd', 'playback-server', 'playback-nvr', 'export'])
/** Export formats, in rights.mjs's order (it saves them in this order whatever order they are ticked). */
export const FORMATS = Object.freeze(['pack', 'mp4', 'stills'])
export const FORMAT_LABELS = Object.freeze({ pack: 'Evidence pack', mp4: 'MP4', stills: 'Stills' })

/** The editor's tick columns, in the owner's order: one stored right each. */
export const COLUMNS = Object.freeze(['live', 'live-hd', 'playback-nvr', 'playback-server', 'export'])
/** Each column's full name: a box's aria-label, the Rights table's header, "Kept from before". */
export const COLUMN_LABELS = Object.freeze({ live: 'Live', 'live-hd': 'Live HD', 'playback-nvr': 'Playback SD', 'playback-server': 'Playback HD', export: 'Export' })
/** What each column means, in a box's title and its header's. */
export const COLUMN_TITLES = Object.freeze({
  live: 'Live: the grid, on the camera\'s sub-stream as the NVR is set',
  'live-hd': 'Live HD: full screen at full quality (the camera\'s main stream); needs Live',
  'playback-nvr': 'Playback SD: the NVR\'s own recordings',
  'playback-server': 'Playback HD: this server\'s own recordings, at full quality',
  export: 'Export: clips of this server\'s recordings, always at full quality'
})
/**
 * The tree's two header rows (audit.js draws them): the columns grouped, then each column's short name.
 * A cell with `column` heads that column; `rowhead` is the column of row names.
 */
export const HEAD_ROWS = Object.freeze([
  Object.freeze([{ text: 'Site / camera', rowspan: 2, rowhead: true }, { text: 'Live', colspan: 2 }, { text: 'Playback', colspan: 2 }, { text: 'Export', rowspan: 2, column: 'export' }]),
  Object.freeze([{ text: 'Grid', column: 'live' }, { text: 'HD', column: 'live-hd' }, { text: 'SD', column: 'playback-nvr' }, { text: 'HD', column: 'playback-server' }])
])
// Live HD counts only with Live on the same camera: ticking it ticks Live there too, unticking Live
// unticks it (unticking Live HD leaves Live alone)
const ALSO_ON = Object.freeze({ 'live-hd': ['live'] })
const ALSO_OFF = Object.freeze({ live: ['live-hd'] })
```
and after the other note constants (after line 45) add:
```js
const NO_LIVE = 'no effect without Live'
```
(c) Replace `toggle` (lines 206-220):
```js
/**
 * One box ticked (on true) or unticked. column: one of COLUMNS (Live HD also ticks Live, and Live also
 * unticks Live HD, on the same target). target: '*' for All sites, an NVR id for a site row, 'nvr/ch'
 * for a camera row. A column or target the tree does not have changes nothing.
 */
export function toggle(state, tree, column, target, on) {
  const t = cleanTarget(target)
  const idx = indexOf(tree)
  if (!COLUMNS.includes(column) || !t) return state
  if (t !== '*' && !(t.includes('/') ? idx.nvrs.get(nvrOf(t))?.keys.includes(t) : idx.nvrs.has(t))) return state
  const next = copyState(state)
  const also = (on === true ? ALSO_ON : ALSO_OFF)[column] ?? []
  for (const a of [column, ...also]) next.grants[a] = apply(next.grants[a], t, on === true, idx)
  return next
}
```
(d) Replace lines 281-299 (`RANK`, `WORD`, `playbackCell`, `cellsOf`, `KEPT_LABELS`) with:
```js
/** Every column's cell; a Live HD box on where Live is off (only stored data can do that) says so. */
function cellsOf(one) {
  const cells = Object.fromEntries(COLUMNS.map((c) => [c, one(c)]))
  if (cells['live-hd'].state !== 'off' && cells.live.state === 'off') cells['live-hd'] = { ...cells['live-hd'], note: NO_LIVE }
  return cells
}

/** Whether one stored right covers one camera of the tree: '*', its site, itself, or a kept target of them. */
const coversKey = (c, nvr, key) => c.all || c.nvrs.includes(nvr) || c.cams.includes(key) || c.kept.includes(nvr) || c.kept.includes(key)
```
(e) `keptList` (lines 302-314): delete the `const both = …` and `const columns = …` lines, and its `return` becomes:
```js
    return { target: t, text, reason: site && site.keys.length === 0 ? UNLISTED : GONE, columns: COLUMNS.filter((c) => actions.includes(c)).map((c) => COLUMN_LABELS[c]) }
```
(f) In `view`, after the export-format warning add:
```js
  // Live HD where Live is not (kept from before, or hand-edited): it grants nothing there
  const hdAlone = [...idx.nvrs.values()].some(({ node, keys }) => keys.some((key) => coversKey(g['live-hd'], node.nvr, key) && !coversKey(g.live, node.nvr, key)))
  if (!state.admin && hdAlone) warnings.push('Live HD is ticked where Live is not (kept from before): it has no effect there. Tick Live there, or untick Live HD.')
```
and `adminNote` becomes `'An admin may watch (at full quality), play back and export everything, on every site and camera, in any format, and can change all of this. Switch Admin off to choose what they may see.'`
(g) `click`'s doc (lines 367-370): `/** A click on a box: a ticked box is unticked, a part-ticked or empty one ticked, like any checkbox. */`

- [ ] **Step 5: `cctv/public/audit.js`, `audit.html`, `style.css`**

(a) audit.js line 15:
```js
import { COLUMNS, COLUMN_LABELS, COLUMN_TITLES, FORMATS, FORMAT_LABELS, HEAD_ROWS, buildTree, click, copyFrom, copySources, dropKept, fromRow, sameRow, setAdmin, setAll, setFormat, toRow, view } from './access-model.js'
```
(b) `renderRights` (lines 106-130): its first line becomes
```js
  const sent = (Array.isArray(d?.actions) ? d.actions : []).filter((a) => a !== 'admin')
  // the editor's order and names (access-model.js); an action this page does not know (a newer
  // server) goes last, under its own key
  const actions = [...COLUMNS.filter((a) => sent.includes(a)), ...sent.filter((a) => !COLUMNS.includes(a))]
```
and its return gains `labels: actions.map((a) => COLUMN_LABELS[a] ?? a),` after `actions,`.
(c) `paintRights` (lines 196-210):
```js
  const paintRights = (d) => {
    const r = renderRights(d)
    id('rightsNote').textContent = r.note
    const heads = ['User', 'Admin', ...r.labels, 'Export formats']
    const head = el('tr')
    for (const h of heads) head.append(el('th', { textContent: h }))
    id('rightsHead').replaceChildren(head)
    // each cell carries its column's name: on a phone the table is one card per user (style.css)
    const td = (text, i, className = '') => {
      const c = el('td', { textContent: text, className })
      c.dataset.label = heads[i]
      return c
    }
    id('rightsRows').replaceChildren(...r.users.map((u) => {
      const tr = el('tr')
      tr.append(td(u.user, 0), td(u.admin ? 'yes' : 'no', 1, u.admin ? 'warn' : ''))
      u.cells.forEach((c, i) => tr.append(td(c.text, i + 2)))
      tr.append(td(u.formatText, heads.length - 1))
      return tr
    }))
  }
```
(d) `paintAccess`: replace the `set` helper and the loop after it (lines 293-307) with:
```js
    // parent: the site's cell, whose note a camera does not repeat (every camera of a site stored
    // as NVR playback only would otherwise say so twenty times over)
    const rowNotes = new Map() // target -> ['Live HD: no effect without Live', …] (the row header, on phones)
    const set = (col, target, cell, parent = null) => {
      const box = ac.boxes.get(`${col} ${target}`)
      if (!box) return
      box.cb.checked = cell.state === 'on'
      box.cb.indeterminate = cell.state === 'some'
      const note = parent && parent.note === cell.note ? '' : cell.note
      box.note.textContent = note
      box.cb.title = cell.note ? `${COLUMN_TITLES[col]}. ${cell.note}` : COLUMN_TITLES[col]
      if (note) rowNotes.set(target, [...(rowNotes.get(target) ?? []), `${COLUMN_LABELS[col]}: ${note}`])
    }
    for (const col of COLUMNS) {
      set(col, '*', v.all[col])
      for (const s of v.sites) {
        set(col, s.nvr, s.cells[col])
        for (const c of s.cameras) set(col, c.key, c.cells[col], s.cells[col])
      }
    }
    for (const [target, small] of ac.rowNotes) small.textContent = (rowNotes.get(target) ?? []).join(' · ')
```
(e) `drawTree`: after `ac.boxes = new Map()` add:
```js
    ac.rowNotes = new Map() // target -> its row header's line of notes (shown on phones instead of per box)
    // the two header rows from the model, so the columns and their names cannot disagree
    id('ac-head').replaceChildren(...HEAD_ROWS.map((row) => {
      const tr = el('tr')
      for (const h of row) {
        const th = el('th', { textContent: h.text, className: h.column ? 'ac-col' : h.rowhead ? 'ac-rowhead' : 'ac-group' })
        th.scope = h.colspan ? 'colgroup' : 'col'
        if (h.rowspan) th.rowSpan = h.rowspan
        if (h.colspan) th.colSpan = h.colspan
        if (h.column) {
          th.title = COLUMN_TITLES[h.column]
          th.setAttribute('aria-label', COLUMN_LABELS[h.column])
        }
        tr.append(th)
      }
      return tr
    }))
```
`rowHead` takes the row's target and carries its notes line:
```js
    const rowHead = (text, sub, target) => {
      const head = el('div', { className: 'ac-head' })
      const notes = el('small', { className: 'ac-row-notes' })
      ac.rowNotes.set(target, notes)
      head.append(el('span', { className: 'ac-name', textContent: text }), el('small', { textContent: sub }), notes)
      const th = el('th', { scope: 'row' })
      th.append(head)
      return th
    }
```
and its three callers pass the target: `rowHead('All sites', 'everything, sites added later included', '*')`, `rowHead(s.site, `${s.name !== s.site ? `${s.name} · ` : ''}${count}`, s.nvr)`, `rowHead(c.name, `camera ${c.ch + 1}`, c.key)`. In `cellTd` the checkbox gets its meaning as a title: `const cb = el('input', { type: 'checkbox', title: COLUMN_TITLES[col] })`.
(f) audit.html line 103 becomes `<thead id="ac-head"></thead>` and line 52 becomes `<table class="hp-table rights-table">`.
(g) style.css: line 1828 `.ac-tree thead th:first-child { text-align: left; }` becomes `.ac-tree thead th.ac-rowhead { text-align: left; }`; line 1830 `.ac-tree thead th:not(:first-child) { width: 116px; }` becomes `.ac-tree thead th.ac-col { width: 116px; }`; after it add:
```css
/* two header rows (audit.js, from access-model.js HEAD_ROWS): the second sticks under the first */
.ac-tree thead tr:nth-child(2) th { top: var(--ac-head-row, 29px); font-size: var(--fs-meta); }
.ac-tree thead th.ac-group { border-bottom: 1px solid var(--border); }
.ac-row-notes { display: none; color: var(--warn); font-size: 11px; line-height: 1.25; }
```
and the `@media (max-width: 560px)` block (lines 1859-1865) becomes:
```css
@media (max-width: 560px) {
  .ac-dialog { width: calc(100vw - 16px); padding: 10px; }
  .ac-tree thead th.ac-col { width: 44px; }
  .ac-tree td { padding: 6px 2px; }
  .ac-tree input[type="checkbox"] { width: 22px; height: 22px; }
  .ac-cam th { padding-left: 12px; }
  .ac-dialog .ac-copy { margin-left: 0; }
  /* five boxes of 44 px leave no room for a note under each: they are said in the row's header */
  .ac-tree td .ac-note { display: none; }
  .ac-row-notes:not(:empty) { display: block; }
  /* the Rights table: one card per user */
  .rights-table, .rights-table tbody, .rights-table tr, .rights-table td { display: block; }
  .rights-table thead { display: none; }
  .rights-table tr { margin-bottom: 8px; border: 1px solid var(--border); border-radius: 8px; }
  .rights-table td { display: grid; grid-template-columns: 8.5em 1fr; gap: 8px; padding: 4px 10px; white-space: normal; border-bottom: 0; }
  .rights-table td::before { content: attr(data-label); color: var(--text-muted); }
}
```

- [ ] **Step 6: Run the tests**

Run: `node cctv/test/access-model.test.mjs`, `node cctv/test/rights.test.mjs`, `node cctv/test/audit.test.mjs`, `node cctv/test/pages-shell.test.mjs`.
Expected: each `all passed`.
By eye, in a browser (dev pane or the owner, with his OK — never production data changes): Users & audit -> Edit access at 375 px wide: five 44 px columns fit with no sideways scroll, the two header rows stick, notes appear under the row name.

- [ ] **Step 7: Commit**

```bash
git add cctv/public/access-model.js cctv/public/audit.js cctv/public/audit.html cctv/public/style.css cctv/test/access-model.test.mjs cctv/test/rights.test.mjs
git commit -m "Access editor: five columns (Live, Live HD, Playback SD, Playback HD, Export), Live HD kept inside Live, a two-row header from the model, phone layout, the Rights table in the same names" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Help text, CHANGELOG, and the full test run

**Files:**
- Modify: `cctv/public/audit.html:50` (Rights help), `:100` (editor help), `:106-109` (the formats fieldset)
- Modify: `CHANGELOG.md` (`## [Unreleased]`: `### Added` after line 33, `### Changed` line 37)
- Test: every suite (Windows), then the whole suite on the server copy

**Interfaces:**
- Consumes: everything above. Produces: no code.

- [ ] **Step 1: The editor's help text (`cctv/public/audit.html`)**

Line 50 becomes:
```html
      <p class="st-help">What each account may do, per site or per camera: Live, Live HD, Playback SD, Playback HD and Export. Anything not listed here is refused. Change it with <b>Edit access</b> above.</p>
```
Line 100 becomes:
```html
        <p class="st-help">A ticked site includes cameras added to it later; untick one camera and the rest stay ticked.
          <b>Live</b> is the live grid, on the camera's sub-stream as the NVR is set. <b>Live HD</b> adds full screen at full quality (the main stream); without it full screen stays on the sub-stream. Live HD counts only where Live is ticked: ticking it ticks Live, unticking Live unticks it.
          <b>Playback SD</b> plays the NVR's own recordings; <b>Playback HD</b> plays this server's own recordings at full quality. The NVR's recordings in HD need Playback SD together with Playback HD or Live HD.
          Event pictures (Alarms) need either playback right on the camera; they are full size with Live HD or Playback HD, a smaller copy otherwise.
          These limit what Argus shows, not what the network allows: anyone with the NVR's or the cameras' own passwords can reach them directly.</p>
```
In the formats fieldset, after `<div id="ac-formats" class="ac-format-list"></div>` add:
```html
          <p class="st-help">Exports are always the full-quality recording, whatever else is ticked.</p>
```

- [ ] **Step 2: `CHANGELOG.md`**

After line 33 (the end of the last `### Added` bullet) add:
```markdown
- Stream rights: the access editor (Users & audit -> Edit access) sets, per user and per site or camera,
  **Live** (the grid, on the sub-stream), **Live HD** (full screen at full quality; without it full
  screen stays on the sub-stream), **Playback SD** (the NVR's recordings), **Playback HD** (Argus's own
  recordings) and **Export**. Enforced on the server: the main stream asked for directly, the main
  stream shown while a sub-stream starts (a viewer without Live HD is told why the tile waits
  instead), the NVR's main stream in playback and the switch to it for cameras the NVR records in HD
  only (Playback SD with Live HD or Playback HD), and event pictures (full size with Live HD or
  Playback HD, a copy at most 704 wide otherwise). Existing live access is unchanged: rights.json is
  upgraded to version 2 with Live HD wherever Live was (the old file kept as rights.v1.json, a shadow
  rights.v2.json keeps Live HD removals across a rollback and return); an account whose Playback SD
  reaches cameras without Live gets the NVR's recordings and event pictures there in SD only, and the
  upgrade's audit row names it. A rights.json from a newer release is never rewritten. Taking Live HD
  away ends a full-quality stream already playing; the page drops to the sub-stream. `/api/cameras`
  says per camera what the viewer may do (`hd`, `playback`; `?for=playback`: `sd`, `hd`, `nvrHd`,
  `legs`), and the pages offer only that.
```
Under `### Changed` (line 37) add:
```markdown
- A server playback refused for want of Playback HD now closes 1008 "not allowed" with a message
  (was 1011 "server recordings not available"). The `stream` parameter of `/live` and `/playback` is
  read strictly: absent, `0` or `1`; anything else is refused (`''`, `0.0`, `-0` and the like used to
  mean the main stream).
- A camera is marked "records HD only on the NVR" only after its main stream actually played, the
  4 s wait for an SD picture counts only while the NVR plays (a slow NVR, or the camera wall opening
  its tiles paused, used to mark cameras for good), an SD picture clears a mark, and marks are
  re-tested after a week; marks written by older releases are tried in SD again. `data/hd-only.json`
  keeps each mark's time. A viewer who may not see main is tried in SD on a marked camera too.
- Event pictures are sent with `cache-control: private, no-store` (the browser cache showed one
  user's picture to the next user of the same browser).
- `/api/rights/me` is gone (it was never reachable).
```

- [ ] **Step 3: The whole suite on Windows**

Run each, from the repo root, and read the last line of each (a script loop is fine):
`access-model access-watch adaptive-live alarms-view audit bookmarks event-snapshot export-job export-scope grid-diff grid-view hd-only live-mux-client live-mux-server live-tile live-wait map-cameras pages-shell pb-sources pb-transport pb-view phone-live rec-fallback rec-playback rights stream-hub stream-param sub-bridge wall-clock`
```bash
for t in access-model access-watch adaptive-live alarms-view audit bookmarks event-snapshot export-job export-scope grid-diff grid-view hd-only live-mux-client live-mux-server live-tile live-wait map-cameras pages-shell pb-sources pb-transport pb-view phone-live rec-fallback rec-playback rights stream-hub stream-param sub-bridge wall-clock; do out=$(node cctv/test/$t.test.mjs 2>&1); echo "$t: fails=$(echo "$out" | grep -c '^FAIL') | $(echo "$out" | tail -n 1)"; done
```
Expected: `fails=0` everywhere except `rec-fallback: fails=2` (the known "16x during a leg" checks).

- [ ] **Step 4: The whole suite on the server copy**

Appendix A (b), then (d). Expected final line `DONE: N suites, 2 not passing`, the two being `cctv/test/sps.test.mjs` and `cctv/test/substreams.test.mjs` (`/work` fixtures). Every other line `rc=0 fails=0`, including `playback-hd-switch`, `playback-busy`, `playback-search`, `playback-dates`, `transcode-ffmpeg`, `event-snapshot-ffmpeg`, `users-api`, `rec-timeline`, `rec-fallback`, `camera-poll`.

- [ ] **Step 5: Check the amendments held**

```bash
git diff --stat master -- cctv/events.mjs cctv/test/events.test.mjs cctv/public/playout.js
git diff --stat master -- cctv/live-attach.mjs cctv/live-mux.mjs
git log --format='%B' master..HEAD | grep -c '^Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>$'
git log --oneline master..HEAD | wc -l
```
Expected: the first prints nothing (A1, A3); the second shows small diffs (live-attach.mjs about 55 lines, live-mux.mjs about 11); the last two numbers are equal (one trailer per commit). The branch is `stream-rights`; nothing is pushed.

- [ ] **Step 6: Commit**

```bash
git add cctv/public/audit.html CHANGELOG.md
git commit -m "Stream rights: the editor's help text and the changelog" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Report**

Report to the controller: the commits (`git log --oneline master..HEAD`), the Windows and server-copy results, the owner notes in spec section 8 (value4u cameras 19-29 and tiles past its 15 sub-stream limit show "SD stream not available" / "Waiting for room" to a viewer without Live HD; an account whose Playback SD reaches cameras without Live gets SD there, named in the upgrade's audit row; Live follows the stream, not a resolution; Playback HD is near live and SD for a camera recorded on its sub-stream; Export is always full quality; access outside Argus), and the two points in spec "Decisions" that wait for the controller's word (A2 applied per account; A4's old-page retries). Do not deploy.

---

## Appendix A: The private server copy (every "server copy" in this plan)

Production (cctv@192.168.1.232) records the site. The copy runs from `/tmp/stream-rights-test`, one suite at a time, each with its own empty data folder, at the lowest CPU priority. It never uses `/var/lib/cctv` or the running service, and nothing in it talks to an NVR (the tests use fakes). Never the test server 192.168.3.147.

(a) Write this runner with the Write tool to `C:\Users\mike\AppData\Local\Temp\claude\C--Users-mike-Downloads-websdk3-2\224c4b4b-edba-4a0e-b617-76eab964a246\scratchpad\stream-rights\run-tests.sh`, once:
```bash
#!/bin/bash
# Runs test files against the private copy in /tmp/stream-rights-test: the ones named, or every
# cctv/test/*.test.mjs. Each gets its own empty data folder (never /var/lib/cctv) and runs at the
# lowest CPU priority, because this machine is recording the site while it runs.
cd /tmp/stream-rights-test || exit 1
export LD_LIBRARY_PATH=/opt/cctv/current/bin/linux
tests=("$@")
[ ${#tests[@]} -gt 0 ] || tests=(cctv/test/*.test.mjs)
bad=0
for f in "${tests[@]}"; do
  d=$(mktemp -d)
  s=$(date +%s)
  DATA_DIR="$d" nice -n 19 timeout 600 node "$f" > /tmp/stream-rights-test/one.out 2>&1
  rc=$?
  fails=$(grep -c '^FAIL' /tmp/stream-rights-test/one.out)
  echo "rc=$rc fails=$fails $(( $(date +%s) - s ))s $f | $(tail -n 1 /tmp/stream-rights-test/one.out | cut -c1-70)"
  if [ "$rc" != 0 ] || [ "$fails" != 0 ]; then
    bad=$((bad + 1))
    grep -E '^FAIL|Error' /tmp/stream-rights-test/one.out | head -n 8 | sed 's/^/    /'
  fi
  rm -rf "$d"
done
echo "DONE: ${#tests[@]} suites, $bad not passing"
```

(b) Copy the working tree (Git Bash; tar without gzip, which Windows application control blocks), strip any CRLF (the source-text tests match `\n`), link the packages, SDK, build and deploy/ from the installed release, and add the runner. Repeat (b) whenever the working tree changes; it replaces the whole copy.
```bash
S=/c/Users/mike/AppData/Local/Temp/claude/C--Users-mike-Downloads-websdk3-2/224c4b4b-edba-4a0e-b617-76eab964a246/scratchpad/stream-rights
cd /c/Users/mike/Downloads/websdk3.2/TVT-CCTV-streams && tar -cf - cctv package.json VERSION | MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'rm -rf /tmp/stream-rights-test && mkdir -p /tmp/stream-rights-test && tar -xf - -C /tmp/stream-rights-test && find /tmp/stream-rights-test/cctv -type f \( -name "*.mjs" -o -name "*.js" -o -name "*.html" -o -name "*.css" \) -exec sed -i "s/\r$//" {} + && for d in node_modules bin build deploy; do ln -s /opt/cctv/current/$d /tmp/stream-rights-test/$d; done && echo "copied $(find /tmp/stream-rights-test/cctv -name "*.mjs" | wc -l) modules"'
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'cat > /tmp/stream-rights-test/run-tests.sh' < "$S/run-tests.sh"
```

(c) Run named test files:
```bash
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'bash /tmp/stream-rights-test/run-tests.sh cctv/test/playback-busy.test.mjs' < /dev/null
```
Expected: one line per file, `rc=0 fails=0 …`, then `DONE: N suites, 0 not passing`.

(d) Run every suite (longer than one tool call: start it in the background and poll about once a minute):
```bash
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'nohup bash /tmp/stream-rights-test/run-tests.sh > /tmp/stream-rights-test/all.txt 2>&1 < /dev/null &' < /dev/null
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'tail -n 2 /tmp/stream-rights-test/all.txt' < /dev/null
MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes cctv@192.168.1.232 'grep -v "^rc=0 fails=0" /tmp/stream-rights-test/all.txt' < /dev/null
```
The two known environmental failures, and nothing else: `cctv/test/sps.test.mjs` (`ENOENT … /work/cranes.bin`) and `cctv/test/substreams.test.mjs` (`ENOENT … /work/live-nvr1-queryNetworkNodeEncodeInfo.xml`).

## Appendix B: Interface contract (names every task uses)

```
cctv/stream-param.mjs (Task 2)
  MAIN = 0, SUB = 1, HD_NOT_ALLOWED = 'hd not allowed'
  HD_ASK_MESSAGE = 'Playing this camera in HD from the NVR needs Playback HD or Live HD.'
  HD_ONLY_MESSAGE = 'No SD recording of this camera came from the NVR (it may keep this camera only in HD). Playing it in HD needs Playback HD or Live HD.'
  streamParam(raw) -> 0 | 1 | NaN            (absent: 1; exactly '0'/'1'; else NaN)

cctv/rights.mjs (Tasks 1a, 1b, 7)
  ACTIONS = ['live', 'live-hd', 'playback-server', 'playback-nvr', 'export', 'admin']              (1a)
  can(who, 'live-hd', t)                      true only where live covers t too (admins always)   (1a)
  canAny(who, 'live-hd')                      needs a non-empty live list too                     (1a)
  sitesFor(who, list)                         ignores live-hd                                      (1a)
  mayHd(who, nvrId, ch) -> boolean            live-hd || playback-server on that camera            (1a)
  intersectTargets(a, b) -> string[]                                                               (1a)
  rightsChangeDetail(before, after) -> '<roleNote><changes | no changes> | now: …'                  (1a)
  handleRights POST: 409 { outdated: true } (no grants['live-hd']) | 409 { stale: true } | 200 | 400 | 403   (1a)
  RIGHTS_FILE, RIGHTS_V1_BACKUP (rights.v1.json), RIGHTS_SHADOW (rights.v2.json)                  (1b)
  loadRights() -> { version: 2, users, newer? }                                                    (1b)
  writeStore(store, before?)  shadow (old ∩ new) -> rights.json -> shadow (new); throws on `newer` (1b)
  saveRights on a newer file: throws, status 409; forgetRights on a newer file: that row only     (1b)
  handleRights POST: 409 { newer: true } while rights.json is from a newer release                (1b)
  liveCameras(who, cams) -> [{ …cam, hd, playback }]            (an admin: every flag, no can())  (7)
  playbackCameras(who, cams) -> [{ …cam, sd, hd, nvrHd, legs }] (an admin: every flag, no can())  (7)

cctv/access-watch.mjs (Task 2)
  track(ws, req, { actions: Array<string | string[]>, nvr, ch })   // inner array: any one of these
  sweep closes 1008 'signed out' | 'hd not allowed' | 'not allowed'; sweepSoon() (unchanged)

cctv/live-wait.mjs (Task 3)
  WAIT_NOTICE_MS = 4000, SD_UNAVAILABLE_MS = 15000
  waitWhy({ held, waitedMs }) -> 'held' | 'starting' | 'unavailable'
  waitForSub(ws, { stream, held, full?, everyMs?, every?, clear?, now?, since? }) -> stop()
    (full counts as held for the first notice only; since: when the tile opened)
cctv/live-mux.mjs (Task 3)
  MuxChannel.notice(obj)                      text { ...obj, id }
cctv/live-attach.mjs (Task 3)
  liveAttacher({ can, currentUser, adaptiveLive, phoneLive, track?, waitTimers? })
  tracks ['live'] (sub) | ['live', 'live-hd'] (main); a stand-in handle with ['live', 'live-hd'],
  whose close ends the stand-in and starts the wait notices

cctv/hd-only.mjs (Tasks 4, 5)
  SD_FALLBACK_MS = 4000, HD_ONLY_RETEST_MS = 604800000                                              (4)
  new SdWait(limitMs?).tick(now, running) -> boolean; .restart(); .ms                               (4)
  hdOnlyStore({ file, nvrId, now?, retestMs?, log? }) -> { has(ch), mark(ch), unmark(ch) }          (4)
    (an older release's [ch, …] list is not read)
  SD_REFUSE_MS = 6000; noSdAction({ waitedMs, mayMain }) -> null | 'switch' | 'refuse'              (5)
cctv/playback.mjs (Tasks 4, 5)
  createPlayback(nvr).isHdOnly(ch), .markHdOnly(ch)                                                 (4)
  createPlayback(nvr).connect(ws, url, { main: boolean, allowMain?: () => boolean, onMain?: () => void }) -> { main } | null   (5)
    a marked camera: main at once only when allowMain(); anyone else is tried in SD
    #switchToMain asks allowMain() again after StopPlayBack, before onMain / {type:'stream'} / #open
cctv/rec-playback.mjs (Task 5)
  NVR_MAIN_ACTIONS = ['playback-nvr', ['live-hd', 'playback-server']]
  connectPlayback({ nvr, ws, url, who, index, allowed?, allowedNvr?, allowedMain? = mayHd, legs?, remote?, onMain?, opts? })
    -> ServerPlayback (with .actions) | { source: 'nvr', main, actions } | null
    (the allowMain it hands on asks allowedMain on every call)

cctv/event-snapshot.mjs (Task 6)
  SD_WIDTH = 704; SD_RETRY_MS = 300000; sdPath(id); sdArgs(); sdSnapshot(ev: { id, seenMs? }, deps?) -> Promise<Buffer>
  handleSnapshot(req, res, eventId, who, deps = {})   200: 'cache-control: private, no-store'
    a picture older than its event row: 404, whole and SD; the SD copies on their own one-at-a-time queue

cctv/server.mjs
  /live: streamType: streamParam(url.searchParams.get('stream'))                                    (Task 3)
  /playback: allowedMain from currentUser(req) each call; onMain: re-track + watch.sweepSoon();
             if (session) watch.track(… session.actions …)                                          (Task 5)
  /api/cameras: liveCameras | ?for=playback playbackCameras                                          (Task 7)

cctv/public/live-tile.js (Task 8)
  HD_REFUSED = 'hd not allowed'; waitText(why); LiveTile opts.onHdRefused?: () => boolean
cctv/public/grid-diff.js (Task 8): diffCameras changed[i].hd
cctv/public/pb-sources.js (Tasks 9, 10)
  ALL_RIGHTS; pbRights(cam); nvrQualityOptions({ nvrHd }); serverQualityOptions({ remote, nvrLabel?, sd? })
  pickMode({ timeline, h265, quality, rights? }) -> mode 'server' | 'nvr' | 'none'
  refusedMessage(1008, 'hd not allowed') -> string (covers both HD refusals)
  wallQualities(rights[], current) -> { options, value }; wallTileMode({ rights, quality, available, codec, h265 })
cctv/public/access-model.js (Tasks 1a, 11)
  GRANTABLE = ['live', 'live-hd', 'playback-server', 'playback-nvr', 'export']
  COLUMNS = ['live', 'live-hd', 'playback-nvr', 'playback-server', 'export']
  COLUMN_LABELS, COLUMN_TITLES, HEAD_ROWS
cctv/public/audit.js (Task 11): renderRights(d) -> { actions, labels, formats, users, admins, note }
```

## Appendix C: Spec coverage (self-review)

| Spec item | Task |
|---|---|
| 1.1 actions, 1.2 rules 1-4 (AND rule, canAny, sitesFor), rule 5 (`mayHd`) | 1a |
| 1.2 rule 6 (NVR main = SD and mayHd), legs unchanged | 5 |
| 1.2 rule 7 and its still exception (S1) | 6 (the still rule), 12 (help text) |
| L0 `/live` strict parse | 2 (`streamParam`), 3 (server.mjs) |
| L1, L2, L3, L4, L5 (live main, tracking, stand-in, phone stand-in, conversions; raw `-0` on a channel) | 3 |
| L6, L7 (warm-ups, worker) | unchanged; covered by the Task 3 regression runs |
| P1 upgrade gate | unchanged |
| P2, P3, P5, P6, P7, P8 | 5 |
| P4 known HD-only and the switch gate (asked from the session, again after StopPlayBack; SD tried for a viewer who cannot switch) | 4 (the switch fixed: M1, M2, marks after main frames, heal, expiry, old marks); 5 (the gate) |
| P9, P10 | unchanged; Task 5 regression runs |
| S1, S2 snapshot SD copy (own queue, failures remembered), no-store (M3), stale picture refused, sweep/forget | 6 |
| X1 exports | unchanged; help text in 12 |
| C1, C2 camera lists (admin short cut) | 7 |
| R1 sitesFor, R3 outdated 409, R5 `/api/rights/me` removed, R6 diff-first audit | 1a |
| R3 newer 409, R4 migration + shadow (written first) + backup + audit (naming Playback SD beyond Live) | 1b |
| R2 canSee | unchanged (AND rule, Task 1a) |
| 2.5 access watch any-of and reasons (M5); HD taken away while watching | 2 (watch); 3 (live main, stand-in on a socket and on a mux channel, wait notices after it); 5 (NVR playback re-track and sweep) |
| 3.1-3.5 migration, shadow, rollback, newer files | 1b |
| 3.6 open editors | 1a |
| 4.1 wait notice (held on the first notice only when the NVR is full), `MuxChannel.notice` (M4), close reason | 3 (server), 8 (client) |
| 4.2 `/playback` protocol | 4, 5 |
| 4.4 HTTP | 1a, 1b, 6, 7 |
| 4.6 old pages (A4) | 3 (JSON-object notices), 1a (outdated 409), 7 (additive fields) |
| 5 live grid, full screen, phone, map popup, Recordings link (M7), `remote` rule, hd flip | 8 |
| 5 playback page (C5, C6, C7, C8, C9, M6) | 9 |
| 5 camera wall (C7 wall rows) | 10 |
| 5 sign-in clears `argus-stills` (Q21) | 8 |
| 5 access editor and Rights table (C11) | 11; help text 12 |
| 6 audit entries | 1a (rights change), 1b (migration, newer file), 5 (NVR playback sub/main/switch) |
| 7 out of scope, A1, A3 checks | 12 Step 5 |
| 8 owner notes | 12 Step 7 |
| 9 test strategy | every task's steps; 12 (full run) |
| Decisions (rulings on the review) | as each names |
