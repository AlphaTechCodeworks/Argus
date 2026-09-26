// Admin routes for the Settings tab (admins only; server.mjs also does the same-origin and JSON
// checks for every non-GET admin request).
//
//   GET  /api/admin/settings   -> { settings, choices, memory }   memory: the RAM each "recent footage
//                              in RAM" choice needs (rec-cache.mjs estimateRecentRam), or null
//   POST /api/admin/settings   { partial settings, see settings.mjs } -> { settings }
//   GET  /api/admin/storage    -> { locations (with health), lowFreePct, floorFreePct, types, roles }
//   POST /api/admin/storage    { action: 'add', path, type, role, limitGB?, sameDisk? } -> { location }
//                              { action: 'set', id, role?, limitGB? } -> { location }
//                              { action: 'remove', id } -> { id }   (files and marker stay)
//   GET  /api/admin/storage/folders?path= -> { path, parent, folders } (read-only), see folders.mjs
//   POST /api/admin/storage/folders { path, name } -> { path }   "New folder" inside path
//   GET  /api/admin/disks      -> { disks, job, error? }   drives that could be prepared, see disks.mjs
//   POST /api/admin/disks/prepare { dev, serial, fs: 'xfs'|'ext4' } -> 202 { job }
//                              ERASES the drive; the typed serial must match exactly
//   GET  /api/admin/netshares  -> { shares (mount state + free space), job, base, protos }
//   POST /api/admin/netshares  { action: 'test'|'add'|'remove', proto, server, share, subdir?,
//                              user, pass, role?, id? } -> 202 { job }   see netshares.mjs
//                              The password is write-only: it goes to the root helper for that one
//                              job and is never stored, logged or answered with.
import { isAdmin } from './auth.mjs'
import { errorAnswer } from './nvr-xml.mjs'
import { KINDS } from './alerts.mjs'
import { AFTER, MAX_RETENTION_DAYS, MODES, RECENT_MINUTES, THUMBNAILS, getSettings, saveSettings } from './settings.mjs'
import { currentJob, listDisks, prepareDisk } from './disks.mjs'
import { BASE as NET_BASE, PROTOS as NET_PROTOS, currentJob as netJob, listShares, runShareJob } from './netshares.mjs'
import { listFolders, makeFolder } from './folders.mjs'
import { ROLES, TYPES, addLocation, listLocations, removeLocation, updateLocation } from './storage.mjs'

const CHOICES = { modes: MODES, after: AFTER, recentMinutes: RECENT_MINUTES, thumbnails: THUMBNAILS, maxRetentionDays: MAX_RETENTION_DAYS, alertKinds: KINDS }

/**
 * The settings as the page may see them: the mail password is write-only, so it leaves here as
 * 'set' or ''. An admin's browser has no reason to hold it, and it would otherwise sit in the
 * page's memory and in anything that logs a response.
 */
function forPage() {
  const s = getSettings() // already a deep clone, so this cannot alter what is stored
  if (s.alerts?.email) s.alerts.email.pass = s.alerts.email.pass ? 'set' : ''
  // a webhook's secret is shown as 'set' too (sending 'set' back keeps it: settings.mjs webhookList)
  if (Array.isArray(s.alerts?.webhooks)) s.alerts.webhooks = s.alerts.webhooks.map((h) => ({ url: h.url, secret: h.secret ? 'set' : '' }))
  return s
}

const ROUTES = {
  '/api/admin/settings': ['GET', 'POST'],
  '/api/admin/storage': ['GET', 'POST'],
  '/api/admin/storage/folders': ['GET', 'POST'],
  '/api/admin/disks': ['GET'],
  '/api/admin/disks/prepare': ['POST'],
  '/api/admin/netshares': ['GET', 'POST']
}

/**
 * @param {string} method
 * @param {string} pathname
 * @param {() => Promise<object>} readJson the request's JSON object body
 * @param {string} user
 * @param {boolean} [admin] whether the user is an admin (server.mjs passes its own answer)
 * @param {{ ramEstimate?: () => object|null }} [opts] ramEstimate: GET's `memory` (a failure gives null)
 * @returns {Promise<[number, any, object?] | null>} null when the path is not one of these routes
 */
export async function handleSettings(method, pathname, readJson, user, admin = isAdmin(user), { ramEstimate, params } = {}) {
  const methods = ROUTES[pathname]
  if (!methods) return null
  if (!admin) return [403, { error: 'Only admins can change settings' }]
  if (!methods.includes(method)) return [405, { error: 'Method not allowed' }, { allow: methods.join(', ') }]
  try {
    if (pathname === '/api/admin/settings') {
      if (method === 'GET') {
        let memory = null
        try {
          memory = ramEstimate?.() ?? null
        } catch (e) {
          console.warn(`[settings] RAM estimate failed: ${e.message}`)
        }
        return [200, { settings: forPage(), choices: CHOICES, memory }]
      }
      const body = await readJson()
      const patch = { ...body }
      saveSettings(patch, user)
      return [200, { settings: forPage() }]
    }
    if (pathname === '/api/admin/storage') {
      if (method === 'GET') {
        const s = getSettings()
        return [200, { locations: listLocations(), lowFreePct: s.storage.lowFreePct, floorFreePct: s.storage.floorFreePct, types: TYPES, roles: ROLES }]
      }
      const body = await readJson()
      if (body.action === 'add') {
        return [200, { location: addLocation({ path: body.path, type: body.type, role: body.role, limitGB: body.limitGB ?? null, sameDisk: body.sameDisk === true }, user) }]
      }
      if (body.action === 'set') {
        const fields = {}
        if ('role' in body) fields.role = body.role
        if ('limitGB' in body) fields.limitGB = body.limitGB
        return [200, { location: updateLocation(String(body.id ?? ''), fields, user) }]
      }
      if (body.action === 'remove') {
        removeLocation(String(body.id ?? ''), user)
        return [200, { id: body.id }]
      }
      return [400, { error: 'action must be add, set or remove' }]
    }
    if (pathname === '/api/admin/storage/folders') {
      if (method === 'GET') return [200, listFolders(params?.get('path') ?? '')]
      const body = await readJson()
      return [200, makeFolder(typeof body.path === 'string' ? body.path : '', body.name)]
    }
    if (pathname === '/api/admin/disks') {
      try {
        return [200, { disks: await listDisks(), job: currentJob() }]
      } catch (e) {
        return [200, { disks: [], job: currentJob(), error: `Cannot list drives: ${e.message}` }]
      }
    }
    if (pathname === '/api/admin/disks/prepare') {
      return [202, { job: await prepareDisk(await readJson(), user) }]
    }
    if (pathname === '/api/admin/netshares') {
      if (method === 'GET') return [200, { shares: listShares(), job: netJob(), base: NET_BASE, protos: NET_PROTOS }]
      // the job runs in the background; the page polls GET for its progress, as it does for disks
      return [202, { job: runShareJob(await readJson(), user) }]
    }
  } catch (e) {
    return errorAnswer(e)
  }
  return null
}
