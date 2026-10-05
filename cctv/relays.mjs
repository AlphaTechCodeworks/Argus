// NVR alarm outputs (relays): what each NVR has, and whether each is on. READ ONLY for now.
//
//   GET /api/admin/nvrs/:id/alarm-outputs  -> { outputs: [{ id, name, online, on, delay }] }   (admins)
//   GET /api/admin/alarm-outputs           -> { nvrs: [{ nvr, name, outputs | error }] }       (admins)
//
// The NVR answers getAlarmOutStatus (an empty request) with response/content/item[@id] carrying
// <name>, <onlineStatus>, <switch> and <delay> (5secs, 1mins, manual...), as its own web client reads
// it. Switching one (setAlarmOutStatus <switch>true|false</switch><alarmOutIds>) drives whatever is
// wired to it -- a siren, a gate, a light -- so that waits until the owner has said which outputs are
// safe to use from here; the site's floodlight is worked by hand only.
import { XML_HEADER, kid, kids, parseXml } from './xml.mjs'

export const GET_ALARM_OUTS = 'getAlarmOutStatus'
const text = (n) => (n?.text ?? '').trim()
const yes = (s) => /^(true|1|on)$/i.test(String(s).trim())

/** The request: getAlarmOutStatus takes nothing. */
export const alarmOutRequest = () => `${XML_HEADER}</request>`

/** The outputs in the NVR's answer. Throws when it is not an answer at all, or says it failed. */
export function parseAlarmOuts(xml) {
  const response = kid(parseXml(String(xml ?? '')), 'response')
  if (!response) throw new Error('the NVR did not answer with a document')
  const status = text(kid(response, 'status'))
  if (status && status !== 'success') {
    const code = text(kid(response, 'errorCode'))
    throw new Error(code === '536870953' ? 'this NVR login may not see alarm outputs (no alarm rights)' : `the NVR refused getAlarmOutStatus (${status}${code ? `, code ${code}` : ''})`)
  }
  const content = kid(response, 'content')
  const items = content ? kids(content, 'item') : []
  return items.map((it) => {
    const delay = kid(it, 'delay')
    return {
      id: it.attrs?.id ?? '',
      name: text(kid(it, 'name')) || 'Alarm output',
      online: kid(it, 'onlineStatus') ? yes(text(kid(it, 'onlineStatus'))) : true,
      on: yes(text(kid(it, 'switch'))),
      delay: text(delay) || text(kid(delay, 'enum')) || null
    }
  })
}

/** One NVR's outputs. `query` is nvr-xml.mjs transparent (injected: the tests have no NVR). */
export async function readAlarmOuts(nvr, query) {
  const xml = await query(nvr, GET_ALARM_OUTS, alarmOutRequest(), 'alarm outputs')
  return parseAlarmOuts(xml)
}

/**
 * The routes. @returns {Promise<[number, object]|null>} null when the path is not ours
 * @param {{ nvrs: Map, admin: boolean, query: Function }} deps
 */
export async function handleRelays(method, pathname, { nvrs, admin, query }) {
  const one = /^\/api\/admin\/nvrs\/([^/]+)\/alarm-outputs$/.exec(pathname)
  if (pathname !== '/api/admin/alarm-outputs' && !one) return null
  if (!admin) return [403, { error: 'Admins only' }]
  if (method !== 'GET') return [405, { error: 'Reading only: switching outputs is not set up yet' }]
  const ask = async (nvr) => {
    if (!nvr.online) return { nvr: nvr.id, name: nvr.name, error: `${nvr.name} is offline` }
    try {
      return { nvr: nvr.id, name: nvr.name, outputs: await readAlarmOuts(nvr, query) }
    } catch (e) {
      return { nvr: nvr.id, name: nvr.name, error: e.message }
    }
  }
  if (one) {
    const nvr = nvrs.get(decodeURIComponent(one[1]))
    if (!nvr) return [404, { error: 'Unknown NVR' }]
    const r = await ask(nvr)
    return r.error ? [502, { error: r.error }] : [200, { outputs: r.outputs }]
  }
  // one NVR at a time: these share each NVR's XML queue with settings and clock checks
  const out = []
  for (const nvr of nvrs.values()) out.push(await ask(nvr))
  return [200, { nvrs: out }]
}
