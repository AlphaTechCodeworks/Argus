// Adding a NAS share (SMB or NFS) as a place for recordings (admins only), through the same root
// disk helper service as disks.mjs: cctv-disk-helper.socket (/run/cctv-disk/helper.sock, reachable
// only with the cctv-disk group) -> cctv-disk-helper.service (deploy/cctv-disk-helperd.mjs) ->
// /usr/local/sbin/cctv-disk-helper. No sudo, nothing root in here.
//
//   listShares() -> [{ id, proto, server, share, subdir, user, mount, path, unit, locationId,
//                      mounted, freeBytes, totalBytes, added, addedBy }]
//   runShareJob({ action: 'test'|'add'|'remove', ... }, user) -> the job (one at a time)
//
// The password is never kept here. It is passed straight through to the helper for one job and
// written by root to /etc/cctv/nas-<id>.cred (0600); nothing in this process stores it, logs it or
// answers with it, and the configured shares in settings have no password field at all.
//
// The WHOLE share is mounted at /srv/cctv-net/<id> and `subdir` names the folder inside it that
// the recordings go in (share "Backups", subdir "CCTV Backup" -> /srv/cctv-net/<id>/CCTV Backup).
// That way renaming or recreating the folder on the NAS never means rewriting a mount unit, and
// the mount point itself has no space in it.
import { createConnection } from 'node:net'
import { statSync, statfsSync } from 'node:fs'
import { HttpError } from './nvr-xml.mjs'
import { getSettings, saveSettings } from './settings.mjs'
import { addLocation, listLocations, removeLocation } from './storage.mjs'

export const SOCKET = '/run/cctv-disk/helper.sock'
export const BASE = '/srv/cctv-net'
export const PROTOS = ['smb', 'nfs']
/** The id the Test button borrows: never an added share, so a test can never disturb a real one. */
export const PROBE_ID = 'probe'

// The same allowlists the helper service and the helper script check again. Nothing typed here is
// ever put into a shell string; it travels as JSON and then as an argument list.
const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
// a share or folder name: a space is allowed ("CCTV Backup"), a leading dot or a trailing space
// is not, which rules out "." and ".." and so any traversal
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+&-]{0,63}$/
const NFS_EXPORT = /^(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){1,8}$/
const SHARE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const NAS_USER = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,31}\\)?[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/
const MAX_PASS = 256

export const isName = (v) => typeof v === 'string' && NAME.test(v) && !v.endsWith(' ')
export const isSubdir = (v) => typeof v === 'string' && (v === '' || (v.length <= 255 && v.split('/').length <= 4 && v.split('/').every(isName)))
// A host name's last part may not be all digits: "999.1.1.1" looks like an address, is not a valid
// one, and must be refused rather than quietly treated as a name the resolver will never find.
const isServer = (v) => typeof v === 'string' && v.length <= 253 && (IPV4.test(v) || (HOSTNAME.test(v) && !/^\d+$/.test(v.split('.').at(-1))))

let socketPath = SOCKET

/** One request to the helper service; onLine gets each line it streams back. -> its exit code. */
let runner = (req, onLine) =>
  new Promise((resolve) => {
    let buf = ''
    let code = null
    let settled = false
    const finish = (c) => {
      if (settled) return
      settled = true
      resolve(c)
    }
    const line = (l) => {
      if (!l.trim()) return
      try {
        const m = JSON.parse(l)
        if (m && typeof m === 'object' && Object.keys(m).length === 1 && Number.isInteger(m.exit)) return void (code = m.exit)
        if (m && typeof m.error === 'string') return void onLine(JSON.stringify({ step: 'helper', state: 'failed', message: m.error }))
      } catch {}
      onLine(l)
    }
    const sock = createConnection(socketPath)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`))
    sock.on('data', (c) => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
    sock.on('error', (e) => {
      if (code === null) onLine(JSON.stringify({ step: 'start', state: 'failed', message: `cannot reach the disk helper (${e.code || e.message}): is cctv-disk-helper.socket running?` }))
      finish(code ?? 127)
    })
    sock.on('close', () => {
      if (buf) line(buf)
      buf = ''
      if (code === null && !settled) onLine(JSON.stringify({ step: 'helper', state: 'failed', message: 'the disk helper hung up without finishing' }))
      finish(code ?? 1)
    })
  })

// replaceable for the offline tests (nothing can really be mounted on a test machine)
let statOf = (p) => statSync(p)
let statfs = (p) => statfsSync(p)

/** Whether something is really mounted at the mount point (its folder is on another filesystem). */
function isMounted(mount) {
  try {
    return statOf(mount).dev !== statOf(BASE).dev
  } catch {
    return false
  }
}

const shares = () => getSettings().storage.netshares ?? []

/** The configured shares with their mount state and free space. Never a password: there is none. */
export function listShares() {
  return shares().map((s) => {
    const mounted = isMounted(s.mount)
    const out = { ...s, mounted, freeBytes: null, totalBytes: null }
    if (mounted) {
      try {
        const f = statfs(s.path)
        out.freeBytes = Number(f.bavail) * Number(f.bsize)
        out.totalBytes = Number(f.blocks) * Number(f.bsize)
      } catch {
        // free space is a nicety; a share that answers statfs with an error is still listed
      }
    }
    return out
  })
}

/** A share id from the share name, unique among the configured ones (the owner never types one). */
export function shareId(share, taken = new Set()) {
  const base =
    share
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'nas'
  let id = SHARE_ID.test(base) ? base : 'nas'
  for (let n = 2; taken.has(id) || id === PROBE_ID; n++) id = `${base.slice(0, 24)}-${n}`
  return id
}

/** Checks what the owner typed, before anything reaches the helper. @throws {HttpError} 400 */
export function cleanShare(body) {
  const proto = body?.proto
  if (!PROTOS.includes(proto)) throw new HttpError(400, 'Protocol must be SMB or NFS.')
  const server = typeof body?.server === 'string' ? body.server.trim() : ''
  if (!isServer(server)) throw new HttpError(400, 'Server must be an IP address such as 192.168.0.121, or a host name.')
  const share = typeof body?.share === 'string' ? body.share.trim() : ''
  if (proto === 'smb') {
    if (!isName(share)) throw new HttpError(400, 'Share name: letters, digits, spaces and . _ - ( ) + &, starting with a letter or digit. No slashes.')
  } else if (!(share.length <= 255 && NFS_EXPORT.test(share))) {
    throw new HttpError(400, 'Export path: something like /export/cctv, each part starting with a letter or digit.')
  }
  const subdir = typeof body?.subdir === 'string' ? body.subdir.trim().replace(/^\/+|\/+$/g, '') : ''
  if (!isSubdir(subdir)) throw new HttpError(400, 'Folder inside the share: at most four parts, each starting with a letter or digit (a space is fine).')
  const user = typeof body?.user === 'string' ? body.user.trim() : ''
  if (user !== '' && !NAS_USER.test(user)) throw new HttpError(400, 'User name: letters, digits, . _ @ - and an optional DOMAIN\\ prefix.')
  const pass = typeof body?.pass === 'string' ? body.pass : ''
  if (pass.length > MAX_PASS) throw new HttpError(400, `The password must be at most ${MAX_PASS} characters.`)
  if (/[\r\n\0]/.test(pass)) throw new HttpError(400, 'The password must not contain line breaks.')
  if (proto === 'smb' && user === '') throw new HttpError(400, 'SMB needs a user name.')
  return { proto, server, share, subdir, user, pass }
}

// ---- the job -------------------------------------------------------------------------------------

/** The helper's steps in order ('done': mounted, proven writable and, for an add, registered). */
export const NET_STEPS = ['check', 'credentials', 'unit', 'mount', 'verify', 'done']

/** Progress for the page's bar, the same shape as disks.mjs progressOf. */
export function progressOf(j) {
  const of = NET_STEPS.length - 1
  if (j.state === 'done') return { step: 'done', done: of, of, pct: 100, steps: NET_STEPS }
  let done = 0
  let step = NET_STEPS[0]
  for (const s of j.steps ?? []) {
    const i = NET_STEPS.indexOf(s.step)
    if (i < 0) continue
    if (s.state === 'done') {
      done = Math.max(done, i + 1)
      step = NET_STEPS[Math.min(i + 1, of)]
    } else if (i >= done) step = s.step
  }
  return { step, done, of, pct: Math.round((done / of) * 100), steps: NET_STEPS }
}

let job = null // { action, id, proto, server, share, subdir, by, state, steps, error, location, ... }
let running = Promise.resolve()

export const currentJob = () => (job ? { ...structuredClone(job), progress: progressOf(job) } : null)

function saveShares(list, user) {
  saveSettings({ storage: { netshares: list } }, user, { internal: true })
}

/**
 * Runs one share job in the background.
 *   { action: 'test', proto, server, share, subdir?, user, pass }   mounts, proves a write, undoes it
 *   { action: 'add',  proto, server, share, subdir?, user, pass, role }   and keeps it
 *   { action: 'remove', id }
 * @throws {HttpError} 400 bad input, 404 unknown share, 409 another job is running
 */
export function runShareJob(body, user) {
  const action = body?.action
  if (!['test', 'add', 'remove'].includes(action)) throw new HttpError(400, 'action must be test, add or remove')
  if (job?.state === 'running') throw new HttpError(409, 'Another network drive job is running; wait for it to finish.')

  if (action === 'remove') {
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!SHARE_ID.test(id)) throw new HttpError(400, 'bad share id')
    const s = shares().find((x) => x.id === id)
    if (!s) throw new HttpError(404, 'No such network drive')
    return start({ action, id, proto: s.proto, server: s.server, share: s.share, subdir: s.subdir, locationId: s.locationId }, { op: 'netunmount', id }, user)
  }

  const f = cleanShare(body)
  const role = action === 'add' ? role_(body?.role) : null
  const id = action === 'test' ? PROBE_ID : shareId(f.share, new Set(shares().map((s) => s.id)))
  if (action === 'add' && shares().some((s) => s.proto === f.proto && s.server === f.server && s.share === f.share && s.subdir === f.subdir)) {
    throw new HttpError(409, 'That share is already added.')
  }
  // `pass` goes into the request and nowhere else: it is not put in the job, not logged and not
  // answered with. The helper writes it to a root-only credentials file and the job forgets it.
  const req = { op: 'netmount', proto: f.proto, server: f.server, share: f.share, subdir: f.subdir, id, user: f.user, pass: f.pass, mode: action === 'add' ? 'add' : 'test' }
  return start({ action, id, proto: f.proto, server: f.server, share: f.share, subdir: f.subdir, user: f.user, role }, req, user)
}

const role_ = (v) => {
  if (!['main', 'overflow', 'archive'].includes(v)) throw new HttpError(400, 'role must be main, overflow or archive')
  return v
}

function start(info, req, user) {
  job = { ...info, by: user ?? '?', state: 'running', steps: [], error: '', nextStep: '', location: null, startedAt: new Date().toISOString(), endedAt: null }
  const mine = job
  console.log(`[netshares] ${user}: ${info.action} ${info.proto} ${info.server}/${info.share}${info.subdir ? `/${info.subdir}` : ''} as ${info.id}`)
  let done = null
  running = runner(req, (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m?.done === true) done = m
    else if (m && typeof m.step === 'string') {
      const text = (v) => (v === null || v === undefined ? '' : String(v))
      const state = text(m.state)
      const message = text(m.message)
      if (!state && !message) return
      mine.steps.push({ step: m.step, state, message, at: new Date().toISOString() })
      if (state === 'failed') mine.error = message || 'failed'
    }
  })
    .then((code) => {
      if (code !== 0 || !done) throw new Error(mine.error || `the disk helper stopped (exit ${code})`)
      if (info.action === 'remove') return void finishRemove(mine, info, user)
      mine.path = done.path
      mine.mount = done.mount
      mine.unit = done.unit
      mine.vers = done.vers ?? ''
      if (info.action === 'test') {
        mine.state = 'done'
        return
      }
      finishAdd(mine, info, done, user)
    })
    .catch((e) => {
      mine.state = 'failed'
      mine.error = mine.error || e.message
      console.warn(`[netshares] ${info.action} ${info.id} failed: ${mine.error}`)
    })
    .finally(() => {
      mine.endedAt = new Date().toISOString()
    })
  return currentJob()
}

/** A mounted share becomes a storage location; if that fails the mount is still there, so say so. */
function finishAdd(mine, info, done, user) {
  const entry = { id: info.id, proto: info.proto, server: info.server, share: info.share, subdir: info.subdir, user: info.user, mount: done.mount, path: done.path, unit: done.unit, locationId: null, added: new Date().toISOString(), addedBy: user ?? '?' }
  let location = null
  try {
    location = addLocation({ path: done.path, type: 'network', role: info.role ?? (listLocations().some((l) => l.role === 'main') ? 'overflow' : 'main') }, user)
    entry.locationId = location.id
  } catch (e) {
    // the share is mounted and will come back after a reboot: keep it, and say what is left to do
    saveShares([...shares(), entry], user)
    mine.state = 'mounted'
    mine.nextStep = `The share is mounted at ${done.path}, but it could not be added as a storage location (${e.message}). Add it under Storage locations: folder ${done.path}, type Network share.`
    console.warn(`[netshares] ${info.id} mounted at ${done.path} but not added as a location: ${e.message}`)
    return
  }
  saveShares([...shares(), entry], user)
  mine.location = location
  mine.state = 'done'
  console.log(`[netshares] ${info.id} mounted at ${done.path} (${location.id}, ${location.role})`)
}

/** Unmounted: drop it from the list and from the storage locations. Files on the NAS are untouched. */
function finishRemove(mine, info, user) {
  if (info.locationId) {
    try {
      removeLocation(info.locationId, user)
    } catch {
      // already gone from the list: nothing to undo
    }
  }
  saveShares(
    shares().filter((s) => s.id !== info.id),
    user
  )
  mine.state = 'done'
  console.log(`[netshares] ${info.id} unmounted and removed from the list (files on the NAS left alone)`)
}

export const _test = {
  setRunner(fn) {
    runner = fn
  },
  setSocket(p) {
    socketPath = p
  },
  setStat(statFn, statfsFn) {
    statOf = statFn
    statfs = statfsFn
  },
  running: () => running,
  reset() {
    job = null
  }
}
