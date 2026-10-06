# Clip sharing — design

**Goal:** let an authorised person turn one finished export into a **time-limited public link**, so
they can send a clip as evidence to someone who has no account.

**Approved choices (owner, 4 Oct 2026):** expiry **chosen per link** (1 / 7 / 30 days, default 7);
the link opens a **landing page with a Download button**; creating a link needs a **new per-user
"sharing" permission** (in the access editor).

## The permission

- A new boolean `share` on the rights row (rights.mjs), **default false** — public links are
  sensitive, so sharing is opt-in. A full admin always may share.
- `canShare(who)` = `who.admin === true || rightsOf(name).share === true`.
- To create a link for a *specific* export you must both hold `share` **and** be able to reach that
  export today (`mayReach` in export-api.mjs: its owner with export rights on those cameras, or an
  admin). So sharing never widens who can see a clip — only how.
- Access editor: a **"Share clips"** checkbox (next to the Map toggle), default off. `/api/me`
  returns `share` so the Exports UI knows whether to show the Share button.

## The share record (new module share-links.mjs)

Stored in `DATA_DIR/shares.json` (never on a recording location), one entry per link:

```
{ token, jobId, by, createdAt, expiresAt, revoked }
```

- `token`: 32 random bytes, base64url (43 chars) — unguessable; the only credential.
- `createShare(jobId, by, days)` — days ∈ {1,7,30}; returns the token.
- `getShare(token)` — the record, or null when missing / revoked / expired (callers never
  distinguish these to the public).
- `listSharesFor(who)` — an admin's are all; anyone else's are the ones they made; each carries the
  job summary for the "manage links" view.
- `revokeShare(token, who)` — owner or admin; marks `revoked`.
- Expired/revoked records are pruned lazily on list and on access. Every create, revoke and
  anonymous download is audited (audit.mjs), the share token and job named.

## Routes

**Public — before the login gate (server.mjs), the only unauthenticated app surface besides login:**
- `GET /s/<token>` → serves the landing page (static `share.html`). Always 200 with the page; the
  page itself fetches the info below and shows "this link is no longer valid" when the token is bad,
  so the existence of a clip is never revealed by the status code.
- `GET /s/<token>/info` → JSON `{ ok, camera, when, format, expiresAt }` for a valid token, else
  `{ ok: false }` (404). No ids, no paths, nothing but what the landing page shows.
- `GET /s/<token>/download` → streams **only that one export** (the same ZIP `downloadExport`
  streams), `content-disposition: attachment`, `cache-control: no-store`. Invalid token → 404.
  Rate-limited (per IP) to blunt token guessing, though a 32-byte token is already infeasible.

**Authenticated:**
- `POST /api/exports/:id/share { days }` → create a link. Requires `canShare(who)` **and**
  `mayReach(who, job)`. Returns `{ token, url, expiresAt }`.
- `GET /api/shares` → the caller's links (admin: all), each with its job summary and expiry.
- `DELETE /api/shares/:token` → revoke (owner or admin).

## The landing page (share.html / share.js — public)

Static, served for `GET /s/<token>`; added to PUBLIC_PATHS so its own script/style load without a
session. It reads the token from the URL, calls `/s/<token>/info`, and shows: "Evidence clip",
the camera(s), the date/time, the format, when the link expires, and a **Download** button linking
to `/s/<token>/download`. A bad token shows a plain "This link has expired or is no longer valid."
Under the app's existing CSP (`script-src 'self'`), so no inline or third-party script.

## Sharing from the Exports UI (playback.js)

When an export finishes (followExport's `done` branch, by the Download link): if `/api/me` says
`share`, a **Share** button appears → a small dialog to pick the expiry (1 / 7 / 30 days) → POST to
`/api/exports/:id/share` → shows the link to copy, with its expiry and a Revoke option.

## Reuse / refactor

`downloadExport` already streams a job's ZIP (`zipStream`, `zipEntriesOf`). Extract its streaming
core as `streamExportZip(dataDir, id, res, headers)` and call it from both the authenticated
download (authorised by `mayReach`) and the share download (authorised by a valid token). The bytes
are identical; only the gate differs.

## Security notes (load-bearing)

- The public routes are matched **before** the auth redirect, and match **only** `^/s/<token>(/info|/download)?$` with a strict token charset; nothing else becomes public.
- A share authorises exactly one `jobId`; the download streams that job and nothing else — no id in
  the URL is honoured except through the token, so a clip cannot be reached by guessing its id.
- Missing / expired / revoked / unknown all look the same to the public (404), so a token reveals
  nothing.
- Revoke and expiry are checked on **every** hit (no caching of the authorisation).
- Creating a link cannot widen access: it needs `share` **and** `mayReach` on that export.

## Migration

None. `share` absent on every current row → false (no one can make links until granted; admins
can). `shares.json` absent → no links.

## Testing

- `rights.mjs`: `canShare` (admin always; viewer only with `share`; no session → false);
  `cleanRights` defaults `share` false and reads only the literal true.
- `share-links.mjs`: create → get round-trips; expired and revoked and unknown all return null;
  `listSharesFor` scopes to the owner (admin all); revoke by a stranger is refused; the token charset
  and length.
- route gating: create refused without `share` or without `mayReach`; the public download refused for
  a bad/expired/revoked token and allowed for a good one; `/s/<token>/info` reveals nothing for a bad
  token.
- `access-model` / `nav`: the `share` flag round-trips; presets default it off; the editor checkbox
  renders.
- `share.js` pure parts: the info → view mapping, and the "invalid" message for `{ ok: false }`.

## Out of scope

- Sharing anything but a finished export (no live links, no raw-recording links).
- Per-recipient links or view counts beyond the audit log.
- Watermarking or re-encoding on share (the shared file is the export as made).
