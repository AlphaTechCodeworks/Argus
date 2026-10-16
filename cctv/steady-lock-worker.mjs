// The worker thread of one steadied camera (steady-lock.mjs WorkerLocker): each picture in, steadied
// (Locker), and back, in order. Its own thread so that the measuring and moving, a few ms a picture,
// never hold up the server's sockets.
import { parentPort, workerData } from 'node:worker_threads'
import { Locker, UNSURE } from './steady-lock.mjs'

const locker = new Locker(workerData)
parentPort.on('message', (u8) => {
  const r = locker.process(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength))
  const out = new Uint8Array(r.frame)
  parentPort.postMessage({ frame: out, reset: r.reset ? (r.sure < UNSURE ? 'unsure' : 'picture') : null }, [out.buffer])
})
