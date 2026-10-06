// A camera's motorised lens: its focus settings, and a one-off "Focus now". Only cameras
// whose NVR answers the lens query with settings have one (one camera here, JPB DOOR).
//
// Protocol: the NVR web client's Image page, lens part (displaySet.js, "ds:N" = line N of the
// beautified copy in the research folder):
//   read   queryCameraLensCtrlParam  <condition><chlId>{id}</chlId></condition>
//          supported only if the answer is "success" AND has content (ds:1150)
//   save   editCameraLensCtrlParam   <content><chl id><focusType type="focusType">manual</focusType>
//                                     <IrchangeFocus>true</IrchangeFocus><timeInterval>0</timeInterval></chl></content>
//          in manual focus the page always sends timeInterval 0 (ds:1214), whatever it was
//   action cameraLensCtrlCall        <content><chlId>{id}</chlId><actionType>OneKeyFocus</actionType></content>,
//          then Stop, as the page's button does on mouse down / mouse up (ds:1188-1243)
// Zoom, Near and Far are not offered.
//
// Safety: saves and focusing go under the NVR's change lock and through its XML queue; a save
// re-reads first and refuses if the setting changed since it was shown; the refocus interval
// the page resets to 0 needs an acknowledgement, because Undo cannot put it back; Stop is sent
// after OneKeyFocus even if that failed; "Focus now" is refused unless the panel reports good
// light (autofocus in the dark hunts and can end up worse).
//
//   GET  /api/admin/nvrs/:id/channels/:ch/lens  -> { lens }
//   POST /api/admin/nvrs/:id/channels/:ch/lens  { device, action: 'save', IrchangeFocus, seen: { IrchangeFocus }, ack?, ackToken?, confirm: true }
//                                               { device, action: 'undo', seq, confirm: true }
//                                               { device, action: 'focus', light: { period, mono, mean }, confirm: true }
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
  transparent,
  withNvrLock
} from './nvr-xml.mjs'
import { nvrs } from './nvrs.mjs'
import { xmlDegraded, xmlGen } from './xml-session.mjs'

const QUERY_URL = 'queryCameraLensCtrlParam'
const EDIT_URL = 'editCameraLensCtrlParam'
const CALL_URL = 'cameraLensCtrlCall'
const LOG_FILE = join(DATA_DIR, 'lens-changes.log')
export const TIMING = { verifyMs: 1500, stopAfterMs: 300 } // tests shorten them

// ---- NVR answers ---------------------------------------------------------------------------

/** The lens settings from a queryCameraLensCtrlParam answer; supported: false without content. */
function parseLens(xml) {
  const { response, status, errorCode } = parseAnswer(xml)
  const content = kid(response, 'content')
  const hasContent = Boolean(content && (content.children.length || content.text.trim()))
  if (status !== 'success' || !hasContent) {
    return { supported: false, status, errorCode, reason: status !== 'success' ? `the NVR refused (${errorCode || status || 'no status'})` : 'this camera has no motorised lens' }
  }
  const chl = kid(content, 'chl')
  const text = (name) => kid(chl, name)?.text.trim() ?? null
  const types = kids(kid(kid(response, 'types'), 'focusType'), 'enum').map((e) => e.text.trim())
  const note = text('timeIntervalNote')
  return {
    supported: true,
    id: chl?.attrs.id ?? null,
    focusTypes: types,
    focusType: text('focusType'),
    IrchangeFocus: text('IrchangeFocus') === 'true',
    timeInterval: text('timeInterval') === null ? null : Number(text('timeInterval')),
    intervals: note ? note.split(',').map((x) => Number(x.trim())).filter(Number.isFinite) : []
  }
}

async function readLens(nvr, chlId, gen) {
  const xml = `${XML_HEADER}<condition><chlId>${esc(chlId)}</chlId></condition></request>`
  return parseLens(await transparent(nvr, QUERY_URL, xml, 'lens settings', { gen }))
}

/** The page's save document (ds:1214): manual focus always sends interval 0. */
function buildSave(chlId, lens, IrchangeFocus) {
  const manual = lens.focusType !== 'auto'
  const interval = manual ? 0 : (lens.timeInterval ?? 0)
  return (
    `${XML_HEADER}<content><chl id="${esc(chlId)}"><focusType type="focusType">${manual ? 'manual' : 'auto'}</focusType>` +
    `<IrchangeFocus>${IrchangeFocus ? 'true' : 'false'}</IrchangeFocus><timeInterval>${esc(interval)}</timeInterval></chl></content></request>`
  )
}
const buildCall = (chlId, actionType) => `${XML_HEADER}<content><chlId>${esc(chlId)}</chlId><actionType>${esc(actionType)}</actionType></content></request>`

/**
 * What a save does beyond the switch: the refocus interval the page resets, which can't be put
 * back from here. An Undo is a save too (it sends 0 as well): the interval may have been set
 * again since (on the camera's own page), so it asks the same.
 */
function saveImpacts(lens, action = 'lens') {
  if (lens.focusType === 'auto' || !lens.timeInterval) return []
  return [
    {
      key: 'lens-interval',
      text: `The refocus interval goes from ${lens.timeInterval} to 0 (the NVR page always does this in manual focus); ${action === 'undo' ? 'it cannot be put back from here' : `Undo cannot put ${lens.timeInterval} back`}.`,
      paths: ['timeInterval']
    }
  ]
}

/** "Focus now" only in good light: by day, or a lit colour scene (the panel measures it; advisory). */
function lightOk(light) {
  if (!isPlainObject(light)) return false
  return light.period === 'day' || (light.mono === false && typeof light.mean === 'number' && light.mean >= 90)
}

const tokenOf = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)

// ---- change log --------------------------------------------------------------------------------

function writeLog(entry) {
  mkdirSync(dirname(LOG_FILE), { recursive: true })
  appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}
const readLog = () => readLogCached(LOG_FILE).filter((e) => typeof e.seq === 'string')

/** The newest lens save to this camera not undone yet, if the switch is still as it left it. */
function undoable(log, device, chlId, lens) {
  const mine = log.filter((e) => e.kind === 'change' && e.device === device && e.chl === chlId)
  const results = new Map(log.filter((e) => e.kind === 'result').map((e) => [e.seq, e]))
  const undone = new Set(mine.filter((e) => e.action === 'undo' && results.get(e.seq)?.result === 'done').map((e) => e.undoes))
  const last = mine.filter((e) => e.action === 'lens' && !undone.has(e.seq)).at(-1)
  if (!last || results.get(last.seq)?.result === 'failed') return null
  return lens.IrchangeFocus === last.to.IrchangeFocus ? last : null
}

// ---- API ---------------------------------------------------------------------------------------

async function save(ctx, lens, IrchangeFocus, { action, undoes, body }) {
  const { nvr, chlId, gen, device, user } = ctx
  if (lens.IrchangeFocus === IrchangeFocus) return { status: 'done', message: 'Nothing to change' }
  const list = saveImpacts(lens, action) // from the fresh read, for Undo too
  const token = tokenOf([device, chlId, 'lens', action, lens.focusType, lens.timeInterval, lens.IrchangeFocus, IrchangeFocus])
  if (list.length && !(body.ackToken === token && list.every((i) => Array.isArray(body.ack) && body.ack.includes(i.key)))) {
    throw new HttpError(409, 'This change needs your confirmation', { needsAck: list, ackToken: token })
  }
  if (xmlDegraded(nvr) || xmlGen(nvr) !== gen) throw new HttpError(409, `${nvr.name} is busy or reconnected; nothing was sent`)
  const seq = newSeq()
  const from = { IrchangeFocus: lens.IrchangeFocus, timeInterval: lens.timeInterval }
  const to = { IrchangeFocus, timeInterval: lens.focusType === 'auto' ? lens.timeInterval : 0 }
  writeLog({ kind: 'change', seq, at: new Date().toISOString(), user, nvr: nvr.id, device, nvrName: nvr.name, chl: chlId, ch: ctx.ch + 1, name: ctx.name, action, undoes, focusType: lens.focusType, from, to, ack: list.map((i) => i.key) })
  console.log(`[lens] ${nvr.id} ch${ctx.ch + 1} "${ctx.name}": refocus on day/night switch ${from.IrchangeFocus} -> ${IrchangeFocus} (${action}, by ${user})`)
  let a
  try {
    a = parseAnswer(await transparent(nvr, EDIT_URL, buildSave(chlId, lens, IrchangeFocus), 'lens change', { gen }))
  } catch (e) {
    a = { status: e?.name === 'SdkTimeout' ? 'no answer in time' : 'error', errorCode: e.message }
  }
  await sleep(TIMING.verifyMs)
  const now = await readLens(nvr, chlId, gen).catch(() => null)
  // the page also counts errorCode 0 as success (ds:1214)
  const accepted = a.status === 'success' || a.errorCode === '0'
  const result = !now?.supported ? 'unknown' : now.IrchangeFocus === IrchangeFocus ? 'done' : 'failed'
  try {
    writeLog({ kind: 'result', seq, at: new Date().toISOString(), result, answer: a.status, errorCode: a.errorCode || undefined, after: now?.supported ? { IrchangeFocus: now.IrchangeFocus, timeInterval: now.timeInterval } : null })
    rotateLog(LOG_FILE)
  } catch (e) {
    console.warn(`[lens] result not logged: ${e.message}`)
  }
  const message = result === 'done' ? (action === 'undo' ? 'Undone (the refocus interval stays as it is)' : 'Saved') : result === 'unknown' ? 'Sent, but the lens settings could not be read back' : accepted ? 'The NVR accepted it, but the camera kept its setting' : `Not changed: the NVR refused (${a.errorCode || a.status})`
  return { seq, status: result, message }
}

/** OneKeyFocus, then always Stop (the page's button: mouse down, mouse up). */
async function focus(ctx) {
  const { nvr, chlId, gen, device, user } = ctx
  if (xmlDegraded(nvr) || xmlGen(nvr) !== gen) throw new HttpError(409, `${nvr.name} is busy or reconnected; nothing was sent`)
  const seq = newSeq()
  writeLog({ kind: 'action', seq, at: new Date().toISOString(), user, nvr: nvr.id, device, chl: chlId, ch: ctx.ch + 1, name: ctx.name, action: 'focus' })
  console.log(`[lens] ${nvr.id} ch${ctx.ch + 1} "${ctx.name}": focus now (by ${user})`)
  let a
  let stop
  try {
    a = parseAnswer(await transparent(nvr, CALL_URL, buildCall(chlId, 'OneKeyFocus'), 'lens focus', { gen }))
    await sleep(TIMING.stopAfterMs)
  } catch (e) {
    a = { status: 'error', errorCode: e.message }
  } finally {
    try {
      stop = parseAnswer(await transparent(nvr, CALL_URL, buildCall(chlId, 'Stop'), 'lens stop', { gen }))
    } catch (e) {
      stop = { status: 'error', errorCode: e.message }
      console.warn(`[lens] ${nvr.id} ch${ctx.ch + 1}: Stop after focus failed: ${e.message}`)
    }
  }
  const ok = a.status === 'success'
  return { seq, status: ok ? 'done' : 'failed', stop: stop.status, message: ok ? 'Focusing: the picture may take a few seconds to settle' : `The NVR refused (${a.errorCode || a.status})` }
}

const lensView = (ctx, lens) => ({
  ...lens,
  impacts: lens.supported ? saveImpacts(lens) : [],
  undo: (() => {
    const last = lens.supported ? undoable(readLog(), ctx.device, ctx.chlId, lens) : null
    return last ? { seq: last.seq, at: last.at, by: last.user, puts: `refocus on day/night switch ${last.from.IrchangeFocus ? 'on' : 'off'}` } : null
  })()
})

/**
 * @returns {Promise<[number, any]>}
 */
export async function handleLens(method, nvrId, ch, readJson, user) {
  try {
    const { nvr, chlId, name } = cameraOf(nvrs, nvrId, ch)
    requireOnline(nvr)
    const ctx = { nvr, ch, chlId, name, gen: xmlGen(nvr), user, device: deviceOf(nvr) }
    if (method === 'GET') return [200, { lens: lensView(ctx, await readLens(nvr, chlId, ctx.gen)) }]
    if (method !== 'POST') return [405, { error: 'Method not allowed' }]
    const body = await readJson()
    if (!isPlainObject(body)) throw new HttpError(400, 'The request must be a JSON object')
    if (body.confirm !== true) throw new HttpError(400, 'Changes need confirm: true')
    if (body.device !== ctx.device) throw new HttpError(409, 'These settings are out of date (the NVR or its address changed). Close the panel and open it again.')
    if (!['save', 'undo', 'focus'].includes(body.action)) throw new HttpError(400, 'action must be "save", "undo" or "focus"')
    if (body.action === 'focus' && !lightOk(body.light)) throw new HttpError(400, 'Focus now needs good light: by day, or a lit scene in colour (autofocus in the dark hunts)')
    if (body.action === 'save' && typeof body.IrchangeFocus !== 'boolean') throw new HttpError(400, 'IrchangeFocus must be true or false')
    return await withNvrLock(nvr, body.action === 'focus' ? 'Focusing a camera' : 'A lens change', async () => {
      const lens = await readLens(nvr, chlId, ctx.gen)
      if (!lens.supported) throw new HttpError(400, `No lens control: ${lens.reason}`)
      let result
      if (body.action === 'focus') result = await focus(ctx)
      else if (body.action === 'undo') {
        const last = undoable(readLog(), ctx.device, chlId, lens)
        if (!last || last.seq !== body.seq) throw new HttpError(409, 'Someone changed this lens since; reopen the panel')
        result = await save(ctx, lens, last.from.IrchangeFocus, { action: 'undo', undoes: last.seq, body })
      } else {
        if (!isPlainObject(body.seen) || body.seen.IrchangeFocus !== lens.IrchangeFocus) {
          throw new HttpError(409, 'The lens setting changed since you looked; nothing was sent', { stale: [{ path: 'IrchangeFocus', now: lens.IrchangeFocus }], lens: lensView(ctx, lens) })
        }
        result = await save(ctx, lens, body.IrchangeFocus, { action: 'lens', body })
      }
      const now = await readLens(nvr, chlId, ctx.gen).catch(() => lens)
      return [200, { lens: lensView(ctx, now), result }]
    })
  } catch (e) {
    return errorAnswer(e)
  }
}

// for the offline tests (cctv/test/lens.test.mjs)
export const _test = { parseLens, buildSave, buildCall, saveImpacts, lightOk, undoable, TIMING, LOG_FILE }
