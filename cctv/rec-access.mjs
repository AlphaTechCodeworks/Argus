// Who may play back (and later export) the server's own recordings. The one place per-camera
// rights are decided: every server-recording route asks here (the timeline API, server playback).
// Non-admins keep today's NVR playback unchanged.

/**
 * Whether `who` may play camera `ch` of NVR `nvrId` from the server's recordings.
 * Admins only for now (who.admin is also true with CCTV_AUTH=off). Per-user rights (admin screens
 * in a later plan) replace this body; the signature stays.
 * @param {{ user?: string, admin?: boolean } | null | undefined} who
 * @param {string} nvrId
 * @param {number} ch
 */
export function canPlayServer(who, nvrId, ch) {
  return Boolean(who?.admin)
}
