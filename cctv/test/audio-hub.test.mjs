// A camera's sound to its listeners (audio-hub.mjs) and its decoding in the page (public/live-audio.js).
// Plain node: no SDK, no server, no browser.
import { makeAudioHub, parseWaveFormat } from '../audio-hub.mjs'
import { alawSample, decode, ulawSample } from '../public/live-audio.js'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}
const J = JSON.stringify
const sock = () => ({ readyState: 1, bufferedAmount: 0, got: [], send(m) { this.got.push(m) } })

// the format the fleet's cameras announce: A-law, mono, 8 kHz
const WAVE = Buffer.from('06000100401f0000803e0000010010001200', 'hex')
check('format: A-law, mono, 8 kHz', J(parseWaveFormat(WAVE)) === J({ tag: 6, channels: 1, rate: 8000 }))
check('format: too short or senseless is none', parseWaveFormat(Buffer.alloc(4)) === null && parseWaveFormat(Buffer.alloc(18)) === null && parseWaveFormat(null) === null)

{
  const hub = makeAudioHub()
  const told = []
  hub.setWorker('n1', (m) => told.push(m))
  const a = sock()
  const b = sock()
  const stopA = hub.listen('n1', 5, a)
  check('the first listener asks the worker for the camera\'s sound', J(told) === J([{ t: 'audiowant', ch: 5, on: true }]))
  const stopB = hub.listen('n1', 5, b)
  check('a second listener asks nothing more', told.length === 1 && hub.stats().listeners === 2)
  const frame = { ch: 5, buf: Buffer.alloc(320, 0xd5), tag: 6, channels: 1, rate: 8000 }
  hub.onFrame('n1', frame)
  check('each listener is told the format once, then gets the sound', J(a.got[0]) === J(J({ format: 'alaw', rate: 8000, channels: 1 })) && a.got[1] === frame.buf && b.got.length === 2)
  hub.onFrame('n1', frame)
  check('...the format is not said again', a.got.length === 3 && a.got[2] === frame.buf)
  hub.onFrame('n1', { ...frame, ch: 6 })
  hub.onFrame('n2', frame)
  check('another camera\'s sound goes to nobody', a.got.length === 3)
  b.bufferedAmount = 10_000_000
  hub.onFrame('n1', frame)
  check('a listener far behind is skipped, the other is not', a.got.length === 4 && b.got.length === 3)
  const late = sock()
  const stopLate = hub.listen('n1', 5, late)
  check('someone joining later is told the format at once', J(late.got) === J([J({ format: 'alaw', rate: 8000, channels: 1 })]))
  stopLate()
  stopA()
  check('one listener leaving changes nothing for the worker', told.length === 1)
  stopB()
  stopB()
  check('the last one leaving tells the worker, once', J(told.slice(1)) === J([{ t: 'audiowant', ch: 5, on: false }]) && hub.stats().cameras === 0)
  const c = sock()
  hub.listen('n1', 7, c)
  hub.workerReady('n1')
  check('a worker that restarted is told again what is listened to', J(told.slice(-2)) === J([{ t: 'audiowant', ch: 7, on: true }, { t: 'audiowant', ch: 7, on: true }]))
  hub.onFrame('n1', { ch: 7, buf: Buffer.alloc(10), tag: 85, channels: 1, rate: 8000 })
  check('a format the page cannot play: said, and no sound sent', c.got.length === 1 && JSON.parse(c.got[0]).format === null)
  const many = Array.from({ length: 9 }, () => hub.listen('n1', 9, sock()))
  check('a camera has a most listeners', many.slice(0, 8).every((x) => typeof x === 'function') && many[8] === null)
}

check('A-law: silence is near zero, and the two halves mirror', alawSample(0xd5) === 8 && alawSample(0x55) === -8 && alawSample(0xaa) === -alawSample(0x2a) && Math.abs(alawSample(0x2a)) === 32256)
check('mu-law: silence is zero, the loudest are the ends', ulawSample(0xff) === 0 && ulawSample(0x7f) === 0 && ulawSample(0x80) === 32124 && ulawSample(0x00) === -32124)
{
  const d = decode(Uint8Array.from([0xd5, 0xaa, 0xd5, 0x2a]), 'alaw', { rate: 8000, outRate: 48000 })
  check('decode: stretched to the output rate, every camera sample kept', d.samples.length === 24 && Math.abs(d.samples[6] - alawSample(0xaa) / 32768) < 1e-6 && Math.abs(d.samples[18] - alawSample(0x2a) / 32768) < 1e-6)
  check('decode: a straight line between two samples', Math.abs(d.samples[3] - (alawSample(0xd5) + alawSample(0xaa)) / 2 / 32768) < 1e-6)
  check('decode: an unknown format is nothing', decode(Uint8Array.from([1, 2]), 'aac', { rate: 8000, outRate: 48000 }) === null)
}

console.log(failed ? `${failed} FAILED` : 'all passed')
process.exitCode = failed ? 1 : 0
