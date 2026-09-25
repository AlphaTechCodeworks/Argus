// Admin API: manage NVRs and sites from the app (admins only; see auth.isAdmin).
// Writes data/nvrs.json, which nvrs.mjs watches, so changes apply within seconds.
//
//   GET    /api/admin/nvrs        -> [{ id, site, name, host, port, sn, via, user, status, error, model, cameras, camerasOnline }]
//   POST   /api/admin/nvrs        { site, name, host, port, user, password, skipTest? } -> { id, model }
//                                  or { site, name, sn, user, password, skipTest? }: by serial number,
//                                  through TVT's P2P relay (host/port default to the relay)
//   PUT    /api/admin/nvrs/:id    { site?, name?, host?, port?, sn?, user?, password?, skipTest? } -> { id, model? }
//                                  (sn: '' switches back to connecting by address; send host then)
//   DELETE /api/admin/nvrs/:id
//
// Passwords are never sent back to the browser. Connection changes are tested
// with a real login first unless skipTest is set (e.g. the NVR is switched off).
import { cleanNvrFields, nvrs, readConfig, testLogin, uniqueId, whereIs, writeConfig } from './nvrs.mjs'
import { readVpn, vpnSiteFor } from './vpn.mjs'

const publicView = (cfg, vpn = { sites: [] }) => {
  const live = nvrs.get(cfg.id)?.info()
  const site = cfg.sn ? null : vpnSiteFor(cfg.host, vpn)
  return {
    id: cfg.id,
    site: cfg.site,
    name: cfg.name,
    host: cfg.host,
    port: cfg.port,
    sn: cfg.sn || '',
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
    subStreamsSeen: live?.subStreamsSeen ?? { h264: 0, h265: 0 }
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

/**
 * @param {string} method
 * @param {string} pathname
 * @param {() => Promise<any>} readJson
 * @returns {Promise<[number, any]>} status and body
 */
export async function handleAdmin(method, pathname, readJson) {
  try {
    const id = decodeURIComponent(pathname.slice('/api/admin/nvrs/'.length))
    const cfg = readConfig()

    if (pathname === '/api/admin/nvrs' && method === 'GET') {
      const vpn = readVpn()
      return [200, cfg.nvrs.map((n) => publicView(n, vpn))]
    }

    if (pathname === '/api/admin/nvrs' && method === 'POST') {
      const body = await readJson()
      const fields = cleanNvrFields(body)
      const password = String(body.password ?? '')
      if (!password) throw new HttpError(400, 'password is required')
      // the same device twice: same serial number, or (by address) same address and port
      const same = (n) => (fields.sn ? n.sn === fields.sn : !n.sn && n.host === fields.host && n.port === fields.port)
      if (cfg.nvrs.some(same)) throw new HttpError(409, `${whereIs(fields)} is already in the list`)
      const model = await tested({ ...fields, password }, body.skipTest)
      const nvr = { id: uniqueId(fields.name, new Set(cfg.nvrs.map((n) => n.id))), ...fields, password }
      if (!nvr.sn) delete nvr.sn
      writeConfig({ nvrs: [...readConfig().nvrs, nvr] })
      console.log(`[admin] added ${nvr.id} (${nvr.name}) at ${whereIs(nvr)}, site "${nvr.site}"`)
      return [201, { id: nvr.id, model }]
    }

    if (pathname.startsWith('/api/admin/nvrs/') && id) {
      const current = cfg.nvrs.find((n) => n.id === id)
      if (!current) throw new HttpError(404, 'No such NVR')

      if (method === 'DELETE') {
        writeConfig({ nvrs: readConfig().nvrs.filter((n) => n.id !== id) })
        console.log(`[admin] removed ${id}`)
        return [200, { id }]
      }

      if (method === 'PUT') {
        const body = await readJson()
        const fields = cleanNvrFields(body, { partial: true })
        const next = { ...current, ...fields }
        if (!next.sn) delete next.sn
        if (body.password) next.password = String(body.password)
        if (next.sn && cfg.nvrs.some((n) => n.id !== id && n.sn === next.sn)) throw new HttpError(409, `${whereIs(next)} is already in the list`)
        const connectionChanged = ['host', 'port', 'user', 'password', 'sn'].some((k) => (next[k] ?? '') !== (current[k] ?? ''))
        const model = connectionChanged ? await tested(next, body.skipTest) : ''
        writeConfig({ nvrs: readConfig().nvrs.map((n) => (n.id === id ? next : n)) })
        console.log(`[admin] updated ${id}${connectionChanged ? ' (connection settings)' : ''}`)
        return [200, { id, model }]
      }
    }
    return [404, { error: 'Not found' }]
  } catch (e) {
    if (e instanceof HttpError) return [e.status, { error: e.message, ...e.extra }]
    return [400, { error: e.message }]
  }
}
