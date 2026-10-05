// NVR register: one row per NVR with its site, how it is reached, live status, camera counts AND the
// login (username + password) the app uses to connect to it. This is the ONE place the stored NVR
// passwords are shown, so both routes are admin-only (server.mjs) and the page keeps the passwords
// hidden until asked. Self-updating: built live from the running NVRs and the (watched) config on
// every request -- no snapshot, no NVR query (everything is already in memory), so it is cheap to
// open as often as you like.
//
//   GET /api/admin/register      -> { at, nvrs: [...] }          (admins)
//   GET /api/admin/register.xlsx -> the same, as a spreadsheet   (admins)
import { buildXlsx } from './xlsx-writer.mjs'

/** @param {Map<string, import('./nvrs.mjs').Nvr>} nvrs */
export function nvrRegister(nvrs) {
  const out = []
  for (const nvr of nvrs.values()) {
    const i = nvr.info()
    out.push({
      site: i.site,
      name: i.name,
      id: i.id,
      via: i.via,
      sn: i.sn || '',
      nat: nvr.cfg.sn ? Number(nvr.cfg.nat) || 2 : null,
      host: nvr.cfg.host || '',
      port: nvr.cfg.port || null,
      status: i.status,
      error: i.error || '',
      model: i.model || '',
      serial: i.serial || '',
      cameras: i.cameras,
      camerasOnline: i.camerasOnline,
      user: nvr.cfg.user || ''
    })
  }
  return out
}

/** How an NVR is reached, for a cell. */
export const connectionOf = (n) => (n.sn ? `P2P serial ${n.sn}${Number(n.nat) === 1 ? ' (NAT 1.0)' : ''}` : `${n.host}${n.port ? `:${n.port}` : ''}`)

export const REGISTER_COLUMNS = ['Site', 'NVR', 'Connection', 'Status', 'Cameras online', 'Cameras total', 'Login user', 'Model', 'NVR serial', 'ID']

/** The register flattened to header + one row per NVR. */
export function registerRows(list) {
  const rows = [REGISTER_COLUMNS]
  for (const n of list) {
    rows.push([n.site, n.name, connectionOf(n), n.status, n.camerasOnline, n.cameras, n.user, n.model, n.serial, n.id])
  }
  return rows
}

/** The register as an .xlsx file (one "NVR register" sheet). */
export function registerXlsx(list) {
  return buildXlsx([{ name: 'NVR register', rows: registerRows(list) }])
}
