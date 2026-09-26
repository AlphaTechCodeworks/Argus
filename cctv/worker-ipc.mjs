// Messages between the main process and an NVR worker (child_process.fork, serialization 'advanced',
// so Buffers cross as bytes). Parent -> worker: want/unwant/stop. Worker -> parent: ready/state/frame/stats.
// Recording (recorder.mjs): parent -> worker settings; worker -> parent segopen / segment / recgap
// (segopen: a segment file has been created and is being written; kept by the parent in memory only).
// (restart: parent -> worker, restart stream ch/type in place, e.g. after a sub-stream codec change)
// (events: parent -> worker, the stretches each event-mode camera should be recording; rec-modes.mjs)
export const MSG = { WANT: 'want', UNWANT: 'unwant', RESTART: 'restart', STOP: 'stop', READY: 'ready', STATE: 'state', FRAME: 'frame', STATS: 'stats', SETTINGS: 'settings', EVENTS: 'events', SEGOPEN: 'segopen', SEGMENT: 'segment', RECGAP: 'recgap' }
export const restart = (ch, type, why) => ({ t: MSG.RESTART, ch, type, why })
export const streamKey = (ch, type) => `${ch}:${type}`
/** background: only warm-ups want it (a viewer's stream starts ahead of it in the worker too) */
export const want = (ch, type, background = false) => ({ t: MSG.WANT, ch, type, background })
export const unwant = (ch, type) => ({ t: MSG.UNWANT, ch, type })
/** A packed frame (sdk.mjs encodeFrame wire format) for stream `key`. */
export const frameMsg = (key, buf, isKey) => ({ t: MSG.FRAME, key, buf, isKey: Boolean(isKey) })
