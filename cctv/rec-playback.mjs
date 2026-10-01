// Playback from the server's own recordings over the /playback WebSocket (phase 3).
//
// connectPlayback() decides per socket where playback comes from, and at which quality:
//  - without src=auto: the NVR's own recordings (playback.mjs PlaybackSession, NVR clock), for a viewer
//    who may play them back (rights.mjs playback-nvr; anyone else is closed 1008 "not allowed":
//    playback-server alone never reaches the NVR). Its main stream (stream=0, or a camera the NVR
//    keeps only in HD) is full quality: it also needs Live HD or Playback HD on the camera (mayHd),
//    else {type:'error'} and 1008 "hd not allowed". The stream is read once here (stream-param.mjs)
//    and handed to playback.mjs, which no longer reads it from the URL.
//  - with src=auto: the server's recordings (a ServerPlayback), when CCTV_LIVE_WORKER=on (an index),
//    the viewer may (rights.mjs playback-server; else {type:'error'} and 1008 "not allowed") and the
//    camera has recordings (else {type:'error'} and 1011): never a silent NVR session in another time
//    base (R15). Server playback does not need the NVR: it runs while the NVR is offline (R14). Its
//    gaps are filled from the NVR (legs, below) only for a viewer who may also play the NVR back.
//  What it decided comes back with the rights to watch while it plays (server.mjs, access-watch.mjs).
//
// ServerPlayback reads the segment files directly (rec-reader.mjs; read-only, one read in flight,
// at most 4 MB per read call) and sends the frames exactly as stored, in the /live wire format
// (encodeDiskFrame: width and height 0, the browser takes the size from the SPS). All times are the
// server's clock (the recorder's arrival stamps). Pacing is done here, as playback.mjs does it for
// the NVR: frames are queued and released at their media time x speed, every tickMs.
//  - Start and seek: the frames from the keyframe at or before T are queued and the pacer is anchored
//    at T, so the frames before T go out at once (the preroll; the browser decodes them without
//    showing them), then the rest in time.
//  - 1x, 2x, 4x: every frame, except that 2x and 4x are keyframes only while the frames are converted
//    (H.265 for a browser that cannot decode it, below: the conversion keeps up with 1x and not much
//    more). 8x-32x and every reverse speed: keyframes only, skipped evenly so that
//    consecutive ones are about |speed| x 1000 / maxKeysPerS ms of footage apart, and never more than
//    maxKeysPerS a second of wall time (the pacer holds them back). With a longer GOP every keyframe
//    goes, at its media time: |speed| x 1000 / GOP (ms) of them a second. Reverse walks the keyframes back,
//    file by file, to the camera's first recording ({type:'end', reverse:true}).
//  - Reverse and scrubbing put the browser in "stills" mode ({type:'mode', stills}).
//  - A speed change keeps the position: within 1-4x the pacer is re-anchored; otherwise the queue is
//    dropped and the reader restarts at the position in the new mode (key to all frames: at the next
//    keyframe at or after it, so no preroll is needed).
//  - Seek {seek:T, gen} and scrub {scrub:T, gen} work on the open socket. A generation number
//    announced by {type:'started'} or {type:'scrub'} comes before the frames that belong to it; the
//    browser drops frames of older generations. A scrub sends the keyframe at or before T and
//    pauses; only the newest scrub is answered.
//  - Files: at the end of one the next one follows (index.next) without a message. A gap of
//    noticeGapMs or more is played from the NVR when it has it (below), else it is jumped with a
//    {type:'notice'} when playback reaches it.
//  - NVR legs (R7, rec-fallback.mjs; `legs`, null: none): stretches of noticeGapMs (30 s) or more
//    without server footage play from the NVR when its coverage (a cached search) has them: at a
//    start or seek in such a stretch ({type:'started', src:'nvr'}), and at a hole between two files
//    or inside one ({type:'source', src:'nvr', from, to}). The leg is the NVR's own playback session with its clock
//    converted to the server's; it ends where the server's footage starts again, and playback goes
//    on from disk with {type:'source', src:'server'} (a start whose NVR playback never began gets its
//    {type:'started'} from the server after all, after a notice). During a leg the pacer is idle and
//    the reader has already read the next file's first GOP, so the switch back is instant. The
//    coverage of a hole is asked for once the reader is within prefetchMs of it; the pacer waits at
//    the hole at most legWaitMs for the answer. Legs run forward only, at 1x-4x when they start, at
//    most 8x (16x/32x during a leg run at 8x). Reverse, scrub and keyframe speeds never start one; a
//    seek, scrub or reverse closes the leg first. An NVR that is offline, busy or failing: the
//    stretch is jumped with a notice that says why.
//  - Gaps: a hole between two files (the end of the one before to the start of the one after, index
//    times), or inside one file where the NVR stalled and the writer carried on in the same file
//    (rec-reader holeAfter: the GOP before it keeps its frame step, from its last frame to the next
//    keyframe). Over gapMs, the reader marks the first item it queues after the hole (gapBefore) and
//    the pacer jumps to that item; noticeGapMs or more also gets an NVR leg or a notice (above).
//    Nothing else is taken for a gap: every other frame and keyframe goes out at its media time,
//    however far apart (a long GOP in keyframe mode, keyframes-only footage at 1x). Holes inside a
//    file are found at 1x-4x only: keyframe modes do not split GOPs, so there such a hole plays at
//    its media time, like a long GOP.
//  - The open file (the one being written, rec-index noteOpen) is followed: refreshed every
//    tailPollMs; once it is closed (noteClosed) the next file follows. Reaching the newest frame
//    faster than 1x drops to 1x ({type:'speed', speed:1, reason:'newest'}).
//  - A file that cannot be opened (ENOENT: deleted by housekeeping, EACCES) is skipped (logged once),
//    and so is an empty one (closed, no keyframe on disk): its span plays as a hole, notice and all.
//    Any other failure sends {type:'error'} and closes the socket (1011 'playback failed'); it never
//    throws. The store itself failing (EIO and the like: the NAS share down) is said in words, and
//    the page then plays the NVR's copy (public/playback.js).
//  - Flow control: reading stops while the socket has more than pauseAbove bytes queued and starts
//    again below resumeBelow; at most readAheadMs x |speed| of footage and maxQueueBytes are queued.
//  - H.265 for a browser that cannot decode it (&h265=0 on the URL, transcode.mjs): the frames go
//    through ffmpeg and H.264 goes out instead, in this same wire format and with the same times, so
//    the page needs no new decoding path, at most 1920 wide and 2.5 Mbit/s (PLAYBACK_LIMITS; keyframes
//    only, 2.5 Mbit/s of wall clock at maxKeysPerS pictures a second, not per camera frame). Only
//    that parameter switches it on, so a browser that can decode H.265 always gets the recording
//    itself. At most CCTV_TRANSCODE_MAX (2) of these run at
//    once; over that the viewer is told plainly and the socket closes, rather than joining a queue.
//    The ffmpeg is killed on close, on error and on every seek: recording always wins. NVR legs are
//    told the same (h265), so the NVR's own playback is converted for this browser too.
//  - A converter's start, playing every frame (the playback hunt of 1 Oct 2026, finding F3): ffmpeg's
//    first picture comes 0.5-1.4 s after its first frame went in (the journal: first frame 524-1410 ms
//    over 14 sessions), and it then works off what it was handed meanwhile at 25-45 pictures a second.
//    The pacer went on at 1x from the start point all the same, so those seconds reached the page
//    faster than they play (traced: 14, 30, 31, 20 frames a second), up to 0.9 s ahead of the clock
//    its player had set on the first frame: a skip and a freeze of 0.3-1.6 s some 3-4 s after the first
//    picture, at every start and every jump. So where a converter starts (a start or seek, back to 1x
//    from keyframes, a change of codec between two files) the pacer hands it what is due (the frames
//    up to the start point) and CONVERTER_HOLDS frames more, which ffmpeg needs before it gives a
//    picture back, and then stops its clock until the converter has given back all but that many:
//    the converted frame at the start point is out. The clock goes on from the last frame handed in,
//    and the preroll ends there. The start is no faster for it; it is even. A converter silent for
//    convertWaitMs (3 s) is not waited for any longer. One picture at a time (a scrub, keyframes
//    only) never waits, and neither does a frame that is not converted.
//  - A remote viewer (`remote`: server.mjs asks adaptive-live.mjs isRemoteAddress of the socket, the
//    rule live view uses; the Cloudflare tunnel arrives from 127.0.0.1): one tunnel connection
//    carried 3.5-6.5 Mbit/s, and a 4.2 Mbit/s main stream through it froze 22 times a minute
//    (smoothness report, cause 3). So a recording over the cap (2.5 Mbit/s by the index, times the
//    speed; keyframe speeds always) goes, every frame, H.264 or H.265, through the same conversion
//    within PLAYBACK_LIMITS (measured on three 3.7-5.2 Mbit/s recordings: 2.2-2.5 Mbit/s) while a
//    slot is free besides the last one ({type:'fit', on:true}); one within it is sent as it is
//    ({type:'fit', on:false, fits:true}), until a faster speed takes it over the cap. This is decided
//    at the first file of each run (a start, a seek, a restart in another mode), so it falls on a
//    keyframe and before the run picks its mode. The last free slot is left for H.265 a browser
//    cannot decode (here or in NVR playback, the same pool), which has no alternative: without one to
//    spare the run sends the recording itself, as before, rather than refusing ({type:'fit',
//    on:false, busy:true}), and the next jump asks again.
//    &original=1 (the page's "Original (server)"; the camera wall's tiles) is the recording itself:
//    never converted, unless it is H.265 for a browser that cannot decode it. The local network is
//    not touched.
//  - Parsed files are kept per session (an LRU of 64 open readers, closed after 60 s unused), so
//    scrubbing and seeking back and forth do not read an .idx twice.
import * as fsp from 'node:fs/promises'
import { canPlayNvr, canPlayServer, mayHd } from './rights.mjs'
import { HD_ASK_MESSAGE, HD_NOT_ALLOWED, MAIN, streamParam } from './stream-param.mjs'
import { audit } from './audit.mjs'
import { DATA_DIR } from './auth.mjs'
import { nvrLegs } from './rec-fallback.mjs'
import { SegmentReader, keyAtOrAfter, keyAtOrBefore } from './rec-reader.mjs'
import { CODEC_H264, DECODE_THREADS, PLAYBACK_LIMITS, Transcoder, clientCanDecodeH265, pool as transcodePool, wantsTranscode } from './transcode.mjs'

// ---- read-ahead: the next file of a playback, read once in the background ----
// When playback opens a file, the one after it is read through (1 MB at a time into one reused
// buffer, nothing kept) so the operating system has it cached by the time playback -- or a jump
// forward -- gets there: from memory instead of from the disk or the share. Each file at most once.
const aheadDone = new Set()
let aheadBusy = false
const aheadBuf = Buffer.allocUnsafe(1024 * 1024)
async function readAhead(path) {
  if (!path || aheadBusy || aheadDone.has(path)) return
  aheadBusy = true
  aheadDone.add(path)
  if (aheadDone.size > 500) aheadDone.delete(aheadDone.values().next().value)
  let fh
  try {
    fh = await fsp.open(path, 'r')
    for (;;) {
      const { bytesRead } = await fh.read(aheadBuf, 0, aheadBuf.length, null)
      if (bytesRead < aheadBuf.length) break
    }
  } catch {} finally {
    await fh?.close().catch(() => {})
    aheadBusy = false
  }
}

export const HEADER_SIZE = 16
/** Speeds a server playback accepts (R9). */
export const SPEEDS = Object.freeze([-32, -16, -8, -4, -2, -1, 1, 2, 4, 8, 16, 32])
const MB = 1024 * 1024
const READERS_MAX = 64 // parsed files kept per session
const READER_IDLE_MS = 60_000 // a kept file unused this long is closed
// Keyframes are picked at least this share of the spacing apart: the smoothed key times of a file
// lie on a line whose step can be a little under the GOP (1999 ms for 2 s), which must not halve
// the rate. The wall-time limit in the pacer still holds.
const KEY_SPACING_SLACK = 0.9
const SKIP_CODES = new Set(['ENOENT', 'EACCES'])
// The store itself failing (the NAS share down or unreachable; it is mounted soft, so a stuck read ends
// in one of these after a few minutes). Not skipped like a missing file: that would not cover a read
// failing mid-file, would call footage that exists "not recorded", and in a full outage would try
// file after file, each one hanging. The session ends (#fail) with this said in words rather than
// "EIO: i/o error, read", and the page plays the NVR's copy instead (playback.js).
const STORE_CODES = new Set(['EIO', 'ETIMEDOUT', 'EHOSTDOWN', 'EHOSTUNREACH', 'ESTALE', 'ENOTCONN'])
const STORE_FAILED = 'The recording store could not be read (network storage problem)'
/** NVR fallback legs (rec-fallback.mjs): { coverage(nvr, ch, fromMs, toMs), start(opts) }; null: gaps are jumped. */
const defaultLegs = nvrLegs
// NVR coverage shorter than this is clock jitter at the edge of server footage, not a stretch to play
const COVER_MIN_MS = 2000
const LEG_MAX_SPEED = 8 // NVR sessions play at most 8x
/**
 * The pictures a conversion playing forward keeps inside until more go in: one in ffmpeg's parser (a
 * picture is whole only when the next begins), one in each decoder thread past the first
 * (transcode.mjs DECODE_THREADS), and the last one out, which the Transcoder holds until the next
 * proves it whole. Handed four frames it gives the first back; handed fewer, nothing.
 */
const CONVERTER_HOLDS = DECODE_THREADS + 1

/** A leg that could not be started at all. */
const failedLeg = (e) => ({
  done: Promise.resolve({ reason: 'error', message: e?.message ?? String(e), frames: 0, lastTs: null, announced: false }),
  command() {},
  close() {},
  announced: false,
  frames: 0,
  lastTs: null
})
const isoOf = (ms) => (Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : String(ms))

/** One frame from disk in the /live wire format (server.mjs), width and height 0, ts in µs. */
export function encodeDiskFrame(buf, isKey, codec, tsMs) {
  const msg = Buffer.allocUnsafe(HEADER_SIZE + buf.length)
  msg.writeUInt8(isKey ? 1 : 0, 0)
  msg.writeUInt8(codec, 1)
  msg.writeUInt16LE(0, 2)
  msg.writeUInt16LE(0, 4)
  msg.writeUInt16LE(0, 6)
  msg.writeBigInt64LE(BigInt(Math.round(tsMs * 1000)), 8)
  buf.copy(msg, HEADER_SIZE)
  return msg
}

const sendJson = (ws, obj) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
}

/**
 * One audit row per playback session opened: who looked at recorded footage, which camera, from
 * when, and whether it came off the server or the NVR, and from the NVR at which quality. Kept tiny
 * and wrapped in its own try even though audit() already swallows everything — nothing about
 * recording an event may ever be the reason somebody cannot watch a camera.
 */
const note = (who, nvr, ch, source, start) => {
  try {
    const n = Number(start)
    audit(DATA_DIR, {
      user: who?.user,
      action: 'playback-view',
      target: `${nvr?.id}/${ch}`,
      detail: `${source} playback from ${Number.isFinite(n) ? new Date(n).toISOString() : String(start)}`
    })
  } catch {}
}

/** What an NVR session on the main stream needs while it is open (access-watch.mjs): the NVR's
 * recordings, and a right to see main -- Live HD or Playback HD, either will do. */
export const NVR_MAIN_ACTIONS = Object.freeze(['playback-nvr', Object.freeze(['live-hd', 'playback-server'])])
const NVR_SUB_ACTIONS = Object.freeze(['playback-nvr'])
const SERVER_REFUSAL = 'You may not play back this camera from the server\'s recordings.'

/**
 * Handles a /playback WebSocket: server recordings (src=auto) or the NVR, see the top.
 * @param {{ nvr: object, ws: object, url: URL, who: {user?: string, admin?: boolean}|null,
 *           index: object|null, allowed?: Function, allowedNvr?: Function, allowedMain?: Function,
 *           legs?: object|null, remote?: boolean, onMain?: () => void, opts?: object }} args
 *   index: rec-index.mjs (null: CCTV_LIVE_WORKER off); allowed, allowedNvr, allowedMain: the access
 *   hooks for the server's recordings, the NVR's and a main-stream picture (rights.mjs canPlayServer,
 *   canPlayNvr, mayHd); remote: the viewer is remote (adaptive-live.mjs isRemoteAddress of the socket;
 *   see the top); onMain: an NVR session went over to the main stream by itself (server.mjs watches
 *   it for the main-stream rights from then on); opts: ServerPlayback options (tests)
 * @returns {ServerPlayback|{ source: 'nvr', main: boolean, actions: Array }|null} what it plays, each
 *   with `actions`, the rights it needs while open; null: refused (the socket is closing)
 */
export function connectPlayback({ nvr, ws, url, who, index, allowed = canPlayServer, allowedNvr = canPlayNvr, allowedMain = mayHd, legs = defaultLegs, remote = false, onMain = () => {}, opts = {} }) {
  const p = url.searchParams
  // a check that throws is a no
  const ask = (check, c) => {
    try {
      return Boolean(check(who, nvr.id, c))
    } catch {
      return false
    }
  }
  // The NVR's own recordings are playback-nvr's. server.mjs lets either playback right open the
  // socket, which can serve either source, so each source asks for its own right here: playback-server
  // alone never reaches the NVR, which may still hold days the server has already let go.
  const nvrAllowed = (c) => ask(allowedNvr, c)
  // One reading of `stream` for every decision below (stream-param.mjs): '', '0.0', '-0' and the like
  // were main to Number() while a check on the text would have called them SD.
  const stream = streamParam(p.get('stream'))
  if (p.get('src') !== 'auto') {
    const rawCh = p.get('ch') ?? ''
    if (!/^\d{1,3}$/.test(rawCh) || Number.isNaN(stream)) {
      ws.close(1008, 'bad parameters')
      return null
    }
    const ch = Number(rawCh)
    if (!nvrAllowed(ch)) {
      ws.close(1008, 'not allowed')
      return null
    }
    // The NVR's main stream is full quality: Playback SD and a right to see main (rights.mjs mayHd).
    // Asked again (allowMain) when the session wants to go over to main by itself (playback.mjs: a
    // camera the NVR records in HD only), so a right taken away meanwhile counts.
    const mayMain = () => ask(allowedMain, ch)
    const main = stream === MAIN
    if (main && !mayMain()) {
      sendJson(ws, { type: 'error', message: HD_ASK_MESSAGE })
      ws.close(1008, HD_NOT_ALLOWED)
      return null
    }
    if (!nvr.online) {
      ws.close(1013, 'NVR offline')
      return null
    }
    const start = p.get('start') ?? ''
    const opened = nvr.playback.connect(ws, url, {
      main,
      allowMain: mayMain,
      onMain: () => {
        note(who, nvr, ch, 'nvr main (switched: no SD recording)', start)
        onMain()
      }
    })
    // refused there (bad parameters): the socket is closing, nothing to watch
    if (!opened) return null
    // who looked at recorded footage, when, and at which quality: the row an investigation asks for.
    // audit() never throws, so it cannot break playback.
    note(who, nvr, ch, opened.main ? 'nvr main' : 'nvr sub', start)
    return { source: 'nvr', main: opened.main, actions: opened.main ? NVR_MAIN_ACTIONS : NVR_SUB_ACTIONS }
  }
  const rawCh = p.get('ch') ?? ''
  const rawStart = p.get('start') ?? ''
  const ch = Number(rawCh)
  const start = Number(rawStart)
  if (!/^\d{1,3}$/.test(rawCh) || Number.isNaN(stream) || rawStart === '' || !Number.isFinite(start)) {
    ws.close(1008, 'bad parameters')
    return null
  }
  // a viewer without the right is told so, and closed 1008 like every other refusal of a right (the
  // pages then stop and say why), not 1011 "not available here", which reads as a fault to retry
  if (!ask(allowed, ch)) {
    sendJson(ws, { type: 'error', message: SERVER_REFUSAL })
    ws.close(1008, 'not allowed')
    return null
  }
  let eligible = false
  try {
    eligible = Boolean(index) && index.first(nvr.id, ch) !== null
  } catch (e) {
    console.warn(`[${nvr.id}] server playback ch${ch + 1}: ${e.message}`)
  }
  if (!eligible) {
    sendJson(ws, { type: 'error', message: 'Server recordings are not available here; reload the page.' })
    ws.close(1011, 'server recordings not available')
    return null
  }
  note(who, nvr, ch, 'server', start)
  // The page tells us what it can decode (&h265=0 when canDecodeH265() said no). Nothing else may
  // switch the conversion on, so H.264 can never reach a client that did not ask for it.
  const clientH265 = clientCanDecodeH265(p)
  // gaps are filled from the NVR's recordings only for someone who may play those back; anyone else
  // has them jumped with a notice (#legsAllowed with no legs)
  // a remote viewer who chose "Original (server)": the recording itself, not the capped conversion
  const original = p.get('original') === '1'
  return new ServerPlayback({ ws, nvr, ch, start, stream, index, legs: nvrAllowed(ch) ? legs : null, clientH265, remote: Boolean(remote), original, ...opts })
}

/** HH:MM:SS of a server time, in the NVR's time zone when known (else the server's). */
function clockText(ms, tzOffsetMs) {
  const tz = tzOffsetMs ?? -new Date(ms).getTimezoneOffset() * 60_000
  return new Date(ms + tz).toISOString().slice(11, 19)
}

/**
 * One server playback on one socket (see the top). Everything is injectable for tests.
 * The reader works as a chain of steps, one at a time (so one read in flight). A step belongs to an
 * epoch; a seek, scrub or restart starts a new epoch, and a step of an older one throws its result
 * away when it returns.
 */
export class ServerPlayback {
  /**
   * @param {{ ws: object, nvr: {id: string}, ch: number, start: number, stream?: number, index: object,
   *   legs?: object|null, fs?: object, now?: () => number, tickMs?: number, readAheadMs?: number,
   *   maxQueueBytes?: number, pauseAbove?: number, resumeBelow?: number, gapMs?: number, lagMs?: number,
   *   maxKeysPerS?: number, tailPollMs?: number, endGraceMs?: number, noticeGapMs?: number,
   *   legWaitMs?: number, legSpanMs?: number, prefetchMs?: number, log?: (line: string) => void }} opts
   *   now: a monotonic clock in ms (pacing); gapMs: a hole (between two files or inside one) longer
   *   than this is skipped at once (the reader marks it); lagMs: the pacer re-anchors when it is this far (x |speed|)
   *   ahead of the frames (the reader stalled); endGraceMs: the end of the footage lasts this long
   *   before {type:'end'} (a file closing and the next opening are not an end); noticeGapMs: gaps
   *   this long are announced, or played from the NVR (legs); legWaitMs: the longest wait for the
   *   NVR's coverage; legSpanMs: a start with no server footage after it asks the NVR this far;
   *   prefetchMs: the coverage of a hole is asked for when the reader is this close to it;
   *   clientH265: the browser can decode H.265 (false: its H.265 frames are converted, transcode.mjs);
   *   remote: a remote viewer, whose frames all go through the capped conversion while a slot is
   *   free; original: that viewer asked for the recording itself instead (see the top);
   *   fitAboveKbps: only a recording over this rate is converted for a remote viewer (the cap);
   *   convertWaitMs: a converter that has just started is waited for until it has been silent this
   *   long (see the top);
   *   pool, makeTranscoder: the concurrency cap and the converter, injectable for tests
   */
  constructor({
    ws,
    nvr,
    ch,
    start,
    stream = 0,
    index,
    legs = null,
    fs = fsp,
    now = () => performance.now(),
    tickMs = 15,
    readAheadMs = 3000,
    maxQueueBytes = 16 * MB,
    pauseAbove = 8 * MB,
    resumeBelow = MB,
    gapMs = 3000,
    lagMs = 1000,
    maxKeysPerS = 8,
    tailPollMs = 200,
    endGraceMs = 5000,
    noticeGapMs = 30_000,
    legWaitMs = 5000,
    legSpanMs = 6 * 3_600_000,
    prefetchMs = 10_000,
    clientH265 = true,
    remote = false,
    original = false,
    fitAboveKbps = PLAYBACK_LIMITS.maxKbps,
    convertWaitMs = 3000,
    pool = transcodePool,
    makeTranscoder = (o) => new Transcoder(o),
    log = (line) => console.log(line)
  }) {
    Object.assign(this, { clientH265, pool, makeTranscoder })
    this.xcode = null // the running conversion (H.265 recordings, a browser that cannot decode them)
    this.slot = null // its place under the concurrency cap
    this.converts = false // this viewer's frames are converted (#noteCodec): 2x and 4x are keyframes only
    this.convertWaitMs = convertWaitMs
    this.xin = 0 // frames handed to the converter since it last started, and pictures it has given back
    this.xout = 0
    this.hold = null // { last, extra }: the pacer is waiting for a converter that has just started (#heldPace)
    // a remote viewer's frames all go through the conversion, capped for the tunnel (see the top)
    this.fit = Boolean(remote) && !original
    this.fitAboveKbps = fitAboveKbps
    this.fitOn = false // they do: a slot was had at a run's first file (kept for the session, as the slot is)
    this.fitAsked = false // this run has decided (at its first file): the next jump decides again
    this.fitFits = null // this run is sent as it is because it fitted: the recording's 1x rate (kbit/s)
    Object.assign(this, { ws, nvr, ch, start, index, legs, fs, now, readAheadMs, maxQueueBytes, pauseAbove, resumeBelow, gapMs, lagMs, maxKeysPerS, tailPollMs, endGraceMs, noticeGapMs, legWaitMs, legSpanMs, prefetchMs, log })
    this.leg = null // { handle, gen, fromMs, toMs, keyMode }: an NVR leg is playing (the pacer is idle)
    this.closed = false
    this.speed = 1
    this.paused = false
    this.gen = 0
    this.epoch = 0
    this.#newEpochAbort()
    this.busy = false // a step is running
    // { ts, buf, isKey, codec } frames, { ts, text } messages and { ts, legAt } NVR legs planned at a
    // hole, in play order; gapBefore: the first item after a hole
    this.queue = []
    this.queueBytes = 0
    this.gapPending = false // the reader moved past a hole: the next item queued gets gapBefore
    this.anchor = null // { wall, media }: media time `media` is due at wall time `wall`
    this.startAt = null // the first anchor's media time (a seek target: earlier frames are the preroll)
    this.preroll = null // while frames before this time are going out
    this.lastTs = null // the last frame sent
    this.lastQueuedTs = null
    this.lastKeyWall = -Infinity
    this.posRef = start // the position when nothing has been sent yet
    this.stills = false
    this.throttled = false
    this.atEnd = false // forward: no footage after the reader's position (yet)
    this.atEndSince = 0
    this.revEnd = false // reverse: at the camera's first recording
    this.endSent = false
    this.readers = new Map() // path -> SegmentReader, least recently used first
    this.skipLogged = false
    this.lastIdleCheck = 0
    this.t0 = now()
    this.timing = { index: null, idx: null, first: null }
    // cursor: { phase: 'start'|'resume'|'scrub'|'play'|'scrubbed'|'end', ... }
    this.cur = { phase: 'start', t: start, gen: 0 }
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.#onCommand(String(data))
    })
    ws.on('close', () => this.close())
    if (stream !== 0) this.#send({ type: 'stream', stream: 0 }) // server footage is the main stream (R17)
    // (the page offers "Original (server)" only to a viewer the server calls remote: this says so)
    if (remote && original) this.#send({ type: 'fit', on: false, original: true })
    this.pacer = setInterval(() => this.#pace(), tickMs)
    this.#fill()
  }

  /** The rights this session needs while it is open (access-watch.mjs): the server's recordings, and
   * the NVR's as well when its gaps are filled from there. */
  get actions() {
    return this.legs ? ['playback-server', 'playback-nvr'] : ['playback-server']
  }

  #send(obj) {
    sendJson(this.ws, obj)
  }

  /**
   * Keyframes only: reverse, 8x and up, and 2x and 4x while this viewer's frames are converted. The
   * conversion keeps up with 1x and not much more (4K at 1920 wide: 1.2-1.3x), so at 2x and 4x half
   * the frames or fewer arrived, in stutters (smoothness report, cause 2c): keyframes are a steady
   * slideshow instead.
   */
  #keyMode() {
    return this.speed < 0 || this.speed >= 8 || (this.speed > 1 && this.converts)
  }

  /**
   * Called for every file opened: the first one this viewer's browser cannot decode (H.265 with
   * &h265=0) makes the session a converting one for good, as the conversion itself is. It is known
   * here, before a start or restart picks its mode, so a start at 2x is keyframes only from its first
   * frame rather than switching once the first converted frame has gone out. A remote viewer's run
   * is decided here too, at its first file (#fitRun).
   */
  #noteCodec(codec, seg) {
    if (!this.converts && wantsTranscode({ clientH265: this.clientH265, codec })) this.converts = true
    if (this.fit && !this.fitOn && !this.fitAsked) {
      this.fitAsked = true
      this.#fitRun(seg, codec)
    }
  }

  /**
   * A remote viewer's run, decided at its first file: a start, a seek or a restart in another mode
   * each begin at a keyframe with nothing queued, and the run's mode is picked after this (2x and 4x
   * are keyframes only when converting). Never in the middle of a run: the converter would begin at
   * the next keyframe and the frames queued before it would be lost.
   *  - A recording within the cap (fitAboveKbps, the index's rate times the speed) is sent as it
   *    is: converted, a 2.2 Mbit/s camera came out at 2.15 with a busier second than before (3.74
   *    against 3.35 Mbit), for a slot and 0.74 of a core; half the H.264 cameras record under 0.75
   *    Mbit/s. Not at keyframe speeds (reverse, 8x-32x): up to maxKeysPerS keyframes a second, of
   *    which the 1x rate says nothing (the conversion holds them to the cap per second, picturesPerS).
   *  - Otherwise a slot: kept for the session, as for a browser without H.265 (one that H.265 took
   *    meanwhile serves here too). Never the last free one (keepFree): this conversion has an
   *    alternative, and H.265 for a browser that cannot decode it has none, here or in NVR playback
   *    (the same pool); two remote viewers over the cap would otherwise turn the site PC's H.265
   *    playback into a refusal. Unless this file is such H.265 itself, which needs the slot anyway.
   *    None to spare: this run sends the recording itself, as before, since a stuttering picture
   *    beats a refusal.
   * Either way the next jump decides again (#reset), and so does a faster speed that takes a run
   * sent as it is over the cap (#setSpeed).
   */
  #fitRun(seg, codec) {
    // A closed session must never take a slot: close() has run and will not run again to give it
    // back. (#openSeg already stops a run that went stale while its file opened; this is the guard
    // at the slot itself.)
    if (this.closed) return
    const kbps = this.#recordedKbps(seg)
    const keys = this.speed < 0 || this.speed >= 8
    if (!keys && kbps !== null && kbps * Math.abs(this.speed) <= this.fitAboveKbps) {
      this.fitFits = kbps
      this.#send({ type: 'fit', on: false, fits: true })
      return
    }
    const needed = wantsTranscode({ clientH265: this.clientH265, codec })
    this.slot ??= this.pool.acquire({ keepFree: needed ? 0 : 1 })
    if (this.slot) {
      this.fitOn = true
      this.converts = true
      this.#send({ type: 'fit', on: true })
      return
    }
    const kept = needed ? '' : '; the last is kept for H.265 a browser cannot decode'
    this.log(`[${this.nvr.id}] server playback ch${this.ch + 1}: remote viewer, no conversion to spare (${this.pool.active} of ${this.pool.max} running${kept}): sending the original recording`)
    this.#send({ type: 'fit', on: false, busy: true })
  }

  /**
   * The recording's rate at seg in kbit/s (bits per ms), from the index: its bytes over its span. The
   * file being written has no size there yet, so the one before it stands in. null: not known (then
   * a remote viewer's run is converted).
   */
  #recordedKbps(seg) {
    const rate = (s) => (s?.bytes > 0 && s.endMs > s.startMs ? (s.bytes * 8) / (s.endMs - s.startMs) : null)
    try {
      return rate(seg) ?? rate(this.index.prev(this.nvr.id, this.ch, seg.startMs))
    } catch {
      return null
    }
  }

  /**
   * Whether a frame goes through the conversion: H.265 this browser cannot decode, or any frame for a
   * remote viewer whose run began converted.
   */
  #convertsFrame(codec) {
    return wantsTranscode({ clientH265: this.clientH265, codec }) || this.fitOn
  }

  /**
   * One picture at a time goes to the conversion: a scrub (one keyframe, then paused) and keyframes
   * only. Nothing follows such a picture for a while (a second at 2x), and ffmpeg's parser holds a
   * picture until the next one begins, so each one is ended at once (Transcoder.endPicture).
   */
  #oneAtATime() {
    return this.cur.phase === 'scrub' || this.#keyMode()
  }

  // ---- commands --------------------------------------------------------------------------------

  #onCommand(text) {
    if (this.closed) return
    let cmd
    try {
      cmd = JSON.parse(text)
    } catch {
      return
    }
    if (!cmd || typeof cmd !== 'object') return
    try {
      const gen = Number.isSafeInteger(cmd.gen) ? cmd.gen : this.gen + 1
      if ('seek' in cmd) return this.#seek(Number(cmd.seek), gen)
      if ('scrub' in cmd) return this.#scrub(Number(cmd.scrub), gen)
      if ('speed' in cmd) this.#setSpeed(Number(cmd.speed))
      if ('pause' in cmd) this.#setPaused(Boolean(cmd.pause))
    } catch (e) {
      this.#fail(e)
    }
  }

  /** Drops everything queued, whatever the running step is doing and the NVR leg (closed first). */
  #reset() {
    this.#bumpEpoch()
    this.#closeLeg()
    this.#stopTranscode(false)
    this.queue = []
    this.queueBytes = 0
    this.gapPending = false
    this.anchor = null
    this.startAt = null
    this.preroll = null
    this.lastTs = null
    this.lastQueuedTs = null
    this.lastKeyWall = -Infinity
    this.atEnd = false
    this.revEnd = false
    this.endSent = false
    this.fitAsked = false // a remote viewer's next run decides again (#fitRun)
    this.fitFits = null
  }

  #seek(t, gen) {
    if (!Number.isFinite(t)) return
    this.#reset()
    this.gen = gen
    this.paused = false
    this.posRef = t
    this.cur = { phase: 'start', t, gen }
    this.#updateStills()
    this.#fill()
  }

  #scrub(t, gen) {
    if (!Number.isFinite(t)) return
    this.#reset()
    this.gen = gen
    this.paused = true
    this.posRef = t
    this.cur = { phase: 'scrub', t, gen }
    this.#updateStills()
    this.#fill()
  }

  #setPaused(p) {
    // play after a scrub: from the keyframe shown (the page normally sends {seek})
    if (!p && this.cur.phase === 'scrubbed') return this.#seek(this.cur.t, this.gen)
    if (p === this.paused) return
    this.paused = p
    this.leg?.handle.command({ pause: p })
    if (this.anchor) {
      // resume from the next queued frame
      this.anchor = null
      this.startAt = null
      this.preroll = null
    }
  }

  /** Stills while reversing or scrubbing (the browser shows each frame when decoded). */
  #updateStills() {
    const want = this.speed < 0 || this.cur.phase === 'scrub' || this.cur.phase === 'scrubbed'
    if (want === this.stills) return
    this.stills = want
    this.#send({ type: 'mode', stills: want })
  }

  /** The play position: between the last frame sent and the next one due. */
  #position(now) {
    if (this.leg) return this.leg.handle.lastTs ?? this.leg.fromMs
    if (this.preroll !== null) return this.preroll
    const dir = Math.sign(this.speed)
    let p = this.anchor ? this.anchor.media + (now - this.anchor.wall) * this.speed : (this.lastTs ?? this.posRef)
    if (this.lastTs !== null && dir * (p - this.lastTs) < 0) p = this.lastTs
    const bound = this.queue.find((q) => q.buf)?.ts ?? this.lastTs
    if (bound != null && dir * (p - bound) > 0) p = bound
    return p
  }

  #setSpeed(s, reason = null) {
    if (!SPEEDS.includes(s) || s === this.speed) return
    if (this.leg) return this.#legSpeed(s)
    const now = this.now()
    const media = this.anchor ? this.anchor.media + (now - this.anchor.wall) * this.speed : null
    const P = this.#position(now)
    const wasKey = this.#keyMode()
    this.speed = s
    if (reason) this.#send({ type: 'speed', speed: s, reason })
    this.#updateStills()
    const phase = this.cur.phase
    if (phase === 'scrub' || phase === 'scrubbed' || phase === 'end') return
    if (phase === 'start') {
      // not started yet: start again in the new mode (a remote viewer's run decided again at this speed)
      this.#bumpEpoch()
      this.cur = { ...this.cur }
      this.fitAsked = false
      this.fitFits = null
      return this.#fill()
    }
    // A remote viewer's run sent as it is because it fitted at the old speed, and over the cap at
    // this one (#fitRun): it restarts at the position like a change of mode, and is decided again.
    const outgrown = this.fitFits !== null && this.fitFits * Math.abs(s) > this.fitAboveKbps
    if (!wasKey && !this.#keyMode() && !outgrown) {
      // 1x/2x/4x: the same frames, a new rate from here
      if (this.anchor) this.anchor = { wall: now, media }
      return
    }
    this.#reset()
    this.posRef = P
    this.cur = { phase: 'resume', t: P }
    this.#fill()
  }

  // ---- pacing ----------------------------------------------------------------------------------

  #pace() {
    if (this.closed) return
    const now = this.now()
    // (a converter has just started: the clock stands still until it has caught up)
    if (this.hold) this.#heldPace(now)
    // (idle during an NVR leg: the leg sends its frames itself)
    else if (!this.paused && this.queue.length && !this.leg) {
      const dir = Math.sign(this.speed)
      const keyMode = this.#keyMode()
      const spd = Math.max(1, Math.abs(this.speed))
      if (!this.anchor) {
        this.anchor = { wall: now, media: this.startAt ?? this.queue[0].ts }
        this.startAt = null
      }
      let media = this.anchor.media + (now - this.anchor.wall) * this.speed
      const first = this.queue[0]
      const head = first.ts
      // A hole (marked by the reader, between two files or inside one): continue from the item after it. The
      // reader stalled (disk, flow control) and the clock ran ahead of the frames: continue from
      // the next frame, in time. Nothing else re-anchors: the spacing of what is queued is footage.
      const gap = first.gapBefore === true && dir * (head - media) > 0
      const behind = this.preroll === null && dir * (media - head) > this.lagMs * spd
      if (first.gapBefore) first.gapBefore = false // jumped once
      const minWall = keyMode ? 1000 / this.maxKeysPerS : 0
      if (gap || behind) {
        // anchored when a keyframe can go out again (the maxKeysPerS limit), so the ones after it
        // keep their media spacing (a notice at the head waits with the keyframe behind it)
        const wall = keyMode ? Math.max(now, this.lastKeyWall + minWall) : now
        this.anchor = { wall, media: head }
        media = head - (wall - now) * this.speed
      }
      while (this.queue.length && dir * (this.queue[0].ts - media) <= 0) {
        const item = this.queue[0]
        if (item.legAt) {
          // a hole the NVR may have: a leg, or jumped with a notice
          const r = this.#legMarker(item, now)
          if (r === 'wait') break
          this.queue.shift()
          if (r === 'started') break
          continue
        }
        // (keyframes: a delta frame here was read before the mode changed under a running play -- an
        // H.265 file after H.264 ones, at 2x for a browser that cannot decode it -- and goes at its time)
        if (item.buf && keyMode && item.isKey) {
          if (now - this.lastKeyWall < minWall) break // at most maxKeysPerS a second
          this.lastKeyWall = now
        }
        this.queue.shift()
        if (item.buf) this.queueBytes -= item.buf.length
        this.#deliver(item)
        if (this.closed) return
      }
      // A converter started on a frame of this pass (#transcode), and has now been handed all that
      // was due: the clock stops here, and starts again where the converter has caught up.
      if (this.hold) {
        this.anchor = null
        this.#heldPace(now)
        if (this.closed) return
      }
    }
    this.#edges(now)
    this.#fill()
    if (now - this.lastIdleCheck > 1000) {
      this.lastIdleCheck = now
      this.#closeIdleReaders(now)
    }
  }

  /**
   * A converter has just started (this.hold, set in #transcode) and has been handed what was due.
   * Until it has caught up the clock stands still (see the top):
   *  - it is handed CONVERTER_HOLDS frames more, as they are queued, whatever their time (a notice
   *    among them goes out with them): without them ffmpeg gives no picture back, and the frame at
   *    the start point would never come out;
   *  - once it has given back all but CONVERTER_HOLDS of what it was handed, it is as far as it can
   *    get: the wait ends (#release). Looked at here, on the pacer's tick, not where the picture
   *    comes out: 15 ms later at most;
   *  - it ends too at a hole the NVR may play, at a frame that is not converted (H.264 after H.265,
   *    for a browser without H.265), and when the converter has given nothing for convertWaitMs
   *    (dead, or starved of processor): then the clock runs as it always did.
   * While paused nothing more is handed in; the wait still ends as above.
   */
  #heldPace(now) {
    const h = this.hold
    if (this.xout > 0 && this.xin - this.xout <= CONVERTER_HOLDS) return this.#release(now)
    while (!this.paused && h.extra < CONVERTER_HOLDS && this.queue.length) {
      const item = this.queue[0]
      if (item.legAt || (item.buf && !this.#convertsFrame(item.codec))) return this.#release(now)
      this.queue.shift()
      if (item.buf) {
        this.queueBytes -= item.buf.length
        h.extra++
      }
      this.#deliver(item)
      // (closed; or a file in another codec among them: the next converter's own wait has begun)
      if (this.closed || this.hold !== h) return
    }
    if (now - h.last >= this.convertWaitMs) {
      // (said only of a converter that had enough to give a picture: with fewer frames in, the
      // footage ended there or its pictures are seconds apart, and there was nothing to wait for)
      if (this.xin > CONVERTER_HOLDS) this.log(`[${this.nvr.id}] server playback ch${this.ch + 1}: the conversion gave no picture in ${Math.round(this.convertWaitMs)} ms (${this.xin} frames in, ${this.xout} out): playing on without waiting for it`)
      this.#release(now)
    }
  }

  /**
   * The wait for a converter is over, and so is the preroll. The clock goes on from the last frame
   * handed in; from the start point when nothing past it went in (the converter had caught up before
   * there was more to hand it: footage with pictures seconds apart, a stand-in that takes no time),
   * so the next frame goes at its own distance from the start point, as it always did.
   */
  #release(now) {
    const media = this.preroll !== null && this.preroll > this.lastTs ? this.preroll : this.lastTs
    this.hold = null
    this.preroll = null
    // (paused meanwhile: from the next queued frame when play resumes, as #setPaused leaves it)
    this.anchor = this.paused ? null : { wall: now, media }
  }

  #deliver(item) {
    if (item.text) return this.#send(item.text)
    if (this.ws.readyState !== this.ws.OPEN) return
    if (this.#convertsFrame(item.codec)) {
      // The browser cannot decode what was recorded, or a remote viewer's link cannot carry it:
      // ffmpeg turns it into H.264 and the converted frame is sent from the callback below, in this
      // same wire format and at this same time. The position is moved on all the same (#transcode),
      // so pacing does not wait on the encoder: except where a converter starts (#heldPace), and
      // there the preroll ends when that wait does, not here.
      if (!this.#transcode(item)) return // the cap is full: #transcode has told the viewer and closed the session
      if (this.#oneAtATime()) this.xcode.endPicture()
      if (!this.hold && this.preroll !== null && item.ts >= this.preroll) this.preroll = null
      return
    }
    this.ws.send(encodeDiskFrame(item.buf, item.isKey, item.codec, item.ts))
    this.lastTs = item.ts
    if (this.preroll !== null && item.ts >= this.preroll) this.preroll = null
    if (this.timing.first === null) this.timing.first = this.now() - this.t0
  }

  // ---- H.265 -> H.264 conversion (transcode.mjs) -----------------------------------------------

  /**
   * Feeds one frame to the conversion, starting it the first time. False means the server is
   * already converting as many streams as it will (the cap): the viewer is told so plainly and the
   * session ends, because a queue for something this heavy is a page that waits for ever. (Only H.265
   * for a browser that cannot decode it gets here without a slot: a remote viewer who found none is
   * sent the recording itself, #fitRun.)
   */
  #transcode(item) {
    if (!this.xcode) {
      this.slot ??= this.pool.acquire()
      if (!this.slot) {
        this.log(`[${this.nvr.id}] server playback ch${this.ch + 1}: H.265 conversion refused, ${this.pool.active} already running`)
        this.#send({
          type: 'error',
          message: `This recording is H.265 and this browser cannot play it. The server can convert it, but it is already converting as many streams as it can. Try again in a few minutes${this.legs ? ', or choose "SD (NVR)"' : ''}.`
        })
        // Not 1013: the page turns that into "the NVR is busy", which would replace the message
        // above with one about the wrong machine entirely.
        this.ws.close(1011, 'transcode busy')
        this.close()
        return false
      }
      this.xcode = this.makeTranscoder({
        // what ffmpeg reads: H.265, or for a remote viewer H.264 too (switched below)
        inCodec: item.codec,
        // at most 1920 wide and 2.5 Mbit/s: a 4K conversion at full size ran slower than real time
        // and came out bigger than a tunnel carries (the measurements are at PLAYBACK_LIMITS)
        ...PLAYBACK_LIMITS,
        // Asked each time an ffmpeg starts. Playing forward, low_delay is dropped: it made the H.265
        // decoder single-threaded, and 4K converted at 1.2x real time with it, 2.2-2.3x without
        // (smoothness report, cause 2a). One picture at a time keeps it, because the decoder's frame
        // threads hold a picture back until the next arrives: a scrub's keyframe would never come
        // out, and each keyframe would wait for the next one (a second at 2x).
        lowDelay: () => this.#oneAtATime(),
        // Asked each time too. One picture at a time is at most maxKeysPerS a second (the pacer), but
        // x264 spends the rate cap as though a camera frame's time lay between pictures: each keyframe
        // got a 1x picture's share (15.6 KB) and came out blocky while the link sat nearly idle.
        // Stamped maxKeysPerS a second, the cap holds per second of wall clock and each gets its share.
        picturesPerS: () => (this.#oneAtATime() ? this.maxKeysPerS : 0),
        onFrame: (ts, isKey, buf) => this.#sendConverted(ts, isKey, buf),
        onFail: (e) => this.#fail(new Error(`could not convert this H.265 recording (${e.message})`)),
        log: this.log
      })
      this.converts = true // (a scrub opens its file without #openSeg)
      const why = this.fitOn ? `for a remote viewer, at most ${PLAYBACK_LIMITS.maxWidth} wide and ${PLAYBACK_LIMITS.maxKbps} kbit/s` : 'H.265 to H.264 for this browser'
      this.log(`[${this.nvr.id}] server playback ch${this.ch + 1}: converting ${why}`)
    } else if (this.xcode.inCodec !== item.codec) {
      // A remote viewer's footage changed codec between two files (the recorder on the sub-stream,
      // a camera reconfigured). ffmpeg is told the format it reads when it starts, so the running
      // one ends and the next starts on this frame, the new file's first keyframe; the last two or
      // three pictures of the file before (inside the old ffmpeg, or out of it but not yet proved
      // whole) are lost with it.
      this.xcode.reset()
      this.xcode.inCodec = item.codec
      this.xin = 0
      this.xout = 0
    }
    // A converter starts on this frame (the first of a run, or of a file in another codec), playing
    // every frame: the pacer waits for it once what is due has gone in (#heldPace). One picture at
    // a time (a scrub, keyframes only) is ended and comes out by itself: no wait.
    if (this.xin === 0 && !this.#oneAtATime()) this.hold = { last: this.now(), extra: 0 }
    this.xin++
    this.lastTs = item.ts // (before the push: a stand-in may hand the picture back inside it)
    this.xcode.push(item.ts, item.isKey, item.buf)
    return true
  }

  #sendConverted(ts, isKey, buf) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(encodeDiskFrame(buf, isKey, CODEC_H264, ts))
    if (this.timing.first === null) this.timing.first = this.now() - this.t0
    this.xout++
    if (this.hold) this.hold.last = this.now() // (it is working: #heldPace waits on)
  }

  /**
   * Stops the conversion dead. Called on every jump (seek, scrub, speed change, a new epoch) and on
   * close: an ffmpeg still chewing on footage nobody is watching is stealing cores from the
   * recorder, so it is killed rather than allowed to drain.
   */
  #stopTranscode(final) {
    // (the next frame handed in starts a converter; a wait for this one is over with it)
    this.xin = 0
    this.xout = 0
    this.hold = null
    if (final) {
      this.xcode?.close()
      this.xcode = null
      // (also a slot with no conversion yet: a remote viewer's is taken at the first file, #fitRun)
      this.slot?.release()
      this.slot = null
      return
    }
    this.xcode?.reset() // the slot is kept: the same viewer plays on from the new position
  }

  /** The newest frame reached faster than 1x; the end of the footage. Checked when the queue is empty. */
  #edges(now) {
    const c = this.cur
    if (this.leg || this.paused || this.queue.length || c.phase !== 'play') return
    const atTail = Boolean(c.reader?.growing && c.needPoll)
    if (this.speed > 1 && (atTail || this.atEnd)) return this.#setSpeed(1, 'newest')
    if (this.speed > 0 && this.atEnd && !this.endSent && now - this.atEndSince >= this.endGraceMs) {
      this.endSent = true
      this.#send({ type: 'end', newest: true })
    }
    if (this.speed < 0 && this.revEnd && !this.endSent) {
      this.endSent = true
      this.#send({ type: 'end', reverse: true })
    }
  }

  /** Queues a frame or a message; the first one after a hole (#hole) is marked gapBefore. */
  #enqueue(item) {
    if (this.gapPending) {
      item.gapBefore = true
      this.gapPending = false
    }
    this.queue.push(item)
  }

  #queueFrame(f, codec) {
    this.#enqueue({ ts: f.ts, buf: f.buf, isKey: f.isKey, codec })
    this.queueBytes += f.buf.length
    this.lastQueuedTs = f.ts
  }

  // ---- reading ---------------------------------------------------------------------------------

  /** Whether the next step may run now (flow control; waits at the end of the footage). */
  #wantRead() {
    const c = this.cur
    if (c.phase === 'start' || c.phase === 'resume' || c.phase === 'scrub') return true
    if (c.phase !== 'play') return false
    if (this.now() < (c.waitUntil ?? 0)) return false
    // during an NVR leg the next file is read up to its first GOP (the switch back is instant)
    if (this.leg) return this.queueBytes === 0
    const buffered = this.ws.bufferedAmount ?? 0
    if (this.throttled) {
      if (buffered >= this.resumeBelow) return false
      this.throttled = false
    } else if (buffered > this.pauseAbove) {
      this.throttled = true
      return false
    }
    if (this.queueBytes >= this.maxQueueBytes) return false
    const ahead = this.queue.length > 1 ? Math.abs(this.queue.at(-1).ts - this.queue[0].ts) : 0
    return ahead < this.readAheadMs * Math.max(1, Math.abs(this.speed))
  }

  #fill() {
    if (this.closed || this.busy || !this.#wantRead()) return
    this.busy = true
    const epoch = this.epoch
    const stale = () => this.closed || epoch !== this.epoch
    let run
    try {
      run = this.#step(this.cur, stale)
    } catch (e) {
      run = Promise.reject(e)
    }
    run.then(
      (progress) => this.#stepDone(stale, Boolean(progress)),
      (e) => {
        if (stale()) return this.#stepDone(stale, false)
        this.busy = false
        this.#fail(e)
      }
    )
  }

  #stepDone(stale, progress) {
    this.busy = false
    if (this.closed) return this.#closeReaders()
    // go on at once (not at the next tick) after progress or a new epoch
    if (progress || stale()) setImmediate(() => this.#pace())
  }

  /** One step of the reader: true when it made progress (the next one may follow at once). */
  async #step(c, stale) {
    switch (c.phase) {
      case 'start':
        return this.#startStep(c, stale)
      case 'resume':
        return this.#resumeStep(c, stale)
      case 'scrub':
        return this.#scrubStep(c, stale)
      case 'play':
        if (!c.reader) return this.speed > 0 ? this.#nextFile(c, stale) : this.#prevFile(c, stale)
        c.reader.lastUsed = this.now()
        return this.#keyMode() ? this.#keyStep(c, stale) : this.#allStep(c, stale)
    }
    return false
  }

  /** Start or seek: find the file and the keyframe, announce the generation, set the preroll. */
  async #startStep(c, stale) {
    const id = this.nvr.id
    const fwd = this.speed > 0
    const t0 = this.now()
    let seg = this.index.at(id, this.ch, c.t)
    let jumped = false
    let reason = c.reason ?? null // why the NVR did not play the stretch jumped (for the notice)
    if (!seg) {
      seg = fwd ? this.index.next(id, this.ch, c.t) : this.index.prev(id, this.ch, c.t)
      jumped = true
    }
    if (this.timing.index === null) this.timing.index = this.now() - t0
    if (jumped && !c.noLeg && this.#legsAllowed()) {
      // no server footage at T: the NVR may have the stretch up to the next file (R7)
      const end = seg ? seg.startMs : c.t + this.legSpanMs
      if (end - c.t >= this.noticeGapMs) {
        const cov = await this.#coverage(c.t, end)
        if (stale()) return false
        const span = this.#legSpan(cov, c.t, end)
        if (span && this.#nvrReady()) return this.#legAtStart(c, seg, span, cov, stale)
        reason = cov.reason ?? (span ? this.#nvrNotReady() : null)
      }
    }
    const t1 = this.now()
    const opened = seg ? await this.#openSeg(seg, fwd ? 1 : -1, stale) : null
    if (stale()) return false
    if (this.timing.idx === null) this.timing.idx = this.now() - t1
    if (!opened) {
      // nothing to play in that direction
      this.cur = { phase: 'end' }
      this.#send(fwd ? { type: 'end', newest: true } : { type: 'end', reverse: true })
      return false
    }
    if (opened.seg !== seg) jumped = true // an unreadable file was skipped
    const r = opened.reader
    const k = Math.max(0, keyAtOrBefore(r.times, c.t))
    const from = r.times[k] ?? opened.seg.startMs
    const keyMode = this.#keyMode()
    // at: what the browser shows first (the frames before it are the preroll); keyframe modes have none
    const at = keyMode || jumped ? from : c.t
    if (jumped && fwd) this.#send(this.#notice(c.t, from, reason))
    this.#send({ type: 'started', gen: c.gen, at, from, src: 'server' })
    this.posRef = at
    this.cur = { phase: 'play', seg: opened.seg, reader: r, k, i: 0, target: from, needPoll: false, waitUntil: 0 }
    if (!keyMode) {
      this.startAt = at
      this.preroll = at
    }
    return true
  }

  /** A restart in another mode at the play position (a speed change): no new generation. */
  async #resumeStep(c, stale) {
    const id = this.nvr.id
    const fwd = this.speed > 0
    const seg = this.index.at(id, this.ch, c.t) ?? (fwd ? this.index.next(id, this.ch, c.t) : this.index.prev(id, this.ch, c.t))
    const opened = seg ? await this.#openSeg(seg, fwd ? 1 : -1, stale) : null
    if (stale()) return false
    const base = { phase: 'play', k: 0, i: 0, target: c.t, needPoll: false, waitUntil: 0 }
    if (!opened) {
      // nothing there (yet): forward waits for new footage, reverse is at the first recording
      this.cur = { ...base, seg: { startMs: c.t }, reader: null }
      return true
    }
    const r = opened.reader
    let k = 0
    if (!this.#keyMode()) {
      // all frames again: from the next keyframe at or after the position (no preroll needed)
      const ka = keyAtOrAfter(r.times, c.t)
      k = ka >= 0 ? ka : r.rows.length
    }
    this.cur = { ...base, seg: opened.seg, reader: r, k }
    return true
  }

  /** Scrub: the keyframe at or before T, if this is still the newest scrub; then paused. */
  async #scrubStep(c, stale) {
    const seg = this.index.at(this.nvr.id, this.ch, c.t)
    let r = null
    let kf = null
    if (seg) {
      try {
        r = await this.#reader(seg)
      } catch (e) {
        if (stale() || !SKIP_CODES.has(e?.code)) throw e
        this.#logSkip(seg, e)
      }
      if (stale()) return false
      const k = r ? keyAtOrBefore(r.times, c.t) : -1
      if (k >= 0) {
        kf = await r.keyframe(k)
        if (!kf && k > 0) kf = await r.keyframe(k - 1) // the newest keyframe of the open file, not complete yet
        if (stale()) return false
      }
    }
    if (!kf) {
      this.#send({ type: 'scrub', gen: c.gen, none: true })
      this.cur = { phase: 'scrubbed', t: c.t }
      return false
    }
    this.#send({ type: 'scrub', gen: c.gen, at: kf.ts })
    // Converted, the picture is ended in #deliver (#oneAtATime, while the phase is still 'scrub'):
    // nothing follows this keyframe, and ffmpeg would hold it until a next picture began, so the drag
    // showed no picture at all.
    this.#deliver({ buf: kf.buf, isKey: true, codec: r.codec, ts: kf.ts })
    this.cur = { phase: 'scrubbed', t: kf.ts }
    return false
  }

  /** 1x-4x: the next GOP (or what has arrived of the newest one in the open file). */
  async #allStep(c, stale) {
    const r = c.reader
    if (r.growing && c.needPoll) return this.#pollTail(c, stale)
    if (c.k >= r.rows.length) {
      if (r.growing) {
        c.needPoll = true
        return this.#pollTail(c, stale)
      }
      return this.#nextFile(c, stale)
    }
    this.#prefetch(c)
    const frames = await r.gop(c.k)
    if (stale()) return false
    for (let i = c.i; i < frames.length; i++) this.#queueFrame(frames[i], r.codec)
    if (r.growing && c.k === r.rows.length - 1) {
      // the newest GOP of the open file: the rest follows as it is written
      c.i = frames.length
      c.needPoll = true
      c.waitUntil = this.now() + this.tailPollMs
    } else {
      // a hole inside the file after this GOP (the NVR stalled; the writer carried on in the same file)
      const hole = r.holeAfter(c.k)
      c.k++
      c.i = 0
      if (hole) this.#hole(hole.fromMs, hole.toMs)
    }
    return true
  }

  /** 8x-32x and reverse: the next keyframe far enough from the last one. */
  async #keyStep(c, stale) {
    const r = c.reader
    const fwd = this.speed > 0
    if (fwd && r.growing && c.needPoll) return this.#pollTail(c, stale)
    const k = fwd ? keyAtOrAfter(r.times, c.target) : keyAtOrBefore(r.times, c.target)
    if (k < 0) {
      if (fwd && r.growing) {
        c.needPoll = true
        return this.#pollTail(c, stale)
      }
      return fwd ? this.#nextFile(c, stale) : this.#prevFile(c, stale)
    }
    const kf = await r.keyframe(k)
    if (stale()) return false
    if (!kf) {
      if (fwd && r.growing) {
        // the newest keyframe of the open file is not complete yet
        c.needPoll = true
        c.waitUntil = this.now() + this.tailPollMs
        return false
      }
      c.target = r.times[k] + (fwd ? 0.001 : -0.001) // not readable: go past it
      return true
    }
    this.#queueFrame({ buf: kf.buf, isKey: true, ts: kf.ts }, r.codec)
    const spacing = ((Math.abs(this.speed) * 1000) / this.maxKeysPerS) * KEY_SPACING_SLACK
    c.target = fwd ? kf.ts + spacing : kf.ts - spacing
    return true
  }

  /** The open file: what has arrived since, or the rest once it has been closed. */
  async #pollTail(c, stale) {
    const news = await this.#poll(c)
    if (stale()) return false
    if (news) {
      c.needPoll = false
      return true
    }
    c.waitUntil = this.now() + this.tailPollMs
    return false
  }

  async #poll(c) {
    const r = c.reader
    const o = this.index.openOf(this.nvr.id, this.ch)
    if (o && o.path === c.seg.path) return r.refresh()
    // closed by its writer (indexed now), or its worker restarted: read the rest as a closed file
    // (its row by its path, the primary key: a time range would walk the camera's older rows)
    const row = this.index.byPath(c.seg.path)
    await r.markClosed(row?.endMs ?? null, this.#nextStartOf(c.seg))
    c.seg = row ?? { ...c.seg, open: false }
    return true
  }

  /** Forward: the next file (a notice for a long gap), or wait for one. */
  async #nextFile(c, stale) {
    const next = this.index.next(this.nvr.id, this.ch, c.seg.startMs)
    const opened = next ? await this.#openSeg(next, 1, stale) : null
    if (stale()) return false
    if (!opened) {
      if (!this.atEnd) {
        this.atEnd = true
        this.atEndSince = this.now()
      }
      c.waitUntil = this.now() + this.tailPollMs
      return false
    }
    this.atEnd = false
    this.endSent = false
    const r = opened.reader
    // the hole: from the end of the file left (its last frame; what was queued from it when later)
    // to the first keyframe of this one
    const ends = [c.seg.endMs, c.reader?.endMs, this.lastQueuedTs ?? this.lastTs].filter((v) => Number.isFinite(v))
    const before = ends.length ? Math.max(...ends) : null
    const first = r.times[0] ?? opened.seg.startMs
    if (before != null) this.#hole(before, first)
    this.cur = { phase: 'play', seg: opened.seg, reader: r, k: 0, i: 0, target: c.target, needPoll: false, waitUntil: 0 }
    return true
  }

  /**
   * Forward, every frame: a hole from `before` (the last frame queued) to `first` (the next one), between two
   * files or inside one. Over gapMs: the next item queued is marked gapBefore (the pacer jumps to it). noticeGapMs
   * or more: the NVR may have it (a leg when playback gets there), else a notice. A start or seek inside the hole
   * (the preroll's target in it) counts from there.
   */
  #hole(before, first) {
    if (this.preroll !== null && this.preroll > before && this.preroll < first) before = this.preroll
    if (first - before > this.gapMs) this.gapPending = true
    if (first - before >= this.noticeGapMs && this.#legsAllowed()) this.#queueLegMarker(before, first)
    // every hole the pacer jumps gets a notice: silent 3-30 s jumps looked like missing frames
    else if (first - before > this.gapMs) this.#enqueue({ ts: first, text: this.#notice(before, first) })
  }

  /** Reverse: the previous file, or the end (the camera's first recording). */
  async #prevFile(c, stale) {
    const prev = this.index.prev(this.nvr.id, this.ch, c.seg.startMs)
    const opened = prev ? await this.#openSeg(prev, -1, stale) : null
    if (stale()) return false
    if (!opened) {
      this.revEnd = true
      c.waitUntil = Infinity
      return false
    }
    // the hole: from the end of the file before (its last frame) to the start of the one left
    const r = opened.reader
    const end = opened.seg.endMs ?? r.endMs ?? r.times.at(-1)
    const start = c.reader?.times[0] ?? c.seg.startMs
    if (Number.isFinite(end) && Number.isFinite(start) && start - end > this.gapMs) this.gapPending = true
    this.cur = { phase: 'play', seg: opened.seg, reader: r, k: 0, i: 0, target: c.target, needPoll: false, waitUntil: 0 }
    return true
  }

  /** reason: why the NVR did not play it either (offline, busy, failed); none: nobody recorded it. */
  #notice(from, to, reason = null) {
    let tz = null
    try {
      tz = this.nvr.playback?.lastClock?.()?.tzOffsetMs ?? null
    } catch {}
    const why = reason ? `not recorded on the server; ${reason}` : 'not recorded'
    return { type: 'notice', message: `Skipped ${clockText(from, tz)}–${clockText(to, tz)}: ${why}`, from, to }
  }

  // ---- NVR legs (rec-fallback.mjs) -------------------------------------------------------------

  /** Legs start only going forward with every frame (1x-4x): not in reverse, scrubbing or keyframe modes. */
  #legsAllowed() {
    return Boolean(this.legs) && this.speed > 0 && !this.#keyMode()
  }

  #nvrReady() {
    return Boolean(this.nvr.online) && !this.nvr.degraded
  }

  #nvrNotReady() {
    return this.nvr.online ? 'the NVR is busy' : 'the NVR is offline'
  }

  /** The NVR's coverage of [fromMs, toMs] (server time); never throws. */
  #askCoverage(fromMs, toMs) {
    return Promise.resolve()
      .then(() => this.legs.coverage(this.nvr, this.ch, fromMs, toMs))
      .then(
        (c) => c ?? { ranges: [] },
        (e) => ({ ranges: [], reason: `the NVR search failed (${e?.message ?? e})` })
      )
  }

  /** A new epoch: whatever waits on the old one (a coverage wait) stops waiting at once. */
  #bumpEpoch() {
    this.epoch++
    const old = this.epochAbort
    this.#newEpochAbort()
    old?.resolve()
  }

  #newEpochAbort() {
    let resolve
    const promise = new Promise((r) => (resolve = r))
    this.epochAbort = { promise, resolve }
  }

  /**
   * The coverage, waiting at most legWaitMs for it, and no longer than this epoch: a seek, scrub or
   * restart meanwhile ends the wait at once (the reader step holds the step chain while it waits,
   * so a newer seek would otherwise wait for the stale search). The search itself goes on and is
   * cached (rec-fallback.mjs).
   */
  async #coverage(fromMs, toMs) {
    let timer = null
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ranges: [], reason: 'the NVR did not answer in time' }), this.legWaitMs)
    })
    const aborted = this.epochAbort.promise.then(() => ({ ranges: [], reason: 'superseded', aborted: true }))
    try {
      return await Promise.race([this.#askCoverage(fromMs, toMs), late, aborted])
    } finally {
      clearTimeout(timer)
    }
  }

  /** The first stretch of the coverage inside [fromMs, toMs] worth a leg: { from, to }, or null. */
  #legSpan(cov, fromMs, toMs) {
    for (const r of cov?.ranges ?? []) {
      const from = Math.max(fromMs, r[0])
      const to = Math.min(toMs, r[1])
      if (to - from >= COVER_MIN_MS) return { from, to }
    }
    return null
  }

  /** The reader is within prefetchMs of a long hole after this file: ask the NVR's coverage now (it is cached). */
  #prefetch(c) {
    if (c.prefetched || !this.#legsAllowed() || c.seg.open || !Number.isFinite(c.seg.endMs)) return
    const at = c.reader.times[c.k] ?? c.seg.startMs
    if (c.seg.endMs - at > this.prefetchMs) return
    c.prefetched = true
    const next = this.index.next(this.nvr.id, this.ch, c.seg.startMs)
    if (next && next.startMs - c.seg.endMs >= this.noticeGapMs) this.#askCoverage(c.seg.endMs, next.startMs)
  }

  /** A start or seek in a stretch the NVR has: the leg plays it; the reader waits at the next file. */
  async #legAtStart(c, seg, span, cov, stale) {
    const opened = seg ? await this.#openSeg(seg, 1, stale) : null
    if (stale()) return false
    // the leg ends where the server's footage starts again: the next file's first frame
    const first = opened ? Math.min(opened.seg.startMs, opened.reader.times[0] ?? Infinity) : c.t + this.legSpanMs
    if (span.from - c.t > this.gapMs) this.#send(this.#notice(c.t, span.from))
    this.posRef = span.from
    this.cur = opened
      ? { phase: 'play', seg: opened.seg, reader: opened.reader, k: 0, i: 0, target: first, needPoll: false, waitUntil: 0 }
      : { phase: 'play', seg: { startMs: c.t }, reader: null, k: 0, i: 0, target: c.t, needPoll: false, waitUntil: 0 }
    this.#startLeg({ fromMs: span.from, toMs: first, gen: c.gen, floorMs: null, skewMs: cov.skewMs })
    return true
  }

  /** A hole of noticeGapMs or more (between two files or inside one): a leg is decided when playback gets there. */
  #queueLegMarker(fromMs, toMs) {
    const m = { ts: fromMs, legAt: true, fromMs, toMs, cov: undefined, waitFrom: null }
    this.#askCoverage(fromMs, toMs).then((cov) => (m.cov = cov))
    this.queue.push(m) // (not #enqueue: the first frame after the hole keeps gapBefore)
  }

  /** Playback reached a hole: 'started' (a leg plays it), 'skipped' (a notice; jumped) or 'wait' (for the coverage). */
  #legMarker(m, now) {
    if (m.cov === undefined) {
      m.waitFrom ??= now
      if (now - m.waitFrom < this.legWaitMs) return 'wait'
      m.cov = { ranges: [], reason: 'the NVR did not answer in time' }
    }
    const span = this.#legSpan(m.cov, m.fromMs, m.toMs)
    if (span && this.#nvrReady() && this.#legsAllowed()) {
      if (span.from - m.fromMs > this.gapMs) this.#send(this.#notice(m.fromMs, span.from))
      this.#startLeg({ fromMs: span.from, toMs: m.toMs, gen: null, floorMs: this.lastTs, skewMs: m.cov.skewMs })
      return 'started'
    }
    this.#send(this.#notice(m.fromMs, m.toMs, m.cov.reason ?? (span ? this.#nvrNotReady() : null)))
    return 'skipped'
  }

  #startLeg({ fromMs, toMs, gen, floorMs, skewMs }) {
    let skew = skewMs
    if (!Number.isFinite(skew)) {
      try {
        skew = this.nvr.playback?.lastClock?.()?.skewMs ?? 0
      } catch {
        skew = 0
      }
    }
    const rec = { handle: null, gen, fromMs, toMs, keyMode: this.#keyMode() }
    try {
      // h265: the NVR's frames go straight to this browser, so they must be converted when ours are
      rec.handle = this.legs.start({ nvr: this.nvr, ch: this.ch, fromMs, toMs, stream: 0, speed: Math.min(this.speed, LEG_MAX_SPEED), paused: this.paused, skewMs: skew, real: this.ws, gen, at: fromMs, floorMs, h265: this.clientH265 })
    } catch (e) {
      rec.handle = failedLeg(e)
    }
    this.leg = rec
    this.hold = null // (a converter that started on the frames before the hole is not waited for: the leg plays)
    this.anchor = null
    this.startAt = null
    this.preroll = null
    rec.handle.done.then(
      (r) => this.#legDone(rec, r ?? { reason: 'end' }),
      (e) => this.#legDone(rec, { reason: 'error', message: e?.message ?? String(e) })
    )
  }

  #closeLeg() {
    const rec = this.leg
    if (!rec) return
    this.leg = null
    rec.handle.close()
  }

  /** A speed change during a leg: forward speeds go to the NVR (at most 8x); reverse returns to the server. */
  #legSpeed(s) {
    const rec = this.leg
    this.speed = s
    if (s > 0) return rec.handle.command({ speed: s })
    // reverse is not played from the NVR (R7): keyframes back from the server's footage before the position
    const P = rec.handle.lastTs ?? rec.fromMs
    const announced = rec.handle.announced
    this.#reset() // (closes the leg)
    this.#updateStills()
    this.posRef = P
    // a start whose NVR playback had not begun: its generation is announced from the server
    this.cur = rec.gen !== null && !announced ? { phase: 'start', t: P, gen: rec.gen, noLeg: true } : { phase: 'resume', t: P }
    this.#fill()
  }

  /** A leg ended (the server's footage starts, the NVR ended or failed); a leg closed by us is only logged. */
  #legDone(rec, r) {
    const msg = r.message ? ` (${r.message})` : ''
    this.log(`[${this.nvr.id}] server playback ch${this.ch + 1}: NVR leg ${isoOf(rec.fromMs)} to ${isoOf(rec.toMs)}: ${r.reason}${msg}, ${r.frames ?? 0} frames`)
    if (this.leg !== rec || this.closed) return
    this.leg = null
    rec.handle.close()
    const announced = r.announced ?? rec.handle.announced
    const lastTs = r.lastTs ?? rec.handle.lastTs ?? null
    const why = r.reason === 'error' ? `the NVR could not play it${msg}` : null
    if (rec.gen !== null && !announced) {
      // a start or seek whose NVR playback never began: that generation starts from the server after all
      this.#reset()
      this.cur = { phase: 'start', t: rec.fromMs, gen: rec.gen, noLeg: true, reason: why }
      return this.#fill()
    }
    // on from disk: the next file's first frames are queued already (read during the leg)
    const head = this.queue.find((q) => q.buf)
    const from = head?.ts ?? this.cur.reader?.times?.[this.cur.k] ?? this.cur.seg?.startMs ?? null
    if (why) this.#send(this.#notice(lastTs ?? rec.fromMs, rec.toMs, why))
    if (announced) this.#send({ type: 'source', src: 'server', from, to: null })
    if (lastTs !== null) this.lastTs = lastTs
    if (rec.keyMode !== this.#keyMode()) {
      // the speed changed mode during the leg (say 4x to 16x): read on in the new mode
      const t = from ?? lastTs ?? rec.toMs
      this.#reset()
      this.posRef = t
      this.cur = { phase: 'resume', t }
    } else {
      this.anchor = null
      this.startAt = null
      this.preroll = null
    }
    setImmediate(() => this.#pace())
  }

  // ---- files -----------------------------------------------------------------------------------

  /**
   * Opens seg, or the next readable one in direction dir: { seg, reader } or null. A deleted file is
   * skipped, and so is an empty one (a closed file with no keyframe on disk: a zero-byte segment the
   * share left behind, still indexed as recorded). Played, an empty file was its whole span waited out
   * in real time on a black picture; skipped, the callers see the hole from the file before to the
   * file after (#nextFile, #prevFile) or a start that jumped (#startStep), with the usual notice.
   * The file being written is never skipped: it is empty only until its first frames arrive.
   */
  async #openSeg(seg, dir, stale) {
    for (let n = 0; seg && n < 1000; n++) {
      try {
        const reader = await this.#reader(seg)
        // Closed or moved on while it opened (the tab closed, a seek, another camera or day): this
        // file is no run's first any more. Deciding one here (#noteCodec, #fitRun) would take a
        // remote viewer's slot after close() has run, never to be given back, or decide the new
        // run by the old position. (The callers check stale() on a null at once.)
        if (stale()) return null
        if (!(reader.rows.length === 0 && !reader.growing)) {
          this.#noteCodec(reader.codec, seg)
          return { seg, reader }
        }
        this.#logSkip(seg, { code: 'no frames' })
      } catch (e) {
        if (stale() || !SKIP_CODES.has(e?.code)) throw e
        this.#logSkip(seg, e)
      }
      seg = dir > 0 ? this.index.next(this.nvr.id, this.ch, seg.startMs) : this.index.prev(this.nvr.id, this.ch, seg.startMs)
    }
    return null
  }

  #logSkip(seg, e) {
    if (this.skipLogged) return
    this.skipLogged = true
    this.log(`[${this.nvr.id}] server playback ch${this.ch + 1}: ${seg.path}: ${e.code}, skipped`)
  }

  /** A reader for seg: kept from before (LRU), or opened (its .idx read once). */
  async #reader(seg) {
    let r = this.readers.get(seg.path)
    if (r) {
      this.readers.delete(seg.path)
      this.readers.set(seg.path, r)
      if (r.growing && !seg.open) await r.markClosed(seg.endMs ?? null, this.#nextStartOf(seg))
      else if (r.growing) await r.refresh() // the open file, kept from a while ago: what has arrived since
    } else {
      // the neighbours: the last GOP runs up to the next file's first keyframe (a seamless minute join), and a
      // catch-up burst at this file's start may take its time back to the previous file's end
      const after = seg.open ? null : this.index.next(this.nvr.id, this.ch, seg.startMs)
      const nextStartMs = Number.isFinite(after?.startMs) ? after.startMs : null
      const prevEndMs = this.index.prev(this.nvr.id, this.ch, seg.startMs)?.endMs ?? null
      r = new SegmentReader({ path: seg.path, endMs: seg.endMs ?? null, growing: Boolean(seg.open), fs: this.fs, nextStartMs, prevEndMs })
      await r.open()
      this.readers.set(seg.path, r) // (closed with the rest if the session closed meanwhile)
      this.#evict()
      // the next file, ready before it is needed (not the one still being written)
      if (after && !after.open) readAhead(after.path)
    }
    r.lastUsed = this.now()
    return r
  }

  /** The start of the file after seg (its first keyframe), or null. */
  #nextStartOf(seg) {
    const v = this.index.next(this.nvr.id, this.ch, seg.startMs)?.startMs
    return Number.isFinite(v) ? v : null
  }

  #evict() {
    for (const [path, r] of this.readers) {
      if (this.readers.size <= READERS_MAX) break
      if (r === this.cur.reader) continue
      this.readers.delete(path)
      r.close()
    }
  }

  #closeIdleReaders(now) {
    if (this.busy) return
    for (const [path, r] of this.readers) {
      if (r === this.cur.reader || now - (r.lastUsed ?? 0) < READER_IDLE_MS) continue
      this.readers.delete(path)
      r.close()
    }
  }

  #closeReaders() {
    const all = [...this.readers.values()]
    this.readers.clear()
    return Promise.all(all.map((r) => r.close()))
  }

  // ---- end -------------------------------------------------------------------------------------

  #fail(e) {
    if (this.closed) return
    this.log(`[${this.nvr.id}] server playback ch${this.ch + 1} failed: ${e?.message ?? e}`)
    // the viewer gets what went wrong in words; the log above keeps what the system said
    const why = STORE_CODES.has(e?.code) ? STORE_FAILED : (e?.message ?? e)
    this.#send({ type: 'error', message: `Playback failed: ${why}` })
    this.ws.close(1011, 'playback failed')
    this.close()
  }

  /** Stops the session: timers, the reader, the files (once the running step has returned). */
  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.pacer)
    this.#closeLeg()
    this.#stopTranscode(true)
    this.#bumpEpoch()
    this.queue = []
    this.queueBytes = 0
    if (!this.busy) this.#closeReaders()
    const ms = (v) => (v === null ? '-' : String(Math.round(v)))
    const from = Number.isFinite(this.start) && Math.abs(this.start) < 8.64e15 ? new Date(this.start).toISOString() : String(this.start)
    this.log(`[${this.nvr.id}] server playback ch${this.ch + 1} from ${from}: index ${ms(this.timing.index)} ms, idx ${ms(this.timing.idx)} ms, first frame ${ms(this.timing.first)} ms`)
  }
}
