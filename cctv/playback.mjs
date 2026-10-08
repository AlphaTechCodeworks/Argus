// Recorded video: search the NVR's recordings and stream playback to a browser.
//
// Times: these NVRs stamp recordings, searches and playback in UTC, while their
// clock (GetDeviceTime) and the time printed on the picture are local time.
// (Verified: a frame stamped 17:26:56 shows 01:26:56 PM on a UTC-4 site.)
// Everywhere in this API a time is ordinary UTC epoch ms. /api/playback/now
// also returns the NVR's time-zone offset, which browsers add for display.
// The process must run with TZ=UTC (set by the Dockerfile and deploy/cctv.service): the SDK
// converts these times with the process time zone, and on a machine set to local time the
// searches came out shifted by its offset (the newest hours missing from the timeline).
//
// Every NVR has its own instance (search queue, session limit). Routes, all with nvr=ID:
//   GET /api/playback/now                      -> { now, tzOffsetMs, skewMs } (skewMs: NVR clock - server clock)
//   GET /api/playback/dates                    -> ["2026-09-06", ...]
//   GET /api/playback/recordings?ch=N&date=D   -> { ranges: [[start, end]], events: [[start, end, type]] }
//   WS  /playback?ch=N&start=T                  -> same binary frames as /live, plus JSON text messages
//        Which stream is decided by the caller (rec-playback.mjs connectPlayback, rec-fallback.mjs):
//        connect(ws, url, { main, allowMain, onMain }); the URL's stream parameter is not read here.
//        Frames are passed through as the camera encoded them; nothing is transcoded here.
//        client -> server: {"speed": 1|2|4|8} {"pause": true|false}
//        server -> client: {"type":"started"} {"type":"end"} {"type":"error","message":...}
//                          {"type":"stream","stream":0} (switched to HD: this camera records no SD)
//        A camera found to record no SD goes over to main only for a viewer who may see main
//        (allowMain, asked then); anyone else gets {"type":"error"} and a 1008 "hd not allowed"
//        close once no SD frame has come in 6 s of playing, on a camera marked HD only; on any other
//        camera no frame is no footage there: {"type":"end"} after 8 s (hd-only.mjs noSdAction).
// While the NVR is busy (recovering, or its calls are stuck or just came back late, or the SDK is
// stuck on any NVR's call) the three GET routes answer 503 { error, retryAfterS } at once and new
// playbacks fail with the same message, instead of queuing more SDK work for it. Playbacks already
// running are left alone.
//
// Recording days (/dates, NET_SDK_FindRecDate) are asked as rarely as possible: that search has
// wedged the whole SDK on nvr1 (every main-process call for every NVR queued behind it, and the
// watchdog restarted the service, stopping all recording), and it was asked again 2 s after the
// restart. The answer is kept on disk (rec-dates.json) and reused for an hour; a search that runs
// past its time limit opens a breaker for that NVR for 2 hours (also when the watchdog's last dump
// names that search), and none is asked in the first 2 minutes after a login. Meanwhile the answer
// comes from the cache, however old, or, with nothing cached, an empty list. The page only uses
// these days for the date picker's lower limit (public/playback.js), so an old answer is harmless
// and an empty one costs only that limit. Not a 503: the page reads any 503 with a Retry-After on
// /dates as "the NVR is busy", and would then load neither the day's recordings from the NVR (NVR
// mode) nor its clock, events and NVR-only stretches (server mode) until it cleared, up to 2 hours
// on the first run, before rec-dates.json exists. /dates is still 503 while the NVR itself is busy
// (checkBusy) and nothing is cached, as before: /now is then 503 as well.
import koffi from 'koffi'
import { PRIORITY } from './lanes.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'
import { CODEC_H264 as X_H264, CODEC_H265 as X_H265, PLAYBACK_LIMITS, Transcoder, clientCanDecodeH265, lightPool, pool as transcodePool } from './transcode.mjs'
import { bind, codecOf, coolingLeftMs, encodeFrame, errorText, lateCalls, playFrames, sdkCallT, sdkStuck, sniffCodec } from './sdk.mjs'
import { lastHang } from './watchdog.mjs'
import { SdWait, hdOnlyStore, noSdAction } from './hd-only.mjs'
import { HD_ASK_MESSAGE, HD_NOT_ALLOWED, HD_ONLY_MESSAGE } from './stream-param.mjs'

// FindNext* result codes continue the SDK error enum: NET_SDK_FILE_SUCCESS is 85 (one more item).
// A file walk is complete only when it ends with 86 NET_SDK_FILE_NOFIND or 87 NET_SDK_NOMOREFILE;
// 88 NET_SDK_FILE_EXCEPTION, 89 NET_SDK_TRY_LATER, -1 or anything else means the list broke off,
// and a list that broke off used to be drawn as the whole day.
const FILE_SUCCESS = 85
const WALK_COMPLETE = new Set([86, 87])
// How old the NVR's last clock read may be and still be used instead of asking again: GetDeviceTime
// is a round trip of up to 15 s on these NVRs, queued behind every other SDK call of this process,
// and one that hung stalled all NVR work here. The clocks stay within seconds of this server's, and
// the reuse takes only the time zone and the skew (/api/playback/now always reads the clock).
const SEARCH_CLOCK_MS = 10 * 60_000 // a recordings() search
const OPEN_CLOCK_MS = 5 * 60_000 // a playback open
const PLAYCTRL = { PAUSE: 0, FF: 1, RESUME: 3, NORMAL: 6 }
// NET_SDK_RPB_SPEED_*; from 8x the NVR sends keyframes only (16x/32x: one per ~2 s of footage)
export const SPEED_CODE = { 2: 7, 4: 8, 8: 9, 16: 10, 32: 11 }
const SESSION_HOURS = 6 // each request asks the NVR for up to this much footage
const PAUSE_ABOVE = 8 * 1024 * 1024 // bytes queued to a slow client before playback is paused
const RESUME_BELOW = 1024 * 1024
const IDLE_END_MS = 8000 // no frames for this long while playing = end of recording
// Server-side pacing. The SDK paces only one playback at a time; others arrive as fast
// as the NVR can send. Frames are therefore buffered and released at their capture
// timing (x speed), and the NVR is paused while the buffer holds more than BUFFER_HIGH_MS.
const PACE_TICK_MS = 15
const BUFFER_HIGH_MS = 8000 // footage buffered (at 1x) before the NVR is paused
const BUFFER_LOW_MS = 3000 // ... and resumed
const GAP_MS = 3000 // next frame this far ahead of the play position: a gap in the recording, jump over it
const LIVE_EDGE_MS = 30_000 // playback ends this long before "now"
const MAX_QUEUE_FRAMES = 5000 // pacing buffer backstop (~2.5 min at 30 fps) if the NVR ignores pauses
// A remote viewer's main stream, fitted to the tunnel (the playback hunt of 1 Oct 2026, finding F6).
// The NVR's main stream went to a remote viewer as it was: 42.76 MB in 54 s (6.3 Mbit/s) through a
// tunnel connection that carries 3.5-6.5, at 3-50 frames a second with 3 gaps over 1 s and about 1 MB
// standing in cloudflared. Server playback has fitted its own recordings since the smoothness report
// (rec-playback.mjs, "A remote viewer"); this is the same for the NVR's: NVR playback in HD, and the
// NVR legs of a server playback. See PlaybackSession #fitDecide.
const FIT_KEYS_PER_S = 8 // faster than 1x a fitted session converts keyframes only, at most this many a second (rec-playback.mjs maxKeysPerS)
const FIT_HOLDS = 3 // frames ffmpeg needs after the first before it gives a picture back (rec-playback.mjs CONVERTER_HOLDS)
const FIT_WAIT_MS = 3000 // a converter silent this long at its start is not waited for (rec-playback.mjs convertWaitMs)

// continuous/manual recording vs. event recordings (DD_RECORD_TYPE)
const CONTINUOUS_TYPES = 0x1 | 0x2
const BUSY_RETRY_S = 10 // "try again" hint while an NVR recovers (relogin, probe): how long is unknown
const SKEW_MIN_MS = 2000 // NVR clock differences under this read as 0 (DD_TIME has whole seconds)
// recording days (see the top)
const DATES_FILE = join(DATA_DIR, 'rec-dates.json')
const DATES_FRESH_MS = 60 * 60_000 // an answer this recent is reused without asking
const DATES_BREAKER_MS = 2 * 3_600_000 // no search after one ran past its time limit
const DATES_AFTER_LOGIN_MS = 2 * 60_000 // none this soon after a login (04:13:16: 2 s after it)

const pad = (n) => String(n).padStart(2, '0')

/** Refusal while an NVR is busy (see the top); retryAfterS: when it is worth asking again. */
export class NvrBusy extends Error {
  constructor(retryAfterS) {
    super('The NVR is busy; try again in a moment')
    this.name = 'NvrBusy'
    this.retryAfterS = retryAfterS
  }
}

// ---- SDK bindings (defined once, shared by every NVR) ----------------------

const DD_TIME = koffi.struct('PB_DD_TIME', {
  second: 'uint8',
  minute: 'uint8',
  hour: 'uint8',
  wday: 'uint8',
  mday: 'uint8',
  month: 'uint8', // 0-11
  year: 'uint16', // minus 1900
  nTotalseconds: 'int',
  nMicrosecond: 'int'
})
const DD_DATE = koffi.struct('PB_DD_DATE', { mday: 'uint8', month: 'uint8', year: 'uint16' })
const REC_FILE = koffi.struct('PB_REC_FILE', {
  dwChannel: 'uint32',
  bFileLocked: 'uint32',
  startTime: DD_TIME,
  stopTime: DD_TIME,
  dwRecType: 'uint32',
  dwPartition: 'uint32',
  dwFileIndex: 'uint32'
})
const fn = (sig) => bind(sig)
const GetDeviceTime = fn('bool NET_SDK_GetDeviceTime(long userId, _Out_ PB_DD_TIME *time)')
const FindRecDate = fn('int64 NET_SDK_FindRecDate(long userId)')
const FindNextRecDate = fn('long NET_SDK_FindNextRecDate(int64 handle, _Out_ PB_DD_DATE *date)')
const FindRecDateClose = fn('bool NET_SDK_FindRecDateClose(int64 handle)')
const FindFile = fn('int64 NET_SDK_FindFile(long userId, long ch, PB_DD_TIME *start, PB_DD_TIME *stop)')
const FindNextFile = fn('long NET_SDK_FindNextFile(int64 handle, _Out_ PB_REC_FILE *file)')
const FindClose = fn('bool NET_SDK_FindClose(int64 handle)')
const PlayBackByTimeEx = fn(
  'int64 NET_SDK_PlayBackByTimeEx(long userId, long *chs, long n, PB_DD_TIME *start, PB_DD_TIME *stop, void *wnds, int mainStream)'
)
const SetPlayDataCallBack = fn('bool NET_SDK_SetPlayDataCallBack(int64 handle, CctvFrameCallback *cb, void *user)')
const PlayBackControl = fn('bool NET_SDK_PlayBackControl(int64 handle, uint32 code, uint32 value, _Out_ uint32 *out)')
const StopPlayBack = fn('bool NET_SDK_StopPlayBack(int64 handle)')
// the recording-date search; the tests replace these (and may shorten the time limit, which is
// otherwise each function's own budget in sdk.mjs)
const REAL_DATE_CALLS = { FindRecDate, FindNextRecDate, FindRecDateClose, timeoutMs: undefined }
let dateCalls = REAL_DATE_CALLS
// ... and the recorded-file search with its clock read, the same way
const REAL_SEARCH_CALLS = { GetDeviceTime, FindFile, FindNextFile, FindClose, timeoutMs: undefined }
let searchCalls = REAL_SEARCH_CALLS

/** Every NVR's saved recording days and breaker: { [id]: { at, dates, openUntil, why } }. */
const readDatesFile = () => {
  try {
    const all = JSON.parse(readFileSync(DATES_FILE, 'utf8'))
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch {
    return {}
  }
}

/** UTC epoch ms -> DD_TIME with UTC fields (the time base of recordings; see the top). */
export const toDD = (ms) => {
  const d = new Date(ms)
  return {
    second: d.getUTCSeconds(),
    minute: d.getUTCMinutes(),
    hour: d.getUTCHours(),
    wday: d.getUTCDay(),
    mday: d.getUTCDate(),
    month: d.getUTCMonth(),
    year: d.getUTCFullYear() - 1900,
    nTotalseconds: 0,
    nMicrosecond: 0
  }
}
export const fromDD = (t) => Date.UTC(t.year + 1900, t.month, t.mday, t.hour, t.minute, t.second)

/** Playback bindings shared with the motion scanner. */
export const PB = { PlayBackByTimeEx, SetPlayDataCallBack, PlayBackControl, StopPlayBack, PLAYCTRL }


/**
 * Recording search and playback for one NVR.
 * @param {{ id: string, userId: number, loggedInAt?: number }} nvr
 * @param {{ now?: () => number, makeTranscoder?: Function, pool?: object, log?: Function }} [opts]
 *   now: the clock of the recording-days cache; makeTranscoder, pool: the conversion and its slots for
 *   a main stream (transcode.mjs Transcoder and pool); log (all for tests)
 */
export function createPlayback(nvr, { now: datesNow = Date.now, makeTranscoder = (o) => new Transcoder(o), pool: mainPool = transcodePool, log = (l) => console.log(l), nvrStalled = () => lateCalls(nvr.id) > 0 || sdkStuck() } = {}) {
  const userId = () => nvr.userId
  // all SDK work for this NVR goes through its lane, with time limits (lanes.mjs, sdk.mjs)
  const op = (task, priority = PRIORITY.NORMAL) => nvr.lane.run(task, { priority })
  const call = (f, ...args) => sdkCallT({ nvr: nvr.id, tag: 'playback' }, f, ...args)
  const callLate = (onLate, f, ...args) => sdkCallT({ nvr: nvr.id, tag: 'playback', onLate }, f, ...args)
  // The SDK call options of a search or clock read. background: the event intake's, coverage's
  // and motion search's, which nobody waits on: their own tag, and one that comes back late does
  // not cool the NVR (sdk.mjs), which would refuse every viewer's playback and searches of it for a
  // minute. The timeline's searches and playback's clock reads cool it as before.
  const searchOpts = (background = false) => ({ nvr: nvr.id, tag: background ? 'background search' : 'playback', background })

  /**
   * Walks a search handle with next() and closes it afterwards. If a call times out, the
   * native call is still using the handle, so it is closed only once that call returns.
   * opts: timeoutMs for every call of the walk (default: each function's own budget); tag and
   * background as searchOpts; end(code): called with the code that ended the walk (anything but
   * FILE_SUCCESS), and may throw when that code means the list broke off.
   */
  const walk = async (h, next, close, onItem, { timeoutMs, tag = 'playback', background = false, end = null } = {}) => {
    let late = false
    const t = (onLate, f, ...args) => sdkCallT({ nvr: nvr.id, tag, background, timeoutMs, onLate }, f, ...args)
    const closeLater = () => t(undefined, close, h).catch(() => {})
    try {
      let code
      for (let item = {}; (code = await t(closeLater, next, h, item)) === FILE_SUCCESS; item = {}) onItem(item)
      end?.(code)
    } catch (e) {
      if (e?.name === 'SdkTimeout') late = true
      throw e
    } finally {
      if (!late) await t(undefined, close, h).catch(() => {})
    }
  }
  // a search handle that arrives after its timeout is closed straight away
  const closeIfLate = (close, opts = searchOpts()) => (h) => h > 0 && sdkCallT(opts, close, h).catch(() => {})

  /**
   * Throws NvrBusy while the NVR recovers or cools down after late calls (sdk.mjs nvrCooling).
   * Checked before a search or playback queues, and again when its turn in the lane comes.
   */
  const checkBusy = () => {
    const coolMs = coolingLeftMs(nvr.id)
    if (coolMs > 0) throw new NvrBusy(Math.ceil(coolMs / 1000))
    if (nvr.degraded) throw new NvrBusy(BUSY_RETRY_S)
    // the SDK is stuck on another NVR's call (sdk.mjs sdkStuck): this would only queue behind it
    if (sdkStuck()) throw new NvrBusy(BUSY_RETRY_S)
  }

  // searches share one SDK session; run them one at a time
  let searchChain = Promise.resolve()
  const serial = (task) => {
    const run = searchChain.then(task, task)
    searchChain = run.catch(() => {})
    return run
  }

  const TZ_STEP = 15 * 60_000
  let lastClockRead = null // { tzOffsetMs, skewMs, at } of the last successful clock()
  /**
   * The NVR's clock: now as UTC ms (the base recordings are stamped in), its time-zone offset
   * (local - UTC) and skewMs (its clock - this server's). The offset is rounded to 15 min, which
   * absorbs a few minutes of clock error; that error is skewMs (e.g. nvr1 runs about 3 min 40 s
   * fast). Server recordings are stamped with the server's clock. Under SKEW_MIN_MS skewMs is 0:
   * DD_TIME has whole seconds.
   * @param {{ inLane?: boolean, background?: boolean }} [opts] inLane: already running inside this
   *   NVR's lane (don't take a second slot); background: as searchOpts
   */
  const clock = async ({ inLane = false, background = false } = {}) => {
    const read = async () => {
      checkBusy()
      const t = {}
      const { GetDeviceTime: getTime, timeoutMs } = searchCalls
      return (await sdkCallT({ ...searchOpts(background), timeoutMs }, getTime, userId(), t)) ? t : null
    }
    if (!inLane) checkBusy() // answer at once rather than queue behind slow calls
    // ordinary work (NORMAL): HIGH is for stops, which must get through a busy lane
    const t = await (inLane ? read() : op(read))
    if (!t) throw new Error('GetDeviceTime failed')
    const local = fromDD(t) // the NVR's local wall clock, fields read as UTC
    const wall = Date.now()
    const tzOffsetMs = Math.round((local - wall) / TZ_STEP) * TZ_STEP
    const now = local - tzOffsetMs
    const skewMs = Math.abs(now - wall) < SKEW_MIN_MS ? 0 : now - wall
    if (Number.isFinite(now)) lastClockRead = { tzOffsetMs, skewMs, at: wall }
    return { now, tzOffsetMs, skewMs }
  }
  /** The last clock() read ({ tzOffsetMs, skewMs, at }), or null: never calls the NVR. */
  const lastClock = () => (lastClockRead ? { ...lastClockRead } : null)
  const nvrNow = async (opts) => (await clock(opts)).now
  /**
   * The NVR's clock as clock() answers it, from the last read while that is under maxAgeMs old (now:
   * this server's clock plus the skew then), otherwise read now (opts as clock()). Refuses while the
   * NVR is busy either way, as clock() does: a playback or search must not start then.
   */
  const recentClock = async (maxAgeMs, opts = {}) => {
    checkBusy()
    const last = lastClockRead
    if (last && Date.now() - last.at < maxAgeMs) {
      return { now: Date.now() + last.skewMs, tzOffsetMs: last.tzOffsetMs, skewMs: last.skewMs }
    }
    return clock(opts)
  }

  // ---- recording days (see the top): cache on disk, breaker, not just after a login
  const saved = readDatesFile()[nvr.id] ?? {}
  let datesCache = {
    at: Number(saved.at) || 0,
    dates: Array.isArray(saved.dates) ? saved.dates.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) : []
  }
  let breaker = { until: Number(saved.openUntil) || 0, why: String(saved.why ?? '') }
  {
    // the previous run was killed by the watchdog with this NVR's date search as the oldest call:
    // asking again at once is how 04:13:16 followed 04:12:13
    const hang = lastHang()
    const until = Date.parse(hang?.at ?? '') + DATES_BREAKER_MS
    if (/^NET_SDK_Find(Next)?RecDate$/.test(hang?.oldest?.name ?? '') && hang.oldest.nvr === nvr.id && until > breaker.until) {
      breaker = { until, why: `the watchdog restarted the service at ${hang.at} with a recording-date search to this NVR stuck` }
    }
  }
  const saveDates = () => {
    try {
      const all = readDatesFile()
      all[nvr.id] = { at: datesCache.at, dates: datesCache.dates, openUntil: breaker.until, why: breaker.why }
      writeFileSync(DATES_FILE, `${JSON.stringify(all)}\n`, { mode: 0o600 })
    } catch (e) {
      console.warn(`[${nvr.id}] could not save the recording days: ${e.message}`)
    }
  }
  /**
   * Why the NVR is not to be asked for its recording days now, or null: 'held' while the search
   * itself is held back (the breaker is open, or it logged in less than 2 minutes ago), or the
   * NvrBusy while the NVR is busy (checkBusy, which refuses /now just the same).
   */
  const whyNotAskDates = () => {
    const t = datesNow()
    if (breaker.until > t) return 'held'
    if (nvr.loggedInAt && t - nvr.loggedInAt < DATES_AFTER_LOGIN_MS) return 'held'
    try {
      checkBusy()
    } catch (e) {
      return e
    }
    return null
  }
  const datesFresh = () => datesCache.at > 0 && datesNow() - datesCache.at < DATES_FRESH_MS
  /**
   * When the NVR is not to be asked: the cached days however old (they only set the date picker's
   * lower limit). With nothing cached, no days while the search is held back (see the top: a 503
   * there would stall the whole page for hours), and the refusal while the NVR is busy.
   */
  const cachedOr = (why) => {
    if (datesCache.at) return datesCache.dates
    if (why instanceof Error) throw why
    return []
  }
  const recordDates = async () => {
    // a recent answer: no lane, no SDK
    if (datesFresh()) return datesCache.dates
    const no = whyNotAskDates()
    if (no) return cachedOr(no)
    return serial(() => op(async () => {
      // (checked again when its turn comes: another request may have asked meanwhile, or the NVR got busy)
      if (datesFresh()) return datesCache.dates
      const noNow = whyNotAskDates()
      if (noNow) return cachedOr(noNow)
      const { FindRecDate: find, FindNextRecDate: next, FindRecDateClose: close, timeoutMs } = dateCalls
      try {
        const h = await sdkCallT({ nvr: nvr.id, tag: 'playback', timeoutMs, onLate: closeIfLate(close) }, find, userId())
        if (h <= 0) throw new Error('FindRecDate failed')
        const dates = []
        // (any code but 85 ends this walk, unlike the file walk: a short list only moves the date
        // picker's lower limit, while an error is not cached and would ask FindRecDate, the search
        // that wedged the SDK, again on every page load)
        await walk(h, next, close, (d) => dates.push(`${d.year}-${pad(d.month)}-${pad(d.mday)}`), { timeoutMs })
        datesCache = { at: datesNow(), dates: dates.sort() }
        saveDates()
        return datesCache.dates
      } catch (e) {
        if (e?.name === 'SdkTimeout') {
          // on nvr1 this search once held every main-process SDK call for a minute: not again for a while
          breaker = { until: datesNow() + DATES_BREAKER_MS, why: `the recording-date search ran past its time limit (${e.message})` }
          saveDates()
          console.warn(`[${nvr.id}] ${breaker.why}: not asking this NVR for its recording days for ${DATES_BREAKER_MS / 3_600_000} h`)
        }
        throw e
      }
    }))
  }

  /**
   * Recorded ranges (merged) and event recordings for one channel on one NVR-local day (date = YYYY-MM-DD).
   * Throws when the NVR could not say: a refused search (it refuses offline or unconfigured channels
   * too) or a file list that broke off is not "no footage". The timeline then shows the day as
   * unknown ("Could not load recordings"), the event intake and backfill ask again later, coverage
   * gives a reason and motion search stops with the error.
   * background: the event intake's, coverage's and motion search's search (see searchOpts).
   */
  const recordings = async (ch, date, { background = false } = {}) => {
    checkBusy()
    const opts = searchOpts(background)
    const { FindFile: find, FindNextFile: next, FindClose: close, timeoutMs } = searchCalls
    return serial(() => op(async () => {
      // (checks busy again first: the NVR may have got busy while this waited for its turn)
      const { now, tzOffsetMs } = await recentClock(SEARCH_CLOCK_MS, { inLane: true, background })
      // the local day, as UTC times
      const dayStart = Date.parse(`${date}T00:00:00Z`) - tzOffsetMs
      if (Number.isNaN(dayStart)) throw new Error('bad date')
      const dayEnd = Math.min(dayStart + 86_400_000 - 1000, now)
      if (dayEnd <= dayStart) return { ranges: [], events: [] }
      const unknown = (why) => new Error(`${why}, so what it recorded on ${date} is unknown`)
      // (with a limit past the SDK's own 20 s wait, sdk.mjs, a search it gave up on lands here too)
      const h = await sdkCallT({ ...opts, timeoutMs, onLate: closeIfLate(close, opts) }, find, userId(), ch, toDD(dayStart), toDD(dayEnd))
      if (h <= 0) throw unknown('the NVR refused the search (FindFile failed)')
      const files = []
      const end = (code) => {
        if (WALK_COMPLETE.has(code)) return
        const text = errorText(code)
        throw unknown(`the NVR's file list broke off (code ${code}${text.startsWith('error ') ? '' : `, ${text}`})`)
      }
      await walk(h, next, close, (f) => {
        const start = fromDD(f.startTime)
        if (start <= now) files.push({ start, end: Math.min(fromDD(f.stopTime), now), type: f.dwRecType })
      }, { ...opts, timeoutMs, end })
      files.sort((a, b) => a.start - b.start)
      const ranges = []
      for (const f of files) {
        const last = ranges.at(-1)
        if (last && f.start <= last[1] + 2000) last[1] = Math.max(last[1], f.end)
        else ranges.push([f.start, f.end])
      }
      const events = files.filter((f) => (f.type & CONTINUOUS_TYPES) === 0).map((f) => [f.start, f.end, f.type])
      return { ranges, events }
    }))
  }

  // ---- playback sessions --------------------------------------------------

  const sessions = new Set()
  // channels found to record no SD stream: asked for main at once next time (hd-only.mjs: marked only
  // once main frames came after a switch, cleared by an SD frame, trusted for a week; kept across restarts)
  const hdOnly = hdOnlyStore({ file: join(DATA_DIR, 'hd-only.json'), nvrId: nvr.id })
  // a viewer's "may see main" hook, asked now (rec-playback.mjs hands in one that reads the session as
  // it is then); one that throws is a no
  const askMain = (allowMain) => {
    try {
      return allowMain() === true
    } catch {
      return false
    }
  }

  class PlaybackSession {
    /**
     * @param {{ allowMain?: () => boolean, onMain?: () => void, fit?: object|null }} [rights] allowMain:
     *   may this viewer see main pictures (asked when no SD comes); onMain: told when the session goes
     *   over to main; fit: a remote viewer, whose main stream is fitted to the link (#fitDecide):
     *   { kbps?: the rate this camera records at when known, slot?: a conversion slot lent by the server
     *   playback this is a leg of }; null: a viewer on the local network, nothing changes
     */
    constructor(ws, ch, mainStream, start, clientH265 = true, { allowMain = () => false, onMain = () => {}, fit = null } = {}) {
      this.ws = ws
      this.allowMain = allowMain
      this.onMain = onMain
      this.fit = fit // a remote viewer (see FIT_KEYS_PER_S above and #fitDecide)
      this.fitAsked = false // decided for the frames from here on (asked again after a speed change)
      this.fitOn = false // the main stream goes through the capped conversion
      this.fitKey = true // the converter starts at the next keyframe (its first frame, or after a speed change)
      this.fitKeyAt = 0 // when the last keyframe went in, faster than 1x (FIT_KEYS_PER_S)
      this.xin = 0 // frames handed to the fitting converter since it started, and pictures it gave back
      this.xout = 0
      this.hold = null // the pacer waits for a converter that has just started (#heldPace)
      this.lastIn = null // the capture time of the last frame handed in
      // A browser that cannot decode H.265 (no HEVC extension on Windows) gets the NVR's H.265
      // converted to H.264 here, as rec-playback.mjs does for the server's own recordings; with the
      // NAS down, the NVR is where all playback comes from.
      this.clientH265 = clientH265
      this.xcode = null
      this.slot = null
      this.ch = ch
      this.mainStream = mainStream
      this.start = start
      this.handle = 0
      this.closed = false
      this.paused = false // by the viewer
      this.throttled = false // by us, because the viewer's connection is backed up
      this.buffered = false // by us, because the pacing buffer is full
      this.nvrRunning = true
      this.resuming = 0 // RESUMEs asked for that the NVR has not taken yet (#updateNvr)
      this.queue = [] // { ts, msg } waiting for their release time
      this.anchor = null // { wall, media }: media time `media` is released at wall time `wall`
      this.speed = 1
      this.codec = 0
      this.lastFrameAt = Date.now()
      this.gotFrames = false
      this.openedAt = 0
      this.sdWait = new SdWait() // no SD frame in 4 s of the NVR really playing: HD only (hd-only.mjs)
      this.markOnFrames = false // switched to main: marked HD-only when its first frame comes
      this.onFrame = this.#onFrame.bind(this)
      sessions.add(this)
      ws.on('message', (data, isBinary) => {
        // (#onCommand is async and nobody waits for it: whatever it throws must end here. Nothing in
        // this process listens for unhandled rejections, so one that escaped ended the server.)
        if (!isBinary) this.#onCommand(String(data)).catch((e) => console.warn(`[${nvr.id}] playback ch${this.ch + 1}: a command failed: ${e?.message ?? e}`))
      })
      ws.on('close', () => this.close())
      this.timer = setInterval(() => this.#watch(), 500)
      this.pacer = setInterval(() => this.#pace(), PACE_TICK_MS)
      this.#open()
    }

    send(obj) {
      if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj))
    }

    async #open() {
      try {
        const t = [Date.now()]
        // the last clock read while it is under 5 min old (see OPEN_CLOCK_MS); refused while busy
        const { now } = await recentClock(OPEN_CLOCK_MS)
        t.push(Date.now())
        // Closed while the clock was read (a held arrow key opens and drops one per repeat): stop
        // here, before the login. Taking one costs the NVR 2.4-3.9 s and a place in its small pool,
        // only to be handed straight back; a burst of them put rigginglot into its cool-down.
        // (Nothing below awaits before sessions.acquire(), so this one check covers it.)
        if (this.closed) return this.#unregister()
        // asking for footage up to "now" (the file still being written) makes the NVR
        // take a 10 s timeout before starting, so stop a little short of it
        const stop = Math.min(this.start + SESSION_HOURS * 3_600_000, now - LIVE_EDGE_MS)
        if (this.start >= stop) throw new Error('No recording at this time')
        // each playback needs its own login (see SessionPool in nvrs.mjs)
        this.lease ??= await nvr.sessions.acquire()
        t.push(Date.now())
        if (this.closed) return this.#unregister()
        this.starting = true
        const handle = await op(() =>
          sdkCallT(
            {
              nvr: nvr.id,
              tag: `playback ch${this.ch + 1}`,
              // returned after we gave up waiting: stop that orphan playback, then free the login
              onLate: (h) => {
                this.starting = false
                const done = () => this.#unregister()
                if (h > 0) op(() => call(StopPlayBack, h), PRIORITY.HIGH).catch(() => {}).finally(done)
                else done()
              }
            },
            PlayBackByTimeEx, this.lease.userId, [this.ch], 1, toDD(this.start), toDD(stop), null, this.mainStream ? 1 : 0
          )
        ).then(
          (h) => {
            this.starting = false
            return h
          },
          (e) => {
            // on a timeout the native call still runs on this login; onLate frees it
            if (e?.name !== 'SdkTimeout') this.starting = false
            throw e
          }
        )
        t.push(Date.now())
        if (handle <= 0) throw new Error('The NVR refused playback')
        this.handle = handle
        this.keySeen = false
        if (this.closed) return this.#release()
        playFrames.claim(handle, this.onFrame)
        const ok = await op(
          // if this times out it still holds the handle natively: stop the playback when it returns
          () => callLate(() => this.#release(), SetPlayDataCallBack, handle, playFrames.callback, null),
          PRIORITY.HIGH
        ).catch((e) => {
          if (e?.name === 'SdkTimeout') this.lateCallback = true
          throw e
        })
        if (!ok) throw new Error('The NVR refused playback')
        t.push(Date.now())
        if (this.closed) return
        // pause or speed the viewer chose while the playback was opening
        if (this.speed !== 1) await this.#control(PLAYCTRL.FF, SPEED_CODE[this.speed])
        this.nvrRunning = true
        await this.#updateNvr()
        if (process.env.MOTION_DEBUG) console.log(`[${nvr.id}] open timings: now ${t[1] - t[0]} ms, login ${t[2] - t[1]} ms, playback ${t[3] - t[2]} ms, callback ${t[4] - t[3]} ms`)
        this.lastFrameAt = Date.now()
        this.openedAt = Date.now()
        this.send({ type: 'started' })
        console.log(`[${nvr.id}] playback ch${this.ch + 1} ${this.mainStream ? 'main' : 'sub'} from ${new Date(this.start).toISOString()}`)
      } catch (e) {
        if (this.handle === 0) {
          this.handle = -1
          // a PlayBackByTimeEx still running natively keeps the login until it returns
          if (!this.starting) this.#unregister()
        } else if (!this.lateCallback) {
          this.#release()
        }
        this.send({ type: 'error', message: e.message })
        this.ws.close(1011, 'playback failed')
      }
    }

    // frames arrive via playFrames, which routes by handle (the SDK hands every
    // playback's frames to every playback callback)
    #onFrame(info, buf) {
      if (this.closed) return
      if (info.frameType === 5) {
        this.codec = codecOf(info, buf)
        return
      }
      if (info.frameType !== 1 || info.length === 0) return
      this.lastFrameAt = Date.now()
      this.nvrStalledSaid = false // a frame came: a later stall may say "not answering" again
      if (!this.gotFrames) {
        // the first frame: an SD one proves the camera is not HD only (a mark from a slow NVR heals);
        // the first main one after a switch is the proof that it is, and only now is it marked
        if (!this.mainStream) hdOnly.unmark(this.ch)
        else if (this.markOnFrames) {
          this.markOnFrames = false
          hdOnly.mark(this.ch)
        }
      }
      this.gotFrames = true
      if (info.keyFrame) {
        // trust the bitstream over the NVR's format notes, which can be empty or late in playback
        const sniffed = sniffCodec(buf, info.length)
        if (sniffed !== null) this.codec = sniffed
        this.keySeen = true
      } else if (!this.keySeen) {
        return // a playback can start mid-GOP: the browser can't use anything before a keyframe
      }
      this.queue.push({ ts: Number(info.time) / 1000, msg: encodeFrame(info, buf, this.codec), codec: this.codec })
      const ahead = this.#bufferedMs()
      if (!this.buffered && ahead > BUFFER_HIGH_MS * this.speed) {
        this.buffered = true
        this.#updateNvr()
      } else if (!this.nvrRunning && ahead > 4 * BUFFER_HIGH_MS * this.speed && Date.now() - (this.lastRepause ?? 0) > 2000) {
        // the NVR did not take the pause: ask again
        this.lastRepause = Date.now()
        this.#control(PLAYCTRL.PAUSE)
      }
      if (this.queue.length > MAX_QUEUE_FRAMES) {
        this.send({ type: 'error', message: 'The NVR kept sending while paused. Press play to continue.' })
        this.ws.close(1011, 'buffer overflow')
      }
    }

    /** Footage (media ms) waiting in the pacing buffer. */
    #bufferedMs() {
      return this.queue.length > 1 ? this.queue.at(-1).ts - this.queue[0].ts : 0
    }

    /** Releases the frames that are due. */
    #pace() {
      if (this.closed || this.paused) return
      if (this.hold) return this.#heldPace()
      if (this.queue.length === 0) return
      const now = Date.now()
      const head = this.queue[0].ts
      if (!this.anchor) this.anchor = { wall: now, media: head }
      let mediaNow = this.anchor.media + (now - this.anchor.wall) * this.speed
      // a gap in the recording, or we got ahead of a slow NVR: continue from the next frame
      if (head > mediaNow + GAP_MS || head < mediaNow - 1000) {
        this.anchor = { wall: now, media: head }
        mediaNow = head
      }
      // (a converter that starts on one of these stops the release there: #heldPace goes on)
      while (!this.hold && this.queue.length && this.queue[0].ts <= mediaNow) this.#deliver(this.queue.shift())
      if (this.buffered && this.#bufferedMs() < BUFFER_LOW_MS * this.speed) {
        this.buffered = false
        this.#updateNvr()
      }
    }

    /**
     * A fitting converter has just started, playing every frame: ffmpeg's first picture comes 0.5-1.4 s
     * after its first frame went in, and it then works off what it was handed meanwhile faster than it
     * plays, so a clock that ran on meanwhile sent the first seconds in a rush (rec-playback.mjs, "A
     * converter's start", finding F3: a skip and a freeze 3-4 s after the first picture). As there: the
     * converter is handed FIT_HOLDS frames more, which it needs before it gives a picture back, and the
     * clock stops until it has given back all but that many (the first frame's picture is out), or has
     * been silent for FIT_WAIT_MS. The clock then goes on from the last frame handed in.
     */
    #heldPace() {
      const h = this.hold
      while (this.hold === h && h.extra < FIT_HOLDS && this.queue.length) {
        h.extra++
        this.#deliver(this.queue.shift())
      }
      if (this.hold !== h) return
      const now = Date.now()
      const out = this.xout >= Math.max(1, this.xin - FIT_HOLDS)
      if (!out && now - h.last < FIT_WAIT_MS) return
      if (!out) log(`[${nvr.id}] playback ch${this.ch + 1}: the conversion gave no picture in ${FIT_WAIT_MS} ms (${this.xin} frames in, ${this.xout} out): playing on`)
      this.hold = null
      this.anchor = this.lastIn === null ? null : { wall: now, media: this.lastIn }
      if (this.buffered && this.#bufferedMs() < BUFFER_LOW_MS * this.speed) {
        this.buffered = false
        this.#updateNvr()
      }
    }

    /**
     * A remote viewer's main stream, decided at a keyframe: the session's first frame, and the next
     * keyframe after a change of speed while it is sent as it is. As server playback decides a run
     * (rec-playback.mjs #fitRun):
     *  - A slot lent by the server playback this session is a leg of (fit.slot): that viewer's run is
     *    converted and has been told so, and its own converter is idle while the leg plays. Converted,
     *    nothing said. (The pool is 2 and the last is never taken for this, so a leg could never have
     *    had one of its own beside the server playback's.)
     *  - A camera known to record within the cap (fit.kbps, from the server's own recordings of it,
     *    times the speed) is sent as it is: {type:'fit', on:false, fits:true}. Not known: converted.
     *  - Otherwise a slot of the playback pool, never the last free one unless this is H.265 the browser
     *    cannot decode (which needs one anyway): {type:'fit', on:true}. None to spare: said
     *    ({type:'fit', on:false, busy:true}) and the NVR's stream goes as it is, as before.
     * Converted, every frame (H.264 too) goes through PLAYBACK_LIMITS (1920 wide, 2.5 Mbit/s) with the
     * decoder's frame threads (lowDelay false). Faster than 1x only keyframes are converted, at most
     * FIT_KEYS_PER_S a second and stamped so (one picture at a time, with low_delay): a converter fed
     * every frame at 2x-8x falls behind (4K: 2.2x real time at best), and its cap would hold per camera
     * second, not per second of the link. The sub-stream is never fitted, and neither is anything for a
     * viewer on the local network.
     */
    #fitDecide(codec) {
      this.fitAsked = true
      if (this.closed) return // (a closed session must never take a slot: close() will not run again)
      const needed = !this.clientH265 && codec === X_H265
      if (this.fit.slot) {
        this.#fitTake({ release() {} }) // lent: the lender gives it back
        return
      }
      const kbps = this.fit.kbps
      if (!needed && Number.isFinite(kbps) && kbps > 0 && kbps * this.speed <= PLAYBACK_LIMITS.maxKbps) {
        this.send({ type: 'fit', on: false, fits: true })
        return
      }
      const slot = mainPool.acquire({ keepFree: needed ? 0 : 1 })
      if (slot) {
        this.#fitTake(slot)
        this.send({ type: 'fit', on: true })
        return
      }
      const kept = needed ? '' : '; the last is kept for H.265 a browser cannot decode'
      log(`[${nvr.id}] playback ch${this.ch + 1}: remote viewer, no conversion to spare (${mainPool.active} of ${mainPool.max} running${kept}): sending the NVR's stream as it is`)
      this.send({ type: 'fit', on: false, busy: true })
    }

    /** The session converts from here on, in this slot (a converter of the sub-stream before a switch ends). */
    #fitTake(slot) {
      this.xcode?.close()
      this.xcode = null
      this.slot?.release()
      this.slot = slot
      this.fitOn = true
      this.fitKey = true
    }

    /** One frame of a fitted session to its converter (see #fitDecide). */
    #fitPush({ msg, codec, ts }) {
      const isKey = (msg[0] & 1) === 1
      const keysOnly = this.speed > 1
      if (this.fitKey || (this.xcode && this.xcode.inCodec !== codec)) {
        // the converter starts here: its first frame, a change of speed (other arguments), or the
        // camera's codec changed (ffmpeg is told what it reads when it starts). On a keyframe only.
        if (!isKey) return
        this.xcode?.reset()
        if (this.xcode) this.xcode.inCodec = codec
        this.fitKey = false
        this.xin = 0
        this.xout = 0
        this.hold = null
      }
      if (keysOnly) {
        const now = Date.now()
        if (!isKey || now - this.fitKeyAt < 1000 / FIT_KEYS_PER_S) return
        this.fitKeyAt = now
      }
      if (!this.xcode) {
        this.xcode = makeTranscoder({
          inCodec: codec,
          ...PLAYBACK_LIMITS,
          // asked each time an ffmpeg starts (a change of speed starts another)
          lowDelay: () => this.speed > 1,
          picturesPerS: () => (this.speed > 1 ? FIT_KEYS_PER_S : 0),
          onFrame: (t, key, out) => {
            this.xout++
            if (this.hold) this.hold.last = Date.now() // (it is working: #heldPace waits on)
            this.#sendConverted(t, key, out)
          },
          onFail: (e) => this.send({ type: 'error', message: `Could not convert this recording (${e.message}).` }),
          log: (l) => log(`[${nvr.id}] playback ch${this.ch + 1}: ${l}`)
        })
        log(`[${nvr.id}] playback ch${this.ch + 1}: converting the NVR's main stream for a remote viewer, at most ${PLAYBACK_LIMITS.maxWidth} wide and ${PLAYBACK_LIMITS.maxKbps} kbit/s`)
      }
      // a converter starts on this frame, playing every frame: the pacer waits for it (#heldPace)
      if (this.xin === 0 && !keysOnly) this.hold = { last: Date.now(), extra: 0 }
      this.xin++
      this.lastIn = ts
      this.xcode.push(ts, isKey, msg.subarray(16))
      if (keysOnly) this.xcode.endPicture()
    }

    /** A converted picture, in the wire format and at the capture time of the frame it was made from. */
    #sendConverted(t, isKey, out) {
      if (this.closed || this.ws.readyState !== this.ws.OPEN) return
      const m = Buffer.allocUnsafe(16 + out.length)
      m.writeUInt8(isKey ? 1 : 0, 0)
      m.writeUInt8(X_H264, 1)
      m.writeUInt16LE(0, 2)
      m.writeUInt16LE(0, 4)
      m.writeUInt16LE(0, 6)
      m.writeBigInt64LE(BigInt(Math.round(t * 1000)), 8)
      out.copy(m, 16)
      this.ws.send(m)
    }

    #deliver(item) {
      const { msg, codec, ts } = item
      if (this.ws.readyState !== this.ws.OPEN) return
      if (this.fit && this.mainStream) {
        if (!this.fitAsked && (msg[0] & 1) === 1) this.#fitDecide(codec)
        if (this.fitOn) return this.#fitPush(item)
      }
      if (this.clientH265 || codec !== X_H265) return this.ws.send(msg)
      if (!this.xcode) {
        const pool = this.mainStream ? mainPool : lightPool // an SD stream is cheap: its own, larger cap
        this.slot = pool.acquire()
        if (!this.slot) {
          this.send({ type: 'error', message: `This recording is H.265 and the server is already converting ${pool.max} for other viewers. Try again in a moment.` })
          return this.close()
        }
        this.xcode = makeTranscoder({
          inCodec: X_H265,
          onFrame: (t, isKey, out) => this.#sendConverted(t, isKey, out),
          onFail: (e) => this.send({ type: 'error', message: `Could not convert this H.265 recording (${e.message}).` }),
          log: (l) => log(`[${nvr.id}] playback ch${this.ch + 1}: ${l}`)
        })
        log(`[${nvr.id}] playback ch${this.ch + 1}: converting the NVR's H.265 to H.264 for this browser`)
      }
      this.xcode.push(ts, (msg[0] & 1) === 1, msg.subarray(16))
    }

    /** Pauses or resumes the NVR: it runs unless the viewer paused, the link is backed up or the buffer is full. */
    async #updateNvr() {
      const run = !this.paused && !this.throttled && !this.buffered
      if (run === this.nvrRunning) return
      this.nvrRunning = run
      if (!run) return this.#control(PLAYCTRL.PAUSE)
      // the NVR plays again once it has taken the RESUME, which can wait its turn in the NVR's lane (the
      // camera wall resumes every tile at once): until then #watch counts nothing as playing
      this.resuming++
      try {
        await this.#control(PLAYCTRL.RESUME)
        // RESUME plays at normal speed whatever the session was doing before the pause: a session at
        // 4x that had been paused (by the viewer, or by this end because the link or the buffer was
        // full) came back at 1x, and the pacer, which releases at 4x, simply ran dry. Measured on the
        // camera wall on 2026-10-07: tiles paused and then played at 4x received about 1x. The speed
        // is asked for again (and one changed while it was paused is asked for here, for the first time).
        if (this.speed !== 1) await this.#control(PLAYCTRL.FF, SPEED_CODE[this.speed] ?? 0)
      } finally {
        this.resuming--
      }
      this.lastFrameAt = Date.now()
      // playing again before any frame came (opened paused, then played): the 4 s for an SD
      // picture start again, rather than having run out while nothing could come
      if (!this.gotFrames) this.sdWait.restart()
    }

    async #control(code, value = 0) {
      if (this.handle <= 0) return false
      const handle = this.handle
      return op(() => call(PlayBackControl, handle, code, value, [0]), PRIORITY.HIGH).catch(() => false)
    }

    async #onCommand(text) {
      let cmd
      try {
        cmd = JSON.parse(text)
      } catch {
        return
      }
      // JSON, but not a command: null, a number, a string or true parse without error, and `in` throws
      // on every one of them (as rec-playback.mjs and live-mux.mjs check before they look inside)
      if (!cmd || typeof cmd !== 'object') return
      if ('speed' in cmd) {
        const speed = [1, 2, 4, 8].includes(cmd.speed) ? cmd.speed : 1 // 16x/32x are for scanning
        // keep the play position, continue at the new rate
        if (this.anchor) {
          const now = Date.now()
          this.anchor = { wall: now, media: this.anchor.media + (now - this.anchor.wall) * this.speed }
        }
        if (this.fit && speed !== this.speed) {
          // fitted: another converter from the next keyframe (every frame at 1x, keyframes only faster;
          // the frames up to it are not shown). Sent as it is: decided again there, at the new speed.
          if (this.fitOn) this.fitKey = true
          else this.fitAsked = false
          this.hold = null
        }
        this.speed = speed
        // (while the NVR is paused nothing is sent: a speed command there can set it playing behind a
        // session that believes it paused; #updateNvr asks for the speed when it resumes)
        if (this.nvrRunning) await this.#control(speed === 1 ? PLAYCTRL.NORMAL : PLAYCTRL.FF, SPEED_CODE[speed] ?? 0)
      }
      if ('pause' in cmd) {
        this.paused = Boolean(cmd.pause)
        this.anchor = null // resume from the next buffered frame
        if (this.hold) this.hold.last = Date.now() // (a converter's start is not timed through a pause)
        await this.#updateNvr()
      }
    }

    async #watch() {
      if (this.closed || this.handle <= 0) return
      // no SD frame yet, counted only while the NVR really plays this session (hd-only.mjs SdWait: not
      // before it has started, not while it is paused or a RESUME waits in the lane): after
      // SD_FALLBACK_MS over to main for a viewer who may see main, asked now; anyone else is refused
      // after SD_REFUSE_MS on a camera marked HD only, and elsewhere gets "end" below, as for any
      // stretch without footage (noSdAction)
      const running = this.openedAt > 0 && this.nvrRunning && !this.resuming && !this.paused
      if (!this.gotFrames && !this.mainStream && this.sdWait.tick(Date.now(), running)) {
        const act = noSdAction({ waitedMs: this.sdWait.ms, mayMain: askMain(this.allowMain), marked: hdOnly.has(this.ch) })
        if (act === 'switch') return this.#switchToMain()
        if (act === 'refuse') return this.#refuseHd()
      }
      // flow control: pause the NVR while the viewer's connection is backed up
      const queued = this.ws.bufferedAmount
      if (!this.throttled && queued > PAUSE_ABOVE) {
        this.throttled = true
        await this.#updateNvr()
      } else if (this.throttled && queued < RESUME_BELOW) {
        this.throttled = false
        await this.#updateNvr()
      }
      // judged only while the NVR really plays: not before the session (or its main stream, after a
      // switch) has started, which can take longer than 8 s on a busy NVR, nor while a RESUME waits
      if (this.openedAt > 0 && this.nvrRunning && !this.resuming && this.queue.length === 0 && Date.now() - this.lastFrameAt > IDLE_END_MS) {
        // F8: an NVR not answering (an overdue SDK call to it, or the SDK stuck on another) looks the
        // same here as the end of the footage -- silence. Those NVRs stalled when many streams opened,
        // and the page took "end" as the end: it seeked away or said "End of recordings". End only at a
        // real end; while the NVR is stalled, say so once and wait for a frame or a true end.
        if (nvrStalled()) {
          if (!this.nvrStalledSaid) {
            this.nvrStalledSaid = true
            this.send({ type: 'notice', waiting: true, message: 'The NVR is not answering; still trying to play this recording.' })
            log(`[${nvr.id}] playback ch${this.ch + 1}: no frames for ${Math.round((Date.now() - this.lastFrameAt) / 1000)} s, but the NVR has an overdue call: not an end, waiting`)
          }
          // leave lastFrameAt where it is: keep waiting, do not re-tick the 8 s
        } else {
          this.send({ type: 'end' })
          this.lastFrameAt = Date.now()
        }
      }
    }

    /**
     * No SD frame came, and this viewer may not see main: said, and the session ends. `message`: the words
     * (by default that no SD recording came: noSdAction's refusal, on a camera marked HD only).
     */
    #refuseHd(message = HD_ONLY_MESSAGE) {
      console.log(`[${nvr.id}] playback ch${this.ch + 1}: no SD recording came, and main is not allowed for this viewer`)
      this.send({ type: 'error', message })
      this.close()
      this.ws.close(1008, HD_NOT_ALLOWED)
    }

    /** Restarts this playback on the main (HD) stream from the same point. */
    async #switchToMain() {
      const old = this.handle
      this.handle = 0
      this.mainStream = true
      // marked HD-only once main frames have come (#onFrame): a switch alone proves nothing
      this.markOnFrames = true
      this.openedAt = 0 // not started again until the main stream is open (#watch judges nothing before)
      this.sdWait.restart()
      playFrames.release(old)
      await op(() => call(StopPlayBack, old), PRIORITY.HIGH).catch(() => {})
      this.queue = []
      this.anchor = null
      this.buffered = false
      this.nvrRunning = true
      this.xcode?.reset()
      this.hold = null
      if (this.closed) return this.#unregister()
      // asked again now: the right may have gone while the NVR stopped the SD playback, and the sweep
      // then still saw this socket on the sub-stream (which needs Playback SD alone). Said as what it is,
      // HD needing the right: the camera need not be marked HD only, where no frame is no footage (and
      // on the camera wall the words stay on the tile)
      if (!askMain(this.allowMain)) {
        this.#refuseHd(HD_ASK_MESSAGE)
        return this.#unregister() // (the SD playback is stopped already: only its login is left)
      }
      console.log(`[${nvr.id}] playback ch${this.ch + 1}: no SD recording, switching to HD`)
      // watched for the main-stream rights from now on, and audited (rec-playback.mjs, server.mjs)
      try {
        this.onMain()
      } catch (e) {
        console.warn(`[${nvr.id}] playback ch${this.ch + 1}: ${e.message}`)
      }
      this.send({ type: 'stream', stream: 0 })
      await this.#open()
    }

    #release() {
      if (this.released) return
      this.released = true
      const handle = this.handle
      this.handle = -1
      this.lateCallback = false
      if (handle > 0) {
        playFrames.release(handle)
        op(() => call(StopPlayBack, handle), PRIORITY.HIGH)
          .catch(() => {})
          .finally(() => this.#unregister())
      } else if (!this.starting) {
        // (a PlayBackByTimeEx still running natively frees the login from its late handler)
        this.#unregister()
      }
    }

    #unregister() {
      if (this.unregistered) return
      this.unregistered = true
      this.lease?.release()
    }

    close() {
      if (this.closed) return
      this.closed = true
      clearInterval(this.timer)
      clearInterval(this.pacer)
      this.queue = []
      this.xcode?.close()
      this.xcode = null
      this.slot?.release()
      this.slot = null
      sessions.delete(this)
      // if PlayBackByTimeEx is still in flight, #open() releases once it returns;
      // if SetPlayDataCallBack is stuck with the handle, its late handler does
      if (this.handle !== 0 && !this.lateCallback) this.#release()
    }
  }

  /**
   * Handles a /playback WebSocket for the NVR's recordings. Which stream was decided by the caller
   * (rec-playback.mjs connectPlayback for a viewer, rec-fallback.mjs for legs and backfill): main
   * asks the NVR for its main stream; allowMain() says whether this viewer may see main pictures,
   * asked for a camera known to record in HD only and again whenever no SD comes (a right taken away
   * meanwhile counts); onMain() is told when the session goes over to main; fit: the viewer is remote
   * and a main stream is fitted to the link (PlaybackSession's `fit`; null on the local network). The
   * URL's own stream parameter is not read: one decision, made once, by the side that knows the rights.
   * @returns {{ main: boolean } | null} what it plays; null when refused (bad parameters: the socket
   *   is closing)
   */
  const connect = (ws, url, { main, allowMain = () => false, onMain = () => {}, fit = null } = {}) => {
    const ch = Number(url.searchParams.get('ch'))
    const start = Number(url.searchParams.get('start'))
    if (!Number.isInteger(ch) || ch < 0 || typeof main !== 'boolean' || !Number.isFinite(start)) {
      ws.close(1008, 'bad parameters')
      return null
    }
    // A camera known to record in HD only goes to main at once for a viewer who may see main. Anyone
    // else is tried on SD all the same: a mark can be wrong (a slow NVR), an SD frame clears it
    // (#onFrame), and with none after SD_REFUSE_MS of playing the session is refused (#watch)
    const asMain = main || (hdOnly.has(ch) && askMain(allowMain))
    if (asMain && !main) ws.send(JSON.stringify({ type: 'stream', stream: 0 }))
    new PlaybackSession(ws, ch, asMain, start, clientCanDecodeH265(url.searchParams), { allowMain, onMain, fit })
    return { main: asMain }
  }

  /** The NVR is reconnecting or was removed: end every playback and tell its viewer. */
  const stopAll = (reason = 'NVR reconnecting') => {
    for (const s of [...sessions]) {
      s.send({ type: 'error', message: `${reason}. Press play to try again.` })
      s.close()
      s.ws.close(1011, reason)
    }
  }

  return {
    nvrNow,
    clock,
    lastClock,
    recordDates,
    recordings,
    connect,
    stopAll,
    isHdOnly: (ch) => hdOnly.has(ch),
    markHdOnly: (ch) => hdOnly.mark(ch)
  }
}

/**
 * GET /api/playback/now, /dates and /recordings for one NVR (undefined: no such NVR).
 * @returns {Promise<[number, object, object?]>} status, body and extra headers
 */
export async function playbackApi(nvr, pathname, params) {
  if (!nvr) return [404, { error: 'Unknown NVR' }]
  if (!nvr.online) return [503, { error: `${nvr.name} is offline` }]
  const playback = nvr.playback
  try {
    if (pathname === '/api/playback/now') return [200, await playback.clock()]
    if (pathname === '/api/playback/dates') return [200, await playback.recordDates()]
    if (pathname === '/api/playback/recordings') {
      const ch = Number(params.get('ch'))
      const date = params.get('date') ?? ''
      if (!Number.isInteger(ch) || ch < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return [400, { error: 'ch and date=YYYY-MM-DD required' }]
      }
      return [200, await playback.recordings(ch, date)]
    }
    return [404, { error: 'Not found' }]
  } catch (e) {
    if (e instanceof NvrBusy) return [503, { error: e.message, retryAfterS: e.retryAfterS }, { 'retry-after': String(e.retryAfterS) }]
    return [502, { error: `NVR: ${e.message}` }]
  }
}

// for the tests: replace the recording-date search, e.g. with calls that never come back and a short
// timeoutMs (null puts the real one back)
export const _test = {
  setDateCalls(calls) {
    dateCalls = calls ? { ...REAL_DATE_CALLS, ...calls } : REAL_DATE_CALLS
  },
  // the same for the recorded-file search and the clock read: { GetDeviceTime, FindFile,
  // FindNextFile, FindClose, timeoutMs }, each a stand-in with .async(...args, cb) (null: the real ones)
  setSearchCalls(calls) {
    searchCalls = calls ? { ...REAL_SEARCH_CALLS, ...calls } : REAL_SEARCH_CALLS
  }
}
