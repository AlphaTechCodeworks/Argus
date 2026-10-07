// A camera's main (recording) stream: bitrate cap, quality level, codec, resolution and frame
// rate, with the NVR's own storage estimate. Reading is safe; a change needs an admin's
// confirmation of what it does to storage, and is never suggested to lower anything.
//
// Protocol: the NVR web client's record-stream pages (js/app/RecCfg/recModeCfg.js, and
// CommonFunctions.GetBitrateRange), sent over the SDK connection like every XML command:
//   read    queryNodeEncodeInfo       <condition><chlId>{id}</chlId></condition><requireField>...  (per channel:
//           unverified on these NVRs, on the live-test list; else the all-channel answer, ~33 KB per channel)
//           queryRecordDistributeInfo (record mode, cycle recording), querySystemCaps (bandwidth),
//           queryNetCfgV2 (poeMode: on '10' the page offers at most 6144 kbps)
//   storage queryRemainRecTime        <content><recMode>auto</recMode><streamType>Main</streamType><chls type="list">
//           <item id><QoI>..</QoI></item> for EVERY enabled channel (recModeCfg.js getAllRows)</chls></content>
//   write   editNodeEncodeInfo        <content type="list" total="1"><item id><an .../><ae .../><main enct aGOP ></main></item></content>
//           every attribute echoed from a fresh read (recModeCfg.js getSaveData)
// Only NVRs in automatic record mode (the an/ae streams) can be changed here; the manual-mode
// page (eventRecStream.js) has not been seen. Record mode, audio, GOP and the dual-stream switch
// (which restarts the NVR) are never written.
//
// Bitrate type was in that list until 2026-09-25, and is now written. What changed: measuring the
// recordings showed most cameras pinned to a fixed rate, so an empty yard at 3am cost exactly as
// much bandwidth and disk as a busy one. On nvr-2 that held 128 Mb of a 192 Mb budget open around
// the clock, which is why it refused streams and why eleven cameras were recording nothing at all.
//
// It is a change of meaning, not just a setting, and the page has to say so: under CBR the QoI
// figure is the rate the camera holds constantly, and under VBR the same number becomes a ceiling
// it stays below. Quality on a busy scene is unchanged, because the ceiling is unchanged; a still
// scene simply stops paying for detail that is not there. Nothing switches by itself -- it goes
// through the same seen/ack/confirm gate as every other change here, one camera at a time.
//
//   GET  /api/admin/nvrs/:id/channels/:ch/stream[?usage=0.96]   -> { stream }
//   POST /api/admin/nvrs/:id/channels/:ch/stream/estimate       { change, measuredKbps? } -> { estimate }   (read only)
//   POST /api/admin/nvrs/:id/channels/:ch/stream                { device, change, seen, ack, ackToken, confirm: true }
//                                                               { device, undo: true, seq, ack, ackToken, confirm: true }
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DATA_DIR } from './auth.mjs'
import {
  HttpError,
  XML_HEADER,
  cameraOf,
  deviceOf,
  errorAnswer,
  esc,
  isPlainObject,
  kid,
  kids,
  newSeq,
  parseAnswer,
  readLogCached,
  requireOnline,
  rotateLog,
  settled,
  transparent,
  withNvrLock
} from './nvr-xml.mjs'
import { nvrs } from './nvrs.mjs'
import { chOfGuid, parseRecStatus } from './nvr-online.mjs'
import { normEnct, qualityList, recommendedRange } from './substreams.mjs'
import { xmlDegraded, xmlGen } from './xml-session.mjs'

const QUERY_URL = 'queryNodeEncodeInfo'
const EDIT_URL = 'editNodeEncodeInfo' // writes: only an admin's confirmed change
const OUT_BYTES = 2 * 1024 * 1024 // the all-channel answer is ~33 KB per channel
// queryNodeEncodeInfo is heavy and over a slow P2P/relay link takes far longer than the SDK's 20 s
// default (sdk.mjs budgetOf): the read then times out and the panel falls back to a read-only
// resolution with no editable controls at all. This read is interactive — the user is waiting on the
// stream-settings panel — so it is given a long budget (transparent's timeoutMs). That the budget is
// longer than XML_CAP_MS (nvr-xml.mjs, 90 s) is safe since the overlap fix (audit H1): when the cap
// passes it frees the per-NVR queue and the process-wide turn so other NVRs' calls go on, and refuses
// any further call to THIS NVR (503) until this one returns — it no longer lets a second call into the
// SDK beside it. (A 5 MP main over a NAT relay has been measured at ~3 min; 4 min leaves margin.)
const STREAM_READ_TIMEOUT_MS = 240_000
const CACHE_MS = 5000
const LOG_FILE = join(DATA_DIR, 'stream-changes.log')
const REQUIRE = '<requireField><name/><chlType/><mainCaps/><main/><an/><ae/><mn/><me/><mainStreamQualityCaps/><levelNote/></requireField>'
const LEVELS = ['lowest', 'lower', 'medium', 'higher', 'highest']
// What a change may set. bitType joined this list on 2026-09-25: every camera was encoding at a
// fixed rate around the clock, so an empty car park at 3am cost exactly as much bandwidth and disk
// as a busy one. On nvr-2 that was 32 cameras holding 128 Mb of a 192 Mb budget open permanently,
// which is why it refused streams and why eleven cameras recorded nothing. It also makes the
// recordings searchable: under a fixed rate, frame sizes carry no trace of what happened.
const KEYS = ['enct', 'res', 'fps', 'QoI', 'level', 'bitType']
const OVER_BANDWIDTH = '536871004'
export const TIMING = { verifyMs: 3000 } // tests shorten it
export const MIN_RETENTION_DAYS = 30 // site rule: recordings must go back at least 30 days

const list = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : [])
const px = (res) => String(res).split('x').map(Number).reduce((a, b) => a * b, 1)
const sameId = (a, b) => String(a).toUpperCase() === String(b).toUpperCase()

// ---- NVR answers ---------------------------------------------------------------------------

function parseEncode(xml) {
  const { response, status, errorCode } = parseAnswer(xml)
  const items = kids(kid(response, 'content'), 'item').map((item) => {
    const caps = kid(item, 'mainCaps')
    const attrsOf = (n) => (kid(item, n) ? { ...kid(item, n).attrs } : null)
    return {
      id: item.attrs.id,
      rtsp: item.attrs.isRTSPChl === 'true',
      name: (kid(item, 'name')?.text ?? '').trim(),
      chlType: kid(item, 'chlType')?.text.trim() ?? '',
      supEnct: list(caps?.attrs.supEnct),
      bitTypes: list(caps?.attrs.bitType),
      resolutions: kids(caps, 'res').map((r) => ({ res: r.text.trim(), fps: Number(r.attrs.fps) })),
      main: attrsOf('main'),
      an: attrsOf('an'),
      ae: attrsOf('ae'),
      mn: attrsOf('mn'),
      me: attrsOf('me'),
      qualityCaps: kids(kid(item, 'mainStreamQualityCaps'), 'item').map((q) => ({
        enct: q.attrs.enct,
        res: q.attrs.res,
        digitalDefault: q.attrs.digitalDefault,
        analogDefault: q.attrs.analogDefault,
        values: list(q.text).map(Number)
      })),
      levels: list(kid(item, 'levelNote')?.text)
    }
  })
  return { status, errorCode, items }
}

/** The stream as recorded in automatic mode (an = normal recording). */
const current = (item) => ({
  enct: normEnct(item.main?.enct),
  res: item.an?.res ?? '',
  fps: Number(item.an?.fps),
  QoI: Number(item.an?.QoI),
  level: item.an?.level ?? '',
  bitType: item.an?.bitType ?? ''
})
const STREAM_ATTRS = ['res', 'fps', 'QoI', 'bitType', 'level', 'audio', 'type']
const sameStream = (a, b) => Boolean(a && b) && STREAM_ATTRS.every((k) => String(a[k] ?? '') === String(b[k] ?? ''))

/** Bitrate choices for a codec and size (the page's list; on poeMode '10' at most 6144). */
function qoiList(item, sys, enct, res) {
  const values = [...qualityList(item, enct, res).values].sort((a, b) => a - b)
  return sys?.poeMode === '10' ? values.filter((v) => v <= 6144) : values
}
/** The NVR's own default bitrate for a codec and size. */
function digitalDefault(item, enct, res) {
  const d = Number(qualityList(item, enct, res).exact?.[item.chlType === 'analog' ? 'analogDefault' : 'digitalDefault'])
  return Number.isFinite(d) && d > 0 ? d : null
}

async function readAll(nvr, gen, fresh = false) {
  const hit = allCache.get(nvr.id)
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.info
  const info = parseEncode(await transparent(nvr, QUERY_URL, `${XML_HEADER}${REQUIRE}</request>`, 'main stream settings (all)', { gen, outBytes: OUT_BYTES, timeoutMs: STREAM_READ_TIMEOUT_MS }))
  if (info.status !== 'success') throw new HttpError(502, `The NVR refused to list its streams (${info.errorCode || info.status || 'no status'})`)
  allCache.set(nvr.id, { at: Date.now(), info })
  return info
}
const allCache = new Map() // nvr id -> { at, info }

/** One channel's stream settings, read fresh: per channel if the NVR allows, else from the list of all. */
async function readChannel(nvr, chlId, gen) {
  try {
    const xml = `${XML_HEADER}<condition><chlId>${esc(chlId)}</chlId></condition>${REQUIRE}</request>`
    const info = parseEncode(await transparent(nvr, QUERY_URL, xml, 'main stream settings', { gen, outBytes: OUT_BYTES, timeoutMs: STREAM_READ_TIMEOUT_MS }))
    const item = info.status === 'success' ? info.items.find((i) => sameId(i.id, chlId)) : null
    if (item) return item
  } catch (e) {
    if (xmlGen(nvr) !== gen) throw e
  }
  const item = (await readAll(nvr, gen, true)).items.find((i) => sameId(i.id, chlId))
  if (!item) throw new HttpError(502, 'The NVR lists no main stream for this camera')
  return item
}

/**
 * A read-only resolution for one channel from queryRecStatus, for when the heavy queryNodeEncodeInfo
 * times out over P2P. Fast and light; carries the main (and sub) resolution + fps, nothing editable.
 * @returns {Promise<null | { partial: true, current: {res, fps}, sub: string|null, why: string }>}
 */
async function recStatusResolution(nvr, ch, gen) {
  try {
    const m = parseRecStatus(await transparent(nvr, 'queryRecStatus', `${XML_HEADER}</request>`, 'rec status (resolution)', { gen, outBytes: 256 * 1024 }))
    const row = m?.get(ch)
    const main = row?.main ?? row?.sub
    if (!main) return null
    return {
      partial: true,
      current: { res: main.resolution, fps: main.fps },
      sub: row.main && row.sub ? row.sub.resolution : null,
      why: 'the NVR did not return its full stream settings over this link; this is the resolution it is recording at'
    }
  } catch {
    return null
  }
}

/** Record mode, cycle recording, bandwidth and PoE mode (each may be missing). Cached 5 s. */
async function readSystem(nvr, gen) {
  const hit = sysCache.get(nvr.id)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.sys
  const ask = async (url) => {
    try {
      const a = parseAnswer(await transparent(nvr, url, `${XML_HEADER}</request>`, url, { gen }))
      return a.status === 'success' ? kid(a.response, 'content') : null
    } catch (e) {
      if (xmlGen(nvr) !== gen) throw e
      return null
    }
  }
  const rec = await ask('queryRecordDistributeInfo')
  const caps = await ask('querySystemCaps')
  const net = await ask('queryNetCfgV2')
  const text = (n, ...path) => path.reduce((x, name) => kid(x, name), n)?.text.trim() ?? null
  const num = (v) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const sys = {
    recMode: text(rec, 'recMode', 'mode'),
    loopRecSwitch: text(rec, 'loopRecSwitch') === 'true',
    doubleStreamRecSwitch: text(rec, 'doubleStreamRecSwitch') === 'true',
    totalBandwidth: num(text(caps, 'totalBandwidth')), // Mbit/s
    usedTotalBandwidth: num(text(caps, 'usedTotalBandwidth')), // kbit/s
    mainStreamLimitFps: num(text(caps, 'mainStreamLimitFps')),
    poeMode: text(net, 'poeMode')
  }
  sysCache.set(nvr.id, { at: Date.now(), sys })
  return sys
}
const sysCache = new Map()

// ---- what may change ---------------------------------------------------------------------------

/** Why this camera's stream can't be changed here, or null. usage: measured kbps / cap (from the panel). */
function whyNot(item, sys, online, usage) {
  if (item.chlType === 'recorder') return 'it comes from another recorder'
  if (item.rtsp) return 'it is an RTSP channel'
  if (item.chlType !== 'digital') return 'it is not a network camera'
  if (!online || item.resolutions.length === 0) return 'the camera is offline'
  if (sys.recMode !== 'auto') return sys.recMode ? 'the NVR records in manual mode: stream changes for it are not supported yet' : 'the NVR\'s record mode could not be read'
  if (!item.an || !item.ae || !item.main) return 'the NVR reports no recording stream for it'
  if (!['VBR', 'CBR'].includes(item.an.bitType)) return 'the NVR reports no bitrate type for this camera'
  if (!sameStream(item.an, item.ae)) return 'its normal and event recording streams differ: change them on the NVR'
  if (typeof usage === 'number' && Number.isFinite(usage) && usage > 1.2) return `the camera does not keep to its bitrate cap (it sends ${usage.toFixed(2)}× the cap)`
  return null
}

/** The only codec moves offered (plan S4, S6): off the smart codec, and H.264 up to H.265. */
const CODEC_MOVES = new Set(['h265p>h265', 'h264>h265'])

/**
 * The stream after a change, checked against what the camera offers. Refuses anything that
 * lowers the cap, frame rate, quality level or resolution, any codec move but H.265+ -> H.265
 * and H.264 -> H.265 (to H.264, or to a smart codec, is a lower quality at the same cap), and
 * more pixels or frames without a bitrate raised in proportion (each would get fewer bits).
 * undoTo: Undo sets exactly these logged values (it may lower).
 */
function planChange(item, sys, change, { undoTo = null, allowLowerRes = false } = {}) {
  const cur = current(item)
  let next
  if (undoTo) next = { ...cur, ...Object.fromEntries(KEYS.filter((k) => k in undoTo).map((k) => [k, undoTo[k]])) }
  else {
    if (!isPlainObject(change) || Object.keys(change).length === 0) throw new HttpError(400, 'change must name what to change')
    for (const k of Object.keys(change)) if (!KEYS.includes(k)) throw new HttpError(400, `${k} cannot be changed here`)
    next = { ...cur, ...change }
  }
  const bad = (why) => {
    throw new HttpError(400, `Refused: ${why}`)
  }
  const enct = item.supEnct.find((e) => normEnct(e) === normEnct(next.enct))
  if (!enct) bad(`codec ${next.enct} is not offered by this camera`)
  next.enct = normEnct(enct)
  const res = item.resolutions.find((r) => r.res === next.res)
  if (!res) bad(`resolution ${next.res} is not offered`)
  // (mainStreamLimitFps is the NVR's lowest allowed main-stream frame rate, not a maximum)
  if (!Number.isInteger(next.fps) || next.fps < 1 || (res.fps && next.fps > res.fps) || (sys.mainStreamLimitFps && next.fps < sys.mainStreamLimitFps)) bad(`frame rate ${next.fps}`)
  const choices = qoiList(item, sys, next.enct, next.res)
  if (!Number.isInteger(next.QoI) || !choices.includes(next.QoI)) bad(`bitrate ${next.QoI} is not one of the NVR's choices${sys.poeMode === '10' ? ' (at most 6144 on this NVR\'s PoE mode)' : ''}`)
  if (!item.levels.includes(next.level)) bad(`quality level ${next.level}`)
  if (!['VBR', 'CBR'].includes(cur.bitType)) bad('the NVR reports no bitrate type for this camera')
  // The camera's own list, not a guess: a model that only does one of the two must not be asked
  // for the other. An NVR that does not report the list at all is taken at its word for what the
  // camera is set to now, and nothing else is offered.
  if (!['VBR', 'CBR'].includes(next.bitType)) bad(`bitrate type ${next.bitType}`)
  const offered = item.bitTypes?.length ? item.bitTypes : [cur.bitType]
  if (!offered.includes(next.bitType)) bad(`bitrate type ${next.bitType} is not offered by this camera (it offers ${offered.join(', ')})`)
  if (!undoTo) {
    if (next.QoI < cur.QoI) bad('this never lowers the bitrate cap (Undo can put back a raise)')
    if (next.fps < cur.fps) bad('this never lowers the frame rate')
    if (LEVELS.indexOf(next.level) < LEVELS.indexOf(cur.level)) bad('this never lowers the quality level')
    if (next.enct !== cur.enct && !CODEC_MOVES.has(`${cur.enct}>${next.enct}`)) bad(`this changes the codec only from H.265+ to H.265 or from H.264 to H.265, not ${cur.enct} to ${next.enct} (a lower quality at the same cap)`)
    if (!allowLowerRes && next.res !== cur.res && px(next.res) < px(cur.res)) bad('this never lowers the resolution')
    // more pixels or frames at the same cap means fewer bits for each: only with the cap raised
    // in proportion (rounded up to a list step; the top step when the list ends)
    const ratio = (px(next.res) / px(cur.res)) * (next.fps / cur.fps)
    if (ratio > 1) {
      const want = cur.QoI * ratio
      const need = choices.find((v) => v >= want) ?? choices.at(-1)
      const what = next.res !== cur.res && next.fps !== cur.fps ? 'a bigger picture at more frames' : next.res !== cur.res ? 'a bigger picture' : 'more frames per second'
      if (next.QoI < need) bad(`${what} needs the bitrate raised with it (${cur.QoI} × ${ratio.toFixed(2)} → at least ${need} kbps)`)
    }
  }
  return { cur, next }
}

/** editNodeEncodeInfo for one channel, as the page's getSaveData writes it, every other attribute echoed. */
function buildEdit(item, next) {
  const s = (x) =>
    // bitType follows `next` like the other settings, falling back to whatever this element already
    // had. Under CBR the QoI figure is the rate the camera holds constantly; under VBR it becomes a
    // ceiling it stays under, so the same number means something different either side of a switch
    // -- which is why the change is stated in those words rather than as a bare setting.
    `res="${esc(next.res)}" fps="${esc(next.fps)}" QoI="${esc(next.QoI)}" audio="${esc(x.audio ?? '')}" type="${esc(x.type ?? '')}" bitType="${esc(next.bitType || x.bitType || 'CBR')}" level="${esc(next.level)}"`
  const gop = item.main?.aGOP ? item.main.aGOP : String(4 * Number(next.fps))
  const enct = item.supEnct.find((e) => normEnct(e) === normEnct(next.enct)) ?? next.enct
  return (
    `${XML_HEADER}<content type="list" total="1"><item id="${esc(item.id)}">` +
    `<an ${s(item.an)}></an><ae ${s(item.ae)}></ae><main enct="${esc(enct)}" aGOP="${esc(gop)}" ></main>` +
    `</item></content></request>`
  )
}

/** Channels the page lists in its storage estimate (not from another recorder, camera online). */
const enabled = (i) => i.chlType !== 'recorder' && i.resolutions.length > 0 && i.an && Number.isFinite(Number(i.an.QoI))

/** queryRemainRecTime with every enabled channel's cap, one of them replaced. */
function buildRemain(items, replace = {}) {
  const rows = items.filter(enabled).map((i) => `<item id="${esc(i.id)}"><QoI>${esc(replace[i.id] ?? i.an.QoI)}</QoI></item>`)
  return `${XML_HEADER}<content><recMode type="recModeType">auto</recMode><streamType type="streamType">Main</streamType><chls type="list">${rows.join('')}</chls></content></request>`
}
function parseRemain(xml) {
  const { response, status, errorCode } = parseAnswer(xml)
  if (status !== 'success') return { ok: false, errorCode }
  return {
    ok: true,
    groups: kids(kid(response, 'content'), 'item').map((i) => ({ days: Number(kid(i, 'remainRecTime')?.text.trim()), group: kid(i, 'diskGroupIndex')?.text.trim() ?? null }))
  }
}

/**
 * The site's minimum recording retention, on the NVR's estimate (it assumes every camera at its
 * cap, so only a raised cap can shorten it). Returns null when allowed, else the reason. A disk
 * group whose days fall below the minimum refuses the change; so does a raise the NVR can't
 * estimate (cycle recording, or no answer), since the minimum can't be confirmed then.
 */
function retentionRefusal(cur, next, before, after, cycle) {
  if (!(Number(next.QoI) > Number(cur.QoI))) return null
  const known = before.ok && after.ok && !cycle && before.groups.length > 0 && before.groups.length === after.groups.length && [...before.groups, ...after.groups].every((g) => Number.isFinite(g.days))
  if (!known) return `the NVR's recording-time estimate is not available${cycle ? ' (cycle recording)' : ''}, so the site's minimum of ${MIN_RETENTION_DAYS} days of recordings can't be confirmed`
  const low = after.groups.filter((g, i) => g.days < before.groups[i].days && g.days < MIN_RETENTION_DAYS)
  if (!low.length) return null
  return `the NVR estimates ${low.map((g) => `${g.days} days${after.groups.length > 1 ? ` (disk group ${g.group ?? '?'})` : ''}`).join(', ')} of recordings after it, under the site's minimum of ${MIN_RETENTION_DAYS}`
}

/** The NVR's storage estimate with every enabled channel, now and with this channel's new cap. */
async function storageEstimate(nvr, gen, item, sys, next) {
  const all = await readAll(nvr, gen)
  const remain = async (replace) => {
    try {
      return parseRemain(await transparent(nvr, 'queryRemainRecTime', buildRemain(all.items, replace), 'storage estimate', { gen }))
    } catch (e) {
      if (xmlGen(nvr) !== gen) throw e
      return { ok: false, errorCode: e.message }
    }
  }
  const before = await remain({})
  const after = await remain({ [item.id]: next.QoI })
  const cycle = sys.loopRecSwitch && [before, after].some((x) => x.ok && x.groups.some((g) => g.days === 0))
  return { all, before, after, cycle }
}

const gbPerDay = (kbps) => Math.round(((kbps * 86400) / 8e6) * 10) / 10
/** The worst case the NVR's estimate can't show: it assumes every camera at its cap. */
function worstCase(cur, next, measuredKbps) {
  const M = typeof measuredKbps === 'number' && Number.isFinite(measuredKbps) && measuredKbps >= 0 ? Math.round(measuredKbps) : null
  const [C, C2] = [cur.QoI, next.QoI]
  if (M === null) return { measuredKbps: null, capKbps: C, newCapKbps: C2, extraKbps: null, gbPerDay: null, text: `The NVR's estimate assumes this camera sends its full cap (${C2} kbit/s); measure the stream to see what it sends now.` }
  if (C2 !== C) {
    const extra = Math.max(0, C2 - M)
    return { measuredKbps: M, capKbps: C, newCapKbps: C2, extraKbps: extra, gbPerDay: gbPerDay(extra), text: `This camera now sends ${M} of ${C} kbit/s. After the change it may send up to ${C2}: +${extra} kbit/s = +${gbPerDay(extra)} GB/day.` }
  }
  const extra = Math.max(0, C - M)
  return { measuredKbps: M, capKbps: C, newCapKbps: C2, extraKbps: extra, gbPerDay: gbPerDay(extra), text: `The NVR's estimate assumes every camera at its cap and does not change; real use may rise by up to ${extra} kbit/s (+${gbPerDay(extra)} GB/day).` }
}

const tokenOf = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
const sortObj = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

function impactsOf(cur, next) {
  const changed = KEYS.filter((k) => String(cur[k]) !== String(next[k]))
  const other = [
    next.level !== cur.level ? `quality level ${cur.level} → ${next.level}` : null,
    next.enct !== cur.enct ? `codec ${cur.enct} → ${next.enct}` : null,
    next.fps !== cur.fps ? `${cur.fps} → ${next.fps} fps` : null,
    next.res !== cur.res ? `${cur.res} → ${next.res}` : null
  ].filter(Boolean)
  const also = other.length ? ` (with ${other.join(', ')})` : ''
  let text
  if (next.QoI < cur.QoI) text = `Recording uses up to ${next.QoI} instead of ${cur.QoI} kbit/s for this camera${also}: a lower picture quality again, and the NVR keeps more days of recordings.` // only an Undo lowers
  else if (next.QoI > cur.QoI) text = `Recording uses up to ${next.QoI} instead of ${cur.QoI} kbit/s for this camera${also}: the NVR keeps fewer days of recordings.`
  else if (!other.length) text = `Nothing changes (${cur.QoI} kbit/s).`
  else if (next.enct !== cur.enct && cur.enct === 'h264' && other.length === 1) text = `The cap stays at ${cur.QoI} kbit/s and H.265 gives a better picture for it; recordings take about as much space as now when the camera sends its full cap.`
  else text = `The cap stays at ${cur.QoI} kbit/s, but with ${other.join(', ')} the camera sends closer to it (up to its full cap): the NVR may keep fewer days of recordings.`
  const out = [{ key: 'storage', text, paths: changed }]
  if (cur.enct !== next.enct || cur.res !== next.res) out.push({ key: 'encoder-restart', text: 'The camera restarts its encoder: a few seconds without video or recording.', paths: ['enct', 'res'].filter((k) => cur[k] !== next[k]) })
  return out
}

// ---- change log --------------------------------------------------------------------------------

function writeLog(entry) {
  mkdirSync(dirname(LOG_FILE), { recursive: true })
  appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}
const readLog = () => readLogCached(LOG_FILE).filter((e) => typeof e.seq === 'string')
const pick = (s) => Object.fromEntries(KEYS.map((k) => [k, s[k]]))
const sameKeys = (a, b) => KEYS.every((k) => String(a?.[k] ?? '') === String(b?.[k] ?? ''))

/** The newest stream change to this channel not undone yet, if the stream still is as it left it. */
function undoable(log, device, chlId, item) {
  const mine = log.filter((e) => e.kind === 'change' && e.device === device && sameId(e.chl, chlId))
  const results = new Map(log.filter((e) => e.kind === 'result').map((e) => [e.seq, e]))
  const undone = new Set(mine.filter((e) => e.action === 'undo' && results.get(e.seq)?.result === 'done').map((e) => e.undoes))
  const last = mine.filter((e) => e.action === 'change' && !undone.has(e.seq)).at(-1)
  if (!last) return null
  const r = results.get(last.seq)
  if (r?.result === 'failed') return null
  return sameKeys(pick(current(item)), r?.after ?? last.to) ? last : null
}

// ---- API -----------------------------------------------------------------------------------------

function streamView(ctx, item, sys, usage) {
  const cur = current(item)
  const why = whyNot(item, sys, ctx.online, usage)
  const choices = cur.res ? qoiList(item, sys, cur.enct, cur.res) : []
  const last = undoable(readLog(), ctx.device, ctx.chlId, item)
  return {
    id: item.id,
    name: item.name,
    chlType: item.chlType,
    caps: { supEnct: item.supEnct.map(normEnct), bitTypes: item.bitTypes, resolutions: item.resolutions, levels: item.levels },
    main: item.main ? { enct: cur.enct, aGOP: item.main.aGOP ?? null, mGOP: item.main.mGOP ?? null } : null,
    recMode: sys.recMode,
    pair: sys.recMode === 'manually' ? 'mn/me' : 'an/ae',
    stream: sys.recMode === 'manually' ? item.mn : item.an,
    event: sys.recMode === 'manually' ? item.me : item.ae,
    current: cur,
    qoiList: choices,
    // the bitrate choices for each offered size (current codec), so the panel's resolution picker
    // can raise the cap in step with a bigger picture without a round trip per size
    qoiByRes: Object.fromEntries(item.resolutions.map((r) => [r.res, qoiList(item, sys, cur.enct, r.res)])),
    digitalDefault: cur.res ? digitalDefault(item, cur.enct, cur.res) : null,
    // the page's "recommended range" for VBR
    bitrateRange: cur.bitType === 'VBR' && cur.res ? recommendedRange({ res: cur.res, level: cur.level, fps: cur.fps, enct: cur.enct }, choices.at(-1)) : null,
    candidate: why === null,
    why,
    followsCapChecked: typeof usage === 'number',
    system: { loopRecSwitch: sys.loopRecSwitch, totalBandwidthMbps: sys.totalBandwidth, usedBandwidthKbps: sys.usedTotalBandwidth, mainStreamLimitFps: sys.mainStreamLimitFps, poeMode: sys.poeMode },
    undo: last ? { seq: last.seq, at: last.at, by: last.user, puts: KEYS.filter((k) => String(last.from[k]) !== String(last.to[k])).map((k) => `${k} ${last.from[k]}`).join(', ') } : null
  }
}

async function estimate(ctx, body) {
  const { nvr, chlId, gen } = ctx
  const item = await readChannel(nvr, chlId, gen)
  const sys = await readSystem(nvr, gen)
  const { cur, next } = planChange(item, sys, body.change)
  // the NVR's storage estimate, with every enabled channel, before and after
  const { all, before, after, cycle } = await storageEstimate(nvr, gen, item, sys, next)
  const refused = retentionRefusal(cur, next, before, after, cycle)
  const sum = (replace) => all.items.filter(enabled).reduce((n, i) => n + Number(replace[i.id] ?? i.an.QoI), 0)
  const used = sys.usedTotalBandwidth
  const total = sys.totalBandwidth
  const free = (u) => (total === null || u === null ? null : Math.max(0, Math.round(((1024 * total - u) / 1024) * 10) / 10))
  return {
    from: cur,
    to: next,
    bandwidth: { totalMbps: total, freeBeforeMbps: free(used), freeAfterMbps: free(used === null ? null : used + (next.QoI - cur.QoI)) },
    remain: {
      before: before.ok ? before.groups : null,
      after: after.ok ? after.groups : null,
      error: before.ok && after.ok ? null : before.errorCode || after.errorCode || 'no answer',
      cycle, // cycle recording: the NVR answers 0 days, so the ratio of all caps is shown instead
      ratio: Math.round((sum({}) / sum({ [item.id]: next.QoI })) * 1000) / 1000
    },
    retention: { minDays: MIN_RETENTION_DAYS, refused: refused ? `Refused: ${refused}.` : null },
    worstCase: worstCase(cur, next, body.measuredKbps),
    impacts: impactsOf(cur, next)
  }
}

async function apply(ctx, body) {
  const { nvr, chlId, gen, device, user } = ctx
  const item = await readChannel(nvr, chlId, gen)
  const sys = await readSystem(nvr, gen)
  const why = whyNot(item, sys, ctx.online)
  if (why) throw new HttpError(400, `This camera's stream can't be changed here: ${why}`)
  const log = readLog()
  let plan
  let action = 'change'
  let undoes
  if (body.undo === true) {
    const last = undoable(log, device, chlId, item)
    if (!last || last.seq !== body.seq) throw new HttpError(409, 'Someone changed this stream since; reopen the panel')
    plan = planChange(item, sys, null, { undoTo: last.from })
    action = 'undo'
    undoes = last.seq
  } else {
    const now = current(item)
    if (!isPlainObject(body.seen) || !KEYS.every((k) => k in body.seen)) throw new HttpError(400, `seen must list the stream shown (${KEYS.join(', ')})`)
    const stale = KEYS.filter((k) => String(body.seen[k]) !== String(now[k]))
    if (stale.length) throw new HttpError(409, `The stream changed since you looked (${stale.map((k) => `${k} is now ${now[k]}`).join(', ')}); nothing was sent`, { stale: stale.map((k) => ({ path: k, now: now[k] })) })
    plan = planChange(item, sys, body.change)
  }
  const { cur, next } = plan
  if (sameKeys(cur, next)) return { status: 'done', message: 'Nothing to change' }
  if (Number(next.QoI) > Number(cur.QoI)) {
    // the site's retention minimum, asked of the NVR again now: nothing is sent below it
    const { before, after, cycle } = await storageEstimate(nvr, gen, item, sys, next)
    const refused = retentionRefusal(cur, next, before, after, cycle)
    if (refused) throw new HttpError(400, `Refused: ${refused}. Nothing was sent.`)
  }
  const list = impactsOf(cur, next)
  const token = tokenOf([device, chlId, 'stream', action, sortObj(pick(cur)), sortObj(pick(next)), list.map((i) => [i.key, i.text])])
  const ack = Array.isArray(body.ack) ? body.ack : []
  if (body.ackToken !== token || !list.every((i) => ack.includes(i.key))) throw new HttpError(409, 'This change needs your confirmation', { needsAck: list, ackToken: token })
  if (xmlDegraded(nvr) || xmlGen(nvr) !== gen) throw new HttpError(409, `${nvr.name} is busy or reconnected; nothing was sent`)
  return writeChange(ctx, item, cur, next, list, { action, undoes })
}

/**
 * Writes one planned change, waits, reads the channel back to verify, and logs the before and the
 * result (so Undo can put it back). Returns { seq, status, message }. Shared by the single-camera
 * apply above and the bulk optimiser below; the caller does the gating (seen/ack, retention) first.
 */
async function writeChange(ctx, item, cur, next, list, { action = 'change', undoes } = {}) {
  const { nvr, chlId, gen, device, user } = ctx
  const seq = newSeq()
  // write-ahead: if the "before" can't be recorded, nothing is sent
  writeLog({ kind: 'change', seq, at: new Date().toISOString(), user, nvr: nvr.id, device, nvrName: nvr.name, chl: chlId, ch: ctx.ch + 1, name: ctx.name, action, undoes, from: pick(cur), to: pick(next), ack: list.map((i) => i.key), before: { main: item.main, an: item.an, ae: item.ae } })
  console.log(`[streams] ${nvr.id} ch${ctx.ch + 1} "${ctx.name}": ${KEYS.filter((k) => String(cur[k]) !== String(next[k])).map((k) => `${k} ${cur[k]} -> ${next[k]}`).join(', ')} (${action}, by ${user})`)
  let a
  let timedOut = false
  try {
    a = parseAnswer(await transparent(nvr, EDIT_URL, buildEdit(item, next), 'main stream change', { gen }))
  } catch (e) {
    timedOut = e?.name === 'SdkTimeout'
    a = { status: timedOut ? 'no answer in time' : 'error', errorCode: e.message }
  }
  if (timedOut) await settled(nvr)
  await sleep(TIMING.verifyMs)
  allCache.delete(nvr.id)
  sysCache.delete(nvr.id)
  let after = null
  try {
    after = pick(current(await readChannel(nvr, chlId, gen)))
  } catch {}
  const result = !after ? 'unknown' : sameKeys(after, next) ? 'done' : 'failed'
  try {
    writeLog({ kind: 'result', seq, at: new Date().toISOString(), result, answer: a.status, errorCode: a.errorCode || undefined, after })
    rotateLog(LOG_FILE)
  } catch (e) {
    console.warn(`[streams] result not logged: ${e.message}`)
  }
  const message =
    result === 'done' ? (action === 'undo' ? 'Undone' : 'Applied')
      : result === 'unknown' ? 'Sent, but the stream could not be read back; reopen this panel'
        : a.errorCode === OVER_BANDWIDTH ? 'Not changed: over the NVR\'s bandwidth limit'
          : a.status === 'success' ? 'The NVR accepted it, but the camera kept its stream settings'
            : `Not changed: the NVR refused (${a.errorCode || a.status})`
  return { seq, status: result, message }
}

// ---- bulk optimiser: bring every camera to H.265 + VBR -------------------------------------------
// The two storage wins that cost no picture quality: H.264 -> H.265 (about half the bitrate for the
// same quality) and CBR -> VBR (a still scene stops paying its full rate). Both keep the bitrate cap,
// so neither raises bandwidth nor shortens recordings, and both go through planChange like any other
// change. Cameras already there are left alone; so are H.265+/smart ones -- those are already the most
// compressed, and this never moves off a smart codec (which would make recordings bigger).

/** The H.265 + VBR change for one camera, or why it is skipped. `online` from nvr.channels. */
function optimisePlan(item, sys, online) {
  const why = whyNot(item, sys, online)
  if (why) return { skip: why }
  const cur = current(item)
  const change = {}
  if (cur.enct === 'h264' && item.supEnct.some((e) => normEnct(e) === 'h265')) change.enct = 'h265'
  if (cur.bitType === 'CBR' && (item.bitTypes.length === 0 || item.bitTypes.includes('VBR'))) change.bitType = 'VBR'
  if (Object.keys(change).length === 0) return { skip: `already ${(cur.enct || '?').toUpperCase()} + ${cur.bitType || '?'}` }
  try {
    const { next } = planChange(item, sys, change)
    const moves = KEYS.filter((k) => String(cur[k]) !== String(next[k])).map((k) => `${k} ${cur[k]}→${next[k]}`)
    return { change, from: pick(cur), to: pick(next), moves }
  } catch (e) {
    return { skip: e.message.replace(/^Refused: /, '') }
  }
}

/** Dry run: what the optimiser would change on this NVR, per camera. No writes. */
async function optimiseList(nvr, gen) {
  const sys = await readSystem(nvr, gen)
  const all = await readAll(nvr, gen, true)
  return all.items.map((item) => {
    const ch = chOfGuid(item.id)
    const online = ch === null ? true : nvr.channels.find((c) => c.ch === ch)?.online !== false
    const p = optimisePlan(item, sys, online)
    return { ch: ch === null ? null : ch + 1, name: item.name, moves: p.moves ?? null, from: p.from ?? null, to: p.to ?? null, skip: p.skip ?? null }
  })
}

/** Applies the H.265 + VBR change to every eligible camera on this NVR, one at a time (under the NVR lock). */
async function optimiseApply(ctx) {
  const { nvr, gen } = ctx
  const sys = await readSystem(nvr, gen)
  const all = await readAll(nvr, gen, true)
  const results = []
  for (const listed of all.items) {
    if (xmlGen(nvr) !== gen || nvr.stopped) break
    const ch = chOfGuid(listed.id)
    const online = ch === null ? true : nvr.channels.find((c) => c.ch === ch)?.online !== false
    const plan0 = optimisePlan(listed, sys, online)
    const row = { ch: ch === null ? null : ch + 1, name: listed.name }
    if (!plan0.change) {
      results.push({ ...row, status: 'skipped', message: plan0.skip })
      continue
    }
    // a fresh read right before writing, in case the camera changed since the list read
    let item, cur, next
    try {
      item = await readChannel(nvr, listed.id, gen)
      ;({ cur, next } = planChange(item, sys, plan0.change))
    } catch (e) {
      results.push({ ...row, status: 'skipped', message: String(e?.message ?? e).replace(/^Refused: /, '') })
      continue
    }
    if (sameKeys(cur, next)) {
      results.push({ ...row, status: 'skipped', message: 'already set' })
      continue
    }
    const res = await writeChange({ ...ctx, ch, chlId: listed.id, name: item.name }, item, cur, next, impactsOf(cur, next))
    results.push({ ...row, status: res.status, message: res.message, moves: KEYS.filter((k) => String(cur[k]) !== String(next[k])).map((k) => `${k} ${cur[k]}→${next[k]}`) })
  }
  return results
}

/**
 * POST /api/admin/nvrs/:id/streams/optimise  { confirm?: true }
 * Without confirm: a dry-run plan (what would change, per camera). With confirm: applies it, one
 * camera at a time under the NVR lock. Only ever H.264->H.265 and CBR->VBR (quality kept, cap kept).
 * @returns {Promise<[number, any]>}
 */
export async function handleStreamOptimise(method, nvrId, readJson, user) {
  try {
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    const nvr = nvrs.get(nvrId)
    if (!nvr) return [404, { error: 'Unknown NVR' }]
    requireOnline(nvr)
    const body = await readJson()
    if (!isPlainObject(body)) throw new HttpError(400, 'The request must be a JSON object')
    const gen = xmlGen(nvr)
    if (body.confirm !== true) return [200, { nvr: nvr.id, name: nvr.name, dryRun: true, cameras: await optimiseList(nvr, gen) }]
    const ctx = { nvr, gen, user, device: deviceOf(nvr) }
    const results = await withNvrLock(nvr, 'H.265 + VBR optimise', () => optimiseApply(ctx))
    return [200, { nvr: nvr.id, name: nvr.name, applied: true, results }]
  } catch (e) {
    return errorAnswer(e)
  }
}

// ---- resolution cap: bring oversized cameras down (e.g. 8 MP -> 4 MP) to save disk --------------
// Unlike every other change here, this LOWERS quality on purpose, so it is the one place planChange is
// asked to allow a drop (allowLowerRes) -- and only the main resolution, never bitrate, fps or codec.
// The encoder restarts and the recorded picture carries less detail from here on; the caller confirms it.

const MP = (res) => px(res) / 1e6

/** The best resolution the camera offers below its current and at or under maxPx pixels, or null. */
function downTarget(item, curRes, maxPx) {
  const curPx = px(curRes)
  return (
    item.resolutions
      .map((r) => r.res)
      .filter((r) => px(r) < curPx && px(r) <= maxPx)
      .sort((a, b) => px(b) - px(a))[0] ?? null
  )
}

/** The resolution change for one camera to fit under maxPx (e.g. 4 MP), or why it is skipped. */
function capPlan(item, sys, online, maxPx) {
  const why = whyNot(item, sys, online)
  if (why) return { skip: why }
  const cur = current(item)
  if (px(cur.res) <= maxPx) return { skip: `already ${MP(cur.res).toFixed(1)} MP (${cur.res})` }
  const target = downTarget(item, cur.res, maxPx)
  if (!target) return { skip: `the camera offers no resolution under ${(maxPx / 1e6).toFixed(1)} MP` }
  try {
    const { next } = planChange(item, sys, { res: target }, { allowLowerRes: true })
    const moves = KEYS.filter((k) => String(cur[k]) !== String(next[k])).map((k) => `${k} ${cur[k]}→${next[k]}`)
    return { change: { res: target }, from: pick(cur), to: pick(next), moves, mp: `${MP(cur.res).toFixed(1)}→${MP(target).toFixed(1)} MP` }
  } catch (e) {
    return { skip: e.message.replace(/^Refused: /, '') }
  }
}

/** Dry run: which cameras on this NVR are over the cap and what they'd become. No writes. */
async function capList(nvr, gen, maxPx) {
  const sys = await readSystem(nvr, gen)
  const all = await readAll(nvr, gen, true)
  return all.items.map((item) => {
    const ch = chOfGuid(item.id)
    const online = ch === null ? true : nvr.channels.find((c) => c.ch === ch)?.online !== false
    const p = capPlan(item, sys, online, maxPx)
    return { ch: ch === null ? null : ch + 1, name: item.name, mp: p.mp ?? null, moves: p.moves ?? null, from: p.from ?? null, to: p.to ?? null, skip: p.skip ?? null }
  })
}

/** Caps the main resolution of every over-cap camera on this NVR, one at a time (under the NVR lock). */
async function capApply(ctx, maxPx) {
  const { nvr, gen } = ctx
  const sys = await readSystem(nvr, gen)
  const all = await readAll(nvr, gen, true)
  const results = []
  for (const listed of all.items) {
    if (xmlGen(nvr) !== gen || nvr.stopped) break
    const ch = chOfGuid(listed.id)
    const online = ch === null ? true : nvr.channels.find((c) => c.ch === ch)?.online !== false
    const plan0 = capPlan(listed, sys, online, maxPx)
    const row = { ch: ch === null ? null : ch + 1, name: listed.name }
    if (!plan0.change) {
      results.push({ ...row, status: 'skipped', message: plan0.skip })
      continue
    }
    let item, cur, next
    try {
      item = await readChannel(nvr, listed.id, gen)
      ;({ cur, next } = planChange(item, sys, plan0.change, { allowLowerRes: true }))
    } catch (e) {
      results.push({ ...row, status: 'skipped', message: String(e?.message ?? e).replace(/^Refused: /, '') })
      continue
    }
    if (sameKeys(cur, next)) {
      results.push({ ...row, status: 'skipped', message: 'already set' })
      continue
    }
    const res = await writeChange({ ...ctx, ch, chlId: listed.id, name: item.name }, item, cur, next, impactsOf(cur, next))
    results.push({ ...row, status: res.status, message: res.message, mp: plan0.mp })
  }
  return results
}

/**
 * POST /api/admin/nvrs/:id/streams/cap-resolution  { maxMp?: number, confirm?: true }
 * Lowers the MAIN resolution of cameras above the cap (default 4 MP) to the camera's best option at or
 * under it -- e.g. 8 MP -> 4 MP. This REDUCES recorded quality from here on, so it needs confirm:true and
 * the UI makes that plain. Without confirm: a dry-run plan. One camera at a time under the NVR lock.
 * @returns {Promise<[number, any]>}
 */
export async function handleStreamCapResolution(method, nvrId, readJson, user) {
  try {
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    const nvr = nvrs.get(nvrId)
    if (!nvr) return [404, { error: 'Unknown NVR' }]
    requireOnline(nvr)
    const body = await readJson()
    if (!isPlainObject(body)) throw new HttpError(400, 'The request must be a JSON object')
    const maxMp = Number.isFinite(Number(body.maxMp)) && Number(body.maxMp) >= 1 && Number(body.maxMp) <= 12 ? Number(body.maxMp) : 4
    const maxPx = Math.round(maxMp * 1e6)
    const gen = xmlGen(nvr)
    if (body.confirm !== true) return [200, { nvr: nvr.id, name: nvr.name, maxMp, dryRun: true, cameras: await capList(nvr, gen, maxPx) }]
    const ctx = { nvr, gen, user, device: deviceOf(nvr) }
    const results = await withNvrLock(nvr, `cap resolution at ${maxMp} MP`, () => capApply(ctx, maxPx))
    return [200, { nvr: nvr.id, name: nvr.name, maxMp, applied: true, results }]
  } catch (e) {
    return errorAnswer(e)
  }
}

/**
 * /channels/:ch/stream and /channels/:ch/stream/estimate.
 * @returns {Promise<[number, any]>}
 */
export async function handleStreams(what, method, nvrId, ch, params, readJson, user) {
  try {
    const { nvr, chlId, name } = cameraOf(nvrs, nvrId, ch)
    requireOnline(nvr)
    const online = nvr.channels.find((c) => c.ch === ch)?.online !== false
    const ctx = { nvr, ch, chlId, name, gen: xmlGen(nvr), user, device: deviceOf(nvr), online }
    if (what === 'estimate') {
      if (method !== 'POST') return [405, { error: 'Method not allowed' }]
      const body = await readJson()
      if (!isPlainObject(body)) throw new HttpError(400, 'The request must be a JSON object')
      return [200, { estimate: await estimate(ctx, body) }]
    }
    if (method === 'GET') {
      const u = params.get('usage')
      const usage = u === null || u === '' ? undefined : Number(u)
      if (usage !== undefined && !Number.isFinite(usage)) throw new HttpError(400, 'Bad usage')
      let item
      try {
        item = await readChannel(nvr, chlId, ctx.gen)
      } catch (e) {
        // queryNodeEncodeInfo is heavy (~500 KB/channel) and times out over P2P. Rather than show
        // nothing, fall back to the resolution the recorder reports (queryRecStatus, ~fast), marked
        // as read-only. The full, editable settings still need the NVR on a fatter link.
        if (xmlGen(nvr) !== ctx.gen) throw e
        const partial = await recStatusResolution(nvr, ch, ctx.gen)
        if (partial) return [200, { stream: partial }]
        throw e
      }
      return [200, { stream: streamView(ctx, item, await readSystem(nvr, ctx.gen), usage) }]
    }
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    const body = await readJson()
    if (!isPlainObject(body)) throw new HttpError(400, 'The request must be a JSON object')
    if (body.confirm !== true) throw new HttpError(400, 'Changes need confirm: true')
    if (body.device !== ctx.device) throw new HttpError(409, 'These settings are out of date (the NVR or its address changed). Close the panel and open it again.')
    return await withNvrLock(nvr, 'A stream change', async () => {
      const result = await apply(ctx, body)
      const item = await readChannel(nvr, chlId, ctx.gen).catch(() => null)
      return [200, { stream: item ? streamView(ctx, item, await readSystem(nvr, ctx.gen)) : null, result }]
    })
  } catch (e) {
    return errorAnswer(e)
  }
}

// for the offline tests (cctv/test/streams.test.mjs)
export const _test = { parseEncode, current, qoiList, digitalDefault, whyNot, planChange, buildEdit, buildRemain, parseRemain, worstCase, impactsOf, undoable, recommendedRange, retentionRefusal, optimisePlan, capPlan, downTarget, LOG_FILE, TIMING }
