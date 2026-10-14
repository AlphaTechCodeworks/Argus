// The Playback page's Sound (no DOM): when the camera's recorded sound is asked for, and when each
// packet of it plays. The server sends it down the playback socket with the picture, only after
// {"sound": true} and only at 1x forwards (cctv/pb-sound.mjs); the page plays it through live-audio.js
// soundOut, the same output, volume and Filter as Live's Sound button.
//
// Pure, tested in plain node (test/pb-sound.test.mjs).

/** The codec byte of a sound frame on the playback socket (cctv/pb-sound.mjs SOUND_CODEC; video is 0 or 1). */
export const SOUND_CODEC = 2

/**
 * Whether the server is to send sound now: the button is on, this is the NVR's playback (the server's
 * own recordings have none), it plays forwards at 1x, and is not paused or on its way to a frame step.
 */
export const soundWanted = ({ on, mode, speed, paused, stepping }) => on === true && mode !== 'server' && speed === 1 && !paused && !stepping

// The picture's clock is the last frame shown (the player's onFrame: its capture time, and when).
// Older than this, the picture is not moving (waiting for the NVR, decoding behind): no sound with it.
const STILL_MS = 1500

/**
 * How long from now a packet stamped tsMs plays, in seconds, so that it is heard with its picture: the
 * picture shows capture time `shown.ts` at `shown.at` and moves on at 1x. null while there is no
 * picture yet, or it has not moved for STILL_MS (the packet is dropped: sound runs only with a picture).
 * @param {{ tsMs: number, shown: { ts: number, at: number }|null, nowMs: number }} o nowMs and shown.at
 *   on the same clock (performance.now())
 */
export function soundDelayS({ tsMs, shown, nowMs }) {
  if (!shown || !Number.isFinite(tsMs) || !Number.isFinite(shown.ts) || nowMs - shown.at > STILL_MS) return null
  const onScreen = shown.ts + (nowMs - shown.at)
  return (tsMs - onScreen) / 1000
}
