// What /api/health tells someone who is not an admin. Health is open to everyone signed in (the
// banner on every page and the map read it too), but rights.mjs decides which cameras each person
// may see, and /api/cameras, /api/events and /api/alarms already keep the rest out. Without this,
// health named them all anyway: every camera on every site with whether it was online or recording
// right now, and every NVR's address, model and serial, to a viewer allowed one camera or none.
//
// An admin gets the body exactly as it is. Anyone else gets:
//   - the cameras they may see (canSee: live or either playback right, as for events and alarms);
//   - the NVRs of those cameras, by name and state only: address, model, serial, disks and error
//     text (which names host:port) are for admins;
//   - the alerts about those NVRs, less the ones that list cameras by name (camera-offline and
//     not-recording cover every camera of the NVR; each visible camera's own state is in `cameras`),
//     and less the drive, forecast and restart alerts, which carry paths and are the server's;
//   - no storage locations and no alert-sender state; the last settings backup as when and how
//     many copies, never where.

// Per-NVR alerts whose detail lists cameras by name
const CAMERA_LISTS = new Set(['camera-offline', 'not-recording'])

/** The NVR a per-NVR alert is about ("nvr-offline/nvr-2" -> "nvr-2"), or null for any other alert. */
const nvrOf = (a) => {
  const key = String(a?.key ?? '')
  const slash = key.indexOf('/')
  return slash > 0 && key.startsWith('nvr-') ? key.slice(slash + 1) : null
}

/**
 * @param {object} body what alert-checks.mjs health() answers, plus server.mjs's `viewing`
 * @param {{ admin?: boolean, canSee?: (nvr: string, ch: number) => boolean }} who admin from the
 *   session (only the literal true); canSee the rights question (missing: nothing is seen)
 */
export function healthFor(body, { admin, canSee } = {}) {
  if (admin === true) return body
  const see = typeof canSee === 'function' ? canSee : () => false
  const list = (v) => (Array.isArray(v) ? v : [])
  const cameras = list(body?.cameras).filter((c) => see(c?.nvrId, c?.ch))
  const seen = new Set(cameras.map((c) => c.nvrId))
  const nvrs = list(body?.nvrs)
    .filter((n) => seen.has(n?.id))
    .map((n) => ({ id: n.id, name: n.name, online: n.online, status: n.status }))
  const keep = (a) => !CAMERA_LISTS.has(a?.kind) && seen.has(nvrOf(a))
  const b = body?.backup
  return {
    ...body,
    open: list(body?.open).filter(keep),
    history: list(body?.history).filter(keep),
    nvrs,
    cameras,
    locations: [],
    sending: null,
    // health.js reads the time, how many copies were written and whether any failed
    backup: b ? { at: b.at, written: list(b.written).map(() => ''), errors: list(b.errors).map(() => 'a copy could not be written') } : null
  }
}
