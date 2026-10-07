# Granular admin access — design

**Goal:** a middle tier between "viewer" and "full admin". Today access is binary: a full admin can do
everything (users, cameras, settings, storage, reports, audit, reboot, diagnostics); everyone else is a
viewer whose camera access is set per camera. This adds **per‑feature admin capabilities**, so a person
can be granted some admin areas without the rest.

**Approved choices (owner, 3 Oct 2026):** fine‑grained (a capability per feature). On review the
owner asked for a **unified per‑user editor** covering *both* what a person may watch/play/export
(the existing per‑camera/site grants) *and* what they may administer, driven by **checkboxes with
one‑click role presets**, and for this to be **part of setting up a new user**. The presets are
Full admin, Deputy admin, Camera manager, Operator, Guard and Custom (see "Role presets" below).

## Capabilities

Eight capabilities, one per admin area (fail‑closed: anything not listed is denied):

| id | Grants |
|----|--------|
| `users` | Users & access — create users, grant per‑camera rights **and** admin capabilities |
| `cameras` | Sites/NVRs, maps, camera OSD / lines / image / stream (resolution) settings |
| `settings` | System settings (`/api/admin/...` settings, excluding storage) |
| `storage` | Recording‑storage config (the Storage tab) |
| `reports` | View Reports |
| `audit` | View the Audit log |
| `reboot` | Restart the service / reboot the machine |
| `diagnostics` | Relays, NVR log, network status |

## Role presets

One‑click fills for the unified editor. A preset is **not stored** as a role — it just ticks a set
of capabilities and (for the viewing‑focused ones) fills the per‑camera grant tree; the admin then
tweaks and saves the resulting row. Picking a preset never bypasses the escalation safeguard
(only a full admin can apply one that grants admin power).

| Preset | Admin capabilities | Viewing grants |
|--------|--------------------|----------------|
| **Full admin** | the `admin` flag (all capabilities, implied) | everything |
| **Deputy admin** | every capability **except `users`** | sees all cameras |
| **Camera manager** | `cameras` + `diagnostics` | sees all cameras |
| **Operator** | none | Live + Playback (server & NVR) on all cameras |
| **Guard** | none | Live only, all cameras |
| **Custom** | none pre‑filled | none pre‑filled |

## Storage model (rights.mjs)

The rights row gains one field:

```
{ admin: false, grants: {…}, formats: [], adminCaps: ['cameras', …] }
```

- `admin: true` — full admin, implies **all** capabilities (unchanged behaviour).
- `admin: false` + `adminCaps: [...]` — a partial admin: those admin areas, otherwise a viewer (the
  per‑camera `grants` still apply to what they may watch/play back/export).
- `adminCaps` defaults to `[]`, so every existing viewer is unchanged and no migration is needed.
- `cleanRights` validates `adminCaps` against the known set and drops anything else (fail‑closed), the
  same way it already cleans `grants`.

## Gating

One helper, used everywhere a feature is admin‑only:

```
canAdmin(who, cap)  =  who.admin === true  ||  who.adminCaps?.includes(cap)
```

- `who` is built in server.mjs from the session + rights, carrying `admin` and `adminCaps`.
- Every `who.admin` / `auth.isAdmin` gate on an admin route becomes `canAdmin(who, '<cap>')` with the
  right capability (the route→capability map is the table above). A denied request returns 403, as now.
- The nav (nav-model.js) stops filtering admin items by a single `adminOnly` flag; each admin item
  carries its `cap`, and `navFor(who)` keeps the ones the person has. A full admin sees all.
- `/api/me` returns the person's `adminCaps` (and `admin`) so the client hides what they cannot reach —
  but the client hiding is cosmetic; the server re‑checks every request (the `canSee` model).

## Privilege‑escalation safeguard (the load‑bearing rule)

A partial admin must never be able to grant themselves (or anyone) more power.

- Only a **full admin** (`who.admin === true`) may change another user's `admin` flag or `adminCaps`, or
  create/delete users. The `users` capability lets a partial admin edit **per‑camera grants and formats**
  only; the save path (handleRights / handleUsers) **rejects** any change to `admin`/`adminCaps` from a
  non‑full‑admin, and rejects creating/deleting accounts.
- This is enforced server‑side, not in the UI. It is the one rule that makes the feature safe, and it
  gets its own tests.

## UI — one unified editor (audit.js / audit.html)

The access editor becomes the single place a person's whole access is set, in three stacked
sections, with the preset buttons across the top:

1. **Account** — name, password, and a **Full admin** switch (the existing `ac-admin` checkbox,
   relabelled). Full admin implies every capability and all viewing.
2. **Can administer** — one tick per capability (`users`, `cameras`, `settings`, `storage`,
   `reports`, `audit`, `restart/reboot`, `diagnostics`). Shown and editable **only to a full
   admin**; a partial admin who holds `users` sees the viewing tree but not this section (matching
   the server rule). Greyed out while Full admin is on (it already implies all).
3. **Can see** — the existing per‑site/per‑camera grant tree and export formats, unchanged.

- **Presets** (Role presets above) sit at the top of the editor and fill sections 2 and 3 in one
  click, then the admin tweaks.
- Everything saves through the existing compare‑and‑swap (`seen`) rights POST; the server
  re‑decides and the escalation safeguard still applies, so the UI gating is cosmetic.

### Part of setting up a new user

Adding a new account already auto‑opens this editor for a new viewer (audit.js). That stays, and
is the answer to "camera/site (and now admin) allocation should be part of creating a user": the
one editor opens straight after **Add or update**, so a new person's cameras, sites and admin
areas are all set in the same flow. (If the auto‑open is currently failing for a brand‑new
account, fix it as part of this work so the editor reliably opens.)

### Client model (access-model.js)

`toRow`/`fromRow` carry `adminCaps` alongside `admin`, `grants` and `formats`; `view`/`click`
gain the capability ticks; a `preset(name)` pure function returns the `{admin, adminCaps, grants,
formats}` a preset fills, so the UI and tests share one source of truth.

## Migration

None required. `adminCaps` is absent on every current row → treated as `[]`. Full admins keep `admin:
true` and all powers. The shadow/upgrade machinery in rights.mjs is untouched (adminCaps is additive).

## Testing

- `rights.mjs`: `canAdmin` truth table (full admin = all; partial admin = only its caps; unknown cap =
  denied); `cleanRights` drops unknown `adminCaps`.
- **Escalation**: a partial admin with `users` cannot set `admin`/`adminCaps` or create/delete users
  (server rejects); a full admin can.
- `nav-model`: `navFor` returns only the admin items a person's caps allow.
- Route gating: a representative admin route returns 403 for a partial admin lacking its capability and
  200 with it.
- `access-model`: `preset(name)` returns the right `{admin, adminCaps, grants, formats}` for each of
  Full admin / Deputy admin / Camera manager / Operator / Guard / Custom; `toRow`/`fromRow` round‑trip
  `adminCaps`.
- UI (audit.js render*): the "Can administer" section renders for a full admin and is absent for a
  partial admin; a preset button fills the capability ticks and the grant tree together.

## Out of scope

- Per‑site admin scoping (e.g. "camera manager for Main site only") — capabilities are server‑wide for
  now; a later iteration could scope `cameras` by site using the existing per‑camera grant tree.
- Time‑bounded or audited capability grants beyond the existing audit of rights changes.
