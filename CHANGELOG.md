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

### Fixed

### Changed

### Removed
