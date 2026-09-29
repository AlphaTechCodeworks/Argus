# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking Changes

### Added

- Line crossing: an admin draws up to four lines on a camera's live picture (full-size Live view,
  **Lines**) and Argus writes them into the camera's own line-crossing detection through the NVR
  (`/api/admin/nvrs/:id/channels/:ch/lines`, `cctv/tripwire.mjs`): confirmed, logged before it is
  sent, read back field by field, undoable, and refused while the camera's sound or white-light
  trigger is on. Crossings are read from the NVR's live alarm list every 5 s (`cctv/alarm-watch.mjs`)
  and become "Line crossing" alarms within seconds, each with a phone alert through ntfy for the
  cameras switched on in the panel (the "Line crossing" alarm rule), a bookmark from 30 s before
  to 60 s after, and a picture taken from Argus's own recording (`GET /api/events/:id/snapshot`)
  shown on the Alarms page. The alert's link, `/alarms.html#event=<id>`, opens that alarm. Every
  crossing is bookmarked, and bookmarked footage is never thinned by housekeeping, so a busy
  camera's line crossings accumulate as protected footage rather than being trimmed with age.
- Multi-camera playback (phase 8) on the Wall page: a searchable camera list, saved views kept with
  the user's account (`GET`/`PUT /api/me/views`, `cctv/views.mjs`), fixed 2×2 and 3×3 grids with
  paging, timeline lanes for either the camera being worked on or every camera on the page, a tile
  toolbar (snapshot, copy the picture, export that camera, maximise), and exporting a whole view as
  one job through the existing `/api/exports`.
- Streams are now opened one at a time and no oftener than every 0.7 s, stopped the moment a tile is
  off the page, behind a maximised tile or on a hidden tab, and backed off for up to five minutes
  when an NVR refuses one. An NVR shares one bandwidth budget between serving us and recording to
  its own disk, so a grid that asked for nine streams at once could stop a site recording.
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

### Fixed

### Changed

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

### Removed
