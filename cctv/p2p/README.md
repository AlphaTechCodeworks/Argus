# P2P tunnel helper, stage 1 (offline)

Goal: Argus's vendor SDK logs in to `127.0.0.1:<port>`; this helper carries those bytes to the NVR
through the vendor's P2P 2.0 cloud path. Inside the tunnel the bytes are the ordinary TCP 6036
protocol (`head` greeting, `1111` commands), unencrypted. Stage 1 is the protocol code and its
tests only: **nothing here opens a UDP socket or talks to any host.** Node standard library only.

Source of every layout: static analysis of the vendor's `libNatClientSDK.so.1` 1.1.1 (and the
Windows 1.1.2 DLL), written up outside the repository (`protocol.md`). Addresses in comments
(`@0011a2d0`) are Ghidra addresses in that library.

## What is implemented

| File | What |
|---|---|
| `wire.mjs` | 36-byte datagram header (category, command, data type, connect type, connection id, send counter, peer counter, data index, ack index); connector SYN (u16 step, u16 version 0x0102) and RST; ACK list; `1010` stream record incl. the split form for packets over 0x12bf8 bytes and an incremental `RecordParser`; command packet envelope for encrypt types 0-3; 16-byte command header; items (id, ver 4, count, length); CRC-32 |
| `crypt.mjs` | XOR (4-byte key in the packet); RSA-1024 key pair as PKCS#1 PEM (251-byte public PEM), PKCS#1 v1.5 block decrypt (117 -> 128 bytes per block); AES-ECB 128/192/256; session key = 16 key bytes as 32 lowercase hex characters; `sealCommand` / `openCommand` for all four types with the CRC-32 over the padded plain text; the "aligned" AES of the SYN bodies |
| `messages.mjs` | redirect request (cmd 0x2) and reply (items 0x04, 0x05); P2P connect request (0x303, item 0x33) and reply (items 0x34, 0x36, 0x24, 0x23, 0x35, with the `clt` column table turned into candidates); peer SYN steps 1-4 with the vendor's checks (`answerSynStep1/2/3`); relay step 1 (cmd 0x202, items 0x22 + 0x23); peer command 0x203 (item 0x25); `serverDatagrams` to put a command on a server link |
| `reliable.mjs` | the vendor's reliable UDP as a pure state machine (datagrams in, datagrams + in-order bytes + peer commands out, caller's clock): data index from 2, <= 1236 bytes per datagram, cumulative ack, selective ACK lists (<= 309), loss marking by transmit counter, RTO from RTT (100 ms minimum sample, 200 ms floor, doubling, 60 s cap), window 15 (device) / 0x200 (server), receive window 0x500, 10 s keep-alive ACK, 60 s idle timeout -> RST |
| `proxy.mjs` | local TCP side: listens on 127.0.0.1, ignores the SDK's probe connection (closed within ms, no byte), holds the real one unread until the tunnel is up, copies both ways with back-pressure, closes the socket when the tunnel drops |
| `pcapng.mjs` | capture reader (pcapng and classic pcap) for the offline checks only |

Every value that is not known is a named parameter with an `UNKNOWN:` comment where it enters
(`messages.mjs`). Nothing is defaulted silently: `cty`, `p2v`, the serial, our address and port
must be passed in.

Not ported line by line: the sender's congestion control (`reliable.mjs` follows the vendor's
shape; the peer cannot see it), the connector resend schedule of SYN packets, the port collider and
NAT type test of connect type 1 (hole punching). None of that is needed for the lan, upnp and relay
paths.

## Tests

Plain node scripts, PASS/FAIL lines, exit code 1 on failure:

```
node cctv/test/p2p-wire.test.mjs       # layouts
node cctv/test/p2p-crypt.test.mjs      # crypto (FIPS-197 vectors, RSA round trips, CRC)
node cctv/test/p2p-messages.test.mjs   # every message both ways, the checks, sizes
node cctv/test/p2p-reliable.test.mjs   # loss / reordering / duplication on a seeded channel
node cctv/test/p2p-proxy.test.mjs      # loopback sockets against a fake tunnel
P2P_CAPTURE_DIR=<captures> [P2P_STREAM_DIR=<earlier rebuilt streams>] node cctv/test/p2p-capture.test.mjs
```

The capture test prints SKIP without `P2P_CAPTURE_DIR`. No capture byte, serial, key or address
is in the repository; the fixtures are synthetic.

## Verified against the owner's captures (13 files, run 2026-10-01)

- All 992,709 P2P 2.0 datagrams in the captures decode with `wire.mjs` and encode back
  byte-identical; every one has the structure of its kind (SYN step/version, zero words, ACK list,
  `1010` on the first packet of a server link). NAT 1.0 traffic on port 8989 is a different protocol
  and is left out.
- Redirect request: the 5 captured requests (394 and 405 bytes) were opened (XOR), and built again
  by `messages.mjs` from the same inputs: **byte-identical on the wire**, `1010` length, PEM of 251
  bytes, JSON `{"rt":"p2p","cid":"","isp":"","svid":"","cty":5,["isfull":1,]"et":1}`.
- Server links rebuilt with `reliable.mjs` + `RecordParser` (415 links): every one is whole records.
  RSA replies: 312 bytes (plain 180, 2 blocks) and the 4-datagram full list (plain 3906, 34 blocks).
- AES: all 226 client packets use `(plain & ~15) + 16` cipher bytes (the client code); all 176
  server replies where the forms differ use **no extra block** (`{"ol":0}`: plain 32, 32 cipher
  bytes, 100 on the wire). `openCommand` accepts both; `sealCommand(..., { serverStyle })` builds
  the server form for a fake server.
- P2P connect requests (340 bytes, plain 267) and the other client AES requests (244/404/420
  bytes), 218 in all: a request built here for the same JSON length has the same size and the same clear
  fields (encrypt type, length, plain length).
- Relay step 1: plain 88 = 72 + a 16-byte relay token; built here with a 16-byte token: same size.
- Peer command 0x203: 88-byte payload, key ids 0/0, plain 58, one each way (client index 2, NVR
  index 3); built here for a 34-character JSON: same size.
- Connector RST: 40 bytes with version 0x0102.
- Streams: both tunnelled directions of the full Ossia session rebuilt by `reliable.mjs` from the
  raw datagrams (every captured copy, relay and direct path mixed) are **byte-for-byte equal** to
  the earlier rebuild (client -> NVR 11,732 bytes, NVR -> client 45,172,049 bytes, sha-256 equal).
  In the other captures every direction is delivered in order up to the first datagram the capture
  itself lacks.

Cannot be checked offline: the inside of every RSA and AES body (no key in a capture): the redirect
reply JSON, the P2P request JSON (cv, p2pid, lanIps), the P2P reply (rid, candidates, tokens, link
key length), the SYN JSON bodies, the 0x203 JSON.

## Unknown (only a live exchange settles these)

1. Whether the cloud answers our redirect request at all, and with `et` = 2.
2. The P2P request values the cloud wants: `cty` (Ossia 5), `p2v` ("1.1.2"; does 1.1.1 get hidden
   devices?), `cv`, `svid`, `p2pid` (our client id), `lanIps`.
3. The real P2P reply: candidate table values, length of the link key (16/24/32), whether the relay
   token is always there, `msc` in practice.
4. Client id: the captured step 2 bodies are 112 bytes, which needs `|cid| + |msc digits|` = 18..33:
   Ossia's client id is not empty. Where it comes from (config or a registration) is not known.
5. The device's step 3 body is 16 bytes in the capture: too short to echo a 22-character nonce as
   `{"cx":".."}`. So `answerSynStep3`'s check may fail against a real device; the driver should
   log it and answer step 4 anyway until this is understood.
6. Whether the device needs our 0x203 peer command before it sends `head` (in the capture it did not
   wait), and its exact JSON.
7. Whether the relay limits speed or the number of streams; the `time` tolerance and rate limits of
   the cloud.

## What the first live test needs (later, with the owner's OK)

- The owner's go-ahead, one of his own serials, and a machine whose UDP traffic to the vendor cloud
  may be captured (tcpdump of the whole exchange, kept private).
- Stage 2 driver (`node:dgram`): one UDP socket; redirect to `device.provisionisr-nat2.com:9968`;
  decrypt the reply with our own key (this alone settles unknowns 1 and part of 3, and lets us read
  every later AES body of our own session); P2P request to the servers of the lowest order; on
  `ol=1` start relay + lan + upnp connectors on the rid; hand the first connected path to a
  `ReliableLink`; give `proxy.mjs` an `openTunnel` built on it.
- Pass: the `head` greeting arrives through the tunnel, then Argus's SDK logs in through
  `127.0.0.1:<port>` exactly as in the LAN proxy test.
