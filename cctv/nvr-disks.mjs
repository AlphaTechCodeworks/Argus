// What each NVR says about its own disks, how long it has been recording to them, and what it is.
//
// Why this exists: the server keeps the long-term recordings, but every NVR also holds its own
// copy of roughly the last 30 days on its internal disk. That copy is the only redundancy this
// system has, and until now nothing looked at it. An NVR whose disk has failed goes on looking
// perfectly healthy on the Health page while the safety net is quietly gone.
//
// Route: the NVR web client's XML commands over the existing logged-in SDK connection
// (nvr-xml.mjs transparent()), not new koffi bindings. The SDK library's own symbols show that
// its NET_SDK_FindDisk / NET_SDK_GetNvrRecordDays / NET_SDK_GetDeviceSupportFunction calls are
// themselves implemented by sending these same XML commands and reading these same fields:
//
//   queryDiskStatus       -> response/content/diskList, fields freeSpace / totalSpace /
//                            diskStatus ("read/write", "unformat", "formatting", "exception")
//   queryStorageDevInfo   -> per disk slotIndex / recStartDate / recEndDate  (= GetNvrRecordDays)
//   querySystemCaps       -> softwareVersion / hardwareVersion / kenerlVersion / launchDate,
//                            ipChlMaxCount / analogChlCount  (firmware, and the camera limit)
//
// Declaring the C structs instead would mean getting _net_sdk_disk_info's layout exactly right
// against a library that has already crashed this process once; a wrong layout corrupts memory.
// The XML route uses a call this codebase already makes hundreds of times a day.
//
// Everything here degrades rather than fails. An NVR that does not answer a command, answers
// something unrecognised, or is offline, reports `available: false` with a reason, and the Health
// page prints "not available". It never reports a healthy-looking zero for something it did not
// actually manage to read: a page that quietly invents good news is worse than one that admits
// the gap.
//
// Timing: these facts change over days, not seconds, so each NVR is asked at most every 10
// minutes, in the background, and never on the health poll's own thread of control. health() is
// synchronous and only ever reads the last snapshot.

import { XML_HEADER, esc, kid, kids, parseXml } from './xml.mjs'
import { xmlOnline } from './xml-session.mjs'

/** How long a good answer is kept before the NVR is asked again. */
export const FRESH_MS = 10 * 60_000
/** How long a failure is kept before trying again: shorter, so a passing fault heals by itself. */
export const RETRY_MS = 2 * 60_000
/** Nothing here is worth holding a lane for: give up well inside the SDK's own 20 s budget. */
export const QUERY_MS = 8000
/** How long the last good disk/SMART snapshot keeps being shown (marked stale) while fresh reads fail
 *  over P2P. SMART changes slowly, so an hour-old reading with its age beats a blank panel. */
export const STALE_OK_MS = 60 * 60_000

const OUT_BYTES = 64 * 1024 // a disk list is a few hundred bytes per disk; system caps ~2 kB

/** A plain query: this dialect wants the whole <request> document even when there is nothing to say. */
const emptyRequest = () => `${XML_HEADER}</request>`

/**
 * The real send: one command over the NVR's logged-in SDK connection.
 * nvr-xml.mjs is imported only when a query is really made, because it loads the native SDK,
 * which is a Linux .so — the offline tests import this module on a Windows PC.
 */
export const sdkQuery = async (nvr, url, xml, tag) => {
  const { transparent } = await import('./nvr-xml.mjs')
  return transparent(nvr, url, xml, tag, { outBytes: OUT_BYTES })
}

// ---- reading the answers ---------------------------------------------------------------------
//
// Deliberately forgiving. Firmware across these NVRs is not uniform and we cannot try every one
// of them, so each field is looked for under any of the names the SDK and the web client are
// known to use, as a child element or as an attribute. A field that is not there stays null
// rather than becoming 0.

const text = (n) => (n?.text ?? '').trim()
/** The first of `names` present on `node`, as a child element or an attribute; null if none is. */
const field = (node, names) => {
  for (const name of names) {
    const c = kid(node, name)
    if (c && text(c) !== '') return text(c)
    const a = node?.attrs?.[name]
    if (a !== undefined && String(a).trim() !== '') return String(a).trim()
  }
  return null
}
const num = (v) => {
  if (v === null || v === undefined) return null
  // Number('') is 0, and a 0 nobody measured is exactly the reassuring lie this page must not tell.
  const digits = String(v).replace(/[^\d.-]/g, '')
  if (digits === '' || digits === '-' || digits === '.') return null
  const n = Number(digits)
  return Number.isFinite(n) ? n : null
}

/**
 * A size the NVR states, in bytes. These answers carry megabytes unless they say otherwise
 * (the SDK prints them with "%.2f"), and some firmware adds a unit attribute. This assumption is
 * the main thing a run against a real NVR has to confirm — see the discovery notes below.
 */
export function sizeBytes(value, unit) {
  const n = num(value)
  if (n === null) return null
  const u = String(unit ?? 'MB').trim().toUpperCase()
  const scale = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[u]
  return scale === undefined ? null : Math.round(n * scale)
}

// How the NVR's own word for a disk's condition maps onto something the page can colour. A word
// we have never seen stays 'unknown', which is not an alert: only states we positively recognise
// as broken raise one, or a firmware with new vocabulary would page the owner every night.
const OK_WORDS = /^(read\s*\/?\s*write|readwrite|rw|normal|ok|good|online|in\s*use|using|used)$/i
const WARN_WORDS = /read\s*only|^ro$|idle|standby|sleep|hibernat|redundan|backup/i
const BUSY_WORDS = /format|rebuild|sync/i
const BAD_WORDS = /except|error|abnormal|fail|damage|\bbad\b|unformat|no\s*disk|offline|missing|pull|lost|smart|degrade/i

/**
 * Worst first. Used both to pick the worst disk in an NVR and to let a drive's own SMART verdict
 * lower a disk's state -- never raise it. "read/write" only means the NVR is still using the disk;
 * a drive can be perfectly writable and quietly failing, which is the case this exists to catch.
 */
const RANK = Object.freeze({ bad: 0, unknown: 1, busy: 2, warn: 3, ok: 4 })

/** 'ok' | 'warn' | 'busy' | 'bad' | 'unknown' for an NVR's word for a disk's condition. */
export function diskState(status) {
  const s = String(status ?? '').trim()
  if (!s) return 'unknown'
  if (BAD_WORDS.test(s)) return 'bad'
  if (BUSY_WORDS.test(s)) return 'busy'
  if (OK_WORDS.test(s)) return 'ok'
  if (WARN_WORDS.test(s)) return 'warn'
  return 'unknown'
}

/** Every <item> under any element called `name`, at any depth (firmware nests these differently). */
function itemsUnder(root, names) {
  const out = []
  const walk = (node) => {
    for (const c of node.children) {
      if (names.includes(c.name)) out.push(...kids(c, 'item'))
      walk(c)
    }
  }
  walk(root)
  return out
}

/** The <response> of an answer, with its status, or null when the text is not an answer at all. */
function answerOf(xml) {
  const response = kid(parseXml(xml), 'response')
  if (!response) throw new Error('no <response>')
  return {
    response,
    status: text(kid(response, 'status')),
    errorCode: text(kid(response, 'errorCode'))
  }
}

/**
 * The unit these NVRs declare once for the whole list rather than on each disk:
 *   <diskList type="list"><itemType><size unit="MB"/></itemType><item>...
 * Without this a 12 TB disk reads as 11 TB or 11 GB depending on which default is assumed, so the
 * declared unit is preferred over any guess. Returns null when the answer does not declare one.
 */
function declaredUnit(root, names) {
  let found = null
  const walk = (node) => {
    for (const c of node.children) {
      if (c.name === 'itemType') {
        for (const n of names) {
          const u = kid(c, n)?.attrs?.unit
          if (u && !found) found = String(u).trim()
        }
      }
      walk(c)
    }
  }
  walk(root)
  return found
}

/**
 * One disk as the NVR describes it. Both queryDiskStatus and queryStorageDevInfo carry these
 * fields, and which of them a given firmware fills in is not something we can predict: on these
 * NVMS-9000 boxes queryDiskStatus answers with nothing usable and queryStorageDevInfo carries the
 * lot, so the same reader is used for both and the two answers are merged afterwards.
 */
function diskFields(item, i, listTotalUnit, listFreeUnit) {
  const raw = field(item, ['diskStatus', 'status', 'state'])
  const totalUnit = kid(item, 'totalSpace')?.attrs?.unit ?? kid(item, 'size')?.attrs?.unit ?? item.attrs?.unit ?? listTotalUnit
  const freeUnit = kid(item, 'freeSpace')?.attrs?.unit ?? kid(item, 'remainSize')?.attrs?.unit ?? listFreeUnit ?? totalUnit
  const slot = num(field(item, ['slotIndex', 'slot', 'index', 'diskNum']))
  return {
    // The web client numbers disks "disk1", "disk2"; the id attribute is a GUID nobody reads out.
    name: field(item, ['name', 'diskName']) ?? `Disk ${slot ?? i + 1}`,
    slot,
    id: item.attrs?.id ?? null,
    model: field(item, ['model', 'diskModel']),
    serial: field(item, ['serialNum', 'serialNumber', 'sn']),
    status: raw,
    state: diskState(raw),
    totalBytes: sizeBytes(field(item, ['totalSpace', 'size', 'capacity']), totalUnit),
    freeBytes: sizeBytes(field(item, ['freeSpace', 'remainSize', 'freeSize']), freeUnit)
  }
}

/**
 * queryDiskStatus: the NVR's disks.
 * @returns {{ ok: boolean, errorCode: string, disks: object[] }}
 */
export function parseDiskStatus(xml) {
  const { response, status, errorCode } = answerOf(xml)
  if (status && status !== 'success') return { ok: false, errorCode: errorCode || status, disks: [] }
  // 'content' matters: these NVRs answer queryDiskStatus with <content type="list"> holding the
  // items directly, with no <diskList> around them at all. Looking only for the named lists found
  // nothing, and a disk whose condition the NVR had plainly stated came out as "unknown".
  // kids() takes direct children only, so naming 'content' here cannot pick up the items nested
  // deeper inside it (the raid type lists in queryStorageDevInfo's answer).
  const items = itemsUnder(response, ['diskList', 'disks', 'diskInfo', 'content'])
  const tu = declaredUnit(response, ['totalSpace', 'size', 'capacity'])
  const fu = declaredUnit(response, ['freeSpace', 'remainSize', 'freeSize'])
  return { ok: true, errorCode: '', disks: items.map((item, i) => diskFields(item, i, tu, fu)) }
}

const DAY_MS = 86_400_000
/** "2026-08-26", "2026/8/26" or "20260826" as a UTC midnight, or null. Dates only: no clock skew. */
export function parseDate(s) {
  const t = String(s ?? '').trim()
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t)
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(t)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const ms = Date.UTC(y, mo - 1, d)
  return Number.isFinite(ms) ? ms : null
}

/**
 * queryStorageDevInfo: the oldest and newest recording on each disk, which is what
 * NET_SDK_GetNvrRecordDays is built from. Days are inclusive of both ends, as the NVR's own
 * page counts them: a disk holding today only is 1 day, not 0.
 * @returns {{ ok: boolean, errorCode: string, slots: object[] }}
 */
export function parseStorageDevInfo(xml) {
  const { response, status, errorCode } = answerOf(xml)
  if (status && status !== 'success') return { ok: false, errorCode: errorCode || status, slots: [] }
  const items = itemsUnder(response, ['diskList', 'disks', 'storageDevList', 'content'])
  const tu = declaredUnit(response, ['totalSpace', 'size', 'capacity'])
  const fu = declaredUnit(response, ['freeSpace', 'remainSize', 'freeSize'])
  const slots = []
  items.forEach((item, i) => {
    const from = parseDate(field(item, ['recStartDate', 'startDate', 'recStartTime']))
    const to = parseDate(field(item, ['recEndDate', 'endDate', 'recEndTime']))
    // An item with no dates at all is not a recording disk (an unformatted or spare slot), and
    // counting it as "0 days" would drag the NVR's figure down to zero. It is simply left out.
    if (from === null && to === null) return
    slots.push({
      // On these NVRs this is the answer that actually carries the model, serial and size; the
      // dates used to be all that was read out of it, which is why the Health page showed nulls.
      ...diskFields(item, i, tu, fu),
      from,
      to,
      days: from !== null && to !== null && to >= from ? Math.round((to - from) / DAY_MS) + 1 : null
    })
  })
  return { ok: true, errorCode: '', slots }
}

/** querySystemCaps: firmware and the channel limits. Every field may be null. */
export function parseSystemCaps(xml) {
  const { response, status, errorCode } = answerOf(xml)
  if (status && status !== 'success') return { ok: false, errorCode: errorCode || status, caps: {} }
  const c = kid(response, 'content') ?? response
  return {
    ok: true,
    errorCode: '',
    caps: {
      firmware: field(c, ['softwareVersion', 'firmwareVersion', 'version']),
      hardware: field(c, ['hardwareVersion']),
      kernel: field(c, ['kenerlVersion', 'kernelVersion']), // the NVR really does spell it "kenerl"
      launchDate: field(c, ['launchDate']),
      maxCameras: num(field(c, ['ipChlMaxCount'])),
      analogCameras: num(field(c, ['analogChlCount'])),
      maxPlaybackWindows: num(field(c, ['playbackMaxWin'])),
      // Why an NVR refuses a stream that should be fine. Each of these boxes has a fixed budget it
      // shares between recording and live viewing, and once it is spent the next stream is simply
      // turned away -- which looks exactly like a broken camera unless the figure is on the page.
      // nvr-2 sits at 128 of its 192 Mb; nvr1 at 102. That is the whole difference between them.
      totalBandwidthMbps: num(field(c, ['totalBandwidth'])), // the NVR states this one in Mbit/s
      usedBandwidthKbps: num(field(c, ['usedTotalBandwidth'])) // and this one in kbit/s
    }
  }
}

/** Used and total in Mbit/s with the percentage, or null when the NVR did not give both. */
export function bandwidthOf(caps) {
  const total = caps?.totalBandwidthMbps
  const usedKb = caps?.usedBandwidthKbps
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(usedKb)) return null
  // kbit/s -> Mbit/s is decimal (1 Mbit/s = 1000 kbit/s), as totalBandwidthMbps is; 1024 under-read it ~2.3%
  const used = Math.round((usedKb / 1000) * 10) / 10
  return { usedMbps: used, totalMbps: total, pct: Math.round((used / total) * 100) }
}

// ---- what one NVR reports ----------------------------------------------------------------------

/** The three read-only commands, in the order they are asked and tried by the discovery route. */
export const COMMANDS = Object.freeze([
  { key: 'disks', url: 'queryDiskStatus', parse: parseDiskStatus },
  { key: 'record', url: 'queryStorageDevInfo', parse: parseStorageDevInfo },
  { key: 'caps', url: 'querySystemCaps', parse: parseSystemCaps }
])

/**
 * Read-only commands the discovery route tries, so the real NVRs can be asked once which of them
 * they actually answer before any of this is trusted. The first three are what the running code
 * uses; the rest are names the SDK library or the web client also mention, kept here because we
 * have never seen a real answer from these particular boxes. Nothing in this list writes.
 */
export const DISCOVERY = Object.freeze([
  'queryDiskStatus', 'queryStorageDevInfo', 'querySystemCaps',
  'queryExternalDisks', 'queryDiskInfo', 'queryDiskList', 'queryHddInfo', 'queryStorageInfo', 'queryRecordStatus'
])

/**
 * Sends each command once and hands back what came back, raw. For the discovery run on the real
 * server: it is how we find out which of these names these NVRs answer, and in what shape.
 * Never throws; a command that fails is reported as a failure and the next one is still tried.
 */
export async function discoverStorage(nvr, query, commands = DISCOVERY) {
  const out = []
  for (const url of commands) {
    const t0 = Date.now()
    try {
      const xml = await query(nvr, url, emptyRequest(), 'disk discovery')
      let status = ''
      let errorCode = ''
      try {
        const a = answerOf(xml)
        status = a.status
        errorCode = a.errorCode
      } catch (e) {
        status = `unparsable: ${e.message}`
      }
      out.push({ url, ms: Date.now() - t0, ok: status === 'success', status, errorCode, xml })
    } catch (e) {
      out.push({ url, ms: Date.now() - t0, ok: false, status: 'failed', errorCode: '', error: e?.message ?? String(e) })
    }
  }
  return out
}

// ---- SMART: what the disk says about its own health ---------------------------------------------
//
// queryDiskSmartInfo, with <condition><diskId>{GUID}</diskId></condition>. The command was found
// by elimination: every wrong name answers a bare HTTP 404, and this one answered with XML, so the
// NVR knew it. A bodyless request is refused with errorCode 536870923 -- it wants to be told which
// disk.
//
// The NVR gives its own verdict (good / lowHealth / bad), the temperature, how long the disk has
// been powered on, and the raw SMART attribute table.
//
// Of the two dozen attributes, only a few actually predict a failure. Backblaze, who have run
// hundreds of thousands of these drives, report that five do most of the work: reallocated
// sectors, reported uncorrectable, command timeout, pending sectors and offline uncorrectable.
// Those are the ones this raises a warning for, and only when their raw count is above zero.
//
// The others are deliberately NOT judged. Seagate encodes attributes 1 and 7 so that a perfectly
// healthy drive reports a raw value in the hundreds of millions -- this disk reports 889,728,777
// seek errors and is fine. Treating a big number as a bad number would condemn every healthy
// Seagate in the estate, so the normalised value and the maker's own verdict are trusted instead.
const SMART_NAMES = Object.freeze({
  1: 'Read error rate', 3: 'Spin-up time', 4: 'Start/stop count', 5: 'Reallocated sectors',
  7: 'Seek error rate', 9: 'Power-on hours', 10: 'Spin retries', 12: 'Power cycles',
  18: 'Head health', 187: 'Reported uncorrectable', 188: 'Command timeout', 190: 'Airflow temperature',
  192: 'Unsafe shutdowns', 193: 'Load/unload cycles', 194: 'Temperature', 197: 'Pending sectors',
  198: 'Offline uncorrectable', 199: 'CRC errors', 200: 'Write error rate', 240: 'Head flying hours',
  241: 'Total written', 242: 'Total read'
})

/** The attributes worth waking somebody for, and what a non-zero count on each one means. */
export const CRITICAL_SMART = Object.freeze({
  5: 'sectors have already failed and been swapped out',
  187: 'reads the drive could not correct',
  188: 'commands the drive gave up on',
  197: 'sectors waiting to be swapped out',
  198: 'sectors that could not be read even offline'
})

const HOT_C = 50 // a 3.5" drive above this is being cooked; Seagate rate these to 60

/**
 * queryDiskSmartInfo for one disk.
 * @returns {{ ok: boolean, errorCode: string, smart: object|null }}
 */
export function parseSmart(xml) {
  const { response, status, errorCode } = answerOf(xml)
  if (status && status !== 'success') return { ok: false, errorCode: errorCode || status, smart: null }
  const c = kid(response, 'content') ?? response
  const attrs = itemsUnder(response, ['smartItems']).map((item) => {
    const id = num(item.attrs?.id)
    return {
      id,
      name: SMART_NAMES[id] ?? `Attribute ${id ?? '?'}`,
      value: num(field(item, ['value'])),
      worst: num(field(item, ['worstValue'])),
      threshold: num(field(item, ['threshold'])),
      raw: num(field(item, ['rawValue'])),
      kind: field(item, ['type']), // 'Pre-fail' or 'Oldage'
      status: field(item, ['smartStatus']) // 'normal' or 'warn'
    }
  })

  // Concerns, in the disk's own words where it gives them and in plain counts where it does not.
  const concerns = []
  for (const a of attrs) {
    if (a.status && a.status.toLowerCase() === 'warn') concerns.push(`${a.name}: the drive flags this`)
    else if (CRITICAL_SMART[a.id] && Number.isFinite(a.raw) && a.raw > 0) concerns.push(`${a.name}: ${a.raw} — ${CRITICAL_SMART[a.id]}`)
  }
  const temperature = num(field(c, ['temperature']))
  if (Number.isFinite(temperature) && temperature >= HOT_C) concerns.push(`running at ${temperature} °C`)

  // A few attributes say something the disk's own verdict does not, and are worth carrying.
  const raw = (id) => attrs.find((a) => a.id === id)?.raw ?? null
  const powerCycles = raw(12) ?? raw(4)
  const unsafe = raw(192) // emergency retracts: the heads parked because the power went, not because it was asked
  // Attribute 190 is the airflow temperature as 100 minus degrees; its worst-ever value is the
  // only record of how hot this drive has ever been, which is what shows a cabinet fan has died.
  const hot190 = attrs.find((a) => a.id === 190)
  const peakTemp = Number.isFinite(hot190?.worst) ? 100 - hot190.worst : (attrs.find((a) => a.id === 194)?.worst ?? null)
  // Deliberately NOT reported: attributes 241/242, "total written" and "total read". They are
  // 32-bit and have wrapped about 150 times on this drive -- it reads 0.93 TB where the real
  // figure is nearer 331 TB. A number that wrong is worse than no number.

  const verdict = field(c, ['diskStatus'])
  const v = String(verdict ?? '').toLowerCase()
  return {
    ok: true,
    errorCode: '',
    smart: {
      id: field(c, ['id']),
      verdict, // the NVR's own word: good | lowHealth | bad
      state: v === 'good' ? (concerns.length ? 'warn' : 'ok') : v === 'lowhealth' ? 'warn' : v === 'bad' ? 'bad' : 'unknown',
      temperature,
      peakTemp,
      powerOnDays: num(field(c, ['powerOnDays'])),
      powerOnHours: raw(9),
      flyingHours: raw(240),
      powerCycles,
      unsafeShutdowns: unsafe,
      loadCycles: raw(193),
      crcErrors: raw(199),
      concerns,
      attrs
    }
  }
}

/** The request this command wants: it refuses one that does not name a disk. */
export const smartRequest = (diskId) => `${XML_HEADER}<condition><diskId>${esc(diskId)}</diskId></condition></request>`

/**
 * The disk health hunt. These NVRs advertise supportHDHealth and do know the command
 * `queryDiskSmartInfo` -- it is the one name of twelve tried that answered with XML rather than a
 * 404 -- but it refuses a bodyless request with errorCode 536870923. A SMART report is per disk,
 * so the likeliest reason is that it wants to be told which disk. This sends the shapes the rest
 * of this dialect uses, against the GUIDs the NVR itself just gave us, and reports what each one
 * said. Read-only, and it stops at the first shape that succeeds.
 */
export async function probeSmart(nvr, query, url = 'queryDiskSmartInfo') {
  const out = []
  let ids = []
  try {
    const r = parseStorageDevInfo(await query(nvr, 'queryStorageDevInfo', emptyRequest(), 'smart probe'))
    ids = r.slots.map((s) => s.id).filter(Boolean)
  } catch (e) {
    out.push({ shape: 'read the disk list first', error: e?.message ?? String(e) })
  }
  const id = ids[0] ?? null
  const shapes = [
    ['no body', emptyRequest()],
    ['requireField', `${XML_HEADER}<requireField><diskId/><smartInfo/></requireField></request>`],
    ...(id
      ? [
          ['condition/diskId', `${XML_HEADER}<condition><diskId>${id}</diskId></condition></request>`],
          ['content/diskId', `${XML_HEADER}<content><diskId>${id}</diskId></content></request>`],
          ['condition/item id', `${XML_HEADER}<condition><diskList type="list"><item id="${id}"></item></diskList></condition></request>`],
          ['content list item id', `${XML_HEADER}<content type="list"><item id="${id}"></item></content></request>`],
          ['condition/id', `${XML_HEADER}<condition><id>${id}</id></condition></request>`]
        ]
      : [])
  ]
  for (const [shape, doc] of shapes) {
    try {
      const xml = await query(nvr, url, doc, 'smart probe')
      let status = ''
      let errorCode = ''
      try {
        const a = answerOf(xml)
        status = a.status
        errorCode = a.errorCode
      } catch (e) {
        status = `unparsable: ${e.message}`
      }
      out.push({ shape, sent: doc, ok: status === 'success', status, errorCode, xml })
      if (status === 'success') break
    } catch (e) {
      out.push({ shape, sent: doc, ok: false, status: 'failed', error: e?.message ?? String(e) })
    }
  }
  return { url, diskIds: ids, tried: out }
}

/** An entry that says "we have nothing", with the reason, so the page never invents a reading. */
const unavailable = (why, at, extra = {}) => ({ at, available: false, why, disks: [], days: null, worst: 'unknown', caps: {}, reachable: null, ...extra })

/**
 * One NVR's answers, merged. Never throws: every failure becomes `available: false` plus a reason.
 * @param {object} nvr
 * @param {(nvr: object, url: string, xml: string, tag: string) => Promise<string>} query
 * @param {() => number} now
 * @param {(nvr: object) => Promise<{ ok: boolean, why: string, skipped?: boolean }>} [reach]
 *   asked only when the NVR is not logged in, so the page can separate "the network is down"
 *   from "it answered, but refused us".
 */
export async function readStorage(nvr, query, now, reach) {
  const at = now()
  if (!xmlOnline(nvr)) {
    let probed = null
    try {
      probed = reach ? await reach(nvr) : null
    } catch {} // a probe that cannot be made tells us nothing; it must not turn into an error
    const why = probed && !probed.skipped
      ? probed.ok
        ? `${nvr?.name ?? 'the NVR'} answers on the network but is not logged in${nvr?.error ? `: ${nvr.error}` : ''}`
        : `${nvr?.name ?? 'the NVR'} ${probed.why}`
      : `${nvr?.name ?? 'the NVR'} is ${nvr?.status ?? 'offline'}${nvr?.error ? `: ${nvr.error}` : ''}`
    return unavailable(why, at, { reachable: probed && !probed.skipped ? probed.ok : null })
  }

  const got = {}
  const failed = []
  for (const { key, url, parse } of COMMANDS) {
    try {
      const xml = await query(nvr, url, emptyRequest(), 'nvr disks')
      const r = parse(xml)
      if (r.ok) got[key] = r
      else failed.push(`${url}: ${r.errorCode || 'refused'}`)
    } catch (e) {
      failed.push(`${url}: ${e?.message ?? e}`)
    }
  }

  const caps = got.caps?.caps ?? {}
  if (!got.disks && !got.record) return unavailable(failed.join('; ') || 'the NVR did not answer', at, { caps, reachable: true })

  // Merge the two views by slot: queryDiskStatus knows the condition and the size,
  // queryStorageDevInfo knows how far back the recordings on that disk go.
  // By id first, then by slot. queryDiskStatus names its disks only by the GUID -- it carries no
  // slotIndex at all -- so matching on slot alone left every disk's condition stranded in an
  // answer that could not be paired with the disk it described.
  const bySlot = new Map()
  const byId = new Map()
  for (const s of got.record?.slots ?? []) {
    if (s.slot !== null) bySlot.set(s.slot, s)
    if (s.id) byId.set(s.id, s)
  }
  const loneSlot = (got.record?.slots ?? []).length === 1 ? got.record.slots[0] : null

  // Whichever answer knows a thing, wins. Neither command is complete on every firmware: these
  // NVRs put the condition in one and the model, serial and size in the other, and taking one
  // side wholesale is what made the Health page print nulls next to a disk it could describe.
  const merge = (a, b) => {
    const out = { ...a }
    for (const [k, v] of Object.entries(b ?? {})) if (out[k] === null || out[k] === undefined) out[k] = v
    if (out.status && a.status === null) out.state = diskState(out.status)
    return out
  }

  const disks = (got.disks?.disks ?? []).map((d) => {
    const rec = (d.id && byId.get(d.id)) || (d.slot !== null && bySlot.get(d.slot)) || (got.disks.disks.length === 1 ? loneSlot : null) || null
    const { from, to, days, ...detail } = rec ?? {}
    return { ...merge(d, detail), recFrom: from ?? null, recTo: to ?? null, days: days ?? null }
  })

  // No disk list, but recording dates: report everything that answer carried, not just the days.
  if (!disks.length) {
    for (const s of got.record?.slots ?? []) {
      const { from, to, days, ...detail } = s
      disks.push({ ...detail, recFrom: from, recTo: to, days })
    }
  }

  // The NVR holds what its shortest-serving disk holds: with two disks recording in parallel,
  // a promise of "30 days" is only true for as long as both of them go back.
  // SMART, one query per disk, and only for disks the NVR gave an id for -- the command refuses a
  // request that does not name one. A disk that will not give its SMART data keeps everything else
  // it did give: this is extra detail, not a precondition. A failure here is recorded in `why`.
  for (const d of disks) {
    if (!d.id) continue
    try {
      const r = parseSmart(await query(nvr, 'queryDiskSmartInfo', smartRequest(d.id), 'disk smart'))
      if (r.ok) d.smart = r.smart
      else failed.push(`queryDiskSmartInfo: ${r.errorCode || 'refused'}`)
    } catch (e) {
      failed.push(`queryDiskSmartInfo: ${e?.message ?? e}`)
    }
    // The drive's own verdict outranks the NVR's "read/write", which only says the NVR is using
    // it. A disk can be perfectly writable and quietly failing, and that is the case this exists
    // to catch; it is never allowed to upgrade a state, only to lower it.
    // Only a verdict we positively recognise as poor lowers it. A SMART reply we could not make
    // sense of comes back as 'unknown', and letting that downgrade a disk the NVR is writing to
    // would turn every firmware quirk into a disk fault.
    const sv = d.smart?.state
    if ((sv === 'warn' || sv === 'bad') && RANK[sv] < RANK[d.state]) d.state = sv
  }

  const dayFigures = disks.map((d) => d.days).filter((d) => Number.isFinite(d))
  const worst = disks.length === 0 ? 'missing' : disks.map((d) => d.state).reduce((a, b) => (RANK[b] < RANK[a] ? b : a), 'ok')

  return {
    at,
    available: true,
    why: failed.join('; '), // partial: e.g. the disk list arrived but the dates did not
    disks,
    days: dayFigures.length ? Math.min(...dayFigures) : null,
    worst,
    caps,
    reachable: true
  }
}

// ---- the cache the health poll reads -----------------------------------------------------------

/**
 * A background reader with a snapshot the (synchronous) health poll can read for free.
 *
 * refresh() is fire-and-forget and never rejects; it asks each NVR at most once per FRESH_MS
 * (RETRY_MS after a failure) and never twice at the same time. get() is a plain map lookup, so
 * nothing on the health path can block, throw, or wait on an NVR.
 *
 * @param {object} o
 * @param {() => object[]} o.listNvrs
 * @param {(nvr, url, xml, tag) => Promise<string>} [o.query] injected by the tests; the default
 *   sends the command over the NVR's logged-in SDK connection.
 */
/**
 * Keep the last-good SMART for any disk whose fresh read did not get it. queryDiskSmartInfo times out
 * over P2P often enough that an otherwise good disk read would keep losing its SMART; SMART changes
 * slowly, so the last reading (with its age) is far better than a blank. Matched by disk id; `smartAt`
 * says when the SMART shown was actually read. Mutates and returns `fresh`.
 */
export function carrySmart(prevGood, fresh) {
  if (!fresh?.available || !Array.isArray(fresh.disks)) return fresh
  const prevById = prevGood?.available && Array.isArray(prevGood.disks)
    ? new Map(prevGood.disks.filter((d) => d.id).map((d) => [d.id, d]))
    : new Map()
  for (const d of fresh.disks) {
    if (d.smart) { d.smartAt = fresh.at; continue } // read just now
    const p = d.id ? prevById.get(d.id) : null
    if (p?.smart) {
      d.smart = p.smart
      d.smartAt = p.smartAt ?? prevGood.at // when it was actually read
      const sv = d.smart.state // a carried warn/bad still lowers the disk's state, never raises it
      if ((sv === 'warn' || sv === 'bad') && RANK[sv] < RANK[d.state]) d.state = sv
    }
  }
  return fresh
}

export function makeNvrStorage({ listNvrs, query, reach, now = Date.now, freshMs = FRESH_MS, retryMs = RETRY_MS, staleOkMs = STALE_OK_MS, log = console.warn } = {}) {
  const entries = new Map() // nvr id -> entry from readStorage (the last read; drives the schedule)
  const lastGood = new Map() // nvr id -> last AVAILABLE snapshot, shown (stale) while fresh reads fail
  const running = new Map() // nvr id -> promise, so two ticks never ask the same NVR at once

  const send = query ?? sdkQuery

  const due = (id) => {
    const e = entries.get(id)
    if (!e) return true
    return now() - e.at >= (e.available ? freshMs : retryMs)
  }

  const one = (nvr) => {
    if (running.has(nvr.id)) return running.get(nvr.id)
    // A hard ceiling of our own: transparent() has its own budget, but a call that outlives it
    // stays inside the SDK, and we would rather show the previous snapshot than keep a slot busy.
    const timed = Promise.race([
      readStorage(nvr, send, now, reach),
      new Promise((r) => setTimeout(() => r(unavailable(`${nvr.name ?? nvr.id} did not answer within ${QUERY_MS} ms`, now())), QUERY_MS).unref?.())
    ])
    const p = timed
      .then((e) => {
        // a fresh available read wins, but carries last-good SMART onto any disk whose SMART query
        // failed; an unavailable read is stored for the schedule, and get() falls back to lastGood
        if (e?.available) {
          const merged = carrySmart(lastGood.get(nvr.id), e)
          entries.set(nvr.id, merged)
          lastGood.set(nvr.id, merged)
        } else {
          entries.set(nvr.id, e)
        }
      })
      .catch((e) => {
        // readStorage promises not to throw; if that promise is ever broken, the health poll
        // must still not be the thing that dies.
        log(`[nvr-disks] ${nvr.id}: ${e?.message ?? e}`)
        entries.set(nvr.id, unavailable(String(e?.message ?? e), now()))
      })
      .finally(() => running.delete(nvr.id))
    running.set(nvr.id, p)
    return p
  }

  return {
    /**
     * The last snapshot for an NVR, or null if it has never been read. Never blocks. When the most
     * recent read failed (a P2P timeout, the NVR briefly unreachable) the last good snapshot is shown
     * instead, marked `stale`, until it is older than staleOkMs -- so SMART and disk health do not
     * blink out on a single bad read.
     */
    get: (id) => {
      const e = entries.get(id) ?? null
      if (e?.available) return e
      const good = lastGood.get(id)
      if (good && now() - good.at < staleOkMs) return { ...good, stale: true, why: e?.why ?? good.why }
      return e
    },
    /** Asks every NVR that is due. Resolves when this round is done; safe to call and ignore. */
    async refresh() {
      let list = []
      try {
        list = listNvrs()
      } catch (e) {
        log(`[nvr-disks] could not list the NVRs: ${e?.message ?? e}`)
        return
      }
      await Promise.allSettled(list.filter((n) => n?.id && due(n.id)).map((n) => one(n)))
    },
    _entries: entries
  }
}
