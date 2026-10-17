// Sound with the NVR's playback: the server's rules (pb-sound.mjs), the page's (public/pb-sound.js),
// the shared output's timing (public/live-audio.js slotFor), and the wiring of playback.mjs and
// public/playback.js, read as text (playback.mjs loads koffi, so it cannot be imported on a PC without
// the SDK; the same way alarm-watch-wiring.test.mjs reads nvrs.mjs).
// Plain node: no SDK, no server, no browser.
//   node cctv/test/pb-sound.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_SOUND_BYTES, SOUND_CODEC, SOUND_NEAR_MS, dropLateSound, encodeSound, isSoundMsg, queueInOrder, soundFormatOf, soundHello, soundWanted, withoutSound } from '../pb-sound.mjs'
import { SOUND_CODEC as PAGE_SOUND_CODEC, soundDelayS, soundWanted as pageWants } from '../public/pb-sound.js'
import { slotFor } from '../public/live-audio.js'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}
const J = JSON.stringify

// ---- the server: format, wire format ----------------------------------------------------
// the format announcement probed on prod (14 Oct 2026): A-law, mono, 8 kHz
const WAVE = Buffer.from('06000100401f0000803e00000100100012000000', 'hex')
const ALAW = soundFormatOf(WAVE)
check('format: the probed WAVEFORMATEX is A-law, mono, 8 kHz', J(ALAW) === J({ tag: 6, channels: 1, rate: 8000 }))
check('hello: says alaw, rate and channels', J(soundHello(ALAW)) === J({ type: 'sound', format: 'alaw', rate: 8000, channels: 1 }))
check('hello: a format the page cannot play is said, with why', soundHello({ tag: 0xff, channels: 1, rate: 8000 }).format === null && /cannot play/.test(soundHello({ tag: 0xff, channels: 1, rate: 8000 }).why))
check('hello: no format at all is "no sound"', soundHello(null).format === null && /no sound/.test(soundHello(null).why))

const pcm = Buffer.alloc(320, 0xd5)
const msg = encodeSound(pcm, 1_760_000_000_123_456)
check('wire: 16-byte header then the sound as it came', msg.length === 336 && msg.subarray(16).equals(pcm))
check('wire: the codec byte is SOUND_CODEC, not a keyframe', msg[1] === SOUND_CODEC && msg[0] === 0)
check('wire: capture time in us at byte 8, as the video', msg.readBigInt64LE(8) === 1_760_000_000_123_456n)
check('wire: a BigInt time (as koffi may give it) is taken too', encodeSound(pcm, 5n).readBigInt64LE(8) === 5n)
check('wire: told from video by that byte (video is 0 H.264 or 1 H.265)', isSoundMsg(msg) && SOUND_CODEC !== 0 && SOUND_CODEC !== 1)
check('wire: the page reads the same byte', PAGE_SOUND_CODEC === SOUND_CODEC)

// ---- the server: when a sound frame is queued -------------------------------------------
const base = { sound: true, speed: 1, paused: false, format: ALAW, keySeen: true, length: 320, tsMs: 1000, lastVideoTs: 990 }
check('wanted: asked, 1x, playing, A-law, after a keyframe, near the video', soundWanted(base))
check('not wanted: not asked for', !soundWanted({ ...base, sound: false }))
for (const speed of [2, 4, 8]) check(`not wanted: at ${speed}x`, !soundWanted({ ...base, speed }))
check('not wanted: paused', !soundWanted({ ...base, paused: true }))
check('not wanted: before the first keyframe (nothing is shown before it)', !soundWanted({ ...base, keySeen: false }))
check('not wanted: format not announced yet, or one the page cannot play', !soundWanted({ ...base, format: null }) && !soundWanted({ ...base, format: { tag: 0x55, channels: 1, rate: 8000 } }))
check('not wanted: an empty or oversized frame', !soundWanted({ ...base, length: 0 }) && !soundWanted({ ...base, length: MAX_SOUND_BYTES + 1 }))
check('not wanted: no video yet to be near', !soundWanted({ ...base, lastVideoTs: null }))
check('not wanted: stamped far from the video (another clock would move the pacer)', !soundWanted({ ...base, tsMs: 990 + SOUND_NEAR_MS + 1 }) && !soundWanted({ ...base, tsMs: 990 - SOUND_NEAR_MS - 1 }))
check('wanted: within SOUND_NEAR_MS either side', soundWanted({ ...base, tsMs: 990 + SOUND_NEAR_MS }) && soundWanted({ ...base, tsMs: 990 - SOUND_NEAR_MS }))

// ---- the server: the pacing queue ---------------------------------------------------------
{
  // the NVR's order on prod: video every 33 ms, sound every 40 ms, the two a little apart
  const q = []
  const arrivals = []
  for (let i = 0; i < 30; i++) arrivals.push({ ts: i * 33.3, v: i })
  for (let i = 0; i < 25; i++) arrivals.push({ ts: i * 40 + 5, s: i })
  // interleaved roughly as they come, sound up to 60 ms early or late against the video
  arrivals.sort((a, b) => (a.ts + (a.s !== undefined ? ((a.s % 3) - 1) * 60 : 0)) - (b.ts + (b.s !== undefined ? ((b.s % 3) - 1) * 60 : 0)))
  for (const a of arrivals) queueInOrder(q, a.s !== undefined ? { ts: a.ts, sound: true, s: a.s } : { ts: a.ts, v: a.v })
  const ordered = q.every((x, i) => i === 0 || q[i - 1].ts <= x.ts)
  check('queue: sound and video interleaved in time order', ordered)
  check('queue: video keeps the order it came in', J(q.filter((x) => !x.sound).map((x) => x.v)) === J([...Array(30).keys()]))
  check('queue: all 55 items are there', q.length === 55)
  const v = withoutSound(q)
  check('queue: without sound leaves the video untouched, in order', v.length === 30 && v.every((x, i) => x.v === i))
  check('queue: without sound on a queue with none is the same queue (no copy)', withoutSound(v) === v)
}
{
  // video stays exactly as pushed, also when the NVR sends it out of order (it was never sorted)
  const q = []
  for (const ts of [0, 40, 20, 60]) queueInOrder(q, { ts })
  check('queue: video alone is a plain push, even out of order', J(q.map((x) => x.ts)) === J([0, 40, 20, 60]))
  queueInOrder(q, { ts: 100, sound: true })
  queueInOrder(q, { ts: 80 })
  check('queue: a video frame goes in front of sound stamped after it', J(q.map((x) => x.ts)) === J([0, 40, 20, 60, 80, 100]))
}

{
  // late sound at the head is dropped, so the pacer never takes it for a jump back; video is never dropped
  const q = [{ ts: 100, sound: true }, { ts: 150, sound: true }, { ts: 160 }, { ts: 170, sound: true }]
  check('late sound: the sound before the first video frame goes', dropLateSound(q, 1000) === 2 && J(q.map((x) => x.ts)) === J([160, 170]))
  const r = [{ ts: 100, sound: true }, { ts: 120 }]
  check('late sound: none older than the limit, nothing goes', dropLateSound(r, 100) === 0 && r.length === 2)
}

// ---- the page --------------------------------------------------------------------------------
const want = { on: true, mode: 'nvr', speed: 1, paused: false, stepping: false }
check('page asks: on, NVR playback, 1x, playing', pageWants(want))
check('page does not ask: off', !pageWants({ ...want, on: false }))
check('page does not ask: the server\'s own recordings', !pageWants({ ...want, mode: 'server' }))
for (const speed of [2, 4, 8, -1]) check(`page does not ask: at ${speed}x`, !pageWants({ ...want, speed }))
check('page does not ask: paused, or on the way to a frame step', !pageWants({ ...want, paused: true }) && !pageWants({ ...want, stepping: true }))

const shown = { ts: 10_000, at: 500 }
check('delay: a packet of the picture on screen now plays now', soundDelayS({ tsMs: 10_100, shown, nowMs: 600 }) === 0)
check('delay: one 300 ms ahead of the picture waits 0.3 s', Math.abs(soundDelayS({ tsMs: 10_400, shown, nowMs: 600 }) - 0.3) < 1e-9)
check('delay: one already past is negative (dropped by slotFor)', soundDelayS({ tsMs: 9_900, shown, nowMs: 600 }) < 0)
check('delay: no picture yet, none', soundDelayS({ tsMs: 10_000, shown: null, nowMs: 600 }) === null)
check('delay: a picture not moving for 1.5 s, none', soundDelayS({ tsMs: 10_000, shown, nowMs: 2_100 }) === null)

// ---- the output's timing (live-audio.js) -------------------------------------------------------
check('slot, on arrival: the first packet LEAD_S behind', Math.abs(slotFor({ now: 1, next: 0 }) - 1.15) < 1e-9)
check('slot, on arrival: the next straight after', slotFor({ now: 1, next: 1.2 }) === 1.2)
check('slot, on arrival: too far ahead is dropped', slotFor({ now: 1, next: 1.9 }) === null)
check('slot, timed: when the picture is', slotFor({ now: 1, next: 0, wantAt: 1.3 }) === 1.3)
check('slot, timed: close to where the last ended joins on', slotFor({ now: 1, next: 1.32, wantAt: 1.3 }) === 1.32)
check('slot, timed: too late is dropped', slotFor({ now: 1, next: 0, wantAt: 0.99 }) === null)
check('slot, timed: far ahead (not this picture\'s) is dropped', slotFor({ now: 1, next: 0, wantAt: 4.5 }) === null)
check('slot, timed: nonsense is dropped', slotFor({ now: 1, next: 0, wantAt: NaN }) === null)

// ---- wiring, read as text ------------------------------------------------------------------------
const pb = readFileSync(join(import.meta.dirname, '..', 'playback.mjs'), 'utf8')
check('playback.mjs: frame types 2 and 6 go to #onSound (they were dropped)', /info\.frameType === 6 \|\| info\.frameType === 2\) return this\.#onSound\(info, buf\)/.test(pb))
check('playback.mjs: sound is queued only through soundWanted, with the session\'s speed, pause and keyframe', /soundWanted\(\{ sound: this\.sound, speed: this\.speed, paused: this\.paused, format: this\.soundFormat, keySeen: this\.keySeen/.test(pb))
check('playback.mjs: sound goes into the same pacing queue, by time', /if \(want\) queueInOrder\(this\.queue, \{ ts, msg: encodeSound\(/.test(pb))
check('playback.mjs: the {sound} command is read after the object guard', pb.indexOf("if ('sound' in cmd)") > pb.indexOf("if (!cmd || typeof cmd !== 'object') return"))
check('playback.mjs: off drops the queued sound; so does any speed but 1x', /if \(!on\) this\.queue = withoutSound\(this\.queue\)/.test(pb) && /if \(speed !== 1\) this\.queue = withoutSound\(this\.queue\)/.test(pb))
check('playback.mjs: sound is sent as it is, never to a converter, and not once off or faster', /if \(item\.sound\) \{\s+if \(this\.sound && this\.speed === 1\) this\.ws\.send\(msg\)\s+return\s+\}/.test(pb) && pb.indexOf('if (item.sound)') < pb.indexOf('if (this.fit && this.mainStream)'))
check('playback.mjs: the pacer drops late sound before it looks at the head of the queue', /dropLateSound\(this\.queue, [^\n]*\)\s+if \(this\.queue\.length === 0\) return\s+const head = this\.queue\[0\]\.ts/.test(pb))
check('playback.mjs: a converter\'s held start counts frames, not sound', /if \(!item\.sound\) h\.extra\+\+/.test(pb))

const page = readFileSync(join(import.meta.dirname, '..', 'public', 'playback.js'), 'utf8')
check('playback.js: a sound frame is taken out before the player', /if \(buf\[1\] === SOUND_CODEC\) return playSound\(buf, view\).*\s+player\.push\(/.test(page))
check('playback.js: the socket asks again on open (each socket starts without sound)', /if \(ws === sock\) syncSound\(\)/.test(page))
check('playback.js: pause, speed and a step tell the server', (page.match(/syncSound\(\) \/\/ \((silent while paused|sound at 1x only|none on the way to a stepped frame)\)/g) ?? []).length === 3)
check('playback.js: the button is hidden for the server\'s own recordings', /soundBtn\.hidden = server/.test(page))
const html = readFileSync(join(import.meta.dirname, '..', 'public', 'playback.html'), 'utf8')
check('playback.html: Sound button, volume and Filter are there', ['soundBtn', 'soundExtras', 'soundVol', 'soundFilter'].every((id) => html.includes(`id="${id}"`)))

console.log(failed ? `${failed} FAILED` : 'all passed')
process.exitCode = failed ? 1 : 0
