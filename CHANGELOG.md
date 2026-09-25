# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking Changes

### Added

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
