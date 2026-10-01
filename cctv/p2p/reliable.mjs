// The vendor's reliable UDP ("TNAT UDT", CTNATUdt) as a pure state machine.
// No sockets and no timers inside: the caller hands in received datagrams and the current time in
// milliseconds, and takes out the datagrams to send, the in-order stream bytes and the peer
// commands. One instance is one connection id; the datagrams of every path (relay, direct) of that
// connection go into the same instance, as the vendor keeps one sequence space per connection.
//
// What is on the wire follows the vendor's code (protocol.md, step 8):
//   - DATA carries at most 1236 bytes; the data index starts at 2 and a resend keeps its index
//     but takes a new transmit counter.
//   - every packet carries the highest transmit counter seen from the peer and the highest
//     in-order data index received (cumulative ack).
//   - ACK lists the data indexes received out of order (selective ack, at most 309 per ACK). It is
//     sent at once on a gap or a duplicate, after two data packets, or 100 ms after one; and every
//     10 s as keep-alive.
//   - RTO from RTT (srtt/8 + var, samples below 100 ms count as 100), floor 200 ms, doubling, cap 60 s.
//   - congestion window starts at 15 packets on a device link (0x200 on a server link).
//   - 60 s without a packet from the peer: RST and closed.
// The sender's congestion control follows the vendor's shape (slow start, +1 per window, x4/5 or
// x7/8 on loss, never below 15) but is not a line-by-line port; nothing of it is visible to the peer.
// Data indexes and counters are plain numbers: a connection would need 2^32 packets to wrap.
import { CATEGORY, CMD, DATA_TYPE, MAX_ACK_LIST, MAX_PAYLOAD, decodeAckList, decodeDatagram, encodeAckList, encodeDatagram } from './wire.mjs'

export const FIRST_DATA_INDEX = 2
export const RTO_FLOOR_MS = 200
export const RTO_CAP_MS = 60000
export const ACK_DELAY_MS = 100
export const KEEPALIVE_MS = 10000
export const IDLE_TIMEOUT_MS = 60000
export const RECV_WINDOW = 0x500
export const CWND_PEER = 15
export const CWND_SERVER = 0x200

const SENT = 1 // in flight
const TIMED_OUT = 2 // RTO passed
const LOST = 4 // the peer has seen a later transmit of ours and has not acked this one
// congestion modes, numbered as in CTNATUdt::ChangeMode
const SLOW_START = 0
const AVOID = 1
const AFTER_TIMEOUT = 2
const AFTER_LOSS = 4

export class ReliableLink {
  #out = []
  #bytes = []
  #peerCmds = []
  #queue = [] // not sent yet
  #sent = [] // sent, not acked; in data index order
  #recv = new Map() // data index -> { type, payload } waiting for a gap to fill
  #sack = [] // out-of-order indexes to report in the next ACK

  /**
   * connectionId  16 bytes (the rid of the P2P reply for a device link)
   * category      1 device peer (default), 2 cloud server
   * connectType   byte 3 of what we send: the path in use (setConnectType on a switch)
   * now           the caller's clock, ms
   */
  constructor({ connectionId, category = CATEGORY.PEER, connectType = 0, now = 0, cwnd, recvWindow = RECV_WINDOW, keepAliveMs = KEEPALIVE_MS, idleTimeoutMs = IDLE_TIMEOUT_MS, maxPayload = MAX_PAYLOAD } = {}) {
    if (!Buffer.isBuffer(connectionId) || connectionId.length !== 16) throw new Error('connectionId must be 16 bytes')
    this.connectionId = Buffer.from(connectionId)
    this.category = category
    this.connectType = connectType
    this.recvWindow = recvWindow
    this.keepAliveMs = keepAliveMs
    this.idleTimeoutMs = idleTimeoutMs
    this.maxPayload = Math.min(maxPayload, MAX_PAYLOAD)
    this.closed = false
    this.closeReason = null
    // sender
    this.txCounter = 0 // transmit counter of the last packet sent
    this.nextDataIndex = FIRST_DATA_INDEX
    this.ackedCounter = 0 // highest of our transmit counters the peer reported
    this.ackedIndex = FIRST_DATA_INDEX - 1 // highest of our data indexes the peer acked in order
    this.inflight = 0
    this.cwnd = cwnd ?? (category === CATEGORY.SERVER ? CWND_SERVER : CWND_PEER)
    this.ssthresh = 0x7fffffff
    this.mode = SLOW_START
    this.avoidCount = 0
    this.recoverUntil = -1 // no second cut for packets sent before this transmit counter
    this.srtt8 = 800 // smoothed RTT * 8 (starts at 100 ms)
    this.rttvar = 400
    this.rto = 200
    this.lastRtt = 100
    this.backoff = 0
    // receiver
    this.peerCounter = 0 // highest transmit counter received from the peer
    this.nextExpected = FIRST_DATA_INDEX
    this.ackState = 0 // 0 nothing owed, 1 one data packet, 2 ack now, 3 gap (ack now, with the list)
    this.ackOwedSince = 0
    this.lastPeerConnectType = null
    // clocks
    this.lastSendAt = now
    this.lastRecvAt = now
    this.stats = { dataSent: 0, resent: 0, acksSent: 0, dataReceived: 0, duplicates: 0, outOfOrder: 0, acksReceived: 0, outsideWindow: 0, bytesIn: 0, bytesOut: 0 }
  }

  // ------------------------------------------------------------------------------ caller side
  /** Queue stream bytes. They are cut into packets of at most 1236 bytes; each takes a data index now. */
  send(bytes, now) {
    if (this.closed) return 0
    for (let o = 0; o < bytes.length; o += this.maxPayload) this.#enqueue(DATA_TYPE.STREAM, Buffer.from(bytes.subarray(o, o + this.maxPayload)))
    this.stats.bytesOut += bytes.length
    if (now !== undefined) this.#pump(now)
    return bytes.length
  }

  /** Queue one peer command packet (data type 1): it takes one data index and is not stream data. */
  sendPeerCommand(packet, now) {
    if (this.closed) return false
    if (packet.length > this.maxPayload) throw new Error('peer command does not fit one datagram')
    this.#enqueue(DATA_TYPE.PEER_CMD, Buffer.from(packet))
    if (now !== undefined) this.#pump(now)
    return true
  }

  /** Datagrams to put on the socket, oldest first. */
  takeDatagrams() {
    const o = this.#out
    this.#out = []
    return o
  }

  /** In-order stream bytes received since the last call. */
  takeBytes() {
    const b = this.#bytes.length === 1 ? this.#bytes[0] : Buffer.concat(this.#bytes)
    this.#bytes = []
    return b
  }

  /** Peer command packets (data type 1) received in order since the last call. */
  takePeerCommands() {
    const c = this.#peerCmds
    this.#peerCmds = []
    return c
  }

  /** Packets not yet acked plus packets not yet sent: the caller's back-pressure measure. */
  get backlog() {
    return this.#queue.length + this.#sent.length
  }

  get idle() {
    return this.#queue.length === 0 && this.#sent.length === 0
  }

  setConnectType(ct) {
    this.connectType = ct
  }

  /** Send RST (36 bytes) and close. */
  close(reason = 'closed by caller') {
    if (this.closed) return
    this.#out.push(this.#header(CMD.RST, { sendCounter: this.txCounter }))
    this.#shut(reason)
  }

  // --------------------------------------------------------------------------------- receive
  /**
   * Hand in one received datagram. Returns what it was: 'data', 'ack', 'rst', 'syn' (not handled
   * here: the connect exchange belongs to the handshake driver), or 'ignored' (another connection
   * id or category, or not a datagram at all).
   */
  receive(datagram, now) {
    if (this.closed) return 'ignored'
    let h
    try {
      h = decodeDatagram(datagram)
    } catch {
      return 'ignored'
    }
    if (h.category !== this.category || !h.connectionId.equals(this.connectionId)) return 'ignored'
    if (h.command === CMD.SYN) return 'syn'
    if (h.command === CMD.RST) {
      this.#shut('reset by peer')
      return 'rst'
    }
    this.lastRecvAt = now
    this.lastPeerConnectType = h.connectType
    if (h.command === CMD.ACK) {
      this.stats.acksReceived++
      this.#release(h.ackIndex, h.peerCounter, now)
      this.#selectiveAck(decodeAckList(h.payload))
      this.#resend(now) // what the peer's report marked as lost goes out again at once
      this.#pump(now)
      return 'ack'
    }
    if (h.command !== CMD.DATA) return 'ignored'
    this.stats.dataReceived++
    this.#release(h.ackIndex, h.peerCounter, now)
    if (h.sendCounter > this.peerCounter) this.peerCounter = h.sendCounter
    const idx = h.dataIndex
    if (idx - this.nextExpected >= this.recvWindow) this.stats.outsideWindow++
    else if (idx === this.nextExpected) {
      this.#deliver(h.dataType, h.payload)
      this.nextExpected++
      let filled = false
      while (this.#recv.size) {
        const held = this.#recv.get(this.nextExpected)
        if (!held) break
        this.#recv.delete(this.nextExpected)
        this.#deliver(held.type, held.payload)
        this.nextExpected++
        filled = true
      }
      // a packet that closes a gap is acked at once, so the sender stops resending
      this.#owe(now, filled || this.ackState !== 0 ? 2 : 1)
    } else if (idx > this.nextExpected) {
      this.stats.outOfOrder++
      this.#sack.push(idx)
      if (!this.#recv.has(idx)) this.#recv.set(idx, { type: h.dataType, payload: Buffer.from(h.payload) })
      else this.stats.duplicates++
      this.#owe(now, 3)
    } else {
      this.stats.duplicates++
      this.#owe(now, 2)
    }
    this.#resend(now)
    this.#pump(now) // data going out carries the ack; see #transmit
    if (this.ackState >= 2) this.#sendAck(now)
    return 'data'
  }

  // ----------------------------------------------------------------------------------- timers
  /** Run the timers: resend, delayed ACK, keep-alive, idle timeout. Call it at least every 10-50 ms, or at nextWake(). */
  tick(now) {
    if (this.closed) return
    if (now - this.lastRecvAt >= this.idleTimeoutMs) {
      this.#out.push(this.#header(CMD.RST, { sendCounter: this.txCounter }))
      this.#shut('idle timeout')
      return
    }
    this.#resend(now)
    this.#pump(now)
    if (this.ackState >= 2 || (this.ackState === 1 && now - this.ackOwedSince >= ACK_DELAY_MS)) this.#sendAck(now)
    if (now - this.lastSendAt >= this.keepAliveMs) this.#sendAck(now)
  }

  /** The time (ms, same clock) at which tick() next has something to do. */
  nextWake(now) {
    if (this.closed) return Infinity
    let t = Math.min(this.lastRecvAt + this.idleTimeoutMs, this.lastSendAt + this.keepAliveMs)
    if (this.ackState === 1) t = Math.min(t, this.ackOwedSince + ACK_DELAY_MS)
    if (this.ackState >= 2) t = now
    const rto = this.currentRto
    for (const p of this.#sent) t = Math.min(t, p.state === SENT ? p.sentAt + rto : now)
    return Math.max(t, now)
  }

  /** The resend timeout in force: rto << backoff, between 200 ms and 60 s. */
  get currentRto() {
    return Math.max(RTO_FLOOR_MS, Math.min(RTO_CAP_MS, this.rto * 2 ** Math.min(this.backoff, 16)))
  }

  // ---------------------------------------------------------------------------------- inside
  #shut(reason) {
    this.closed = true
    this.closeReason = reason
    this.#queue = []
    this.#sent = []
    this.#recv.clear()
    this.#sack = []
  }

  #enqueue(type, payload) {
    this.#queue.push({ type, payload, idx: this.nextDataIndex++, state: 0, sentAt: 0, txCounter: 0 })
  }

  #header(command, fields, payload) {
    return encodeDatagram(
      { category: this.category, command, connectType: this.connectType, connectionId: this.connectionId, peerCounter: this.peerCounter, ackIndex: this.nextExpected - 1, ...fields },
      payload
    )
  }

  #deliver(type, payload) {
    if (type === DATA_TYPE.PEER_CMD) this.#peerCmds.push(Buffer.from(payload))
    else {
      this.#bytes.push(Buffer.from(payload))
      this.stats.bytesIn += payload.length
    }
  }

  #owe(now, state) {
    if (this.ackState === 0) this.ackOwedSince = now
    if (state > this.ackState) this.ackState = state
  }

  #transmit(p, now) {
    p.txCounter = ++this.txCounter
    p.sentAt = now
    p.state = SENT
    this.inflight++
    this.#out.push(this.#header(CMD.DATA, { dataType: p.type, sendCounter: p.txCounter, dataIndex: p.idx }, p.payload))
    this.lastSendAt = now
    // a data packet carries the cumulative ack; only a gap report still needs its own ACK
    if (this.ackState === 1 || this.ackState === 2) this.ackState = 0
  }

  #pump(now) {
    while (this.#queue.length && this.inflight < this.cwnd) {
      const p = this.#queue.shift()
      this.#sent.push(p)
      this.#transmit(p, now)
      this.stats.dataSent++
    }
  }

  #sendAck(now) {
    const list = this.#sack.splice(0, MAX_ACK_LIST)
    this.#out.push(this.#header(CMD.ACK, { sendCounter: this.txCounter }, encodeAckList(list)))
    this.ackState = this.#sack.length ? 3 : 0
    this.lastSendAt = now
    this.stats.acksSent++
  }

  // CTNATUdt::CalculateRTO: Jacobson with a 100 ms minimum sample
  #measure(now, sentAt) {
    const rtt = Math.min(32767, Math.max(0, now - sentAt))
    this.lastRtt = rtt
    const delta = Math.max(100, rtt) - (this.srtt8 >> 3)
    this.srtt8 += delta
    this.rttvar = this.rttvar - (this.rttvar >> 2) + Math.abs(delta)
    this.rto = this.rttvar + (this.srtt8 >> 3)
  }

  #grow(n) {
    for (let i = 0; i < n; i++) {
      if (this.mode === AVOID) {
        if (++this.avoidCount >= this.cwnd) {
          this.avoidCount = 0
          this.cwnd++
        }
      } else if (this.mode === SLOW_START) {
        if (++this.cwnd > this.ssthresh) this.#setMode(AVOID)
      }
    }
  }

  // CTNATUdt::ChangeMode
  #setMode(m) {
    if (m === SLOW_START) this.mode = SLOW_START
    else if (m === AVOID) {
      if (this.mode === AFTER_LOSS) this.cwnd = this.ssthresh
      this.avoidCount = 0
      this.mode = AVOID
    } else if (m === AFTER_LOSS) {
      this.mode = AFTER_LOSS
      this.ssthresh = Math.max(20, (this.cwnd * 7) >> 3)
    } else if (m === AFTER_TIMEOUT) {
      const base = this.mode === AFTER_LOSS ? this.ssthresh : this.cwnd
      if (this.mode !== AFTER_LOSS) this.ssthresh = this.cwnd
      this.cwnd = Math.max(CWND_PEER, Math.trunc((base * 4) / 5))
      if (this.ssthresh < 20) this.ssthresh = 20
      this.mode = AFTER_TIMEOUT
    }
  }

  // CTNATUdt::ReleaseReliableData: cumulative ack by data index, loss marking by transmit counter
  #release(ackIndex, peerSawCounter, now) {
    const newCounter = peerSawCounter > this.ackedCounter
    if (newCounter) {
      this.ackedCounter = peerSawCounter
      this.backoff = 0
    }
    const newAck = ackIndex > this.ackedIndex
    if (newAck) {
      this.ackedIndex = ackIndex
      if (this.mode === AFTER_TIMEOUT || this.mode === AFTER_LOSS) {
        this.recoverUntil = this.txCounter
        this.#setMode(this.mode === AFTER_TIMEOUT ? SLOW_START : AVOID)
      }
      while (this.#sent.length && this.#sent[0].idx <= ackIndex) {
        const p = this.#sent.shift()
        if (p.state === SENT) {
          this.inflight--
          this.#grow(1)
        }
        this.#measure(now, p.sentAt)
      }
    }
    if (newCounter) {
      for (const p of this.#sent) {
        if (peerSawCounter <= p.txCounter) break
        if (p.state === SENT) {
          p.state = LOST
          this.inflight--
        }
      }
    }
  }

  // CTNATUdt::HandleRecvAckData: the list part
  #selectiveAck(indexes) {
    let freed = 0
    for (const idx of indexes) {
      const i = this.#sent.findIndex((p) => p.idx === idx)
      if (i < 0) continue
      if (this.#sent[i].state === SENT) freed++
      this.#sent.splice(i, 1)
    }
    if (freed) {
      this.inflight -= freed
      this.#grow(freed)
    }
  }

  // CTNATUdt::ResendData
  #resend(now) {
    const rto = this.currentRto
    let marked = 0
    for (const p of this.#sent) {
      if (p.state === SENT && now - p.sentAt >= rto) {
        p.state = TIMED_OUT
        this.inflight--
      }
      if (p.state !== SENT) marked++
    }
    if (!marked) return
    for (let i = 0; i < this.#sent.length; i++) {
      const p = this.#sent[i]
      if (p.state === SENT) continue
      const sentBefore = p.txCounter
      this.#transmit(p, now)
      this.stats.resent++
      if (i === 0) {
        if (sentBefore > this.recoverUntil) this.#setMode(marked < this.cwnd >> 1 ? AFTER_LOSS : AFTER_TIMEOUT)
        this.backoff++
      }
      // while the head keeps timing out, only the head is retried
      if (this.backoff >= 2) break
    }
  }
}
