// An NVR's own event log (queryLog), read only: what the NVR itself recorded as happening -- motion,
// alarm inputs, AI detections (LOG_ALARM_INTELLIGENT: intrusion, tripwire...), video loss -- with the
// camera and the time. Built on the request the NVR's own web client sends (its viewLog page): the
// page, then a list of log types and a UTC time range; the answer lists response/content/item with
// logType, time (UTC), userName, clientType, content and chl@id.
//
//   GET /api/admin/nvrs/:id/log?types=LOG_ALARM_INTELLIGENT,LOG_ALARM_MOTION&from=<ms>&to=<ms>&page=1
//     -> { total, items: [{ type, atMs, ch, camera, user, content }] }   (admins)
import { XML_HEADER, kid, kids, parseXml } from './xml.mjs'
import { xmlOnline } from './xml-session.mjs'

export const QUERY_LOG = 'queryLog'
export const LOG_TYPES = Object.freeze(['LOG_ALARM_MOTION', 'LOG_ALARM_SENSOR', 'LOG_ALARM_INTELLIGENT', 'LOG_ALARM_FACE_MATCH', 'LOG_ALARM_VEHICLE_PLATE_MATCH', 'LOG_ALARM_ALARMOUTPUT', 'LOG_ALARM_OCCLUSION', 'LOG_ALARM_ALL', 'LOG_EXCEPTION_ALL', 'LOG_EXCEPTION_IPC_DISCONNECT', 'LOG_OPERATE_ALL'])
export const PAGE_SIZE = 100
const cdata = (s) => `<![CDATA[${String(s).replace(/]]>/g, '')}]]>`
/** "yyyy-MM-dd HH:mm:ss" in UTC, as the web client sends it. */
export const utcText = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
/** The NVR's "yyyy-MM-dd HH:mm:ss" (UTC) back to ms. */
export const parseUtcText = (s) => {
  const ms = Date.parse(`${String(s).trim().replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? ms : null
}
/** A channel GUID back to a 0-based channel (chlIdOf in reverse), or null. */
export function chOfGuid(id) {
  const m = /^\{([0-9A-F]{8})-0000-0000-0000-000000000000\}$/i.exec(String(id ?? ''))
  return m ? Number.parseInt(m[1], 16) - 1 : null
}

export function logRequest({ types, fromMs, toMs, page = 1, pageSize = PAGE_SIZE }) {
  const list = types.filter((t) => LOG_TYPES.includes(t))
  if (!list.length) throw new Error('no known log type asked for')
  return `${XML_HEADER}<pageIndex>${Math.max(1, Math.floor(page))}</pageIndex><pageSize>${Math.min(PAGE_SIZE, Math.max(1, Math.floor(pageSize)))}</pageSize>` +
    `<condition><logType type="list"><itemType type="logType"/>${list.map((t) => `<item>${cdata(t)}</item>`).join('')}</logType>` +
    `<startTime>${cdata(utcText(fromMs))}</startTime><endTime>${cdata(utcText(toMs))}</endTime></condition></request>`
}

export function parseLog(xml) {
  const response = kid(parseXml(String(xml ?? '')), 'response')
  if (!response) throw new Error('the NVR did not answer with a document')
  const status = (kid(response, 'status')?.text ?? '').trim()
  if (status && status !== 'success') throw new Error(`the NVR refused queryLog (${status}, code ${(kid(response, 'errorCode')?.text ?? '').trim()})`)
  const content = kid(response, 'content')
  const total = Number(content?.attrs?.total ?? 0) || 0
  const items = (content ? kids(content, 'item') : []).map((it) => {
    const chl = kid(it, 'chl')
    return {
      type: (kid(it, 'logType')?.text ?? '').trim(),
      atMs: parseUtcText(kid(it, 'time')?.text ?? ''),
      ch: chOfGuid(chl?.attrs?.id),
      camera: (chl?.text ?? '').trim() || null,
      user: (kid(it, 'userName')?.text ?? '').trim() || null,
      content: (kid(it, 'content')?.text ?? '').trim()
    }
  })
  return { total, items }
}

/** One page of an NVR's log. `query` is nvr-xml.mjs transparent (injected for the tests). */
export async function readNvrLog(nvr, query, opts) {
  return parseLog(await query(nvr, QUERY_LOG, logRequest(opts), 'nvr log', { outBytes: 1024 * 1024 }))
}

/** The route. @returns {Promise<[number, object]|null>} */
export async function handleNvrLog(method, pathname, search, { nvrs, admin, query, now = Date.now() }) {
  const m = /^\/api\/admin\/nvrs\/([^/]+)\/log$/.exec(pathname)
  if (!m) return null
  if (!admin) return [403, { error: 'Admins only' }]
  if (method !== 'GET') return [405, { error: 'Method not allowed' }]
  const nvr = nvrs.get(decodeURIComponent(m[1]))
  if (!nvr) return [404, { error: 'Unknown NVR' }]
  if (!xmlOnline(nvr)) return [409, { error: `${nvr.name} is offline` }]
  const p = new URLSearchParams(search)
  const toMs = Number(p.get('to')) || now
  const fromMs = Number(p.get('from')) || toMs - 86_400_000
  const types = (p.get('types') || 'LOG_ALARM_ALL').split(',').map((s) => s.trim())
  try {
    return [200, await readNvrLog(nvr, query, { types, fromMs, toMs, page: Number(p.get('page')) || 1 })]
  } catch (e) {
    return [502, { error: e.message }]
  }
}

