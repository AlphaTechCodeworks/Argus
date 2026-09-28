// Which exports a user may list, open, download and delete (export-api.mjs). An export is a copy
// of footage, so reaching one must be no easier than making it: an admin reaches every job, anyone
// else only their own, and only while their export right still covers every camera in it and its
// format. Decided on each request, so a revoked right takes effect at once. Pure: no NVR, no SDK,
// no recording drive; the finished jobs are written straight into a temporary data folder.
//
//   node cctv/test/export-scope.test.mjs
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// auth.mjs and rights.mjs read DATA_DIR when first imported, so it is set before they are
const dataDir = mkdtempSync(join(tmpdir(), 'export-scope-'))
process.env.DATA_DIR = dataDir
writeFileSync(join(dataDir, 'users.json'), JSON.stringify({ boss: { hash: 'x', role: 'admin' }, alice: { hash: 'x', role: 'viewer' }, bob: { hash: 'x', role: 'viewer' } }))
const grants = (exp) => ({ live: [], 'playback-server': [], 'playback-nvr': [], export: exp })
writeFileSync(join(dataDir, 'rights.json'), JSON.stringify({ version: 1, users: {
  alice: { admin: false, grants: grants(['nvr1/0']), formats: ['pack'] },
  bob: { admin: false, grants: grants(['*']), formats: ['pack', 'mp4', 'stills'] }
} }))

// A finished job as export-job.mjs records it: exports/<id>/export.json beside its pack folder.
// All of them exist before the first call, because the register reads the folder once per process.
const job = (id, by, format, clips) => {
  const dir = join(dataDir, 'exports', id)
  mkdirSync(join(dir, 'pack'), { recursive: true })
  writeFileSync(join(dir, 'pack', 'clip.bin'), `footage of ${id}`)
  writeFileSync(join(dir, 'export.json'), JSON.stringify({ id, name: id, format, notes: 'notes', state: 'done', error: '', by, startedAt: new Date().toISOString(), endedAt: null, bytes: 0,
    clips: clips.map(([nvr, ch]) => ({ nvr, ch, fromMs: 1, toMs: 2 })), progress: {}, files: [{ path: 'clip.bin', bytes: 48, crc32: 0 }] }))
}
const OWN = 'aaaaaaaa-0000-0000-0000-000000000001' // alice's pack of nvr1/0: hers, and still allowed
const BOSS = 'aaaaaaaa-0000-0000-0000-000000000002' // an admin's mp4 of nvr-2/5: another camera, format and person
const BOBS = 'aaaaaaaa-0000-0000-0000-000000000003' // bob's pack of nvr1/0: alice's own camera and format, but not hers
const EMPTY = 'aaaaaaaa-0000-0000-0000-000000000004' // alice's, with no clips at all: nothing to decide on, so nothing
job(OWN, 'alice', 'pack', [['nvr1', 0]])
job(BOSS, 'boss', 'mp4', [['nvr-2', 5]])
job(BOBS, 'bob', 'pack', [['nvr1', 0]])
job(EMPTY, 'alice', 'pack', [])

const { handleExports, downloadExport } = await import('../export-api.mjs')
const { saveRights } = await import('../rights.mjs')

const ALICE = { user: 'alice', admin: false }
const ADMIN = { user: 'boss', admin: true }
const api = (who, method, pathname) => handleExports({ method, pathname, readJson: async () => ({}), who, user: who.user, index: null, dataDir })
const download = async (who, id) => {
  const out = { status: 0, bytes: 0 }
  const res = {
    writableEnded: false,
    writeHead(s) { out.status = s },
    write(c) {
      out.bytes += c.length
      return true
    },
    end() { this.writableEnded = true },
    once() {},
    destroy() {}
  }
  await downloadExport({ pathname: `/api/exports/${id}/download`, method: 'GET', who, res, dataDir, sendJson: (r, s) => { out.status = s } })
  return out
}
const ids = async (who) => (await api(who, 'GET', '/api/exports'))[1].exports.map((j) => j.id).sort()

// ---- a restricted user reaches only her own jobs -------------------------------------------

check('the list holds only her own job', JSON.stringify(await ids(ALICE)) === JSON.stringify([OWN]), JSON.stringify(await ids(ALICE)))
check('her own job opens', (await api(ALICE, 'GET', `/api/exports/${OWN}`))[0] === 200)
check('another user\'s job on another camera is 404, not 403', (await api(ALICE, 'GET', `/api/exports/${BOSS}`))[0] === 404)
check('another user\'s job on her own camera is 404', (await api(ALICE, 'GET', `/api/exports/${BOBS}`))[0] === 404)
check('a job with no clips is nobody\'s but an admin\'s', (await api(ALICE, 'GET', `/api/exports/${EMPTY}`))[0] === 404)
const stolen = await download(ALICE, BOSS)
check('downloading another user\'s job is 404 and sends no footage', stolen.status === 404 && stolen.bytes === 0, JSON.stringify(stolen))
check('downloading her own job works', (await download(ALICE, OWN)).status === 200)
check('deleting another user\'s job is 404', (await api(ALICE, 'DELETE', `/api/exports/${BOSS}`))[0] === 404)
check('and the job is still there', existsSync(join(dataDir, 'exports', BOSS)) && (await api(ADMIN, 'GET', `/api/exports/${BOSS}`))[0] === 200)

// ---- an admin reaches everything ------------------------------------------------------------

check('an admin lists every job', (await ids(ADMIN)).length === 4)
check('an admin downloads another user\'s job', (await download(ADMIN, OWN)).status === 200)

// ---- a revoked right takes effect on the next request -----------------------------------------

saveRights('alice', { admin: false, grants: grants(['nvr1/1']), formats: ['pack'] })
check('after the camera right is revoked her job leaves her list', (await ids(ALICE)).length === 0)
check('and its download is 404', (await download(ALICE, OWN)).status === 404)
saveRights('alice', { admin: false, grants: grants(['nvr1/0']), formats: ['mp4'] })
check('after the format right is revoked its download is 404', (await download(ALICE, OWN)).status === 404)
check('and she cannot delete it either', (await api(ALICE, 'DELETE', `/api/exports/${OWN}`))[0] === 404 && existsSync(join(dataDir, 'exports', OWN)))

// ---- an admin still deletes anything ---------------------------------------------------------

check('an admin deletes another user\'s job', (await api(ADMIN, 'DELETE', `/api/exports/${BOBS}`))[0] === 200 && !existsSync(join(dataDir, 'exports', BOBS)))

rmSync(dataDir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
