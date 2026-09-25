// What does this NVR actually support?
//
// The SDK library and the NVMS-9000 firmware between them offer far more than this app uses:
// tamper detection, face matching, object search, the NVR's own disk state. Whether a given NVR
// has any of it depends on its model, its firmware and its licence, and the only honest way to
// find out is to ask it.
//
// Every command here is a QUERY. Nothing is changed on the NVR, which is why this is safe to run
// against a live site. An unsupported command comes back as a failure and is reported as
// "not supported" rather than being allowed to look like an error in the app.
//
//   GET /api/admin/nvrs/:id/capabilities -> { nvr, model, results: [...] }

import { transparent } from './nvr-xml.mjs'

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>'
const body = () => `${XML_HEAD}<request version="1.0" systemType="NVMS-9000" clientType="WEB"></request>`

/** Read-only queries worth knowing the answer to, and why we care. */
export const PROBES = Object.freeze([
  { cmd: 'queryDiskStatus', why: 'the NVR’s own disks: present, healthy or failed' },
  { cmd: 'queryStorageDevInfo', why: 'disk sizes and free space' },
  { cmd: 'queryExternalDisks', why: 'any disk attached to the NVR' },
  { cmd: 'queryRecStatus', why: 'which channels the NVR is recording right now' },
  { cmd: 'queryVfd', why: 'tamper detection: camera covered, moved or out of focus' },
  { cmd: 'queryChlVideoLossStatus', why: 'which cameras have lost their picture' },
  { cmd: 'queryMotion', why: 'motion zones and sensitivity per camera' },
  { cmd: 'queryAlarmStatus', why: 'alarm inputs and their state' },
  { cmd: 'queryFaceMatchAlarm', why: 'face matching, if this model has it' },
  { cmd: 'queryFacePersonnalInfoGroupList', why: 'a stored list of people to match against' },
  { cmd: 'queryChlPresetList', why: 'PTZ presets, so we know which cameras move' },
  { cmd: 'queryTimeCfg', why: 'the NVR clock and how it is set' },
  { cmd: 'queryEmailCfg', why: 'email settings the NVR already has' },
  { cmd: 'queryUserList', why: 'the accounts on the NVR' },
  { cmd: 'queryLog', why: 'the NVR’s own event log' },
  { cmd: 'queryOnlineChlList', why: 'which cameras the NVR believes are online' }
])

const STATUS = /<status>\s*([a-z]+)\s*<\/status>/i
const ERRCODE = /<errorCode>\s*(\d+)\s*<\/errorCode>/i

/**
 * Runs every probe against one NVR, one at a time so a site is never flooded.
 * Never throws: a command the NVR dislikes is simply reported as unsupported.
 * @returns {Promise<Array<{cmd:string, why:string, supported:boolean, status:string, bytes:number, sample:string}>>}
 */
export async function probeNvr(nvr, { timeoutMs = 8000 } = {}) {
  const out = []
  for (const p of PROBES) {
    try {
      const answer = String((await transparent(nvr, p.cmd, body(), `probe ${p.cmd}`, { outBytes: 64 * 1024 })) ?? '')
      const status = STATUS.exec(answer)?.[1]?.toLowerCase() ?? 'no status'
      const err = ERRCODE.exec(answer)?.[1]
      out.push({
        cmd: p.cmd,
        why: p.why,
        supported: status === 'success',
        status: status === 'success' ? 'supported' : `${status}${err ? ` (code ${err})` : ''}`,
        bytes: answer.length,
        // enough of the answer to see the shape, with the whitespace squeezed out
        sample: answer.replace(/>\s+</g, '><').slice(0, 600)
      })
    } catch (e) {
      out.push({ cmd: p.cmd, why: p.why, supported: false, status: `refused: ${e.message.slice(0, 80)}`, bytes: 0, sample: '' })
    }
  }
  return out
}

/**
 * GET /api/admin/nvrs/:id/capabilities
 * @returns {Promise<[number, object] | null>} null when this is not that route
 */
export async function handleProbe(method, pathname, nvrs) {
  const m = /^\/api\/admin\/nvrs\/([^/]+)\/capabilities$/.exec(pathname)
  if (!m) return null
  if (method !== 'GET') return [405, { error: 'Method not allowed' }]
  const nvr = nvrs.get(decodeURIComponent(m[1]))
  if (!nvr) return [404, { error: 'Unknown NVR' }]
  if (!nvr.online) return [409, { error: `${nvr.name} is offline` }]
  return [200, { nvr: nvr.id, name: nvr.name, model: nvr.model ?? null, serial: nvr.serial ?? null, results: await probeNvr(nvr) }]
}
