// An NVR's network status, READ ONLY: how much of its receive and send budgets is in use right now, as
// the "Network Status" page of the NVR's own web client shows it. The send budget is the one that runs
// out: every client that pulls video from the NVR shares it -- this server, playback users, a PC logged
// in with the NVR's own client -- and nvr-2's page said 71 of 192 Mbit/s left while only 31-49 Mbit/s
// reached us and its cameras gapped every ~5 s. This lets the owner see that from here.
//
//   GET /api/admin/nvrs/:id/netstatus
//     -> { totalMbps, remainMbps, usedMbps, sendTotalMbps, sendRemainMbps, sendUsedMbps,
//          ipGroup, ports: [{ port, ip, ipV6, fields }], at, note? }   (admins; at = when the NVR answered, ms)
//
// The request is queryNetStatus with an empty body, as the web client sends it (commonCfg getNetStatus,
// CommonFunctions GetPort); the same call shape streams.mjs uses for querySystemCaps. What is known of
// the answer, and how well:
//   content/bandwidth/{totalBandwidth, remainBandwidth, sendTotalBandwidth, sendRemainBandwidth}: seen
//     in the answers of nvr1 and nvr-2 (same model and firmware) by an earlier read-only probe over this
//     same SDK call, and they match the page's Total / Real-time Remain / Total Send / Real-time Remain
//     Send Bandwidth. The page's label for each element is inferred from the names and the matching
//     numbers: the page module itself (app/NetCfg/netStatus.js) was never captured.
//   content/nic/item/{ip, ipV6}, one item per Ethernet port, and content/ipGroup/{switch, ip, ipV6}, the
//     one address the web client checks first when switch is true (the ports working as one): from the
//     web client's own parsing, never seen in a real answer here.
// The rest of that page (each port's Online, DHCP, mask, gateway, DNS, MAC, PPPoE, service ports, NAT)
// probably comes from this answer too, under names nobody here has seen. So a port's other elements are
// passed through as the NVR names them (ports[].fields) rather than guessed at. UNVERIFIED.
//
// The NVR takes about 1.2 s to answer this (other reads take ~0.1 s; it probably measures over a
// window), in its one-at-a-time XML queue next to settings reads and clock checks. So one answer is
// kept for CACHE_MS and shared by every admin asking meanwhile: this is for looking, not for polling.
import { XML_HEADER, kid, kids, parseXml } from './xml.mjs'
import { xmlDegraded, xmlGen, xmlOnline } from './xml-session.mjs'

export const QUERY_NET_STATUS = 'queryNetStatus'
export const CACHE_MS = 5000
const MAX_FIELDS = 64 // per port: enough for a status page, and a strange answer cannot grow the reply
// never passed through, whatever the firmware puts on a status page
const SECRET = /pass|pwd|secret|key|token|auth/i
const text = (n) => (n?.text ?? '').trim()
const round = (n) => Math.round(n * 1000) / 1000

/** The request: queryNetStatus takes nothing (the web client adds only its token, which the SDK does not need). */
export const netStatusRequest = () => `${XML_HEADER}</request>`

// ---- units --------------------------------------------------------------------------------------
//
// The figures are whole Mbit/s. These NVRs mark them unit="MB", which would be megabytes, but they are
// megabits: the NVR's own page shows the same numbers as "192Mb", and in a test sendRemainBandwidth
// fell by about 42 while ~50 Mbit/s was pulled. So a bare number is Mbit/s and a B is read as bits
// wherever it appears; only the scale is taken from a unit, k (querySystemCaps writes its "used"
// figure in kbit/s, so another firmware might here) or G, from the text after the number or, failing
// that, from the unit attribute. A unit written after the number that is none of these gives null: a
// figure in an unknown unit is worse than none. An attribute that is none of these is ignored, as
// "MB" already has to be.

const SCALE = { k: 0.001, m: 1, g: 1000 }
/** k, M or G (bits or bytes, per second or not) -> its scale; nothing -> 1; anything else -> null. */
function scaleOf(unit) {
  const u = String(unit ?? '').trim()
  if (!u) return 1
  const m = /^([kmg])(?:b|bits?|bps)?(?:\/s)?$/i.exec(u)
  return m ? SCALE[m[1].toLowerCase()] : null
}

/** A bandwidth figure in Mbit/s, or null. `unit` is the element's unit attribute (see above). */
export function toMbps(value, unit) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(\S*)\s*$/.exec(String(value ?? ''))
  if (!m) return null
  const scale = m[2] ? scaleOf(m[2]) : (scaleOf(unit) ?? 1)
  return scale === null ? null : round(Number(m[1]) * scale)
}

const used = (total, remain) => (total === null || remain === null ? null : round(Math.max(0, total - remain)))

/** Every leaf under a node as { "path.to.leaf": text }, but not the names in skip or anything secret-looking. */
function leaves(node, skip) {
  const out = {}
  let count = 0
  const walk = (n, prefix) => {
    const seen = new Map()
    for (const c of n.children) {
      if (SECRET.test(c.name) || (!prefix && skip.includes(c.name))) continue
      const k = (seen.get(c.name) ?? 0) + 1
      seen.set(c.name, k)
      const path = `${prefix}${c.name}${k > 1 ? `[${k}]` : ''}`
      if (c.children.length) walk(c, `${path}.`)
      else if (count < MAX_FIELDS) {
        out[path] = text(c)
        count++
      }
    }
  }
  walk(node, '')
  return out
}

/**
 * What the NVR's answer says. Throws when it is not an answer at all, says it failed, or has no content.
 * camerasOnline: how many of its cameras are online, to tell an idle receive counter from one the
 * firmware leaves unfilled (below).
 */
export function parseNetStatus(xml, { camerasOnline = 0 } = {}) {
  const response = kid(parseXml(String(xml ?? '')), 'response')
  if (!response) throw new Error('the NVR did not answer with a document')
  const status = text(kid(response, 'status'))
  if (status && status !== 'success') {
    const code = text(kid(response, 'errorCode'))
    throw new Error(code === '536870953' ? 'this NVR login may not read the network status (no rights)' : `the NVR refused ${QUERY_NET_STATUS} (${status}${code ? `, code ${code}` : ''})`)
  }
  const content = kid(response, 'content')
  if (!content) throw new Error('the NVR answered with no network status')
  const bw = kid(content, 'bandwidth')
  const fig = (name) => {
    const n = kid(bw, name)
    return n ? toMbps(n.text, n.attrs?.unit) : null
  }
  const totalMbps = fig('totalBandwidth')
  const remainMbps = fig('remainBandwidth')
  const sendTotalMbps = fig('sendTotalBandwidth')
  const sendRemainMbps = fig('sendRemainBandwidth')
  let usedMbps = used(totalMbps, remainMbps)
  const notes = []
  if (!bw) notes.push('this NVR\'s answer carries no bandwidth figures')
  // Firmware 1.4.6 (rigginglot) said its whole receive budget was free while 11 cameras recorded into
  // it: it does not fill that counter in. So "all free" with cameras online is unknown, not 0. Its send
  // counter did move when streams were pulled from it, so that one is taken as it comes.
  if (usedMbps === 0 && camerasOnline > 0) {
    usedMbps = null
    notes.push(`the NVR says its whole receive budget is free with ${camerasOnline} camera${camerasOnline === 1 ? '' : 's'} online: its firmware probably does not count it`)
  }
  const group = kid(content, 'ipGroup')
  const ports = kids(kid(content, 'nic'), 'item').map((it, i) => ({
    port: i + 1,
    ...(it.attrs?.id ? { id: it.attrs.id } : {}),
    ip: text(kid(it, 'ip')) || null,
    ipV6: text(kid(it, 'ipV6')) || null,
    fields: leaves(it, ['ip', 'ipV6'])
  }))
  return {
    totalMbps,
    remainMbps,
    usedMbps,
    sendTotalMbps,
    sendRemainMbps,
    sendUsedMbps: used(sendTotalMbps, sendRemainMbps),
    ipGroup: group ? { on: /^true$/i.test(text(kid(group, 'switch'))), ip: text(kid(group, 'ip')) || null, ipV6: text(kid(group, 'ipV6')) || null } : null,
    ports,
    ...(notes.length ? { note: notes.join('; ') } : {})
  }
}

const cache = new WeakMap() // nvr -> { value, until }: its last answer
const asking = new WeakMap() // nvr -> the read in flight, shared by everyone who asks meanwhile

/**
 * One NVR's network status, from the cache when it is fresh. `query` is nvr-xml.mjs transparent
 * (injected: the tests have no NVR); clock is Date.now unless a test says otherwise.
 */
export function readNetStatus(nvr, query, clock = Date.now) {
  const hit = cache.get(nvr)
  if (hit && clock() < hit.until) return Promise.resolve(hit.value)
  let p = asking.get(nvr)
  if (p) return p
  p = (async () => {
    const camerasOnline = (nvr.channels ?? []).filter((c) => c.online && c.configured !== false).length
    const xml = await query(nvr, QUERY_NET_STATUS, netStatusRequest(), 'network status', { gen: xmlGen(nvr) })
    const at = clock()
    const value = { ...parseNetStatus(xml, { camerasOnline }), at }
    cache.set(nvr, { value, until: at + CACHE_MS })
    return value
  })().finally(() => asking.delete(nvr)) // (a failure is not kept: the next request asks again)
  asking.set(nvr, p)
  return p
}

/**
 * The route. @returns {Promise<[number, object]|null>} null when the path is not ours
 * @param {{ nvrs: Map, admin: boolean, query: Function, clock?: () => number }} deps
 */
export async function handleNetStatus(method, pathname, { nvrs, admin, query, clock = Date.now }) {
  const m = /^\/api\/admin\/nvrs\/([^/]+)\/netstatus$/.exec(pathname)
  if (!m) return null
  if (!admin) return [403, { error: 'Admins only' }]
  if (method !== 'GET') return [405, { error: 'Reading only: nothing about the NVR\'s network is changed from here' }]
  let id
  try {
    id = decodeURIComponent(m[1])
  } catch {
    return [404, { error: 'Unknown NVR' }] // a broken %-escape names no NVR
  }
  const nvr = nvrs.get(id)
  if (!nvr) return [404, { error: 'Unknown NVR' }]
  if (!xmlOnline(nvr)) return [409, { error: `${nvr.name} is offline` }]
  // optional work waits while the NVR recovers or its calls are late (nvrs.mjs degraded): a 1.2 s read
  // would only queue behind them
  if (xmlDegraded(nvr)) return [409, { error: `${nvr.name} is busy or recovering; try again in a minute` }]
  try {
    return [200, await readNetStatus(nvr, query, clock)]
  } catch (e) {
    // transparent's own refusals (SDK stuck, queue full, read breaker open: nothing was sent) keep
    // their 503 and retry hint; everything else is the NVR's error
    if (e?.status === 503) return [503, { error: e.message, ...(e.extra ?? {}) }]
    return [502, { error: e?.message ?? String(e) }]
  }
}
