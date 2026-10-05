// Event-driven recording: turning the events in the database into an answer to the one question
// the recorder asks thousands of times a minute — should this camera be writing this frame?
//
// Pure: no I/O, no timers, no SDK. The recorder runs inside a live worker where a mistake costs
// footage, so the decision is made by a function that can be tested exhaustively on any machine,
// and the worker only ever asks it.
//
// ---------------------------------------------------------------------------------------------
// THE HONEST PART, which matters more than the code
// ---------------------------------------------------------------------------------------------
// Event-driven recording is only as good as how quickly events arrive. Ours arrive by polling the
// NVR's recorded-file index (events.mjs explains why there is no confirmed live subscription), so
// an event is known a minute or two after it happened. By then the moment is past: a camera that
// only started writing when the event arrived would have recorded the aftermath and missed the act.
//
// Rather than pretend otherwise, a camera in an event mode keeps recording continuously whenever
// its event feed is not fresh enough to be trusted, and says so. The pre/post seconds and the
// window logic below are complete and used the moment a prompt event source is confirmed; until
// then the honest behaviour of "motion mode" on these NVRs is "records everything, and tells you
// why". Disk is cheaper than a missing incident.
import { recordWindows, eventsForMode, inWindows, isEventMode } from './event-rules.mjs'

/**
 * How fresh the event feed must be for a camera to be trusted to record on events alone. Polling
 * comes round every couple of minutes per camera on a quiet NVR and much more slowly on a busy one,
 * so this is generous; it is a guard against a dead feed, not a measure of quality.
 */
export const FEED_FRESH_MS = 5 * 60_000

/**
 * Windows are extended by this much when they are merged, so a burst of movement is one file rather
 * than a stutter of starts and stops. Kinder to the disk and far easier to watch back.
 */
export const JOIN_MS = 5000

/**
 * The stretches one camera should be recording, from its events and its settings.
 * @param {object[]} events   that camera's events (events-db eventsOfCamera)
 * @param {string} mode       'motion' | 'ai' | 'ai-or-motion'
 * @param {{preS?: number, postS?: number}} cfg   from settings.recording (defaults merged already)
 * @returns {Array<[number, number]>}
 */
export function windowsFor(events, mode, { preS = 0, postS = 0 } = {}) {
  return recordWindows(eventsForMode(events, mode), { preS, postS, joinMs: JOIN_MS })
}

/**
 * Should this frame be written?
 *
 * @param {object} o
 * @param {string} o.mode      the camera's recording mode
 * @param {Array<[number,number]>} [o.windows]  what the parent last sent for this camera
 * @param {number|null} [o.feedAt]  when the parent last sent windows at all (null: never)
 * @param {number} o.ts        the frame's time on this server's clock
 * @param {number} o.nowMs
 * @returns {{ write: boolean, why: string }} `why` is shown on the Health page, so it is a sentence
 */
export function shouldWrite({ mode, windows = [], feedAt = null, ts, nowMs, freshMs = FEED_FRESH_MS }) {
  if (!isEventMode(mode)) return { write: true, why: '' }
  if (feedAt === null) return { write: true, why: 'recording continuously: no events have reached this worker yet' }
  if (nowMs - feedAt > freshMs) {
    return { write: true, why: `recording continuously: the last event update was ${Math.round((nowMs - feedAt) / 60_000)} min ago and cannot be trusted` }
  }
  if (inWindows(windows, ts)) return { write: true, why: '' }
  return { write: false, why: 'waiting for an event' }
}

/**
 * The message the main process sends a worker: every event-mode camera's windows, as plain arrays.
 * Built here so the rule about which events a mode cares about lives in one place.
 *
 * @param {object} o
 * @param {string} o.nvrId
 * @param {Array<{ch: number}>} o.cameras       the NVR's channels
 * @param {object} o.recording                  settings.recording
 * @param {(ch: number, fromMs: number, toMs: number) => object[]} o.eventsOf
 * @param {number} o.nowMs
 * @param {number} [o.lookBackMs]  how far back windows are built; only the live edge matters, but a
 *                                 little history covers a worker that has just restarted
 */
export function buildWindowMessage({ nvrId, cameras, recording, eventsOf, nowMs, lookBackMs = 30 * 60_000 }) {
  const windows = {}
  const defaults = recording?.defaults ?? {}
  for (const c of cameras ?? []) {
    const ch = typeof c === 'number' ? c : c.ch
    if (!Number.isInteger(ch)) continue
    const per = recording?.cameras?.[`${nvrId}/${ch}`] ?? {}
    const mode = per.mode ?? defaults.mode
    if (!isEventMode(mode)) continue
    const preS = per.preS ?? defaults.preS ?? 0
    const postS = per.postS ?? defaults.postS ?? 0
    // A window can only start once we know about it, so it is built over recent events only; the
    // pre-roll reaches back from each event, which is what preS is for.
    const events = eventsOf(ch, nowMs - lookBackMs - preS * 1000, nowMs)
    windows[ch] = windowsFor(events, mode, { preS, postS })
  }
  return { windows, at: nowMs }
}
