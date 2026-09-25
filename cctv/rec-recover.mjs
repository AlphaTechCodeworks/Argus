// Crash recovery for server recordings (main process). A worker that dies (crash, SIGKILL by its
// watchdog, the app itself killed) leaves its open segment files on disk without an index row
// (the 'segment' message is sent only after the close); housekeeping only deletes what the index
// knows, so such files would stay forever. When an NVR's worker (re)starts, recoverOrphans()
// looks through that NVR's folder on each location for segment files with no row and indexes
// them as they are (bytes kept; a trailing partial frame is harmless to playback):
//   startMs  the first .idx row (the first keyframe), else the minute in the file name
//   endMs    the file's last change (the last frame written), kept between startMs and startMs + 5 min
//            (never before the last .idx row)
//   keyframes  the .idx rows; bytes: the file size
// Only files last changed before the new worker started are touched: anything newer may be one
// the new worker is writing.
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseIdx } from './segment-writer.mjs'

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const HOUR_RE = /^\d{2}$/
const FILE_RE = /^(\d{2})-(\d{2})(?:-\d{1,2})?\.(h264|h265)$/
const MAX_SPAN_MS = 5 * 60_000

const dirs = async (d) => {
  try {
    return (await readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * Indexes the segment files of one NVR on one location that have no index row.
 * @param {{ index: {has, addSegment}, loc: {id, path}, nvrId: string, beforeMs: number }} opts
 * @returns {Promise<object[]>} the rows added
 */
export async function recoverOrphans({ index, loc, nvrId, beforeMs }) {
  const added = []
  const base = join(loc.path, String(nvrId))
  for (const chName of await dirs(base)) {
    if (!/^\d{1,3}$/.test(chName)) continue
    const ch = Number(chName)
    for (const day of await dirs(join(base, chName))) {
      const dm = DAY_RE.exec(day)
      if (!dm) continue
      for (const hour of await dirs(join(base, chName, day))) {
        if (!HOUR_RE.test(hour)) continue
        const folder = join(base, chName, day, hour)
        let names
        try {
          names = await readdir(folder)
        } catch {
          continue
        }
        for (const name of names) {
          const fm = FILE_RE.exec(name)
          if (!fm || fm[1] !== hour) continue
          const path = join(folder, name)
          if (index.has(path)) continue
          let st
          try {
            st = await stat(path)
          } catch {
            continue
          }
          if (!st.isFile() || st.mtimeMs >= beforeMs) continue
          let rows = []
          try {
            rows = parseIdx(await readFile(`${path}.idx`))
          } catch {} // no .idx (crashed between the two opens): the name gives the start
          rows = rows.filter((r) => r.offset <= st.size)
          const named = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(hour), Number(fm[2]))
          const startMs = rows[0]?.tsMs ?? named
          const lastKey = rows.at(-1)?.tsMs ?? startMs
          const endMs = Math.round(Math.max(lastKey, Math.min(st.mtimeMs, startMs + MAX_SPAN_MS)))
          const seg = { nvr: String(nvrId), ch, path, startMs, endMs, bytes: st.size, keyframes: rows.length, loc: loc.id }
          index.addSegment(seg)
          added.push(seg)
        }
        await new Promise((r) => setImmediate(r)) // a big tree: let the app breathe
      }
    }
  }
  return added
}

const DOWNTIME_MIN_MS = 3000 // playback's gapMs: shorter holes are not reported

/**
 * At startup (or a worker restart), after recoverOrphans: a gap row for each recording camera from the
 * end of its newest segment (or gap row, when later) to atMs, so the index explains the time the
 * service or worker was down. Cameras without footage, and holes under 3 s, get none.
 * @param {{ index: {lastEnds, addGap}, nvrId: string, channels: number[], atMs: number, reason: string }} opts
 * @returns {object[]} the rows added
 */
export function downtimeGaps({ index, nvrId, channels, atMs, reason }) {
  const added = []
  for (const ch of channels) {
    const { segEnd, gapEnd } = index.lastEnds(nvrId, ch)
    if (segEnd == null) continue
    const fromMs = Math.max(segEnd, gapEnd ?? -Infinity)
    if (!(atMs - fromMs >= DOWNTIME_MIN_MS)) continue
    const g = { nvr: String(nvrId), ch: Number(ch), fromMs, toMs: atMs, reason }
    index.addGap(g)
    added.push(g)
  }
  return added
}
