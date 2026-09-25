// Motion search inside a box drawn on a camera's picture.
//
// Light by design:
//   - only periods where the NVR itself recorded motion (anywhere in the picture)
//     are scanned; a box can't see motion the whole picture didn't
//   - footage is pulled at 32x, where the NVR sends keyframes only (one per ~2 s
//     of footage), over a few parallel playback connections
//   - ffmpeg decodes each keyframe straight to a 96x72 greyscale crop of the box
//   - consecutive crops are compared; a lighting change that brightens or darkens
//     the whole box is subtracted out, so clouds and headlights count less
//
// WS /motion?nvr=ID&ch=N&from=T&to=T&box=x,y,w,h&sens=1|2|3   (box as 0..1 fractions)
//   server -> client: {"type":"plan","total":ms,"segments":n}
//                     {"type":"progress","done":ms}
//                     {"type":"hit","start":T,"end":T,"score":0..1}
//                     {"type":"done","hits":n} | {"type":"error","message":...}
import { spawn } from 'node:child_process'
import { PRIORITY } from './lanes.mjs'
import { PB, SPEED_CODE, toDD } from './playback.mjs'
import { CODEC_H265, FRAME_TYPE_VIDEO, FRAME_TYPE_VIDEO_FORMAT, HEADER_SIZE, codecOf, encodeFrame, playFrames, sdkCallT } from './sdk.mjs'

const W = 96
const H = 72
const PARALLEL = 2 // playback connections per scan; this NVR handles about two simultaneous playbacks well
const MAX_SCANS = 2 // concurrent scans per NVR (they share the NVR's playback logins)
const PAD_MS = 5000 // scan a little either side of each NVR motion event
const MIN_CHUNK_MS = 60_000
const NO_FRAMES_MS = 6000 // no frames at all by then -> try the HD stream (camera records HD only)
const IDLE_MS = 8000 // frames stopped arriving -> this chunk is finished
const MERGE_MS = 6000 // hits closer than this become one result
// fraction of the box's pixels that must change, by sensitivity (1 = low, 3 = high)
const THRESHOLDS = { 1: 0.04, 2: 0.015, 3: 0.006 }
const PIXEL_DELTA = 22 // grey levels a pixel must change by to count

const running = new Map() // nvr id -> number of scans

/** Periods to scan: NVR motion events within [from, to], padded and merged; whole range if none. */
function plan(from, to, events) {
  const spans = events
    .map(([s, e]) => [Math.max(from, s - PAD_MS), Math.min(to, e + PAD_MS)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [s, e] of spans) {
    const last = merged.at(-1)
    if (last && s <= last[1] + PAD_MS) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  const list = merged.length ? merged : [[from, to]]
  // split long spans so the parallel connections share the work
  const total = list.reduce((n, [s, e]) => n + (e - s), 0)
  const target = Math.max(MIN_CHUNK_MS, total / (PARALLEL * 2))
  const chunks = []
  for (const [s, e] of list) for (let t = s; t < e; t += target) chunks.push([t, Math.min(e, t + target)])
  return { chunks, total }
}

/** Decodes frames to W x H greyscale crops of the box; calls onFrame(tsMs, pixels). */
class Analyzer {
  constructor(codec, box, onFrame) {
    const [x, y, w, h] = box
    this.pending = []
    this.buf = Buffer.alloc(0)
    this.onFrame = onFrame
    this.proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', 'nobuffer', '-probesize', '32', '-analyzeduration', '0',
      '-f', codec === CODEC_H265 ? 'hevc' : 'h264', '-i', 'pipe:0',
      '-vf', `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},scale=${W}:${H}:flags=area,format=gray`,
      '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'ignore'] })
    this.proc.stdin.on('error', () => {})
    this.proc.stdout.on('data', (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
      while (this.buf.length >= W * H) {
        const ts = this.pending.shift()
        const frame = this.buf.subarray(0, W * H)
        this.buf = this.buf.subarray(W * H)
        if (ts !== undefined) this.onFrame(ts, frame)
      }
    })
    this.done = new Promise((resolve) => this.proc.on('close', resolve))
  }

  push(tsMs, data) {
    this.pending.push(tsMs)
    this.proc.stdin.write(data)
  }

  /** Waits for the frames already sent to be analysed. */
  finish() {
    this.proc.stdin.end()
    return this.done
  }

  kill() {
    this.proc.kill('SIGKILL')
  }
}

/** Fraction of pixels that changed between two crops, with overall lighting change removed. */
function changed(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += b[i] - a[i]
  const shift = sum / a.length
  let n = 0
  for (let i = 0; i < a.length; i++) if (Math.abs(b[i] - a[i] - shift) > PIXEL_DELTA) n++
  return n / a.length
}

/**
 * @param {import('./nvrs.mjs').Nvr} nvr
 * @param {import('ws').WebSocket} ws
 * @param {URL} url
 */
export async function motionScan(nvr, ws, url) {
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj))
  const ch = Number(url.searchParams.get('ch'))
  const from = Number(url.searchParams.get('from'))
  const to = Number(url.searchParams.get('to'))
  const box = (url.searchParams.get('box') ?? '').split(',').map(Number)
  const threshold = THRESHOLDS[url.searchParams.get('sens')] ?? THRESHOLDS[2]
  const valid =
    Number.isInteger(ch) && ch >= 0 && Number.isFinite(from) && to > from && to - from <= 24 * 3_600_000 &&
    box.length === 4 && box.every((v) => v >= 0 && v <= 1) && box[2] > 0.01 && box[3] > 0.01 &&
    box[0] + box[2] <= 1.0001 && box[1] + box[3] <= 1.0001
  if (!valid) {
    send({ type: 'error', message: 'Bad search parameters' })
    return ws.close(1008, 'bad parameters')
  }
  if ((running.get(nvr.id) ?? 0) >= MAX_SCANS) {
    send({ type: 'error', message: 'Another motion search is running on this NVR. Try again when it finishes.' })
    return ws.close(1013, 'busy')
  }
  running.set(nvr.id, (running.get(nvr.id) ?? 0) + 1)

  let cancelled = false
  let stopReason = null // why the search stopped early, for the viewer (null: the viewer left)
  const cleanups = new Set()
  const stop = (reason) => {
    if (cancelled) return
    cancelled = true
    stopReason = reason
    for (const c of cleanups) c()
  }
  ws.on('close', () => stop(null))
  // the NVR relogs or is removed: stop, and say so
  const abortScan = () => stop('The NVR is reconnecting')
  nvr.scans.add(abortScan)

  try {
    // NVR motion events for the range (the day-by-day search the timeline uses)
    const events = []
    // recordings are listed per NVR-local day; from/to are UTC
    const { tzOffsetMs } = await nvr.playback.clock()
    const DAY = 86_400_000
    for (let day = Math.floor((from + tzOffsetMs) / DAY) * DAY; day < to + tzOffsetMs; day += DAY) {
      const date = new Date(day).toISOString().slice(0, 10)
      const res = await nvr.playback.recordings(ch, date)
      events.push(...res.events)
    }
    const { chunks, total } = plan(from, to, events)
    send({ type: 'plan', total, segments: chunks.length, basedOnEvents: events.length > 0 })

    let done = 0
    let found = 0
    const state = { hd: false } // switched to HD for this scan (camera records no SD)
    const queue = [...chunks]
    const worker = async () => {
      while (queue.length && !cancelled) {
        const [s, e] = queue.shift()
        let results
        try {
          results = await scanChunk(nvr, ch, s, e, box, cleanups, () => cancelled, state)
        } catch (err) {
          // could not scan this part (NVR busy or recovering): don't report it as "no movement"
          stop(err.message)
          return
        }
        // chunks finish out of order, so hits are merged per chunk (results are time-ordered)
        let open = null
        for (const [ts, score] of results) {
          if (score < threshold) continue
          if (open && ts - open.end <= MERGE_MS) {
            open.end = ts
            open.score = Math.max(open.score, score)
          } else {
            if (open) send({ type: 'hit', ...open })
            open = { start: ts, end: ts, score }
            found++
          }
        }
        if (open) send({ type: 'hit', ...open })
        if (cancelled) return // hits from a chunk cut short are real, but it was not fully checked
        done += e - s
        send({ type: 'progress', done })
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker))
    if (stopReason) {
      const mins = (ms) => Math.round(ms / 60_000)
      send({
        type: 'error',
        message: `${stopReason}. Search incomplete: ${mins(done)} of ${mins(total)} min checked` +
          `${found ? `, ${found} moment${found === 1 ? '' : 's'} found so far` : ''}. Try again shortly.`
      })
    } else if (!cancelled) {
      send({ type: 'done', hits: found })
    }
  } catch (e) {
    send({ type: 'error', message: e.message })
  } finally {
    nvr.scans.delete(abortScan)
    running.set(nvr.id, (running.get(nvr.id) ?? 1) - 1)
    ws.close()
  }
}

/**
 * Plays [start, end) at 32x and returns [[tsMs, changedFraction]] per keyframe, in time order.
 * SD is used unless the camera is known to record HD only. A chunk that yields no
 * SD frames is retried once in SD (a slow NVR start looks the same as no footage),
 * then in HD for this scan only; the playback page's choice is never changed here.
 * Throws if the NVR could not be asked at all (busy, recovering), so the search can
 * say it is incomplete instead of reporting no movement.
 */
async function scanChunk(nvr, ch, start, end, box, cleanups, isCancelled, state) {
  const once = async (main) => {
    const r = await scanOnce(nvr, ch, start, end, box, main, cleanups, isCancelled)
    if (r && r.failed) throw new Error(r.failed)
    return r
  }
  const hd = state.hd || nvr.playback.isHdOnly(ch)
  let result = await once(hd)
  if (result !== null || hd || isCancelled()) return result ?? []
  result = await once(false)
  if (result !== null || isCancelled()) return result ?? []
  result = await once(true)
  if (result !== null) state.hd = true
  return result ?? []
}

/** Resolves scores, null (playback started but no frames came), or { failed: reason }. */
function scanOnce(nvr, ch, start, end, box, main, cleanups, isCancelled) {
  return new Promise((resolve) => {
    const scores = []
    let prev = null
    let analyzer = null
    let codec = null
    let handle = 0
    let gotFrames = false
    let frames = 0
    let keyframes = 0
    let lastFrameAt = Date.now()
    let finished = false
    const startedAt = Date.now()
    let playingSince = 0 // set once the NVR was told to play at 32x
    let lease = null
    // a timed-out call still running inside the SDK keeps its login (and handle) busy:
    // the playback is stopped and the login returned only once that call comes back
    let starting = false // PlayBackByTimeEx in flight
    let callbackBusy = false // SetPlayDataCallBack in flight (or timed out and still running)

    const onPixels = (ts, pixels) => {
      if (prev) scores.push([ts, changed(prev, pixels)])
      prev = Buffer.from(pixels)
    }

    // all SDK work for this NVR goes through its lane, with time limits
    const op = (task, priority = PRIORITY.NORMAL) => nvr.lane.run(task, { priority })
    const tag = `motion ch${ch + 1}`
    const call = (f, ...args) => sdkCallT({ nvr: nvr.id, tag }, f, ...args)

    /** Stops the playback (if any) and returns the login to the pool. */
    const stopAndFree = async () => {
      const h = handle
      handle = 0
      if (h > 0) {
        playFrames.release(h)
        await op(() => call(PB.StopPlayBack, h), PRIORITY.HIGH).catch(() => {})
      }
      lease?.release()
      lease = null
    }

    /** @param {null | { failed: string }} [outcome] set when no scores are to be reported */
    const finish = async (outcome) => {
      if (finished) return
      finished = true
      clearInterval(timer)
      cleanups.delete(abort)
      if (!starting && !callbackBusy) await stopAndFree()
      if (analyzer) await analyzer.finish()
      scores.sort((a, b) => a[0] - b[0])
      if (process.env.MOTION_DEBUG) {
        const max = Math.max(0, ...scores.map((s) => s[1]))
        const why = outcome === null ? ' (no frames)' : outcome ? ` (${outcome.failed})` : ''
        console.log(`[motion] ch${ch + 1} ${new Date(start).toISOString().slice(11, 19)}-${new Date(end).toISOString().slice(11, 19)} ${main ? 'HD' : 'SD'}: frames ${keyframes}/${frames}, scores ${scores.length}, max ${(max * 100).toFixed(1)}%${why} in ${Date.now() - startedAt} ms`)
      }
      resolve(outcome === undefined ? scores : outcome)
    }
    const abort = () => {
      analyzer?.kill()
      finish()
    }
    cleanups.add(abort)

    // frames arrive via playFrames, routed by handle (the SDK hands every playback's
    // frames to every playback callback)
    const onFrame = (info, buf) => {
      if (finished) return
      if (info.frameType === FRAME_TYPE_VIDEO_FORMAT) {
        codec = codecOf(info, buf)
        return
      }
      if (info.frameType !== FRAME_TYPE_VIDEO || info.length === 0) return
      gotFrames = true
      frames++
      if (info.keyFrame) keyframes++
      lastFrameAt = Date.now()
      const ts = Number(info.time) / 1000
      if (ts >= end) return finish()
      if (!info.keyFrame) return // at 32x the NVR sends keyframes only; ignore stragglers
      analyzer ??= new Analyzer(codec ?? CODEC_H265, box, onPixels)
      analyzer.push(ts, encodeFrame(info, buf, codec ?? CODEC_H265).subarray(HEADER_SIZE))
    }

    const timer = setInterval(() => {
      if (isCancelled()) return abort()
      if (!gotFrames && playingSince && Date.now() - playingSince > NO_FRAMES_MS) return finish(null)
      if (gotFrames && Date.now() - lastFrameAt > IDLE_MS) finish()
    }, 500)

    ;(async () => {
      // each playback needs its own login (see SessionPool in nvrs.mjs)
      let why = ''
      lease = await nvr.sessions.acquire().catch((e) => {
        why = e.message
        return null
      })
      if (finished) {
        // cancelled while waiting for a login
        lease?.release()
        lease = null
        return
      }
      if (!lease) return finish({ failed: why || 'No playback connection to the NVR' })

      starting = true
      let late = false
      const h = await op(() =>
        sdkCallT(
          {
            nvr: nvr.id,
            tag,
            // returned after we gave up on it: stop that playback, then free the login
            onLate: (lateHandle) => {
              starting = false
              if (lateHandle > 0) handle = lateHandle
              stopAndFree()
            }
          },
          PB.PlayBackByTimeEx, lease.userId, [ch], 1, toDD(start), toDD(end), null, main ? 1 : 0
        )
      ).catch((e) => {
        if (e?.name === 'SdkTimeout') late = true
        return -1
      })
      if (late) return finish({ failed: 'The NVR is not answering' })
      starting = false
      if (finished) {
        // cancelled while the playback was starting
        handle = h
        return stopAndFree()
      }
      if (h <= 0) return finish(null)
      handle = h
      playFrames.claim(handle, onFrame)
      callbackBusy = true
      const ok = await op(
        () =>
          sdkCallT(
            {
              nvr: nvr.id,
              tag,
              onLate: () => {
                callbackBusy = false
                if (finished) stopAndFree()
              }
            },
            PB.SetPlayDataCallBack, handle, playFrames.callback, null
          ),
        PRIORITY.HIGH
      ).then(
        (res) => {
          callbackBusy = false
          return res
        },
        (e) => {
          // on a timeout the call still runs with the handle; its onLate stops the playback
          if (e?.name !== 'SdkTimeout') callbackBusy = false
          return false
        }
      )
      if (finished) {
        // cancelled meanwhile: finish() left the stop to us
        if (!callbackBusy) stopAndFree()
        return
      }
      if (!ok) return finish({ failed: 'The NVR is not answering' })
      await op(() => call(PB.PlayBackControl, handle, PB.PLAYCTRL.FF, SPEED_CODE[32], [0]), PRIORITY.HIGH).catch(() => {})
      if (finished) return
      playingSince = Date.now()
    })()
  })
}
