// Who is connected right now: the distinct browser sessions (viewerOf, live-attach.mjs) that have at
// least one live, playback or motion socket open, split into local (on the network) and remote (over
// the internet). A person with several tabs or cameras is ONE viewer -- all their sockets share a
// key, so they are counted once. Purely in memory: a socket closing drops it, and a server restart
// clears it. A factory, not a singleton, so it can be tested on its own (test/presence.test.mjs).
//
// And what each of them has open (Health: "Who is watching", viewers.mjs): the signed-in name and
// the address the session came from, kept from its sockets, and one entry per open live stream,
// playback or motion search (open, below), which goes when its socket or channel closes or the
// viewer's last socket does. Nothing of the session itself is kept: no cookie, no key.

/** The most viewers, and things open for each, that list() gives: the page is for a glance. */
export const MAX_VIEWERS = 200
export const MAX_OPEN_EACH = 100

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max)

export function makePresence() {
  const viewers = new Map() // key -> { remote: boolean, sockets: Set, since: number, user, address, open: Map }
  return {
    /**
     * A socket for `key` opened. remote: it reached the server over the internet (live-attach's rule);
     * user and address: who is signed in on it and where it came from, for list().
     */
    join(key, ws, { remote = false, now = Date.now(), user = null, address = '' } = {}) {
      let v = viewers.get(key)
      if (!v) viewers.set(key, (v = { remote: Boolean(remote), sockets: new Set(), since: now, user: null, address: '', open: new Map() }))
      v.remote = Boolean(remote) // a session that moved onto the tunnel (or off it) counts as it is now
      if (user) v.user = text(user, 64)
      if (address) v.address = text(address, 45)
      v.sockets.add(ws)
      return v
    },
    /** A socket closed; the viewer is forgotten once its last socket has gone. */
    leave(key, ws) {
      const v = viewers.get(key)
      if (!v) return
      v.sockets.delete(ws)
      v.open.delete(ws)
      if (v.sockets.size === 0) viewers.delete(key)
    },
    /**
     * Something `key` has open from now on: a live stream, a playback, a motion search. handle: its
     * socket, or its channel on a /live-mux socket (one page's tiles share a socket); the same handle
     * again replaces what it had (a playback that went over to the main stream). Ignored for a viewer
     * that is not connected: its sockets join first.
     * @param {{ type: 'live'|'playback'|'motion', nvr: string, ch: number, stream?: 'sub'|'main',
     *   kind?: string, source?: string }} what
     * @returns {() => void} it closed
     */
    open(key, handle, what) {
      const v = viewers.get(key)
      if (v) v.open.set(handle, { ...what })
      return () => viewers.get(key)?.open.delete(handle)
    },
    /** { people, local, remote } — distinct sessions connected now. */
    summary() {
      let local = 0
      let remote = 0
      for (const v of viewers.values()) if (v.remote) remote++; else local++
      return { people: viewers.size, local, remote }
    },
    /**
     * Each viewer with what it has open, longest connected first, bounded (MAX_VIEWERS, and
     * MAX_OPEN_EACH of each kind): { user, address, remote, since, live, playback, other, counts }.
     * The same camera open twice the same way (two tabs) is one line. counts are of everything, also
     * what the bounds left out; cameras: the distinct cameras among them.
     * @param {{ maxViewers?: number, maxEach?: number,
     *   nameOf?: (nvr: string, ch: number) => { site?: string, nvrName?: string, camera?: string }|null }} [o]
     *   nameOf: the names to show for a camera (server.mjs knows them), asked only for what is given
     * @returns {{ viewers: object[], total: number }} total: every viewer connected, also those left out
     */
    list({ maxViewers = MAX_VIEWERS, maxEach = MAX_OPEN_EACH, nameOf = () => null } = {}) {
      const named = (o) => {
        let n = null
        try {
          n = nameOf(o.nvr, o.ch)
        } catch {} // a name that cannot be read is no name: the id and channel still say which
        return { nvr: o.nvr, ch: o.ch, site: n?.site ?? null, nvrName: n?.nvrName ?? null, camera: n?.camera ?? null }
      }
      const out = []
      for (const v of [...viewers.values()].sort((a, b) => a.since - b.since).slice(0, Math.max(0, maxViewers))) {
        const seen = { live: new Map(), playback: new Map(), other: new Map() }
        const cameras = new Set()
        for (const o of v.open.values()) {
          cameras.add(`${o.nvr}/${o.ch}`)
          if (o.type === 'live') seen.live.set(`${o.nvr}/${o.ch}/${o.stream}/${o.kind}`, o)
          else if (o.type === 'playback') seen.playback.set(`${o.nvr}/${o.ch}/${o.source}`, o)
          else seen.other.set(`${o.nvr}/${o.ch}/${o.type}`, o)
        }
        const some = (m) => [...m.values()].slice(0, Math.max(0, maxEach))
        out.push({
          user: v.user,
          address: v.address,
          remote: v.remote,
          since: v.since,
          live: some(seen.live).map((o) => ({ ...named(o), stream: o.stream ?? 'sub', kind: o.kind ?? 'unknown' })),
          playback: some(seen.playback).map((o) => ({ ...named(o), source: o.source ?? 'unknown' })),
          other: some(seen.other).map((o) => ({ ...named(o), what: o.type })),
          counts: { sockets: v.sockets.size, live: seen.live.size, playback: seen.playback.size, other: seen.other.size, cameras: cameras.size }
        })
      }
      return { viewers: out, total: viewers.size }
    }
  }
}
