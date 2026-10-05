// Who is connected right now: the distinct browser sessions (viewerOf, live-attach.mjs) that have at
// least one live, playback or motion socket open, split into local (on the network) and remote (over
// the internet). A person with several tabs or cameras is ONE viewer -- all their sockets share a
// key, so they are counted once. Purely in memory: a socket closing drops it, and a server restart
// clears it. A factory, not a singleton, so it can be tested on its own (test/presence.test.mjs).

export function makePresence() {
  const viewers = new Map() // key -> { remote: boolean, sockets: Set, since: number }
  return {
    /** A socket for `key` opened. remote: it reached the server over the internet (live-attach's rule). */
    join(key, ws, { remote = false, now = Date.now() } = {}) {
      let v = viewers.get(key)
      if (!v) viewers.set(key, (v = { remote: Boolean(remote), sockets: new Set(), since: now }))
      v.remote = Boolean(remote) // a session that moved onto the tunnel (or off it) counts as it is now
      v.sockets.add(ws)
      return v
    },
    /** A socket closed; the viewer is forgotten once its last socket has gone. */
    leave(key, ws) {
      const v = viewers.get(key)
      if (!v) return
      v.sockets.delete(ws)
      if (v.sockets.size === 0) viewers.delete(key)
    },
    /** { people, local, remote } — distinct sessions connected now. */
    summary() {
      let local = 0
      let remote = 0
      for (const v of viewers.values()) if (v.remote) remote++; else local++
      return { people: viewers.size, local, remote }
    }
  }
}
