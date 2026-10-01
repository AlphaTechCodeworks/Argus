// The local TCP side of the P2P tunnel helper. The vendor SDK logs in to 127.0.0.1:<port> as if
// it were an NVR on TCP 6036; this proxy carries the bytes of that connection to a tunnel and back.
// It knows nothing about UDP or the P2P protocol: the tunnel is whatever `openTunnel` returns.
//
// What the SDK does (measured, tests-report.md TEST 2):
//   - it opens TWO TCP connections per login. The first is closed by the SDK within a few ms
//     without a byte (a reachability probe); the second carries everything.
//   - it sends nothing until the NVR's 64-byte "head" greeting arrives, and waits seconds for it.
// So: a connection gets a tunnel only if it is still open after `probeGraceMs` (or has sent a
// byte); it is then held, with nothing read from it, until the tunnel is up. When the tunnel
// drops, the local socket is closed, and the SDK logs in again by itself.
//
// The tunnel contract (stage 2 implements it over UDP; the tests use a fake):
//   openTunnel({ signal }) -> Promise<tunnel>     resolves when the path to the NVR is up
//   tunnel.write(buffer)   -> boolean             false = please wait for 'drain'
//   tunnel.close()
//   tunnel.on('data', (buffer) => ..)             bytes from the NVR, in order
//   tunnel.on('close', () => ..)                  the tunnel dropped
//   tunnel.on('drain', () => ..)                  optional
//   tunnel.pause() / tunnel.resume()              optional: stop / restart 'data' when the SDK reads slowly
import { createServer } from 'node:net'

export const DEFAULT_PROBE_GRACE_MS = 50

/**
 * Start the proxy. Resolves when it is listening.
 *   port            0 = any free port (read it from the result)
 *   host            stays 127.0.0.1 unless the caller really wants otherwise
 *   openTunnel      see the contract above
 *   probeGraceMs    how long a silent connection must stay open before it gets a tunnel
 *   log             (text) => void, optional
 * Returns { port, host, stats, connections(), close() }.
 */
export function startProxy({ port = 0, host = '127.0.0.1', openTunnel, probeGraceMs = DEFAULT_PROBE_GRACE_MS, log = () => {} }) {
  if (typeof openTunnel !== 'function') throw new Error('openTunnel must be a function')
  const stats = { accepted: 0, probes: 0, tunnelsOpened: 0, tunnelsFailed: 0, tunnelDrops: 0, localCloses: 0, bytesToTunnel: 0, bytesFromTunnel: 0 }
  const live = new Set()
  let seq = 0

  const server = createServer({ pauseOnConnect: true, allowHalfOpen: false }, (socket) => {
    const n = ++seq
    stats.accepted++
    socket.setNoDelay(true)
    const c = { n, socket, tunnel: null, state: 'waiting', abort: new AbortController(), timer: null }
    live.add(c)

    const end = (why) => {
      if (c.state === 'closed') return
      const was = c.state
      c.state = 'closed'
      clearTimeout(c.timer)
      live.delete(c)
      c.abort.abort()
      if (was === 'waiting') stats.probes++
      else if (why.startsWith('local')) stats.localCloses++
      log(`#${n} closed: ${why}${was === 'waiting' ? ' (probe: no tunnel was opened)' : ''}`)
      socket.destroy()
      if (c.tunnel) {
        const t = c.tunnel
        c.tunnel = null
        try {
          t.close()
        } catch {}
      }
    }

    socket.on('error', () => end('local socket error'))
    socket.on('close', () => end('local side closed'))
    socket.on('end', () => end('local side closed'))

    const onReadable = () => {
      if (c.state === 'closed' || c.state === 'up') return
      if (socket.readableLength > 0) {
        clearTimeout(c.timer)
        start()
      } else if (socket.read() === null && c.state !== 'closed') end('local side closed')
    }

    const start = async () => {
      if (c.state !== 'waiting') return
      c.state = 'opening'
      log(`#${n} is a real connection: opening the tunnel`)
      let tunnel
      try {
        tunnel = await openTunnel({ signal: c.abort.signal })
      } catch (e) {
        stats.tunnelsFailed++
        end(`tunnel did not open: ${e?.message ?? e}`)
        return
      }
      if (c.state !== 'opening') {
        // the SDK gave up while the tunnel was coming up
        try {
          tunnel.close()
        } catch {}
        return
      }
      stats.tunnelsOpened++
      c.tunnel = tunnel
      c.state = 'up'
      tunnel.on('data', (b) => {
        if (c.state !== 'up') return
        stats.bytesFromTunnel += b.length
        if (!socket.write(b) && tunnel.pause) {
          tunnel.pause()
          socket.once('drain', () => c.state === 'up' && tunnel.resume?.())
        }
      })
      tunnel.on('close', () => {
        if (c.state !== 'up') return
        stats.tunnelDrops++
        c.tunnel = null
        end('tunnel dropped')
      })
      tunnel.on('error', () => {})
      tunnel.on('drain', () => c.state === 'up' && socket.resume())
      socket.removeListener('readable', onReadable)
      socket.on('data', (b) => {
        if (c.state !== 'up') return
        stats.bytesToTunnel += b.length
        if (tunnel.write(b) === false) socket.pause()
      })
      socket.resume()
    }

    // Until the tunnel is up nothing is consumed from the socket: 'readable' only tells us that a
    // byte is waiting (a real connection, start now) or that the other side has closed (a probe,
    // or the SDK giving up while the tunnel is still coming up).
    socket.on('readable', onReadable)
    c.timer = setTimeout(start, probeGraceMs)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      const addr = server.address()
      log(`listening on ${addr.address}:${addr.port}`)
      resolve({
        port: addr.port,
        host: addr.address,
        stats,
        connections: () => [...live].map((c) => ({ n: c.n, state: c.state })),
        close: () =>
          new Promise((done) => {
            for (const c of [...live]) {
              c.socket.destroy()
              try {
                c.tunnel?.close()
              } catch {}
              c.abort.abort()
              clearTimeout(c.timer)
            }
            server.close(() => done())
          })
      })
    })
  })
}
