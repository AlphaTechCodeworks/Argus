// The on-screen display: the camera's name and the time burnt into the picture.
//
// This matters more than a cosmetic setting. The OSD is part of the recorded image for ever -- it
// cannot be edited out of footage afterwards, and in practice it is the timestamp a person reads
// when they look at evidence. A name that is wrong, or a clock sitting over the one part of the
// frame that matters, is baked into every recording made until somebody notices.
//
// Route: queryIPChlORChlOSD / editIPChlORChlOSD, over the transparent XML channel this app already
// uses for the clock and the picture settings. Both names came out of the SDK library's own symbol
// table, and the NVR answers the read with a proper <response> rather than a 404, so it knows them.
// A read with no body is refused with errorCode 536871059 -- the same shape of answer the disk
// SMART command gives when it has not been told which disk -- so it wants a channel.
//
// Nothing here writes without being told to. The write follows the pattern that has proved safe
// for the clock and the sub-stream codec: read what is there now, change only the fields asked
// for, send the rest back exactly as read, read it again and compare, and log before and after.
// These NVRs replace a whole block rather than merging into it, so a partial write silently wipes
// whatever it does not mention.
//
// The camera carries TWO independently placed overlays (osd-doc.mjs): the clock (time) and the
// channel name (chlName), each with its own switch and X/Y on a 0..10000 grid. A change names the
// block(s) to touch and only the sub-fields within them that should change.
//
//   GET  /api/admin/nvrs/:id/channels/:ch/osd            what this camera shows now (the two-overlay model)
//   GET  /api/admin/nvrs/:id/channels/:ch/osd?probe=1    read-only: which request shape it accepts
//   POST /api/admin/nvrs/:id/channels/:ch/osd            { name?: { text?, show?, x?, y? },
//                                                          time?: { show?, x?, y?, dateFormat?, timeFormat? }, confirm: true }

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './auth.mjs'
import { HttpError, cameraOf, chlIdOf, transparent, withNvrLock } from './nvr-xml.mjs'
// the documents and the rules about them live apart so they can be tested without the SDK
import { allApplied, buildEdit, checkWanted, osdRequest, parseOsd, probeShapes } from './osd-doc.mjs'
import { xmlOnline } from './xml-session.mjs'

const QUERY_URL = 'queryIPChlORChlOSD'
const EDIT_URL = 'editIPChlORChlOSD'
const LOG_FILE = join(DATA_DIR, 'osd-changes.log')
const READ_BACK_MS = 1500

/**
 * Tries each shape until one answers, and reports what every one of them said.
 * Read-only, and it stops at the first success. Never throws.
 */
export async function probeOsd(nvr, ch, query) {
  const chlId = chlIdOf(ch)
  const tried = []
  for (const [shape, doc] of probeShapes(chlId)) {
    try {
      const xml = String((await query(nvr, QUERY_URL, doc, 'osd probe')) ?? '')
      let ok = false
      let errorCode = ''
      let status = ''
      try {
        const r = parseOsd(xml)
        ok = r.ok
        errorCode = r.errorCode
        status = r.ok ? 'success' : 'fail'
      } catch (e) {
        // Not a response document at all, which on this firmware means the command does not exist.
        status = `unreadable: ${e.message}`
      }
      tried.push({ shape, sent: doc, ok, status, errorCode, xml })
      if (ok) break
    } catch (e) {
      tried.push({ shape, sent: doc, ok: false, status: 'failed', error: e?.message ?? String(e) })
    }
  }
  return { url: QUERY_URL, chlId, tried }
}

/**
 * Reads, writes and reads back one camera's OSD.
 * @returns {Promise<{before:object, sent:object, after:object, applied:boolean, warning?:string}>}
 */
export async function setOsd(nvr, ch, want, user, query = transparent) {
  const chlId = chlIdOf(ch)
  return withNvrLock(nvr, 'osd', async () => {
    const beforeXml = String((await query(nvr, QUERY_URL, osdRequest(chlId), 'osd before')) ?? '')
    const before = parseOsd(beforeXml)
    if (!before.ok) throw new HttpError(502, `the NVR would not say what this camera shows (${before.errorCode}); nothing was changed`)
    // validated against the camera's own grid bounds and its <types> list, now that we have them
    const wanted = checkWanted(want, before.osd)

    const reply = String((await query(nvr, EDIT_URL, buildEdit(beforeXml, wanted), 'osd write')) ?? '')
    if (!/<status>\s*success/i.test(reply)) {
      const code = /<errorCode>\s*(\d+)/.exec(reply)?.[1]
      throw new HttpError(502, `the NVR refused the change${code ? ` (code ${code})` : ''}; nothing was changed`)
    }

    await new Promise((r) => setTimeout(r, READ_BACK_MS))
    const after = parseOsd(String((await query(nvr, QUERY_URL, osdRequest(chlId), 'osd after')) ?? ''))
    // Asked, not assumed: these NVRs will answer "success" and keep what they had.
    const applied = after.ok && allApplied(wanted, after.osd)

    try {
      appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), nvr: nvr.id, ch, by: user ?? '?', wanted, before: before.osd, after: after.osd ?? null, applied })}\n`, { mode: 0o600 })
    } catch { /* the change is done; failing to log it must not undo it */ }

    return {
      before: before.osd,
      sent: wanted,
      after: after.osd ?? null,
      applied,
      warning: applied ? undefined : 'The NVR accepted the change but still reports what it had before.'
    }
  })
}

/**
 * GET/POST /api/admin/nvrs/:id/channels/:ch/osd
 * @returns {Promise<[number, object] | null>} null when this is not that route
 */
export async function handleOsd(method, pathname, search, readJson, nvrs, who, query = transparent) {
  const m = /^\/api\/admin\/nvrs\/([^/]+)\/channels\/(\d+)\/osd$/.exec(pathname)
  if (!m) return null
  if (!who?.admin) return [403, { error: 'Only admins can see or change what a camera displays' }]
  const ch = Number(m[2])
  let nvr
  try {
    ;({ nvr } = cameraOf(nvrs, decodeURIComponent(m[1]), ch))
  } catch (e) {
    return [e.status ?? 404, { error: e.message }]
  }
  if (!xmlOnline(nvr)) return [409, { error: `${nvr.name} is offline` }]

  try {
    if (method === 'GET') {
      // ?probe=1 while we do not yet know which request shape this firmware wants. Read-only.
      if (search?.get('probe')) return [200, { nvr: nvr.id, ch, ...(await probeOsd(nvr, ch, query)) }]
      const r = parseOsd(String((await query(nvr, QUERY_URL, osdRequest(chlIdOf(ch)), 'osd')) ?? ''))
      if (!r.ok) return [502, { error: `the NVR would not say what this camera shows (${r.errorCode})` }]
      return [200, { nvr: nvr.id, ch, osd: r.osd }]
    }
    if (method === 'POST') {
      const body = await readJson()
      // What a camera shows is burnt into every recording it makes from now on, and cannot be
      // taken out again. It is never a stray request.
      if (body?.confirm !== true) return [400, { error: 'confirm must be true: this is burnt into every recording from now on' }]
      return [200, await setOsd(nvr, ch, body, who.user, query)]
    }
    return [405, { error: 'Method not allowed' }]
  } catch (e) {
    return [e.status ?? 502, { error: e.message }]
  }
}
