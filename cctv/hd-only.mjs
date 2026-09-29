// The NVR's cameras recorded in HD only, and the wait for an SD picture that finds them
// (playback.mjs). Pure apart from its one file; no SDK, so it is tested on any machine.
//
// An NVR playback asked for the sub-stream that gets no frame goes over to the main stream after
// SD_FALLBACK_MS, and the camera is remembered (DATA_DIR/hd-only.json) so the next playback asks for
// main at once. Two faults let a slow NVR mark cameras for good: the 4 s were counted from before the
// session had even started (openedAt was 0 until the NVR answered, so a tile waiting its turn in the
// NVR's lane "timed out" at the first 500 ms tick), and a session paused while it opened (the camera
// wall opens its tiles paused) switched at the first tick after play. A false mark sends every later
// playback of that camera to the main stream, and would keep a viewer who may not see main from it
// (stream rights). So: SdWait counts only the time the NVR was really playing and starts again at
// each resume; a camera is marked only when main frames came after a switch; an SD frame clears a
// mark; and a mark is trusted for HD_ONLY_RETEST_MS, then the camera is tried in SD again.
//
// hd-only.json: { "<nvr>": { "<ch>": markedAtMs } }. An older release wrote { "<nvr>": [ch, …] } by
// the faulty rule above: those are not trusted (dropped when read), so each camera is tried in SD
// once more. (An older release reading the new form sees no HD-only cameras and learns them again
// with its own rule: harmless.)
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export const SD_FALLBACK_MS = 4000
export const HD_ONLY_RETEST_MS = 7 * 24 * 3_600_000

/** One session's wait for its first SD frame, counting only the time the NVR was playing it. */
export class SdWait {
  constructor(limitMs = SD_FALLBACK_MS) {
    this.limitMs = limitMs
    this.ms = 0 // playing time counted so far
    this.at = null // when the count last moved (null: not counting)
  }

  /**
   * Every watch tick (playback.mjs, 500 ms). running: the session has started, the viewer has not
   * paused it and the NVR is playing it (it has taken the last RESUME, not merely been asked).
   * @returns {boolean} the limit is reached with no SD frame
   */
  tick(now, running) {
    if (!running) {
      this.at = null
      return false
    }
    if (this.at !== null) this.ms += Math.max(0, now - this.at)
    this.at = now
    return this.ms >= this.limitMs
  }

  /** From zero again: played again before any frame came, or a new playback of the same session. */
  restart() {
    this.ms = 0
    this.at = null
  }
}

/**
 * One NVR's HD-only cameras, kept in `file` beside every other NVR's.
 * @param {{ file: string, nvrId: string, now?: () => number, retestMs?: number, log?: (line: string) => void }} o
 * @returns {{ has: (ch: number) => boolean, mark: (ch: number) => void, unmark: (ch: number) => void }}
 */
export function hdOnlyStore({ file, nvrId, now = Date.now, retestMs = HD_ONLY_RETEST_MS, log = console.warn }) {
  const readAll = () => {
    try {
      const all = JSON.parse(readFileSync(file, 'utf8'))
      return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
    } catch {
      return {}
    }
  }
  const marks = new Map() // ch -> markedAtMs
  const mine = readAll()[nvrId]
  // An older release's list ([ch, …]) was written by the faulty rule: not trusted, so not read (each of
  // those cameras is tried in SD once more, and marked again if it really records HD only)
  if (mine && typeof mine === 'object' && !Array.isArray(mine)) {
    for (const [k, at] of Object.entries(mine)) if (/^\d{1,3}$/.test(k) && Number.isFinite(at)) marks.set(Number(k), at)
  }
  const save = () => {
    try {
      const all = readAll()
      all[nvrId] = Object.fromEntries([...marks].sort((a, b) => a[0] - b[0]).map(([ch, at]) => [String(ch), at]))
      const tmp = `${file}.tmp-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify(all)}\n`, { mode: 0o600 })
      renameSync(tmp, file)
    } catch (e) {
      log(`[${nvrId}] could not save the HD-only list: ${e.message}`)
    }
  }
  return {
    /**
     * Recorded in HD only, as last seen, and not so long ago that it is time to try SD again. A mark
     * dated after now (the server's clock was stepped back) is not trusted: it could last for weeks.
     */
    has: (ch) => {
      const age = now() - marks.get(ch) // NaN when not marked
      return age >= 0 && age < retestMs
    },
    /** Main frames came where SD did not: HD only, as of now. */
    mark(ch) {
      marks.set(ch, now())
      save()
    },
    /** An SD frame came: not HD only (a mark from a slow NVR, or one past its re-test). */
    unmark(ch) {
      if (marks.delete(ch)) save()
    }
  }
}
