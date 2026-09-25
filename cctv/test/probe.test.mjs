// Tests for the TCP reachability probe (probe.mjs) that runs before an SDK login.
// Pure node:net and no SDK, so this runs anywhere, Windows included:
//   node cctv/test/probe.test.mjs
import { createServer } from 'node:net'
import { PROBE_MS, probeTarget, tcpReachable } from '../probe.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

/** A listening socket on 127.0.0.1, standing in for an NVR that is on the network. */
const listen = () =>
  new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })

// ---- a reachable address ---------------------------------------------------
{
  const { server, port } = await listen()
  const r = await tcpReachable('127.0.0.1', port)
  check('a listening NVR is reachable', r.ok === true && r.why === '', JSON.stringify(r))
  check('the probe of a reachable NVR is quick (no noticeable cost on the normal path)', r.ms < 250, `${r.ms} ms`)
  server.close()
}

// ---- refused: nothing listening on that port -------------------------------
{
  const { server, port } = await listen()
  await new Promise((r) => server.close(r))
  const r = await tcpReachable('127.0.0.1', port, 2000)
  check('a refused connection counts as unreachable, at once', r.ok === false && r.ms < 1000, JSON.stringify(r))
  check('the reason names the address', r.why.includes(`127.0.0.1:${port}`), r.why)
}

// ---- no answer at all: the live fault (NVR off the network) ----------------
{
  // 203.0.113.0/24 is reserved for documentation (RFC 5737): nothing answers, nothing refuses
  const t0 = Date.now()
  const r = await tcpReachable('203.0.113.1', 6036, 400)
  const took = Date.now() - t0
  // either the handshake times out, or the host is unreachable straight away: both are "not there"
  check('an address that does not answer fails within the probe timeout', r.ok === false && took < 2000, `${JSON.stringify(r)} after ${took} ms`)
}

// ---- a name that will not resolve: no verdict, the login goes ahead --------
{
  const r = await tcpReachable('nvr-a.invalid', 6036, 1000)
  check('an unresolvable name skips the probe rather than failing the login', r.ok === true && r.skipped === true, JSON.stringify(r))
}

// ---- never throws ----------------------------------------------------------
{
  const bad = [
    [undefined, undefined],
    ['127.0.0.1', -1],
    ['127.0.0.1', 'not a port'],
    ['', 6036],
    [{}, {}]
  ]
  let threw = null
  for (const [h, p] of bad) {
    try {
      await tcpReachable(h, p, 200)
    } catch (e) {
      threw = `${h}:${p} ${e.message}`
    }
  }
  check('the probe never throws, whatever it is given', threw === null, threw ?? '')
}

// ---- probeTarget: when a probe can sensibly be made ------------------------
{
  check('an address is probed', JSON.stringify(probeTarget({ host: '192.168.194.50', port: 6036 })) === JSON.stringify({ host: '192.168.194.50', port: 6036 }))
  check('a hostname is probed', probeTarget({ host: 'nvr.example.com', port: 6036 })?.port === 6036)
  check('a numeric string port is probed', probeTarget({ host: '10.0.0.1', port: '6036' })?.port === 6036)
  check('no host: no probe', probeTarget({ host: '', port: 6036 }) === null)
  check('no port: no probe', probeTarget({ host: '10.0.0.1', port: 0 }) === null)
  check('a nonsense port: no probe', probeTarget({ host: '10.0.0.1', port: 'x' }) === null)
  check('a nonsense host: no probe', probeTarget({ host: 'not a host!', port: 6036 }) === null)
  check('nothing at all: no probe', probeTarget() === null && probeTarget({}) === null)
  // a relay/P2P NVR has the relay's address in host/port, which is what the SDK connects to
  check('a relay address is probed like any other', probeTarget({ host: 'c2020.autonat.com', port: 7968 })?.host === 'c2020.autonat.com')
}

check('the default probe timeout is short', PROBE_MS > 0 && PROBE_MS <= 5000, String(PROBE_MS))

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
