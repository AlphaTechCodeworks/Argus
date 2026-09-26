// A new viewer is sent the stream from its last keyframe, so a picture appears at once instead of
// at the next keyframe. On a high-resolution main stream that backlog can be several MB, sent in
// one burst: over Wi-Fi or a phone link that delayed the first picture (and could trip the
// backpressure cap, which then waited for the next keyframe anyway). Past REPLAY_MAX_BYTES only
// the keyframe goes: the picture appears at once, and moves from the next keyframe on (every
// fan-out honours ws.waitForKey through backpressure.mjs).
export const REPLAY_MAX_BYTES = 1_500_000

const size = (m) => m?.length ?? m?.byteLength ?? 0

/** Sends gop (keyframe first) to ws, whole or just its keyframe. @returns {number} messages sent */
export function replayGop(gop, ws, maxBytes = REPLAY_MAX_BYTES) {
  if (!gop.length) return 0
  let bytes = 0
  for (const m of gop) bytes += size(m)
  if (bytes <= maxBytes) {
    for (const m of gop) ws.send(m)
    return gop.length
  }
  ws.send(gop[0])
  ws.waitForKey = true
  return 1
}
