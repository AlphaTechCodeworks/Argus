// Server settings for recording, memory, thumbnails and storage: data/settings.json.
// Validated here (the browser's checks are only a convenience). Recording is off for every
// camera until an admin turns it on.
//
//   { recording: { defaults: { mode, fullDays, after, timelapseS, retentionDays, preS, postS },
//                  cameras: { "<nvr>/<ch>": { ...only the fields that differ, plus locationId } } },
//     memory: { recentMinutes },            // recent footage kept in RAM: warms the file cache, rec-cache.mjs
//     thumbnails: 'off' | '1m' | '5m',
//     storage: { locations: [...], netshares: [...], lowFreePct, floorFreePct } }
//                                           // locations: see storage.mjs; netshares: see netshares.mjs
//                                           // (a netshare never holds a password: only root has it)
//
// The file is written as a temp file + rename (never half-written), mode 0600.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './auth.mjs'
import { audit } from './audit.mjs'
import { KINDS } from './alerts.mjs'
import { HttpError, isPlainObject } from './nvr-xml.mjs'

export const SETTINGS_FILE = join(DATA_DIR, 'settings.json')

export const MODES = ['off', 'continuous', 'motion', 'ai', 'ai-or-motion']
export const AFTER = ['timelapse', 'keep', 'delete']
// which stream the server records: auto (main, and the sub-stream when the NVR will not serve the
// main one -- stream-choice.mjs), or a fixed main / sub for the whole camera or NVR
export const STREAMS = ['auto', 'main', 'sub']
export const RECENT_MINUTES = [0, 1, 2, 5, 10, 15, 20]
export const THUMBNAILS = ['off', '1m', '5m']
export const MAX_RETENTION_DAYS = 366

export const DEFAULTS = Object.freeze({
  recording: {
    defaults: { mode: 'off', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 183, preS: 10, postS: 20, stream: 'auto' },
    cameras: {},
    // per-NVR overrides, e.g. { "nvr-2": { stream: "sub" } } to record a constrained NVR on its
    // sub-streams so it can serve every camera within its bandwidth budget (recorder.mjs #streamPref)
    nvrs: {}
  },
  memory: { recentMinutes: 2 },
  thumbnails: 'off',
  storage: { locations: [], netshares: [], lowFreePct: 15, floorFreePct: 5 },
  alerts: {
    ntfy: { url: 'https://ntfy.sh', topic: '' },
    email: { host: '', port: 587, secure: false, user: '', pass: '', from: '', to: [] },
    // other systems told of alerts and alarms: [{ url, secret }] (alert-send.mjs webhook)
    webhooks: [],
    // yesterday's report at 07:00 site time, through the same channels (reports.mjs)
    dailySummary: true,
    muted: [],
    notRecordingMinutes: 5,
    clockSkewSeconds: 30
  },
  // Gap backfill from the NVRs (phase 2b, backfill.mjs). It only ever runs inside the off-peak
  // window because it reads the same NVRs and the same drives the live recording uses, and live
  // recording always wins. nvrRetentionDays is what each NVR itself keeps (about 30 days here):
  // a hole older than that can never be filled, and there is no point asking.
  backfill: {
    enabled: false,
    windowStart: '01:00',
    windowEnd: '05:00',
    nvrRetentionDays: 30,
    minGapSeconds: 10,
    maxGapMinutes: 60,
    perNvrMbps: 8,
    restSeconds: 30
  }
})

const CAMERA_KEY = /^[A-Za-z0-9._-]{1,64}\/\d{1,3}$/
const LOCATION_ID = /^[A-Za-z0-9._-]{1,64}$/

const int = (name, lo, hi) => (v) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, `${name} must be a whole number from ${lo} to ${hi}`)
  return v
}
const str = (name, max) => (v) => {
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${name} must be text of at most ${max} characters`)
  return v
}
// A guessable topic lets anyone push to the owner's phone, so it must be long and unguessable.
const topic = (v) => {
  const s = str('alerts.ntfy.topic', 64)(v)
  if (s && !/^[A-Za-z0-9_-]{8,64}$/.test(s)) throw new HttpError(400, 'alerts.ntfy.topic must be 8 to 64 letters, digits, - or _')
  return s
}
const oneOf = (name, list) => (v) => {
  if (!list.includes(v)) throw new HttpError(400, `${name} must be one of: ${list.join(', ')}`)
  return v
}
const REC_FIELDS = {
  mode: oneOf('mode', MODES),
  fullDays: int('Full video days', 1, MAX_RETENTION_DAYS),
  after: oneOf('after', AFTER),
  timelapseS: int('Time-lapse interval (s)', 1, 3600),
  retentionDays: int('Total retention days', 1, MAX_RETENTION_DAYS),
  preS: int('Pre-event seconds', 0, 300),
  postS: int('Post-event seconds', 0, 600),
  stream: oneOf('stream', STREAMS)
}
const CAMERA_FIELDS = {
  ...REC_FIELDS,
  locationId: (v) => {
    if (v !== null && !(typeof v === 'string' && LOCATION_ID.test(v))) throw new HttpError(400, 'locationId must be a location id or null')
    return v
  }
}

/** A time of day as "HH:MM" (24 h, the server's local clock): the off-peak window's ends. */
const hhmm = (name) => (v) => {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(v)) throw new HttpError(400, `${name} must be a time of day as HH:MM`)
  return v
}
const BACKFILL_FIELDS = {
  enabled: (v) => Boolean(v),
  windowStart: hhmm('backfill.windowStart'),
  windowEnd: hhmm('backfill.windowEnd'),
  nvrRetentionDays: int('backfill.nvrRetentionDays', 1, MAX_RETENTION_DAYS),
  minGapSeconds: int('backfill.minGapSeconds', 1, 3600),
  maxGapMinutes: int('backfill.maxGapMinutes', 1, 1440),
  perNvrMbps: int('backfill.perNvrMbps', 1, 200),
  restSeconds: int('backfill.restSeconds', 0, 3600)
}

const knownKeys = (obj, keys, where) => {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw new HttpError(400, `unknown setting ${where}${k}`)
}
const needObject = (v, where) => {
  if (!isPlainObject(v)) throw new HttpError(400, `${where} must be an object`)
  return v
}

/** Checks the whole settings object (throws HttpError 400). */
function validate(s) {
  const d = s.recording.defaults
  for (const [k, f] of Object.entries(REC_FIELDS)) f(d[k])
  const days = (r, who) => {
    if (r.fullDays > r.retentionDays) throw new HttpError(400, `${who}: full video days (${r.fullDays}) cannot be more than the total retention (${r.retentionDays})`)
  }
  days(d, 'Defaults')
  for (const [key, o] of Object.entries(s.recording.cameras)) {
    if (!CAMERA_KEY.test(key)) throw new HttpError(400, `bad camera key ${key} (expected <nvr>/<ch>)`)
    needObject(o, `camera ${key}`)
    knownKeys(o, Object.keys(CAMERA_FIELDS), `${key}.`)
    for (const [k, v] of Object.entries(o)) CAMERA_FIELDS[k](v)
    days({ ...d, ...o }, `Camera ${key}`)
  }
  for (const [id, o] of Object.entries(s.recording.nvrs ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, `bad NVR id ${id}`)
    needObject(o, `nvr ${id}`)
    knownKeys(o, ['stream'], `nvrs.${id}.`)
    if ('stream' in o) oneOf('stream', STREAMS)(o.stream)
  }
  oneOf('memory.recentMinutes', RECENT_MINUTES)(s.memory.recentMinutes)
  oneOf('thumbnails', THUMBNAILS)(s.thumbnails)
  int('Low-space threshold (% free)', 1, 50)(s.storage.lowFreePct)
  int('Hard floor (% free)', 1, 50)(s.storage.floorFreePct)
  if (s.storage.floorFreePct >= s.storage.lowFreePct) throw new HttpError(400, 'the hard floor must be below the low-space threshold')
  if (!Array.isArray(s.storage.locations)) throw new HttpError(400, 'storage.locations must be a list')
  if (!Array.isArray(s.storage.netshares)) throw new HttpError(400, 'storage.netshares must be a list')
  if (isPlainObject(s.backfill)) for (const [k, f] of Object.entries(BACKFILL_FIELDS)) f(s.backfill[k])
  // An empty window (both ends the same) would mean "never", which is what `enabled: false` is
  // for; saying it plainly avoids a job that silently never runs.
  if (isPlainObject(s.backfill) && s.backfill.windowStart === s.backfill.windowEnd) throw new HttpError(400, 'the backfill window must not start and end at the same time')
}

/** Settings from the file, each part falling back to the default when missing or invalid. */
function fromFile(j) {
  const s = structuredClone(DEFAULTS)
  if (!isPlainObject(j)) return s
  const r = isPlainObject(j.recording) ? j.recording : {}
  if (isPlainObject(r.defaults)) {
    for (const [k, f] of Object.entries(REC_FIELDS)) {
      try {
        if (k in r.defaults) s.recording.defaults[k] = f(r.defaults[k])
      } catch {}
    }
    if (s.recording.defaults.fullDays > s.recording.defaults.retentionDays) s.recording.defaults = structuredClone(DEFAULTS.recording.defaults)
  }
  if (isPlainObject(r.cameras)) {
    for (const [key, o] of Object.entries(r.cameras)) {
      try {
        const one = { recording: { defaults: s.recording.defaults, cameras: { [key]: o } }, memory: s.memory, thumbnails: s.thumbnails, storage: s.storage }
        validate(one)
        s.recording.cameras[key] = o
      } catch (e) {
        console.warn(`[settings] camera ${key} ignored: ${e.message}`)
      }
    }
  }
  if (isPlainObject(r.nvrs)) {
    for (const [id, o] of Object.entries(r.nvrs)) {
      if (isPlainObject(o) && (!('stream' in o) || STREAMS.includes(o.stream))) s.recording.nvrs[id] = 'stream' in o ? { stream: o.stream } : {}
      else console.warn(`[settings] nvr ${id} recording override ignored`)
    }
  }
  const tryPart = (fn) => {
    try {
      fn()
    } catch {}
  }
  tryPart(() => (s.memory.recentMinutes = oneOf('', RECENT_MINUTES)(j.memory.recentMinutes)))
  tryPart(() => (s.thumbnails = oneOf('', THUMBNAILS)(j.thumbnails)))
  if (isPlainObject(j.storage)) {
    const low = j.storage.lowFreePct
    const floor = j.storage.floorFreePct
    if (Number.isInteger(low) && Number.isInteger(floor) && floor >= 1 && floor < low && low <= 50) Object.assign(s.storage, { lowFreePct: low, floorFreePct: floor })
    if (Array.isArray(j.storage.locations)) s.storage.locations = j.storage.locations.filter(isPlainObject)
    if (Array.isArray(j.storage.netshares)) s.storage.netshares = j.storage.netshares.filter(isPlainObject)
  }
  // Alerts are read back field by field through the same validators, so one bad value in the file
  // costs only that field rather than the whole section.
  if (isPlainObject(j.alerts)) {
    const a = j.alerts
    if (isPlainObject(a.ntfy)) {
      tryPart(() => (s.alerts.ntfy.url = str('', 200)(a.ntfy.url)))
      tryPart(() => (s.alerts.ntfy.topic = topic(a.ntfy.topic)))
    }
    if (Array.isArray(a.webhooks)) tryPart(() => (s.alerts.webhooks = webhookList(a.webhooks, [])))
    if (typeof a.dailySummary === 'boolean') s.alerts.dailySummary = a.dailySummary
    if (isPlainObject(a.email)) {
      for (const k of ['host', 'user', 'pass', 'from']) tryPart(() => (s.alerts.email[k] = str('', 200)(a.email[k])))
      tryPart(() => (s.alerts.email.port = int('', 1, 65535)(a.email.port)))
      s.alerts.email.secure = Boolean(a.email.secure)
      if (Array.isArray(a.email.to)) s.alerts.email.to = a.email.to.filter((t) => typeof t === 'string' && t)
    }
    if (Array.isArray(a.muted)) s.alerts.muted = a.muted.filter((k) => KINDS.includes(k))
    tryPart(() => (s.alerts.notRecordingMinutes = int('', 1, 120)(a.notRecordingMinutes)))
    tryPart(() => (s.alerts.clockSkewSeconds = int('', 5, 3600)(a.clockSkewSeconds)))
  }
  if (isPlainObject(j.backfill)) {
    for (const [k, f] of Object.entries(BACKFILL_FIELDS)) tryPart(() => (s.backfill[k] = f(j.backfill[k])))
    if (s.backfill.windowStart === s.backfill.windowEnd) s.backfill = structuredClone(DEFAULTS.backfill)
  }
  return s
}

let cache = null // { key, settings }
function load() {
  let key = 'none'
  try {
    const st = statSync(SETTINGS_FILE)
    key = `${st.ino}:${st.size}:${st.mtimeMs}`
  } catch {}
  if (cache?.key === key) return cache.settings
  let settings = structuredClone(DEFAULTS)
  if (key !== 'none') {
    try {
      settings = fromFile(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')))
    } catch (e) {
      console.warn(`[settings] ${SETTINGS_FILE} unreadable (${e.message}); using the defaults`)
    }
  }
  cache = { key, settings }
  return settings
}

function write(settings) {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true })
  const tmp = `${SETTINGS_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(settings, null, 1)}\n`, { mode: 0o600 })
  renameSync(tmp, SETTINGS_FILE)
  cache = null
}

const listeners = new Set()
/** cb(settings) after every save (e.g. to tell the recorders). Returns an unsubscribe function. */
/**
 * Webhooks (alerts.webhooks): at most 5 of { url, secret }. The URL must be http(s); the secret is
 * optional (it signs each POST, alert-send.mjs). 'set' as a secret means "keep the stored one".
 */
function webhookList(list, before) {
  if (!Array.isArray(list) || list.length > 5) throw new HttpError(400, 'alerts.webhooks must be a list of at most 5')
  return list.map((h, i) => {
    if (!isPlainObject(h)) throw new HttpError(400, `alerts.webhooks[${i}] must be { url, secret }`)
    const url = str(`alerts.webhooks[${i}].url`, 500)(h.url)
    let u
    try {
      u = new URL(url)
    } catch {
      throw new HttpError(400, `alerts.webhooks[${i}].url is not an address`)
    }
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, `alerts.webhooks[${i}].url must start with https:// or http://`)
    const kept = before.find((b) => b?.url === url)?.secret ?? ''
    const secret = h.secret === 'set' ? kept : str(`alerts.webhooks[${i}].secret`, 128)(h.secret ?? '')
    return { url, secret }
  })
}

export function onSettingsChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** A copy of the current settings. */
export const getSettings = () => structuredClone(load())

/**
 * Applies a partial change and saves it. Objects merge; in recording.cameras a camera set to
 * null loses all its overrides and a field set to null goes back to the default.
 * storage.locations is changed only through storage.mjs (internal: true).
 * @throws {HttpError} 400 when anything is invalid (nothing is saved then)
 */
export function saveSettings(patch, user, { internal = false } = {}) {
  needObject(patch, 'settings')
  knownKeys(patch, Object.keys(DEFAULTS), '')
  const next = getSettings()
  if ('recording' in patch) {
    const r = needObject(patch.recording, 'recording')
    knownKeys(r, ['defaults', 'cameras', 'nvrs'], 'recording.')
    if ('defaults' in r) {
      const d = needObject(r.defaults, 'recording.defaults')
      knownKeys(d, Object.keys(REC_FIELDS), 'recording.defaults.')
      Object.assign(next.recording.defaults, d)
    }
    if ('cameras' in r) {
      for (const [key, o] of Object.entries(needObject(r.cameras, 'recording.cameras'))) {
        if (o === null) {
          delete next.recording.cameras[key]
          continue
        }
        needObject(o, `camera ${key}`)
        const merged = { ...(next.recording.cameras[key] ?? {}) }
        for (const [k, v] of Object.entries(o)) {
          if (v === null && k !== 'locationId') delete merged[k]
          else merged[k] = v
        }
        if (merged.locationId === null) delete merged.locationId
        if (Object.keys(merged).length) next.recording.cameras[key] = merged
        else delete next.recording.cameras[key]
      }
    }
    // per-NVR overrides (only `stream` for now): null removes an NVR's entry, or one field of it
    if ('nvrs' in r) {
      next.recording.nvrs ??= {}
      for (const [id, o] of Object.entries(needObject(r.nvrs, 'recording.nvrs'))) {
        if (o === null) {
          delete next.recording.nvrs[id]
          continue
        }
        needObject(o, `nvr ${id}`)
        const merged = { ...(next.recording.nvrs[id] ?? {}) }
        for (const [k, v] of Object.entries(o)) {
          if (v === null) delete merged[k]
          else merged[k] = v
        }
        if (Object.keys(merged).length) next.recording.nvrs[id] = merged
        else delete next.recording.nvrs[id]
      }
    }
  }
  if ('memory' in patch) {
    const m = needObject(patch.memory, 'memory')
    knownKeys(m, ['recentMinutes'], 'memory.')
    Object.assign(next.memory, m)
  }
  if ('thumbnails' in patch) next.thumbnails = patch.thumbnails
  if ('storage' in patch) {
    const st = needObject(patch.storage, 'storage')
    knownKeys(st, internal ? ['locations', 'netshares', 'lowFreePct', 'floorFreePct'] : ['lowFreePct', 'floorFreePct'], 'storage.')
    Object.assign(next.storage, st)
  }
  if ('alerts' in patch) {
    const al = needObject(patch.alerts, 'alerts')
    knownKeys(al, ['ntfy', 'email', 'webhooks', 'dailySummary', 'muted', 'notRecordingMinutes', 'clockSkewSeconds'], 'alerts.')
    if ('dailySummary' in al) next.alerts.dailySummary = Boolean(al.dailySummary)
    // a secret given back as 'set' (how the API shows one) keeps the one already stored for that URL
    if ('webhooks' in al) next.alerts.webhooks = webhookList(al.webhooks, next.alerts.webhooks ?? [])
    if ('ntfy' in al) {
      const n = needObject(al.ntfy, 'alerts.ntfy')
      knownKeys(n, ['url', 'topic'], 'alerts.ntfy.')
      if ('url' in n) next.alerts.ntfy.url = str('alerts.ntfy.url', 200)(n.url)
      if ('topic' in n) next.alerts.ntfy.topic = topic(n.topic)
    }
    if ('email' in al) {
      const e = needObject(al.email, 'alerts.email')
      knownKeys(e, ['host', 'port', 'secure', 'user', 'pass', 'from', 'to'], 'alerts.email.')
      if ('host' in e) next.alerts.email.host = str('alerts.email.host', 200)(e.host)
      if ('port' in e) next.alerts.email.port = int('alerts.email.port', 1, 65535)(e.port)
      if ('secure' in e) next.alerts.email.secure = Boolean(e.secure)
      if ('user' in e) next.alerts.email.user = str('alerts.email.user', 200)(e.user)
      // The API returns the password as the placeholder 'set', so that value means "leave it".
      if ('pass' in e && e.pass !== 'set') next.alerts.email.pass = str('alerts.email.pass', 200)(e.pass)
      if ('from' in e) next.alerts.email.from = str('alerts.email.from', 200)(e.from)
      if ('to' in e) {
        if (!Array.isArray(e.to) || e.to.length > 10) throw new HttpError(400, 'alerts.email.to must be a list of at most 10 addresses')
        next.alerts.email.to = e.to.map(str('alerts.email.to', 200)).filter(Boolean)
      }
    }
    if ('muted' in al) {
      if (!Array.isArray(al.muted)) throw new HttpError(400, 'alerts.muted must be a list')
      next.alerts.muted = al.muted.filter((k) => KINDS.includes(k))
    }
    if ('notRecordingMinutes' in al) next.alerts.notRecordingMinutes = int('alerts.notRecordingMinutes', 1, 120)(al.notRecordingMinutes)
    if ('clockSkewSeconds' in al) next.alerts.clockSkewSeconds = int('alerts.clockSkewSeconds', 5, 3600)(al.clockSkewSeconds)
  }
  if ('backfill' in patch) {
    const b = needObject(patch.backfill, 'backfill')
    knownKeys(b, Object.keys(BACKFILL_FIELDS), 'backfill.')
    for (const [k, v] of Object.entries(b)) next.backfill[k] = BACKFILL_FIELDS[k](v)
  }
  validate(next)
  write(next)
  console.log(`[settings] saved by ${user ?? '?'}: ${Object.keys(patch).join(', ')}`)
  // Only the top-level keys that changed, never the values: alerts.email.pass would otherwise be
  // written to a file kept for a year. Which settings were touched, by whom and when is the
  // question an audit is for; the new value is already in settings.json.
  // audit() never throws, so a broken audit file cannot stop settings being saved.
  if (!internal) audit(DATA_DIR, { user, action: 'settings-change', target: Object.keys(patch).join(' '), detail: `changed ${Object.keys(patch).join(', ')}` })
  for (const cb of listeners) {
    try {
      cb(getSettings())
    } catch (e) {
      console.warn(`[settings] listener failed: ${e.message}`)
    }
  }
  return getSettings()
}

/** The effective recording settings of one camera (defaults + its overrides). */
export function cameraRecording(nvrId, ch) {
  const s = load()
  const d = s.recording.defaults
  const o = s.recording.cameras[`${nvrId}/${ch}`] ?? {}
  const r = { ...d, ...o }
  return { mode: r.mode, fullDays: r.fullDays, after: r.after, timelapseS: r.timelapseS, retentionDays: r.retentionDays, locationId: o.locationId ?? null }
}
