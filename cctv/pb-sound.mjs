// Sound with the NVR's playback (playback.mjs PlaybackSession): the camera's microphone as it was
// recorded, played on the Playback page while its Sound button is on. During NVR playback the SDK
// hands over the sound with the picture (probe on prod, 14 Oct 2026: frame type 6 once, a WAVEFORMATEX
// for G.711 A-law, mono, 8 kHz; then type 2, 320 bytes every 40 ms, stamped in microseconds like the
// video). playback.mjs used to drop it.
//
// The sound goes down the playback socket itself, through the same pacing queue as the video, so it is
// released at its capture time beside the frames it belongs with. It is sent only to a viewer who asked
// ({"sound": true}), and only at 1x forwards: none while paused or faster (the page plays it at 1x only).
// On the wire it is a frame like the video's (sdk.mjs encodeFrame: 16-byte header, capture time in us at
// byte 8) with SOUND_CODEC in the codec byte, which no video ever has (0 H.264, 1 H.265), so the page
// tells it from the picture by that byte alone. The format goes before it as a text message:
// {"type":"sound","format":"alaw"|"ulaw","rate","channels"} ({"format":null,"why"} for one the page
// cannot play).
//
// Pure (no SDK): tested in test/pb-sound.test.mjs.
import { FORMATS, parseWaveFormat } from './audio-hub.mjs'

/** The codec byte of a sound frame on the playback socket (video is 0 or 1). */
export const SOUND_CODEC = 2
const HEADER_SIZE = 16
/** Larger than any sound frame the fleet sends (320 bytes): anything bigger is not taken for sound. */
export const MAX_SOUND_BYTES = 4096
/**
 * How far a sound frame's time may be from the last video frame's and still be queued. The two come
 * interleaved within a frame or two of each other; a sound frame stamped on some other clock, queued
 * with the picture, would move the pacer's play position and stall or rush the video (playback.mjs #pace
 * re-anchors on the head of the queue).
 */
export const SOUND_NEAR_MS = 1000

/** The text message that tells the page what the sound frames are, from a parsed WAVEFORMATEX (or null). */
export function soundHello(format) {
  const name = format ? FORMATS[format.tag] : null
  if (name) return { type: 'sound', format: name, rate: format.rate, channels: format.channels }
  return { type: 'sound', format: null, why: format ? 'This camera\'s sound is in a format the browser cannot play.' : 'This recording has no sound.' }
}

/** The format announcement's bytes (frame type 6) as { tag, channels, rate }, or null. */
export const soundFormatOf = (bytes) => parseWaveFormat(bytes)

/** One sound frame in the wire format: not a keyframe, SOUND_CODEC, no size, its capture time in us. */
export function encodeSound(bytes, timeUs) {
  const msg = Buffer.alloc(HEADER_SIZE + bytes.length)
  msg.writeUInt8(SOUND_CODEC, 1)
  msg.writeBigInt64LE(BigInt(timeUs), 8)
  bytes.copy(msg, HEADER_SIZE)
  return msg
}

/** Whether a message on the wire is a sound frame (the page's test is the same byte). */
export const isSoundMsg = (msg) => msg.length > HEADER_SIZE && msg[1] === SOUND_CODEC

/**
 * Whether a sound frame is to go to the viewer now: asked for, at 1x forwards, not paused, its format
 * known and playable, after the first keyframe (nothing before it is shown), a sensible size, and close
 * in time to the video (SOUND_NEAR_MS; with no video yet, none).
 * @param {{ sound: boolean, speed: number, paused: boolean, format: object|null, keySeen: boolean,
 *   length: number, tsMs: number, lastVideoTs: number|null }} s
 */
export function soundWanted({ sound, speed, paused, format, keySeen, length, tsMs, lastVideoTs }) {
  if (!sound || speed !== 1 || paused || !keySeen) return false
  if (!format || !FORMATS[format.tag]) return false
  if (!(length > 0) || length > MAX_SOUND_BYTES) return false
  if (!Number.isFinite(tsMs) || lastVideoTs === null || !Number.isFinite(lastVideoTs)) return false
  return Math.abs(tsMs - lastVideoTs) <= SOUND_NEAR_MS
}

/**
 * Puts an item into the pacing queue in time order. Video keeps the order the NVR sent it in, exactly
 * as before (it only moves in front of sound stamped later than itself); sound goes in among the video
 * by its time. The search runs from the end and stops at the first item not later, so it is a push for
 * everything that comes in order.
 * @param {{ ts: number, sound?: boolean }[]} queue @param {{ ts: number, sound?: boolean }} item
 */
export function queueInOrder(queue, item) {
  let i = queue.length
  if (item.sound) while (i > 0 && queue[i - 1].ts > item.ts) i--
  else while (i > 0 && queue[i - 1].sound && queue[i - 1].ts > item.ts) i--
  if (i === queue.length) queue.push(item)
  else queue.splice(i, 0, item)
}

/** The queue without its sound (sound switched off, or the speed changed away from 1x). */
export const withoutSound = (queue) => (queue.some((q) => q.sound) ? queue.filter((q) => !q.sound) : queue)

/** Takes sound stamped before `beforeTs` off the head of the queue (it is late; the video is not touched). */
export function dropLateSound(queue, beforeTs) {
  let n = 0
  while (n < queue.length && queue[n].sound && queue[n].ts < beforeTs) n++
  if (n) queue.splice(0, n)
  return n
}
