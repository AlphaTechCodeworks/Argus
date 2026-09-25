// Preparing a USB/eSATA drive for recordings (admins only), through the root disk helper
// service: cctv-disk-helper.socket (/run/cctv-disk/helper.sock, reachable only with the cctv-disk
// group, which the cctv service has) -> cctv-disk-helper.service (deploy/cctv-disk-helperd.mjs)
// -> /usr/local/sbin/cctv-disk-helper (deploy/cctv-disk-helper). No sudo, nothing root in here.
//
//   listDisks() -> [{ dev, model, serial, sizeBytes, tran, partitions: [{ dev, fstype, label, sizeBytes, mountpoint }], eligible, why }]
//   prepareDisk({ dev, serial, fs }, user) -> the job (runs in the background; one at a time)
//
// A disk may be prepared only when it is a whole disk, not the system disk, nothing on it is
// mounted, it is not in a ZFS pool / LVM / RAID, and the typed serial number matches exactly.
// Checked here, and again by the helper immediately before it erases anything.
import { createConnection } from 'node:net'
import { HttpError } from './nvr-xml.mjs'
import { addLocation, listLocations } from './storage.mjs'

export const SOCKET = '/run/cctv-disk/helper.sock'
const LIST_TIMEOUT_MS = 30_000
const FS = ['xfs', 'ext4']
const DEV = /^\/dev\/(sd[a-z]{1,2}|vd[a-z]{1,2}|nvme[0-9]{1,2}n[0-9]{1,2}|mmcblk[0-9]{1,2})$/
const SERIAL = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/
const MEMBERS = { zfs_member: 'part of a ZFS pool', LVM2_member: 'an LVM member', linux_raid_member: 'part of a RAID' }

let socketPath = SOCKET

/**
 * One request to the helper service ({op:'list'} or {op:'prepare', dev, serial, fs}); onLine gets
 * each line it streams back. Resolves to the helper's exit code (its final {"exit":n} line).
 */
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
        if (m && typeof m.error === 'string') {
          onLine(JSON.stringify({ step: 'helper', state: 'failed', message: m.error }))
          return
        }
      } catch {}
      onLine(l)
    }
    const sock = createConnection(socketPath)
    sock.setEncoding('utf8')
    if (req.op === 'list') sock.setTimeout(LIST_TIMEOUT_MS, () => sock.destroy(Object.assign(new Error('no answer in time'), { code: 'ETIMEDOUT' })))
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

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))
const mounts = (n) => (Array.isArray(n.mountpoints) ? n.mountpoints : [n.mountpoint]).filter((m) => typeof m === 'string' && m !== '')
const flatten = (n) => [n, ...(n.children ?? []).flatMap(flatten)]

/** The helper's list output ({ lsblk, root }) -> the disks the page shows. */
export function parseDisks(out) {
  const devices = out?.lsblk?.blockdevices
  if (!Array.isArray(devices)) throw new Error('unexpected answer from the disk helper')
  const roots = new Set(Array.isArray(out.root) ? out.root : [])
  return devices
    .filter((n) => n.type === 'disk')
    .map((n) => {
      const all = flatten(n)
      const below = all.slice(1)
      const partitions = (n.children ?? []).map((c) => ({
        dev: c.path ?? `/dev/${c.name}`,
        fstype: c.fstype ?? null,
        label: c.label ?? null,
        sizeBytes: num(c.size),
        mountpoint: mounts(c)[0] ?? null
      }))
      const dev = n.path ?? `/dev/${n.name}`
      const serial = typeof n.serial === 'string' ? n.serial.trim() : ''
      const everyMount = all.flatMap(mounts)
      let why = ''
      if (roots.has(dev) || everyMount.includes('/')) why = 'the system disk'
      else if (everyMount.length) why = `in use: mounted at ${everyMount.join(', ')}`
      else {
        const member = all.find((x) => MEMBERS[x.fstype])
        const volume = below.find((x) => x.type === 'lvm' || x.type === 'crypt' || String(x.type).startsWith('raid'))
        if (member) why = `${member === n ? 'the disk' : member.path ?? member.name} is ${MEMBERS[member.fstype]}`
        else if (volume) why = `holds ${volume.type === 'lvm' ? 'an LVM volume' : volume.type === 'crypt' ? 'an encrypted volume' : 'a RAID'}`
        else if (!DEV.test(dev)) why = 'unsupported device type'
        else if (!SERIAL.test(serial)) why = 'no usable serial number to confirm with'
      }
      return { dev, model: n.model?.trim() ?? null, serial, sizeBytes: num(n.size), tran: n.tran ?? null, partitions, eligible: why === '', why }
    })
}

async function helperJson(req) {
  const lines = []
  const code = await runner(req, (l) => lines.push(l))
  const line = lines.find((l) => l.trim().startsWith('{'))
  if (code !== 0 || !line) throw new HttpError(502, `disk helper failed (${code})${lines.length ? `: ${lines.at(-1)}` : ''}`)
  return JSON.parse(line)
}

export async function listDisks() {
  return parseDisks(await helperJson({ op: 'list' }))
}

// state 'prepared': the drive was erased, formatted and mounted, but adding it as a storage
// location failed; nextStep says what to do (add the folder by hand)
let job = null // { dev, serial, fs, by, state: 'running'|'done'|'prepared'|'failed', steps, error, nextStep, location, startedAt, endedAt }
let running = Promise.resolve()

/** The helper's steps in order ('done': the drive is ready and added). */
export const PREPARE_STEPS = ['check', 'wipe', 'partition', 'format', 'mount', 'marker', 'done']

/**
 * Progress of a job for the page's bar: { step (the current one), done (steps finished),
 * of (steps before 'done'), pct, steps }.
 */
export function progressOf(j) {
  const of = PREPARE_STEPS.length - 1
  if (j.state === 'done') return { step: 'done', done: of, of, pct: 100, steps: PREPARE_STEPS }
  let done = 0
  let step = PREPARE_STEPS[0]
  for (const s of j.steps ?? []) {
    const i = PREPARE_STEPS.indexOf(s.step)
    if (i < 0) continue
    if (s.state === 'done') {
      done = Math.max(done, i + 1)
      step = PREPARE_STEPS[Math.min(i + 1, of)]
    } else if (i >= done) step = s.step
  }
  if (j.state === 'prepared') done = of
  return { step, done, of, pct: Math.round((done / of) * 100), steps: PREPARE_STEPS }
}

export const currentJob = () => (job ? { ...structuredClone(job), progress: progressOf(job) } : null)

/**
 * Starts erasing and preparing a disk. The serial must be typed exactly as shown.
 * @throws {HttpError} 400 bad input / serial mismatch, 404 unknown disk, 409 not eligible or busy
 */
export async function prepareDisk(body, user) {
  const dev = String(body?.dev ?? '')
  const serial = typeof body?.serial === 'string' ? body.serial : ''
  const fs = body?.fs ?? 'xfs'
  if (!DEV.test(dev)) throw new HttpError(400, 'dev must be a whole disk such as /dev/sdb')
  if (!FS.includes(fs)) throw new HttpError(400, 'fs must be xfs or ext4')
  if (!serial) throw new HttpError(400, "type the drive's serial number to confirm")
  if (job?.state === 'running') throw new HttpError(409, `${job.dev} is being prepared; wait for it to finish`)
  const disk = (await listDisks()).find((d) => d.dev === dev)
  if (!disk) throw new HttpError(404, `${dev} is not connected (or not a disk)`)
  if (!disk.eligible) throw new HttpError(409, `${dev} cannot be prepared: ${disk.why}`)
  if (serial !== disk.serial) throw new HttpError(400, 'The serial number you typed does not match this drive. Nothing was changed.')
  if (job?.state === 'running') throw new HttpError(409, `${job.dev} is being prepared; wait for it to finish`)

  job = { dev, serial, fs, model: disk.model, by: user ?? '?', state: 'running', steps: [], error: '', nextStep: '', location: null, startedAt: new Date().toISOString(), endedAt: null }
  const mine = job
  console.warn(`[disks] ${user} is ERASING ${dev} (${disk.model ?? '?'}, serial ${serial}, ${disk.sizeBytes} bytes) to format it ${fs}`)
  let done = null
  running = runner({ op: 'prepare', dev, serial, fs }, (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m?.done === true) done = m
    else if (m && typeof m.step === 'string') {
      // (a null or missing state/message is empty, never the text "null"; a line with neither is dropped)
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
      const hasMain = listLocations().some((l) => l.role === 'main')
      try {
        mine.location = addLocation({ path: done.path, type: 'usb', role: hasMain ? 'overflow' : 'main' }, user)
      } catch (e) {
        // the drive itself is ready: say so, and what to do, rather than "failed"
        mine.state = 'prepared'
        mine.nextStep = `The drive was prepared and is mounted at ${done.path}, but it could not be added as a storage location (${e.message}). Add it under Storage locations: folder ${done.path}, type USB drive.`
        console.warn(`[disks] ${dev} prepared at ${done.path} but not added as a location: ${e.message}`)
        return
      }
      mine.state = 'done'
      console.log(`[disks] ${dev} prepared: ${done.path} (${mine.location.id}, ${mine.location.role})`)
    })
    .catch((e) => {
      mine.state = 'failed'
      mine.error = mine.error || e.message
      console.warn(`[disks] preparing ${dev} failed: ${mine.error}`)
    })
    .finally(() => {
      mine.endedAt = new Date().toISOString()
    })
  return currentJob()
}

export const _test = {
  setRunner(fn) {
    runner = fn
  },
  setSocket(p) {
    socketPath = p
  },
  running: () => running
}
