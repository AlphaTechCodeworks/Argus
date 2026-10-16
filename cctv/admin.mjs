// Admin API: manage NVRs and sites from the app (admins only; see auth.isAdmin).
// Writes data/nvrs.json, which nvrs.mjs watches, so changes apply within seconds.
//
//   GET    /api/admin/nvrs        -> [{ id, site, name, brand, host, port, sn, via, user, status, error, model, cameras, camerasOnline, p2p? }]
//   POST   /api/admin/nvrs        { site, name, host, port, user, password, skipTest? } -> { id, model }
//                                  or { site, name, sn, user, password, skipTest? }: by serial number (the
//                                  NVR's cloud ID), through the P2P cloud; no host/port (any sent are not used)
//                                  or { brand: 'hikvision', site, name, host, port (8000), user, password, p2p?, skipTest? }
//   PUT    /api/admin/nvrs/:id    { site?, name?, host?, port?, sn?, user?, password?, p2p?, skipTest? } -> { id, model? }
//                                  (sn: '' switches back to connecting by address; send host then)
//   DELETE /api/admin/nvrs/:id
//   POST   /api/admin/nvr-test    { brand: 'hikvision', host, port, user, password?, id?, p2p? } -> { model, serial, cameras, ... }
//                                  one test login to a Hikvision device, nothing saved (id: an existing
//                                  device's stored password and Hik-Connect secrets fill in what is not sent)
//
// Passwords are never sent back to the browser. Connection changes are tested
// with a real login first unless skipTest is set (e.g. the NVR is switched off).
// Every change and test is written to the audit trail (ctx.audit, from server.mjs).
import { cleanHikFields, isHik, publicP2p } from './hik-config.mjs'
import { testHikLogin } from './hik-nvr.mjs'
import { cleanNvrFields, nvrs, readConfig, testLogin, uniqueId, whereIs, writeConfig } from './nvrs.mjs'
import { readVpn, vpnSiteFor } from './vpn.mjs'

const publicView = (cfg, vpn = { sites: [] }) => {
  const live = nvrs.get(cfg.id)?.info()
  const site = cfg.sn ? null : vpnSiteFor(cfg.host, vpn)
  return {
    id: cfg.id,
    site: cfg.site,
    name: cfg.name,
    brand: isHik(cfg) ? 'hikvision' : 'tvt',
    host: cfg.host,
    port: cfg.port,
    sn: cfg.sn || '',
    nat: cfg.sn ? (Number(cfg.nat) === 1 ? 1 : 2) : null, // P2P generation: 1 = NAT 1.0, 2 = NAT 2.0
    via: cfg.sn ? 'p2p' : site ? 'vpn' : 'lan',
    remote: Boolean(cfg.sn || cfg.remote),
    // reached through the VPN hub (deploy/vpn): which site, and whether its tunnel is up
    vpnSite: site ? { id: site.id, name: site.name, connected: site.connected, lastHandshakeAgoS: site.lastHandshakeAgoS } : null,
    user: cfg.user,
    status: live?.status ?? 'connecting',
    error: live?.error ?? '',
    model: live?.model ?? '',
    serial: live?.serial ?? '',
    cameras: live?.cameras ?? 0,
    camerasOnline: live?.camerasOnline ?? 0,
    // codec actually seen on each camera's sub stream since start-up (from the video itself)
    subStreamsSeen: live?.subStreamsSeen ?? { h264: 0, h265: 0 },
    // Hikvision: Hik-Connect, without its secrets (only whether each one is set)
    p2p: isHik(cfg) ? publicP2p(cfg) : null
  }
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

const tested = async (settings, skipTest) => {
  if (skipTest) return ''
  try {
    return await testLogin(settings)
  } catch (e) {
    throw new HttpError(422, `Could not log in to ${whereIs(settings)}: ${e.message}`, { testFailed: true })
  }
}

/** A Hikvision device's test login (a child process): its model, or 422 with the plain reason. */
const testedHik = async (settings, skipTest, test = testHikLogin) => {
  if (skipTest) return ''
  try {
    return (await test(settings)).model
  } catch (e) {
    throw new HttpError(422, `Could not log in to the Hikvision device at ${settings.host}:${settings.port}: ${e.message}`, { testFailed: true })
  }
}

/**
 * @param {string} method
 * @param {string} pathname
 * @param {() => Promise<any>} readJson
 * @param {{ audit?: (row: object) => void, testHik?: Function }} [ctx] audit: one audit row (server.mjs
 *   adds the user, address and device); testHik: tests only
 * @returns {Promise<[number, any]>} status and body
 */
export async function handleAdmin(method, pathname, readJson, ctx = {}) {
  const note = (row) => {
    try {
      ctx.audit?.({ action: 'settings-change', ok: true, ...row })
    } catch {}
  }
  const testHik = ctx.testHik ?? testHikLogin
  try {
    const id = decodeURIComponent(pathname.slice('/api/admin/nvrs/'.length))
    const cfg = readConfig()

    if (pathname === '/api/admin/nvrs' && method === 'GET') {
      const vpn = readVpn()
      return [200, cfg.nvrs.map((n) => publicView(n, vpn))]
    }

    // Test a Hikvision device's login without saving anything (the Sites dialog's "Test")
    if (pathname === '/api/admin/nvr-test' && method === 'POST') {
      const body = await readJson()
      if (body.brand !== 'hikvision') throw new HttpError(400, 'Only a Hikvision device can be tested here; a TVT NVR is tested by “Test & save”')
      const current = body.id ? cfg.nvrs.find((n) => n.id === body.id && isHik(n)) ?? null : null
      const fields = cleanHikFields({ ...body, site: body.site || 'test', name: body.name || 'test', user: body.user }, { current })
      const password = body.password ? String(body.password) : current?.password ?? ''
      if (!password) throw new HttpError(400, 'password is required')
      const target = `${fields.host}:${fields.port}`
      try {
        const r = await testHik({ ...fields, password, p2p: fields.p2p ?? current?.p2p ?? null })
        note({ target, detail: `Hikvision test login: ${r.model}${r.serial ? `, serial ${r.serial}` : ''}, ${r.cameras} cameras` })
        return [200, { model: r.model, name: r.name, serial: r.serial, cameras: r.cameras, channels: r.channels, sdkVersion: r.sdkVersion, note: r.note || '', p2p: r.p2p ?? null }]
      } catch (e) {
        note({ target, ok: false, detail: `Hikvision test login failed: ${e.message}` })
        return [422, { error: e.message, testFailed: true, p2p: e.p2p ?? null }]
      }
    }

    if (pathname === '/api/admin/nvrs' && method === 'POST') {
      const body = await readJson()
      const hik = body.brand === 'hikvision'
      const fields = hik ? cleanHikFields(body) : cleanNvrFields(body)
      const password = String(body.password ?? '')
      if (!password) throw new HttpError(400, 'password is required')
      // the same device twice: same serial number, or (by address) same address and port
      const same = (n) => (fields.sn ? n.sn === fields.sn : !n.sn && n.host === fields.host && n.port === fields.port)
      if (cfg.nvrs.some(same)) throw new HttpError(409, `${whereIs(fields)} is already in the list`)
      const model = hik ? await testedHik({ ...fields, password }, body.skipTest, testHik) : await tested({ ...fields, password }, body.skipTest)
      const nvr = { id: uniqueId(fields.name, new Set(cfg.nvrs.map((n) => n.id))), ...fields, password }
      if (!nvr.sn) delete nvr.sn
      if (!nvr.p2p) delete nvr.p2p
      writeConfig({ nvrs: [...readConfig().nvrs, nvr] })
      console.log(`[admin] added ${nvr.id} (${nvr.name}) at ${whereIs(nvr)}, site "${nvr.site}"${hik ? ' (Hikvision)' : ''}`)
      note({ target: nvr.id, detail: `added ${hik ? 'Hikvision device' : 'NVR'} ${nvr.name} at ${whereIs(nvr)}, site "${nvr.site}"${body.skipTest ? ' (not tested)' : ''}` })
      return [201, { id: nvr.id, model }]
    }

    if (pathname.startsWith('/api/admin/nvrs/') && id) {
      const current = cfg.nvrs.find((n) => n.id === id)
      if (!current) throw new HttpError(404, 'No such NVR')

      if (method === 'DELETE') {
        writeConfig({ nvrs: readConfig().nvrs.filter((n) => n.id !== id) })
        console.log(`[admin] removed ${id}`)
        note({ target: id, detail: `removed ${current.name} (${whereIs(current)})` })
        return [200, { id }]
      }

      if (method === 'PUT') {
        const body = await readJson()
        const hik = isHik(current)
        if (body.brand !== undefined && (body.brand === 'hikvision') !== hik) throw new HttpError(400, 'The make of a recorder cannot be changed: remove it and add it again')
        const fields = hik ? cleanHikFields(body, { partial: true, current }) : cleanNvrFields(body, { partial: true })
        const next = { ...current, ...fields }
        if (!next.sn) delete next.sn
        if (!next.p2p) delete next.p2p
        if (body.password) next.password = String(body.password)
        if (next.sn && cfg.nvrs.some((n) => n.id !== id && n.sn === next.sn)) throw new HttpError(409, `${whereIs(next)} is already in the list`)
        const connectionChanged = ['host', 'port', 'user', 'password', 'sn', 'nat'].some((k) => (next[k] ?? '') !== (current[k] ?? '')) || (hik && JSON.stringify(next.p2p ?? null) !== JSON.stringify(current.p2p ?? null))
        const model = connectionChanged ? (hik ? await testedHik(next, body.skipTest, testHik) : await tested(next, body.skipTest)) : ''
        writeConfig({ nvrs: readConfig().nvrs.map((n) => (n.id === id ? next : n)) })
        console.log(`[admin] updated ${id}${connectionChanged ? ' (connection settings)' : ''}`)
        const what = Object.keys(fields).filter((k) => JSON.stringify(fields[k]) !== JSON.stringify(current[k]) && k !== 'brand')
        if (body.password) what.push('password')
        note({ target: id, detail: `changed ${current.name}: ${what.length ? what.join(', ') : 'nothing'}${connectionChanged && body.skipTest ? ' (not tested)' : ''}` })
        return [200, { id, model }]
      }
    }
    return [404, { error: 'Not found' }]
  } catch (e) {
    if (e instanceof HttpError) return [e.status, { error: e.message, ...e.extra }]
    return [400, { error: e.message }]
  }
}
