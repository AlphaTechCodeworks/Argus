// When the main process leaves a control login untried (nvrs.mjs #connect). Pure, so it can be
// tested without the SDK: test/login-hold.test.mjs.
//
// Every login in this process goes through one lane, one at a time (nvrs.mjs connectLane: a login can
// block other SDK work), and a login already inside the SDK cannot be overtaken. A login by serial
// number to an NVR that is not reachable sits there for ~20 s before it fails. With two or three such
// NVRs each retried once a minute, a doomed login was in the lane most of the time, and a playback
// login to a healthy NVR on the LAN (2.5 s of its own) waited 15 to 20 s for its turn: measured on
// production on 2026-10-08, on the camera wall and on the first playback of any camera.
//
// Each NVR's live worker makes the same login from its own process, where it holds nobody up. While
// that worker has not got in, this process's attempt is all but certain to fail the same way: it is
// left untried, and looked at again every few seconds. The moment the worker is in, the login is
// made (sooner than the minute-long back-off would have come round). An attempt is still made every
// FORCE_TRY_MS whatever the worker says, in case it is the worker that is wrong.

/** How often an NVR being held is looked at again. */
export const HOLD_CHECK_MS = 5000
/** An attempt is made at least this often, whatever the worker says. */
export const FORCE_TRY_MS = 10 * 60_000

/**
 * Whether this turn's control login is left untried.
 * sn: the NVR is reached by serial number (one reached by address is asked over TCP first, outside
 *   the lane, and costs it nothing when it is down: probe.mjs);
 * failed: this process's last attempt failed (the first attempt is always made);
 * workerState, workerStatus: the worker process's state ('ready' once it runs) and what its own
 *   login says ('online' | 'connecting' | 'offline'); no worker, or one not running, holds nothing;
 * sinceTryMs: how long since this process's last real attempt.
 */
export function holdControlLogin({ sn, failed, workerState, workerStatus, sinceTryMs }) {
  if (!sn || !failed) return false
  if (workerState !== 'ready') return false
  if (typeof workerStatus !== 'string' || workerStatus === '' || workerStatus === 'online') return false
  return Number.isFinite(sinceTryMs) && sinceTryMs < FORCE_TRY_MS
}
