// Where live frames bunch up. A 36-tile page shows about four frames in five (2026-10-09): every
// frame arrives and is decoded, but they arrive in clumps, a wait of about 180 ms each second and
// then several at once, and the player skips the ones that land together. The server passes each
// frame on as it comes (live.mjs, stream-hub.mjs: no batching), so the clumps are made either before
// it (the NVR, the SDK) or after it (the connection, the browser). This times the frames at the two
// places the server sees them, in the NVR's worker as the SDK hands them over and in the main
// process as they are handed to viewers, and says once a minute how evenly they came, in the same
// measure the page reports (the longest wait between two frames in each second).
//
// It only watches: nothing waits on it, and CCTV_FRAME_GAPS=off leaves it out altogether.
const REPORT_MS = 60_000

/**
 * @param {{ where: string, now?: () => number, log?: (line: string) => void, everyMs?: number }} o
 *   where: which place this meter stands at, for the line it writes
 * @returns {{ note: (key: string) => void, report: () => string | null }}
 */
export function gapMeter({ where, now = () => performance.now(), log = console.log, everyMs = REPORT_MS }) {
  let streams = new Map() // stream -> { last, secStart, secMax, sum, secs, worst, frames }
  let since = now()

  const report = () => {
    const t = now()
    const typical = [] // each stream's mean of its per-second longest waits
    let worst = 0
    let frames = 0
    for (const s of streams.values()) {
      if (s.secs > 0) typical.push(s.sum / s.secs)
      if (s.worst > worst) worst = s.worst
      frames += s.frames
    }
    const n = typical.length
    const secs = Math.max(1, (t - since) / 1000)
    streams = new Map()
    since = t
    if (n === 0) return null
    typical.sort((a, b) => a - b)
    const at = (q) => Math.round(typical[Math.min(n - 1, Math.floor(q * n))])
    const line = `[gaps ${where}] ${n} streams, ${(frames / secs / n).toFixed(1)} frames/s each: longest wait between frames in a second, middle stream ${at(0.5)} ms, 9 in 10 under ${at(0.9)} ms, worst single wait ${Math.round(worst)} ms`
    log(line)
    return line
  }

  return {
    /** A frame of this stream has just been seen here. */
    note(key) {
      const t = now()
      const s = streams.get(key)
      if (!s) streams.set(key, { last: t, secStart: t, secMax: 0, sum: 0, secs: 0, worst: 0, frames: 1 })
      else {
        const gap = t - s.last
        s.last = t
        s.frames++
        if (gap > s.secMax) s.secMax = gap
        if (gap > s.worst) s.worst = gap
        if (t - s.secStart >= 1000) {
          s.sum += s.secMax
          s.secs++
          s.secStart = t
          s.secMax = 0
        }
      }
      if (t - since >= everyMs) report()
    },
    report
  }
}

/** The meter for this process, or null when it is switched off: callers write `gaps?.note(key)`. */
export const frameGaps = (where, env = process.env) => (env.CCTV_FRAME_GAPS === 'off' ? null : gapMeter({ where }))
