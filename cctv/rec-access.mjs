// Who may play back (and export) the server's own recordings.
//
// The decision itself moved to rights.mjs in Phase 6, which is the one place per-camera rights are
// now made. This module stays only so that the `canPlayServer(who, nvrId, ch)` call shape keeps
// working for anything that still uses it; it adds no rule of its own, and must never grow one.
// New code should call rights.can(who, 'playback-server', { nvr, ch }) directly.

export { canPlayServer } from './rights.mjs'
