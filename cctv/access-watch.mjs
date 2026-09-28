// Open video sockets, looked at again. rights.mjs is asked when a /live, /playback or /motion socket
// or a /live-mux channel opens, and that was all: an admin unticking a camera, removing an account or
// the person signing out never reached the ones already open. A tile left streaming kept its camera
// for as long as the page stayed open (keepAlive keeps the socket up; a wall display stays open for
// days), and a server playback left open took seeks to any part of that camera's history.
//
// So each open one is tracked with the request that opened it and the rights that let it in, and the
// question is asked again from the session as it is now: that request's cookie, which auth.mjs
// refuses once the account is gone or the session was signed out, and the account's rights and role
// as they are now. It is asked on every sweep: soon after rights or accounts are saved or a session
// is signed out (sweepSoon, which server.mjs hooks to those), and every SWEEP_MS, which also catches
// what this process did not do itself (adduser.mjs, a hand-edited file, a session running out). The
// first "no" closes it 1008: "not allowed", or "signed out" when there is no session any more. A
// /live-mux channel's close is an "end" for that one tile; the page's other tiles carry on.
//
// Pure (no SDK, no server): server.mjs hands in how to read the session and the rights.

export const SWEEP_MS = 15_000

// ws readyState: a socket already closing or closed has had (or is about to have) its 'close' event,
// and one tracked after that would never be let go
const OPEN = 1

/**
 * @param {{ currentUser: (req: object) => string|null, isAdmin: (user: string) => boolean,
 *   can: (who: object, action: string, target: object) => boolean, everyMs?: number,
 *   every?: typeof setInterval, defer?: (fn: Function) => void }} o
 *   currentUser: the signed-in user of a request now (server.mjs); can: rights.mjs can; every and
 *   defer: the timer and the "soon" (tests hand in their own)
 */
export function accessWatch({ currentUser, isAdmin, can, everyMs = SWEEP_MS, every = setInterval, defer = setImmediate }) {
  const open = new Map() // socket or mux channel -> { req, actions, nvr, ch }

  /** Asks every open one again; closes those now refused. @returns {number} how many were closed */
  const sweep = () => {
    // a page's /live-mux channels all share its one upgrade request: its session is read once a sweep
    const sessions = new Map() // req -> who | null
    const whoOf = (req) => {
      if (!sessions.has(req)) {
        let who = null
        try {
          const user = currentUser(req)
          if (user) who = { user, admin: isAdmin(user) === true }
        } catch {} // a session that cannot be read is no session
        sessions.set(req, who)
      }
      return sessions.get(req)
    }
    let closed = 0
    for (const [ws, e] of [...open]) {
      const who = whoOf(e.req)
      // every right it was opened with must still hold; a check that throws is a no (default deny)
      const may = (action) => {
        try {
          return can(who, action, { nvr: e.nvr, ch: e.ch }) === true
        } catch {
          return false
        }
      }
      if (who && e.actions.every(may)) continue
      open.delete(ws)
      closed++
      try {
        ws.close(1008, who ? 'not allowed' : 'signed out')
      } catch {}
    }
    return closed
  }

  // several saves in a row (saveRights writes rights.json, then users.json for the Admin switch) are
  // one sweep, after they are all done
  let pending = false
  const sweepSoon = () => {
    if (pending) return
    pending = true
    defer(() => {
      pending = false
      sweep()
    })
  }

  const timer = every(sweep, everyMs)
  timer?.unref?.()

  return {
    /**
     * Watches one socket or mux channel from now until it closes.
     * @param {object} ws the socket or channel (closed with ws.close(1008, reason))
     * @param {object} req the request that opened it (its cookie is the session)
     * @param {{ actions: string[], nvr: string, ch: number }} what the rights it needs, every one of
     *   them, on that camera
     * @returns {() => void} stops watching it
     */
    track(ws, req, { actions, nvr, ch }) {
      const stop = () => open.delete(ws)
      if (ws.readyState !== undefined && ws.readyState !== OPEN) return stop
      open.set(ws, { req, actions: [...actions], nvr, ch })
      ws.on('close', stop)
      return stop
    },
    sweep,
    sweepSoon,
    size: () => open.size,
    stop: () => clearInterval(timer)
  }
}
