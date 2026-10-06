// The evidence export routes. The job itself is export-job.mjs; this is only the HTTP shape.
//
//   GET    /api/exports              -> { exports: [job] }
//   POST   /api/exports              -> the job, started (409 while another one is running)
//   GET    /api/exports/:id          -> the job, for the progress bar
//   GET    /api/exports/:id/download -> the pack as a ZIP (streamed; see downloadExport)
//   DELETE /api/exports/:id          -> cancels it if it is running, then removes it
//
// Decided by rights.mjs the same way playback is: an export is a permanent copy
// of footage, so it can be no easier to obtain than watching it. The per-clip check happens again
// inside planExport for each camera, so a future per-camera rights model needs no change here.
// A finished export is that footage, so reaching one (list, progress, download, cancel, delete) is
// asked again on every request: mayReach below.
import { can, canAny, canShare } from './rights.mjs'
import { createShare } from './share-links.mjs'
import { ExportError, cancelExport, getExport, listExports, packDirOf, removeExport, startExport, zipEntriesOf, zipStream } from './export-job.mjs'

const ROUTE = /^\/api\/exports(?:\/([A-Za-z0-9-]{1,64})(?:\/(download|share))?)?$/

/** The coarse "may this person use exports at all" gate; the camera AND the format are checked again
 *  per clip inside planExport, which is what actually decides. */
const mayExport = (who) => canAny(who, 'export')

/**
 * Whether this person may reach one job: see it listed, open it, download it, cancel or delete it.
 * An admin reaches every job. Anyone else only their own, and only while their export right still
 * covers every camera in it in its format: holding an export's id must be no easier than making it
 * today, and one export right used to open every export (an admin's evidence of another site, in
 * a format the holder may not use, and the delete button on it). Asked on every request, so a
 * revoked right counts at once; a refusal is 404, so another person's export is not even confirmed.
 * A job with no clips (a damaged record) decides nothing, so it is an admin's alone.
 */
const mayReach = (who, job) =>
  can(who, 'admin') ||
  (typeof who?.user === 'string' && who.user !== '' && job.by === who.user && job.clips.length > 0 &&
    job.clips.every((c) => can(who, 'export', { nvr: c.nvr, ch: c.ch, format: job.format })))

/**
 * @param {{method:string, pathname:string, readJson:()=>Promise<object>, who:object, user:string,
 *          index:object|null, dataDir:string, clockOf?:(nvr:string)=>number}} o
 * @returns {Promise<[number, object]|null>} null when the path is not an exports route
 */
export async function handleExports({ method, pathname, readJson, who, user, index, dataDir, clockOf }) {
  const m = ROUTE.exec(pathname)
  if (!m) return null
  const [, id, tail] = m
  if (!mayExport(who)) return [403, { error: 'You are not allowed to make exports' }]
  if (tail === 'download') return [400, { error: 'downloads are served separately' }] // handled by downloadExport

  try {
    if (!id) {
      if (method === 'GET') return [200, { exports: listExports(dataDir).filter((j) => mayReach(who, j)) }]
      if (method === 'POST') return [201, startExport(await readJson(), { dataDir, index, who, user, clockOf })]
      return [405, { error: 'Method not allowed' }]
    }
    // before GET and DELETE alike, so a refused user cannot cancel someone else's running job either
    const job = getExport(dataDir, id)
    if (!job || !mayReach(who, job)) return [404, { error: 'Unknown export' }]
    // a public, time-limited share link for this one export (share-links.mjs). Needs the sharing
    // permission as well as reaching the job, and only a finished export can be shared.
    if (tail === 'share') {
      if (method !== 'POST') return [405, { error: 'Method not allowed' }]
      if (!canShare(who)) return [403, { error: 'You are not allowed to make share links' }]
      if (job.state !== 'done') return [400, { error: 'Only a finished export can be shared' }]
      const body = await readJson()
      const rec = createShare({ jobId: id, by: user, days: Number(body?.days), info: { label: job.downloadName ?? id, when: null, format: job.format ?? null } })
      return [201, { token: rec.token, url: `/s/${rec.token}`, expiresAt: rec.expiresAt }]
    }
    if (method === 'GET') return [200, job]
    if (method === 'DELETE') {
      // Cancelling first and then removing is deliberate: a running job is asked to stop and its
      // work folder is swept away, so "delete" always means there is nothing left either way.
      cancelExport(dataDir, id)
      return removeExport(dataDir, id) ? [200, { ok: true }] : [404, { error: 'Unknown export' }]
    }
    return [405, { error: 'Method not allowed' }]
  } catch (e) {
    if (e instanceof ExportError) return [e.status, { error: e.message }]
    if (Number.isInteger(e?.status)) return [e.status, { error: e.message }] // createShare's own 400s
    throw e
  }
}

/**
 * Streams a finished export as a ZIP. Nothing is buffered: the entries are read off the pack folder
 * as they go out, so a 40 GB download costs a megabyte of memory.
 * Only a job in the 'done' state has a pack folder at all, so a half-made or failed export cannot
 * be downloaded even by guessing its id.
 * @returns {Promise<boolean>} false when this is not a download URL (the caller carries on routing)
 */
export async function downloadExport({ pathname, method, who, res, dataDir, headers = {}, sendJson }) {
  const m = ROUTE.exec(pathname)
  if (!m || m[2] !== 'download') return false
  const id = m[1]
  if (!mayExport(who)) return sendJson(res, 403, { error: 'You are not allowed to make exports' }), true
  if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }), true
  const job = getExport(dataDir, id)
  if (!job || !mayReach(who, job)) return sendJson(res, 404, { error: 'That export is not ready to download' }), true
  if (!(await streamExportZip({ res, dataDir, id, headers }))) sendJson(res, 404, { error: 'That export is not ready to download' })
  return true
}

/**
 * Streams a finished export's ZIP to `res` (headers and body), nothing buffered. Authorisation is
 * the caller's job -- the signed-in download checks mayReach, a share link checks its token -- so
 * this only confirms the pack exists. Returns false (having written nothing) when the job is not
 * ready to download, so the caller can send its own 404; true once it has taken over the response.
 */
export async function streamExportZip({ res, dataDir, id, headers = {} }) {
  const job = getExport(dataDir, id)
  const dir = packDirOf(dataDir, id)
  if (!job || !dir) return false // not 'done', or the pack is gone: cannot stream it

  const name = String(job.downloadName).replace(/["\\]/g, '_')
  res.writeHead(200, {
    'content-type': 'application/zip',
    // No content-length: the archive is produced as it is sent.
    'content-disposition': `attachment; filename="${name}"`,
    'cache-control': 'no-store',
    ...headers
  })
  try {
    for await (const chunk of zipStream(dir, zipEntriesOf(dataDir, id))) {
      if (res.writableEnded) return true // the browser gave up; stop reading the drive
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve))
    }
    res.end()
  } catch (e) {
    // The headers have gone; the only honest thing left is to cut the connection so the client
    // sees a truncated download rather than a short but plausible ZIP.
    console.warn(`[export] stream of ${id} failed: ${e.message}`)
    res.destroy()
  }
  return true
}
