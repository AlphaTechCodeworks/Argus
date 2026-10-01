// Offline tests for the reliable UDP state machine (p2p/reliable.mjs). Two instances talk through
// a seeded pseudo-random channel (loss, reordering, duplication) on a simulated clock: no sockets,
// no real time, the same result on every run.
//   node cctv/test/p2p-reliable.test.mjs
import { createHash } from 'node:crypto'
import { ReliableLink } from '../p2p/reliable.mjs'
import { CATEGORY, CMD, decodeAckList, decodeDatagram, encodeDatagram } from '../p2p/wire.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const id = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
const other = Buffer.alloc(16, 9)
const sha = (b) => createHash('sha256').update(b).digest('hex')

// mulberry32: a small seeded generator
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pattern = (n, seed) => {
  const r = rng(seed)
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (r() * 256) | 0
  return b
}
const data = (link) => link.takeDatagrams().map((d) => decodeDatagram(d))

// ------------------------------------------------------------------ single-link wire behaviour
{
  const a = new ReliableLink({ connectionId: id, connectType: 3 })
  a.send(Buffer.alloc(3000, 1), 0)
  const out = data(a)
  check('3000 bytes go out as 1236 + 1236 + 528', out.map((h) => h.payload.length).join() === '1236,1236,528')
  check('the first data index is 2, then 3, 4', out.map((h) => h.dataIndex).join() === '2,3,4')
  check('transmit counters count from 1', out.map((h) => h.sendCounter).join() === '1,2,3')
  check('header: category 1, DATA, stream type, the connect type given', out[0].category === 1 && out[0].command === CMD.DATA && out[0].dataType === 0 && out[0].connectType === 3)
  check('before anything is received: peer counter 0, ack index 1', out[0].peerCounter === 0 && out[0].ackIndex === 1)
  check('no datagram is larger than 1272 bytes', out.every((h) => h.payload.length + 36 <= 1272))
}
{
  const a = new ReliableLink({ connectionId: id })
  a.send(Buffer.alloc(1236 * 40, 1), 0)
  check('the congestion window starts at 15 packets on a device link', a.takeDatagrams().length === 15 && a.backlog === 40)
  const s = new ReliableLink({ connectionId: id, category: CATEGORY.SERVER })
  s.send(Buffer.alloc(1236 * 40, 1), 0)
  const o = s.takeDatagrams()
  check('a server link uses category 2 and a window of 0x200', o.length === 40 && o[0][0] === 2)
}
{
  // delayed ACK, ACK after two, cumulative ack fields
  const a = new ReliableLink({ connectionId: id })
  const b = new ReliableLink({ connectionId: id })
  a.send(Buffer.from('one'), 0)
  const [d1] = a.takeDatagrams()
  check('a data datagram is reported as "data"', b.receive(d1, 5) === 'data')
  check('one data packet: no ACK at once', b.takeDatagrams().length === 0)
  b.tick(50)
  check('one data packet: still no ACK after 45 ms', b.takeDatagrams().length === 0)
  b.tick(105)
  const acks = data(b)
  check('one data packet: an ACK 100 ms later', acks.length === 1 && acks[0].command === CMD.ACK)
  check('ACK is 36 bytes with no list', acks[0].payload.length === 0)
  check('ACK words: own counter 0, peer counter 1, 0, highest in-order index 2', acks[0].sendCounter === 0 && acks[0].peerCounter === 1 && acks[0].dataIndex === 0 && acks[0].ackIndex === 2)
  check('the bytes came out', b.takeBytes().toString() === 'one')

  a.send(Buffer.from('two'), 200)
  a.send(Buffer.from('three'), 200)
  for (const d of a.takeDatagrams()) b.receive(d, 210)
  const two = data(b)
  check('two data packets: one ACK at once', two.length === 1 && two[0].command === CMD.ACK && two[0].ackIndex === 4 && two[0].peerCounter === 3)
  check('an ACK is reported as "ack" and frees the sender', a.receive(encodeDatagram(two[0], two[0].payload), 230) === 'ack' && a.idle)
}
{
  // gap: selective ACK at once; the hole is filled by the resend
  const a = new ReliableLink({ connectionId: id })
  const b = new ReliableLink({ connectionId: id })
  a.send(Buffer.concat([Buffer.alloc(1236, 1), Buffer.alloc(1236, 2), Buffer.alloc(1236, 3), Buffer.alloc(10, 4)]), 0)
  const [p2, p3, p4, p5] = a.takeDatagrams()
  b.receive(p2, 1)
  b.receive(p4, 2) // p3 is lost
  const g = data(b)
  check('a gap gives an ACK at once', g.length === 1 && g[0].command === CMD.ACK)
  check('that ACK lists the out-of-order index and keeps the cumulative ack', decodeAckList(g[0].payload).join() === '4' && g[0].ackIndex === 2 && g[0].peerCounter === 3)
  b.receive(p5, 3)
  const g2 = data(b)
  check('the next out-of-order packet is listed in its own ACK', decodeAckList(g2[0].payload).join() === '5')
  check('nothing after the gap is delivered yet', b.takeBytes().length === 1236)
  a.receive(encodeDatagram(g[0], g[0].payload), 4)
  const re = data(a)
  check('the sender resends the missing packet at once (the peer saw a later transmit)', re.length === 1 && re[0].dataIndex === 3)
  check('a resend keeps its data index and takes a new transmit counter', re[0].sendCounter === 5)
  a.receive(encodeDatagram(g2[0], g2[0].payload), 5)
  check('selectively acked packets are not resent', a.takeDatagrams().length === 0 && a.backlog === 1)
  b.receive(encodeDatagram(re[0], re[0].payload), 6)
  const rest = b.takeBytes()
  check('the hole filled: everything after it is delivered in order', rest.length === 1236 * 2 + 10 && rest[0] === 2 && rest[1236] === 3 && rest[2472] === 4)
  const fin = data(b)
  check('cumulative ack now covers the lot', fin.at(-1).ackIndex === 5)
  a.receive(encodeDatagram(fin.at(-1), fin.at(-1).payload), 7)
  check('sender is idle', a.idle)
}
{
  // RTO: floor 200 ms, doubling
  const a = new ReliableLink({ connectionId: id })
  a.send(Buffer.from('x'), 0)
  a.takeDatagrams()
  a.tick(199)
  check('no resend before 200 ms', a.takeDatagrams().length === 0)
  a.tick(200)
  const r1 = data(a)
  check('resend at 200 ms (the RTO floor)', r1.length === 1 && r1[0].dataIndex === 2 && r1[0].sendCounter === 2)
  a.tick(599)
  check('the next resend waits twice as long', a.takeDatagrams().length === 0)
  a.tick(600)
  check('second resend at +400 ms', data(a).length === 1)
  a.tick(1399)
  const none = a.takeDatagrams().length
  a.tick(1400)
  check('third resend at +800 ms', none === 0 && data(a).length === 1)
  check('the RTO is capped at 60 s', (() => {
    const l = new ReliableLink({ connectionId: id })
    l.backoff = 30
    return l.currentRto === 60000
  })())
}
{
  // duplicates
  const a = new ReliableLink({ connectionId: id })
  const b = new ReliableLink({ connectionId: id })
  a.send(Buffer.from('dup'), 0)
  const [d] = a.takeDatagrams()
  b.receive(d, 1)
  b.receive(d, 2)
  check('a duplicate is delivered once', b.takeBytes().toString() === 'dup' && b.stats.duplicates === 1)
  check('a duplicate is answered with an ACK at once', data(b).some((h) => h.command === CMD.ACK && h.ackIndex === 2))
}
{
  // peer command
  const a = new ReliableLink({ connectionId: id })
  const b = new ReliableLink({ connectionId: id })
  a.send(Buffer.from('head'), 0)
  a.sendPeerCommand(Buffer.from('COMMAND'), 0)
  a.send(Buffer.from('tail'), 0)
  const out = a.takeDatagrams()
  check('a peer command goes as 01 11 and takes one data index', out[1][1] === 0x11 && decodeDatagram(out[1]).dataIndex === 3 && decodeDatagram(out[2]).dataIndex === 4)
  for (const d of out) b.receive(d, 1)
  check('the peer command is not part of the byte stream', b.takeBytes().toString() === 'headtail')
  const cmds = b.takePeerCommands()
  check('the peer command comes out on its own', cmds.length === 1 && cmds[0].toString() === 'COMMAND')
}
{
  // keep-alive, idle timeout, RST, foreign packets, window
  const a = new ReliableLink({ connectionId: id, now: 1000 })
  a.tick(10999)
  check('no keep-alive before 10 s', a.takeDatagrams().length === 0)
  a.tick(11000)
  const k = data(a)
  check('a keep-alive ACK after 10 s of sending nothing', k.length === 1 && k[0].command === CMD.ACK && k[0].payload.length === 0)
  a.tick(21000)
  check('and again 10 s later', data(a).length === 1)
  a.tick(60999)
  check('not closed before 60 s of silence', !a.closed)
  a.tick(61000)
  const r = data(a)
  check('60 s without a packet from the peer: RST, 36 bytes, and closed', a.closed && a.closeReason === 'idle timeout' && r.at(-1).command === CMD.RST && r.at(-1).payload.length === 0)
  check('a closed link sends nothing more', a.send(Buffer.from('x'), 61001) === 0 && a.takeDatagrams().length === 0)

  const b = new ReliableLink({ connectionId: id })
  const ka = new ReliableLink({ connectionId: id })
  ka.tick(10000)
  const [alive] = ka.takeDatagrams()
  b.receive(alive, 50000)
  b.tick(100000)
  check('a keep-alive from the peer holds the link open', !b.closed)

  const c = new ReliableLink({ connectionId: id })
  check('RST from the peer closes the link', c.receive(encodeDatagram({ category: 1, command: CMD.RST, connectionId: id }), 1) === 'rst' && c.closed && c.closeReason === 'reset by peer')

  const d = new ReliableLink({ connectionId: id })
  check('a datagram for another connection id is ignored', d.receive(encodeDatagram({ category: 1, command: CMD.RST, connectionId: other }), 1) === 'ignored' && !d.closed)
  check('a datagram of the other category is ignored', d.receive(encodeDatagram({ category: 2, command: CMD.RST, connectionId: id }), 1) === 'ignored' && !d.closed)
  check('a SYN is handed back to the caller', d.receive(encodeDatagram({ category: 1, command: CMD.SYN, connectionId: id }, Buffer.alloc(4)), 1) === 'syn')
  check('garbage is ignored', d.receive(Buffer.from('hello'), 1) === 'ignored')
  d.receive(encodeDatagram({ category: 1, command: CMD.DATA, connectionId: id, sendCounter: 1, dataIndex: 2 + 0x500 }, Buffer.from('far')), 1)
  check('a data index 0x500 or more ahead is outside the window and dropped', d.stats.outsideWindow === 1 && d.takeBytes().length === 0)
  d.receive(encodeDatagram({ category: 1, command: CMD.DATA, connectionId: id, sendCounter: 2, dataIndex: 2 + 0x4ff, connectType: 4 }, Buffer.from('edge')), 1)
  check('one below that is held', d.stats.outOfOrder === 1)
  check('the path a packet came on is recorded, any path is accepted', d.lastPeerConnectType === 4)

  const e = new ReliableLink({ connectionId: id })
  e.close()
  check('close() sends one RST', e.closed && e.takeDatagrams().length === 1)
  check('an ACK list of more than 309 indexes is sent in pieces', (() => {
    const l = new ReliableLink({ connectionId: id })
    for (let i = 0; i < 400; i++) l.receive(encodeDatagram({ category: 1, command: CMD.DATA, connectionId: id, sendCounter: i + 1, dataIndex: 3 + i }, Buffer.from([i & 255])), 1)
    const lists = data(l).map((h) => decodeAckList(h.payload).length)
    return lists.every((n) => n <= 309) && lists.reduce((x, y) => x + y, 0) === 400
  })())
}

// ----------------------------------------------------------- two links over a bad channel
/**
 * Run A <-> B until both streams are delivered or `limitMs` of simulated time passes.
 * Each datagram is, by the seeded generator: dropped (loss), delivered twice (dup), and delayed by
 * `delay` ms plus up to `jitter` ms, which reorders.
 */
function run({ seed, loss = 0, dup = 0, delay = 20, jitter = 0, bytesA = 300000, bytesB = 60000, peerCmds = 0, limitMs = 600000 }) {
  const r = rng(seed)
  const a = new ReliableLink({ connectionId: id })
  const b = new ReliableLink({ connectionId: id })
  const srcA = pattern(bytesA, seed + 1)
  const srcB = pattern(bytesB, seed + 2)
  const gotA = []
  const gotB = []
  let cmdsAtB = 0
  let wire = [] // { at, to, d }
  let now = 0
  let sent = 0
  let dropped = 0
  let offA = 0
  let offB = 0
  let cmdsSent = 0
  const carry = (from, to) => {
    for (const d of from.takeDatagrams()) {
      sent++
      if (r() < loss) {
        dropped++
        continue
      }
      const copies = r() < dup ? 2 : 1
      for (let i = 0; i < copies; i++) wire.push({ at: now + delay + Math.floor(r() * (jitter + 1)), to, d })
    }
  }
  let lenA = 0
  let lenB = 0
  while (now < limitMs) {
    // the applications write in pieces, as a TCP socket would hand them over
    if (offA < srcA.length && a.backlog < 64) {
      const n = 1 + Math.floor(r() * 5000)
      a.send(srcA.subarray(offA, offA + n), now)
      offA += n
      if (cmdsSent < peerCmds && r() < 0.2) a.sendPeerCommand(Buffer.from(`cmd${cmdsSent++}`), now)
    }
    if (offB < srcB.length && b.backlog < 64) {
      const n = 1 + Math.floor(r() * 5000)
      b.send(srcB.subarray(offB, offB + n), now)
      offB += n
    }
    const due = wire.filter((w) => w.at <= now)
    wire = wire.filter((w) => w.at > now)
    for (const w of due) w.to.receive(w.d, now)
    a.tick(now)
    b.tick(now)
    carry(a, b)
    carry(b, a)
    const xb = b.takeBytes()
    if (xb.length) gotB.push(xb), (lenB += xb.length)
    const xa = a.takeBytes()
    if (xa.length) gotA.push(xa), (lenA += xa.length)
    cmdsAtB += b.takePeerCommands().length
    if (lenB === srcA.length && lenA === srcB.length && a.idle && b.idle && offA >= srcA.length && offB >= srcB.length) break
    now += 5
  }
  return {
    okAB: sha(Buffer.concat(gotB)) === sha(srcA),
    okBA: sha(Buffer.concat(gotA)) === sha(srcB),
    ms: now,
    sent,
    dropped,
    resent: a.stats.resent + b.stats.resent,
    dups: a.stats.duplicates + b.stats.duplicates,
    ooo: a.stats.outOfOrder + b.stats.outOfOrder,
    cmdsAtB,
    cmdsSent,
    closed: a.closed || b.closed,
    a,
    b
  }
}
const say = (r) => `${r.ms} ms simulated, ${r.sent} datagrams, ${r.dropped} dropped, ${r.resent} resent, ${r.ooo} out of order, ${r.dups} duplicates`

{
  const r = run({ seed: 1 })
  check('clean channel: both streams arrive byte for byte', r.okAB && r.okBA && !r.closed, say(r))
  check('clean channel: nothing is resent', r.resent === 0)
}
{
  const r = run({ seed: 2, loss: 0.05 })
  check('5 % loss: both streams arrive byte for byte', r.okAB && r.okBA && !r.closed, say(r))
  check('5 % loss: packets were dropped and resent', r.dropped > 0 && r.resent > 0)
}
{
  const r = run({ seed: 3, loss: 0.2 })
  check('20 % loss: both streams arrive byte for byte', r.okAB && r.okBA && !r.closed, say(r))
}
{
  const r = run({ seed: 4, jitter: 80 })
  check('reordering (0-80 ms jitter): both streams arrive byte for byte', r.okAB && r.okBA && !r.closed, say(r))
  check('reordering: packets did arrive out of order', r.ooo > 0)
}
{
  const r = run({ seed: 5, dup: 0.3 })
  check('30 % duplication: both streams arrive byte for byte', r.okAB && r.okBA && !r.closed, say(r))
  check('duplication: duplicates were seen and dropped', r.dups > 0)
}
{
  const r = run({ seed: 6, loss: 0.1, dup: 0.1, jitter: 60, peerCmds: 5 })
  check('10 % loss + 10 % duplication + reordering: both streams arrive byte for byte', r.okAB && r.okBA && !r.closed, say(r))
  check('peer commands arrive exactly once each through the same channel', r.cmdsSent === 5 && r.cmdsAtB === 5, `${r.cmdsAtB}/${r.cmdsSent}`)
}
{
  const r = run({ seed: 7, loss: 0.1, dup: 0.1, jitter: 60, delay: 150, bytesA: 100000, bytesB: 100000 })
  check('the same on a slow path (150 ms each way): both streams arrive', r.okAB && r.okBA && !r.closed, say(r))
}
{
  let ok = true
  let worst = 0
  for (let seed = 100; seed < 120; seed++) {
    const r = run({ seed, loss: 0.15, dup: 0.05, jitter: 100, bytesA: 80000, bytesB: 20000 })
    if (!r.okAB || !r.okBA || r.closed) ok = false
    worst = Math.max(worst, r.ms)
  }
  check('20 more seeds at 15 % loss, 5 % duplication, 0-100 ms jitter: every run delivers both streams', ok, `slowest ${worst} ms simulated`)
}
{
  const x = run({ seed: 8, loss: 0.1, jitter: 40, bytesA: 50000, bytesB: 0 })
  const y = run({ seed: 8, loss: 0.1, jitter: 40, bytesA: 50000, bytesB: 0 })
  check('the channel is seeded: the same seed gives the same run', x.sent === y.sent && x.dropped === y.dropped && x.ms === y.ms)
}
{
  const r = run({ seed: 9, loss: 1, bytesA: 5000, bytesB: 0, limitMs: 70000 })
  check('a dead path: both sides close after 60 s, nothing is delivered', r.closed && r.a.closeReason === 'idle timeout' && !r.okAB)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
