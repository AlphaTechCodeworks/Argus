// The NVR's own per-channel status, read over P2P where GetDeviceIPCInfo is unreliable (it returns
// an empty list at random, wiping the camera states). These two queries are small and answer in
// ~100-200 ms over the cloud, and they agree with GetDeviceIPCInfo when it does answer:
//   queryOnlineChlList  -> which channels the NVR has online        (parseOnlineChlList -> Set<ch>)
//   queryRecStatus      -> per-channel recording + resolution/fps   (parseRecStatus -> Map<ch, row>)
//
// Channel ids are GUIDs, {0000000N-0000-...}; the number N is 1-based, so ch = N - 1 (the 0-based
// channel GetDeviceIPCInfo and the rest of the app use). Confirmed against g-port, 2026-10-05:
// queryOnlineChlList's eight ids mapped exactly onto GetDeviceIPCInfo's eight online channels.
//
// Pure (XML in, data out), so tested on its own: test/nvr-online.test.mjs.
import { kid, kids, parseXml } from './xml.mjs'

const text = (node) => (node?.text ?? '').trim()

/** The 0-based channel of a {0000000N-...} GUID, or null if it is not one. */
export function chOfGuid(id) {
  const m = /\{?\s*([0-9a-fA-F]{8})\b/.exec(String(id ?? ''))
  if (!m) return null
  const n = parseInt(m[1], 16)
  return Number.isFinite(n) && n >= 1 ? n - 1 : null
}

/** Every <item> directly under an element called `name`, at any depth. */
function itemsUnder(root, name) {
  const out = []
  const walk = (node) => {
    for (const c of node.children) {
      if (c.name === name) out.push(...kids(c, 'item'))
      walk(c)
    }
  }
  walk(root)
  return out
}

const okResponse = (xml) => {
  const response = kid(parseXml(xml), 'response')
  if (!response || text(kid(response, 'status')) !== 'success') return null
  return response
}

/**
 * queryOnlineChlList -> the set of 0-based channels the NVR reports online, or null when the answer
 * was not a success we could read (so the caller keeps whatever it had rather than blanking it).
 */
export function parseOnlineChlList(xml) {
  const response = okResponse(xml)
  if (!response) return null
  const set = new Set()
  for (const item of itemsUnder(response, 'content')) {
    const ch = chOfGuid(item.attrs?.id)
    if (ch !== null) set.add(ch)
  }
  return set
}

const sizeOf = (res) => {
  const m = /(\d+)\s*[x*]\s*(\d+)/i.exec(String(res ?? ''))
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null
}

/**
 * queryRecStatus -> Map<ch, { ch, name, recStatus, main, sub }>, or null on a non-success answer.
 *  - recStatus: 'on' | 'off' | 'abnormal' (the NVR's word; main stream's preferred)
 *  - main / sub: { resolution: 'WxH', w, h, fps } | null
 * There is one <item> per channel per stream (and sometimes a summary item with no streamType).
 */
export function parseRecStatus(xml) {
  const response = okResponse(xml)
  if (!response) return null
  const byCh = new Map()
  for (const item of itemsUnder(response, 'content')) {
    const chl = kid(item, 'chl')
    const ch = chOfGuid(chl?.attrs?.id)
    if (ch === null) continue
    let row = byCh.get(ch)
    if (!row) byCh.set(ch, (row = { ch, name: '', recStatus: '', main: null, sub: null }))
    const name = text(chl)
    if (name && !row.name) row.name = name
    const streamType = text(kid(item, 'streamType')).toLowerCase()
    const recStatus = text(kid(item, 'recStatus')).toLowerCase()
    if (recStatus && (streamType === 'main' || !row.recStatus)) row.recStatus = recStatus
    const resolution = text(kid(item, 'resolution'))
    const size = sizeOf(resolution)
    if (size && (streamType === 'main' || streamType === 'sub')) {
      const fpsText = text(kid(item, 'frameRate'))
      const fps = /^\d+$/.test(fpsText) ? Number(fpsText) : null
      row[streamType] = { resolution, w: size.w, h: size.h, fps }
    }
  }
  return byCh
}
