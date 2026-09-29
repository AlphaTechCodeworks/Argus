// The stream a /live or /playback URL asks for, parsed once for every decision made on it, and how a
// refusal of the main stream is said on every socket.
//
// Number(url.searchParams.get('stream') ?? 1) read '', ' ', '0.0', '0x0', '0b0', '0o0', '0e5', '-0',
// '+0', '\n0' and '00' all as 0: the main stream. A rights check written against the text
// ('=== "0"') could be walked round with any of them while the number still asked for main. So:
// absent is the sub-stream, exactly '0' or '1' is that stream, and anything else is no stream at all
// (NaN), which every caller refuses. (Of repeated parameters, searchParams.get takes the first.)
//
// A main stream refused for want of Live HD (or Playback HD, for a recording) closes 1008 with
// HD_NOT_ALLOWED: the pages tell it apart from 'not allowed' and drop to the sub-stream, or say
// so, instead of trying again.
export const MAIN = 0
export const SUB = 1
export const HD_NOT_ALLOWED = 'hd not allowed'
/** NVR playback of the main stream, asked for without Live HD or Playback HD on the camera. */
export const HD_ASK_MESSAGE = 'Playing this camera in HD from the NVR needs Playback HD or Live HD.'
/** NVR playback that got no SD frame (the camera may be recorded in HD only), for someone who may not see main. */
export const HD_ONLY_MESSAGE = 'No SD recording of this camera came from the NVR (it may keep this camera only in HD). Playing it in HD needs Playback HD or Live HD.'

/**
 * @param {string|null|undefined} raw url.searchParams.get('stream')
 * @returns {number} MAIN, SUB, or NaN for anything else
 */
export function streamParam(raw) {
  if (raw === null || raw === undefined) return SUB
  if (raw === '0') return MAIN
  if (raw === '1') return SUB
  return Number.NaN
}
