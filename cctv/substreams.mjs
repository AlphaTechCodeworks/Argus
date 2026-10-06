// Sub-stream codec: shows each channel's sub-stream settings and, when an admin asks and
// confirms, switches chosen channels from H.265 to H.264. Live grids use sub-streams, and
// browsers on PCs without H.265 hardware decoding can't play H.265 at all. The cameras keep
// doing the encoding; only their setting changes.
//
// Protocol: the NVR web client's own Sub Stream page (js/app/RecCfg/subStream.js), sent over
// the logged-in SDK connection with NET_SDK_TransparentConfig (strUrl = the command name,
// sendXML = the whole <request> document, no web token needed):
//   read  queryNetworkNodeEncodeInfo  (every configured channel; ~20 KB per channel)
//   write editNetworkNodeEncodeInfo   (one <item> per channel, full <sub> attribute set)
// A channel's item id is "{0000000N-0000-...}" with N = channel number (1-based) in hex.
//
// Safety: nothing is changed unless an admin asks for named channels and confirms. Each
// channel is read again right before its change, every other setting is sent back exactly
// as read (as the NVR's page does), channels are changed one at a time (under the NVR's change
// lock, shared with picture, stream and lens changes: see withNvrLock), and each change is
// checked by reading the channel again. Every change is appended to
// data/substream-changes.log with the settings before and after, which is what Undo uses.
//
//   GET  /api/admin/nvrs/:id/substreams       -> { channels, job }
//   POST /api/admin/nvrs/:id/substreams       { action: 'h264' | 'undo', channels: [id], bitrate?: 'match' | 'keep', confirm: true } -> { job }
//   GET  /api/admin/nvrs/:id/substreams/job   -> { job }
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DATA_DIR } from './auth.mjs'
import { nvrs } from './nvrs.mjs'
import { HttpError, XML_HEADER, deviceOf, esc, kid, kids, parseXml, settled, transparent, withNvrLock } from './nvr-xml.mjs'
import { xmlDegraded, xmlGen, xmlOnline } from './xml-session.mjs'

const QUERY_URL = 'queryNetworkNodeEncodeInfo'
const EDIT_URL = 'editNetworkNodeEncodeInfo' // writes: only ever sent from a confirmed job
const OUT_BYTES = 2 * 1024 * 1024 // a full answer is ~20 KB per channel; too small a buffer fails (error 102)
const VERIFY_AFTER_MS = 3000 // the NVR passes the change to the camera; read back after this
const CACHE_MS = 5000
const SEEN_FRESH_MS = 10 * 60_000 // a codec seen in the live video counts for this long
const LOG_FILE = join(DATA_DIR, 'substream-changes.log')

// ---- XML (NVR answers only) --------------------------------------------------------

const list = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : [])

// ---- web client rules ---------------------------------------------------------------

/** Some firmware spells plus/smart out ("h265plus"); the web client normalises like this. */
export const normEnct = (e) => String(e ?? '').toLowerCase().replace(/plus/g, 'p').replace(/smart/g, 's')
export const isH265 = (e) => normEnct(e).startsWith('h265')
const wh = (res) => String(res).split('x').map(Number)
/** 1-based channel number from an item id, or null. */
const chNumber = (id) => {
  const m = /^\{([0-9a-f]{8})-0000-0000-0000-000000000000\}$/i.exec(String(id))
  return m ? parseInt(m[1], 16) : null
}

function parseEncodeInfo(xml) {
  const response = kid(parseXml(xml), 'response')
  if (!response) throw new Error('bad answer from the NVR (no <response>)')
  const status = kid(response, 'status')?.text.trim() ?? ''
  const errorCode = kid(response, 'errorCode')?.text.trim() ?? ''
  const channels = kids(kid(response, 'content'), 'item').map((item) => {
    const subCaps = kid(item, 'subCaps')
    return {
      id: item.attrs.id,
      name: (kid(item, 'name')?.text ?? '').trim(),
      chlType: kid(item, 'chlType')?.text.trim() ?? '',
      supEnct: list(subCaps?.attrs.supEnct),
      bitTypes: list(subCaps?.attrs.bitType),
      resolutions: kids(subCaps, 'res').map((r) => ({ value: r.text.trim(), fps: Number(r.attrs.fps) })),
      sub: kid(item, 'sub') ? { ...kid(item, 'sub').attrs } : null,
      qualityCaps: kids(kid(item, 'subStreamQualityCaps'), 'item').map((q) => ({
        enct: q.attrs.enct,
        res: q.attrs.res,
        digitalDefault: q.attrs.digitalDefault,
        analogDefault: q.attrs.analogDefault,
        values: list(q.text).map(Number)
      }))
    }
  })
  return { status, errorCode, channels }
}

/**
 * Bitrate (kbps) choices for a codec and resolution, looked up like the web client does.
 * ch.qualityCaps: [{ enct, res, digitalDefault, analogDefault, values }] (sub or main stream).
 */
export function qualityList(ch, enct, res) {
  const caps = [...ch.qualityCaps].sort((a, b) => {
    const [aw, ah] = wh(a.res)
    const [bw, bh] = wh(b.res)
    return a.enct !== b.enct ? (a.enct > b.enct ? -1 : 1) : bw - aw || bh - ah
  })
  const exact = caps.find((c) => c.enct === enct && c.res === res)
  if (exact?.values.length) return { values: exact.values, exact }
  if (!exact) {
    const [w, h] = wh(res)
    const smaller = caps.find((c) => {
      const [cw, chh] = wh(c.res)
      return c.enct === enct && (cw < w || (cw === w && chh < h)) && c.values.length
    })
    if (smaller) return { values: smaller.values, exact: null }
  }
  return { values: caps.find((c) => c.enct === enct && c.res === '0x0')?.values ?? [], exact: exact ?? null }
}

/** The web client's "recommended range" for a VBR stream (CommonFunctions.GetBitrateRange). */
export function recommendedRange({ res, level, fps, enct }, maxQoI) {
  const [w, h] = wh(res)
  const px = w * h
  const e = { highest: 100, higher: 67, medium: 50, lower: 34, lowest: 25 }[level]
  if (!px || !e) return null
  const d = Math.floor(px / (px >= 2073600 ? 200000 : 150000)) || 0.5
  const f = Number(fps)
  let min = (768 * d * e * Math.max(f, 10)) / 3000
  let max = (1280 * d * e * Math.max(f, 10)) / 3000
  if (f < 10) {
    min -= ((10 - f) * min * 2) / 27
    max -= ((10 - f) * max * 2) / 27
  }
  if (maxQoI) min = Math.min(maxQoI, min)
  const k = isH265(enct) ? 0.55 : 1
  return { min: Math.floor(min * k), max: Math.floor(max * k) }
}

/**
 * What to send to switch one channel to plain H.264, or why it can't be.
 * bitrate 'keep': the current bitrate (raised to the lowest H.264 choice if below it).
 * bitrate 'match': raised where needed so the picture stays about as good; H.264 needs
 *   roughly 1.8x the bitrate of H.265 (CBR: the NVR's H.264 default, as the NVR's page sets;
 *   VBR: the web client's recommended minimum for H.264). Never lowered.
 */
function planH264(ch, bitrate = 'match') {
  const no = (reason) => ({ ok: false, reason })
  if (ch.chlType === 'recorder') return no('comes from another recorder')
  if (!ch.sub) return no('the NVR reports no sub-stream')
  if (ch.resolutions.length === 0) return no('camera offline or has no sub-stream')
  if (!ch.supEnct.includes('h264')) return no('the camera does not offer H.264 on its sub-stream')
  const cur = ch.sub
  if (!isH265(cur.enct)) return no(`already ${label(cur.enct)}`)
  if (!ch.resolutions.some((r) => r.value === cur.res)) return no(`its resolution ${cur.res} is not offered any more`)
  const next = { ...cur, enct: 'h264' }
  const choices = qualityList(ch, 'h264', cur.res).values.sort((a, b) => a - b)
  const now = Number(cur.QoI)
  let target = now
  if (bitrate === 'match') {
    if (cur.bitType === 'CBR') {
      const def = Number(qualityList(ch, 'h264', cur.res).exact?.[`${ch.chlType === 'analog' ? 'analog' : 'digital'}Default`])
      if (def > target) target = def
    } else {
      const range = recommendedRange({ ...cur, enct: 'h264' }, choices.at(-1))
      if (range && range.min > target) target = range.min
    }
  }
  if (choices.length) target = choices.find((v) => v >= target) ?? choices.at(-1)
  next.QoI = String(target)
  if (!next.bitType) next.bitType = 'CBR' // what the web client sends for an empty bitType
  if (next.GOP === undefined || next.GOP === '') next.GOP = String(4 * Number(next.fps))
  return { ok: true, sub: next }
}

/** The editNetworkNodeEncodeInfo document for one channel, as the web client writes it. */
function buildEdit(id, s) {
  const level = s.level === undefined ? '' : ` level="${esc(s.level)}"`
  return (
    `${XML_HEADER}<content type="list" total="1">` +
    `<item id="${esc(id)}"><sub  res="${esc(s.res)}" fps="${esc(s.fps)}" QoI="${esc(s.QoI)}"  bitType="${esc(s.bitType)}"${level} enct="${esc(s.enct)}"  GOP="${esc(s.GOP)}"></sub></item>` +
    `</content></request>`
  )
}

const LABELS = { h264: 'H.264', h265: 'H.265', h264p: 'H.264+', h265p: 'H.265+', h264s: 'H.264 smart', h265s: 'H.265 smart' }
const label = (enct) => LABELS[normEnct(enct)] ?? (enct || 'unknown')

// ---- talking to the NVR ---------------------------------------------------------------

const cache = new Map() // nvr id -> { at, info }
const reading = new Map() // nvr id -> promise of a read in progress (shared, never two at once)
async function readChannels(nvr, { fresh = false, gen } = {}) {
  const hit = cache.get(nvr.id)
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.info
  if (reading.has(nvr.id)) {
    if (!fresh) return reading.get(nvr.id)
    await reading.get(nvr.id).catch(() => {}) // let it finish, then read again
    if (reading.has(nvr.id)) return readChannels(nvr, { fresh, gen })
  }
  const xml = `${XML_HEADER}<requireField><name/><chlType/><subCaps/><sub/><subStreamQualityCaps/><levelNote/></requireField></request>`
  const p = transparent(nvr, QUERY_URL, xml, 'sub-stream settings', { gen: gen ?? xmlGen(nvr), outBytes: OUT_BYTES })
    .then((answer) => {
      const info = parseEncodeInfo(answer)
      if (info.status !== 'success') throw new Error(`the NVR refused to list sub-streams (${info.errorCode || info.status || 'no status'})`)
      cache.set(nvr.id, { at: Date.now(), info })
      return info
    })
    .finally(() => reading.delete(nvr.id))
  reading.set(nvr.id, p)
  return p
}

// ---- change log (and Undo) -------------------------------------------------------------
//
// Write-ahead: a "change" line (settings before, and what is sent) is written BEFORE the edit
// goes out, and a "result" line (what the NVR then reports) after. If the first write fails,
// nothing is sent. Lines are tied to the device (host:port), not just the NVR's id in the app.

const SETTINGS = ['enct', 'res', 'fps', 'QoI', 'bitType', 'level', 'GOP']
const pick = (sub) => Object.fromEntries(SETTINGS.filter((k) => sub?.[k] !== undefined).map((k) => [k, String(sub[k])]))
const sameSettings = (a, b) => SETTINGS.every((k) => String(a?.[k] ?? '') === String(b?.[k] ?? ''))

function readLog() {
  if (!existsSync(LOG_FILE)) return []
  const lines = readFileSync(LOG_FILE, 'utf8').split('\n')
  const out = []
  for (const l of lines.slice(-5000)) {
    if (!l) continue
    try {
      const e = JSON.parse(l)
      if (e && typeof e === 'object' && typeof e.seq === 'string') out.push(e)
    } catch {}
  }
  return out
}
const writeLog = (entry) => appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 })

/**
 * The last change this app made to a channel of this device, if it can be undone: it was an
 * H.264 switch (not itself an undo), and the channel still has exactly the settings the NVR
 * reported right after it (or, if that read-back is missing, the settings that were sent).
 */
function undoable(log, device, ch) {
  if (!ch.sub) return null
  const changes = log.filter((e) => e.kind === 'change' && e.device === device && e.id === ch.id)
  const last = changes.at(-1)
  if (!last || last.action !== 'h264' || !last.from) return null
  const result = log.findLast((e) => e.kind === 'result' && e.seq === last.seq)
  const expected = result?.after ?? last.to
  return sameSettings(pick(ch.sub), pick(expected)) ? last : null
}

// ---- checks on what is sent -------------------------------------------------------------

/** Every value that goes out must be one the camera offers; throws with the reason otherwise. */
function validate(ch, s) {
  const bad = (what) => {
    throw new Error(`refused to send: ${what}`)
  }
  if (!ch.supEnct.includes(normEnct(s.enct))) bad(`codec ${s.enct} is not offered by this camera`)
  const res = ch.resolutions.find((r) => r.value === s.res)
  if (!res) bad(`resolution ${s.res} is not offered`)
  const fps = Number(s.fps)
  if (!Number.isInteger(fps) || fps < 1 || (res.fps && fps > res.fps)) bad(`frame rate ${s.fps}`)
  const qoi = Number(s.QoI)
  if (!Number.isInteger(qoi) || qoi < 1 || qoi > 65535) bad(`bitrate ${s.QoI}`)
  if (!['CBR', 'VBR'].includes(s.bitType) || (ch.bitTypes.length && !ch.bitTypes.includes(s.bitType))) bad(`bitrate type ${s.bitType}`)
  const gop = Number(s.GOP)
  if (!Number.isInteger(gop) || gop < 1 || gop > 480) bad(`GOP ${s.GOP}`)
  if (s.level !== undefined && !/^(highest|higher|medium|lower|lowest)$/.test(s.level)) bad(`quality level ${s.level}`)
}

// ---- jobs ----------------------------------------------------------------------------------

const jobs = new Map() // nvr id -> job

async function runJob(nvr, job) {
  const gen = xmlGen(nvr)
  const stopAll = (from, reason) => {
    for (const s of job.steps.slice(from)) if (s.status === 'waiting') Object.assign(s, { status: 'skipped', reason })
  }
  for (const [i, step] of job.steps.entries()) {
    // never carry on after doubt: offline, a new session, or calls stuck in the SDK
    if (!xmlOnline(nvr) || nvr.stopped || xmlGen(nvr) !== gen || xmlDegraded(nvr)) {
      stopAll(i, `stopped: ${nvr.name} is ${xmlOnline(nvr) ? 'busy or reconnected' : 'offline'}`)
      break
    }
    step.status = 'working'
    let seq = null
    try {
      // read again right before changing: never act on stale settings
      const ch = (await readChannels(nvr, { fresh: true, gen })).channels.find((c) => c.id === step.id)
      if (!ch) throw new Error('the NVR no longer lists this channel')
      step.name = ch.name
      let target
      if (job.action === 'h264') {
        const plan = planH264(ch, job.bitrate)
        if (!plan.ok) {
          Object.assign(step, { status: 'skipped', reason: plan.reason })
          continue
        }
        target = plan.sub
      } else {
        const last = undoable(readLog(), deviceOf(nvr), ch)
        if (!last) {
          Object.assign(step, { status: 'skipped', reason: 'its settings were changed since, or not by this app' })
          continue
        }
        target = { ...pick(last.from) }
        if (target.GOP === undefined || target.GOP === '') target.GOP = String(4 * Number(target.fps))
        if (!target.bitType) target.bitType = 'CBR'
      }
      validate(ch, target)
      // the read took a while: check again that nothing is stuck and the session is the same
      if (xmlDegraded(nvr) || xmlGen(nvr) !== gen) {
        Object.assign(step, { status: 'skipped', reason: `${nvr.name} is busy or reconnected; nothing was sent` })
        stopAll(i + 1, 'stopped: the NVR is busy or reconnected')
        break
      }
      seq = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      // write-ahead: if the "before" can't be recorded, nothing is sent
      writeLog({ kind: 'change', seq, at: new Date().toISOString(), user: job.user, nvr: nvr.id, device: deviceOf(nvr), nvrName: nvr.name, id: ch.id, ch: chNumber(ch.id), name: ch.name, action: job.action, from: pick(ch.sub), to: pick(target) })
      console.log(`[substreams] ${nvr.id} ch${chNumber(ch.id)} "${ch.name}": ${label(ch.sub.enct)} ${ch.sub.QoI} kbps -> ${label(target.enct)} ${target.QoI} kbps (${job.action}, by ${job.user})`)
      let answer
      let timedOut = false
      try {
        answer = parseEncodeInfo(await transparent(nvr, EDIT_URL, buildEdit(ch.id, target), 'sub-stream change', { gen, outBytes: OUT_BYTES }))
      } catch (e) {
        timedOut = e?.name === 'SdkTimeout'
        answer = { status: timedOut ? 'no answer in time' : 'error', errorCode: e.message }
      }
      // a change that timed out may still be applied later: let it finish before checking,
      // and change nothing else in this job
      if (timedOut) await settled(nvr)
      await sleep(VERIFY_AFTER_MS)
      let after = null
      try {
        after = (await readChannels(nvr, { fresh: true, gen })).channels.find((c) => c.id === step.id)?.sub ?? null
      } catch (e) {
        step.reason = `could not read it back (${e.message})`
      }
      const applied = Boolean(after) && normEnct(after.enct) === normEnct(target.enct)
      step.status = applied ? 'done' : after ? 'failed' : 'unknown'
      if (after && !applied) {
        step.reason =
          answer.status === 'success'
            ? `the NVR accepted it but the camera still reports ${label(after.enct)}`
            : `the NVR refused it (${answer.errorCode || answer.status})`
      }
      step.now = after ? `${label(after.enct)}, ${after.QoI} kbps` : null
      try {
        writeLog({ kind: 'result', seq, at: new Date().toISOString(), result: step.status, answer: answer.status, errorCode: answer.errorCode || undefined, after: after ? pick(after) : null })
      } catch (e) {
        step.reason = `${step.reason ? `${step.reason}; ` : ''}the result could not be logged (${e.message})`
      }
      if (applied) {
        // viewers pick up the new codec at the next keyframe; restarting makes that immediate
        const sdkCh = chNumber(ch.id) - 1
        nvr.codecSeen.delete(`${sdkCh}:1`)
        nvr.restartStream(sdkCh, 1, 'sub-stream codec changed') // (in the NVR's live worker when CCTV_LIVE_WORKER=on)
      }
      if (timedOut || step.status === 'unknown') {
        stopAll(i + 1, 'stopped: the NVR did not answer the previous change in time')
        break
      }
    } catch (e) {
      Object.assign(step, { status: seq ? 'unknown' : 'failed', reason: e.message })
      if (seq) {
        stopAll(i + 1, 'stopped after an error during a change')
        break
      }
    }
  }
  job.finishedAt = Date.now()
  job.running = false
  cache.delete(nvr.id)
}

// ---- API ---------------------------------------------------------------------------------------

function channelView(nvr, ch, log, bitrate) {
  const n = chNumber(ch.id)
  const noted = n ? nvr.codecSeen.get(`${n - 1}:1`) : null
  const seen = noted && Date.now() - noted.at < SEEN_FRESH_MS ? noted.codec : null
  const plan = planH264(ch, bitrate)
  const last = undoable(log, deviceOf(nvr), ch)
  return {
    id: ch.id,
    ch: n,
    name: ch.name,
    codec: ch.sub ? label(ch.sub.enct) : null,
    h265: ch.sub ? isH265(ch.sub.enct) : false,
    seen: seen ? label(seen) : null, // what the video itself was last seen to be (live view)
    res: ch.sub?.res ?? null,
    fps: ch.sub?.fps ? Number(ch.sub.fps) : null,
    kbps: ch.sub?.QoI ? Number(ch.sub.QoI) : null,
    bitType: ch.sub?.bitType || null,
    canSwitch: plan.ok,
    why: plan.ok ? null : plan.reason,
    // bitrate after the switch, for each choice
    newKbps: plan.ok ? { match: Number(plan.sub.QoI), keep: Number(planH264(ch, 'keep').sub.QoI) } : null,
    undo: last ? { to: `${label(last.from.enct)}, ${last.from.QoI} kbps`, at: last.at, by: last.user } : null
  }
}

/**
 * @param {string} method
 * @param {string} nvrId
 * @param {boolean} jobOnly  /substreams/job
 * @param {() => Promise<any>} readJson
 * @param {string} user  the admin, for the change log
 * @returns {Promise<[number, any]>}
 */
export async function handleSubstreams(method, nvrId, jobOnly, readJson, user) {
  try {
    const nvr = nvrs.get(nvrId)
    if (!nvr) throw new HttpError(404, 'No such NVR')
    if (jobOnly) return [200, { job: jobs.get(nvr.id) ?? null }]
    if (method === 'GET') {
      if (!xmlOnline(nvr)) throw new HttpError(409, `${nvr.name} is ${nvr.status}; try again when it is online`)
      if (xmlDegraded(nvr)) throw new HttpError(409, `${nvr.name} is busy or recovering; try again in a minute`)
      const info = await readChannels(nvr)
      const log = readLog()
      const channels = info.channels.map((c) => channelView(nvr, c, log, 'match')).sort((a, b) => (a.ch ?? 0) - (b.ch ?? 0))
      return [200, { nvr: { id: nvr.id, name: nvr.name, site: nvr.site, device: deviceOf(nvr) }, channels, job: jobs.get(nvr.id) ?? null }]
    }
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    const body = await readJson()
    if (body.confirm !== true) throw new HttpError(400, 'Changes need confirm: true')
    if (body.device !== deviceOf(nvr)) throw new HttpError(409, 'This list is out of date (the NVR or its address changed). Close it and open it again.')
    const action = body.action === 'undo' ? 'undo' : body.action === 'h264' ? 'h264' : null
    if (!action) throw new HttpError(400, 'action must be "h264" or "undo"')
    const ids = Array.isArray(body.channels) ? [...new Set(body.channels.map(String))] : []
    if (ids.length === 0 || ids.length > 64 || !ids.every((id) => chNumber(id))) throw new HttpError(400, 'Choose the channels to change')
    const current = jobs.get(nvr.id)
    if (current?.running) throw new HttpError(409, 'Changes are already running on this NVR')
    if (xmlDegraded(nvr)) throw new HttpError(409, `${nvr.name} is busy or recovering; try again in a minute`)
    const steps = ids.map((id) => ({ id, ch: chNumber(id), name: '', status: 'waiting', reason: null, now: null }))
    const job = {
      action,
      bitrate: body.bitrate === 'keep' ? 'keep' : 'match',
      user,
      running: true,
      cancelled: false,
      startedAt: Date.now(),
      finishedAt: null,
      nvr: nvr.id,
      steps
    }
    // the job runs after the answer, under the NVR's change lock (shared with picture, stream
    // and lens changes); withNvrLock throws 409 right here if another change holds it
    withNvrLock(nvr, 'A sub-stream change', () => {
      jobs.set(nvr.id, job)
      return runJob(nvr, job)
    }).catch((e) => {
      console.error(`[substreams] ${nvr.id} job failed: ${e.message}`)
      job.running = false
    })
    return [202, { job }]
  } catch (e) {
    if (e instanceof HttpError) return [e.status, { error: e.message }]
    if (e instanceof SyntaxError) return [400, { error: 'Bad JSON' }]
    return [502, { error: e.message }]
  }
}

// for the offline tests (cctv/test/substreams.test.mjs)
export const _test = { parseEncodeInfo, planH264, buildEdit, undoable, chNumber, validate }
