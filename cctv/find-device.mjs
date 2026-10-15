// "Find device" (Sites page, admins): type a MAC, an address or a name and be told which site,
// recorder and camera it is, with its address and MAC wherever the server can know them.
//
// Nothing here talks to a recorder or a camera. It looks only at what the server already has:
//   1. the Cameras report (camera-export.mjs, read nightly): every recorder's cameras with name,
//      address, model, PoE. Recorders do not report their cameras' MACs (the field is empty on
//      the whole fleet), so a camera's MAC is known only from 3 or 4 below;
//   2. the recorders as the app has them now (nvrs.json + the live camera lists);
//   3. the server's own network table (/proc/net/arp): MAC <-> address of the devices on the
//      server's own network segments that it has talked to;
//   4. the TVT network search (mhed.mjs, UDP 23456, the request TVT's own tools send), run only
//      when asked (&search=1) through discovery.mjs, sharing its one-at-a-time lock. Recorders
//      and TVT cameras on the server's own segment answer with MAC, address and model.
// An address seen on the server's own network (3, 4) is tied to a camera only when that camera's
// recorder is reached on this network (not P2P) and the address is on one of the server's own
// networks: remote sites reuse the same private ranges (prod: four P2P sites have cameras in the
// server's own 192.168.0.0/22), and 10.151.151.x is every recorder's PoE network.
//
//   GET /api/admin/find-device?q=<text>[&search=1] -> { query, kind, results, notes, looked, more }
//
// The matching (findDevice and its helpers) is pure: no SDK, no network, testable anywhere.
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'

export const MAX_QUERY = 64
export const MAX_RESULTS = 60
/** Rows in the full discovery list (every recorder, camera and network device: 311 cameras on prod) */
export const MAX_ALL = 2000
const MAX_ARP_ROWS = 4096
const MAX_SEARCH_DEVICES = 256
const SEARCH_REUSE_MS = 15_000 // a second "search the network" within this reuses the last answer
const SEARCH_KEEP_MS = 60 * 60_000 // the last search is still shown (with its time) for an hour
const RATE_WINDOW_MS = 10_000
const RATE_MAX = 20 // lookups per window, for the whole server (admins only, a handful of people)

// ---- small pure helpers -----------------------------------------------------------

const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
export const isIp = (s) => typeof s === 'string' && IP_RE.test(s) && s.split('.').every((x) => Number(x) <= 255)
const toInt = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0) >>> 0
const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
/** Plain printable text from data that came off the network or a file; '' for anything else. */
const clean = (v, max = 64) => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, max) : '')

/**
 * Any common way of writing a MAC -> "aa:bb:cc:dd:ee:ff"; null if it is not a whole MAC.
 * aa:bb:cc:dd:ee:ff, AA-BB-CC-DD-EE-FF, aabb.ccdd.eeff (Cisco), aabbccddeeff.
 */
export function normaliseMac(s) {
  const t = String(s ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$|^[0-9a-f]{4}(\.[0-9a-f]{4}){2}$|^[0-9a-f]{12}$/.test(t)) return null
  const hex = t.replace(/[^0-9a-f]/g, '')
  if (/^0+$/.test(hex) || /^f+$/.test(hex)) return null // "no MAC" and broadcast
  return hex.match(/../g).join(':')
}

/**
 * What the admin typed: a whole MAC, the start or middle of one (3-5 pairs, e.g. a maker's
 * "58:5b:69"), a whole address, the start of one ("192.168.35." or "192.168.35"), or a name.
 * @returns {{ kind: 'mac'|'mac-part'|'ip'|'ip-part'|'name', value: string } | { error: string }}
 */
export function classifyQuery(q) {
  const t = String(q ?? '').trim()
  // everything the server knows, for the discovery list the page opens with (2026-10-15: "it's a discovery tool")
  if (t === '*') return { kind: 'all', value: '' }
  if (t.length < 2) return { error: 'Type at least 2 characters: a MAC, an address or a name.' }
  if (t.length > MAX_QUERY) return { error: `Type at most ${MAX_QUERY} characters.` }
  const mac = normaliseMac(t)
  if (mac) return { kind: 'mac', value: mac }
  if (/^[0-9a-f]{2}([:-][0-9a-f]{2}){2,4}[:-]?$/i.test(t)) return { kind: 'mac-part', value: t.toLowerCase().replace(/-/g, ':').replace(/:$/, '') }
  if (isIp(t)) return { kind: 'ip', value: t }
  if (/^\d{1,3}(\.\d{1,3}){1,2}\.?$/.test(t) && t.split('.').filter(Boolean).every((x) => Number(x) <= 255)) {
    return { kind: 'ip-part', value: t.endsWith('.') ? t : `${t}.` }
  }
  return { kind: 'name', value: t.toLowerCase() }
}

/**
 * /proc/net/arp -> [{ ip, mac, dev }]. Only complete entries (flag 0x2) with a real MAC: the
 * "incomplete" rows (00:00:00:00:00:00) are addresses the server asked for and nobody answered.
 */
export function parseArp(text) {
  const out = []
  const lines = String(text ?? '').split('\n')
  for (const line of lines.slice(1, MAX_ARP_ROWS + 1)) {
    const [ip, , flags, hw, , dev] = line.trim().split(/\s+/)
    if (!isIp(ip) || !(Number.parseInt(flags, 16) & 2)) continue
    const mac = normaliseMac(hw)
    if (mac) out.push({ ip, mac, dev: clean(dev, 16) })
  }
  return out
}

/**
 * Knocks once on every address of the server's own networks (TCP to port 80, given up after
 * timeoutMs), so that every device that is switched on answers the server's address lookup and lands
 * in its network table (/proc/net/arp), whether or not it has port 80 open: the table only holds devices
 * the server has talked to lately. Nothing is sent but the opening of a connection, closed at once.
 * Networks of more than maxHosts addresses are left out. Returns how many addresses were knocked on.
 * @param {{ net: number, mask: number, address: string }[]} nets
 */
export async function sweepNets(nets, { maxHosts = 1024, concurrency = 64, timeoutMs = 400, open = connect } = {}) {
  const hosts = []
  for (const n of nets ?? []) {
    const size = (~n.mask >>> 0) + 1
    if (size > maxHosts + 2) continue
    for (let i = 1; i < size - 1; i++) {
      const ip = toIp((n.net + i) >>> 0)
      if (ip !== n.address) hosts.push(ip)
    }
  }
  let next = 0
  const knock = (host) => new Promise((done) => {
    let sock
    const end = () => {
      try { sock?.destroy() } catch {}
      done()
    }
    try {
      sock = open({ host, port: 80 })
      sock.setTimeout?.(timeoutMs, end)
      sock.on?.('connect', end)
      sock.on?.('error', end)
    } catch {
      done()
    }
  })
  const worker = async () => {
    while (next < hosts.length) await knock(hosts[next++])
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker))
  return hosts.length
}

/** The server's own IPv4 networks, from os.networkInterfaces() (cidr like "192.168.1.232/22"). */
export function localNets(ifaces = networkInterfaces()) {
  const out = []
  for (const list of Object.values(ifaces ?? {})) {
    for (const a of list ?? []) {
      if (a?.family !== 'IPv4' && a?.family !== 4) continue
      if (a.internal || !isIp(a.address)) continue
      const bits = Number(String(a.cidr ?? '').split('/')[1])
      if (!Number.isInteger(bits) || bits < 8 || bits >= 32) continue // a /32 (a VPN's own address) holds nothing else
      const mask = (0xffffffff << (32 - bits)) >>> 0
      out.push({ address: a.address, net: (toInt(a.address) & mask) >>> 0, mask, cidr: a.cidr })
    }
  }
  return out
}
export const onLocalNet = (ip, nets) => isIp(ip) && (nets ?? []).some((n) => ((toInt(ip) & n.mask) >>> 0) === n.net)

/** "Camera 5 · North Gate" (channels are numbered from 0 inside, from 1 on screen, as in camera-choice.js). */
export const cameraLabel = (ch, name) => `Camera ${ch + 1}${name ? ` · ${name}` : ''}`

// ---- the index of everything the server knows -------------------------------------------

/**
 * Every recorder, camera and loose network device the server knows of, one entry each, with the
 * facts of every source merged in.
 * @param {object} data
 * @param {Array<{ id, name, site, host, port, sn, via, online, model, channels? }>} data.recorders the app's recorders now
 * @param {{ at: number, nvrs: object[] } | null} data.report the Cameras report snapshot
 * @param {Array<{ ip, mac, dev? }>} data.arp the server's network table (parsed)
 * @param {Array<object>} data.search the last TVT network search's devices (mhed.mjs decodeReply shape)
 * @param {Array<{ net, mask }>} data.nets the server's own networks
 */
export function buildIndex({ recorders = [], report = null, arp = [], search = [], nets = [] } = {}) {
  const recs = new Map()
  for (const r of recorders) {
    const via = r.via === 'p2p' || r.sn ? 'p2p' : 'lan'
    recs.set(r.id, {
      kind: 'recorder', nvr: r.id, nvrName: r.name || r.id, site: r.site || '', via, sn: r.sn || null,
      host: via === 'lan' ? r.host || null : null, port: Number(r.port) || null,
      ip: via === 'lan' && isIp(r.host) ? r.host : null, mac: null,
      model: r.model || null, online: typeof r.online === 'boolean' ? r.online : null, sources: new Set(['recorders'])
    })
  }
  const cams = new Map()
  const camOf = (nvr, ch, rec) => {
    const key = `${nvr}/${ch}`
    if (!cams.has(key)) {
      cams.set(key, {
        kind: 'camera', nvr, ch, nvrName: rec?.nvrName ?? nvr, site: rec?.site ?? '', via: rec?.via ?? 'lan',
        name: '', ip: null, mac: null, model: null, maker: null, online: null, poe: null, httpPort: null, sources: new Set()
      })
    }
    return cams.get(key)
  }
  // 1. the Cameras report (older), then 2. the live lists (newer) on top of it
  for (const n of Array.isArray(report?.nvrs) ? report.nvrs : []) {
    if (!n || typeof n.nvr !== 'string') continue
    let rec = recs.get(n.nvr)
    if (!rec) {
      // removed from the app since the report: still say where the camera was
      rec = { nvrName: n.nvrName || n.nvr, site: n.site || '', via: n.via === 'p2p' ? 'p2p' : 'lan' }
    } else if (!rec.model && n.nvrModel) rec.model = n.nvrModel
    if (recs.has(n.nvr)) recs.get(n.nvr).sources.add('report')
    for (const c of Array.isArray(n.cameras) ? n.cameras : []) {
      if (!Number.isInteger(c?.ch)) continue
      const cam = camOf(n.nvr, c.ch, rec)
      cam.name = c.name || cam.name
      cam.ip = isIp(c.ip) ? c.ip : cam.ip
      cam.mac = normaliseMac(c.mac) ?? cam.mac
      cam.model = c.model || cam.model
      cam.maker = c.maker || cam.maker
      cam.online = typeof c.online === 'boolean' ? c.online : cam.online
      cam.poe = typeof c.poe === 'boolean' ? c.poe : cam.poe
      cam.httpPort = Number(c.httpPort) || cam.httpPort
      cam.sources.add('report')
    }
  }
  for (const r of recorders) {
    const rec = recs.get(r.id)
    for (const c of Array.isArray(r.channels) ? r.channels : []) {
      if (!Number.isInteger(c?.ch)) continue
      const cam = camOf(r.id, c.ch, rec)
      if (c.name) cam.name = c.name
      if (isIp(c.ip)) cam.ip = c.ip
      if (c.model) cam.model = c.model
      if (c.maker) cam.maker = c.maker
      if (typeof c.online === 'boolean') cam.online = c.online
      if (Number(c.httpPort)) cam.httpPort = Number(c.httpPort)
      cam.sources.add('live')
    }
  }

  // 3. and 4.: what was seen on the server's own network, tied to a recorder or camera where the
  // address can only be that one, otherwise listed as a device of its own
  const loose = new Map()
  const reachable = (e) => e.via === 'lan' && onLocalNet(e.ip, nets)
  const observe = (obs, source) => {
    let tied = false
    for (const rec of recs.values()) {
      if (rec.ip && rec.ip === obs.ip && rec.via === 'lan') {
        rec.mac ??= obs.mac
        if (!rec.model && obs.model) rec.model = obs.model
        rec.sources.add(source)
        tied = true
      }
    }
    for (const rec of recs.values()) {
      if (!tied && rec.via === 'p2p' && obs.name && (rec.nvrName ?? '').toLowerCase() === obs.name.toLowerCase()) {
        rec.sources.add(source)
        tied = true
      }
    }
    for (const cam of cams.values()) {
      if (cam.ip === obs.ip && reachable(cam)) {
        cam.mac ??= obs.mac
        if (!cam.model && obs.model) cam.model = obs.model
        cam.sources.add(source)
        tied = true
      }
    }
    if (tied) return
    const key = `${obs.ip}|${obs.mac ?? ''}`
    const dev = loose.get(key) ?? { kind: 'device', ip: obs.ip, mac: obs.mac ?? null, name: '', model: null, type: null, sources: new Set() }
    if (obs.name && !dev.name) dev.name = obs.name
    if (obs.model && !dev.model) dev.model = obs.model
    if (obs.type && !dev.type) dev.type = obs.type
    dev.sources.add(source)
    loose.set(key, dev)
  }
  for (const a of arp) if (isIp(a?.ip) && normaliseMac(a.mac)) observe({ ip: a.ip, mac: normaliseMac(a.mac) }, 'arp')
  for (const d of (search ?? []).slice(0, MAX_SEARCH_DEVICES)) {
    const ip = clean(d?.ip, 15)
    if (!isIp(ip)) continue
    observe({ ip, mac: normaliseMac(d.mac), name: clean(d.name, 32), model: clean(d.model, 40), type: clean(d.type, 16) }, 'search')
  }
  return [...recs.values(), ...cams.values(), ...loose.values()]
}

// ---- matching ---------------------------------------------------------------------

const ownName = (e) => (e.kind === 'recorder' ? e.nvrName : e.name) || ''

/** How well an entry matches (lower is better); null when it does not. */
function score(e, q) {
  switch (q.kind) {
    // The discovery list (2026-10-15: "only what's on my network", "only the TVT related things", "only
    // show things that are not added in the system"): the TVT devices that answered TVT's own network
    // search and are not a recorder or camera Argus already has (those are tied to it, never 'device')
    case 'all': return e.kind === 'device' && e.sources.has('search') ? 0 : null
    case 'mac': return e.mac === q.value ? 0 : null
    case 'mac-part': return e.mac?.includes(q.value) ? 1 : null
    case 'ip': return e.ip === q.value ? 0 : null
    case 'ip-part': return e.ip?.startsWith(q.value) ? 1 : null
    default: {
      const t = q.value
      const own = ownName(e).toLowerCase()
      if (own === t) return 0
      if (own.includes(t)) return 1
      if ((e.model ?? '').toLowerCase().includes(t)) return 2
      if ((e.kind !== 'recorder' && (e.nvrName ?? '').toLowerCase().includes(t)) || (e.site ?? '').toLowerCase().includes(t)) return 3
      return null
    }
  }
}

const KIND_ORDER = { recorder: 0, camera: 1, device: 2 }

/** Why a found camera's (or device's) MAC is missing, in plain words; null when nothing needs saying. */
function noteFor(e, nets) {
  if (e.kind === 'device') {
    return e.type === 'IP camera'
      ? 'A TVT camera on the server’s own network that none of the recorders lists (or lists at another address).'
      : 'A device on the server’s own network. None of the recorders lists a camera at this address on this network.'
  }
  if (e.kind === 'recorder') {
    if (e.via === 'p2p') return `Reached through the P2P cloud (serial ${e.sn}): its address and MAC on its own site’s network are not known here.`
    if (!e.mac) return onLocalNet(e.ip, nets) ? 'The server has not talked to this address directly lately, so its MAC is not in the server’s network table. Search the network to ask it.' : 'On another network (routed or VPN): its MAC can only be read on site, on its label or its own web page.'
    return null
  }
  if (e.mac) return null
  if (e.via === 'p2p') return `At ${e.site || e.nvrName}, reached through the P2P cloud: recorders do not report their cameras’ MACs, so it can only be read on site (the camera’s label) or on the camera’s own web page.`
  if (e.poe) return `Plugged into ${e.nvrName}’s PoE ports, on the recorder’s own camera network: recorders do not report their cameras’ MACs, so it can only be read on site (the camera’s label) or on the camera’s own web page.`
  if (!onLocalNet(e.ip, nets)) return `On ${e.nvrName}’s camera network, which the server does not reach directly: recorders do not report their cameras’ MACs, so it can only be read on site (the camera’s label) or on the camera’s own web page.`
  return 'On the server’s own network, but the server has not talked to it directly, so its MAC is not in the server’s network table. If it is a TVT camera, Search the network may find it.'
}

/**
 * The matches for what was typed, best first, as plain rows for the page.
 * @returns {{ query, kind, results: object[], more: number, notes: string[] } | { error: string }}
 */
export function findDevice(query, data = {}, { max = MAX_RESULTS } = {}) {
  const q = classifyQuery(query)
  if (q.error) return { error: q.error }
  const nets = data.nets ?? []
  const hits = []
  for (const e of buildIndex(data)) {
    const s = score(e, q)
    if (s !== null) hits.push({ e, s })
  }
  hits.sort((a, b) =>
    a.s - b.s ||
    (a.e.kind === 'device') - (b.e.kind === 'device') || // what the app knows first, loose devices after
    (a.e.site ?? '').localeCompare(b.e.site ?? '') ||
    (a.e.nvrName ?? '').localeCompare(b.e.nvrName ?? '') ||
    KIND_ORDER[a.e.kind] - KIND_ORDER[b.e.kind] ||
    (a.e.ch ?? 0) - (b.e.ch ?? 0) ||
    (a.e.ip ?? '').localeCompare(b.e.ip ?? '')
  )
  const results = hits.slice(0, max).map(({ e }) => ({
    kind: e.kind,
    site: e.site ?? null,
    nvr: e.nvr ?? null,
    nvrName: e.nvrName ?? null,
    ch: e.kind === 'camera' ? e.ch : null,
    label: e.kind === 'camera' ? cameraLabel(e.ch, e.name) : e.kind === 'recorder' ? e.nvrName : e.name || e.type || 'Device',
    address: e.kind === 'recorder' && e.via === 'p2p' ? `P2P cloud, serial ${e.sn}` : e.kind === 'recorder' && e.host && !e.ip ? e.host : e.ip,
    ip: e.ip ?? null,
    mac: e.mac ?? null,
    model: [e.maker && e.model && !e.model.toLowerCase().startsWith(e.maker.toLowerCase()) ? e.maker : null, e.model].filter(Boolean).join(' ') || null,
    type: e.kind === 'device' ? e.type : null,
    online: typeof e.online === 'boolean' ? e.online : null,
    poe: e.kind === 'camera' ? e.poe : null,
    via: e.via ?? null,
    sources: [...e.sources],
    note: noteFor(e, nets)
  }))

  const notes = []
  // the same private address at several recorders: different cameras on different networks
  if (q.kind === 'ip') {
    const where = new Set(results.filter((r) => r.kind === 'camera').map((r) => r.nvr))
    if (where.size > 1) notes.push(`${where.size} recorders each have a camera at ${q.value}. Each recorder has its own camera network (PoE ports, or its site’s network), so these are different cameras.`)
    if (where.size >= 1 && results.some((r) => r.kind === 'device')) notes.push(`The device at ${q.value} on the server’s own network is not ${where.size === 1 ? 'that camera' : 'one of those cameras'}: ${where.size === 1 ? 'it is' : 'they are'} on another network that uses the same addresses.`)
  }
  if ((q.kind === 'mac' || q.kind === 'mac-part') && results.length === 0) {
    notes.push('Recorders do not report their cameras’ MACs, so a MAC is found only for devices on the server’s own network (its network table, or a network search). A camera on a recorder’s PoE ports or at another site can be found by its name or address instead; its MAC is on its label and on the camera’s own web page.')
  } else if (results.length === 0) {
    notes.push('Only the recorders the app has, their cameras and the devices on the server’s own network can be found. A camera’s MAC is never reported by its recorder: on a PoE port or at another site it is read on site (the camera’s label) or on the camera’s own web page.')
  }
  return { query: String(query).trim(), kind: q.kind, results, more: Math.max(0, hits.length - results.length), notes }
}

// ---- the route ----------------------------------------------------------------------

/** The server's network table now: { ok, rows, why? }. Linux only; elsewhere it says so. */
export function readArpTable(file = '/proc/net/arp') {
  try {
    return { ok: true, rows: parseArp(readFileSync(file, 'utf8')) }
  } catch (e) {
    return { ok: false, rows: [], why: process.platform === 'linux' ? `could not be read (${e.code ?? e.message})` : 'only available when the server runs on Linux' }
  }
}

/**
 * The handler. Everything it reads comes in through `ctx`, so it is testable without the SDK:
 * @param {{
 *   recorders: () => object[],
 *   report: () => ({ at: number, nvrs: object[] } | null),
 *   arp?: () => { ok: boolean, rows: object[], why?: string },
 *   nets?: () => object[],
 *   search?: () => Promise<{ ran: boolean, devices?: object[], why?: string }>,
 *   now?: () => number
 * }} ctx
 */
export function makeFindDevice(ctx) {
  const now = ctx.now ?? Date.now
  let last = null // { at, ran, devices, why } of the last network search
  let pending = null
  let calls = []

  async function runSearch() {
    if (last && now() - last.at < SEARCH_REUSE_MS) return last
    if (!pending) {
      pending = (async () => {
        try {
          // every address of the network knocked on first, so the network table lists everything switched on
          try { await ctx.sweep?.() } catch {}
          const r = (await ctx.search?.()) ?? { ran: false, why: 'not available here' }
          last = { at: now(), ran: Boolean(r.ran), devices: Array.isArray(r.devices) ? r.devices.slice(0, MAX_SEARCH_DEVICES) : [], why: r.why ? clean(r.why, 200) : null }
        } catch (e) {
          last = { at: now(), ran: false, devices: [], why: clean(String(e?.message ?? e), 200) }
        } finally {
          pending = null
        }
        return last
      })()
    }
    return pending
  }

  return async function handleFindDevice(method, params) {
    if (method !== 'GET') return [405, { error: 'Method not allowed' }]
    const t = now()
    calls = calls.filter((c) => t - c < RATE_WINDOW_MS)
    if (calls.length >= RATE_MAX) return [429, { error: 'Too many lookups at once. Wait a few seconds and try again.' }]
    calls.push(t)
    const q = String(params.get('q') ?? '')
    const checked = classifyQuery(q)
    if (checked.error) return [400, { error: checked.error }]
    const searchNow = params.get('search') === '1'
    const search = searchNow ? await runSearch() : last && t - last.at < SEARCH_KEEP_MS ? last : null
    const arp = ctx.arp?.() ?? { ok: false, rows: [], why: 'not available here' }
    const report = ctx.report?.() ?? null
    const recorders = ctx.recorders?.() ?? []
    const answer = findDevice(q, {
      recorders,
      report,
      arp: arp.rows,
      search: search?.ran ? search.devices : [],
      nets: ctx.nets?.() ?? localNets()
    }, { max: checked.kind === 'all' ? MAX_ALL : MAX_RESULTS })
    const reportCams = (report?.nvrs ?? []).reduce((n, x) => n + (Array.isArray(x?.cameras) ? x.cameras.length : 0), 0)
    // where it looked, so "Nothing matches" can say so (the page puts it in words)
    answer.looked = {
      report: report ? { at: Number(report.at) || null, recorders: (report.nvrs ?? []).length, cameras: reportCams } : null,
      live: { recorders: recorders.length, cameras: recorders.reduce((n, r) => n + (r.channels?.length ?? 0), 0) },
      arp: { ok: arp.ok, devices: arp.rows.length, why: arp.why ?? null },
      search: search ? { at: search.at, ran: search.ran, devices: search.devices.length, why: search.why, now: searchNow } : null
    }
    return [200, answer]
  }
}
