// What a page's /live-mux socket shows of a frame while it is going out (live-mux.mjs socketPending), on a
// real ws socket over 127.0.0.1; no SDK, no ffmpeg.
//   node cctv/test/live-mux-socket.test.mjs
//
// Why (1 Oct, the review of fix D): adaptive-live.mjs tells a page that has stopped reading from a link
// that is slow by whether its socket has written anything since the look before. "Written" was ws's send
// callback, which comes once a WHOLE frame has gone: a main stream's keyframe of 600 KB takes 4.8 s at
// 1 Mbit/s and 16 s at 0.3, so a slow link that was working read as stopped at most looks, was stepped
// down 6-16 s late or never, and had its conversions paused. The system takes a frame piece by piece, and
// the socket's handle says how much of the piece in hand it has not taken yet: that number moves on a link
// that works and stands still on one that has stopped.
//
// Linux only (the server): there libuv writes what the system will take and keeps count of the rest. On
// Windows the system takes a write whole, 48 MB for a reader that reads nothing, and calls it written: the
// checks that need a socket to back up are left out there, said in one line.
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { serveMux } from '../live-mux.mjs'
import { encodeFrame } from '../phone-live.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MB = 1024 * 1024
const partial = process.platform === 'linux'

const http = createServer()
const wss = new WebSocketServer({ server: http })
let channel = null
wss.on('connection', (ws) => {
  serveMux(ws, { session: () => 'owner', log: () => {}, attach: (c) => { channel = c } })
})
await new Promise((r) => http.listen(0, '127.0.0.1', r))
const client = new WebSocket(`ws://127.0.0.1:${http.address().port}/live-mux`)
let got = 0
client.on('message', (d) => { got += d.length })
await new Promise((r) => client.once('open', r))
client.send(JSON.stringify({ op: 'sub', id: 1, nvr: 'n1', ch: 0, stream: 1 }))
for (let i = 0; i < 100 && !channel; i++) await sleep(10)
check('a channel on a real socket', Boolean(channel))

check('nothing being written: nothing pending', channel.socketPending === 0, `${channel.socketPending}`)

// the page stops reading, and one frame far bigger than the system's buffers is sent to it
client._socket.pause()
const FRAME = 48 * MB
channel.send(encodeFrame(Buffer.alloc(FRAME), true, 0, 0))
// until the number has stood still for half a second
let pending = channel.socketPending
for (let still = 0, i = 0; still < 25 && i < 500; i++) {
  await sleep(20)
  const p = channel.socketPending
  still = p === pending ? still + 1 : 0
  pending = p
}
check('what is pending is a number', typeof pending === 'number', `${pending}`)
if (partial) check('a reader that stopped, one 48 MB frame queued: none of it called back as written', channel.writtenBytes === 0 && channel.sharedBufferedAmount > FRAME, `${channel.writtenBytes} ${channel.sharedBufferedAmount}`)
if (partial) check('  what is pending stands still', pending > 0 && pending === channel.socketPending, `${pending} ${channel.socketPending}`)
if (partial) check('  the system took part of the frame before it stopped (less pending than the frame)', pending < FRAME, `${pending}`)

// it reads again, a little at a time (a slow link): the frame is still going out, and the number moves
const seen = [pending]
for (let i = 0; i < 6 && channel.writtenBytes === 0; i++) {
  client._socket.resume()
  await sleep(5)
  client._socket.pause()
  await sleep(60)
  // (only while the frame is still going: how much a reader takes in 5 ms is the machine's doing)
  if (channel.writtenBytes === 0) seen.push(channel.socketPending)
}
const moved = seen.filter((p, i) => i > 0 && p < seen[i - 1]).length
if (partial) check('a reader taking a little at a time: pending goes down at every look while the frame is not written yet', seen.length >= 3 && moved === seen.length - 1, seen.join())
else console.log(`PASS  (not Linux: the system took the whole frame at once, ${channel.writtenBytes} bytes written with nobody reading; the checks of a socket backing up are left out)`)

// and all of it
client._socket.resume()
for (let i = 0; i < 1000 && channel.writtenBytes === 0; i++) await sleep(20)
check('read to the end: written, nothing pending', channel.writtenBytes > FRAME && channel.socketPending === 0 && channel.sharedBufferedAmount === 0, `${channel.writtenBytes} ${channel.socketPending}`)

client.terminate()
wss.close()
http.close()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
