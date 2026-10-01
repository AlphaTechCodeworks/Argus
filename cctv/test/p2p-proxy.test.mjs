// Offline tests for the local TCP side of the P2P tunnel helper (p2p/proxy.mjs), against a fake
// in-process "tunnel". Loopback sockets on 127.0.0.1 only; nothing leaves this machine.
//   node cctv/test/p2p-proxy.test.mjs
import { EventEmitter } from 'node:events'
import { connect } from 'node:net'
import { startProxy } from '../p2p/proxy.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 3000) => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) return false
    await sleep(5)
  }
  return true
}

// 64 made-up bytes shaped like the NVR greeting: "head" first
const HEAD = Buffer.concat([Buffer.from('head'), Buffer.alloc(60, 0x2e)])

/** A fake tunnel factory: every open is recorded; each tunnel greets with HEAD once it is up. */
function fakeTunnels({ openDelayMs = 0, fail = false, greet = true } = {}) {
  const made = []
  const opens = []
  const openTunnel = ({ signal }) => {
    const rec = { at: Date.now(), aborted: false }
    opens.push(rec)
    signal.addEventListener('abort', () => (rec.aborted = true))
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (fail) return reject(new Error('device offline'))
        const t = new EventEmitter()
        t.got = []
        t.closed = false
        t.paused = false
        t.write = (b) => {
          t.got.push(Buffer.from(b))
          return true
        }
        t.close = () => {
          t.closed = true
        }
        t.pause = () => (t.paused = true)
        t.resume = () => (t.paused = false)
        t.drop = () => t.emit('close')
        made.push(t)
        resolve(t)
        if (greet) setImmediate(() => t.emit('data', HEAD))
      }, openDelayMs)
    })
  }
  return { openTunnel, made, opens }
}

/** A client socket that records what it gets. */
function client(port) {
  const s = connect({ host: '127.0.0.1', port })
  const c = { s, got: [], closed: false, connected: false }
  s.on('connect', () => (c.connected = true))
  s.on('data', (b) => c.got.push(b))
  s.on('close', () => (c.closed = true))
  s.on('error', () => {})
  c.bytes = () => Buffer.concat(c.got)
  return c
}

// ---- the SDK's pattern: a probe that closes at once, then the real connection
{
  const f = fakeTunnels({ openDelayMs: 150 })
  const p = await startProxy({ openTunnel: f.openTunnel, probeGraceMs: 40 })
  check('listens on 127.0.0.1 on a free port', p.host === '127.0.0.1' && p.port > 0)

  const probe = client(p.port)
  await until(() => probe.connected)
  const real = client(p.port) // the SDK opens the second 0-2 ms after the first
  probe.s.destroy() // and closes the first within about 3 ms, without a byte
  await until(() => real.connected)
  await sleep(100)
  check('the probe connection that closed at once got no tunnel', f.opens.length === 1 && p.stats.probes === 1, `${f.opens.length} tunnel(s) opened`)
  check('the second connection is held while the tunnel comes up: nothing sent to it yet', real.got.length === 0 && !real.closed)
  check(
    'the proxy shows it as opening',
    p.connections().some((c) => c.state === 'opening')
  )

  await until(() => real.bytes().length >= 64)
  check('once the tunnel is up the greeting arrives, "head" first', real.bytes().length === 64 && real.bytes().toString('latin1', 0, 4) === 'head')
  const t = f.made[0]
  const login = Buffer.from(`1111${'x'.repeat(760)}`)
  real.s.write(login)
  await until(() => Buffer.concat(t.got).length >= login.length)
  check('bytes from the SDK reach the tunnel unchanged', Buffer.concat(t.got).equals(login))
  const reply = Buffer.alloc(200000)
  for (let i = 0; i < reply.length; i++) reply[i] = (i * 31) & 255
  for (let o = 0; o < reply.length; o += 1236) t.emit('data', reply.subarray(o, o + 1236))
  await until(() => real.bytes().length >= 64 + reply.length)
  check('bytes from the tunnel reach the SDK unchanged and in order', real.bytes().subarray(64).equals(reply))
  check('byte counters match', p.stats.bytesToTunnel === login.length && p.stats.bytesFromTunnel === 64 + reply.length)

  t.drop()
  await until(() => real.closed)
  check('when the tunnel drops the local socket is closed (the SDK will log in again)', real.closed && p.stats.tunnelDrops === 1)
  check('no connection is left', p.connections().length === 0)

  // the SDK logs in again: probe + real, a new tunnel
  const probe2 = client(p.port)
  await until(() => probe2.connected)
  const real2 = client(p.port)
  probe2.s.destroy()
  await until(() => real2.bytes().length >= 64)
  check('the next login gets a new tunnel and its greeting', f.made.length === 2 && real2.bytes().toString('latin1', 0, 4) === 'head' && p.stats.probes === 2)
  real2.s.destroy()
  await until(() => f.made[1].closed)
  check('when the SDK closes, the tunnel is closed', f.made[1].closed && p.stats.localCloses === 1)
  await p.close()
}

// ---- a probe closed with FIN (end) instead of a reset
{
  const f = fakeTunnels()
  const p = await startProxy({ openTunnel: f.openTunnel, probeGraceMs: 60 })
  const probe = client(p.port)
  await until(() => probe.connected)
  probe.s.end()
  await until(() => p.stats.probes === 1)
  await sleep(100)
  check('a probe that ends cleanly within the grace time gets no tunnel either', f.opens.length === 0 && p.stats.probes === 1)
  await p.close()
}

// ---- a connection that speaks first is real at once
{
  const f = fakeTunnels({ greet: false })
  const p = await startProxy({ openTunnel: f.openTunnel, probeGraceMs: 5000 })
  const c = client(p.port)
  c.s.write('early')
  await until(() => f.made.length === 1 && Buffer.concat(f.made[0].got).length === 5, 2000)
  check('a connection that sends a byte gets its tunnel without waiting for the grace time', f.made.length === 1)
  check('bytes sent before the tunnel was up are not lost', f.made[0] && Buffer.concat(f.made[0].got).toString() === 'early')
  c.s.destroy()
  await p.close()
}

// ---- the SDK gives up while the tunnel is still opening
{
  const f = fakeTunnels({ openDelayMs: 200 })
  const p = await startProxy({ openTunnel: f.openTunnel, probeGraceMs: 20 })
  const c = client(p.port)
  await until(() => f.opens.length === 1)
  c.s.destroy()
  await until(() => f.opens[0].aborted)
  check('closing while the tunnel is opening signals abort', f.opens[0].aborted)
  await until(() => f.made.length === 1 && f.made[0].closed)
  check('a tunnel that comes up after the SDK left is closed again', f.made.length === 1 && f.made[0].closed && p.stats.tunnelsOpened === 0)
  await p.close()
}

// ---- the tunnel cannot be opened
{
  const f = fakeTunnels({ fail: true, openDelayMs: 30 })
  const p = await startProxy({ openTunnel: f.openTunnel, probeGraceMs: 10 })
  const c = client(p.port)
  await until(() => c.closed)
  check('when the tunnel does not open, the local socket is closed with nothing sent', c.closed && c.got.length === 0 && p.stats.tunnelsFailed === 1)
  await p.close()
}

// ---- slow reader: the tunnel is asked to pause
{
  const f = fakeTunnels({ greet: false })
  const p = await startProxy({ openTunnel: f.openTunnel, probeGraceMs: 10 })
  const c = client(p.port)
  c.s.pause()
  await until(() => f.made.length === 1)
  const t = f.made[0]
  const chunk = Buffer.alloc(65536, 7)
  let sent = 0
  for (let i = 0; i < 400 && !t.paused; i++) {
    t.emit('data', chunk)
    sent += chunk.length
    await sleep(1)
  }
  check('a reader that does not read makes the proxy pause the tunnel', t.paused, `after ${sent} bytes`)
  c.s.resume()
  await until(() => !t.paused && c.bytes().length === sent, 5000)
  check('when the reader catches up the tunnel is resumed and nothing was lost', !t.paused && c.bytes().length === sent)
  c.s.destroy()
  await p.close()
}

// ---- two real connections at once: each has its own tunnel
{
  const f = fakeTunnels()
  const p = await startProxy({ openTunnel: f.openTunnel, probeGraceMs: 10 })
  const a = client(p.port)
  const b = client(p.port)
  await until(() => f.made.length === 2 && a.bytes().length === 64 && b.bytes().length === 64)
  a.s.write('AAAA')
  b.s.write('BBBB')
  await until(() => f.made.every((t) => Buffer.concat(t.got).length === 4))
  const texts = f.made
    .map((t) => Buffer.concat(t.got).toString())
    .sort()
    .join()
  check('two connections held open do not mix their bytes', texts === 'AAAA,BBBB')
  f.made[0].drop()
  await until(() => a.closed || b.closed)
  await sleep(30)
  check('one tunnel dropping closes only its own socket', a.closed !== b.closed)
  await p.close()
  await until(() => a.closed && b.closed)
  check('closing the proxy closes what is left', a.closed && b.closed)
}

{
  let refused = false
  try {
    startProxy({})
  } catch {
    refused = true
  }
  check('openTunnel must be given', refused)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
